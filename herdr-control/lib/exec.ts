// herdr-control argv-only executor for herdr 0.8.x.
// Uses child_process.execFile (argv only, no shell) with a per-call timeout
// clamped to HERDR_EXEC_ABS_MAX_MS. Error handling mirrors cmux-control.
//
// herdr CLI contract (herdr.dev/docs/cli-reference):
//   - success: JSON envelope on stdout, exit 0
//   - server errors: JSON on stderr, exit 1
//   - usage errors: exit 2
// Exception: `agent read` / `pane read` print plain text on stdout.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HERDR_EXEC_ABS_MAX_MS } from "./constants.ts";

const execFileP = promisify(execFile);

export interface HerdrExecutor {
	exec(args: string[], opts: { timeoutMs: number }): Promise<HerdrExecResult>;
}

export type HerdrExecResult =
	| { ok: true; stdout: string; stderr: string; exitCode: 0 }
	| { ok: false; stdout: string; stderr: string; exitCode: number };

export function clampExecTimeout(timeoutMs: number): number {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return HERDR_EXEC_ABS_MAX_MS;
	return Math.min(timeoutMs, HERDR_EXEC_ABS_MAX_MS);
}

export function defaultHerdrExecutor(bin = "herdr"): HerdrExecutor {
	return {
		async exec(args, opts) {
			const timeoutMs = clampExecTimeout(opts.timeoutMs);
			try {
				const { stdout, stderr } = await execFileP(bin, args, { timeout: timeoutMs });
				return { ok: true, stdout, stderr, exitCode: 0 };
			} catch (err: unknown) {
				const e = err as { code?: string | number; killed?: boolean; signal?: string; stdout?: string; stderr?: string };
				if (e?.code === "ENOENT") {
					return { ok: false, stdout: "", stderr: `spawn ${bin} ENOENT (is herdr installed and on PATH?)`, exitCode: -1 };
				}
				if (e?.killed && e?.signal) {
					return { ok: false, stdout: e.stdout ?? "", stderr: `herdr timed out after ${timeoutMs}ms`, exitCode: -1 };
				}
				return { ok: false, stdout: e?.stdout ?? "", stderr: e?.stderr ?? String(err), exitCode: typeof e?.code === "number" ? e.code : 1 };
			}
		},
	};
}
