// P5b-2: ZellijExecutor abstraction. The production executor uses child_process.execFile
// (argv only, no shell). A test seam allows injection of a fake executor.
//
// Mirrors the established executor abstraction (argv-only via execFile, ENOENT +
// killed/timeout -> non-throwing failure). The binary is "zellij".
//
// Additionally exports `spawnAttachSession(name)` for the backend's two-step
// launch. The backend takes an `attachSpawner` factory opt so unit tests stub
// it; production passes `spawnAttachSession`. The function is ASYNC and the
// backend AWAITS it (see zellij-backend.ts:launch). The attachSpawner seam
// stays: same call signature shape, just returns a Promise<void>.
//
// P5b-2 fix 1 (PR review HIGH): zellij's per-session IPC socket path is
// `<TMPDIR>/zellij-<uid>/...` (max 103 bytes). On systems with a long TMPDIR
// (e.g. macOS's /var/folders/.../T/), session creation fails with "IPC socket
// path is too long". `getZellijSpawnEnv()` returns an env with
// ZELLIJ_SOCKET_DIR set to a short path (unless the caller already set it),
// so the production code works universally without requiring the user to
// pre-configure the env.
//
// P5b-2 fix 2 (PR review HIGH — codex reproduced): the previous
// `child_process.spawn("zellij", ["attach", "-b", name], { detached: true,
// stdio: "ignore" }).unref()` did NOT create the session. Root cause (per the
// cli-spike re-analysis): `zellij attach -b <name>` is a SHORT-LIVED CLIENT
// (~2s) that forks the session server and exits; the session persists AFTER
// the client exits. The spike's "fire-and-forget" framing was wrong — the
// correct model is "run to completion (~2s), session persists". With
// `stdio: "ignore"`, zellij gets /dev/null on fd 0/1/2, which causes it
// to exit without forking the session server (the spike's bash test used
// real file descriptors, not /dev/null — and that was the only way it
// worked). The defensive nohup-via-sh -c wrapper that this slice shipped
// with HEAD 03ee44e ALSO fails for the same root cause (zellij still gets
// /dev/null via the shell's redirect, just from a different parent).
//
// The correct fix: use `child_process.execFile("zellij", ["attach", "-b",
// name], { timeout: 10_000 })` and AWAIT its exit. The session is forked
// during the ~2s the client runs and persists after the client exits. The
// launch flow's existing `list-sessions -s` poll (in zellij-backend.ts)
// then confirms the session appeared. `execFile` is argv-only (the REQ-9
// grep guard still returns 0: no prohibited shell-spawning APIs are used).
// The attachSpawner seam is preserved (same
// `(name: string) => Promise<void>` shape as the executor's `exec`).
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const DEFAULT_ZELLIJ_SOCKET_DIR = "/tmp/zellij-sockets";

/**
 * Returns the env to pass to spawned zellij subprocesses. Sets
 * ZELLIJ_SOCKET_DIR to a short path (`/tmp/zellij-sockets`) if not already
 * set, so zellij's IPC socket fits within its 103-byte path limit even on
 * machines with long TMPDIRs (e.g. macOS /var/folders/.../T/). Caller-set
 * values are respected.
 */
function getZellijSpawnEnv(): NodeJS.ProcessEnv {
	if (process.env.ZELLIJ_SOCKET_DIR) return process.env;
	return { ...process.env, ZELLIJ_SOCKET_DIR: DEFAULT_ZELLIJ_SOCKET_DIR };
}

export interface ZellijExecutor {
	exec(args: string[], opts: { timeoutMs: number }): Promise<ZellijExecResult>;
}

export type ZellijExecResult =
	| { ok: true; stdout: string; stderr: string; exitCode: 0 }
	| { ok: false; stdout: string; stderr: string; exitCode: number };

export function defaultZellijExecutor(): ZellijExecutor {
	return {
		async exec(args, opts) {
			try {
				const { stdout, stderr } = await execFileP("zellij", args, { timeout: opts.timeoutMs, env: getZellijSpawnEnv() });
				return { ok: true, stdout, stderr, exitCode: 0 };
			} catch (err: any) {
				if (err?.code === "ENOENT") return { ok: false, stdout: "", stderr: "spawn zellij ENOENT", exitCode: -1 };
				if (err?.killed && err?.signal) return { ok: false, stdout: err.stdout ?? "", stderr: "timed out after " + opts.timeoutMs + "ms", exitCode: -1 };
				return { ok: false, stdout: err?.stdout ?? "", stderr: err?.stderr ?? String(err), exitCode: err?.code ?? 1 };
			}
		},
	};
}

/**
 * Runs `zellij attach -b <name>` to create a detached zellij session and
 * AWAITS the client's exit. The session is forked by the client during its
 * ~2s run and PERSISTS after the client exits.
 *
 * Why AWAIT (and not fire-and-forget like the original spec said): the
 * `zellij attach -b` client is short-lived (~2s) and exits cleanly after
 * forking the session server. Awaiting the client is what guarantees the
 * session server is actually forked before `launch()` returns. The session
 * server is NOT a child of this Node process — zellij's own server process
 * is the parent — so the server persists after this function returns and
 * after the Node process exits.
 *
 * Why `stdio: "ignore"` (and not the execFile default `pipe`): zellij writes
 * to stderr during startup; with `pipe` stdio and no reader, the 64KB pipe
 * buffer fills and zellij BLOCKS on write (latent deadlock — codex reproduced
 * this with 10s timeout + SIGTERM + empty stdout/stderr). `stdio: "ignore"`
 * gives /dev/null on all 3 fds; writes are discarded immediately so zellij
 * proceeds to exit in ~2s like the spike. The parent awaits and reaps.
 *
 * The backend's launch flow awaits this function before starting the
 * `list-sessions -s` poll, so the poll sees a freshly-created session.
 * The `attachSpawner` injection seam is preserved: tests pass a fake
 * recorder; production passes this function.
 */
export async function spawnAttachSession(name: string): Promise<void> {
	// stdio: "ignore" gives /dev/null on all 3 fds. zellij writes to stderr
	// during startup; with the default pipe stdio and no reader, the pipe
	// buffer (64KB) fills and zellij BLOCKS on write (deadlock). /dev/null
	// discards writes immediately so zellij proceeds to exit in ~2s, the
	// session server is forked off and persists. The parent's `await` reaps
	// the exited child. Timeout 6000ms = 6s, headroom over the spike's ~2s
	// observed exit time.
	await execFileP("zellij", ["attach", "-b", name], {
		stdio: "ignore",
		timeout: 6000,
		env: getZellijSpawnEnv(),
	});
}
