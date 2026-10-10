import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { type AgentEntry, endpointFor, listAgents, readEntry, resolveAgent, writeEntry } from "../../src/discovery.ts";
import { PeersError } from "../../src/protocol.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-peers-test-"));
process.env.PI_PEERS_HOME = home;

function entry(over: Partial<AgentEntry>): AgentEntry {
	const id = over.id ?? "a1";
	return {
		schemaVersion: "1.0",
		protocol: { version: "1.0", minVersion: "1.0" },
		id,
		label: id,
		host: "h",
		runtime: process.platform,
		pid: process.pid,
		cwd: "/w",
		endpoint: endpointFor(id),
		token: "t",
		startedAt: new Date().toISOString(),
		...over,
	};
}

const servers: net.Server[] = [];
before(async () => {
	fs.mkdirSync(path.join(home, "run"), { recursive: true });
	// A live agent: our own pid and a listening endpoint.
	const live = entry({ id: "live", sessionName: "Alpha" });
	await new Promise<void>((r) => servers.push(net.createServer().listen(live.endpoint, r)));
	writeEntry(live);
	// Dead: a pid that can't exist.
	writeEntry(entry({ id: "dead", pid: 2 ** 22 + 7 }));
	// Another runtime sharing the directory: must be skipped, not pruned.
	writeEntry(entry({ id: "foreign", runtime: process.platform === "win32" ? "linux" : "win32", pid: 2 ** 22 + 9 }));
});
after(() => {
	for (const s of servers) s.close();
	fs.rmSync(home, { recursive: true, force: true });
});

test("listAgents keeps live agents, prunes dead ones, skips other runtimes", async () => {
	const agents = await listAgents();
	assert.deepEqual(
		agents.map((a) => a.id),
		["live"],
	);
	assert.equal(readEntry("dead"), undefined, "dead entry is pruned");
	assert.ok(readEntry("foreign"), "foreign-runtime entry is left alone");
});

test("resolveAgent: id, then session name, then label; exact before case-insensitive", () => {
	const agents = [entry({ id: "x1", sessionName: "Build", label: "Build" }), entry({ id: "x2", label: "docs" })];
	assert.equal(resolveAgent(agents, "x2").id, "x2");
	assert.equal(resolveAgent(agents, "Build").id, "x1");
	assert.equal(resolveAgent(agents, "build").id, "x1");
	assert.equal(resolveAgent(agents, "DOCS").id, "x2");
});

test("resolveAgent rejects ambiguous and unknown addresses", () => {
	const agents = [entry({ id: "y1", sessionName: "same" }), entry({ id: "y2", sessionName: "same" })];
	assert.throws(
		() => resolveAgent(agents, "same"),
		(e: unknown) => e instanceof PeersError && e.code === "ambiguous_target" && Array.isArray(e.data) && e.data.length === 2,
	);
	assert.throws(() => resolveAgent(agents, "nobody"), (e: unknown) => e instanceof PeersError && e.code === "agent_not_found");
});
