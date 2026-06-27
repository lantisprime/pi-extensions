// tmux-control: capture pane output with bounded size.
//
// Uses `capture-pane -p -S -<lines>` to dump the visible + recent scrollback
// of a window. Target MUST be session-qualified (`session:windowIndex`) to
// avoid tmux's "can't find pane" ambiguity when multiple sessions exist.
//
// -p  : print to stdout
// -S  : start line (-N = last N lines, inclusive of visible)
// -J  : join wrapped lines (avoids splitting one logical line across two)
import type { TmuxExecutor } from "./exec.ts";
import { TMUX_INVOCATION_TIMEOUT_MS, MAX_CAPTURE_LINES, DEFAULT_CAPTURE_LINES } from "./constants.ts";

export interface CaptureTarget {
	sessionName: string;
	windowIndex: string;
}

export interface CaptureResult {
	ok: boolean;
	output?: string;
	error?: string;
}

export async function captureWindow(
	executor: TmuxExecutor,
	socketPrefix: string[],
	target: CaptureTarget,
	opts?: { lines?: number },
): Promise<CaptureResult> {
	const lines = Math.min(Math.max(opts?.lines ?? DEFAULT_CAPTURE_LINES, 1), MAX_CAPTURE_LINES);
	const t = `${target.sessionName}:${target.windowIndex}`;
	const args = [...socketPrefix, "capture-pane", "-p", "-J", "-S", `-${lines}`, "-t", t];
	const result = await executor.exec(args, { timeoutMs: TMUX_INVOCATION_TIMEOUT_MS });
	if (!result.ok) {
		return { ok: false, error: result.stderr || `capture-pane failed (exit ${result.exitCode})` };
	}
	return { ok: true, output: result.stdout };
}