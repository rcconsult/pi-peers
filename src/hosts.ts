// Phase 2: peers on other hosts, reached over SSH. No registry: each host's own
// pi-peers CLI lists its agents and bridges one connection over SSH stdio.
//
// $PI_PEERS_HOME/hosts lists one SSH alias per line, then options, then optionally the remote
// command that runs the pi-peers CLI (default "pi-peers"):
//
//   wsl2  --reverse  /home/alice/.nvm/versions/node/v25.0.0/bin/node /mnt/c/git/utils/pi-peers/src/cli.ts
//
// --reverse: each local agent also keeps a reverse link open to that host ("expose"), so agents
// there can reach it even though they can't SSH back here.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Duplex } from "node:stream";
import { PeersClient } from "./client.ts";
import { type AgentEntry, peersHome } from "./discovery.ts";
import { encode, lineReader, PeersError, type Peer } from "./protocol.ts";
import type { AgentState, ExposedAgent } from "./schema.gen.ts";

const SSH_TIMEOUT_S = 10;
const LIST_TIMEOUT_MS = 20_000;
const REMOTE_HELLO_TIMEOUT_MS = 20_000;

export interface RemoteHost {
	alias: string;
	command: string;
	reverse: boolean;
}

/** A remote agent as `pi-peers list --json` reports it: no token. */
export type RemoteAgent = AgentState;

export function readHosts(): RemoteHost[] {
	let text: string;
	try {
		text = fs.readFileSync(path.join(peersHome(), "hosts"), "utf8");
	} catch {
		return [];
	}
	const hosts: RemoteHost[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.replace(/#.*$/, "").trim();
		if (!line) continue;
		const [alias, ...rest] = line.split(/\s+/);
		let reverse = false;
		while (rest[0]?.startsWith("--")) {
			if (rest.shift() === "--reverse") reverse = true;
		}
		// ssh would read an alias starting with "-" as an option (e.g. -oProxyCommand=...).
		if (alias.startsWith("-")) continue;
		hosts.push({ alias, command: rest.join(" ") || "pi-peers", reverse });
	}
	return hosts;
}

/** Split "host/address" when host is a configured alias; anything else is a local address. */
export function splitAddress(address: string): { host?: RemoteHost; address: string } {
	const slash = address.indexOf("/");
	if (slash > 0) {
		const host = readHosts().find((h) => h.alias === address.slice(0, slash));
		if (host) return { host, address: address.slice(slash + 1).replace(/^"(.*)"$/, "$1") };
	}
	return { address };
}

/** POSIX single-quote escaping for the remote shell. */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

function ssh(host: RemoteHost, remoteArgs: string) {
	return spawn(
		"ssh",
		["-o", "BatchMode=yes", "-o", `ConnectTimeout=${SSH_TIMEOUT_S}`, "-T", host.alias, `${host.command} ${remoteArgs}`],
		{ stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
	);
}

export function listRemote(host: RemoteHost): Promise<RemoteAgent[]> {
	return new Promise((resolve, reject) => {
		const child = ssh(host, "list --json");
		let out = "";
		let err = "";
		const timer = setTimeout(() => child.kill(), LIST_TIMEOUT_MS);
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("error", (e) => reject(new PeersError("ssh_failed", `ssh ${host.alias}: ${e.message}`)));
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				reject(new PeersError("ssh_failed", `ssh ${host.alias} exited ${code}: ${err.trim().split("\n").pop() ?? ""}`));
				return;
			}
			try {
				resolve(JSON.parse(out));
			} catch {
				reject(new PeersError("ssh_failed", `ssh ${host.alias}: list output is not JSON`));
			}
		});
	});
}

/** Open a connection to an agent on `host` through `pi-peers bridge`. The bridge adds the token. */
export async function connectRemote(host: RemoteHost, address: string, from: Peer): Promise<PeersClient> {
	const child = ssh(host, `bridge ${shq(address)}`);
	const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
	const client = new PeersClient(stream, () => {
		child.stdin.end();
		setTimeout(() => child.kill(), 2_000).unref();
	});
	let err = "";
	child.stderr.on("data", (d) => {
		err += d;
		client.failure = `ssh ${host.alias}: ${err.trim().split("\n").pop()}`;
	});
	child.on("error", (e) => {
		client.failure = `ssh ${host.alias}: ${e.message}`;
	});
	child.on("close", (code) => {
		if (code && !client.failure) client.failure = `ssh ${host.alias} exited ${code}`;
	});
	await client.hello(from, undefined, REMOTE_HELLO_TIMEOUT_MS);
	return client;
}

export type { ExposedAgent };

export interface ReverseLink {
	update(agent: ExposedAgent): void;
	close(): void;
}

/**
 * Keep `ssh <host> pi-peers expose` open. The far end publishes `agent` there and forwards each
 * connection to it as a numbered channel over this one SSH session:
 *   far -> here: {ch, op:"open"} {ch, op:"rec", rec} {ch, op:"close"}
 *   here -> far: {ch, op:"rec", rec} {ch, op:"close"} {op:"update", agent}
 * `onChannel` gets a duplex per channel that speaks plain NDJSON, like a socket would.
 * Reconnects with backoff until closed.
 */
export function openReverseLink(
	host: RemoteHost,
	agent: ExposedAgent,
	onChannel: (stream: Duplex) => void,
	onState: (state: string) => void = () => {},
): ReverseLink {
	let current = agent;
	let child: ChildProcessWithoutNullStreams | undefined;
	let closed = false;
	let backoff = 1_000;
	const channels = new Map<number, Duplex>();

	const send = (rec: unknown) => child?.stdin.writable && child.stdin.write(encode(rec));

	function channel(ch: number): Duplex {
		let pending = "";
		const d = new Duplex({
			read() {},
			write(chunk, _enc, cb) {
				pending += chunk.toString();
				let nl: number;
				while ((nl = pending.indexOf("\n")) >= 0) {
					const line = pending.slice(0, nl);
					pending = pending.slice(nl + 1);
					if (line.trim()) {
						try {
							send({ ch, op: "rec", rec: JSON.parse(line) });
						} catch {}
					}
				}
				cb();
			},
			final(cb) {
				send({ ch, op: "close" });
				cb();
			},
		});
		d.on("close", () => channels.delete(ch));
		return d;
	}

	function connect(): void {
		if (closed) return;
		const c = ssh(host, "expose");
		child = c;
		c.stdin.write(encode({ op: "expose", agent: current }));
		let err = "";
		c.stderr.on("data", (d) => (err += d));
		c.stdout.on(
			"data",
			lineReader(
				(raw) => {
					const m = raw as { ch?: number; op?: string; rec?: unknown };
					if (m.op === "ready") {
						backoff = 1_000;
						onState(`linked to ${host.alias}`);
						return;
					}
					// Channel ids are positive integers chosen by the far end; anything else is dropped.
					const ch = m.ch;
					if (typeof ch !== "number" || !Number.isInteger(ch) || ch < 1) return;
					if (m.op === "open") {
						if (channels.has(ch)) return; // never let a second open replace a live channel
						const d = channel(ch);
						channels.set(ch, d);
						onChannel(d);
					} else if (m.op === "rec") {
						// Records go only to a channel that was opened, and must be JSON objects.
						if (m.rec && typeof m.rec === "object" && !Array.isArray(m.rec)) channels.get(ch)?.push(encode(m.rec));
					} else if (m.op === "close") {
						const d = channels.get(ch);
						channels.delete(ch);
						d?.push(null);
						d?.destroy();
					}
				},
				() => {},
			),
		);
		c.on("close", (code) => {
			for (const d of channels.values()) d.destroy();
			channels.clear();
			if (child === c) child = undefined;
			if (closed) return;
			onState(`link to ${host.alias} down (${err.trim().split("\n").pop() || `exit ${code}`}); retrying`);
			setTimeout(connect, backoff).unref();
			backoff = Math.min(backoff * 2, 60_000);
		});
		c.on("error", () => {});
	}

	connect();
	return {
		update(agent) {
			current = agent;
			send({ op: "update", agent });
		},
		close() {
			closed = true;
			child?.stdin.end();
			const c = child;
			setTimeout(() => c?.kill(), 2_000).unref();
		},
	};
}
