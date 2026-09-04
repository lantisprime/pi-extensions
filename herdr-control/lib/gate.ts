// herdr-control: entry gate (HERDR_ENV check + cached server reachability).
import type { HerdrExecutor } from "./exec.ts";
import { HERDR_SHORT_TIMEOUT_MS, SERVER_STATUS_CACHE_MS, SERVER_STATUS_FAIL_CACHE_MS } from "./constants.ts";
import { extractError } from "./json.ts";
import { herdrGateError, insideHerdr } from "./safety.ts";

let lastOkAt = 0;
let lastFailAt = 0;
let lastFailError = "";

export type GateResult = { ok: true } | { ok: false; error: string };

export function checkInsideHerdr(): GateResult {
	if (!insideHerdr()) return { ok: false, error: herdrGateError() };
	return { ok: true };
}

// Fast path: cached positive check within SERVER_STATUS_CACHE_MS; cached
// negative check within SERVER_STATUS_FAIL_CACHE_MS. Otherwise probe
// `herdr status client` (cheap, client-side only).
export async function ensureServer(executor: HerdrExecutor): Promise<GateResult> {
	const inside = checkInsideHerdr();
	if (!inside.ok) return inside;

	const now = Date.now();
	if (now - lastOkAt < SERVER_STATUS_CACHE_MS) return { ok: true };
	if (now - lastFailAt < SERVER_STATUS_FAIL_CACHE_MS) return { ok: false, error: lastFailError };

	const result = await executor.exec(["status", "client"], { timeoutMs: HERDR_SHORT_TIMEOUT_MS });
	if (result.ok) {
		lastOkAt = Date.now();
		return { ok: true };
	}
	lastFailAt = Date.now();
	const err = extractError(result.stderr, result.exitCode);
	lastFailError = `herdr server not reachable: ${err.message}. Run 'herdr' in a terminal to start/attach the server.`;
	return { ok: false, error: lastFailError };
}

export function resetGateCache(): void {
	lastOkAt = 0;
	lastFailAt = 0;
	lastFailError = "";
}
