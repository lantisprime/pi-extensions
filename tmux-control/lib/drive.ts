// tmux-control: driveClaude orchestrator (P5c-2-S6).
//
// Composes S1 (pasteText) + S2 (waitForWindow) primitives into a one-call
// "ask claude and read the answer" recipe. This is the LLM-callable composite
// that exposes the whole "drive a TUI to completion" workflow as a single
// tool invocation — so an LLM agent can prompt a claude/codex session running
// in a tmux window, wait for it to finish, and read back the response.
//
// Phases (in order, short-circuit on first failure):
//   0. resolve   — resolveTarget validates the identifier against the
//                   prefix-gated window list. PURE (no tmux call) so a
//                   bad identifier returns immediately with phase:"resolve"
//                   and 0 tmux invocations.
//   1. ready     — waitForWindow polls for readyRegex (default "❯"). The
//                   regex match means the TUI is idle and ready for input.
//                   Timeout yields phase:"ready" without firing the paste.
//   2. paste     — pasteText delivers the prompt as ONE bracketed-paste event
//                   (REQ-1, REQ-18) so multi-line prompts arrive intact.
//                   Uses pasteText (not sendText) to avoid the S1 routing
//                   ambiguity — drive always wants the paste path.
//   3. done      — waitForWindow polls for a STABILITY signal by default:
//                   output must be unchanged for `doneStableMs` (2000ms).
//                   The previous regex-based default ("Cooked for|Baked for|✻")
//                   had two correctness bugs flagged by codex review:
//                     a) Stale match — a prior "Cooked for 5s" line in
//                        scrollback matches before the new prompt starts.
//                     b) Streaming ✻ — the spinner glyph appears while the
//                        TUI is still working; regex would match on the
//                        first poll while the answer is incomplete.
//                   Callers can opt BACK INTO regex-based detection by
//                   passing `doneRegex` (any non-empty string). When opt-in
//                   is used, the orchestrator accepts the documented
//                   hazards and trades them for a single-poll trigger.
//                   Timeout yields phase:"done" WITH partial output so the
//                   caller can inspect whatever the TUI produced before
//                   the orchestrator gave up.
//   4. capture   — captureWindow snapshots the final pane state. Returned
//                   verbatim as the LLM's tool result text.
//
// S6 design note (from S1 commit): MUST buffer across stdin reads.
// The composite uses pasteText (S1) which delivers the entire prompt as a
// single bracketed-paste event. This is correct — no additional stdin
// buffering is needed at the S6 layer because the per-slice primitives
// already handle it. Path A marker tests prove that the bracketed-paste
// payload survives tmux's read fragmentation.
//
// Threading: opts are defaulted once at the top so each primitive call site
// stays readable. pressEnterCount defaults to 1 (pasteText's default) —
// drive always wants a trailing Enter, since "ask claude" without submit
// would just sit there. The `phase` discriminator in the result mirrors
// the existing tmux-tool result shapes (tmux_capture / tmux_send) so the
// LLM's tool-result handler doesn't need a special case.
//
// Failure isolation: each phase catches its own error and bails with a
// phase-specific result. Partial output (when available) is returned on
// phase:"done" timeout because that's the most useful state for recovery
// — the paste succeeded but the TUI didn't finish in time, so the
// caller's best option is to read whatever was produced and either retry
// or move on.
import type { TmuxExecutor } from "./exec.ts";
import { pasteText } from "./paste.ts";
import { waitForWindow } from "./wait.ts";
import { captureWindow } from "./capture.ts";
import { resolveTarget } from "./safety.ts";
import type { ListedWindow } from "./list.ts";
import {
	DEFAULT_DRIVE_READY_REGEX,
	DEFAULT_DRIVE_READY_TIMEOUT_MS,
	DEFAULT_DRIVE_DONE_TIMEOUT_MS,
	DEFAULT_DRIVE_LINES,
} from "./constants.ts";
// DEFAULT_DRIVE_DONE_REGEX is intentionally NOT used as the default for
// done-detection anymore (see phase 3 doc above). It remains exported from
// constants.ts as a *suggested* pattern for callers who explicitly opt in
// to regex-based done detection via the `doneRegex` parameter.

export interface DriveClaudeOpts {
	/** Window name (e.g. "pi-agent-bg-abc") or runId (e.g. "bg-abc"). */
	window: string;
	/** Prompt text. Bounded by MAX_TEXT_BYTES (4 KB) by pasteText. */
	prompt: string;
	/** Regex (string) matched against the pane to confirm the TUI is ready
	 *  for input. Default DEFAULT_DRIVE_READY_REGEX. */
	readyRegex?: string;
	/** OPT-IN: regex (string) matched against the pane to confirm the TUI
	 *  has finished its response. When omitted (default), the orchestrator
	 *  uses stability-based detection (output unchanged for doneStableMs).
	 *  Pass a non-empty string to opt BACK INTO regex-based detection.
	 *  See codex review for the rationale (stale-match and streaming-✻
	 *  correctness hazards of the previous regex default). */
	doneRegex?: string;
	/** Max ms to wait for the ready marker. Default DEFAULT_DRIVE_READY_TIMEOUT_MS. */
	readyTimeoutMs?: number;
	/** Max ms to wait for the done marker. Default DEFAULT_DRIVE_DONE_TIMEOUT_MS. */
	doneTimeoutMs?: number;
	/** Number of separate Enter invocations fired after the paste.
	 *  Default 1, clamped 0..MAX_ENTER_COUNT by pasteText. */
	pressEnterCount?: number;
	/** Capture depth for the final captureWindow. Default DEFAULT_DRIVE_LINES.
	 *  Clamped to captureWindow's [1, MAX_CAPTURE_LINES] bounds. */
	lines?: number;
}

export type DriveClaudePhase = "resolve" | "ready" | "paste" | "done" | "capture";

export interface DriveClaudeResult {
	ok: boolean;
	/** Which phase the orchestrator reached. On failure, identifies where it stopped. */
	phase: DriveClaudePhase;
	/** Error message on failure. Omitted on success. */
	error?: string;
	/** Captured pane output. On success (phase:"capture"), the full response.
	 *  On phase:"done" timeout, the last capture from the wait loop (partial output). */
	output?: string;
	/** Resolved tmux target ("sessionName:windowIndex") on success or any
	 *  phase that successfully resolved the identifier (ready/paste/done/capture).
	 *  Omitted on phase:"resolve" since resolution failed. */
	target?: string;
}

/**
 * Drive a Claude/Codex TUI through one full "ask and read" cycle.
 *
 * See file header for the phase model. `windows` MUST be the prefix-gated
 * list returned by listAgentWindows — drive does NOT call tmux to re-list
 * windows, because the caller's snapshot is authoritative for the current
 * invocation.
 *
 * @throws Nothing — every failure path (including malformed readyRegex /
 *         doneRegex patterns) returns `{ok:false, phase, error}` so the
 *         tool layer can surface a structured error to the LLM rather than
 *         throwing across the tool boundary. A malformed readyRegex yields
 *         phase:"ready"; a malformed doneRegex yields phase:"done".
 */
export async function driveClaude(
	executor: TmuxExecutor,
	socketPrefix: string[],
	windows: ListedWindow[],
	prefix: string,
	opts: DriveClaudeOpts,
): Promise<DriveClaudeResult> {
	// Default all opts ONCE up front so each phase reads cleanly. Defaults
	// mirror the documented constants — keeping them inline (rather than
	// inside the function calls) makes the call sites in the LLM tool
	// reviewable without re-scanning constants.ts.
	//
	// doneRegex is intentionally NOT defaulted here. The default for
	// done-detection is stability-based (stableMs); regex-based detection
	// is opt-in via `opts.doneRegex` (see phase 3 comment below).
	const lines = opts.lines ?? DEFAULT_DRIVE_LINES;
	const readyRegex = opts.readyRegex ?? DEFAULT_DRIVE_READY_REGEX;
	const doneRegex = opts.doneRegex;
	const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_DRIVE_READY_TIMEOUT_MS;
	const doneTimeoutMs = opts.doneTimeoutMs ?? DEFAULT_DRIVE_DONE_TIMEOUT_MS;
	const pressEnterCount = opts.pressEnterCount ?? 1;

	// Phase 0 — resolve the window identifier. PURE (no tmux call).
	// Resolution failure short-circuits the whole drive without burning a
	// single tmux exec — this is why the unprefixed-window test can
	// assert `fake.calls.length === 0`.
	const resolved = resolveTarget(opts.window, windows, { prefix });
	if ("error" in resolved) {
		return { ok: false, phase: "resolve", error: resolved.error };
	}
	const target = resolved.target;
	const targetStr = `${target.sessionName}:${target.windowIndex}`;

	// Phase 1 — wait for ready. A timeout here means the TUI never reached
	// the idle state, so we must NOT paste — the prompt would land on a
	// confused prompt area and the TUI could submit it as an unintended
	// command. Safe to bail.
	//
	// A malformed readyRegex throws SyntaxError from waitForWindow (which
	// compiles it via `new RegExp` eagerly). Convert that to a structured
	// phase:"ready" error so the tool layer can surface it without throwing
	// across the tool boundary.
	let readyWait;
	try {
		readyWait = await waitForWindow(
			executor,
			socketPrefix,
			{ sessionName: target.sessionName, windowIndex: target.windowIndex },
			{ regex: readyRegex, timeoutMs: readyTimeoutMs, lines },
		);
	} catch (e) {
		if (e instanceof SyntaxError) {
			return {
				ok: false,
				phase: "ready",
				error: `invalid readyRegex ${JSON.stringify(readyRegex)}: ${e.message}`,
				target: targetStr,
			};
		}
		throw e;
	}
	if (!readyWait.ok) {
		// waitForWindow returns `error` on capture-error and `output` on
		// timeout. Use whichever the reason provides; both are non-empty
		// in practice (capture-error has stderr, timeout has last capture).
		const errMsg = readyWait.error
			?? `ready wait ${readyWait.reason} after ${readyWait.elapsedMs}ms`;
		return { ok: false, phase: "ready", error: errMsg, target: targetStr };
	}

	// Phase 2 — paste. pasteText handles REQ-1 (bracketed paste), REQ-2
	// (argv-only text), REQ-3 (oversize rejection), REQ-4 (buffer cleanup),
	// REQ-20 (marker sanitization). If any of those trip, we bail here.
	const paste = await pasteText(
		executor,
		socketPrefix,
		{ sessionName: target.sessionName, windowIndex: target.windowIndex },
		opts.prompt,
		{ pressEnter: true, pressEnterCount },
	);
	if (!paste.ok) {
		return { ok: false, phase: "paste", error: paste.error, target: targetStr };
	}

// Phase 3 — wait for done. Uses stableMs as the DEFAULT done-detection
	// mechanism (output hasn't changed for doneStableMs). Regex-based done
	// detection is available as an opt-in (doneRegex overrides stableMs).
	// On timeout, return PARTIAL OUTPUT so the caller can inspect whatever
	// the TUI produced before we gave up.
	const doneStableMs = 2_000;
	const doneWaitOpts: Parameters<typeof waitForWindow>[3] = { timeoutMs: doneTimeoutMs, lines };
	if (doneRegex !== undefined && doneRegex !== "") {
		// Caller explicitly chose regex-based detection (opt-in).
		doneWaitOpts.regex = doneRegex;
	} else {
		// Default: stability-based detection (output unchanged for doneStableMs).
		doneWaitOpts.stableMs = doneStableMs;
	}
	// A malformed doneRegex throws SyntaxError from waitForWindow (which
	// compiles it via `new RegExp` eagerly). Convert that to a structured
	// phase:"done" error so the tool layer can surface it without throwing
	// across the tool boundary.
	let doneWait;
	try {
		doneWait = await waitForWindow(
			executor,
			socketPrefix,
			{ sessionName: target.sessionName, windowIndex: target.windowIndex },
			doneWaitOpts,
		);
	} catch (e) {
		if (e instanceof SyntaxError) {
			return {
				ok: false,
				phase: "done",
				error: `invalid doneRegex ${JSON.stringify(doneRegex)}: ${e.message}`,
				target: targetStr,
			};
		}
		throw e;
	}
	if (!doneWait.ok) {
		// Compose an error that includes the wait reason + the partial output
		// snapshot. The caller-facing result.output is the partial capture;
		// the tool layer surfaces both `error` and `output` to the LLM.
		const reason = doneWait.reason ?? "error";
		const partial = doneWait.output;
		const errMsg = doneWait.error
			? `done wait ${reason}: ${doneWait.error}`
			: `done wait ${reason} after ${doneWait.elapsedMs}ms`;
		return {
			ok: false,
			phase: "done",
			error: errMsg,
			output: partial,
			target: targetStr,
		};
	}

	// Phase 4 — final capture. Returned verbatim as the LLM's tool result.
	// captureWindow failure here is unusual (the window has been talking to
	// us the whole time) but if tmux drops the pane between done-wait and
	// final-capture we surface the error rather than silently returning the
	// done-wait's stale snapshot.
	const cap = await captureWindow(
		executor,
		socketPrefix,
		{ sessionName: target.sessionName, windowIndex: target.windowIndex },
		{ lines },
	);
	if (!cap.ok) {
		return { ok: false, phase: "capture", error: cap.error, target: targetStr };
	}

	return { ok: true, phase: "capture", output: cap.output, target: targetStr };
}