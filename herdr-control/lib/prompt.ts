// herdr-control: submit work to an agent via `agent prompt --wait`.
//
// Semantics (herdr.dev/docs/agent-automation):
//   - `--wait` waits for the first settled idle/done/blocked state (defaults;
//     do not repeat them with --until)
//   - an accepted prompt from a non-working state must show a lifecycle
//     change within 5s or herdr returns agent_prompt_stalled
//   - if the agent is already blocked, herdr returns agent_blocked WITHOUT
//     sending any input
//   - waits track lifecycle, not turns; caller timeouts <=5s degrade to plain
//     timeout semantics, so we clamp the minimum to 5s
//   - no default timeout exists: always pass --timeout explicitly
import type { HerdrExecutor } from "./exec.ts";
import { PROMPT_MAX_TIMEOUT_MS, PROMPT_MIN_TIMEOUT_MS } from "./constants.ts";
import { errorCodeIs, extractError, parseEnvelope } from "./json.ts";

export type PromptOutcome =
	| { ok: true; status: string }
	| { ok: false; kind: "blocked" | "stalled" | "timeout" | "not-running" | "error"; error: string };

export function clampPromptTimeout(ms: number | undefined): number {
	if (ms === undefined || !Number.isFinite(ms)) return PROMPT_MIN_TIMEOUT_MS * 60;
	return Math.min(Math.max(Math.trunc(ms), PROMPT_MIN_TIMEOUT_MS), PROMPT_MAX_TIMEOUT_MS);
}

export async function promptAgent(
	executor: HerdrExecutor,
	target: string,
	task: string,
	timeoutMs: number | undefined,
	wait = true,
): Promise<PromptOutcome> {
	const timeout = clampPromptTimeout(timeoutMs);
	const args = wait
		? ["agent", "prompt", target, task, "--wait", "--timeout", String(timeout)]
		: ["agent", "prompt", target, task];
	const result = await executor.exec(args, { timeoutMs: wait ? timeout + 10_000 : 30_000 });
	if (result.ok) {
		let status = "settled";
		try {
			const parsed = parseEnvelope(result.stdout);
			if (parsed.ok) {
				const record = parsed.envelope.result as { agent?: { agent_status?: string } } | null;
				if (record?.agent?.agent_status) status = record.agent.agent_status;
			}
		} catch {
			// envelope parse failure on success is non-fatal
		}
		return { ok: true, status };
	}

	const err = extractError(result.stderr, result.exitCode);
	if (errorCodeIs(err, "agent_blocked")) return { ok: false, kind: "blocked", error: err.message };
	if (errorCodeIs(err, "agent_prompt_stalled")) return { ok: false, kind: "stalled", error: err.message };
	if (errorCodeIs(err, "timeout")) return { ok: false, kind: "timeout", error: err.message };
	if (errorCodeIs(err, "agent_not_running")) return { ok: false, kind: "not-running", error: err.message };
	return { ok: false, kind: "error", error: err.message };
}
