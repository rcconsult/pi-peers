// Two real pi agents on this host. Needs pi installed (or PI_CLI); makes no model calls.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import { after, before, test } from "node:test";
import { PeersClient } from "../../src/client.ts";
import { type AgentEntry, listAgents, resolveAgent } from "../../src/discovery.ts";
import { encode, PeersError } from "../../src/protocol.ts";
import { type Agent, findPiCli, startAgent, tempHome, until } from "./helpers.ts";

const cli = findPiCli();
const home = tempHome();
process.env.PI_PEERS_HOME = home;
const me = { id: "e2e", label: "e2e", host: "test" };
let agents: Agent[] = [];
let t1: AgentEntry;

before(async () => {
	if (!cli) return;
	agents = [startAgent(cli, "t1", { PI_PEERS_HOME: home }), startAgent(cli, "t2", { PI_PEERS_HOME: home })];
	await until(async () => ((await listAgents()).length === 2 ? true : undefined));
	t1 = resolveAgent(await listAgents(), "T1");
});
after(async () => {
	await Promise.all(agents.map((a) => a.kill()));
	fs.rmSync(home, { recursive: true, force: true });
});

const skip = cli ? false : "pi not found: set PI_CLI to pi's cli.js";

/** Raw socket: send records, collect the first response's errorCode. */
async function raw(entry: AgentEntry, ...records: unknown[]): Promise<string | undefined> {
	const s = net.connect(entry.endpoint);
	await new Promise((r) => s.once("connect", r));
	for (const r of records) s.write(encode(r));
	const code = await new Promise<string | undefined>((r) => s.once("data", (d) => r(JSON.parse(String(d).split("\n")[0]).errorCode)));
	s.destroy();
	return code;
}

test("discovery finds both agents; names resolve case-insensitively", { skip }, async () => {
	assert.equal(t1.sessionName, "t1");
	assert.equal(t1.runtime, process.platform);
});

test("requests and refusals", { skip }, async () => {
	const c = await PeersClient.connect(t1, me);
	try {
		const state = await c.request("get_state");
		assert.equal(state.success, true);
		assert.equal((state.data as { idle: boolean }).idle, true);
		assert.equal("token" in (state.data as object), false, "state never includes the token");
		assert.equal((await c.request("frobnicate")).errorCode, "unsupported_command");
		assert.equal((await c.request("steer", { message: "x" })).errorCode, "steer_not_allowed");
		assert.equal((await c.request("prompt", { message: "x", hops: 4 })).errorCode, "hop_limit");
		assert.equal((await c.request("prompt", { message: " " })).errorCode, "invalid_request");
	} finally {
		c.close();
	}
});

test("ask policy shows a dialog; a declined message is denied; replaying its id doesn't ask again", { skip }, async () => {
	const c = await PeersClient.connect(t1, me);
	try {
		const first = await c.request("prompt", { message: "hello" }, 20_000, "dup-1");
		assert.equal(first.errorCode, "denied");
		const replay = await c.request("prompt", { message: "hello again" }, 20_000, "dup-1");
		assert.equal(replay.errorCode, "denied");
		assert.equal(agents[0].dialogs.length, 1, "exactly one dialog");
		assert.match(agents[0].dialogs[0], /pi-peers: prompt from "e2e"@test/);
	} finally {
		c.close();
	}
});

test("handshake failures", { skip }, async () => {
	await assert.rejects(PeersClient.connect({ ...t1, token: "nope" }, me), (e: unknown) => e instanceof PeersError && e.code === "auth_failed");
	assert.equal(await raw(t1, { id: "1", type: "get_state" }), "hello_required");
	assert.equal(await raw(t1, { id: "h", type: "hello", token: t1.token, protocol: { version: "2.0", minVersion: "2.0" } }), "incompatible_version");
	assert.equal(await raw(t1, { id: "h", type: "hello", token: t1.token }), "invalid_request");
});

test("status bar names the agent", { skip }, () => {
	assert.equal(agents[0].statuses.get("pi-peers"), "pi-peers: t1 (you)");
});

test("entries disappear when agents exit", { skip }, async () => {
	await Promise.all(agents.map((a) => a.kill()));
	await until(async () => ((await listAgents()).length === 0 ? true : undefined), 10_000);
});
