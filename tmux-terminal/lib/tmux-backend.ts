// P5: tmux-backed implementation of TermBgBackend.
//
// Security invariants:
//  - new-window argv contains ONLY workerPath + manifestPath (no agentName, no runId, no cwd-as-arg).
//  - agentName goes ONLY into a separate set-window-option @pi_agent_name call.
//  - runId goes ONLY into the window name (pi-agent-<runId>) and set-window-option @pi_run_id.
//  - cwd goes ONLY into the per-window -c option.
//  - manifestPath and cwd are validated (absolute, no `..`, manifestPath realpath under bgStateDir)
//    before any tmux invocation; failure returns { status: "failed", error: "invalid ..." }
//    with NO tmux call made.
//  - All tmux calls timeout; no exception escapes; failures are translated to TermBgFailedResult.
import { TMUX_WINDOW_PREFIX, TMUX_BACKEND_NAME } from "./constants.ts";
import { shellEscape } from "./shell-escape.ts";
import { redactError } from "./redact-error.ts";
import { isAbsoluteNoDotDot, isUnderDir } from "./path-validate.ts";
import type { TmuxExecutor } from "./exec.ts";
import type { TermBgBackend, TermBgAgentConfig, TermBgResult, TermBgWindowEntry } from "../../agents/lib/bg-terminal.ts";

export interface CreateTmuxBackendOpts {
	executor: TmuxExecutor;
	workerPath: string;
	bgStateDir: string;
}

export function createTmuxBackend(opts: CreateTmuxBackendOpts): TermBgBackend {
	const { executor, workerPath, bgStateDir } = opts;

	return {
		name: TMUX_BACKEND_NAME,

		async isAvailable(): Promise<boolean> {
			if (process.env.TMUX) return true;
			try {
				const result = await executor.exec(["list-sessions"], { timeoutMs: 1000 });
				return result.ok === true;
			} catch {
				return false;
			}
		},

		async launch(config: TermBgAgentConfig): Promise<TermBgResult> {
			// REQ-21: validate cwd
			if (!isAbsoluteNoDotDot(config.cwd)) return { status: "failed", error: "invalid cwd" };
			// REQ-20: validate manifestPath
			if (!isAbsoluteNoDotDot(config.manifestPath)) return { status: "failed", error: "invalid manifest path" };
			if (!isUnderDir(config.manifestPath, bgStateDir)) return { status: "failed", error: "invalid manifest path" };

			const windowName = TMUX_WINDOW_PREFIX + config.runId;
			const newWindowArgv = [
				"new-window", "-d", "-n", windowName, "-c", config.cwd,
				"-P", "-F", "#{window_id}", "--",
				"node", workerPath, config.manifestPath,
			];

			let newWindowResult;
			try {
				newWindowResult = await executor.exec(newWindowArgv, { timeoutMs: 10_000 });
			} catch (err: any) {
				if (err?.killed && err?.signal) return { status: "failed", error: "tmux timed out after 10000ms" };
				const stderr = err?.stderr ?? String(err);
				return { status: "failed", error: redactError(stderr, workerPath, config.manifestPath) };
			}
			if (!newWindowResult.ok) {
				return { status: "failed", error: redactError(newWindowResult.stderr, workerPath, config.manifestPath) };
			}

			// REQ-5 + REQ-5a: best-effort user-options for recovery
			try {
				await executor.exec(["set-window-option", "-t", windowName, "@pi_run_id", config.runId], { timeoutMs: 5_000 });
			} catch { /* best-effort */ }
			try {
				await executor.exec(["set-window-option", "-t", windowName, "@pi_agent_name", config.agentName], { timeoutMs: 5_000 });
			} catch { /* best-effort */ }

			return { status: "ok", windowId: windowName };
		},

		async kill(windowId: string): Promise<TermBgResult> {
			try {
				await executor.exec(["kill-window", "-t", windowId], { timeoutMs: 5_000 });
				return { status: "ok", windowId };
			} catch (err: any) {
				const stderr = String(err?.stderr ?? "");
				if (stderr.includes("can't find window")) return { status: "ok", windowId };
				return { status: "failed", error: stderr || "kill failed" };
			}
		},

		async isAlive(windowId: string): Promise<boolean> {
			if (!windowId) return false;
			try {
				const { stdout } = await executor.exec(["list-windows", "-F", "#{window_name}"], { timeoutMs: 5_000 });
				const names = stdout.split("\n");
				return names.some(function _n(n) { return n === windowId; });
			} catch {
				return false;
			}
		},

		async list(): Promise<TermBgWindowEntry[]> {
			try {
				const { stdout } = await executor.exec(
					["list-windows", "-F", "#{window_name} #{@pi_run_id} #{@pi_agent_name}"],
					{ timeoutMs: 5_000 },
				);
				return stdout
					.split("\n")
					.filter(function _f(line) { return line.startsWith(TMUX_WINDOW_PREFIX); })
					.map(function _m(line) {
						const parts = line.split(" ");
						return {
							windowId: parts[0],
							runId: parts[1] || undefined,
							agentName: parts[2] || undefined,
						};
					});
			} catch {
				return [];
			}
		},
	};
}