// P5b-1: CmuxExecutor abstraction. The production executor uses child_process.execFile
// (argv only, no shell). A test seam allows injection of a fake executor.
//
// Mirrors tmux-terminal/lib/exec.ts with the "tmux" binary swapped for "cmux".
// Error handling is identical: ENOENT → spawn cmux ENOENT, killed/timeout →
// timed out, otherwise propagate stderr/exitCode.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface CmuxExecutor {
	exec(args: string[], opts: { timeoutMs: number }): Promise<CmuxExecResult>;
}

export type CmuxExecResult =
	| { ok: true; stdout: string; stderr: string; exitCode: 0 }
	| { ok: false; stdout: string; stderr: string; exitCode: number };

export function defaultCmuxExecutor(): CmuxExecutor {
	return {
		async exec(args, opts) {
			try {
				const { stdout, stderr } = await execFileP("cmux", args, { timeout: opts.timeoutMs });
				return { ok: true, stdout, stderr, exitCode: 0 };
			} catch (err: any) {
				if (err?.code === "ENOENT") return { ok: false, stdout: "", stderr: "spawn cmux ENOENT", exitCode: -1 };
				if (err?.killed && err?.signal) return { ok: false, stdout: err.stdout ?? "", stderr: "timed out after " + opts.timeoutMs + "ms", exitCode: -1 };
				return { ok: false, stdout: err?.stdout ?? "", stderr: err?.stderr ?? String(err), exitCode: err?.code ?? 1 };
			}
		},
	};
}
