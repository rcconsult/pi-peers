// Test-only pi extension: registers a scripted model "faux/faux-1", so end-to-end tests can make
// an agent call tools without a real model. PI_PEERS_FAUX_SCRIPT is a JSON array; for each turn the
// model takes the next entry:
//   {"tool": "bash", "args": {"command": "..."}}  -> calls that tool, then (next response) replies
//                                                     "RESULT: <text of the tool result>"
//   {"say": "text"}                                -> replies with the text
//   {"sections": true}                             -> replies "SECTIONS: <JSON>", the system prompt
//                                                     sections the model currently has
import { type AssistantMessage, fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Step = { tool: string; args: Record<string, unknown> } | { say: string } | { sections: true };

/** System prompt sections as the model sees them: later system messages replace or remove (null) earlier ones. */
function currentSections(context: TranscriptContext): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of context.messages as Array<{ role?: string; sections?: Record<string, string | null> }>) {
		if (m.role !== "system" || !m.sections) continue;
		for (const [k, v] of Object.entries(m.sections)) {
			if (v === null) delete out[k];
			else out[k] = v;
		}
	}
	return out;
}

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
		} else if ("sections" in step) {
			responses.push((context) => fauxAssistantMessage(`SECTIONS: ${JSON.stringify(currentSections(context))}`));
		} else {
			const args = step.args as Parameters<typeof fauxToolCall>[1];
			responses.push(fauxAssistantMessage(fauxToolCall(step.tool, args), { stopReason: "toolUse" }));
			responses.push((context) => fauxAssistantMessage(`RESULT: ${lastToolResultText(context)}`));
		}
	}
	faux.setResponses(responses);
	pi.registerProvider(faux.provider);
}
