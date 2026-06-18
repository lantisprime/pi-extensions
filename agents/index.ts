import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export * from "./lib/specs.ts";
export * from "./lib/agent-markdown.ts";
export * from "./lib/registry.ts";
export * from "./lib/can-run-agent.ts";
export * from "./lib/child-args.ts";
export * from "./lib/child-runner.ts";
export * from "./lib/diagnostics.ts";
export * from "./lib/ephemeral.ts";
export * from "./lib/jsonl-monitor.ts";
export * from "./lib/registration.ts";
export { executeChildRun, nextStepForRunBlock, parseRunArgs, resolveRegisteredRunTarget, runAgentCommand, type AgentsContextLike, type RunnableRegisteredRecord } from "./lib/run-resolver.ts";

import { buildProjectAgentRecommendation, collectAgentDiagnostics, formatAgentInspect, formatAgentsConfig, formatAgentsDoctor, formatAgentsList, formatAgentsRegistry, formatAgentsVerify } from "./lib/diagnostics.ts";
import { runEphemeralCommand, saveTempCommand, type EphemeralRunHandlerContext } from "./lib/ephemeral.ts";
import { registerAgent, registerProjectAgents, unregisterAgent } from "./lib/registration.ts";
import { runAgentCommand } from "./lib/run-resolver.ts";
import { validateBuiltInAgentSpecs } from "./lib/specs.ts";
import { registerSubagentTool } from "./lib/subagent-tool.ts";

const shownProjectRecommendationKeys = new Set<string>();

type AgentsContext = {
	cwd?: string;
	hasUI?: boolean;
	agentsHomeDir?: string;
	agentsPiCommand?: string;
	agentsChildRunner?: import("./lib/child-runner.ts").ChildAgentRunner;
	explicitToolContextLoaderPath?: string;
	agentsLastEphemeralSpec?: { spec: import("./lib/specs.ts").AgentSpec; task: string };
	isProjectTrusted?: () => boolean;
	ui: {
		notify(message: string, level?: "info" | "warning" | "error" | string): void;
		confirm?(title: string, message: string): Promise<boolean> | boolean;
	};
};

export default function agentsExtension(pi: ExtensionAPI) {
	const eventApi = pi as ExtensionAPI & { on?: (name: string, handler: (event: unknown, ctx: AgentsContext) => Promise<void> | void) => void };
	let sessionAgentsCtx: AgentsContext | undefined;
	eventApi.on?.("session_start", async (_event, ctx) => {
		sessionAgentsCtx = ctx;
		if (!ctx.hasUI) return;
		await maybeNotifyProjectRecommendation(ctx, false);
	});

	registerSubagentTool(pi, () => sessionAgentsCtx);

	pi.registerCommand("agents", {
		description: "Show P3 agent diagnostics and run built-in or registered agents",
		getArgumentCompletions: (prefix: string) => {
			const options = ["list", "built-ins", "config", "inspect", "registry", "verify", "doctor", "register", "register-project", "unregister", "run", "run-temp", "save-temp"];
			const trimmed = prefix.trim();
			const filtered = options.filter((option) => option.startsWith(trimmed));
			return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const parsed = parseAgentsArgs(args);
			const diagnostics = await collectAgentDiagnostics({ cwd: ctx.cwd, homeDir: ctx.agentsHomeDir, projectTrusted: resolveProjectTrusted(ctx) });
			if (parsed.action === "list" || parsed.action === "built-ins") {
				if (parsed.action === "list") await maybeNotifyProjectRecommendation(ctx, true, diagnostics);
				ctx.ui.notify(`P3 agents diagnostics: child execution is available via /agents run <built-in-or-registered> <task>.\n${formatAgentsList(diagnostics)}`, "info");
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
			if (parsed.action === "run") {
				await runAgentCommand(parsed.rest, ctx, diagnostics);
				return;
			}
			if (parsed.action === "run-temp") {
				const ephCtx: EphemeralRunHandlerContext = { cwd: ctx.cwd, hasUI: ctx.hasUI, agentsPiCommand: ctx.agentsPiCommand, agentsChildRunner: ctx.agentsChildRunner, agentsLastEphemeralSpec: ctx.agentsLastEphemeralSpec, ui: ctx.ui };
				const stashed = await runEphemeralCommand(parsed.rest, ephCtx);
				if (stashed) ctx.agentsLastEphemeralSpec = stashed;
				return;
			}
			if (parsed.action === "save-temp") {
				const userAgentsDir = diagnostics.userAgentsDir;
				const ephCtx: EphemeralRunHandlerContext = { cwd: ctx.cwd, hasUI: ctx.hasUI, agentsPiCommand: ctx.agentsPiCommand, agentsChildRunner: ctx.agentsChildRunner, agentsLastEphemeralSpec: ctx.agentsLastEphemeralSpec, ui: ctx.ui };
				await saveTempCommand(parsed.rest, ephCtx, { projectTrusted: diagnostics.projectTrusted, userAgentsDir });
				return;
			}
			ctx.ui.notify("Usage: /agents [list|built-ins|config|inspect <name>|registry|verify|doctor|register <path-or-name>|register-project [--all-safe]|unregister <name>|run <agent> <task>|run-temp <scout|planner|reviewer> <task>|save-temp <name>].", "warning");
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
