// cmux-control send operations for cmux surfaces.
import type { CmuxExecutor } from "./exec.ts";
import { requireCmuxRef } from "./safety.ts";

const CMUX_SEND_TIMEOUT_MS = 5000;
const MAX_SEND_TEXT_BYTES = 4096;

export async function sendText(
	executor: CmuxExecutor,
	surfaceRef: string,
	text: string,
	opts: { pressEnter?: boolean } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
	const ref = requireCmuxRef(surfaceRef, "surface");
	if ("error" in ref) return { ok: false, error: ref.error };
	if (Buffer.byteLength(text, "utf8") > MAX_SEND_TEXT_BYTES) {
		return { ok: false, error: `text exceeds ${MAX_SEND_TEXT_BYTES} byte limit` };
	}

	const result = await executor.exec(["send", "--surface", surfaceRef, text], { timeoutMs: CMUX_SEND_TIMEOUT_MS });
	if (!result.ok) return { ok: false, error: result.stderr || `cmux send failed (exit ${result.exitCode})` };

	if (opts.pressEnter) {
		const enterResult = await executor.exec(["send-key", "--surface", surfaceRef, "enter"], {
			timeoutMs: CMUX_SEND_TIMEOUT_MS,
		});
		if (!enterResult.ok) {
			return { ok: false, error: enterResult.stderr || `cmux send-key failed (exit ${enterResult.exitCode})` };
		}
	}

	return { ok: true };
}

export async function sendKey(
	executor: CmuxExecutor,
	surfaceRef: string,
	key: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const ref = requireCmuxRef(surfaceRef, "surface");
	if ("error" in ref) return { ok: false, error: ref.error };

	const result = await executor.exec(["send-key", "--surface", surfaceRef, key], { timeoutMs: CMUX_SEND_TIMEOUT_MS });
	if (!result.ok) return { ok: false, error: result.stderr || `cmux send-key failed (exit ${result.exitCode})` };
	return { ok: true };
}
