// P5d-S1: cmux-control argv-only executor for macOS cmux 0.64.17+.
// Uses child_process.execFile (argv only, no shell) with a 5s hard timeout cap.
// Error handling matches cmux-terminal/lib/exec.ts.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
export const CMUX_EXEC_TIMEOUT_MS = 5000;

export interface CmuxExecutor {
	exec(args: string[], opts: { timeoutMs: number }): Promise<CmuxExecResult>;
}

export type CmuxExecResult =
	| { ok: true; stdout: string; stderr: string; exitCode: 0 }
	| { ok: false; stdout: string; stderr: string; exitCode: number };

export function defaultCmuxExecutor(): CmuxExecutor {
	return {
		async exec(args, opts) {
			const timeoutMs = Math.min(opts.timeoutMs, CMUX_EXEC_TIMEOUT_MS);
			try {
				const { stdout, stderr } = await execFileP("cmux", args, { timeout: timeoutMs });
				return { ok: true, stdout, stderr, exitCode: 0 };
			} catch (err: any) {
				if (err?.code === "ENOENT") return { ok: false, stdout: "", stderr: "spawn cmux ENOENT", exitCode: -1 };
				if (err?.killed && err?.signal) return { ok: false, stdout: err.stdout ?? "", stderr: "timed out after " + timeoutMs + "ms", exitCode: -1 };
				return { ok: false, stdout: err?.stdout ?? "", stderr: err?.stderr ?? String(err), exitCode: err?.code ?? 1 };
			}
		},
	};
}
