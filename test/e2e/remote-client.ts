// Run on the SSH host by ssh.test.ts: reach an agent that a reverse link published there.
// Prints one JSON object with the results.
//   node remote-client.ts <name>
import { PeersClient } from "../../src/client.ts";
import { listAgents, resolveAgent } from "../../src/discovery.ts";
import { PeersError } from "../../src/protocol.ts";

const name = process.argv[2];
const me = { id: "remote-client", label: "remote-client", host: "remote" };
const agents = await listAgents();
const target = resolveAgent(agents, name);
const c = await PeersClient.connect(target, me);
const state = await c.request("get_state", {}, 15_000);
const prompt = await c.request("prompt", { message: "hello over the reverse link", hops: 1, awaitsReply: true }, 30_000);
c.close();
let badToken: string | undefined;
try {
	await PeersClient.connect({ ...target, token: "wrong" }, me);
} catch (e) {
	badToken = e instanceof PeersError ? e.code : String(e);
}
console.log(
	JSON.stringify({
		via: target.via,
		remoteRuntime: target.remoteRuntime,
		stateOk: state.success,
		label: (state.data as { label?: string } | undefined)?.label,
		promptError: prompt.errorCode,
		badToken,
	}),
);
process.exit(0);
