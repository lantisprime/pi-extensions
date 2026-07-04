// P5: Strip absolute worker/manifest paths from tmux error output before
// surfacing them to the user. Truncates to MAX_ERROR_STDERR_LEN + ellipsis.
import { MAX_ERROR_STDERR_LEN, REDACTED_WORKER, REDACTED_MANIFEST } from "./constants.ts";

export function redactError(stderr: string, workerPath: string, manifestPath: string): string {
	let out = stderr;
	if (workerPath) out = out.split(workerPath).join(REDACTED_WORKER);
	if (manifestPath) out = out.split(manifestPath).join(REDACTED_MANIFEST);
	if (out.length > MAX_ERROR_STDERR_LEN) return out.slice(0, MAX_ERROR_STDERR_LEN) + "\u2026";
	return out;
}