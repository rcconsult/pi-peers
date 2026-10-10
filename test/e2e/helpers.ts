// Shared helpers for end-to-end tests: real pi agents in RPC mode, no model calls.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const REPO = path.resolve(import.meta.dirname, "../..");
export const EXTENSION = path.join(REPO, "src/extension/index.ts");

/** pi's cli.js: $PI_CLI, else the managed install under ~/.pi/agent. */
export function findPiCli(): string | undefined {
	if (process.env.PI_CLI) return process.env.PI_CLI;
	try {
		const root = path.join(os.homedir(), ".pi/agent/install");
		const ver = fs.readFileSync(path.join(root, "current-version"), "utf8").trim();
		const cli = path.join(root, "releases", ver, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
		return fs.existsSync(cli) ? cli : undefined;
	} catch {
		return undefined;
	}
}

export function tempHome(prefix = "pi-peers-e2e-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface Agent {
	proc: ChildProcessWithoutNullStreams;
	/** Titles of approval dialogs seen so far. */
	dialogs: string[];
	notes: string[];
	statuses: Map<string, string>;
	kill(): Promise<void>;
}

/** Start a headless pi with the extension. Approval dialogs are answered with `confirm`. */
export function startAgent(cli: string, name: string, env: NodeJS.ProcessEnv, confirm = false): Agent {
	const proc = spawn(process.execPath, [cli, "--mode", "rpc", "--no-session", "--offline", "-ne", "-na", "-e", EXTENSION, "--name", name], {
		cwd: REPO,
		env: { ...process.env, ...env },
	});
	const agent: Agent = {
		proc,
		dialogs: [],
		notes: [],
		statuses: new Map(),
		kill: () =>
			new Promise((resolve) => {
				if (proc.exitCode !== null) return resolve();
				proc.once("exit", () => resolve());
				proc.kill();
			}),
	};
	let buf = "";
	proc.stdout.on("data", (d) => {
		buf += d;
		let i: number;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			let r: { type?: string; method?: string; id?: string; title?: string; message?: string; statusKey?: string; statusText?: string };
			try {
				r = JSON.parse(line);
			} catch {
				continue;
			}
			if (r.type !== "extension_ui_request") continue;
			if (r.method === "confirm") {
				agent.dialogs.push(r.title ?? "");
				proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: r.id, confirmed: confirm })}\n`);
			} else if (r.method === "notify") agent.notes.push(r.message ?? "");
			else if (r.method === "setStatus" && r.statusKey) agent.statuses.set(r.statusKey, r.statusText ?? "");
		}
	});
	proc.stderr.on("data", () => {});
	return agent;
}

export async function until<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 20_000, everyMs = 300): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v !== undefined && v !== false) return v as T;
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await new Promise((r) => setTimeout(r, everyMs));
	}
}

/** SSH end-to-end settings, from the environment. See README "Running the tests". */
export function sshConfig() {
	const host = process.env.PI_PEERS_E2E_SSH_HOST;
	const repo = process.env.PI_PEERS_E2E_REMOTE_REPO;
	const piCli = process.env.PI_PEERS_E2E_REMOTE_PI_CLI;
	if (!host || !repo || !piCli) return undefined;
	const node = process.env.PI_PEERS_E2E_REMOTE_NODE || "node";
	return { host, repo, piCli, node, cliCommand: `${node} ${repo}/src/cli.ts` };
}

/** Run a command on the SSH host; resolves with stdout. */
export function ssh(host: string, command: string, timeoutMs = 60_000): Promise<string> {
	return new Promise((resolve, reject) => {
		const p = spawn("ssh", ["-o", "BatchMode=yes", "-T", host, command]);
		let out = "";
		let err = "";
		const t = setTimeout(() => p.kill(), timeoutMs);
		p.stdout.on("data", (d) => (out += d));
		p.stderr.on("data", (d) => (err += d));
		p.on("close", (code) => {
			clearTimeout(t);
			if (code === 0) resolve(out.split("\r").join(""));
			else reject(new Error(`ssh ${host} exited ${code}: ${err.trim()}`));
		});
	});
}

/** Start a long-running command on the SSH host; `stop()` ends it via stdin. */
export function sshSpawn(host: string, command: string) {
	const p = spawn("ssh", ["-o", "BatchMode=yes", "-T", host, command]);
	let out = "";
	p.stdout.on("data", (d) => (out += d));
	p.stderr.on("data", () => {});
	return {
		output: () => out,
		stop: () =>
			new Promise<void>((resolve) => {
				if (p.exitCode !== null) return resolve();
				p.once("close", () => resolve());
				p.stdin.write("stop\n");
				setTimeout(() => p.kill(), 3_000).unref();
			}),
	};
}
