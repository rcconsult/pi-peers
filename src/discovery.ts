// Rendezvous directory: one JSON file per live agent under $PI_PEERS_HOME/agents.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { PeersError } from "./protocol.ts";
import type { AgentEntry } from "./schema.gen.ts";

export type { AgentEntry };

export const peersHome = (): string => process.env.PI_PEERS_HOME || path.join(os.homedir(), ".pi-peers");
const agentsDir = (): string => path.join(peersHome(), "agents");
const entryPath = (id: string): string => path.join(agentsDir(), `${id}.json`);

export function ensureDirs(): void {
	fs.mkdirSync(agentsDir(), { recursive: true, mode: 0o700 });
	if (process.platform === "win32") return;
	const run = path.join(peersHome(), "run");
	fs.mkdirSync(run, { recursive: true, mode: 0o700 });
	// mkdir leaves existing directories alone; tighten them so only this user can reach the sockets.
	for (const dir of [peersHome(), agentsDir(), run]) fs.chmodSync(dir, 0o700);
}

// sockaddr_un.sun_path is 108 bytes on Linux and 104 on macOS, including the terminating NUL.
const MAX_SOCKET_PATH = process.platform === "darwin" ? 103 : 107;

export function endpointFor(id: string): string {
	if (process.platform === "win32") {
		const user = os.userInfo().username.replace(/[^A-Za-z0-9._-]/g, "_");
		return `\\\\.\\pipe\\pi-peers-${user}-${id}`;
	}
	const sock = path.join(peersHome(), "run", `${id}.sock`);
	if (Buffer.byteLength(sock) > MAX_SOCKET_PATH) {
		throw new PeersError("internal_error", `socket path too long (${Buffer.byteLength(sock)} bytes): set PI_PEERS_HOME to a shorter directory`);
	}
	return sock;
}

export const newToken = (): string => crypto.randomBytes(32).toString("hex");

export function writeEntry(entry: AgentEntry): void {
	ensureDirs();
	const target = entryPath(entry.id);
	const tmp = `${target}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(entry, null, 2), { mode: 0o600 });
	fs.renameSync(tmp, target);
}

export function removeEntry(id: string): void {
	fs.rmSync(entryPath(id), { force: true });
}

export function readEntry(id: string): AgentEntry | undefined {
	try {
		return JSON.parse(fs.readFileSync(entryPath(id), "utf8"));
	} catch {
		return undefined;
	}
}

function readEntries(): AgentEntry[] {
	let names: string[];
	try {
		names = fs.readdirSync(agentsDir());
	} catch {
		return [];
	}
	const entries: AgentEntry[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			entries.push(JSON.parse(fs.readFileSync(path.join(agentsDir(), name), "utf8")));
		} catch {
			// Half-written or corrupt; a later list retries it.
		}
	}
	return entries;
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

function probe(endpoint: string, timeoutMs = 1000): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = net.connect(endpoint);
		const done = (alive: boolean) => {
			sock.destroy();
			resolve(alive);
		};
		sock.setTimeout(timeoutMs, () => done(false));
		sock.once("connect", () => done(true));
		sock.once("error", () => done(false));
	});
}

/** Live agents, pruning entries whose process or endpoint is gone. */
export async function listAgents(): Promise<AgentEntry[]> {
	const live: AgentEntry[] = [];
	await Promise.all(
		readEntries().map(async (e) => {
			// An entry from another runtime sharing this directory (e.g. WSL and Windows) can't be
			// checked from here: its PID is in another namespace. Skip it rather than prune it.
			if (e.runtime && e.runtime !== process.platform) return;
			if (pidAlive(e.pid) && (await probe(e.endpoint))) {
				live.push(e);
				return;
			}
			removeEntry(e.id);
			// A crashed agent leaves its socket file behind; Windows pipes vanish with the process.
			if (process.platform !== "win32" && e.endpoint?.startsWith(path.join(peersHome(), "run"))) {
				fs.rmSync(e.endpoint, { force: true });
			}
		}),
	);
	return live.sort((a, b) => a.label.localeCompare(b.label));
}

/** Resolve an address by id, then sessionName, then label (exact, then unique case-insensitive). */
export function resolveAgent(agents: AgentEntry[], address: string): AgentEntry {
	const byId = agents.find((a) => a.id === address);
	if (byId) return byId;
	for (const key of ["sessionName", "label"] as const) {
		const exact = agents.filter((a) => a[key] === address);
		const matches = exact.length ? exact : agents.filter((a) => a[key]?.toLowerCase() === address.toLowerCase());
		if (matches.length === 1) return matches[0];
		if (matches.length > 1) {
			throw new PeersError(
				"ambiguous_target",
				`"${address}" matches ${matches.length} agents; use an id`,
				matches.map((a) => ({ id: a.id, cwd: a.cwd })),
			);
		}
	}
	throw new PeersError("agent_not_found", `no live agent matches "${address}"`);
}

/** Public view of an entry: never includes the token. */
export function publicEntry({ token: _token, ...rest }: AgentEntry): Omit<AgentEntry, "token"> {
	return rest;
}
