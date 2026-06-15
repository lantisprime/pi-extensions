import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export * from "./lib/specs.ts";
export * from "./lib/agent-markdown.ts";
export * from "./lib/registry.ts";
export * from "./lib/can-run-agent.ts";
export * from "./lib/diagnostics.ts";
export * from "./lib/registration.ts";

import {
	buildProjectAgentRecommendation,
	collectAgentDiagnostics,
	formatAgentInspect,
	formatAgentsConfig,
	formatAgentsDoctor,
	formatAgentsList,
	formatAgentsRegistry,
	formatAgentsVerify,
} from "./lib/diagnostics.ts";
import { registerAgent, registerProjectAgents, unregisterAgent } from "./lib/registration.ts";
import { validateBuiltInAgentSpecs } from "./lib/specs.ts";

const shownProjectRecommendationKeys = new Set<string>();

type AgentsContext = {
	cwd?: string;
	hasUI?: boolean;
	agentsHomeDir?: string;
	isProjectTrusted?: () => boolean;
	ui: {
		notify(message: string, level?: "info" | "warning" | "error" | string): void;
		confirm?(title: string, message: string): Promise<boolean> | boolean;
	};
};

export default function agentsExtension(pi: ExtensionAPI) {
	const eventApi = pi as ExtensionAPI & { on?: (name: string, handler: (event: unknown, ctx: AgentsContext) => Promise<void> | void) => void };
	eventApi.on?.("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		await maybeNotifyProjectRecommendation(ctx, false);
	});

	pi.registerCommand("agents", {
		description: "Show P3 agent diagnostics (no child execution yet)",
		getArgumentCompletions: (prefix: string) => {
			const options = ["list", "built-ins", "config", "inspect", "registry", "verify", "doctor", "register", "register-project", "unregister"];
			const trimmed = prefix.trim();
			const filtered = options.filter((option) => option.startsWith(trimmed));
			return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const parsed = parseAgentsArgs(args);
			const diagnostics = await collectAgentDiagnostics({ cwd: ctx.cwd, homeDir: ctx.agentsHomeDir, projectTrusted: resolveProjectTrusted(ctx) });
			if (parsed.action === "list" || parsed.action === "built-ins") {
				if (parsed.action === "list") await maybeNotifyProjectRecommendation(ctx, true, diagnostics);
				ctx.ui.notify(`P3 agents diagnostics: child execution is not implemented yet.\n${formatAgentsList(diagnostics)}`, "info");
				return;
			}
			if (parsed.action === "config") {
				ctx.ui.notify(formatAgentsConfig(diagnostics), "info");
				return;
			}
			if (parsed.action === "registry") {
				ctx.ui.notify(formatAgentsRegistry(diagnostics), "info");
				return;
			}
			if (parsed.action === "verify") {
				const validation = validateBuiltInAgentSpecs();
				const builtInMessage = validation.ok ? "Built-in specs: valid" : `Built-in specs: invalid\n${validation.issues.map((issue) => `${issue.field}: ${issue.message}`).join("\n")}`;
				ctx.ui.notify(`${builtInMessage}\n${formatAgentsVerify(diagnostics)}`, validation.ok && diagnostics.summary.blocked === 0 ? "info" : "warning");
				return;
			}
			if (parsed.action === "doctor") {
				ctx.ui.notify(formatAgentsDoctor(diagnostics), diagnostics.summary.blocked === 0 && diagnostics.projectRegistryRootOk ? "info" : "warning");
				return;
			}
			if (parsed.action === "inspect") {
				if (!parsed.rest) {
					ctx.ui.notify("Usage: /agents inspect <name>", "warning");
					return;
				}
				ctx.ui.notify(formatAgentInspect(diagnostics, parsed.rest), "info");
				return;
			}
			if (parsed.action === "register") {
				const result = await registerAgent(parsed.rest, registrationOptions(ctx, diagnostics));
				ctx.ui.notify(result.message, result.status === "registered" ? "info" : "warning");
				return;
			}
			if (parsed.action === "register-project") {
				const result = await registerProjectAgents({ ...registrationOptions(ctx, diagnostics), allSafe: parseFlags(parsed.rest).has("--all-safe") });
				ctx.ui.notify(result.message, result.status === "registered" ? "info" : "warning");
				return;
			}
			if (parsed.action === "unregister") {
				const result = await unregisterAgent(parsed.rest, registrationOptions(ctx, diagnostics));
				ctx.ui.notify(result.message, result.status === "unregistered" ? "info" : "warning");
				return;
			}
			ctx.ui.notify("Usage: /agents [list|built-ins|config|inspect <name>|registry|verify|doctor|register <path-or-name>|register-project [--all-safe]|unregister <name>]. Agents do not run until later P3 slices.", "warning");
		},
	});
}

function parseAgentsArgs(args: string): { action: string; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { action: "list", rest: "" };
	const [action, ...rest] = trimmed.split(/\s+/);
	return { action, rest: rest.join(" ").trim() };
}

function resolveProjectTrusted(ctx: AgentsContext): boolean {
	try {
		return Boolean(ctx.isProjectTrusted?.());
	} catch {
		return false;
	}
}

function registrationOptions(ctx: AgentsContext, diagnostics: Awaited<ReturnType<typeof collectAgentDiagnostics>>) {
	return {
		cwd: ctx.cwd,
		homeDir: ctx.agentsHomeDir,
		projectTrusted: diagnostics.projectTrusted,
		hasUI: Boolean(ctx.hasUI),
		ui: ctx.ui,
		diagnostics,
	};
}

function parseFlags(input: string): Set<string> {
	return new Set(input.split(/\s+/).filter((part) => part.startsWith("--")));
}

async function maybeNotifyProjectRecommendation(ctx: AgentsContext, force: boolean, diagnostics = undefined as Awaited<ReturnType<typeof collectAgentDiagnostics>> | undefined): Promise<void> {
	const current = diagnostics ?? await collectAgentDiagnostics({ cwd: ctx.cwd, homeDir: ctx.agentsHomeDir, projectTrusted: resolveProjectTrusted(ctx) });
	const recommendation = buildProjectAgentRecommendation(current);
	if (!recommendation) return;
	if (!force && shownProjectRecommendationKeys.has(recommendation.key)) return;
	shownProjectRecommendationKeys.add(recommendation.key);
	ctx.ui.notify(recommendation.message, "info");
}
