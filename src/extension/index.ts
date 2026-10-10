// pi-peers extension: makes this pi agent discoverable on the local host and lets it
// message peers. Phase 1 prototype of docs/adr/0001-pi-agent-discovery-and-remote-control.md.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { Duplex } from "node:stream";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PeersClient } from "../client.ts";
import { connectRemote, type ExposedAgent, listRemote, openReverseLink, readHosts, type ReverseLink, splitAddress } from "../hosts.ts";
import {
	type AgentEntry,
	endpointFor,
	ensureDirs,
	listAgents,
	newToken,
	peersHome,
	pidAlive,
	readEntry,
	publicEntry,
	removeEntry,
	resolveAgent,
	writeEntry,
} from "../discovery.ts";
import {
	encode,
	fail,
	lineReader,
	MAX_HOPS,
	negotiate,
	ok,
	type Peer,
	PeersError,
	PROTOCOL,
	provenanceHeader,
	type Request,
	type Response,
	SCHEMA_VERSION,
	type VersionRange,
} from "../protocol.ts";

const APPROVAL_TIMEOUT_MS = 120_000;
const DEDUPE_TTL_MS = 10 * 60_000;
const DELIVERY_TYPES = new Set(["prompt", "follow_up", "steer"]);

type PolicyMode = "ask" | "allow" | "deny";
interface Policy {
	default: PolicyMode;
	/** Peer labels (or host/label) delivered without asking. */
	allow: string[];
	/** Peer labels refused without asking. */
	deny: string[];
	/** Peer labels allowed to steer. */
	steer: string[];
}

const policyPath = (): string => path.join(peersHome(), "policy.json");

function loadPolicy(): Policy {
	const fallback: Policy = { default: "ask", allow: [], deny: [], steer: [] };
	try {
		return { ...fallback, ...JSON.parse(fs.readFileSync(policyPath(), "utf8")) };
	} catch {
		return fallback;
	}
}

function savePolicy(p: Policy): void {
	fs.mkdirSync(peersHome(), { recursive: true, mode: 0o700 });
	fs.writeFileSync(policyPath(), JSON.stringify(p, null, 2), { mode: 0o600 });
}

const matchesPeer = (list: string[], from: Peer): boolean =>
	list.some((x) => x === from.label || x === `${from.host}/${from.label}` || x === from.id);

function tokensEqual(a: unknown, b: string): boolean {
	if (typeof a !== "string") return false;
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function lastAssistantText(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch() as Array<{ type: string; message?: { role?: string; content?: unknown } }>;
	for (let i = branch.length - 1; i >= 0; i--) {
		const m = branch[i].message;
		if (branch[i].type !== "message" || m?.role !== "assistant") continue;
		if (typeof m.content === "string") return m.content;
		if (Array.isArray(m.content)) {
			return m.content
				.filter((c: { type?: string }) => c?.type === "text")
				.map((c: { text?: string }) => c.text ?? "")
				.join("");
		}
	}
	return undefined;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

export default function piPeers(pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	let server: net.Server | undefined;
	let entry: AgentEntry | undefined;
	let settled = 0;
	/** Hop count of the peer message currently driving this agent; 0 when the user is. */
	let chainHops = 0;
	const dedupe = new Map<string, { at: number; response: Promise<Response> }>();
	let approvals: Promise<unknown> = Promise.resolve();

	const host = os.hostname();
	const self = (): Peer => ({ id: entry?.id ?? "?", label: entry?.label ?? "?", host });

	function labelFor(c: ExtensionContext, id: string): string {
		return pi.getSessionName() || path.basename(c.cwd) || id;
	}

	function publish(): void {
		if (!entry || !ctx) return;
		entry.sessionName = pi.getSessionName();
		entry.label = labelFor(ctx, entry.id);
		writeEntry(entry);
		ctx.ui.setStatus("pi-peers", `pi-peers: ${entry.label} (you)`);
		for (const l of links) l.update(exposed());
	}

	/** What reverse links publish about this agent on other hosts. */
	function exposed(): ExposedAgent {
		const { id, sessionName, piSessionId, label, host: h, runtime, cwd, protocol, schemaVersion } = entry!;
		return { id, sessionName, piSessionId, label, host: h, runtime, cwd, protocol, schemaVersion };
	}

	/** One line telling the receiving model how to answer, so it doesn't try a path that doesn't exist. */
	async function replyHint(from: Peer, awaitsReply: boolean): Promise<string> {
		if (awaitsReply) return `"${from.label}" is waiting for your answer: reply by answering normally, not with peers_send.`;
		const back = (await listAgents()).some((a) => a.id === from.id);
		return back
			? `To message "${from.label}" later, use peers_send to="${from.label}".`
			: `"${from.label}" can't be messaged back from here; put anything for it in your answer, which it can read with peers_read.`;
	}

	function state() {
		return {
			...publicEntry(entry!),
			idle: ctx?.isIdle() ?? true,
			settled,
		};
	}

	async function approve(from: Peer, req: Request, message: string): Promise<Response | undefined> {
		const policy = loadPolicy();
		if (matchesPeer(policy.deny, from)) return fail(req, "denied", `peer "${from.label}" is denied`);
		if (matchesPeer(policy.allow, from) || policy.default === "allow") return undefined;
		if (policy.default === "deny") return fail(req, "denied", "inbound peer messages are denied");
		if (!ctx?.hasUI) return fail(req, "no_ui", "approval required but this agent has no UI");

		// One dialog at a time; a second peer waits its turn.
		const run = approvals.then(async () => {
			const started = Date.now();
			const preview = message.length > 400 ? `${message.slice(0, 400)}…` : message;
			const yes = await ctx!.ui.confirm(
				`pi-peers: ${req.type} from "${from.label}"@${from.host}?`,
				preview,
				{ timeout: APPROVAL_TIMEOUT_MS },
			);
			if (yes) return undefined;
			return Date.now() - started >= APPROVAL_TIMEOUT_MS - 500
				? fail(req, "approval_timeout", "approval timed out")
				: fail(req, "denied", "declined by the user");
		});
		approvals = run.catch(() => {});
		return run;
	}

	async function deliver(from: Peer, req: Request): Promise<Response> {
		const message = req.message;
		const hops = typeof req.hops === "number" ? req.hops : 1;
		if (typeof message !== "string" || !message.trim()) return fail(req, "invalid_request", "message must be a non-empty string");
		if (hops > MAX_HOPS) return fail(req, "hop_limit", `message exceeds ${MAX_HOPS} hops`);
		if (req.type === "steer" && !matchesPeer(loadPolicy().steer, from)) {
			return fail(req, "steer_not_allowed", `peer "${from.label}" may not steer; send follow_up instead`);
		}
		const refused = await approve(from, req, message);
		if (refused) return refused;

		const hint = await replyHint(from, req.awaitsReply === true);
		const body = `${provenanceHeader(from, hops)}\n${hint}\n\n${message}`;
		const idle = ctx!.isIdle();
		chainHops = hops;
		if (idle) pi.sendUserMessage(body);
		else pi.sendUserMessage(body, { deliverAs: req.type === "steer" ? "steer" : "followUp" });
		return ok(req, { delivered: idle ? "now" : req.type === "steer" ? "steer" : "followUp", settled });
	}

	async function handle(from: Peer, req: Request): Promise<Response> {
		switch (req.type) {
			case "get_state":
				return ok(req, state());
			case "get_last_assistant_text":
				return ok(req, { text: ctx ? lastAssistantText(ctx) : undefined });
			case "prompt":
			case "follow_up":
			case "steer": {
				const now = Date.now();
				for (const [k, v] of dedupe) if (now - v.at > DEDUPE_TTL_MS) dedupe.delete(k);
				const seen = dedupe.get(req.id);
				if (seen) return seen.response;
				const response = deliver(from, req);
				dedupe.set(req.id, { at: now, response });
				return response;
			}
			default:
				return fail(req, "unsupported_command", `unknown command "${req.type}"`);
		}
	}

	/** `trusted`: a reverse-link channel, already authenticated by SSH and the far end's token check. */
	function onConnection(sock: Duplex, trusted = false): void {
		connections.add(sock);
		sock.on("close", () => connections.delete(sock));
		let from: Peer | undefined;
		const send = (r: Response) => sock.writable && sock.write(encode(r));
		sock.on("error", () => {});
		sock.on(
			"data",
			lineReader(
				(rec) => {
					const req = rec as Request;
					if (!req || typeof req.id !== "string" || typeof req.type !== "string") {
						send(fail({ id: String(req?.id ?? ""), type: String(req?.type ?? "") }, "invalid_request", "record needs string id and type"));
						return;
					}
					if (!from) {
						if (req.type !== "hello") {
							send(fail(req, "hello_required", "first record must be hello"));
							sock.end();
							return;
						}
						if (!entry || (!trusted && !tokensEqual(req.token, entry.token))) {
							send(fail(req, "auth_failed", "bad token"));
							sock.end();
							return;
						}
						let agreed: string | undefined;
						try {
							agreed = negotiate(PROTOCOL, req.protocol as VersionRange);
						} catch {
							send(fail(req, "invalid_request", "hello.protocol must be {version, minVersion} as MAJOR.MINOR"));
							sock.end();
							return;
						}
						if (!agreed) {
							send(fail(req, "incompatible_version", "no common protocol version", { agent: PROTOCOL, client: req.protocol }));
							sock.end();
							return;
						}
						const f = req.from as Partial<Peer> | undefined;
						from = { id: String(f?.id ?? "?"), label: String(f?.label ?? "unknown"), host: String(f?.host ?? "?") };
						send(ok(req, { protocol: agreed, agent: state() }));
						return;
					}
					handle(from, req).then(send, (e) => send(fail(req, "internal_error", String(e?.message ?? e))));
				},
				() => send(fail({ id: "", type: "" }, "invalid_request", "record is not valid JSON")),
			),
		);
	}

	const connections = new Set<Duplex>();
	let links: ReverseLink[] = [];

	/** Close the endpoint and wait until it's released, so a restart can reuse the same pipe name. */
	async function stop(): Promise<void> {
		const srv = server;
		server = undefined;
		if (entry) removeEntry(entry.id);
		entry = undefined;
		for (const l of links) l.close();
		links = [];
		for (const s of connections) s.destroy();
		connections.clear();
		if (srv) await new Promise<void>((resolve) => srv.close(() => resolve()));
	}

	/**
	 * The agent id is pi's session id, so an address stays valid across /reload and /resume.
	 * A second live process on the same session gets its pid appended.
	 */
	function agentIdFor(c: ExtensionContext): string {
		const base = (c.sessionManager.getSessionId() || crypto.randomUUID()).replace(/[^A-Za-z0-9._-]/g, "_");
		const other = readEntry(base);
		return other && other.pid !== process.pid && pidAlive(other.pid) ? `${base}-${process.pid}` : base;
	}

	pi.on("session_start", async (_event, c) => {
		ctx = c;
		await stop();
		const id = agentIdFor(c);
		entry = {
			schemaVersion: SCHEMA_VERSION,
			protocol: PROTOCOL,
			id,
			sessionName: pi.getSessionName(),
			piSessionId: c.sessionManager.getSessionId(),
			label: labelFor(c, id),
			host,
			runtime: process.platform,
			pid: process.pid,
			cwd: c.cwd,
			endpoint: endpointFor(id),
			token: newToken(),
			startedAt: new Date().toISOString(),
		};
		// The socket directory must exist before listen; on Linux a missing one surfaces as EACCES.
		ensureDirs();
		if (process.platform !== "win32") fs.rmSync(entry.endpoint, { force: true });
		const srv = net.createServer((sock) => onConnection(sock));
		try {
			await new Promise<void>((resolve, reject) => {
				srv.once("error", reject);
				srv.listen(entry!.endpoint, () => resolve());
			});
		} catch (e) {
			entry = undefined;
			throw e;
		}
		server = srv;
		publish();
		const linkState = new Map<string, string>();
		links = readHosts()
			.filter((h) => h.reverse)
			.map((h) =>
				openReverseLink(h, exposed(), (stream) => onConnection(stream, true), (state) => {
					linkState.set(h.alias, state);
					ctx?.ui.setStatus("pi-peers-links", [...linkState.values()].join(" · "));
				}),
			);
	});

	pi.on("session_info_changed", (_e, c) => {
		ctx = c;
		publish();
	});
	pi.on("agent_settled", (_e, c) => {
		ctx = c;
		settled++;
	});
	pi.on("input", (e, c) => {
		ctx = c;
		if (e.source !== "extension") chainHops = 0;
	});
	pi.on("session_shutdown", () => stop());
	process.once("exit", () => entry && removeEntry(entry.id));

	/** Connect by local address, or by "<ssh alias>/<address>" for a host listed in the hosts file. */
	async function connectTo(address: string): Promise<{ client: PeersClient; target: { label: string } }> {
		const split = splitAddress(address);
		if (split.host) {
			const client = await connectRemote(split.host, split.address, self());
			return { client, target: { label: `${split.host.alias}/${split.address}` } };
		}
		const peers = (await listAgents()).filter((a) => a.id !== entry?.id);
		const target = resolveAgent(peers, split.address);
		return { client: await PeersClient.connect(target, self()), target };
	}

	function check(r: Response): Response {
		if (!r.success) throw new PeersError(r.errorCode ?? "internal_error", r.error ?? "request failed", r.data);
		return r;
	}

	pi.registerTool({
		name: "peers_list",
		label: "pi-peers: list",
		description:
			"List other pi agents that can be messaged with peers_send: agents on this host, and agents on " +
			'SSH hosts from the pi-peers hosts file, addressed as "<host>/<name>".',
		promptSnippet: "List peer pi agents on this host and configured SSH hosts",
		parameters: Type.Object({
			remote: Type.Optional(Type.Boolean({ description: "Also query SSH hosts (default true)" })),
		}),
		async execute(_id, params) {
			return text(await describePeers({ remote: params.remote !== false, details: true }));
		},
	});

	/**
	 * One listing for both the peers_list tool and /peers, so they can't drift apart.
	 * `details` adds ids and cwds, which the model needs and people mostly don't.
	 */
	async function describePeers(opts: { remote: boolean; details: boolean }): Promise<string> {
		const row = (address: string, status: string, id: string, cwd: string) =>
			opts.details ? `- "${address}" ${status} id=${id} cwd=${cwd}` : `- ${address} (${status})`;

		const local = (await listAgents()).filter((a) => a.id !== entry?.id);
		const rowsFor = (agents: typeof local) =>
			Promise.all(
				agents.map(async (p) => {
				let status = "?";
				try {
					const c = await PeersClient.connect(p, self());
					const s = await c.request("get_state", {}, 3_000);
					c.close();
					status = s.success ? ((s.data as { idle: boolean }).idle ? "idle" : "busy") : (s.errorCode ?? "error");
				} catch (e) {
					status = e instanceof PeersError ? e.code : "error";
				}
				return row(p.label, status, p.id, p.cwd);
				}),
			);
		const localRows = await rowsFor(local.filter((a) => !a.via));
		// Agents published here by another host's reverse link: addressed like local ones, but they run elsewhere.
		const viaHosts = [...new Set(local.filter((a) => a.via).map((a) => a.via!))];
		const viaBlocks = await Promise.all(
			viaHosts.map(async (v) => [`Reached through ${v}'s reverse link:`, ...(await rowsFor(local.filter((a) => a.via === v)))]),
		);
		const remoteBlocks = await Promise.all(
			(opts.remote ? readHosts() : []).map(async (h) => {
				try {
					// Skip entries a reverse link published there: they're agents from elsewhere, maybe even this one.
					const agents = (await listRemote(h)).filter((a) => !a.via);
					if (!agents.length) return [`Host ${h.alias}: no agents`];
					return [`Host ${h.alias}:`, ...agents.map((a) => row(`${h.alias}/${a.label}`, a.status ?? "?", a.id, a.cwd))];
				} catch (e) {
					return [`Host ${h.alias}: unreachable (${e instanceof PeersError ? e.message : String(e)})`];
				}
			}),
		);
		return [
			`You: ${entry?.label ?? "?"}`,
			...(localRows.length ? ["This host:", ...localRows] : ["This host: no other agents"]),
			...viaBlocks.flat(),
			...remoteBlocks.flat(),
		].join("\n");
	}

	function describePolicy(p: Policy): string {
		const mode = { ask: "ask before delivering", allow: "deliver without asking", deny: "refuse" }[p.default];
		const names = (xs: string[]) => (xs.length ? xs.join(", ") : "none");
		return `Incoming messages: ${mode} · always allow: ${names(p.allow)} · always deny: ${names(p.deny)} · may steer: ${names(p.steer)}`;
	}

	pi.registerTool({
		name: "peers_send",
		label: "pi-peers: send",
		description:
			"Send a message to another pi agent on this host, addressed by session name, label or id. " +
			"The peer's user may have to approve it. With wait=true, returns the peer's reply when its run finishes.",
		promptSnippet: "Send a message to a peer pi agent",
		parameters: Type.Object({
			to: Type.String({ description: 'Peer session name, label or id; "<host>/<name>" for an SSH host' }),
			message: Type.String({ description: "Message for the peer" }),
			mode: Type.Optional(Type.Union([Type.Literal("prompt"), Type.Literal("follow_up"), Type.Literal("steer")])),
			wait: Type.Optional(Type.Boolean({ description: "Wait for and return the peer's reply" })),
			timeoutSec: Type.Optional(Type.Number({ description: "Max seconds to wait for the reply (default 300)" })),
		}),
		async execute(_id, params, signal) {
			const { client, target } = await connectTo(params.to);
			try {
				const accepted = check(
					await client.request(
						params.mode ?? "prompt",
						{ message: params.message, hops: chainHops + 1, awaitsReply: params.wait === true },
						APPROVAL_TIMEOUT_MS + 10_000,
					),
				);
				const { delivered, settled: before } = accepted.data as { delivered: string; settled: number };
				if (!params.wait) return text(`Delivered to "${target.label}" (${delivered}).`);

				const deadline = Date.now() + (params.timeoutSec ?? 300) * 1000;
				while (Date.now() < deadline && !signal?.aborted) {
					await new Promise((r) => setTimeout(r, 1000));
					const s = check(await client.request("get_state", {}, 5_000)).data as { idle: boolean; settled: number };
					if (s.idle && s.settled > before) {
						const reply = check(await client.request("get_last_assistant_text", {}, 5_000)).data as { text?: string };
						return text(`Reply from "${target.label}":\n\n${reply.text ?? "(no text)"}`);
					}
				}
				return text(`Delivered to "${target.label}" (${delivered}); no reply within the wait time.`);
			} finally {
				client.close();
			}
		},
	});

	pi.registerTool({
		name: "peers_read",
		label: "pi-peers: read",
		description: "Read another pi agent's state or its last assistant message.",
		parameters: Type.Object({
			to: Type.String({ description: 'Peer session name, label or id; "<host>/<name>" for an SSH host' }),
			what: Type.Optional(Type.Union([Type.Literal("last"), Type.Literal("state")])),
		}),
		async execute(_id, params) {
			const { client, target } = await connectTo(params.to);
			try {
				if (params.what === "state") {
					return text(JSON.stringify(check(await client.request("get_state")).data, null, 2));
				}
				const r = check(await client.request("get_last_assistant_text")).data as { text?: string };
				return text(`Last message from "${target.label}":\n\n${r.text ?? "(none)"}`);
			} finally {
				client.close();
			}
		},
	});

	pi.registerCommand("peers", {
		description: "pi-peers: list peers and set the inbound policy: /peers [list | policy ask|allow|deny | allow|deny|steer|forget <label>]",
		handler: async (args, c) => {
			const [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const arg = rest.join(" ");
			const p = loadPolicy();
			if (verb === "policy" && ["ask", "allow", "deny"].includes(arg)) p.default = arg as PolicyMode;
			else if (verb && ["allow", "deny", "steer"].includes(verb) && arg) {
				const list = p[verb as "allow" | "deny" | "steer"];
				if (!list.includes(arg)) list.push(arg);
			} else if (verb === "forget" && arg) {
				for (const k of ["allow", "deny", "steer"] as const) p[k] = p[k].filter((x) => x !== arg);
			} else if (verb && verb !== "list") {
				c.ui.notify("Usage: /peers [list | policy ask|allow|deny | allow|deny|steer|forget <label>]", "warning");
			}
			const changed = verb === "policy" || (["allow", "deny", "steer", "forget"].includes(verb ?? "") && !!arg);
			if (changed) savePolicy(p);

			c.ui.notify(`${await describePeers({ remote: true, details: false })}\n${describePolicy(p)}`, "info");
		},
	});
}
