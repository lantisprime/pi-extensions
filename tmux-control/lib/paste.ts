// tmux-control: paste text via bracketed paste (P5c-2-S1).
//
// Problem: `send-keys -l` of text containing '\n' fires Enter on every newline,
// causing premature submission of multi-line prompts (the #1 failure mode of v0.1).
//
// Solution: deliver text via `set-buffer` + `paste-buffer -p` (bracketed paste)
// as ONE paste event. The TUI receives the entire text — including any '\n' —
// as a single bracketed-paste payload and decides how to interpret the newlines
// (e.g. a TUI prompt inserts a literal newline in the input; a shell waits for
// the user to press Enter explicitly).
//
// Argv-only: text reaches tmux as a single argv element of `set-buffer` (never
// a shell string, never split). Uses `--` options-terminator so leading-dash
// text like "-X" is delivered verbatim (REQ-2).
//
// Buffer cleanup: paste-buffer -d deletes the buffer on success. On paste
// failure we issue a best-effort delete-buffer so no orphan buffer is left
// behind (REQ-4).
//
// pressEnter threading: optional, default true. When true, fires
// `pressEnterCount` (default 1, clamped 0..MAX_ENTER_COUNT) separate
// send-keys Enter invocations AFTER the paste (S3 seam).
import type { TmuxExecutor } from "./exec.ts";
import {
	TMUX_INVOCATION_TIMEOUT_MS,
	MAX_TEXT_BYTES,
	PASTE_BUFFER_NAME,
	MAX_ENTER_COUNT,
	BRACKET_START,
	BRACKET_END,
} from "./constants.ts";

export interface PasteTarget {
	sessionName: string;
	windowIndex: string;
}

export interface PasteResult {
	ok: boolean;
	sentBytes?: number;
	error?: string;
}

export interface PasteOpts {
	/** Send Enter after paste (default true). */
	pressEnter?: boolean;
	/** Number of separate Enter invocations (default 1, clamped 0..MAX_ENTER_COUNT). S3 seam. */
	pressEnterCount?: number;
}

/** Best-effort delete-buffer; swallows errors. Used for failure-path cleanup (REQ-4). */
async function tryDeleteBuffer(executor: TmuxExecutor, socketPrefix: string[]): Promise<void> {
	try {
		await executor.exec(
			[...socketPrefix, "delete-buffer", "-b", PASTE_BUFFER_NAME],
			{ timeoutMs: TMUX_INVOCATION_TIMEOUT_MS },
		);
	} catch {
		// best-effort; swallow
	}
}

/**
 * Deliver `text` as a single bracketed-paste event to a tmux window.
 *
 * Steps:
 *   1. set-buffer -b <PASTE_BUFFER_NAME> -- <text>
 *   2. paste-buffer -b <PASTE_BUFFER_NAME> -d -t <session:window> -p
 *      (-d deletes the buffer; -p = bracketed paste; -r omitted so tmux's
 *       default LF→CR separator replacement applies)
 *   3. (failure path only) best-effort delete-buffer
 *   4. (if pressEnter) N separate send-keys Enter invocations
 */
export async function pasteText(
	executor: TmuxExecutor,
	socketPrefix: string[],
	target: PasteTarget,
	text: string,
	opts?: PasteOpts,
): Promise<PasteResult> {
	if (typeof text !== "string") return { ok: false, error: "text must be a string" };
	if (text.length === 0) return { ok: false, error: "text is empty" };
	if (text.length > MAX_TEXT_BYTES) {
		return { ok: false, error: `text too long: ${text.length} bytes (max ${MAX_TEXT_BYTES})` };
	}
	// REQ-20: reject payloads containing literal bracketed-paste markers. tmux
	// passes them through verbatim, so an embedded \e[201~ would close the
	// bracket early (bytes after it processed as typed input → premature submit)
	// and an embedded \e[200~ would open a nested one. We REJECT rather than
	// silently strip: a prompt bound for an agent should never be mutated behind
	// the caller's back, and a raw ESC byte never appears in legitimate text —
	// so this is defense against pathological/crafted input with ~zero false
	// positives. Caller strips control bytes if it genuinely needs to send them.
	if (text.includes(BRACKET_START) || text.includes(BRACKET_END)) {
		return {
			ok: false,
			error: "text contains an embedded bracketed-paste marker (\\e[200~ or \\e[201~); strip control bytes before paste",
		};
	}

	const t = `${target.sessionName}:${target.windowIndex}`;
	const pressEnter = opts?.pressEnter !== false;
	// Clamp to 0..MAX_ENTER_COUNT. NaN-safe: NaN > 0 is false, so the Enter loop
	// is skipped entirely (fail-safe — never fires an unbounded number of Enters).
	const pressEnterCount = Math.min(Math.max(opts?.pressEnterCount ?? 1, 0), MAX_ENTER_COUNT);

	// Step 1: set-buffer with `--` options terminator so leading-dash text
	// is delivered verbatim (REQ-2, OD-1).
	const setArgs = [...socketPrefix, "set-buffer", "-b", PASTE_BUFFER_NAME, "--", text];
	const setR = await executor.exec(setArgs, { timeoutMs: TMUX_INVOCATION_TIMEOUT_MS });
	if (!setR.ok) {
		return { ok: false, error: setR.stderr || `set-buffer failed (exit ${setR.exitCode})` };
	}

	// Step 2: paste-buffer -d -p (paste + delete in one call).
	// `-p` is bracketed paste; `-d` deletes the buffer. `-r` is intentionally
	// omitted: tmux's default behavior replaces interior LF with the default
	// separator CR, which is exactly what real terminals send inside a
	// bracketed paste, so the TUI ingests the whole text as one paste event
	// (interior CRs do not submit) — REQ-1.
	const pasteArgs = [...socketPrefix, "paste-buffer", "-b", PASTE_BUFFER_NAME, "-d", "-t", t, "-p"];
	const pasteR = await executor.exec(pasteArgs, { timeoutMs: TMUX_INVOCATION_TIMEOUT_MS });
	if (!pasteR.ok) {
		// Step 3a (failure path): set-buffer succeeded but paste failed; clean up orphan.
		await tryDeleteBuffer(executor, socketPrefix);
		return { ok: false, error: pasteR.stderr || `paste-buffer failed (exit ${pasteR.exitCode})` };
	}

	// Step 4: optional Enter invocations.
	if (pressEnter && pressEnterCount > 0) {
		for (let i = 0; i < pressEnterCount; i++) {
			const r = await executor.exec(
				[...socketPrefix, "send-keys", "-t", t, "Enter"],
				{ timeoutMs: TMUX_INVOCATION_TIMEOUT_MS },
			);
			if (!r.ok) {
				return { ok: false, error: `text pasted but Enter failed: ${r.stderr || `exit ${r.exitCode}`}` };
			}
		}
	}

	return { ok: true, sentBytes: text.length };
}