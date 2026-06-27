// tmux-control: runId → windowId bridge.
//
// Resolution strategy (in order):
//   1. Dynamic import `agents/lib/bg-terminal.ts` → call getBgTerminalBackend()
//      → if backend exists, call backend.list() and match by runId.
//   2. Fall back to prefix-match: windowName === `${prefix}${runId}`.
//   3. Fall back to bare tmux list-windows scan.
//
// (1) is preferred because it uses the agents extension's authoritative
// runId→windowId mapping. (2) and (3) work without the agents extension
// loaded, or if no backend is registered.
import type { TmuxExecutor } from "./exec.ts";
import { listAgentWindows } from "./list.ts";
import { matchesPrefix } from "./safety.ts";
import { DEFAULT_WINDOW_PREFIX } from "./constants.ts";

export interface ResolvedWindow {
	sessionName: string;
	windowIndex: string;
	windowName: string;
	runId?: string;
	agentName?: string;
	source: "backend" | "prefix-match" | "tmux-scan";
}

export type ResolveResult =
	| { ok: true; window: ResolvedWindow }
	| { ok: false; error: string };

/** Dynamically import agents/lib/bg-terminal.ts. Returns null if the
 *  agents extension is not loaded or the file is not resolvable. */
async function tryLoadBackend(): Promise<{ list(): Promise<Array<{ windowId: string; runId?: string; agentName?: string }>> } | null> {
	try {
		// Dynamic import resolves relative to THIS module's location.
		// `agents` is expected to be a sibling directory of `tmux-control`.
		const url = new URL("../../agents/lib/bg-terminal.ts", import.meta.url);
		const mod = await import(url.href);
		const getBgTerminalBackend = mod?.getBgTerminalBackend;
		if (typeof getBgTerminalBackend !== "function") return null;
		const backend = getBgTerminalBackend();
		if (!backend || typeof backend.list !== "function") return null;
		return backend;
	} catch {
		return null;
	}
}

export async function resolveRunId(
	runId: string,
	executor: TmuxExecutor,
	socketPrefix: string[],
	opts?: { prefix?: string; trustProject?: boolean },
): Promise<ResolveResult> {
	const prefix = opts?.prefix ?? DEFAULT_WINDOW_PREFIX;

	// (1) Backend list (authoritative)
	const backend = await tryLoadBackend();
	if (backend) {
		try {
			const entries = await backend.list();
			const match = entries.find((e) => e.runId === runId);
			if (match && match.windowId) {
				// Backend-supplied windowId is opaque; it's expected to be either
				// a full session:window target or a window_id like @42. Pass it
				// through verbatim — capture/send will need a follow-up lookup if
				// it turns out to be a bare name.
				return {
					ok: true,
					window: {
						sessionName: "?",
						windowIndex: "?",
						windowName: match.windowId,
						runId,
						agentName: match.agentName,
						source: "backend",
					},
				};
			}
		} catch {
			// fall through to prefix-match
		}
	}

	// (2) Prefix-match (works without backend)
	const candidate = prefix + runId;
	if (!matchesPrefix(candidate, prefix)) {
		return { ok: false, error: `runId "${runId}" would produce window "${candidate}" which doesn't match prefix "${prefix}"` };
	}

	// (3) tmux scan to confirm existence
	const windows = await listAgentWindows(executor, socketPrefix, prefix);
	const found = windows.find((w) => w.windowName === candidate);
	if (found) {
		return { ok: true, window: { ...found, source: "prefix-match" } };
	}

	return { ok: false, error: `no window found for runId "${runId}" (tried backend list, prefix-match "${candidate}")` };
}