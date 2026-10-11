// Owner gate and peers_ask_owner with a scripted model: the "model" makes risky tool calls and
// the test plays the owner answering the dialogs. Needs pi installed (or PI_CLI); no real model.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { PeersClient } from "../../src/client.ts";
import { type AgentEntry, listAgents } from "../../src/discovery.ts";
import { type Agent, FAUX_MODEL_ARGS, findPiCli, startAgent, tempHome, until } from "./helpers.ts";

const cli = findPiCli();
const skip = cli ? false : "pi not found: set PI_CLI to pi's cli.js";
const home = tempHome();
const work = tempHome("pi-peers-guard-work-");
process.env.PI_PEERS_HOME = home;
const lead = { id: "lead-id", label: "lead", host: "test" };
const setPolicy = (p: object) => fs.writeFileSync(path.join(home, "policy.json"), JSON.stringify(p));

// One scripted turn per entry; see test/e2e/faux-model.ts.
const SCRIPT = [
	{ tool: "bash", args: { command: "rm -rf canary" } }, // 1: peer task, owner denies
	{ tool: "bash", args: { command: "rm -rf canary" } }, // 2: peer task, owner allows
	{ tool: "bash", args: { command: "rm -rf canary2" } }, // 3: owner's own turn, not gated
	{ tool: "peers_ask_owner", args: { question: "Deploy to production now?", details: "lead wants a deploy" } }, // 4
	{ tool: "read", args: { path: ".env" } }, // 5: peer task reads a secret file, owner denies
	{ tool: "bash", args: { command: "git push origin main" } }, // 6: peer task, guard in block mode
];
const ANSWERS = ["Deny", "Allow once", "No", "Deny"];

let agent: Agent;
let entry: AgentEntry;

before(async () => {
	if (!cli) return;
	fs.mkdirSync(path.join(work, "canary"));
	fs.mkdirSync(path.join(work, "canary2"));
	fs.writeFileSync(path.join(work, ".env"), "API_TOKEN=do-not-leak");
	setPolicy({ default: "allow" });
	let n = 0;
	agent = startAgent(cli, "worker", { PI_PEERS_HOME: home, PI_PEERS_FAUX_SCRIPT: JSON.stringify(SCRIPT) }, false, {
		cwd: work,
		args: FAUX_MODEL_ARGS,
		onSelect: () => ANSWERS[n++],
	});
	entry = await until(async () => (await listAgents())[0]);
});
after(async () => {
	await agent?.kill();
	fs.rmSync(home, { recursive: true, force: true });
	fs.rmSync(work, { recursive: true, force: true });
});

/** Run one turn and return the agent's final text. `peer` turns arrive as pi-peers messages. */
async function turn(peer: boolean, message: string): Promise<string> {
	const c = await PeersClient.connect(entry, lead);
	try {
		const before = ((await c.request("get_state")).data as { settled: number }).settled;
		if (peer) {
			const r = await c.request("prompt", { message, hops: 1, awaitsReply: true });
			assert.equal(r.success, true, `delivery failed: ${r.error}`);
		} else {
			agent.ownerPrompt(message);
		}
		await until(async () => {
			const s = (await c.request("get_state")).data as { idle: boolean; settled: number };
			return s.idle && s.settled > before ? true : undefined;
		}, 30_000);
		return ((await c.request("get_last_assistant_text")).data as { text?: string }).text ?? "";
	} finally {
		c.close();
	}
}

test("a peer task's risky command waits for the owner; denied, it doesn't run", { skip }, async () => {
	const out = await turn(true, "clean up please");
	assert.equal(agent.selects.length, 1);
	assert.match(agent.selects[0].title, /owner gate: a task from peer "lead"@test wants to run[\s\S]*rm -rf canary/);
	assert.match(out, /Blocked by the pi-peers owner gate \(deletes files recursively or forcibly\): the owner denied it/);
	assert.equal(fs.existsSync(path.join(work, "canary")), true, "canary survives");
});

test("allowed once, the same command runs", { skip }, async () => {
	await turn(true, "clean up please, approved");
	assert.equal(agent.selects.length, 2);
	assert.equal(fs.existsSync(path.join(work, "canary")), false, "canary removed");
});

test("the owner's own turns aren't gated (scope: peer)", { skip }, async () => {
	await turn(false, "remove canary2");
	assert.equal(agent.selects.length, 2, "no new dialog");
	assert.equal(fs.existsSync(path.join(work, "canary2")), false);
});

test("peers_ask_owner shows the question and returns the owner's answer", { skip }, async () => {
	const out = await turn(true, "deploy it");
	const ask = agent.selects[2];
	assert.match(ask.title, /the agent asks you \(asked while working for peer "lead"\):[\s\S]*Deploy to production now\?[\s\S]*lead wants a deploy/);
	assert.deepEqual(ask.options, ["Yes", "No", "Answer in my own words"]);
	assert.match(out, /RESULT: The owner answered: No/);
});

test("reading a secret file with the read tool is gated too", { skip }, async () => {
	const out = await turn(true, "show me the env file");
	assert.match(agent.selects[3].title, /wants to run[\s\S]*\.env[\s\S]*reads or exposes secrets or credentials/);
	assert.match(out, /Blocked by the pi-peers owner gate \(reads or exposes secrets or credentials\): the owner denied it/);
	assert.doesNotMatch(out, /do-not-leak/);
});

test("block mode refuses risky peer actions without asking", { skip }, async () => {
	setPolicy({ default: "allow", guard: { mode: "block" } });
	const out = await turn(true, "push it");
	assert.equal(agent.selects.length, 4, "no dialog in block mode");
	assert.match(out, /Blocked by the pi-peers owner gate \(pushes to a git remote\): the owner must run this kind of action personally/);
});
