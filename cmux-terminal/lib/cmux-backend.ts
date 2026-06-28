// P5b-1: cmux-backed implementation of TermBgBackend.
//
// Mirrors tmux-terminal/lib/tmux-backend.ts with two structural changes:
//   1. The terminal is cmux (Ghostty-based macOS multiplexer), not tmux.
//   2. cmux has no analog of tmux's `set-window-option @pi_*` user options, so
//      the runId+agentName metadata can only be recovered from the workspace
//      name itself. We encode runId into the workspace name (`pi-cmux-<runId>`)
//      and accept that agentName is unrecoverable after launch.
//
// cmux 0.64.17 API surface used here:
//   - `cmux version`            — socket/CLI liveness probe (no --json flag)
//   - `cmux workspace create`   — create workspace (flags: --name, --cwd,
//                                 --command, --focus); stdout is the opaque
//                                 workspace handle (e.g. `workspace:3`) which
//                                 we use as windowId when non-empty
//   - `cmux workspace list --json` — list workspaces in the current window
//                                 (JSON shape: { workspaces: [{id,title,...}] })
//   - `cmux close-workspace --workspace <id>` — close one workspace by handle
//                                 (NOT `close-window`, which would close the
//                                 whole window and any other workspaces inside it)
//
// Security invariants (carried over from tmux-backend.ts):
//  - workspace create argv contains ONLY workerPath + manifestPath (no
//    agentName, no runId, no cwd-as-arg).
//  - agentName goes ONLY into a best-effort side effect (cmux has no user
//    options; the call is intentionally a no-op and best-effort).
//  - runId goes ONLY into the workspace name (`pi-cmux-<runId>`).
//  - cwd goes ONLY into the per-workspace --cwd flag.
//  - manifestPath and cwd are validated (absolute, no `..`, manifestPath
//    realpath under bgStateDir) before any cmux invocation; failure returns
//    { status: "failed", error: "invalid ..." } with NO cmux call made.
//  - All cmux calls timeout; no exception escapes; failures are translated to
//    TermBgFailedResult.
//
// cmux limitation: workspace name encodes runId only. There is no cmux
// equivalent of `set-window-option @pi_agent_name`; agentName is not
// recoverable from `workspace list` output. We pass agentName via the worker
// argv only when the cmux CLI supports a user-option flag (it doesn't today),
// so launch currently does no agentName side-effect — only the workspace name
// is persisted, and it carries runId alone.
import { CMUX_WINDOW_PREFIX, CMUX_BACKEND_NAME } from "./constants.ts";
import { shellEscape } from "./shell-escape.ts";
import { redactError } from "./redact-error.ts";
import { isAbsoluteNoDotDot, isUnderDir } from "./path-validate.ts";
import type { CmuxExecutor } from "./exec.ts";
import type { TermBgBackend, TermBgAgentConfig, TermBgResult, TermBgWindowEntry } from "../../agents/lib/bg-terminal.ts";

export interface CreateCmuxBackendOpts {
	executor: CmuxExecutor;
	workerPath: string;
	bgStateDir: string;
}

export function createCmuxBackend(opts: CreateCmuxBackendOpts): TermBgBackend {
	const { executor, workerPath, bgStateDir } = opts;

	return {
		name: CMUX_BACKEND_NAME,

		async isAvailable(): Promise<boolean> {
			// cmux is macOS-only (Ghostty-based macOS terminal multiplexer).
			if (process.platform !== "darwin") return false;
			// cmux 0.64.17: `identify --json` doesn't exist — `identify` has no
			// --json flag. Use `cmux version` as a liveness probe: it returns
			// ok only when the cmux CLI can talk to the running socket. On a
			// missing/stale socket the exec resolves to { ok: false, ... }.
			try {
				const result = await executor.exec(["version"], { timeoutMs: 1_000 });
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

			const workspaceName = CMUX_WINDOW_PREFIX + config.runId;
			// cmux 0.64.17's `workspace create --command` takes a single shell-
			// string payload. We use `node <workerPath> <manifestPath>`
			// (analogous to the tmux `node + workerPath + manifestPath` argv),
			// with each path POSIX-shell-escaped via single-quote wrapping so
			// spaces, quotes, and shell metacharacters inside the path can't
			// inject extra tokens when cmux sends the text+Enter to the new
			// workspace's terminal surface after creation.
			const commandString = `node ${shellEscape(workerPath)} ${shellEscape(config.manifestPath)}`;
			// cmux 0.64.17 canonical command. Legacy `new-workspace` is
			// deprecated and prints a one-time hint pointing to `workspace create`.
			const createArgv = [
				"workspace", "create",
				"--name", workspaceName,
				"--cwd", config.cwd,
				"--command", commandString,
				"--focus", "false",
			];

			let createResult;
			try {
				createResult = await executor.exec(createArgv, { timeoutMs: 10_000 });
			} catch (err: any) {
				if (err?.killed && err?.signal) return { status: "failed", error: "cmux timed out after 10000ms" };
				const stderr = err?.stderr ?? String(err);
				return { status: "failed", error: redactError(stderr, workerPath, config.manifestPath) };
			}
			if (!createResult.ok) {
				return { status: "failed", error: redactError(createResult.stderr, workerPath, config.manifestPath) };
			}

			// REQ-5 + REQ-5a: best-effort agentName metadata.
			// cmux limitation: no analog of tmux's `set-window-option @pi_*`
			// exists in cmux 0.64.17 (no `set-extension-option`, no user-options
			// surface on `workspace create`). The runId is encoded into the
			// workspace name above; agentName has no equivalent carrier and is
			// intentionally NOT persisted. Documented as a known cmux gap.
			// If a future cmux release adds a user-option flag, prefer that
			// over encoding agentName into the workspace name (collision risk).
			// Intentionally no-op: keep the launch contract symmetric with the
			// tmux backend, but skip the call since cmux has no equivalent.

			// cmux 0.64.17 `workspace create` writes `OK <handle>` to stdout,
			// where `<handle>` is the workspace's opaque ref (e.g.
			// `workspace:3`, or a UUID with `--id-format uuids`). The leading
			// `OK ` token is a status prefix — cmux prints it on every
			// mutating command (also `workspace close`, `rename`, etc.) and
			// it is NOT accepted by subsequent cmux commands. Strip it so the
			// returned windowId is reusable as a handle for `close-workspace`/
			// `workspace list`. If cmux prints something we don't recognize
			// (older builds, or the call short-circuited), fall back to the
			// title we just set via `--name` — `isAlive`/`list` still match
			// on title.
			let handle = createResult.stdout.trim();
			const okPrefixMatch = handle.match(/^OK\s+(\S+)\s*$/);
			if (okPrefixMatch) handle = okPrefixMatch[1];
			return { status: "ok", windowId: handle || workspaceName };
		},

		async kill(windowId: string): Promise<TermBgResult> {
			// cmux 0.64.17: use `close-workspace --workspace <id|ref|index>` to
			// kill a SINGLE workspace. `close-window --window <id>` would close
			// the ENTIRE window (and all workspaces inside it), which is the
			// wrong scope when several pi agents live in the same window.
			try {
				const result = await executor.exec(["close-workspace", "--workspace", windowId], { timeoutMs: 5_000 });
				if (!result.ok) {
					const stderr = result.stderr ?? "";
					// Idempotent: closing a missing window is not an error.
					if (stderr.includes("not found")) {
						return { status: "ok", windowId };
					}
					return { status: "failed", error: stderr || "kill failed" };
				}
				return { status: "ok", windowId };
			} catch (err: any) {
				const stderr = String(err?.stderr ?? "");
				if (stderr.includes("not found")) {
					return { status: "ok", windowId };
				}
				return { status: "failed", error: stderr || "kill failed" };
			}
		},

		async isAlive(windowId: string): Promise<boolean> {
			if (!windowId) return false;
			// cmux 0.64.17 canonical command. Legacy `list-workspaces` is
			// deprecated and prints a one-time hint pointing to `workspace list`.
			try {
				const { stdout } = await executor.exec(["workspace", "list", "--json"], { timeoutMs: 5_000 });
				let parsed: any;
				try {
					parsed = JSON.parse(stdout);
				} catch {
					return false;
				}
				const workspaces = Array.isArray(parsed?.workspaces) ? parsed.workspaces : (Array.isArray(parsed) ? parsed : []);
				// cmux JSON shape: { workspaces: [{ ref, title, ... }, ...] }.
				// We match against BOTH `ref` (the opaque handle that launch()
				// returns when `workspace create` prints `OK <ref>` to stdout) and
				// `title` (the --name we passed; the only thing we have when
				// stdout is empty and launch() falls back to the title as
				// windowId). Exact-match semantics — never substring match (REQ:
				// bg-terminal.ts interface).
				return workspaces.some(function _m(ws: any) {
					if (!ws) return false;
					if (typeof ws.ref === "string" && ws.ref === windowId) return true;
					if (typeof ws.title === "string" && ws.title === windowId) return true;
					return false;
				});
			} catch {
				return false;
			}
		},

		async list(): Promise<TermBgWindowEntry[]> {
			try {
				const { stdout } = await executor.exec(["workspace", "list", "--json"], { timeoutMs: 5_000 });
				let parsed: any;
				try {
					parsed = JSON.parse(stdout);
				} catch {
					return [];
				}
				const workspaces = Array.isArray(parsed?.workspaces) ? parsed.workspaces : (Array.isArray(parsed) ? parsed : []);
				const entries: TermBgWindowEntry[] = [];
				for (const ws of workspaces) {
					if (!ws || typeof ws.title !== "string") continue;
					const title: string = ws.title;
					if (!title.startsWith(CMUX_WINDOW_PREFIX)) continue;
					// runId = strip prefix; if a workspace was renamed or the
					// title doesn't carry our prefix, skip rather than guess.
					const runId = title.slice(CMUX_WINDOW_PREFIX.length);
					if (!runId) continue;
					entries.push({
						windowId: title,
						runId,
						// agentName is intentionally undefined: cmux limitation
						// (no user-options equivalent) means we cannot recover
						// the agent name from cmux state.
						agentName: undefined,
					});
				}
				return entries;
			} catch {
				return [];
			}
		},
	};
}
