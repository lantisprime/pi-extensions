// P5b-1: Shared constants for the cmux-terminal extension.
// Imported by other modules; no runtime side effects.
export const CMUX_BACKEND_NAME = "cmux";
export const CMUX_WINDOW_PREFIX = "pi-cmux-";
export const MAX_ERROR_STDERR_LEN = 512;
export const CMUX_INVOCATION_TIMEOUT_MS = 10_000;
export const CMUX_KILL_TIMEOUT_MS = 5_000;
export const CMUX_AVAILABLE_TIMEOUT_MS = 1_000;
export const WORKER_BASENAMES = ["bg-worker.ts", "bg-worker.mjs", "bg-worker.js"] as const;
export const REDACTED_WORKER = "<worker>";
export const REDACTED_MANIFEST = "<manifest>";
