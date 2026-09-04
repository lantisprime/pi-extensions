// herdr-control: read agent terminal output via `agent read`.
//
// NOTE: unlike control commands, `agent read` prints PLAIN TEXT on stdout
// (ANSI stripped by default) — not a JSON envelope. `recent-unwrapped` joins
// soft wraps and is the preferred source for transcripts. Alternate-screen
// agents only expose history reads while idle; herdr returns agent_not_idle
// otherwise, which we classify so callers can wait and retry.
import type { HerdrExecutor } from "./exec.ts";
import {
	DEFAULT_READ_LINES,
	DEFAULT_READ_SOURCE,
	MAX_READ_LINES,
	MAX_TRANSCRIPT_CHARS,
	MIN_READ_LINES,
} from "./constants.ts";
import { errorCodeIs, extractError } from "./json.ts";

export const READ_SOURCES = ["visible", "recent", "recent-unwrapped"] as const;
export type ReadSource = (typeof READ_SOURCES)[number];

export interface ReadOptions {
	source?: ReadSource;
	lines?: number;
}

export type ReadOutcome =
	| { ok: true; text: string; truncated: boolean }
	| { ok: false; kind: "not-idle" | "error"; error: string };

export function clampReadLines(lines: number | undefined): number {
	if (lines === undefined || !Number.isFinite(lines)) return DEFAULT_READ_LINES;
	return Math.min(Math.max(Math.trunc(lines), MIN_READ_LINES), MAX_READ_LINES);
}

// Keep the TAIL of long transcripts: the agent's final answer lives at the
// bottom of the terminal.
export function keepTail(text: string, max: number = MAX_TRANSCRIPT_CHARS): { text: string; truncated: boolean } {
	if (text.length <= max) return { text, truncated: false };
	return { text: text.slice(text.length - max), truncated: true };
}

export async function readAgent(executor: HerdrExecutor, target: string, opts: ReadOptions = {}): Promise<ReadOutcome> {
	const source = opts.source ?? (DEFAULT_READ_SOURCE as ReadSource);
	const lines = clampReadLines(opts.lines);
	const result = await executor.exec(
		["agent", "read", target, "--source", source, "--lines", String(lines)],
		{ timeoutMs: 30_000 }, // alternate-screen page collection can take a moment
	);
	if (!result.ok) {
		const err = extractError(result.stderr, result.exitCode);
		if (errorCodeIs(err, "agent_not_idle")) {
			return { ok: false, kind: "not-idle", error: `${err.message} (wait for the agent to settle, then retry; or use --source visible)` };
		}
		return { ok: false, kind: "error", error: err.message };
	}
	const kept = keepTail(result.stdout);
	return { ok: true, text: kept.text, truncated: kept.truncated };
}
