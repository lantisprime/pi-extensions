// cmux-control: runId -> workspaceRef bridge.
//
// Resolution strategy (in order):
//   1. Dynamic import `agents/lib/bg-terminal.ts` -> call
//      selectBgTerminalBackend() -> if the selected backend is cmux, call
//      backend.list() and match by runId.
//   2. Fall back to cmux workspace prefix-match:
//      workspace title === `${prefix}${runId}`.
import type { CmuxExecutor } from "./exec.ts";
import { CMUX_INVOCATION_TIMEOUT_MS, DEFAULT_CMUX_PREFIX } from "./constants.ts";

export type CmuxResolveResult =
	| { ok: true; workspaceRef: string; agentName?: string; source: string }
	| { ok: false; error: string };

type CmuxBackend = {
	name?: string;
	list(): Promise<Array<{ windowId: string; runId?: string; agentName?: string }>>;
};

type TryLoadCmuxBackendResult =
	| { ok: true; backend: CmuxBackend }
	| { ok: false; error: string }
	| { ok: false; unavailable: true };

/** Try to dynamically load the bg-terminal backend. Returns the selected cmux
 *  backend, an explicit wrong-backend error, or unavailable for fallback. */
async function tryLoadCmuxBackend(): Promise<TryLoadCmuxBackendResult> {
	try {
		// Dynamic import resolves relative to THIS module's location.
		// `agents` is expected to be a sibling directory of `cmux-control`.
		const url = new URL("../../agents/lib/bg-terminal.ts", import.meta.url);
		const mod = await import(url.href);
		const selectBgTerminalBackend = mod?.selectBgTerminalBackend;
		if (typeof selectBgTerminalBackend !== "function") return { ok: false, unavailable: true };
		const selected = await selectBgTerminalBackend();
		const backend = selected?.ok === true ? selected.backend : null;
		if (!backend || typeof backend.list !== "function") return { ok: false, unavailable: true };
		if (backend.name !== "cmux") {
			return { ok: false, error: `selected background terminal backend is "${backend.name ?? "unknown"}", not "cmux"` };
		}
		return { ok: true, backend };
	} catch {
		return { ok: false, unavailable: true };
	}
}

function workspaceEntries(stdout: string): Array<{ ref?: string; title?: string; name?: string }> {
	try {
		const parsed = JSON.parse(stdout);
		if (Array.isArray(parsed)) return parsed;
		if (Array.isArray(parsed?.workspaces)) return parsed.workspaces;
		return [];
	} catch {
		return [];
	}
}

function workspaceRefFor(entry: { ref?: string; title?: string; name?: string }): string | null {
	if (typeof entry.ref === "string" && entry.ref.length > 0) return entry.ref;
	if (typeof entry.title === "string" && entry.title.length > 0) return entry.title;
	if (typeof entry.name === "string" && entry.name.length > 0) return entry.name;
	return null;
}

export async function resolveRunId(
	runId: string,
	executor: CmuxExecutor,
	opts?: { prefix?: string },
): Promise<CmuxResolveResult> {
	const prefix = opts?.prefix ?? DEFAULT_CMUX_PREFIX;

	const backendResult = await tryLoadCmuxBackend();
	if (!backendResult.ok && "error" in backendResult) return { ok: false, error: backendResult.error };
	if (backendResult.ok) {
		try {
			const entries = await backendResult.backend.list();
			const match = entries.find((entry) => entry.runId === runId);
			if (match?.windowId) {
				return {
					ok: true,
					workspaceRef: match.windowId,
					agentName: match.agentName,
					source: "backend",
				};
			}
		} catch {
			// fall through to prefix-match
		}
	}

	const candidate = prefix + runId;
	try {
		const result = await executor.exec(["workspace", "list", "--json"], { timeoutMs: CMUX_INVOCATION_TIMEOUT_MS });
		if (result.ok) {
			const found = workspaceEntries(result.stdout).find((entry) => entry.title === candidate || entry.name === candidate);
			const workspaceRef = found ? workspaceRefFor(found) : null;
			if (workspaceRef) return { ok: true, workspaceRef, source: "prefix-match" };
		}
	} catch {
		// fall through to not found
	}

	return { ok: false, error: `no workspace found for runId "${runId}" (tried backend list, prefix-match "${candidate}")` };
}
