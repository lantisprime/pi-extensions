// P5: Shared constants for the tmux-terminal extension.
// Imported by other modules; no runtime side effects.
export const TMUX_INVOCATION_TIMEOUT_MS = 10_000;
export const TMUX_WINDOW_PREFIX = "pi-agent-";
export const MAX_ERROR_STDERR_LEN = 512;
export const TMUX_BACKEND_NAME = "tmux";
export const WORKER_BASENAMES = ["bg-worker.ts", "bg-worker.mjs", "bg-worker.js"] as const;
export const REDACTED_WORKER = "<worker>";
export const REDACTED_MANIFEST = "<manifest>";