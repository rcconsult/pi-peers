#!/usr/bin/env node
// pi-peers CLI. Runs on plain Node >= 22.18 (built-in TypeScript type stripping).
//
//   pi-peers list [--json]     live agents on this host (never prints tokens)
//   pi-peers bridge <address>  relay stdin/stdout to one local agent; used over SSH

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import { PeersClient } from "./client.ts";
import {
	type AgentEntry,
	endpointFor,
	ensureDirs,
	listAgents,
	newToken,
	publicEntry,
	removeEntry,
	resolveAgent,
	writeEntry,
} from "./discovery.ts";
import type { ExposedAgent } from "./hosts.ts";
import { encode, fail, lineReader, PeersError, type Request } from "./protocol.ts";

const STOP = Symbol("stop");
const cliPeer = () => ({ id: `cli-${process.pid}`, label: "pi-peers cli", host: os.hostname() });

async function list(json: boolean): Promise<void> {
	const agents = await listAgents();
	const rows = await Promise.all(
		agents.map(async (a) => {
			let idle: boolean | undefined;
			let status = "?";
			try {
				const c = await PeersClient.connect(a, cliPeer());
				const s = await c.request("get_state", {}, 3_000);
				c.close();
				if (s.success) {
					idle = (s.data as { idle: boolean }).idle;
					status = idle ? "idle" : "busy";
				} else status = s.errorCode ?? "error";
			} catch (e) {
				status = e instanceof PeersError ? e.code : "error";
			}
			return { ...publicEntry(a), idle, status };
		}),
	);
	if (json) {
		process.stdout.write(`${JSON.stringify(rows)}\n`);
		return;
	}
	if (!rows.length) console.log("No agents found.");
	for (const r of rows) console.log(`"${r.label}"\t${r.status}\t${r.id}\t${r.cwd}`);
}

/**
 * Reads the client's first record, which must be hello, adds this host's token for the
 * target agent, then copies bytes both ways. Version negotiation stays end to end.
 */
function bridge(address: string): void {
	let buf = Buffer.alloc(0);
	const onData = (chunk: Buffer) => {
		buf = Buffer.concat([buf, chunk]);
		const nl = buf.indexOf(0x0a);
		if (nl < 0) return;
		process.stdin.off("data", onData);
		process.stdin.pause();
		const first = buf.subarray(0, nl).toString();
		const rest = buf.subarray(nl + 1);
		start(first, rest).catch((e) => {
			if (e === STOP) return;
			process.stderr.write(`pi-peers bridge: ${e?.message ?? e}\n`);
			process.exit(1);
		});
	};
	process.stdin.on("data", onData);
	process.stdin.on("end", () => process.exit(0));

	// Exit only after the record is flushed; stdout over an SSH pipe is asynchronous.
	function replyAndExit(rec: unknown): never {
		process.stdout.write(encode(rec), () => process.exit(0));
		throw STOP;
	}

	async function start(firstLine: string, rest: Buffer): Promise<void> {
		let hello: Request;
		try {
			hello = JSON.parse(firstLine);
		} catch {
			replyAndExit(fail({ id: "", type: "" }, "invalid_request", "record is not valid JSON"));
		}
		if (hello?.type !== "hello") {
			replyAndExit(fail(hello, "hello_required", "first record must be hello"));
		}
		let target: AgentEntry;
		try {
			target = resolveAgent(await listAgents(), address);
		} catch (e) {
			const pe = e instanceof PeersError ? e : new PeersError("internal_error", String(e));
			replyAndExit(fail(hello, pe.code, pe.message, pe.data));
		}
		const sock = net.connect(target.endpoint);
		let connected = false;
		sock.once("error", (e) => {
			if (connected) return; // the close handler below finishes up
			const rec = fail(hello, "agent_unavailable", `connect to ${target.label} failed: ${e.message}`);
			process.stdout.write(encode(rec), () => process.exit(0));
		});
		sock.once("connect", () => {
			connected = true;
			sock.write(encode({ ...hello, token: target.token }));
			if (rest.length) sock.write(rest);
			process.stdin.pipe(sock);
			sock.pipe(process.stdout);
			process.stdin.resume();
			sock.on("close", () => process.stdout.write("", () => process.exit(0)));
		});
	}
}

/**
 * Far end of a reverse link (see openReverseLink in hosts.ts). Publishes the remote agent here,
 * with its own endpoint and token, and forwards each local connection over stdio as a channel.
 * Local clients authenticate here with the token; the other end trusts the SSH session.
 */
function expose(): void {
	let entry: AgentEntry | undefined;
	let server: net.Server | undefined;
	let nextCh = 1;
	const sockets = new Map<number, net.Socket>();
	const out = (rec: unknown) => process.stdout.write(encode(rec));

	const finish = () => {
		if (entry) removeEntry(entry.id);
		server?.close();
		for (const s of sockets.values()) s.destroy();
		process.exit(0);
	};
	process.stdin.on("end", finish);
	process.on("SIGTERM", finish);
	process.on("SIGHUP", finish);

	function publish(agent: ExposedAgent): void {
		entry = {
			...agent,
			via: agent.host,
			remoteRuntime: agent.runtime,
			runtime: process.platform,
			pid: process.pid,
			endpoint: entry?.endpoint ?? endpointFor(`${agent.id}-via`),
			token: entry?.token ?? newToken(),
			startedAt: entry?.startedAt ?? new Date().toISOString(),
		} as AgentEntry;
		writeEntry(entry);
	}

	function onConnection(sock: net.Socket): void {
		const ch = nextCh++;
		let authed = false;
		sockets.set(ch, sock);
		out({ ch, op: "open" });
		sock.on(
			"data",
			lineReader(
				(rec) => {
					const r = rec as Request;
					if (!authed) {
						if (r?.type !== "hello") {
							sock.end(encode(fail(r ?? { id: "", type: "" }, "hello_required", "first record must be hello")));
							return;
						}
						if (r.token !== entry?.token) {
							sock.end(encode(fail(r, "auth_failed", "bad token")));
							return;
						}
						authed = true;
						const { token: _t, ...rest } = r;
						out({ ch, op: "rec", rec: rest });
						return;
					}
					out({ ch, op: "rec", rec: r });
				},
				() => {},
			),
		);
		sock.on("error", () => {});
		sock.on("close", () => {
			if (sockets.delete(ch)) out({ ch, op: "close" });
		});
	}

	process.stdin.on(
		"data",
		lineReader(
			(raw) => {
				const m = raw as { op?: string; ch?: number; rec?: unknown; agent?: ExposedAgent };
				if (m.op === "expose" && m.agent && !server) {
					ensureDirs();
					publish(m.agent);
					if (process.platform !== "win32") fs.rmSync(entry!.endpoint, { force: true });
					server = net.createServer(onConnection);
					server.on("error", (e) => {
						process.stderr.write(`pi-peers expose: ${e.message}\n`);
						finish();
					});
					server.listen(entry!.endpoint, () => out({ op: "ready" }));
				} else if (m.op === "update" && m.agent) {
					publish(m.agent);
				} else if (m.op === "rec" && typeof m.ch === "number") {
					sockets.get(m.ch)?.write(encode(m.rec));
				} else if (m.op === "close" && typeof m.ch === "number") {
					const s = sockets.get(m.ch);
					sockets.delete(m.ch);
					s?.end();
				}
			},
			() => {},
		),
	);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "list") {
	list(args.includes("--json")).catch((e) => {
		process.stderr.write(`pi-peers list: ${e?.message ?? e}\n`);
		process.exit(1);
	});
} else if (cmd === "bridge" && args.length) {
	bridge(args.join(" "));
} else if (cmd === "expose") {
	expose();
} else {
	process.stderr.write("usage: pi-peers list [--json] | pi-peers bridge <id|sessionName|label> | pi-peers expose\n");
	process.exit(2);
}
