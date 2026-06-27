// Shared run-resolution helpers extracted from index.ts so /agents run and run_subagent
// share the same gated path. P3d-1 Step 1: pure move with zero logic changes.

import { parseAgentMarkdownFile } from "./agent-markdown.ts";
import { canRunAgent } from "./can-run-agent.ts";
import {
	buildIntentCandidates,
	type AgentDiagnosticRecord,
	type AgentDiagnostics,
} from "./diagnostics.ts";
import { collectChildProcess, formatChildAgentRunResult, formatAgentResultForContext, runBuiltInChildAgent, runChildAgent, type ChildAgentRunner, type ChildAgentRunResult } from "./child-runner.ts";
import { getBuiltInAgentSpec, isReservedBuiltInAgentName } from "./specs.ts";
import { prepareAgentTask } from "./context-providers/prepare-task.ts";
import { type ReviewTargetInput } from "./context-providers/review-context.ts";
import type { ModelProfileLibrary } from "./profiles.ts";
import type { ProjectAgentRegistry } from "./registry.ts";
import { resolveRunIntent, profileEffect, INTENT_AUTORUN_CONFIDENCE, ROLE_DEFAULT_PROFILE, type IntentCandidate } from "./intent-router.ts";
import { startBackgroundRun, startBackgroundPhase, type BgRunUI, type BgRunSettle } from "./bg-run.ts";

export type AgentsContextLike = {
	cwd?: string;
	hasUI?: boolean;
	agentsHomeDir?: string;
	agentsPiCommand?: string;
	agentsChildRunner?: ChildAgentRunner;
	explicitToolContextLoaderPath?: string;
	disableContextFiles?: boolean;
	profileLibrary?: ModelProfileLibrary;
	projectTrusted?: boolean;
	projectRegistry?: ProjectAgentRegistry;
	isProjectTrusted?: () => boolean;
	ui: {
		notify(message: string, level?: "info" | "warning" | "error" | string): void;
		confirm?(title: string, message: string): Promise<boolean> | boolean;
		/** P8-3: present when the host UI supports widgets (interactive TUI). When available
		 *  AND hasUI, agent-spawning commands run in the background with a live indicator;
		 *  otherwise they fall back to the synchronous await path (zero behavior change). */
		setWidget?(key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
	};
	/** P8-followup: inject a completed subagent's result into pi's conversation (triggers a turn
	 *  so pi reacts to the findings). Wired in index.ts to pi.sendUserMessage; absent in non-TUI. */
	deliverResult?: (content: string) => void;
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
		...(ctx.disableContextFiles ? { disableContextFiles: true } : {}),
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

/** P8-3: run the child and return the settle message+level WITHOUT notifying (so a background
 *  run can notify on completion). Optional onProgress streams stdout lines to the widget.
 *  onProgress is forwarded into the runner options; when absent the options are byte-identical
 *  to the pre-P8 path (so the synchronous/tool callers are unchanged). */
/** Test-only seam: override fn in unit tests to observe the (task, opts) prepareAgentTask receives
 *  from the dispatch chain (proves reviewTarget threading). Do not mutate in production. */
export const __prepareTaskSeam = { fn: prepareAgentTask };

async function executeChildRunResult(agent: Parameters<ChildAgentRunner>[0], task: string, ctx: AgentsContextLike, source: string, profileOverride?: string, onProgress?: (line: string) => void, timeoutMs?: number, reviewTarget?: ReviewTargetInput): Promise<BgRunSettle> {
	try {
		const childOptions = buildChildRunOptions(ctx);
		const profiles = ctx.profileLibrary;
		const progressOpt = onProgress ? { onProgress } : {};
		const timeoutOpt = timeoutMs ? { timeoutMs } : {};
		const runOptions = {
			...childOptions,
			projectTrusted: ctx.projectTrusted,
			projectRegistry: ctx.projectRegistry,
			...progressOpt,
			...timeoutOpt,
		};
		// P9: assemble review context (diff/branch/changed files/plan docs) for agents that declare
		// `context:` and rewrite the task to point the sandboxed child at the bundle file. No-op for
		// agents without context or when there's nothing to review. dispose() in finally (B3).
		const prepared = await __prepareTaskSeam.fn(agent, task, { cwd: ctx.cwd, reviewTarget });
		const childTask = prepared.task;
		// P10-B: override cwd with the canonical project root (REQ-B3) so the child's read/grep/ls
		// resolve from the repo root, not the caller's subdir or linked-worktree subpath.
		const projectRootCwd = prepared.projectRoot ?? childOptions.cwd;
		const runOptionsWithRoot = { ...runOptions, cwd: projectRootCwd };
		let result: ChildAgentRunResult;
		try {
			result = ctx.agentsChildRunner
				? await ctx.agentsChildRunner(agent, childTask, profileOverride ? { ...childOptions, cwd: projectRootCwd, profileOverride, ...progressOpt, ...timeoutOpt } : { ...childOptions, cwd: projectRootCwd, ...progressOpt, ...timeoutOpt })
				: typeof agent === "string"
					? await runBuiltInChildAgent(agent, childTask, runOptionsWithRoot, profiles, profileOverride)
					: await runChildAgent(agent, childTask, runOptionsWithRoot, profiles, profileOverride);
		} finally {
			await prepared.dispose();
		}
		// P8-followup: feed the run into pi's conversation (best-effort) — findings on success, or a
		// framed error for pi to interpret + advise on failure (timeout/spawn/exit).
		if (typeof ctx.deliverResult === "function") {
			try { ctx.deliverResult(formatAgentResultForContext(result)); } catch { /* delivery best-effort */ }
		}
		return { message: formatChildAgentRunResult(result), level: result.status === "completed" ? "info" : "warning" };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { message: `Agent run failed before ${source} child execution completed: ${message}`, level: "error" };
	}
}

/** Synchronous run + notify (the no-UI / tool fallback). Behavior unchanged from pre-P8. */
export async function executeChildRun(agent: Parameters<ChildAgentRunner>[0], task: string, ctx: AgentsContextLike, source: string, profileOverride?: string, timeoutMs?: number, reviewTarget?: ReviewTargetInput): Promise<void> {
	const settle = await executeChildRunResult(agent, task, ctx, source, profileOverride, undefined, timeoutMs, reviewTarget);
	ctx.ui.notify(settle.message, settle.level);
}

/** P8-3: background the run when the host has an interactive widget UI; otherwise await inline.
 *  Backgrounding returns immediately so pi's composer stays live (REQ-1). The synchronous path
 *  is taken when !hasUI OR the host lacks setWidget (REQ-8), keeping non-TUI/tool callers and the
 *  existing test suites unchanged (their ctx.ui has no setWidget). */
export async function dispatchChildRun(agent: Parameters<ChildAgentRunner>[0], task: string, ctx: AgentsContextLike, source: string, profileOverride?: string, timeoutMs?: number, reviewTarget?: ReviewTargetInput): Promise<void> {
	if (ctx.hasUI && typeof ctx.ui.setWidget === "function") {
		const label = typeof agent === "string" ? agent : agent.name;
		startBackgroundRun({
			ui: ctx.ui as BgRunUI,
			label,
			run: (handle) => executeChildRunResult(agent, task, ctx, source, profileOverride, handle.onProgress, timeoutMs, reviewTarget),
		});
		return;
	}
	await executeChildRun(agent, task, ctx, source, profileOverride, timeoutMs, reviewTarget);
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
		await dispatchChildRun(parsed.name, parsed.task, ctx, "built-in", parsed.profileOverride, parsed.timeoutMs, parsed.reviewTarget);
		return;
	}

	const resolved = await resolveRegisteredRunTarget(parsed.name, diagnostics);
	if (!resolved.ok) {
		ctx.ui.notify(resolved.message, "warning");
		return;
	}
	await runResolvedTarget(resolved.record, parsed.task, ctx, diagnostics, parsed.profileOverride, parsed.timeoutMs, parsed.reviewTarget);
}

export function parseRunArgs(input: string): { ok: true; name: string; task: string; profileOverride?: string; timeoutMs?: number; reviewTarget?: ReviewTargetInput; warning?: string } | { ok: false; message: string } {
	const usage = "Usage: /agents run <agent> [--profile <name>] [--timeout <seconds>] [--base <ref> | --range <a>..<b>] <task>";
	const trimmed = input.trim();
	if (!trimmed) return { ok: false, message: usage };

	const tokens = trimmed.split(/\s+/);
	const name = tokens[0];
	if (!name) return { ok: false, message: usage };

	// Consume leading --profile/--timeout/--base/--range flags (any order, immediately after the agent
	// name). A flag appearing mid-task is part of the task, with a warning (preserves prior behavior).
	const leading = parseLeadingRunFlags(tokens, 1, usage, { allowTargetFlags: true });
	if (!leading.ok) return { ok: false, message: usage };
	const restTokens = tokens.slice(leading.taskStart);
	const strayFlag = restTokens.some((t) => t === "--profile" || t === "--timeout" || t === "--base" || t === "--range")
		? "--profile/--timeout/--base/--range must come right after the agent name; treated as task text"
		: undefined;
	// CR-5: a spaced range value (`--range a .. b`) splits on whitespace — only "a" is captured and the
	// leftover "..", "b" become task text. Detect the orphaned operator token and warn so it isn't silent.
	const spacedRange = leading.reviewTarget && restTokens[0] && /^\.\.\.?/.test(restTokens[0])
		? "a --range/--base value looks split by spaces — write it without spaces (e.g. --range a..b); trailing tokens were treated as task text"
		: undefined;
	const warning = leading.warning ?? spacedRange ?? strayFlag;
	const task = restTokens.join(" ").trim();
	if (!task) return { ok: false, message: usage };
	return { ok: true, name, task, profileOverride: leading.profileOverride, timeoutMs: leading.timeoutMs, reviewTarget: leading.reviewTarget, warning };
}

/** Consume leading --profile <name> / --timeout <seconds> [/ --base <ref> / --range <a>..<b>] flags
 *  from tokens[start..]. Any order, each at most once. Returns the index where the task begins.
 *  --timeout is in SECONDS (1..3600). P11: --base/--range are parsed ONLY when allowTargetFlags is
 *  true (run-only — /agents do and the gate pass false, so they treat the flags as task text — B6).
 *  Parsing is SYNTACTIC only: ref-token safety is enforced later by isSafeGitRef in resolveDiffTarget
 *  (the security boundary), so e.g. `--base -O` parses here and is rejected+noted at resolve time. */
function parseLeadingRunFlags(tokens: string[], start: number, _usage: string, opts: { allowTargetFlags?: boolean } = {}): { ok: true; profileOverride?: string; timeoutMs?: number; reviewTarget?: ReviewTargetInput; warning?: string; taskStart: number } | { ok: false } {
	let i = start;
	let profileOverride: string | undefined;
	let timeoutMs: number | undefined;
	let baseRef: string | undefined;
	let rangeSpec: string | undefined;
	const isTargetFlag = (t: string) => !!opts.allowTargetFlags && (t === "--base" || t === "--range");
	while (i < tokens.length && (tokens[i] === "--profile" || tokens[i] === "--timeout" || isTargetFlag(tokens[i]))) {
		const flag = tokens[i];
		const value = tokens[i + 1];
		if (value === undefined || value.startsWith("--")) return { ok: false };
		if (flag === "--profile") {
			if (profileOverride !== undefined) return { ok: false }; // repeated
			profileOverride = value;
		} else if (flag === "--timeout") {
			if (timeoutMs !== undefined) return { ok: false }; // repeated
			const sec = Number(value);
			if (!Number.isInteger(sec) || sec <= 0 || sec > 3600) return { ok: false };
			timeoutMs = sec * 1000;
		} else if (flag === "--base") {
			if (baseRef !== undefined) return { ok: false }; // repeated
			baseRef = value;
		} else { // --range
			if (rangeSpec !== undefined) return { ok: false }; // repeated
			rangeSpec = value;
		}
		i += 2;
	}
	// REQ-11: --range wins over --base; surface a warning when both were given so a typed flag is
	// never silently dropped (the confusion P11 removes).
	let reviewTarget: ReviewTargetInput | undefined;
	let warning: string | undefined;
	if (rangeSpec !== undefined) {
		reviewTarget = { kind: "range", spec: rangeSpec };
		if (baseRef !== undefined) warning = "both --range and --base given; using --range, ignoring --base";
	} else if (baseRef !== undefined) {
		reviewTarget = { kind: "base", ref: baseRef };
	}
	return { ok: true, profileOverride, timeoutMs, reviewTarget, warning, taskStart: i };
}

/** P6-3a: extract the registered-run tail of runAgentCommand into a reusable function.
 *  Zero behavior change — same parse/re-read/gate/execute sequence.
 *  Called by runAgentCommand (existing) and runIntentCommand (P6-3b). */

/** P4-2: shared preflight gate — re-read current spec bytes, recompute status, run canRunAgent.
 *  Used by runResolvedTarget (sync, behavior-preserving) and preflightBgAgent (background).
 *  Returns the live parsed spec + gate result, or a denial with a user-facing reason. */
export async function preflightAgentGate(
	record: RunnableRegisteredRecord,
	ctx: AgentsContextLike,
	diagnostics: AgentDiagnostics,
): Promise<{ ok: true; parsed: Awaited<ReturnType<typeof parseAgentMarkdownFile>>; gate: Awaited<ReturnType<typeof canRunAgent>> } | { ok: false; reason: string; code: string }> {
	let currentParsed: Awaited<ReturnType<typeof parseAgentMarkdownFile>>;
	try {
		currentParsed = await parseAgentMarkdownFile(record.filePath, { source: record.source });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, code: "re-read-failed", reason: `Agent '${record.name}' is not runnable: failed to re-read current spec bytes: ${message}. Next: /agents inspect ${record.name}` };
	}
	if (!currentParsed.spec || currentParsed.status === "invalid" || currentParsed.status === "dangerous" || currentParsed.status === "shadowed") {
		return { ok: false, code: "bad-status", reason: `Agent '${record.name}' is not runnable: current spec status=${currentParsed.status}. Next: /agents inspect ${record.name}` };
	}
	const gate = await canRunAgent(
		{ parsed: currentParsed, canonicalPath: record.canonicalPath },
		{ projectTrusted: diagnostics.projectTrusted, projectRoot: diagnostics.projectRoot, userRegistry: diagnostics.userRegistry, projectRegistry: diagnostics.projectRegistry, homeDir: ctx.agentsHomeDir },
	);
	if (!gate.ok) {
		return { ok: false, code: gate.code, reason: `Agent '${record.name}' is not runnable: ${gate.reason}. Next: ${nextStepForRunBlock(record, gate.code)}` };
	}
	return { ok: true, parsed: currentParsed, gate };
}

export async function runResolvedTarget(record: RunnableRegisteredRecord, task: string, ctx: AgentsContextLike, diagnostics: AgentDiagnostics, profileOverride?: string, timeoutMs?: number, reviewTarget?: ReviewTargetInput): Promise<void> {
	const preflight = await preflightAgentGate(record, ctx, diagnostics);
	if (!preflight.ok) {
		ctx.ui.notify(preflight.reason, "warning");
		return;
	}
	const currentParsed = preflight.parsed;
	ctx.ui.notify(`Running registered ${record.source} agent '${currentParsed.spec.name}' with read-only tools.`, "info");
	await dispatchChildRun(currentParsed.spec, task, ctx, record.source, profileOverride, timeoutMs, reviewTarget);
}

/** P6-3b: parse /agents do input. Leading --profile/--timeout flags (no agent-name token). */
export function parseDoArgs(input: string): { ok: true; task: string; profileOverride?: string; timeoutMs?: number } | { ok: false; message: string } {
	const usage = "Usage: /agents do [--profile <name>] [--timeout <seconds>] <task>";
	const trimmed = input.trim();
	if (!trimmed) return { ok: false, message: usage };
	const tokens = trimmed.split(/\s+/);
	// flags start at index 0 (no agent name). allowTargetFlags:false — /agents do never targets a
	// diff (--base/--range stay task text), so the NL/classifier path can't smuggle a review target (B6).
	const leading = parseLeadingRunFlags(tokens, 0, usage, { allowTargetFlags: false });
	if (!leading.ok) return { ok: false, message: usage };
	const task = tokens.slice(leading.taskStart).join(" ").trim();
	if (!task) return { ok: false, message: usage };
	return { ok: true, task, profileOverride: leading.profileOverride, timeoutMs: leading.timeoutMs };
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
	// The classifier runs synchronously (we need its pick before launching) so the composer is
	// briefly held here. Animate a spinner during it so it doesn't read as a freeze; it transitions
	// seamlessly into the chosen agent's run spinner.
	const stopPhase = (ctx.hasUI && typeof ctx.ui.setWidget === "function")
		? startBackgroundPhase(ctx.ui as BgRunUI, "routing — selecting agent…")
		: () => {};
	let decision;
	try {
		decision = await resolveRunIntent(parsed.task, candidates, { runClassifier: __classifierRunner.fn });
	} finally {
		stopPhase();
	}
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
		await dispatchChildRun(decision.agent, parsed.task, ctx, "built-in", profile, parsed.timeoutMs);
	} else {
		const resolved = await resolveRegisteredRunTarget(decision.agent, diagnostics);
		if (!resolved.ok) { ctx.ui.notify(resolved.message, "warning"); return; }
		await runResolvedTarget(resolved.record, parsed.task, ctx, diagnostics, profile, parsed.timeoutMs);
	}
}
