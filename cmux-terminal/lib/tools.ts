// P5b-1-S4: cmux-flavored tool layer (cmuxPaste / cmuxWaitFor / cmuxSendKeys).
//
// Mirrors tmux-control/lib/{paste,wait,send}.ts 1:1 with the cmux CLI swap:
//   - paste  → tmux's set-buffer/paste-buffer is replaced by `cmux send --surface <ref> <text>`
//              (single argv-only call; text is shell-escaped so metachars are inert
//              in the receiving terminal's shell).
//   - wait   → tmux's capture-pane is replaced by `cmux read-screen --surface <ref> --lines <n>`
//              (one exec per poll; never a long exec — REQ-8).
//   - send   → tmux's send-keys is replaced by `cmux send-key --surface <ref> <token>`
//              (per token in keys mode) or `cmux send --surface <ref> <text>`
//              (literal mode, one chunk).
//
// All text is delivered via execFile (argv-only, no shell). The shell-escape
// applies to the text payload so the receiving terminal's shell can safely
// receive metachars (e.g., `;`, `|`, `'`). The cmux CLI's `cmux send` accepts
// a text payload that the receiving terminal's shell will interpret as input
// — so escaping is the only safe route for arbitrary text. This mirrors the
// cmux-backend.ts pattern for the `workspace create --command` payload
// (workerPath + manifestPath shell-escaped so cmux's shell-string handling
// can't inject tokens).
//
// cmux 0.64.17 CLI surface used here (validated by S2.5 spike at
// cmux-terminal/docs/cli-spike-output.txt):
//   - `cmux send --surface <ref> <text>`           — literal text payload
//                                                  (paste + literal-mode send)
//   - `cmux send-key --surface <ref> <token>`      — single key token
//                                                  (Enter, C-c, Up, ...)
//   - `cmux read-screen --surface <ref> --lines N` — capture N lines from the
//                                                  surface's screen
//
// The tools are independent of the bg backend (they target cmux surfaces
// directly via the cmux CLI). They do NOT register as a TermBgBackend — that
// is the role of `cmux-terminal/lib/cmux-backend.ts`. The `cmuxTerminalTools`
// factory in `cmux-terminal/index.ts` binds these to an executor for the
// extension-wiring pattern (REQ-T5).
import type { CmuxExecutor } from "./exec.ts";
import { CMUX_INVOCATION_TIMEOUT_MS } from "./constants.ts";
import { shellEscape } from "./shell-escape.ts";

/** Defensive cap on paste / send text size (matches tmux-control MAX_TEXT_BYTES). */
const MAX_TEXT_BYTES = 4_000;
/** Default capture depth for cmuxWaitFor. Tighter than the full scrollback so
 *  a small terminal prompt area is captured quickly (mirrors tmux-control
 *  DEFAULT_WAIT_LINES). */
const DEFAULT_WAIT_LINES = 50;
/** Default poll cadence for cmuxWaitFor. Each capture is a separate exec
 *  bounded by CMUX_INVOCATION_TIMEOUT_MS; the long wait is achieved by
 *  polling, never one long exec (REQ-8 / tmux-control wait.ts contract). */
const DEFAULT_WAIT_INTERVAL_MS = 1_000;

// ─── paste ──────────────────────────────────────────────────────────────

export interface PasteOpts {
	/** cmux surface ref, e.g. "surface:11" — the value cmux's `workspace list`
	 *  returns as `ref` (NOT the title). Matches what cmuxTerminalTools'
	 *  callers will have from `cmux workspace list --json`. */
	window: string;
	/** Literal text payload. cmux 0.64.17's `send` handles interior LFs as
	 *  part of the payload (verified by S2.5 spike for both single-line and
	 *  multi-line text). */
	text: string;
	/** Send Enter after paste (default true). Uses a separate
	 *  `cmux send-key --surface <ref> enter` invocation. */
	pressEnter?: boolean;
}

export type PasteResult =
	| { ok: true; sentBytes: number; routedViaPaste: boolean }
	| { ok: false; error: string };

/**
 * Deliver `text` as a single paste event to a cmux surface.
 *
 * Steps:
 *   1. `cmux send --surface <ref> <shell-escaped text>` (single exec; the
 *      shell-escape keeps the receiving terminal's shell from interpreting
 *      metachars like `;`, `|`, `'`).
 *   2. (if pressEnter) `cmux send-key --surface <ref> enter` (separate exec).
 *
 * Mirror notes vs. tmux-control/lib/paste.ts:
 *   - No `set-buffer`/`paste-buffer -p` dance: cmux has no buffer concept, and
 *     `cmux send` already delivers the entire payload as one event (verified
 *     by S2.5 spike for both single-line and multi-line payloads).
 *   - No `BRACKET_START/END` rejection: cmux has no analog of tmux's
 *     bracketed-paste markers — the receiving TUI/shell receives the typed
 *     bytes verbatim (modulo the shell-escape that wraps the payload).
 *   - The `routedViaPaste` field is always `false` in this implementation:
 *     we always use a single `cmux send` call. The S2.5 multi-line
 *     `$(cat prompt)` pattern is an orchestrator-level concern (handled by
 *     the cmux-orchestrator skill), not a tool concern.
 *
 * Shell-escape rationale: the cmux CLI's `send` types its text arg into the
 * receiving terminal's input, where the shell (or a TUI's input parser)
 * interprets metachars. Wrapping the text in single quotes ensures the
 * receiving parser treats the payload as a single literal token. Mirrors the
 * cmux-backend.ts pattern for `workspace create --command <shell-string>`.
 */
export async function cmuxPaste(
	executor: CmuxExecutor,
	opts: PasteOpts,
): Promise<PasteResult> {
	if (typeof opts.text !== "string") return { ok: false, error: "text must be a string" };
	if (opts.text.length === 0) return { ok: false, error: "text is empty" };
	if (opts.text.length > MAX_TEXT_BYTES) {
		return { ok: false, error: `text too long: ${opts.text.length} bytes (max ${MAX_TEXT_BYTES})` };
	}

	// Shell-escape the text payload. The argv-only execFile path means cmux
	// receives the shell-escaped form VERBATIM; the receiving terminal's
	// shell strips the wrapping quotes and sees the original text.
	const sendArgs = ["send", "--surface", opts.window, shellEscape(opts.text)];
	const sendR = await executor.exec(sendArgs, { timeoutMs: CMUX_INVOCATION_TIMEOUT_MS });
	if (!sendR.ok) {
		return { ok: false, error: sendR.stderr || `cmux send failed (exit ${sendR.exitCode})` };
	}

	const pressEnter = opts.pressEnter !== false;
	if (pressEnter) {
		const enterArgs = ["send-key", "--surface", opts.window, "enter"];
		const enterR = await executor.exec(enterArgs, { timeoutMs: CMUX_INVOCATION_TIMEOUT_MS });
		if (!enterR.ok) {
			return { ok: false, error: `text sent but Enter failed: ${enterR.stderr || `exit ${enterR.exitCode}`}` };
		}
	}

	return { ok: true, sentBytes: opts.text.length, routedViaPaste: false };
}

// ─── wait ───────────────────────────────────────────────────────────────

export interface WaitOpts {
	/** cmux surface ref, e.g. "surface:11". */
	window: string;
	/** Regex (RegExp) or pattern (string) matched against the captured screen
	 *  output. Returns `matched:true` on first hit. A string is compiled via
	 *  `new RegExp(str)` — caller is responsible for escaping regex special
	 *  chars (or passing a `RegExp` literal for patterns containing `|`,
	 *  `[`, `*`, etc.). */
	regex?: string | RegExp;
	/** Idle window in ms — return `matched:true` once the captured output is
	 *  unchanged for ≥ `stableMs`. Stability window starts at the FIRST
	 *  REPEAT (the second consecutive capture with the same output), NOT on
	 *  the initial capture. So a stable-from-start output requires at least
	 *  2 captures AND `now - lastChangeAt ≥ stableMs` before triggering. */
	stableMs?: number;
	/** REQUIRED hard cap in ms. Polling stops once `elapsed ≥ timeoutMs`;
	 *  result is `{ok:false, error:"timeout"}`. Throws TypeError if
	 *  non-positive or non-finite (programmer error). */
	timeoutMs: number;
	/** Capture depth in lines (from end of scrollback). Default
	 *  `DEFAULT_WAIT_LINES` (50). */
	lines?: number;
}

/** Test seam: inject `sleep` / `now` so unit tests run without real time.
 *  Both default to `setTimeout` / `Date.now` in production. */
export interface WaitDeps {
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

export type WaitResult =
	| { ok: true; matched: true; output: string; iterations: number }
	| { ok: false; error: string };

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const realNow = (): number => Date.now();

/**
 * Normalize `opts.regex` into a fresh, non-stateful RegExp compiled ONCE
 * before the polling loop. Mirrors tmux-control/lib/wait.ts `compileRegex`:
 *   - `undefined` → `undefined` (no regex check).
 *   - `RegExp`    → always copy via `new RegExp(source, flags)`. This avoids
 *                   `lastIndex` leakage when the caller passes a global/sticky
 *                   regex and reuses it (e.g. `/READY/g` with nonzero
 *                   `lastIndex` would otherwise skip past earlier matches).
 *   - `string`    → compile via `new RegExp(str)`. A malformed pattern
 *                   throws native `SyntaxError` HERE (before any cmux call)
 *                   so the caller sees the error eagerly.
 */
function compileRegex(regex: string | RegExp | undefined): RegExp | undefined {
	if (regex === undefined) return undefined;
	if (regex instanceof RegExp) {
		return new RegExp(regex.source, regex.flags);
	}
	return new RegExp(regex);
}

/**
 * Poll a cmux surface until a regex matches, the output becomes stable, or
 * the timeout fires. Each capture is a separate `cmux read-screen` exec
 * bounded by `CMUX_INVOCATION_TIMEOUT_MS` (10s); the long wait is achieved by
 * polling, never one long exec (REQ-8, mirrors tmux-control/lib/wait.ts).
 *
 * Regex behavior: identical to tmux-control. Caller-provided RegExp instances
 * are always copied via `new RegExp(source, flags)` to avoid `lastIndex`
 * mutation on reuse. A malformed string pattern throws SyntaxError eagerly
 * before any cmux call.
 *
 * Stable behavior: `lastChangeAt` is `null` until the FIRST REPEAT of any
 * run of consecutive same-output captures — i.e., the second capture after
 * the initial capture, OR the second capture after any observed change. At
 * the first repeat, `lastChangeAt` is set to `now()` and the stability
 * window begins counting FROM that point — not from `startMs` and not from
 * the first capture of a new run. On any change, `lastChangeAt` is RESET to
 * `null` so the next same-output capture re-arms the window as a fresh
 * first repeat. This enforces "not on first repeat" (tmux-control EC4): a
 * stable run requires ≥ 2 captures AND `now - lastChangeAt ≥ stableMs`
 * before `matched:true` is returned — regardless of whether the run started
 * at function entry or after an intervening change.
 *
 * Capture-error behavior: ANY `read-screen` failure (including the 10s
 * exec-timeout, "surface not found", etc.) is **immediately fatal** for
 * the whole wait. No retry budget. This is intentional for S4 simplicity —
 * mirrors tmux-control's wait.ts S2 contract.
 *
 * Precedence: regex > stable > sleep > timeout. A regex hit on the same
 * capture that would otherwise trigger stable returns `matched:true`.
 *
 * @throws TypeError if `timeoutMs` is non-finite or non-positive.
 * @throws SyntaxError if `opts.regex` is a malformed string pattern
 *         (raised during pre-loop validation, before any cmux call).
 */
export async function cmuxWaitFor(
	executor: CmuxExecutor,
	opts: WaitOpts,
	deps?: WaitDeps,
): Promise<WaitResult> {
	if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
		throw new TypeError(`timeoutMs must be a positive finite number, got ${opts.timeoutMs}`);
	}
	const lines = opts.lines ?? DEFAULT_WAIT_LINES;
	const sleep = deps?.sleep ?? realSleep;
	const now = deps?.now ?? realNow;

	// Compile (and validate) the regex ONCE before the loop. Throws
	// SyntaxError eagerly if the pattern is malformed; copies RegExp
	// instances to avoid stateful `lastIndex` issues on reuse.
	const regex = compileRegex(opts.regex);

	const startMs = now();
	let iterations = 0;
	let prev: string | undefined;
	// `null` until the FIRST REPEAT (second consecutive same-output capture).
	// Stability window counts from there, NOT from startMs or first capture.
	let lastChangeAt: number | null = null;

	while (now() - startMs < opts.timeoutMs) {
		const captureArgs = ["read-screen", "--surface", opts.window, "--lines", String(lines)];
		const result = await executor.exec(captureArgs, { timeoutMs: CMUX_INVOCATION_TIMEOUT_MS });
		iterations++;
		if (!result.ok) {
			return { ok: false, error: result.stderr || `cmux read-screen failed (exit ${result.exitCode})` };
		}
		const output = result.stdout ?? "";

		// Regex check (takes precedence over stable).
		if (regex !== undefined && regex.test(output)) {
			return { ok: true, matched: true, output, iterations };
		}

		// Stable check (only after at least one previous capture exists).
		// Three branches enforce "not on first repeat" per run (mirrors
		// tmux-control/lib/wait.ts):
		//   1. output !== prev   -> CHANGE; reset lastChangeAt to null so
		//                            the next same-output capture re-arms as
		//                            a fresh first repeat.
		//   2. lastChangeAt === null -> FIRST REPEAT of this run; start the
		//                               stability window at NOW.
		//   3. (else) SECOND+ REPEAT; check now - lastChangeAt >= stableMs.
		if (prev !== undefined && opts.stableMs !== undefined) {
			if (output !== prev) {
				lastChangeAt = null;
			} else if (lastChangeAt === null) {
				lastChangeAt = now();
			} else if (now() - lastChangeAt >= opts.stableMs) {
				return { ok: true, matched: true, output, iterations };
			}
		}

		prev = output;
		await sleep(DEFAULT_WAIT_INTERVAL_MS);
	}

	return { ok: false, error: "timeout" };
}

// ─── send ───────────────────────────────────────────────────────────────

export type SendMode = "literal" | "keys";

export interface SendOpts {
	/** cmux surface ref, e.g. "surface:11". */
	window: string;
	/** Payload text. In `literal` mode (default): sent as one chunk via
	 *  `cmux send --surface <ref> <text>`. In `keys` mode: split on
	 *  whitespace, each token sent via `cmux send-key --surface <ref> <token>`. */
	text: string;
	/** "literal" (default) or "keys". Keys mode sends each
	 *  whitespace-separated token as a separate `cmux send-key` invocation;
	 *  literal mode sends the whole string as one `cmux send` call. */
	mode?: SendMode;
	/** Send Enter after text. Default in literal: true. Default in keys:
	 *  false (caller appends "Enter" as a final token if they want it —
	 *  mirrors tmux-control keys mode S5 semantics). */
	pressEnter?: boolean;
}

export type SendResult =
	| { ok: true; sentKeys: string[]; pressEnter: boolean }
	| { ok: false; error: string };

/**
 * Send text to a cmux surface in `literal` or `keys` mode.
 *
 * Literal mode (default): one `cmux send --surface <ref> <shell-escaped
 * text>` exec, plus (if pressEnter) a separate `cmux send-key --surface
 * <ref> enter` exec. The text is shell-escaped (same as cmuxPaste) so the
 * receiving terminal's shell treats metachars as literal.
 *
 * Keys mode: each whitespace-separated token in `text` is a separate
 * `cmux send-key --surface <ref> <token>` exec. pressEnter defaults to
 * `false` (caller appends "Enter" as a final token if needed). Tokens are
 * passed verbatim — no shell-escape, since `cmux send-key` interprets
 * tokens as key names (Enter, C-c, Up, ...) not shell payloads.
 *
 * Mirror notes vs. tmux-control/lib/send.ts:
 *   - No multi-line routing: cmux's `cmux send` handles interior LFs as
 *     part of the payload (S2.5 spike verified this for both single-line
 *     and multi-line text). tmux's `send-keys -l` would fire Enter on
 *     every '\n'; cmux's `send` does not, so no analog of tmux's
 *     "multi-line routes through pasteText" seam is needed.
 *   - The literal path uses `cmux send` (which expects a shell-string
 *     payload that the receiving terminal interprets) — we shell-escape
 *     the text. The keys path uses `cmux send-key` (which expects a
 *     key-name token, like tmux's `send-keys C-c`) — we pass the token
 *     as-is.
 */
export async function cmuxSendKeys(
	executor: CmuxExecutor,
	opts: SendOpts,
): Promise<SendResult> {
	if (typeof opts.text !== "string") return { ok: false, error: "text must be a string" };
	if (opts.text.length > MAX_TEXT_BYTES) {
		return { ok: false, error: `text too long: ${opts.text.length} bytes (max ${MAX_TEXT_BYTES})` };
	}

	const mode: SendMode = opts.mode ?? "literal";

	if (mode === "keys") {
		const tokens = opts.text.split(/\s+/).filter((tok) => tok.length > 0);
		if (tokens.length === 0) {
			return { ok: false, error: "keys mode requires at least one key token" };
		}
		for (const token of tokens) {
			const args = ["send-key", "--surface", opts.window, token];
			const r = await executor.exec(args, { timeoutMs: CMUX_INVOCATION_TIMEOUT_MS });
			if (!r.ok) {
				return { ok: false, error: r.stderr || `cmux send-key failed (exit ${r.exitCode})` };
			}
		}
		// pressEnter in keys mode defaults to false: caller appends "Enter"
		// as a token if they want it (mirrors tmux-control/lib/send.ts
		// S5 keys-mode semantics — no implicit trailing Enter).
		const pressEnter = opts.pressEnter === true;
		if (pressEnter) {
			const enterArgs = ["send-key", "--surface", opts.window, "enter"];
			const r = await executor.exec(enterArgs, { timeoutMs: CMUX_INVOCATION_TIMEOUT_MS });
			if (!r.ok) {
				return { ok: false, error: `keys sent but Enter failed: ${r.stderr || `exit ${r.exitCode}`}` };
			}
		}
		return { ok: true, sentKeys: tokens, pressEnter };
	}

	// Literal mode: one `cmux send --surface <ref> <text>` call, plus
	// (if pressEnter, default true) a separate `cmux send-key ... enter`.
	// The text is shell-escaped (same rationale as cmuxPaste).
	const pressEnter = opts.pressEnter !== false;
	const sendArgs = ["send", "--surface", opts.window, shellEscape(opts.text)];
	const r = await executor.exec(sendArgs, { timeoutMs: CMUX_INVOCATION_TIMEOUT_MS });
	if (!r.ok) {
		return { ok: false, error: r.stderr || `cmux send failed (exit ${r.exitCode})` };
	}
	if (pressEnter) {
		const enterArgs = ["send-key", "--surface", opts.window, "enter"];
		const enterR = await executor.exec(enterArgs, { timeoutMs: CMUX_INVOCATION_TIMEOUT_MS });
		if (!enterR.ok) {
			return { ok: false, error: `text sent but Enter failed: ${enterR.stderr || `exit ${enterR.exitCode}`}` };
		}
	}
	// sentKeys reports the single chunk that was sent in literal mode (the
	// text itself), so callers can introspect what was delivered. An empty
	// array would lose the "what was typed" information.
	return { ok: true, sentKeys: [opts.text], pressEnter };
}
