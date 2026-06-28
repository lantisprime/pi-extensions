// tmux-control: shared constants.
export const TMUX_CONTROL_NAME = "tmux-control";
export const DEFAULT_WINDOW_PREFIX = "pi-agent-";
export const DEFAULT_CAPTURE_LINES = 200;
export const MAX_CAPTURE_LINES = 5_000;
export const TMUX_INVOCATION_TIMEOUT_MS = 5_000;
export const MAX_TEXT_BYTES = 4_000;
export const MAX_ERROR_STDERR_LEN = 512;
// Buffer name for pasteText (P5c-2-S1). Extension-controlled constant — never
// derived from user input — so `-b <name>` cannot be injected (REQ-4).
export const PASTE_BUFFER_NAME = "pictl-paste";
// Max Enter invocations in a single sendText/pressEnterCount (P5c-2-S3 seam;
// pasted here so pasteText can clamp it without circular deps).
export const MAX_ENTER_COUNT = 10;
// Default poll cadence for waitForWindow (P5c-2-S2).
export const DEFAULT_WAIT_INTERVAL_MS = 1_000;
// Default capture depth for waitForWindow (P5c-2-S2). Tighter than the
// LLM-tool default (DEFAULT_CAPTURE_LINES) because we're polling for a marker
// in the recent prompt area, not the full scrollback. Smaller captures are
// faster and reduce false-positive matches against historical output.
export const DEFAULT_WAIT_LINES = 50;
// Bracketed-paste markers (P5c-2-S1, REQ-20). tmux does NOT escape these bytes
// when emitting paste-buffer content, so a payload containing a literal
// \e[200~ / \e[201~ would open/close the bracket from the receiving TUI's
// parser POV — splitting one paste into multiple events and letting bytes after
// an embedded \e[201~ be processed as typed input (premature submit). pasteText
// rejects any payload that contains these. Exported so the rejection guard and
// its tests share one definition. (\x1b and \x1B are the SAME byte 0x1b — there
// is no uppercase marker variant.)
export const BRACKET_START = "\x1b[200~";
export const BRACKET_END = "\x1b[201~";