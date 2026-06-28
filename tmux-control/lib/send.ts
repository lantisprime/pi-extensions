// tmux-control: send-keys with text-bound and safety checks.
//
// All text is delivered via argv-only execFile (no shell). The `Enter` key
// is sent as a separate send-keys invocation AFTER the text, so the literal
// text is delivered first (avoids literal-text mode mishaps).
//
// Target MUST be session-qualified (`session:windowIndex`) to avoid tmux
// ambiguity (see lib/list.ts for the rationale).
//
// Multi-line routing (P5c-2-S1, REQ-18):
//   Text containing '\n' is delivered via pasteText() (bracketed paste) so the
//   TUI receives the entire prompt as one event — `send-keys -l` of a string
//   with newlines would fire Enter on every '\n', prematurely submitting
//   incomplete multi-line prompts. Opt-out with `mode: "keys"` (S5 seam).
//
// Safety:
//   - Target resolved by safety.resolveTarget BEFORE send.
//   - Text length capped at MAX_TEXT_BYTES (4 KB) to prevent floods.
//   - send-keys with literal text uses `-l` to suppress key-name parsing.
import type { TmuxExecutor } from "./exec.ts";
import { TMUX_INVOCATION_TIMEOUT_MS, MAX_TEXT_BYTES } from "./constants.ts";
import { pasteText } from "./paste.ts";

export type SendMode = "literal" | "keys";

export interface SendTarget {
	sessionName: string;
	windowIndex: string;
}

export interface SendResult {
	ok: boolean;
	sentBytes?: number;
	error?: string;
	/** True if the text was routed through pasteText (multi-line). Omitted for the literal path. */
	routedViaPaste?: boolean;
}

export interface SendOpts {
	/** Send Enter after text (default true). */
	pressEnter?: boolean;
	/** Number of separate Enter invocations. S3 seam (default 1). */
	pressEnterCount?: number;
	/** "literal" (default) or "keys". S5 seam — keys mode skips multi-line routing. */
	mode?: SendMode;
}

export async function sendText(
	executor: TmuxExecutor,
	socketPrefix: string[],
	target: SendTarget,
	text: string,
	opts?: SendOpts,
): Promise<SendResult> {
	if (typeof text !== "string") return { ok: false, error: "text must be a string" };
	if (text.length > MAX_TEXT_BYTES) {
		return { ok: false, error: `text too long: ${text.length} bytes (max ${MAX_TEXT_BYTES})` };
	}

	// Multi-line routing (REQ-18): when text contains '\n' AND caller did NOT
	// explicitly request keys mode, route through pasteText (bracketed paste).
	// - Single-line text stays on the fast path (send-keys -l).
	// - Keys mode skips routing (callers want literal key tokens).
	// - pressEnter/pressEnterCount thread through.
	if (opts?.mode !== "keys" && text.includes("\n")) {
		const r = await pasteText(executor, socketPrefix, target, text, {
			pressEnter: opts?.pressEnter,
			pressEnterCount: opts?.pressEnterCount,
		});
		return { ...r, routedViaPaste: true };
	}

	const t = `${target.sessionName}:${target.windowIndex}`;

	// Literal-mode send (`-l`): every char in `text` is treated as a literal
	// key press, NOT a tmux key name. Without `-l`, words like "Up" or "C-x"
	// would be interpreted as key names.
	const textArgs = [...socketPrefix, "send-keys", "-l", "-t", t, text];
	const r1 = await executor.exec(textArgs, { timeoutMs: TMUX_INVOCATION_TIMEOUT_MS });
	if (!r1.ok) {
		return { ok: false, error: r1.stderr || `send-keys failed (exit ${r1.exitCode})` };
	}

	const pressEnter = opts?.pressEnter !== false;
	if (pressEnter) {
		const r2 = await executor.exec(
			[...socketPrefix, "send-keys", "-t", t, "Enter"],
			{ timeoutMs: TMUX_INVOCATION_TIMEOUT_MS },
		);
		if (!r2.ok) {
			return { ok: false, error: `text sent but Enter failed: ${r2.stderr}` };
		}
	}

	return { ok: true, sentBytes: text.length };
}