// P5b-2: Shared constants for the zellij-terminal extension.
// Imported by other modules; no runtime side effects.
export const ZELLIJ_BACKEND_NAME = "zellij";
export const ZELLIJ_SESSION_PREFIX = "pi-zellij-";
export const ZELLIJ_BACKEND_PREFERENCE = 0;
export const ZELLIJ_INVOCATION_TIMEOUT_MS = 10_000; // for `run`
export const ZELLIJ_LIST_TIMEOUT_MS = 5_000; // for `list-sessions`/`kill-session`/`list-panes`
export const ZELLIJ_LAUNCH_POLL_TIMEOUT_MS = 5_000; // poll for session appearance after `attach -b`
export const ZELLIJ_LAUNCH_POLL_INTERVAL_MS = 250;
export const ZELLIJ_AVAILABLE_PROBE_TIMEOUT_MS = 1_000;
export const WORKER_BASENAMES = ["bg-worker.ts", "bg-worker.mjs", "bg-worker.js"] as const;
export const REDACTED_WORKER = "<worker>";
export const REDACTED_MANIFEST = "<manifest>";
export const MAX_ERROR_STDERR_LEN = 512;
