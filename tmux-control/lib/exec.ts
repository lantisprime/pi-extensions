// tmux-control: argv-only tmux executor with hard timeout.
// Mirrors the safety model of tmux-terminal/lib/exec.ts but is independent
// (no shared module, so it can be loaded without the agents extension).
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface TmuxExecutor {
	exec(args: string[], opts: { timeoutMs: number }): Promise<TmuxExecResult>;
}

export type TmuxExecResult =
	| { ok: true; stdout: string; stderr: string; exitCode: 0 }
	| { ok: false; stdout: string; stderr: string; exitCode: number };

export function defaultTmuxExecutor(): TmuxExecutor {
	return {
		async exec(args, opts) {
			try {
				const { stdout, stderr } = await execFileP("tmux", args, { timeout: opts.timeoutMs });
				return { ok: true, stdout, stderr, exitCode: 0 };
			} catch (err: any) {
				if (err?.code === "ENOENT") return { ok: false, stdout: "", stderr: "spawn tmux ENOENT", exitCode: -1 };
				if (err?.killed && err?.signal) return { ok: false, stdout: err.stdout ?? "", stderr: `timed out after ${opts.timeoutMs}ms`, exitCode: -1 };
				return { ok: false, stdout: err?.stdout ?? "", stderr: err?.stderr ?? String(err), exitCode: err?.code ?? 1 };
			}
		},
	};
}