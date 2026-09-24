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
export const AGENTS_RUN_CHAIN_MAX = 8;

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
			return { ok: false, reason: "chain requires 2..8 safe agent names" };
		}
		for (const entry of p.chain) {
			if (!AGENTS_RUN_AGENT_RE.test(entry.trim())) {
				return { ok: false, reason: "chain requires 2..8 safe agent names" };
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
			"Use mode chain with 2..8 agent names to run a relay chain; each name must be a safe identifier.",
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
					description: "Delegation mode: run (default, synchronous child), bg (registered agents only, persistent terminal), chain (relay 2..8 agents).",
				},
				agent: {
					type: "string",
					pattern: "^[A-Za-z][A-Za-z0-9._-]{0,127}$",
					description: "Built-in agent name (e.g. scout, planner, reviewer) or a registered user/project agent name.",
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
					description: "Optional timeout in seconds (1..3600).",
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
					minItems: 2,
					maxItems: 8,
					items: {
						type: "string",
						pattern: "^[A-Za-z][A-Za-z0-9._-]{0,127}$",
					},
					description: "chain mode only: 2..8 agent names relayed in order.",
				},
			},
		},
	};
}
