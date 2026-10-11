// pi-peers loaded twice in one pi (e.g. this repo's dev shim plus an installed package): pi must
// still start, with exactly one active copy, before and after a reload. Needs pi (or PI_CLI).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { PeersClient } from "../../src/client.ts";
import { listAgents } from "../../src/discovery.ts";
import { type Agent, findPiCli, REPO, startAgent, tempHome, until } from "./helpers.ts";

const cli = findPiCli();
const skip = cli ? false : "pi not found: set PI_CLI to pi's cli.js";
const home = tempHome();
const copyDir = tempHome("pi-peers-copy-");
process.env.PI_PEERS_HOME = home;
let agent: Agent;

before(async () => {
	if (!cli) return;
	// A second copy at a different path, like node_modules/pi-peers next to the repo's src/.
	fs.cpSync(path.join(REPO, "src"), path.join(copyDir, "src"), { recursive: true });
	const second = path.join(copyDir, "src/extension/index.ts");
	agent = startAgent(cli, "dup", { PI_PEERS_HOME: home }, false, {
		args: ["-e", second, "-e", path.join(REPO, "test/e2e/reload-command.ts")],
	});
});
after(async () => {
	await agent?.kill();
	fs.rmSync(home, { recursive: true, force: true });
	fs.rmSync(copyDir, { recursive: true, force: true });
});

const reachable = async () => {
	const agents = await listAgents();
	if (agents.length !== 1) return undefined;
	const c = await PeersClient.connect(agents[0], { id: "t", label: "t", host: "t" });
	const ok = (await c.request("get_state")).success;
	c.close();
	return ok ? agents[0] : undefined;
};

test("two copies: pi starts, one copy is active, the other says so", { skip }, async () => {
	const entry = await until(reachable, 20_000);
	assert.equal(entry.label, "dup");
	await until(() => (agent.notes.some((n) => n.includes("another copy is already active")) ? true : undefined), 10_000);
	assert.equal(agent.proc.exitCode, null, "pi is still running");
});

test("after a reload, exactly one copy is active again", { skip }, async () => {
	const before = agent.notes.filter((n) => n.includes("another copy is already active")).length;
	agent.ownerPrompt("/pp-test-reload");
	await until(() => (agent.notes.filter((n) => n.includes("another copy is already active")).length > before ? true : undefined), 20_000);
	const entry = await until(reachable, 20_000);
	assert.equal(entry.label, "dup");
	assert.equal((await listAgents()).length, 1, "still exactly one discovery entry");
});
