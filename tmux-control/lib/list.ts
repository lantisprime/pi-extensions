// tmux-control: list windows matching the prefix.
//
// Returns `{ sessionName, windowName, runId, agentName }` per match.
// Crucially, callers must use `sessionName:windowIndex` (not bare window name)
// when addressing the window via tmux commands — see capture.ts / send.ts for
// why (ambiguity when multiple sessions exist with same-named windows).
//
// Format: `tmux list-windows -a -F '#{session_name} #{window_index} #{window_name} #{@pi_run_id} #{@pi_agent_name}'`
// Filter to prefix matches BEFORE returning so the caller never sees
// unrelated windows.
import type { TmuxExecutor } from "./exec.ts";
import { TMUX_INVOCATION_TIMEOUT_MS } from "./constants.ts";
import { matchesPrefix } from "./safety.ts";

export interface ListedWindow {
	sessionName: string;
	windowIndex: string; // tmux's window_index is a string like "1", "2", ...
	windowName: string;
	runId?: string;
	agentName?: string;
}

export async function listAgentWindows(
	executor: TmuxExecutor,
	socketPrefix: string[],
	prefix: string,
	timeoutMs = TMUX_INVOCATION_TIMEOUT_MS,
): Promise<ListedWindow[]> {
	const result = await executor.exec(
		[...socketPrefix, "list-windows", "-a", "-F", "#{session_name} #{window_index} #{window_name} #{@pi_run_id} #{@pi_agent_name}"],
		{ timeoutMs },
	);
	if (!result.ok) return [];
	const out: ListedWindow[] = [];
	for (const line of result.stdout.split("\n")) {
		if (!line) continue;
		const parts = line.split(" ");
		const sessionName = parts[0] ?? "";
		const windowIndex = parts[1] ?? "";
		const windowName = parts[2] ?? "";
		if (!matchesPrefix(windowName, prefix)) continue;
		const runId = parts[3];
		const agentName = parts[4];
		out.push({
			sessionName,
			windowIndex,
			windowName,
			runId: runId || undefined,
			agentName: agentName || undefined,
		});
	}
	return out;
}

/** Build the tmux target string for a (session, window) pair. */
export function tmuxTarget(w: { sessionName: string; windowIndex: string }): string {
	return `${w.sessionName}:${w.windowIndex}`;
}