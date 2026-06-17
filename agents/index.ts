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

import { parseAgentMarkdownFile } from "./lib/agent-markdown.ts";
import { canRunAgent } from "./lib/can-run-agent.ts";
import {
	buildProjectAgentRecommendation,
	collectAgentDiagnostics,
	formatAgentInspect,
	formatAgentsConfig,
	formatAgentsDoctor,
	formatAgentsList,
	formatAgentsRegistry,
	formatAgentsVerify,
	type AgentDiagnosticRecord,
	type AgentDiagnostics,
} from "./lib/diagnostics.ts";
import { formatChildAgentRunResult, runBuiltInChildAgent, runChildAgent, type ChildAgentRunner } from "./lib/child-runner.ts";
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
		description: "Show P3 agent diagnostics and run built-in or registered agents",
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
			ctx.ui.notify("Usage: /agents [list|built-ins|config|inspect <name>|registry|verify|doctor|register <path-or-name>|register-project [--all-safe]|unregister <name>|run <agent> <task>].", "warning");
		},
	});
}

async function runAgentCommand(input: string, ctx: AgentsContext, diagnostics: AgentDiagnostics): Promise<void> {
	const parsed = parseRunArgs(input);
	if (!parsed.ok) {
		ctx.ui.notify(parsed.message, "warning");
		return;
	}
	if (isReservedBuiltInAgentName(parsed.name)) {
		ctx.ui.notify(`Running built-in agent '${parsed.name}' with read-only tools.`, "info");
		await executeChildRun(parsed.name, parsed.task, ctx, "built-in");
		return;
	}

	const resolved = await resolveRegisteredRunTarget(parsed.name, diagnostics);
	if (!resolved.ok) {
		ctx.ui.notify(resolved.message, "warning");
		return;
	}
	const record = resolved.record;
	let currentParsed: Awaited<ReturnType<typeof parseAgentMarkdownFile>>;
	try {
		currentParsed = await parseAgentMarkdownFile(record.filePath, { source: record.source });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Agent '${parsed.name}' is not runnable: failed to re-read current spec bytes: ${message}. Next: /agents inspect ${parsed.name}`, "warning");
		return;
	}
	if (!currentParsed.spec || currentParsed.status === "invalid" || currentParsed.status === "dangerous" || currentParsed.status === "shadowed") {
		ctx.ui.notify(`Agent '${parsed.name}' is not runnable: current spec status=${currentParsed.status}. Next: /agents inspect ${parsed.name}`, "warning");
		return;
	}
	const gate = await canRunAgent(
		{ parsed: currentParsed, canonicalPath: record.canonicalPath },
		{ projectTrusted: diagnostics.projectTrusted, projectRoot: diagnostics.projectRoot, userRegistry: diagnostics.userRegistry, projectRegistry: diagnostics.projectRegistry, homeDir: ctx.agentsHomeDir },
	);
	if (!gate.ok) {
		ctx.ui.notify(`Agent '${parsed.name}' is not runnable: ${gate.reason}. Next: ${nextStepForRunBlock(record, gate.code)}`, "warning");
		return;
	}
	ctx.ui.notify(`Running registered ${record.source} agent '${currentParsed.spec.name}' with read-only tools.`, "info");
	await executeChildRun(currentParsed.spec, parsed.task, ctx, record.source);
}

async function executeChildRun(agent: Parameters<ChildAgentRunner>[0], task: string, ctx: AgentsContext, source: string): Promise<void> {
	try {
		const result = ctx.agentsChildRunner
			? await ctx.agentsChildRunner(agent, task, { cwd: ctx.cwd, piCommand: ctx.agentsPiCommand })
			: typeof agent === "string"
				? await runBuiltInChildAgent(agent, task, { cwd: ctx.cwd, piCommand: ctx.agentsPiCommand })
				: await runChildAgent(agent, task, { cwd: ctx.cwd, piCommand: ctx.agentsPiCommand });
		ctx.ui.notify(formatChildAgentRunResult(result), result.status === "completed" ? "info" : "warning");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Agent run failed before ${source} child execution completed: ${message}`, "error");
	}
}

type RunnableRegisteredRecord = AgentDiagnosticRecord & { source: "user" | "project"; spec: NonNullable<AgentDiagnosticRecord["spec"]>; canonicalPath: string; rawBytesSha256: string; filePath: string };

async function resolveRegisteredRunTarget(name: string, diagnostics: AgentDiagnostics): Promise<{ ok: true; record: RunnableRegisteredRecord } | { ok: false; message: string }> {
	const matches = diagnostics.records.filter((record) => record.source !== "built-in" && record.name === name);
	if (matches.length === 0) {
		const trustHint = diagnostics.projectTrusted ? "" : " If this is a project agent, activate project trust first.";
		return { ok: false, message: `No discovered registered user/project agent named '${name}'. Next: /agents list or /agents register <name>.${trustHint}` };
	}
	if (matches.length > 1) {
		return { ok: false, message: `Agent name '${name}' is ambiguous across discovered user/project specs. Rename one spec before running.` };
	}
	const record = matches[0];
	if (!record.spec || !record.canonicalPath || !record.rawBytesSha256 || !record.filePath || (record.source !== "user" && record.source !== "project")) {
		return { ok: false, message: `Agent '${name}' cannot run because its spec or trust material is missing. Next: /agents inspect ${name}` };
	}
	if (!record.runnable) {
		return { ok: false, message: `Agent '${name}' is not runnable: ${record.reason}. Next: ${record.nextStep || `/agents inspect ${name}`}` };
	}
	return { ok: true, record: record as RunnableRegisteredRecord };
}

function nextStepForRunBlock(record: AgentDiagnosticRecord, code: string): string {
	if (record.nextStep) return record.nextStep;
	if (code === "project-untrusted") return "Activate project trust, then run /agents register-project";
	if (code === "project-registry-root-mismatch") return "Run /agents doctor";
	return `/agents inspect ${record.name}`;
}

function parseRunArgs(input: string): { ok: true; name: string; task: string } | { ok: false; message: string } {
	const trimmed = input.trim();
	if (!trimmed) return { ok: false, message: "Usage: /agents run <agent> <task>" };
	const match = trimmed.match(/^(\S+)\s+([\s\S]+)$/);
	if (!match) return { ok: false, message: "Usage: /agents run <agent> <task>" };
	const name = match[1];
	const task = match[2].trim();
	if (!task) return { ok: false, message: "Usage: /agents run <agent> <task>" };
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
