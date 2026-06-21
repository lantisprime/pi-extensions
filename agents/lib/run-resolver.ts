// Shared run-resolution helpers extracted from index.ts so /agents run and run_subagent
// share the same gated path. P3d-1 Step 1: pure move with zero logic changes.

import { parseAgentMarkdownFile } from "./agent-markdown.ts";
import { canRunAgent } from "./can-run-agent.ts";
import {
	buildIntentCandidates,
	type AgentDiagnosticRecord,
	type AgentDiagnostics,
} from "./diagnostics.ts";
import { collectChildProcess, formatChildAgentRunResult, runBuiltInChildAgent, runChildAgent, type ChildAgentRunner } from "./child-runner.ts";
import { getBuiltInAgentSpec, isReservedBuiltInAgentName } from "./specs.ts";
import type { ModelProfileLibrary } from "./profiles.ts";
import type { ProjectAgentRegistry } from "./registry.ts";
import { resolveRunIntent, profileEffect, INTENT_AUTORUN_CONFIDENCE, ROLE_DEFAULT_PROFILE, type IntentCandidate } from "./intent-router.ts";

export type AgentsContextLike = {
	cwd?: string;
	hasUI?: boolean;
	agentsHomeDir?: string;
	agentsPiCommand?: string;
	agentsChildRunner?: ChildAgentRunner;
	explicitToolContextLoaderPath?: string;
	profileLibrary?: ModelProfileLibrary;
	projectTrusted?: boolean;
	projectRegistry?: ProjectAgentRegistry;
	isProjectTrusted?: () => boolean;
	ui: {
		notify(message: string, level?: "info" | "warning" | "error" | string): void;
		confirm?(title: string, message: string): Promise<boolean> | boolean;
	};
};

export type RunnableRegisteredRecord = AgentDiagnosticRecord & {
	source: "user" | "project";
	spec: NonNullable<AgentDiagnosticRecord["spec"]>;
	canonicalPath: string;
	rawBytesSha256: string;
	filePath: string;
};

export const TOOL_CONTEXT_LOADER_PATH_ENV = "PI_AGENTS_TOOL_CONTEXT_LOADER_PATH";

export function resolveExplicitToolContextLoaderPath(ctx?: { explicitToolContextLoaderPath?: string }): string | undefined {
	return ctx?.explicitToolContextLoaderPath || process.env[TOOL_CONTEXT_LOADER_PATH_ENV];
}

export function buildChildRunOptions(ctx: { cwd?: string; agentsPiCommand?: string; explicitToolContextLoaderPath?: string }) {
	const explicitToolContextLoaderPath = resolveExplicitToolContextLoaderPath(ctx);
	return {
		cwd: ctx.cwd,
		piCommand: ctx.agentsPiCommand,
		...(explicitToolContextLoaderPath ? { explicitToolContextLoaderPath } : {}),
	};
}

export async function resolveRegisteredRunTarget(name: string, diagnostics: AgentDiagnostics): Promise<{ ok: true; record: RunnableRegisteredRecord } | { ok: false; message: string }> {
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

export function nextStepForRunBlock(record: AgentDiagnosticRecord, code: string): string {
	if (record.nextStep) return record.nextStep;
	if (code === "project-untrusted") return "Activate project trust, then run /agents register-project";
	if (code === "project-registry-root-mismatch") return "Run /agents doctor";
	return `/agents inspect ${record.name}`;
}

export async function executeChildRun(agent: Parameters<ChildAgentRunner>[0], task: string, ctx: AgentsContextLike, source: string, profileOverride?: string): Promise<void> {
	try {
		const childOptions = buildChildRunOptions(ctx);
		const profiles = ctx.profileLibrary;
		const runOptions = {
			...childOptions,
			projectTrusted: ctx.projectTrusted,
			projectRegistry: ctx.projectRegistry,
		};
		const result = ctx.agentsChildRunner
			? await ctx.agentsChildRunner(agent, task, profileOverride ? { ...childOptions, profileOverride } : childOptions)
			: typeof agent === "string"
				? await runBuiltInChildAgent(agent, task, runOptions, profiles, profileOverride)
				: await runChildAgent(agent, task, runOptions, profiles, profileOverride);
		ctx.ui.notify(formatChildAgentRunResult(result), result.status === "completed" ? "info" : "warning");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Agent run failed before ${source} child execution completed: ${message}`, "error");
	}
}

export async function runAgentCommand(input: string, ctx: AgentsContextLike, diagnostics: AgentDiagnostics): Promise<void> {
	const parsed = parseRunArgs(input);
	if (!parsed.ok) {
		ctx.ui.notify(parsed.message, "warning");
		return;
	}
	if (parsed.warning) ctx.ui.notify(parsed.warning, "warning");
	if (isReservedBuiltInAgentName(parsed.name)) {
		ctx.ui.notify(`Running built-in agent '${parsed.name}' with read-only tools.`, "info");
		await executeChildRun(parsed.name, parsed.task, ctx, "built-in", parsed.profileOverride);
		return;
	}

	const resolved = await resolveRegisteredRunTarget(parsed.name, diagnostics);
	if (!resolved.ok) {
		ctx.ui.notify(resolved.message, "warning");
		return;
	}
	await runResolvedTarget(resolved.record, parsed.task, ctx, diagnostics, parsed.profileOverride);
}

export function parseRunArgs(input: string): { ok: true; name: string; task: string; profileOverride?: string; warning?: string } | { ok: false; message: string } {
	const usage = "Usage: /agents run <agent> [--profile <name>] <task>";
	const trimmed = input.trim();
	if (!trimmed) return { ok: false, message: usage };

	// Extract optional --profile <name> that must come immediately after the agent name.
	// Forms: "<agent> --profile <name> <task>" or "<agent> <task>".
	// Mid-task --profile is part of the task, not an override.
	const tokens = trimmed.split(/\s+/);
	const name = tokens[0];
	if (!name) return { ok: false, message: usage };

	let profileOverride: string | undefined;
	let rest: string;
	if (tokens.length >= 2 && tokens[1] === "--profile") {
		// <agent> --profile ...
		if (tokens.length < 3) return { ok: false, message: usage }; // no value after --profile
		const profileValue = tokens[2];
		if (profileValue.startsWith("--")) return { ok: false, message: usage }; // option-looking value
		profileOverride = profileValue;
		rest = tokens.slice(3).join(" ");
	} else {
		rest = tokens.slice(1).join(" ");
	}
	const warning = (tokens[1] !== "--profile" && tokens.slice(1).some((t) => t === "--profile")) ? "--profile must come right after the agent name; treated as task text" : undefined;

	// Reject repeated --profile token (token-level, so task text containing "--profile"
	// as a substring like "--profiled" is NOT rejected)
	if (profileOverride && tokens.slice(3).some((t) => t === "--profile")) return { ok: false, message: usage };

	const task = rest.trim();
	if (!task) return { ok: false, message: usage };
	return { ok: true, name, task, profileOverride, warning };
}

/** P6-3a: extract the registered-run tail of runAgentCommand into a reusable function.
 *  Zero behavior change — same parse/re-read/gate/execute sequence.
 *  Called by runAgentCommand (existing) and runIntentCommand (P6-3b). */
export async function runResolvedTarget(record: RunnableRegisteredRecord, task: string, ctx: AgentsContextLike, diagnostics: AgentDiagnostics, profileOverride?: string): Promise<void> {
	let currentParsed: Awaited<ReturnType<typeof parseAgentMarkdownFile>>;
	try {
		currentParsed = await parseAgentMarkdownFile(record.filePath, { source: record.source });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Agent '${record.name}' is not runnable: failed to re-read current spec bytes: ${message}. Next: /agents inspect ${record.name}`, "warning");
		return;
	}
	if (!currentParsed.spec || currentParsed.status === "invalid" || currentParsed.status === "dangerous" || currentParsed.status === "shadowed") {
		ctx.ui.notify(`Agent '${record.name}' is not runnable: current spec status=${currentParsed.status}. Next: /agents inspect ${record.name}`, "warning");
		return;
	}
	const gate = await canRunAgent(
		{ parsed: currentParsed, canonicalPath: record.canonicalPath },
		{ projectTrusted: diagnostics.projectTrusted, projectRoot: diagnostics.projectRoot, userRegistry: diagnostics.userRegistry, projectRegistry: diagnostics.projectRegistry, homeDir: ctx.agentsHomeDir },
	);
	if (!gate.ok) {
		ctx.ui.notify(`Agent '${record.name}' is not runnable: ${gate.reason}. Next: ${nextStepForRunBlock(record, gate.code)}`, "warning");
		return;
	}
	ctx.ui.notify(`Running registered ${record.source} agent '${currentParsed.spec.name}' with read-only tools.`, "info");
	await executeChildRun(currentParsed.spec, task, ctx, record.source, profileOverride);
}

/** P6-3b: parse /agents do input. Leading --profile is tokens[0] (no agent-name token). */
export function parseDoArgs(input: string): { ok: true; task: string; profileOverride?: string } | { ok: false; message: string } {
	const usage = "Usage: /agents do [--profile <name>] <task>";
	const trimmed = input.trim();
	if (!trimmed) return { ok: false, message: usage };
	const tokens = trimmed.split(/\s+/);
	if (tokens[0] === "--profile") {
		if (tokens.length < 2 || tokens[1].startsWith("--")) return { ok: false, message: usage };
		const task = tokens.slice(2).join(" ").trim();
		if (!task) return { ok: false, message: usage };
		return { ok: true, task, profileOverride: tokens[1] };
	}
	return { ok: true, task: trimmed, profileOverride: undefined };
}

/** P6-3b: the /agents do command — route by intent, auto-run high-confidence read-only picks. */
/** Tools allowed for auto-run (REQ-8 read-only rail). Case/whitespace-exact — fails closed. */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

/** Test-only seam: override fn in unit tests to intercept classifier calls.
 *  Do not mutate in production. Defaults to collectChildProcess. */
export const __classifierRunner = { fn: collectChildProcess };

export async function runIntentCommand(input: string, ctx: AgentsContextLike, diagnostics: AgentDiagnostics): Promise<void> {
	const parsed = parseDoArgs(input);
	if (!parsed.ok) { ctx.ui.notify(parsed.message, "warning"); return; }
	if (!ctx.hasUI) {
		ctx.ui.notify("Intent routing needs interactive confirmation. Use /agents run <agent> <task>.", "warning");
		return;
	}
	const candidates = buildIntentCandidates(diagnostics);
	if (candidates.length === 0) { ctx.ui.notify("No runnable agents to route to.", "warning"); return; }
	const decision = await resolveRunIntent(parsed.task, candidates, { runClassifier: __classifierRunner.fn });
	const chosen = candidates.find((c) => c.name === decision.agent);
	if (!chosen) { ctx.ui.notify(`Router chose unknown agent '${decision.agent}'.`, "warning"); return; }
	const tools = chosen.source === "built-in"
		? (getBuiltInAgentSpec(decision.agent)?.tools ?? [])
		: (diagnostics.records.find((r) => r.name === decision.agent)?.spec?.tools ?? []);
	const readOnly = tools.length > 0 && tools.every((t) => READ_ONLY_TOOLS.has(t));
	const autoRun = decision.confidence >= INTENT_AUTORUN_CONFIDENCE && readOnly;
	if (!autoRun) {
		const ok = await ctx.ui.confirm(`Route to ${decision.agent}?`, `${decision.reason} (confidence ${decision.confidence.toFixed(2)})`);
		if (!ok) { ctx.ui.notify("Routing cancelled.", "info"); return; }
	}
	let profile = parsed.profileOverride;
	if (!profile && chosen.source === "built-in" && chosen.role) {
		const roleDefault = ROLE_DEFAULT_PROFILE[chosen.role];
		const def = ctx.profileLibrary?.profiles?.find((p) => p.name === roleDefault);
		if (def && profileEffect(def) !== "none") profile = roleDefault;
	}
	if (chosen.source === "built-in") {
		await executeChildRun(decision.agent, parsed.task, ctx, "built-in", profile);
	} else {
		const resolved = await resolveRegisteredRunTarget(decision.agent, diagnostics);
		if (!resolved.ok) { ctx.ui.notify(resolved.message, "warning"); return; }
		await runResolvedTarget(resolved.record, parsed.task, ctx, diagnostics, profile);
	}
}
