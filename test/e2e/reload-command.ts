// Test-only pi extension: "/pp-test-reload" performs a real extension reload, as /reload does in the TUI.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("pp-test-reload", {
		description: "Reload extensions (test only)",
		handler: async (_args, ctx) => {
			await ctx.reload();
		},
	});
}
