// SCHEMA1-A agents_run: schema-bounded LLM front door for /agents run|bg|chain.
// This file (slice A) is pure validation + tool-definition builder; exec
// wiring and registration are SCHEMA1-B. Plan:
// .plans/SCHEMA/SCHEMA1_AGENTS_RUN_PLAN.md (Appendix B mechanical spec).
//
// Design decision (amends WORKPLAN REQ-A1, recorded in the plan): `agent`,
// `profile`, and `backend` are pattern-bounded strings, NOT schema enums —
// the registered-agent set and profile library are dynamic per project while
// schemas are static. Runtime resolution stays fail-closed with an
// available-list error and remains the security boundary (registry gate,
// isSafeGitRef, bg preflight). Schema bounds are a strict subset of runtime
// checks.

// --- Shared constants ---

export const AGENTS_RUN_AGENT_RE = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
export const AGENTS_RUN_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
export const AGENTS_RUN_RANGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{2,}\.\.[A-Za-z0-9][A-Za-z0-9._/-]{2,}$/;
export const AGENTS_RUN_TIMEOUT_MIN_S = 1;
export const AGENTS_RUN_TIMEOUT_MAX_S = 3600;
export const AGENTS_RUN_TASK_MAX_CHARS = 8_000;
export const AGENTS_RUN_CHAIN_MIN = 2;
// One constant for one concept: the relay runner has a hard cap
// (MAX_CHAIN_LENGTH), so the schema must advertise the SAME bound. They used to
// be 8 (schema) and 3 (runner), which spent a model turn discovering the
// difference. agents-run-tool already imports chain-runner below, so the
// dependency exists regardless; binding the schema to it is what stops the drift.
export const AGENTS_RUN_CHAIN_MAX = MAX_CHAIN_LENGTH;
export const AGENTS_RUN_CHAIN_RANGE = `${AGENTS_RUN_CHAIN_MIN}..${AGENTS_RUN_CHAIN_MAX}`;

// C0 control-char set replicated from subagent-tool.ts semantics so slice A
// stays zero-dependency: allow ordinary multiline task text (TAB/LF/CR),
// reject NUL and other C0 controls.
const DISALLOWED_CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

// --- Types ---

export type AgentsRunMode = "run" | "bg" | "chain";

export type AgentsRunParams = {
	mode?: AgentsRunMode;
	agent: string;
	task: string;
	timeout_s?: number;
	profile?: string;
	backend?: string;
	base?: string;
	range?: string;
	chain?: string[];
};

export type ValidatedAgentsRun =
	| {
			ok: true;
			mode: AgentsRunMode;
			agent: string;
			task: string;
			timeout_s?: number;
			profile?: string;
			backend?: string;
			base?: string;
			range?: string;
			chain?: string[];
	  }
	| { ok: false; reason: string };

// --- Input validation (contract states A-H) ---

// State table (SCHEMA1_AGENTS_RUN_PLAN.md Contracts):
//   A ok · B bad agent · C bad task · D bad timeout · E bad chain ·
//   F bad ref · G bad mode · H type confusion.
// Type checks (H) always precede pattern checks: NEVER regex-test a coerced
// value. Pure function, no pi API.
export function validateAgentsRunInput(raw: unknown): ValidatedAgentsRun {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, reason: "params must be an object" };
	}
	const p = raw as Record<string, unknown>;

	// mode (optional, default "run") — state G / H.
	let mode: AgentsRunMode = "run";
	if (p.mode !== undefined) {
		if (typeof p.mode !== "string") return { ok: false, reason: "mode must be a string" };
		if (p.mode !== "run" && p.mode !== "bg" && p.mode !== "chain") {
			return { ok: false, reason: "mode must be run|bg|chain" };
		}
		mode = p.mode;
	}

	// agent (required) — state H then B.
	if (typeof p.agent !== "string") return { ok: false, reason: "agent must be a string" };
	const agent = p.agent.trim();
	if (!agent || !AGENTS_RUN_AGENT_RE.test(agent)) {
		return { ok: false, reason: "agent must be a safe identifier" };
	}

	// task (required) — state H then C.
	if (typeof p.task !== "string") return { ok: false, reason: "task must be a string" };
	const task = p.task;
	if (task.trim().length === 0) {
		return { ok: false, reason: "task must not be empty or whitespace-only" };
	}
	if (DISALLOWED_CONTROL_CHAR_RE.test(task)) {
		return { ok: false, reason: "task contains control characters (NUL or other control bytes)" };
	}
	if (task.length > AGENTS_RUN_TASK_MAX_CHARS) {
		return { ok: false, reason: `task exceeds maxTaskChars (${AGENTS_RUN_TASK_MAX_CHARS})` };
	}

	// timeout_s (optional) — state H (not a number / not integer) then D (range).
	if (p.timeout_s !== undefined) {
		if (typeof p.timeout_s !== "number" || !Number.isInteger(p.timeout_s)) {
			return { ok: false, reason: "timeout_s must be an integer" };
		}
		if (p.timeout_s < AGENTS_RUN_TIMEOUT_MIN_S || p.timeout_s > AGENTS_RUN_TIMEOUT_MAX_S) {
			return { ok: false, reason: "timeout_s must be an integer 1..3600" };
		}
	}

	// profile / backend (optional) — state H then B-family pattern.
	if (p.profile !== undefined) {
		if (typeof p.profile !== "string") return { ok: false, reason: "profile must be a string" };
		if (!AGENTS_RUN_AGENT_RE.test(p.profile.trim())) {
			return { ok: false, reason: "profile must be a safe identifier" };
		}
	}
	if (p.backend !== undefined) {
		if (typeof p.backend !== "string") return { ok: false, reason: "backend must be a string" };
		if (!AGENTS_RUN_AGENT_RE.test(p.backend.trim())) {
			return { ok: false, reason: "backend must be a safe identifier" };
		}
	}

	// base / range (optional git refs) — state H then F. Patterns are
	// prefilters; isSafeGitRef remains the boundary at resolution time.
	if (p.base !== undefined) {
		if (typeof p.base !== "string") return { ok: false, reason: "base must be a string" };
		if (!AGENTS_RUN_REF_RE.test(p.base)) return { ok: false, reason: "invalid git ref: base" };
	}
	if (p.range !== undefined) {
		if (typeof p.range !== "string") return { ok: false, reason: "range must be a string" };
		if (!AGENTS_RUN_RANGE_RE.test(p.range)) return { ok: false, reason: "invalid git ref: range" };
	}

	// chain (optional) — state H (not array / non-string entry) then E.
	if (p.chain !== undefined) {
		if (!Array.isArray(p.chain)) return { ok: false, reason: "chain must be an array" };
		for (const entry of p.chain) {
			if (typeof entry !== "string") return { ok: false, reason: "chain must be an array of strings" };
		}
		if (p.chain.length < AGENTS_RUN_CHAIN_MIN || p.chain.length > AGENTS_RUN_CHAIN_MAX) {
			return { ok: false, reason: `chain requires ${AGENTS_RUN_CHAIN_RANGE} safe agent names` };
		}
		for (const entry of p.chain) {
			if (!AGENTS_RUN_AGENT_RE.test(entry.trim())) {
				return { ok: false, reason: `chain requires ${AGENTS_RUN_CHAIN_RANGE} safe agent names` };
			}
		}
	}

	// State A.
	return {
		ok: true,
		mode,
		agent,
		task,
		...(p.timeout_s !== undefined ? { timeout_s: p.timeout_s as number } : {}),
		...(p.profile !== undefined ? { profile: (p.profile as string).trim() } : {}),
		...(p.backend !== undefined ? { backend: (p.backend as string).trim() } : {}),
		...(p.base !== undefined ? { base: p.base as string } : {}),
		...(p.range !== undefined ? { range: p.range as string } : {}),
		...(p.chain !== undefined ? { chain: p.chain as string[] } : {}),
	};
}

// --- Tool definition (REQ-1: all bounds verbatim, no dynamic enums) ---

export function buildAgentsRunToolDefinition() {
	return {
		name: "agents_run",
		label: "Agents Run",
		description: "Delegate to built-in or registered agents via run/bg/chain modes with schema-bounded inputs",
		promptSnippet: "agents_run agent task — Delegate a task to a built-in or registered agent via run/bg/chain modes",
		promptGuidelines: [
			"Use agents_run to delegate a task to a built-in agent or a registered user/project agent (mode run, the default).",
			"Use mode bg to launch a REGISTERED agent as a persistent background terminal via a named backend; built-ins are denied in bg mode.",
			`Use mode chain with ${AGENTS_RUN_CHAIN_RANGE} agent names to run a relay chain; each name must be a safe identifier. Each step's summary is relayed to the next step as untrusted data, and the chain's findings are returned in this tool result.`,
			"agent/profile/backend are pattern-bounded names, not enums: unknown names fail closed at runtime with the available list.",
		],
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["agent", "task"],
			properties: {
				mode: {
					type: "string",
					enum: ["run", "bg", "chain"],
					default: "run",
					description: `Delegation mode: run (default, synchronous child), bg (registered agents only, persistent terminal), chain (relay ${AGENTS_RUN_CHAIN_RANGE} agents).`,
				},
				agent: {
					type: "string",
					pattern: "^[A-Za-z][A-Za-z0-9._-]{0,127}$",
					description: "Built-in agent name (discover with /agents built-ins) or a registered user/project agent name.",
				},
				task: {
					type: "string",
					maxLength: 8000,
					description: "Delegated task text. Bounded, read-only scope only.",
				},
				timeout_s: {
					type: "integer",
					minimum: 1,
					maximum: 3600,
					description: "Optional timeout in seconds (1..3600), applied per child run. In chain mode it bounds EACH step, not the chain as a whole.",
				},
				profile: {
					type: "string",
					pattern: "^[A-Za-z][A-Za-z0-9._-]{0,127}$",
					description: "Optional model-profile name; must be a safe identifier.",
				},
				backend: {
					type: "string",
					pattern: "^[A-Za-z][A-Za-z0-9._-]{0,127}$",
					description: "bg mode only: registered background-terminal backend name.",
				},
				base: {
					type: "string",
					pattern: "^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$",
					description: "Optional git ref to run from (prefilter only; isSafeGitRef remains the boundary).",
				},
				range: {
					type: "string",
					pattern: "^[A-Za-z0-9][A-Za-z0-9._/-]{2,}\\.\\.[A-Za-z0-9][A-Za-z0-9._/-]{2,}$",
					description: "Optional git commit range A..B (prefilter only; isSafeGitRef remains the boundary).",
				},
				chain: {
					type: "array",
					minItems: AGENTS_RUN_CHAIN_MIN,
					maxItems: AGENTS_RUN_CHAIN_MAX,
					items: {
						type: "string",
						pattern: "^[A-Za-z][A-Za-z0-9._-]{0,127}$",
					},
					description: `chain mode only: ${AGENTS_RUN_CHAIN_RANGE} agent names relayed in order.`,
				},
			},
		},
	};
}

// --- Execution wiring (SCHEMA1-B) ---

// Focused review (2026-09-24, reviewer subagent) resolved before build:
//  - tool ctx forces hasUI:false so mode "run" always takes the inline
//    dispatchChildRun path (UI widget path returns before the child settles,
//    which would make abort-race + tool-result semantics meaningless);
//  - the raced exec promise gets a .catch tail so a post-abort rejection
//    (e.g. bg manifest write) cannot become an UnhandledPromiseRejection;
//  - bg launch mirrors handleBgCommand (index.ts) including the status-line
//    refresh on BOTH outcomes via the onBgSettled hook (lib cannot import
//    index.ts — cycle), and the failure-cleanup writeBgResult+markBgRunDone;
//  - diagnosticsLoader is a seam (default real collectAgentDiagnostics) so
//    wiring tests can fake registered-agent discovery (AGENTS.md rule 4).
import type { AgentsContextLike } from "./run-resolver.ts";
import { dispatchChildRun, resolveRegisteredRunTarget, runResolvedTarget } from "./run-resolver.ts";
import { collectAgentDiagnostics, type AgentDiagnostics } from "./diagnostics.ts";
import { isReservedBuiltInAgentName } from "./specs.ts";
import { getBgTerminalBackendByName, listBgTerminalBackends, type TermBgBackend } from "./bg-terminal.ts";
import { preflightBgAgent } from "./bg-preflight.ts";
import { preflightChain, runChain, partialFindings, MAX_CHAIN_LENGTH } from "./chain-runner.ts";
import { markBgRunDone, updateBgReservationOwner, writeBgResult } from "./bg-state.ts";
import type { ChildAgentRunner } from "./child-runner.ts";
import { frameUntrusted } from "./child-runner.ts";

export type AgentsRunDetails = {
	mode: AgentsRunMode;
	agent: string;
	runId?: string;
	backend?: string;
	/** chain mode: per-step status of every step that ran (B2 — the caller can
	 *  see where a chain stopped instead of only that it stopped). */
	steps?: { agentName: string; status: string; durationMs?: number }[];
	/** chain mode: only the steps that completed, on a failed chain. */
	completedSteps?: { agentName: string; status: string }[];
};

export type AgentsRunOutcome =
	| { ok: true; text: string; details: AgentsRunDetails; isError: false }
	| { ok: false; text: string; code: string; details: AgentsRunDetails; isError: true };

/** Returns the DENIED variant specifically, not the union — callers that build a
 *  denial can then read `.code` without a cast. */
function denyOutcome(details: AgentsRunDetails, code: string, reason: string, nextStep?: string): Extract<AgentsRunOutcome, { ok: false }> {
	return {
		ok: false,
		code,
		text: nextStep ? `agents_run denied: ${reason} Next: ${nextStep}` : `agents_run denied: ${reason}`,
		details,
		isError: true,
	};
}

function notReadyOutcome(details: AgentsRunDetails): Extract<AgentsRunOutcome, { ok: false }> {
	return denyOutcome(details, "not-ready", "session context not ready; tool called before session_start or session is uninitialized");
}

/** Injectable seams for wiring tests. Every field optional; when absent the
 *  production path is used unchanged. (Plan names three seams; the focused
 *  review committed two more: backendByName — bg launch is untestable without
 *  it — and diagnosticsLoader, per AGENTS.md rule 4.) */
export type AgentsRunSeams = {
	/** Forwarded into the AgentsContextLike (run + chain modes). */
	childRunner?: ChildAgentRunner;
	/** bg mode preflight (default: real preflightBgAgent). */
	bgPreflight?: typeof preflightBgAgent;
	/** chain mode runner (default: real runChain). */
	chainRunner?: typeof runChain;
	/** bg backend lookup (default: real getBgTerminalBackendByName). */
	backendByName?: (name: string) => TermBgBackend | undefined;
	/** Discovery loader (default: real collectAgentDiagnostics). */
	diagnosticsLoader?: typeof collectAgentDiagnostics;
	/** Called after every bg launch outcome (success or failure). index.ts
	 *  wires this to updateBgStatusLine + ensureBgStatusPolling for parity
	 *  with /agents bg; default no-op. */
	onBgSettled?: (ctx: AgentsContextLike) => Promise<void> | void;
};

function availableAgentsList(diagnostics: AgentDiagnostics): string {
	const names = diagnostics.records.map((r) => `${r.name} [${r.source}]`);
	return names.length > 0 ? names.join(", ") : "(none discovered)";
}

// --- Core execution (REQ-3/4/5) ---

export async function executeAgentsRun(
	validated: Extract<ValidatedAgentsRun, { ok: true }>,
	runCtx: AgentsContextLike,
	diagnostics: AgentDiagnostics,
	seams: AgentsRunSeams = {},
	signal?: AbortSignal,
): Promise<AgentsRunOutcome> {
	const details: AgentsRunDetails = { mode: validated.mode, agent: validated.agent };
	const timeoutMs = validated.timeout_s !== undefined ? validated.timeout_s * 1000 : undefined;

	// Abort discipline (plan blocker-3): deny before starting, and race the
	// exec against an abort listener so a mid-flight abort settles the tool
	// call with code "aborted". The raced promise gets a catch tail (review
	// blocker B2) so a late rejection cannot surface as unhandled.
	if (signal?.aborted) {
		return denyOutcome(details, "aborted", "aborted before the delegation started");
	}

	const exec = (async (): Promise<AgentsRunOutcome> => {
		if (validated.mode === "run") {
			if (isReservedBuiltInAgentName(validated.agent)) {
				await dispatchChildRun(validated.agent, validated.task, runCtx, "built-in", validated.profile, timeoutMs);
				return {
					ok: true,
					text: `Delegated to built-in agent '${validated.agent}'. The child's findings are delivered to the session (notify + conversation injection).`,
					details,
					isError: false,
				};
			}
			const resolved = await resolveRegisteredRunTarget(validated.agent, diagnostics);
			if (!resolved.ok) {
				return denyOutcome(details, "unknown-agent", resolved.message, `available: ${availableAgentsList(diagnostics)}`);
			}
			await runResolvedTarget(resolved.record, validated.task, runCtx, diagnostics, validated.profile, timeoutMs);
			return {
				ok: true,
				text: `Delegated to registered agent '${validated.agent}'. The child's findings are delivered to the session (notify + conversation injection).`,
				details,
				isError: false,
			};
		}

		if (validated.mode === "bg") {
			// Registered-only parity: resolveRegisteredRunTarget filters
			// source !== "built-in", so /agents bg scout denies today — the
			// tool denies the same shape explicitly (REQ-4, EC10).
			if (isReservedBuiltInAgentName(validated.agent)) {
				return denyOutcome(details, "invalid-input", "bg mode supports registered agents only (built-ins run synchronously in run mode)");
			}
			const backend = seams.backendByName ? seams.backendByName(validated.backend ?? "") : getBgTerminalBackendByName(validated.backend ?? "");
			if (!backend) {
				const registered = listBgTerminalBackends().map((b) => b.name);
				return denyOutcome(details, "unknown-backend", `unknown backend '${validated.backend ?? ""}'`, `registered backends: ${registered.join(", ") || "(none)"}`);
			}
			const resolved = await resolveRegisteredRunTarget(validated.agent, diagnostics);
			if (!resolved.ok) {
				return denyOutcome(details, "unknown-agent", resolved.message, `available: ${availableAgentsList(diagnostics)}`);
			}
			const preflight = seams.bgPreflight
				? await seams.bgPreflight(resolved.record, validated.task, runCtx, diagnostics, {
						...(validated.profile !== undefined ? { profileOverride: validated.profile } : {}),
						...(validated.timeout_s !== undefined ? { maxDurationSec: validated.timeout_s } : {}),
					})
				: await preflightBgAgent(resolved.record, validated.task, runCtx, diagnostics, {
						...(validated.profile !== undefined ? { profileOverride: validated.profile } : {}),
						...(validated.timeout_s !== undefined ? { maxDurationSec: validated.timeout_s } : {}),
					});
			if (!preflight.ok) {
				return denyOutcome(details, preflight.code, preflight.reason);
			}
			const launch = await backend.launch({
				agentName: resolved.record.name ?? resolved.record.filePath,
				runId: preflight.runId,
				manifestPath: preflight.paths.manifestPath,
				cwd: runCtx.cwd ?? process.cwd(),
			});
			if (launch.status === "failed") {
				// Parity with handleBgCommand: free the reservation + manifest so
				// the slot does not wait for the stale-reaper.
				try {
					await writeBgResult(preflight.paths, { version: 1, runId: preflight.runId, status: "failed", error: launch.error ?? "unknown launch error" });
					await markBgRunDone(preflight.paths);
				} catch { /* best-effort; the reaper will catch it on next session */ }
				await seams.onBgSettled?.(runCtx);
				return denyOutcome(details, "spawn-error", `launch failed via ${backend.name}: ${launch.error ?? "unknown error"}`);
			}
			if (launch.windowId) {
				try {
					await updateBgReservationOwner(preflight.paths, {
						ownerHandle: launch.windowId,
						ownerBackendName: backend.name,
					});
				} catch { /* best-effort; age-only fallback is acceptable */ }
			}
			await seams.onBgSettled?.(runCtx);
			return {
				ok: true,
				text: `Background agent '${validated.agent}' running (${preflight.runId.slice(0, 16)}…) via ${backend.name}. Track with /agents bg-status.`,
				details: { ...details, runId: preflight.runId, backend: backend.name },
				isError: false,
			};
		}

		// mode "chain".
		// Defense in depth: validate() already rejects anything over
		// AGENTS_RUN_CHAIN_MAX (bound to MAX_CHAIN_LENGTH), but the runner is the
		// real boundary and can be called with a hand-built array.
		if (validated.chain && validated.chain.length > MAX_CHAIN_LENGTH) {
			return denyOutcome(details, "invalid-input", `chain length capped at ${MAX_CHAIN_LENGTH} agents (the relay runner enforces a hard cap of ${MAX_CHAIN_LENGTH})`);
		}
		const names = validated.chain ?? [];
		const preflight = await preflightChain(names, diagnostics);
		if (!preflight.ok) {
			return denyOutcome(details, preflight.code, preflight.message, preflight.nextStep);
		}
		const chainCtx = {
			cwd: runCtx.cwd,
			agentsPiCommand: runCtx.agentsPiCommand,
			agentsChildRunner: runCtx.agentsChildRunner,
			explicitToolContextLoaderPath: runCtx.explicitToolContextLoaderPath,
			profileLibrary: runCtx.profileLibrary,
			// M3: timeout_s was validated and computed but never reached the chain,
			// so a model bounding a chain got an unbounded one. Per-step, matching
			// the schema text.
			...(timeoutMs !== undefined ? { timeoutMs } : {}),
			// M4: abort the in-flight child instead of only racing the promise.
			...(signal ? { signal } : {}),
		};
		const outcome = seams.chainRunner
			? await seams.chainRunner(preflight.resolved, validated.task, chainCtx)
			: await runChain(preflight.resolved, validated.task, chainCtx);
		const chainNames = names.join(" → ");
		// B2/security: step summaries are child output — UNTRUSTED, they can echo
		// prompt-injection text from repo files the step read. Frame them the same
		// way the session-delivery path does before they reach a model.
		const findings = (perStep: number) => {
			const block = partialFindings(outcome.results, perStep);
			return block ? frameUntrusted(block) : "";
		};
		if (!outcome.ok) {
			// B2: keep the findings from the steps that DID run. Spending up to 3
			// child sessions and reporting only "failed at step 2" is how real work
			// gets thrown away.
			return {
				ok: false,
				code: outcome.code,
				text: `agents_run chain failed at '${outcome.agentName}' (${outcome.code}): ${outcome.message} [chain: ${chainNames}]${findings(2000)}`,
				details: { ...details, completedSteps: outcome.results.map((r) => ({ agentName: r.agentName, status: r.status })) },
				isError: true,
			};
		}
		const failed = outcome.results.filter((s) => s.status !== "completed");
		const stepDetails = outcome.results.map((r) => ({ agentName: r.agentName, status: r.status, durationMs: r.durationMs }));
		if (failed.length > 0) {
			return {
				ok: false,
				code: "chain-partial",
				text: `Chain finished with ${failed.length}/${outcome.results.length} failed step(s): ${failed.map((s) => s.agentName).join(", ")} [chain: ${chainNames}].${findings(2000)}`,
				details: { ...details, steps: stepDetails },
				isError: true,
			};
		}
		return {
			ok: true,
			// B2: the findings ARE the point of the call. Previously this returned
			// only "Chain completed: a → b → c." and threw away every summary.
			text: `Chain completed: ${chainNames}.${findings(2000)}`,
			details: { ...details, steps: stepDetails },
			isError: false,
		};
	})();

	const abortPromise = new Promise<AgentsRunOutcome>((resolve) => {
		signal?.addEventListener("abort", () => resolve(denyOutcome(details, "aborted", "aborted before the delegation completed")), { once: true });
	});
	exec.catch(() => {}); // review blocker B2: swallow the post-abort tail
	const raced = await Promise.race([exec, abortPromise]);
	return raced;
}

// --- Tool registration (mirrors registerSubagentTool) ---

export function registerAgentsRunTool(pi: import("@earendil-works/pi-coding-agent").ExtensionAPI, sessionCtxRef: () => AgentsContextLike | undefined, seams: AgentsRunSeams = {}): void {
	const definition = buildAgentsRunToolDefinition() as unknown as Parameters<import("@earendil-works/pi-coding-agent").ExtensionAPI["registerTool"]>[0];
	pi.registerTool({
		...definition,
		async execute(_toolCallId, params, signal, _onUpdate, extensionCtx) {
			const input = validateAgentsRunInput(params);
			const fallbackDetails: AgentsRunDetails = { mode: "run", agent: "(missing)" };
			if (!input.ok) {
				const outcome = denyOutcome(fallbackDetails, "invalid-input", input.reason);
				return { content: [{ type: "text", text: outcome.text }], details: { ...outcome.details, code: outcome.code }, isError: outcome.isError };
			}

			// Fail closed if session context not yet captured (REQ-5).
			const sessionCtx = sessionCtxRef();
			if (!sessionCtx) {
				const outcome = notReadyOutcome({ mode: input.mode, agent: input.agent });
				return { content: [{ type: "text", text: outcome.text }], details: { ...outcome.details, code: outcome.code }, isError: outcome.isError };
			}

			const loader = seams.diagnosticsLoader ?? collectAgentDiagnostics;
			const diagnostics = await loader({
				cwd: extensionCtx.cwd,
				homeDir: sessionCtx.agentsHomeDir,
				projectTrusted: extensionCtx.isProjectTrusted(),
			});

			// hasUI:false (review blocker B1): the tool awaits the inline
			// dispatch path so completion + abort semantics are deterministic.
			const runCtx: AgentsContextLike = {
				...sessionCtx,
				cwd: extensionCtx.cwd,
				hasUI: false,
				projectTrusted: extensionCtx.isProjectTrusted(),
				...(seams.childRunner ? { agentsChildRunner: seams.childRunner } : {}),
			};

			const outcome = await executeAgentsRun(input, runCtx, diagnostics, seams, signal ?? undefined);
			return {
				content: [{ type: "text", text: outcome.text }],
				// Deny code surfaces in details so the caller can branch on it.
				details: outcome.ok ? outcome.details : { ...outcome.details, code: outcome.code },
				isError: outcome.isError,
			};
		},
	});
}
