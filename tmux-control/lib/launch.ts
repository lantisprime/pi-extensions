// tmux-control: launch a tmux session (for arbitrary use, NOT agents).
//
// Distinct from /agents bg: this spawns a tmux session running an arbitrary
// command (or just a shell). The agents extension owns the bg-launch flow
// (signed manifests, reservation lifecycle). This is the general-purpose
// "spawn a tmux session" capability.
//
// Args are passed argv-only — no shell parsing. If `command` is provided,
// it's joined with single spaces and passed as the command argument to
// `tmux new-session -d -s <name> <command>`. tmux itself invokes the
// command via $SHELL -c, so shell metacharacters within `command` ARE
// interpreted by the user's shell — that's a deliberate trade-off for
// being able to launch pipelines like "npm run dev | tee /tmp/log".
import type { TmuxExecutor } from "./exec.ts";
import { TMUX_INVOCATION_TIMEOUT_MS } from "./constants.ts";
import { isValidWindowName } from "./safety.ts";

export interface LaunchResult {
	ok: boolean;
	sessionName?: string;
	error?: string;
}

export async function launchSession(
	executor: TmuxExecutor,
	socketPrefix: string[],
	name: string,
	command?: string,
): Promise<LaunchResult> {
	if (!isValidWindowName(name)) return { ok: false, error: `invalid session name: "${name}"` };

	const args: string[] = [...socketPrefix, "new-session", "-d", "-s", name];
	if (command) args.push(command);

	const result = await executor.exec(args, { timeoutMs: TMUX_INVOCATION_TIMEOUT_MS });
	if (!result.ok) {
		return { ok: false, error: result.stderr || `new-session failed (exit ${result.exitCode})` };
	}
	return { ok: true, sessionName: name };
}