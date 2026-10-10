// Cross-host over SSH, both directions. Skipped unless these are set:
//   PI_PEERS_E2E_SSH_HOST       ssh alias of the remote host (BatchMode login must work)
//   PI_PEERS_E2E_REMOTE_REPO    path of this repo on the remote host
//   PI_PEERS_E2E_REMOTE_PI_CLI  pi's cli.js on the remote host
//   PI_PEERS_E2E_REMOTE_NODE    node >= 22.18 on the remote host (default "node")
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, test } from "node:test";
import { connectRemote, listRemote, readHosts } from "../../src/hosts.ts";
import { PeersError } from "../../src/protocol.ts";
import { findPiCli, ssh, sshConfig, sshSpawn, startAgent, tempHome, until } from "./helpers.ts";

const cfg = sshConfig();
const cli = findPiCli();
const skip = !cfg ? "set PI_PEERS_E2E_SSH_HOST, PI_PEERS_E2E_REMOTE_REPO and PI_PEERS_E2E_REMOTE_PI_CLI" : !cli ? "pi not found locally: set PI_CLI" : false;

const home = tempHome();
process.env.PI_PEERS_HOME = home;
const remoteHome = `/tmp/pi-peers-e2e-${process.pid}-${Date.now()}`;
const me = { id: "e2e", label: "e2e", host: "test" };
after(async () => {
	fs.rmSync(home, { recursive: true, force: true });
	// remoteHome is built above from a fixed prefix, never from input.
	if (cfg) await ssh(cfg.host, `rm -rf '${remoteHome}'`).catch(() => {});
});

function writeHosts(reverse: boolean): void {
	fs.writeFileSync(
		path.join(home, "hosts"),
		`${cfg!.host} ${reverse ? "--reverse " : ""}PI_PEERS_HOME=${remoteHome} ${cfg!.cliCommand}\nnohost-pi-peers-e2e\n`,
	);
}

test("forward: list, bridge, remote approval, errors", { skip }, async () => {
	writeHosts(false);
	const [host, unreachable] = readHosts();
	const remote = sshSpawn(cfg!.host, `PI_PEERS_HOME=${remoteHome} ${cfg!.node} ${cfg!.repo}/test/e2e/remote-agent.ts w1 ${cfg!.piCli}`);
	try {
		await until(() => (remote.output().includes("READY") ? true : undefined), 40_000);
		const listed = await listRemote(host);
		assert.deepEqual(listed.map((a) => [a.label, "token" in a]), [["w1", false]]);

		const c = await connectRemote(host, "w1", me);
		try {
			const state = await c.request("get_state", {}, 15_000);
			assert.equal((state.data as { label: string }).label, "w1");
			assert.equal((await c.request("prompt", { message: "hi", hops: 1 }, 30_000)).errorCode, "denied");
		} finally {
			c.close();
		}
		await assert.rejects(connectRemote(host, "nobody", me), (e: unknown) => e instanceof PeersError && e.code === "agent_not_found");
		await assert.rejects(listRemote(unreachable), (e: unknown) => e instanceof PeersError && e.code === "ssh_failed");
		await assert.rejects(connectRemote(unreachable, "w1", me), (e: unknown) => e instanceof PeersError && e.code === "ssh_failed");
	} finally {
		await remote.stop();
	}
});

test("reverse: a remote client reaches a local agent through its reverse link", { skip }, async () => {
	writeHosts(true);
	const wa = startAgent(cli!, "wA", { PI_PEERS_HOME: home });
	try {
		await until(() => (wa.statuses.get("pi-peers-links")?.includes("linked") ? true : undefined), 30_000);
		const listed = await until(async () => {
			const rows = JSON.parse(await ssh(cfg!.host, `PI_PEERS_HOME=${remoteHome} ${cfg!.cliCommand} list --json`));
			return rows.length ? rows : undefined;
		});
		assert.equal(listed[0].label, "wA");
		assert.equal(listed[0].via, (await import("node:os")).hostname());

		const out = JSON.parse(await ssh(cfg!.host, `cd ${cfg!.repo} && PI_PEERS_HOME=${remoteHome} ${cfg!.node} test/e2e/remote-client.ts wA`));
		assert.equal(out.stateOk, true);
		assert.equal(out.label, "wA");
		assert.equal(out.remoteRuntime, process.platform);
		assert.equal(out.promptError, "denied");
		assert.equal(out.badToken, "auth_failed");
		assert.equal(wa.dialogs.length, 1, "the approval dialog appeared on the local agent");
	} finally {
		await wa.kill();
	}
	const gone = await until(async () => {
		const rows = JSON.parse(await ssh(cfg!.host, `PI_PEERS_HOME=${remoteHome} ${cfg!.cliCommand} list --json`));
		return rows.length === 0 ? true : undefined;
	}, 15_000);
	assert.equal(gone, true, "the remote entry disappears when the local agent exits");
});
