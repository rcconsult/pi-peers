import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { readHosts, shq, splitAddress } from "../../src/hosts.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-peers-hosts-"));
process.env.PI_PEERS_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));

fs.writeFileSync(
	path.join(home, "hosts"),
	["# comment", "", "-oProxyCommand=evil", "plain", "wsl2  --reverse  /opt/node /repo/src/cli.ts   # trailing comment", "box /usr/bin/pi-peers"].join("\r\n"),
);

test("readHosts parses aliases, --reverse and remote commands", () => {
	assert.deepEqual(readHosts(), [
		{ alias: "plain", command: "pi-peers", reverse: false },
		{ alias: "wsl2", command: "/opt/node /repo/src/cli.ts", reverse: true },
		{ alias: "box", command: "/usr/bin/pi-peers", reverse: false },
	]);
});

test("splitAddress only treats configured aliases as hosts", () => {
	assert.equal(splitAddress("wsl2/pi3").host?.alias, "wsl2");
	assert.equal(splitAddress("wsl2/pi3").address, "pi3");
	assert.equal(splitAddress('box/"Refactor auth"').address, "Refactor auth");
	assert.deepEqual(splitAddress("other/name"), { address: "other/name" });
	assert.deepEqual(splitAddress("pi1"), { address: "pi1" });
});

test("aliases starting with - are ignored, so ssh can't read them as options", () => {
	assert.ok(readHosts().every((h) => !h.alias.startsWith("-")));
});

test("shq quotes addresses for the remote shell", async () => {
	const { execFileSync } = await import("node:child_process");
	const nasty = `pi3'; touch /tmp/pwned; echo '$(id) \`x\` "q"`;
	assert.equal(shq("a'b"), String.raw`'a'\''b'`);
	// Round-trip through a real POSIX shell where there is one.
	if (process.platform === "win32") return;
	assert.equal(execFileSync("sh", ["-c", `printf %s ${shq(nasty)}`], { encoding: "utf8" }), nasty);
});
