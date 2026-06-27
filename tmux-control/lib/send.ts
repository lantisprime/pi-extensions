// tmux-control: send-keys with text-bound and safety checks.
//
// All text is delivered via argv-only execFile (no shell). The `Enter` key
// is sent as a separate send-keys invocation AFTER the text, so the literal
// text is delivered first (avoids literal-text mode mishaps).
//
// Target MUST be session-qualified (`session:windowIndex`) to avoid tmux
// ambiguity (see lib/list.ts for the rationale).
//
// Safety:
//   - Target resolved by safety.resolveTarget BEFORE send.
//   - Text length capped at MAX_TEXT_BYTES (4 KB) to prevent floods.
//   - send-keys with literal text uses `-l` to suppress key-name parsing.
import type { TmuxExecutor } from "./exec.ts";
import { TMUX_INVOCATION_TIMEOUT_MS, MAX_TEXT_BYTES } from "./constants.ts";

export interface SendTarget {
	sessionName: string;
	windowIndex: string;
}

export interface SendResult {
	ok: boolean;
	sentBytes?: number;
	error?: string;
}

export async function sendText(
	executor: TmuxExecutor,
	socketPrefix: string[],
	target: SendTarget,
	text: string,
	opts?: { pressEnter?: boolean },
): Promise<SendResult> {
	if (typeof text !== "string") return { ok: false, error: "text must be a string" };
	if (text.length > MAX_TEXT_BYTES) {
		return { ok: false, error: `text too long: ${text.length} bytes (max ${MAX_TEXT_BYTES})` };
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