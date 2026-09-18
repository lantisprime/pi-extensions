// herdr-control shared constants. No runtime side effects.
export const DEFAULT_HERDR_PREFIX = "pi-herdr-";

// herdr agent names: [a-z][a-z0-9_-]{0,31} (herdr.dev/docs/agent-automation).
export const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

// herdr pane refs: w<pN>:p<pN>, e.g. w9:p1. Closed IDs are never reused.
export const PANE_REF_RE = /^w\d+:p\d+$/;

// agent start waits for interactive readiness: 30s default, (3000, 300000] ms.
export const AGENT_START_TIMEOUT_MS = 30_000;
export const AGENT_START_MIN_TIMEOUT_MS = 3_001;
export const AGENT_START_MAX_TIMEOUT_MS = 300_000;

// agent prompt --wait: herdr requires >5s caller timeouts for clean timeout
// semantics (at <=5s it returns plain timeout instead of stalled semantics).
export const DEFAULT_SPAWN_TIMEOUT_MS = 300_000;
export const PROMPT_MIN_TIMEOUT_MS = 5_000;
export const PROMPT_MAX_TIMEOUT_MS = 600_000;

// Baseline per-call cap for short herdr calls (list/get/read/close/status).
export const HERDR_SHORT_TIMEOUT_MS = 10_000;
// Hard ceiling for any single herdr exec (long waits via prompt/wait).
export const HERDR_EXEC_ABS_MAX_MS = 600_000;

// agent read defaults.
export const DEFAULT_READ_SOURCE = "recent-unwrapped";
export const DEFAULT_READ_LINES = 200;
export const MIN_READ_LINES = 1;
export const MAX_READ_LINES = 1_000;

// Transcript payload budget for tool results (tail-keeping).
export const MAX_TRANSCRIPT_CHARS = 8_000;

// Positive server-status check cache window for the entry gate.
export const SERVER_STATUS_CACHE_MS = 30_000;
// Failed checks are retried sooner (avoid hammering a dead socket).
export const SERVER_STATUS_FAIL_CACHE_MS = 5_000;

// Session-entry custom type for spawn-registry event sourcing.
export const SPAWN_REGISTRY_ENTRY_TYPE = "herdr-control/spawn-registry";

// Supported agent kinds (herdr 0.8.0 `herdr agent start --kind`).
export const HERDR_KINDS = [
	"pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline",
	"omp", "mastracode", "opencode", "copilot", "kimi", "kiro", "droid",
	"amp", "grok", "hermes", "kilo", "qodercli", "maki",
] as const;

export type HerdrKind = (typeof HERDR_KINDS)[number];
