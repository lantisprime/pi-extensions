// cmux-control surface capture operation.
import type { CmuxExecutor } from "./exec.ts";
import { requireCmuxRef } from "./safety.ts";

const CMUX_CAPTURE_TIMEOUT_MS = 5000;
const DEFAULT_CAPTURE_LINES = 50;
const MAX_CAPTURE_LINES = 5000;

export async function captureSurface(
	executor: CmuxExecutor,
	surfaceRef: string,
	lines = DEFAULT_CAPTURE_LINES,
): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
	const ref = requireCmuxRef(surfaceRef, "surface");
	if ("error" in ref) return { ok: false, error: ref.error };
	if (!Number.isInteger(lines) || lines < 1 || lines > MAX_CAPTURE_LINES) {
		return { ok: false, error: `lines must be an integer from 1 to ${MAX_CAPTURE_LINES}` };
	}

	const result = await executor.exec(["read-screen", "--surface", surfaceRef, "--lines", String(lines)], {
		timeoutMs: CMUX_CAPTURE_TIMEOUT_MS,
	});
	if (!result.ok) {
		return { ok: false, error: result.stderr || `cmux read-screen failed (exit ${result.exitCode})` };
	}
	return { ok: true, output: result.stdout ?? "" };
}
