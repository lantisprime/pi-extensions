// tmux-control: discover the tmux server socket to talk to.
//
// Strategy (matches the agents extension's tmux-terminal backend):
//   1. If $TMUX is set, parse the socket path. Format:
//        <socket-path>,<pid>,<session-id>
//      e.g. "/tmp/tmux-501/default,12345,0"
//   2. Otherwise probe the user's default socket: /tmp/tmux-<uid>/default
//   3. The caller may also pass `-L <socket>` to force an isolated server.
//
// All callers receive a TmuxArgvPrefix that should be prepended to every
// tmux invocation. For the user's main server: ["-S", socket]. For an
// isolated server: ["-L", socket].
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type TmuxArgvPrefix = string[];

export function defaultSocketPath(): string {
	return path.join(os.tmpdir(), `tmux-${os.userInfo().uid}`, "default");
}

export function socketFromTmuxEnv(): string | null {
	const raw = process.env.TMUX;
	if (!raw) return null;
	const first = raw.split(",")[0];
	if (!first) return null;
	return first;
}

/**
 * Return argv prefix to reach the user's main tmux server.
 * - $TMUX socket if set and exists
 * - default socket (/tmp/tmux-<uid>/default) if reachable
 * - null if no reachable server (caller should report "tmux not running")
 */
export function discoverMainServerPrefix(): TmuxArgvPrefix | null {
	const fromEnv = socketFromTmuxEnv();
	if (fromEnv && fs.existsSync(fromEnv)) return ["-S", fromEnv];
	const def = defaultSocketPath();
	if (fs.existsSync(def)) return ["-S", def];
	return null;
}

/**
 * Return argv prefix for an isolated server (`tmux -L <socket>`).
 * Does NOT check existence — the caller will start the server if needed.
 */
export function isolatedServerPrefix(socket: string): TmuxArgvPrefix {
	return ["-L", socket];
}