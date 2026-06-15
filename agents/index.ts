import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export * from "./lib/specs.ts";

import { formatBuiltInAgentList, validateBuiltInAgentSpecs } from "./lib/specs.ts";

export default function agentsExtension(pi: ExtensionAPI) {
	pi.registerCommand("agents", {
		description: "List P3 built-in agent specs (scaffold only; no child execution yet)",
		handler: async (args, ctx) => {
			const action = args.trim() || "list";
			if (action === "list" || action === "built-ins" || action === "") {
				ctx.ui.notify(`P3 agents scaffold: built-ins only; child execution is not implemented yet.\n${formatBuiltInAgentList()}`, "info");
				return;
			}
			if (action === "verify") {
				const validation = validateBuiltInAgentSpecs();
				ctx.ui.notify(validation.ok ? "P3 built-in agent specs are valid." : validation.issues.map((issue) => `${issue.field}: ${issue.message}`).join("\n"), validation.ok ? "info" : "warning");
				return;
			}
			ctx.ui.notify("Usage: /agents [list|built-ins|verify]. P3b-1 scaffold does not run agents yet.", "warning");
		},
	});
}
