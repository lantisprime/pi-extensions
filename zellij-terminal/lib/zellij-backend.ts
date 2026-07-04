// P5b-2: zellij-backed implementation of TermBgBackend.
//
// Security invariants (carried over from tmux-backend.ts / cmux-backend.ts):
//  - run argv contains ONLY workerPath + manifestPath after the `--` terminator
//    (no agentName, no runId, no cwd-as-arg). The pane name is a derived
//    `pi-zellij-pane-<runId.slice(0,8)>` — never user-controlled text.
//  - manifestPath and cwd are validated (absolute, no `..`, manifestPath
//    realpath under bgStateDir) before any zellij invocation; failure returns
//    { status: "failed", error: "invalid ..." } with NO zellij call made.
//  - All zellij calls timeout; no exception escapes; failures are translated to
//    TermBgFailedResult.
//
// zellij limitation: the session name encodes runId only. There is no
// zellij equivalent of tmux's `set-window-option @pi_agent_name`; agentName is
// not recoverable from `list-sessions` output. Documented as a known gap
// (same as cmux-terminal P5b-1).
//
// Two-step detached launch (per the spike):
//  1. await attachSpawner(sessionName) — runs `zellij attach -b
//     <sessionName>` via execFile (argv-only, stdio:"ignore" → /dev/null on
//     all 3 fds; needed to avoid the pipe-buffer deadlock when zellij
//     writes to stderr during startup). The client runs ~2s, forks the
//     session server, and exits; the await reaps the child and guarantees
//     the session server is forked before step 2 starts.
//  2. Poll `zellij list-sessions -s` until sessionName appears (250ms interval,
//     5000ms timeout). Failure → { failed, "zellij session did not appear
//     within 5000ms" }.
//  3. `zellij -s <sessionName> run --name <pane-name> --cwd <cwd>
//     --close-on-exit -- node <workerPath> <manifestPath>` → pane id
//     `terminal_<n>` on stdout.
//
// The pane id is NOT persisted. windowId = session name, so kill()/isAlive()/
// list() work off the session name (the only zellij CLI surface that takes an
// opaque handle).
import {
	ZELLIJ_SESSION_PREFIX,
	ZELLIJ_BACKEND_NAME,
	ZELLIJ_BACKEND_PREFERENCE,
	ZELLIJ_INVOCATION_TIMEOUT_MS,
	ZELLIJ_LIST_TIMEOUT_MS,
	ZELLIJ_LAUNCH_POLL_TIMEOUT_MS,
	ZELLIJ_LAUNCH_POLL_INTERVAL_MS,
	ZELLIJ_AVAILABLE_PROBE_TIMEOUT_MS,
	REDACTED_WORKER,
	REDACTED_MANIFEST,
} from "./constants.ts";
import { redactError } from "./redact-error.ts";
import { isAbsoluteNoDotDot, isUnderDir } from "./path-validate.ts";
import type { ZellijExecutor } from "./exec.ts";
import type { TermBgBackend, TermBgAgentConfig, TermBgResult, TermBgWindowEntry } from "../../agents/lib/bg-terminal.ts";

const ERR_INVALID_CWD = "invalid cwd";
const ERR_INVALID_MANIFEST = "invalid manifest path";
const ERR_SESSION_TIMEOUT = "zellij session did not appear within 5000ms";
const ERR_UNEXPECTED_RUN_OUTPUT = (stdout: string) => `unexpected run output: ${stdout}`;
const ERR_KILL_FAILED = "kill failed";

export interface CreateZellijBackendOpts {
	executor: ZellijExecutor;
	/** Runs `zellij attach -b <name>` to create the detached session and
	 *  AWAITS the client's exit (~2s). INJECTED so unit tests pass a
	 *  recorder/promise-returning fake instead of a real execFile.
	 *  Production: `spawnAttachSession` from `./exec.ts`. The backend's
	 *  `launch` awaits this before starting the `list-sessions -s` poll. */
	attachSpawner: (name: string) => Promise<void>;
	workerPath: string;
	bgStateDir: string;
	preference?: number;
}

export function createZellijBackend(opts: CreateZellijBackendOpts): TermBgBackend {
	const { executor, attachSpawner, workerPath, bgStateDir } = opts;

	return {
		name: ZELLIJ_BACKEND_NAME,
		// REQ-2: always set preference explicitly to ZELLIJ_BACKEND_PREFERENCE
		// (0). When the caller passes preference: 0, it must still appear on
		// the backend (the optional-field check is opt-in to override; the
		// default IS ZELLIJ_BACKEND_PREFERENCE = 0).
		preference: opts.preference ?? ZELLIJ_BACKEND_PREFERENCE,

		async isAvailable(): Promise<boolean> {
			// REQ-3: list-sessions -s exits 0 when >=1 session active. Exits 1
			// with "No active zellij sessions found." when zero (the
			// healthy-but-empty state — verified in the spike). ENOENT /
			// any other failure → false.
			try {
				const result = await executor.exec(["list-sessions", "-s"], { timeoutMs: ZELLIJ_AVAILABLE_PROBE_TIMEOUT_MS });
				if (result.ok === true) return true;
				if (result.ok === false && /No active zellij sessions found\./.test(result.stderr)) return true;
				return false;
			} catch {
				return false;
			}
		},

		async launch(config: TermBgAgentConfig): Promise<TermBgResult> {
			// REQ-4: validate cwd BEFORE any zellij call. Failure → invalid cwd.
			if (!isAbsoluteNoDotDot(config.cwd)) return { status: "failed", error: ERR_INVALID_CWD };
			// REQ-4: validate manifestPath (absolute + no `..` + realpath under
			// bgStateDir). Failure → invalid manifest path.
			if (!isAbsoluteNoDotDot(config.manifestPath)) return { status: "failed", error: ERR_INVALID_MANIFEST };
			if (!isUnderDir(config.manifestPath, bgStateDir)) return { status: "failed", error: ERR_INVALID_MANIFEST };

			const sessionName = ZELLIJ_SESSION_PREFIX + config.runId;
			const paneName = "pi-zellij-pane-" + config.runId.slice(0, 8);

			// Step 1: run zellij attach -b to create the detached session.
			// REQ-4: not called on invalid input (validation already returned).
			// AWAITED (per P5b-2 PR review fix 2): the zellij attach -b client
			// is short-lived (~2s) and forks the session server before exiting;
			// awaiting the client guarantees the session is forked before the
			// poll below starts. The session server persists after the client
			// exits (it is NOT a child of the Node process).
			await attachSpawner(sessionName);

			// Step 2: poll list-sessions -s for the session name to appear.
			const pollDeadline = Date.now() + ZELLIJ_LAUNCH_POLL_TIMEOUT_MS;
			let sessionAppeared = false;
			while (Date.now() < pollDeadline) {
				let pollResult;
				try {
					pollResult = await executor.exec(["list-sessions", "-s"], { timeoutMs: ZELLIJ_LIST_TIMEOUT_MS });
				} catch {
					pollResult = { ok: false, stdout: "", stderr: "", exitCode: 1 };
				}
				if (pollResult.ok) {
					const names = pollResult.stdout.split("\n");
					if (names.some((line) => line === sessionName)) {
						sessionAppeared = true;
						break;
					}
				}
				// No session yet (or empty list) — sleep and retry.
				await new Promise((r) => setTimeout(r, ZELLIJ_LAUNCH_POLL_INTERVAL_MS));
			}
			if (!sessionAppeared) return { status: "failed", error: ERR_SESSION_TIMEOUT };

			// Step 3: run the worker command in the named session via -s flag.
			// REQ-5: argv after `--` is `node <workerPath> <manifestPath>` ONLY.
			// No agentName, no runId, no cwd-as-arg (cwd is via --cwd flag).
			const runArgv = [
				"-s", sessionName,
				"run",
				"--name", paneName,
				"--cwd", config.cwd,
				"--close-on-exit",
				"--",
				"node", workerPath, config.manifestPath,
			];

			let runResult;
			try {
				runResult = await executor.exec(runArgv, { timeoutMs: ZELLIJ_INVOCATION_TIMEOUT_MS });
			} catch (err: any) {
				if (err?.killed && err?.signal) {
					// Best-effort cleanup of the session we just created.
					try { await executor.exec(["kill-session", sessionName], { timeoutMs: ZELLIJ_LIST_TIMEOUT_MS }); } catch { /* best-effort */ }
					return { status: "failed", error: `zellij timed out after ${ZELLIJ_INVOCATION_TIMEOUT_MS}ms` };
				}
				const stderr = err?.stderr ?? String(err);
				try { await executor.exec(["kill-session", sessionName], { timeoutMs: ZELLIJ_LIST_TIMEOUT_MS }); } catch { /* best-effort */ }
				return { status: "failed", error: redactError(stderr, workerPath, config.manifestPath) };
			}
			if (!runResult.ok) {
				try { await executor.exec(["kill-session", sessionName], { timeoutMs: ZELLIJ_LIST_TIMEOUT_MS }); } catch { /* best-effort */ }
				return { status: "failed", error: redactError(runResult.stderr, workerPath, config.manifestPath) };
			}

			// REQ-4 State E: run output must match /terminal_\d+/.
			if (!/terminal_\d+/.test(runResult.stdout)) {
				try { await executor.exec(["kill-session", sessionName], { timeoutMs: ZELLIJ_LIST_TIMEOUT_MS }); } catch { /* best-effort */ }
				return { status: "failed", error: ERR_UNEXPECTED_RUN_OUTPUT(runResult.stdout) };
			}

			// REQ-4 State F: success. windowId is the session name.
			return { status: "ok", windowId: sessionName };
		},

		async kill(windowId: string): Promise<TermBgResult> {
			try {
				const result = await executor.exec(["kill-session", windowId], { timeoutMs: ZELLIJ_LIST_TIMEOUT_MS });
				if (result.ok) return { status: "ok", windowId };
				// REQ-6: "No session named X found." exit 1 = idempotent ok
				// (mirrors tmux's "can't find window" tolerance). But if a
				// zombie is still listed, fall back to delete-session -f.
				if (/No session named .* found/.test(result.stderr)) {
					try {
						const listRes = await executor.exec(["list-sessions", "-s"], { timeoutMs: ZELLIJ_LIST_TIMEOUT_MS });
						if (listRes.ok) {
							const stillListed = listRes.stdout.split("\n").some((line) => line === windowId);
							if (stillListed) {
								// Best-effort: zombie cleanup. Ignore result.
								try { await executor.exec(["delete-session", "-f", windowId], { timeoutMs: ZELLIJ_LIST_TIMEOUT_MS }); } catch { /* best-effort */ }
							}
						}
					} catch { /* best-effort */ }
					return { status: "ok", windowId };
				}
				return { status: "failed", error: result.stderr || ERR_KILL_FAILED };
			} catch (err: any) {
				const stderr = String(err?.stderr ?? "");
				if (/No session named .* found/.test(stderr)) {
					// Same idempotent+zombie path as above.
					try {
						const listRes = await executor.exec(["list-sessions", "-s"], { timeoutMs: ZELLIJ_LIST_TIMEOUT_MS });
						if (listRes.ok) {
							const stillListed = listRes.stdout.split("\n").some((line) => line === windowId);
							if (stillListed) {
								try { await executor.exec(["delete-session", "-f", windowId], { timeoutMs: ZELLIJ_LIST_TIMEOUT_MS }); } catch { /* best-effort */ }
							}
						}
					} catch { /* best-effort */ }
					return { status: "ok", windowId };
				}
				return { status: "failed", error: stderr || ERR_KILL_FAILED };
			}
		},

		async isAlive(windowId: string): Promise<boolean> {
			// REQ-7: empty windowId → false. Exact match against list-sessions -s
			// output. Any error (ENOENT, timeout, thrown) → catch and return
			// false (NOT re-throw) — matches tmux/cmux backend convention.
			if (!windowId) return false;
			try {
				const { stdout } = await executor.exec(["list-sessions", "-s"], { timeoutMs: ZELLIJ_LIST_TIMEOUT_MS });
				const names = stdout.split("\n");
				return names.some(function _n(n) { return n === windowId; });
			} catch {
				return false;
			}
		},

		async list(): Promise<TermBgWindowEntry[]> {
			// REQ-8: list-sessions -s, one session name per line. Filter on
			// ZELLIJ_SESSION_PREFIX; agentName is unrecoverable (zellij has no
			// user-options equivalent).
			try {
				const { stdout } = await executor.exec(["list-sessions", "-s"], { timeoutMs: ZELLIJ_LIST_TIMEOUT_MS });
				return stdout
					.split("\n")
					.filter(function _f(line) { return line.startsWith(ZELLIJ_SESSION_PREFIX); })
					.map(function _m(line) {
						const runId = line.slice(ZELLIJ_SESSION_PREFIX.length);
						return {
							windowId: line,
							runId: runId || undefined,
							agentName: undefined,
						};
					});
			} catch {
				return [];
			}
		},
	};
}
