// Started on the SSH host by ssh.test.ts: one headless agent; prints READY once registered,
// answers approval dialogs with NO, exits on "stop" on stdin.
//   node remote-agent.ts <name> <pi cli.js>
import * as fs from "node:fs";
import * as path from "node:path";
import { EXTENSION, startAgent } from "./helpers.ts";

const [name, cli] = process.argv.slice(2);
const home = process.env.PI_PEERS_HOME!;
const agent = startAgent(cli, name, {}, false);
const ready = setInterval(() => {
	try {
		if (fs.readdirSync(path.join(home, "agents")).some((f) => f.endsWith(".json"))) {
			console.log(`READY ${EXTENSION}`);
			clearInterval(ready);
		}
	} catch {}
}, 300);
const quit = async () => {
	await agent.kill();
	process.exit(0);
};
process.stdin.on("data", (d) => String(d).includes("stop") && quit());
setTimeout(quit, 120_000).unref();
