import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export * from "./lib/specs.ts";
export * from "./lib/agent-markdown.ts";
export * from "./lib/registry.ts";
export * from "./lib/can-run-agent.ts";
export * from "./lib/child-args.ts";
export * from "./lib/child-runner.ts";
export * from "./lib/diagnostics.ts";
export * from "./lib/jsonl-monitor.ts";
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
import { formatChildAgentRunResult, runBuiltInChildAgent, type ChildAgentRunner } from "./lib/child-runner.ts";
import { registerAgent, registerProjectAgents, unregisterAgent } from "./lib/registration.ts";
import { isReservedBuiltInAgentName, validateBuiltInAgentSpecs } from "./lib/specs.ts";

const shownProjectRecommendationKeys = new Set<string>();

type AgentsContext = {
	cwd?: string;
	hasUI?: boolean;
	agentsHomeDir?: string;
	agentsPiCommand?: string;
	agentsChildRunner?: ChildAgentRunner;
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
		description: "Show P3 agent diagnostics and run built-in agents",
		getArgumentCompletions: (prefix: string) => {
			const options = ["list", "built-ins", "config", "inspect", "registry", "verify", "doctor", "register", "register-project", "unregister", "run"];
			const trimmed = prefix.trim();
			const filtered = options.filter((option) => option.startsWith(trimmed));
			return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const parsed = parseAgentsArgs(args);
			const diagnostics = await collectAgentDiagnostics({ cwd: ctx.cwd, homeDir: ctx.agentsHomeDir, projectTrusted: resolveProjectTrusted(ctx) });
			if (parsed.action === "list" || parsed.action === "built-ins") {
				if (parsed.action === "list") await maybeNotifyProjectRecommendation(ctx, true, diagnostics);
				ctx.ui.notify(`P3 agents diagnostics: built-in child execution is available via /agents run <built-in> <task>.\n${formatAgentsList(diagnostics)}`, "info");
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
				await runAgentCommand(parsed.rest, ctx);
				return;
			}
			ctx.ui.notify("Usage: /agents [list|built-ins|config|inspect <name>|registry|verify|doctor|register <path-or-name>|register-project [--all-safe]|unregister <name>|run <scout|planner|reviewer> <task>].", "warning");
		},
	});
}

async function runAgentCommand(input: string, ctx: AgentsContext): Promise<void> {
	const parsed = parseRunArgs(input);
	if (!parsed.ok) {
		ctx.ui.notify(parsed.message, "warning");
		return;
	}
	if (!isReservedBuiltInAgentName(parsed.name)) {
		ctx.ui.notify("P3c-2 only supports built-in agents: scout, planner, reviewer. Registered user/project agents wait for P3c-3.", "warning");
		return;
	}
	ctx.ui.notify(`Running built-in agent '${parsed.name}' with read-only tools.`, "info");
	try {
		const runner = ctx.agentsChildRunner ?? runBuiltInChildAgent;
		const result = await runner(parsed.name, parsed.task, { cwd: ctx.cwd, piCommand: ctx.agentsPiCommand });
		ctx.ui.notify(formatChildAgentRunResult(result), result.status === "completed" ? "info" : "warning");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Agent run failed before child execution completed: ${message}`, "error");
	}
}

function parseRunArgs(input: string): { ok: true; name: string; task: string } | { ok: false; message: string } {
	const trimmed = input.trim();
	if (!trimmed) return { ok: false, message: "Usage: /agents run <scout|planner|reviewer> <task>" };
	const match = trimmed.match(/^(\S+)\s+([\s\S]+)$/);
	if (!match) return { ok: false, message: "Usage: /agents run <scout|planner|reviewer> <task>" };
	const name = match[1];
	const task = match[2].trim();
	if (!task) return { ok: false, message: "Usage: /agents run <scout|planner|reviewer> <task>" };
	return { ok: true, name, task };
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
