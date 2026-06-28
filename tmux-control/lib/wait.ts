// tmux-control: poll a tmux window until a regex matches, the output becomes
// stable, or a timeout fires (P5c-2-S2).
//
// Designed for "drive a TUI and wait for it to finish" workflows (used directly
// by callers today, and composed into tmux_drive_claude in P5c-2-S6):
//
//   await waitForWindow(ex, sock, {sessionName, windowIndex},
//                       { regex: /❯/, timeoutMs: 30000, intervalMs: 1000 });
//   await waitForWindow(ex, sock, {sessionName, windowIndex},
//                       { stableMs: 2000, timeoutMs: 120000 });
//
// Both forms honor the same hard `timeoutMs` via SHORT POLLING: each capture
// is a separate `capture-pane` exec bounded by `TMUX_INVOCATION_TIMEOUT_MS`
// (5s). The long wait is achieved by polling — never by one long exec —
// satisfying REQ-8 (the "polling, not long execs" invariant).
//
// Determinism: `deps.sleep` / `deps.now` are injectable so unit tests can run
// without real time. Default deps are `setTimeout` + `Date.now`. The fake
// `now` / `sleep` pair in tests typically advances `time` only on `sleep`,
// so successive captures within one synchronous block see the same `now`
// (avoids accidental stable triggers).
import type { TmuxExecutor } from "./exec.ts";
import { captureWindow } from "./capture.ts";
import {
	DEFAULT_WAIT_INTERVAL_MS,
	DEFAULT_WAIT_LINES,
} from "./constants.ts";

export type WaitResult =
	| { ok: true;  matched: "regex" | "stable"; output: string; elapsedMs: number; polls: number }
	| { ok: false; reason: "timeout" | "capture-error"; output?: string; error?: string; elapsedMs: number; polls: number };

export interface WaitOpts {
	/** Regex (RegExp) or pattern (string) matched against the captured pane output.
	 *  Returns `matched:"regex"` on first hit. String is compiled via `new RegExp`
	 *  — caller is responsible for escaping regex special chars (or pass a
	 *  `RegExp` literal for patterns containing `|`, `[`, `*`, etc.). */
	regex?: string | RegExp;
	/** Idle window in ms — return `matched:"stable"` once the captured output is
	 *  unchanged for ≥ `stableMs`. Stability window starts at the FIRST REPEAT
	 *  (the second consecutive capture with the same output), NOT on the
	 *  initial capture — so a stable-from-start output requires at least 2
	 *  captures AND `now - lastChangeAt ≥ stableMs` before triggering. */
	stableMs?: number;
	/** REQUIRED hard cap in ms. Polling stops once `elapsed ≥ timeoutMs`; result
	 *  is `{ok:false, reason:"timeout"}`. Throws TypeError if non-positive
	 *  or non-finite (programmer error). */
	timeoutMs: number;
	/** Poll cadence in ms. Default `DEFAULT_WAIT_INTERVAL_MS` (1000).
	 *  Throws TypeError if non-positive or non-finite. */
	intervalMs?: number;
	/** Capture depth in lines (from end of scrollback). Default
	 *  `DEFAULT_WAIT_LINES` (50). Clamped to captureWindow's
	 *  `[1, MAX_CAPTURE_LINES]` bounds. */
	lines?: number;
}

/** Test seam: inject `sleep` / `now` so unit tests run without real time.
 *  Both default to `setTimeout` / `Date.now` in production. */
export interface WaitDeps {
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const realNow = (): number => Date.now();

/**
 * Normalize `opts.regex` into a fresh, non-stateful RegExp compiled ONCE
 * before the polling loop. Three behaviors:
 *   - `undefined` → `undefined` (no regex check).
 *   - `RegExp`    → always copy via `new RegExp(source, flags)`. This avoids
 *                   `lastIndex` leakage when the caller passes a global/sticky
 *                   regex and reuses it (e.g. `/READY/g` with nonzero
 *                   `lastIndex` would otherwise skip past earlier matches).
 *   - `string`    → compile via `new RegExp(str)`. A malformed pattern throws
 *                   native `SyntaxError` HERE (before any tmux call) so the
 *                   caller sees the error eagerly.
 *
 * Returning a fresh RegExp each invocation means caller-owned state
 * (e.g., `lastIndex` on a reused `/g` or `/y` regex) cannot leak into or
 * be observed by this call — the local regex is owned by this invocation.
 */
function compileRegex(regex: string | RegExp | undefined): RegExp | undefined {
	if (regex === undefined) return undefined;
	if (regex instanceof RegExp) {
		return new RegExp(regex.source, regex.flags);
	}
	return new RegExp(regex);
}

/**
 * Poll a tmux window until a regex matches, the output becomes stable, or the
 * timeout fires. Each capture is a separate `capture-pane` exec bounded by
 * `TMUX_INVOCATION_TIMEOUT_MS` (5s); the long wait is achieved by polling,
 * never one long exec (REQ-8).
 *
 * Regex behavior: a `string` is compiled via `new RegExp(str)` ONCE before the
 * loop; a malformed pattern throws native `SyntaxError` before any tmux call.
 * Caller-provided `RegExp` instances are always copied via
 * `new RegExp(source, flags)` to avoid `lastIndex` mutation on reuse
 * (relevant for `/g` and `/y` flags).
 *
 * Stable behavior: `lastChangeAt` is `null` until the FIRST REPEAT of any
 * run of consecutive same-output captures — i.e., the second capture after
 * the initial capture, OR the second capture after any observed change. At
 * the first repeat, `lastChangeAt` is set to `now()` and the stability window
 * begins counting FROM that point — not from `startMs` and not from the
 * first capture of a new run. On any change, `lastChangeAt` is RESET to
 * `null` so the next same-output capture re-arms the window as a fresh
 * first repeat. This enforces "not on first repeat" (AC3, EC4): a stable
 * run requires ≥ 2 captures AND `now - lastChangeAt ≥ stableMs` before
 * `matched:"stable"` is returned — regardless of whether the run started at
 * function entry or after an intervening change.
 *
 * Capture-error behavior: ANY `capture-pane` failure (including the 5s
 * exec-timeout, "can't find pane", etc.) is **immediately fatal** for the
 * whole wait. No retry budget. This is intentional for S2 simplicity —
 * adding retry semantics introduces policy questions (which errors are
 * transient, how long to retry, whether retries count against the poll
 * budget, how timeout precedence interacts). S6 may revisit if
 * `tmux_drive_claude` needs to distinguish transient vs fatal.
 *
 * Precedence: regex > stable > sleep > timeout. A regex hit on the same
 * capture that would otherwise trigger stable returns `matched:"regex"`.
 *
 * @throws TypeError if `timeoutMs` or `intervalMs` is non-finite or non-positive.
 * @throws SyntaxError if `opts.regex` is a malformed string pattern
 *         (raised during pre-loop validation, before any tmux call).
 */
export async function waitForWindow(
	executor: TmuxExecutor,
	socketPrefix: string[],
	target: { sessionName: string; windowIndex: string },
	opts: WaitOpts,
	deps?: WaitDeps,
): Promise<WaitResult> {
	if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
		throw new TypeError(`timeoutMs must be a positive finite number, got ${opts.timeoutMs}`);
	}
	const intervalMs = opts.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
	if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
		throw new TypeError(`intervalMs must be a positive finite number, got ${intervalMs}`);
	}
	const sleep = deps?.sleep ?? realSleep;
	const now = deps?.now ?? realNow;
	const lines = opts.lines ?? DEFAULT_WAIT_LINES;

	// Compile (and validate) the regex ONCE before the loop. Throws
	// SyntaxError eagerly if the pattern is malformed; copies RegExp
	// instances to avoid stateful `lastIndex` issues on reuse.
	const regex = compileRegex(opts.regex);

	const startMs = now();
	let polls = 0;
	let prev: string | undefined;
	// `null` until the FIRST REPEAT (second consecutive same-output capture).
	// Stability window counts from there, NOT from startMs or first capture.
	let lastChangeAt: number | null = null;

	while (now() - startMs < opts.timeoutMs) {
		const out = await captureWindow(executor, socketPrefix, target, { lines });
		polls++;
		if (!out.ok) {
			return {
				ok: false,
				reason: "capture-error",
				error: out.error,
				elapsedMs: now() - startMs,
				polls,
			};
		}
		const output = out.output ?? "";

		// Regex check (takes precedence over stable per plan flow).
		if (regex !== undefined && regex.test(output)) {
			return {
				ok: true,
				matched: "regex",
				output,
				elapsedMs: now() - startMs,
				polls,
			};
		}

		// Stable check (only after at least one previous capture exists).
		// Three branches enforce "not on first repeat" per run:
		//   1. output !== prev   -> CHANGE; reset lastChangeAt to null so the
		//                            next same-output capture re-arms as a
		//                            fresh first repeat.
		//   2. lastChangeAt === null -> FIRST REPEAT of this run; start the
		//                               stability window at NOW.
		//   3. (else) SECOND+ REPEAT; check now - lastChangeAt >= stableMs.
		if (prev !== undefined && opts.stableMs !== undefined) {
			if (output !== prev) {
				lastChangeAt = null;
			} else if (lastChangeAt === null) {
				lastChangeAt = now();
			} else if (now() - lastChangeAt >= opts.stableMs) {
				return {
					ok: true,
					matched: "stable",
					output,
					elapsedMs: now() - startMs,
					polls,
				};
			}
		}

		prev = output;
		await sleep(intervalMs);
	}

	return {
		ok: false,
		reason: "timeout",
		output: prev,
		elapsedMs: now() - startMs,
		polls,
	};
}
