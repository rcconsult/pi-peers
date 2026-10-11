// Test-only pi extension: registers a scripted model "faux/faux-1", so end-to-end tests can make
// an agent call tools without a real model. PI_PEERS_FAUX_SCRIPT is a JSON array; for each turn the
// model takes the next entry:
//   {"tool": "bash", "args": {"command": "..."}}  -> calls that tool, then (next response) replies
//                                                     "RESULT: <text of the tool result>"
//   {"say": "text"}                                -> replies with the text
import { type AssistantMessage, fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Step = { tool: string; args: Record<string, unknown> } | { say: string };

function lastToolResultText(context: TranscriptContext): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const m = context.messages[i] as { role?: string; content?: Array<{ type: string; text?: string }> };
		if (m.role === "toolResult") return (m.content ?? []).map((c) => c.text ?? "").join("");
	}
	return "(no tool result)";
}

export default function (pi: ExtensionAPI) {
	const script = JSON.parse(process.env.PI_PEERS_FAUX_SCRIPT ?? "[]") as Step[];
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const responses: Array<AssistantMessage | ((context: TranscriptContext) => AssistantMessage)> = [];
	for (const step of script) {
		if ("say" in step) {
			responses.push(fauxAssistantMessage(step.say));
		} else {
			const args = step.args as Parameters<typeof fauxToolCall>[1];
			responses.push(fauxAssistantMessage(fauxToolCall(step.tool, args), { stopReason: "toolUse" }));
			responses.push((context) => fauxAssistantMessage(`RESULT: ${lastToolResultText(context)}`));
		}
	}
	faux.setResponses(responses);
	pi.registerProvider(faux.provider);
}
