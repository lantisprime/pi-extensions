// herdr-control: close a spawned pane via `pane close`.
//
// Safety policy lives in index.ts (registry + confirm gates); this module is
// the thin CLI wrapper. herdr never reuses closed pane IDs, so closing by
// recorded pane ID cannot hit a recycled terminal.
import type { HerdrExecutor } from "./exec.ts";
import { HERDR_SHORT_TIMEOUT_MS } from "./constants.ts";
import { extractError, parseEnvelope } from "./json.ts";
import { requirePaneRef } from "./safety.ts";

export type CloseOutcome = { ok: true } | { ok: false; error: string };

export async function closePane(executor: HerdrExecutor, paneId: string): Promise<CloseOutcome> {
	const ref = requirePaneRef(paneId);
	if (!ref.ok) return { ok: false, error: ref.error };
	const result = await executor.exec(["pane", "close", ref.ref], { timeoutMs: HERDR_SHORT_TIMEOUT_MS });
	if (!result.ok) {
		const err = extractError(result.stderr, result.exitCode);
		return { ok: false, error: err.message };
	}
	const parsed = parseEnvelope(result.stdout);
	if (!parsed.ok) return { ok: false, error: parsed.error };
	return { ok: true };
}
