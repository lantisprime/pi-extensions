// tmux-control: window name safety validation.
//
// Hard invariant: send-keys must never target windows whose names don't
// match the configured prefix. Without this, a typo or hostile input could
// type into the user's shell window (which would be catastrophic).
//
// The default prefix `pi-agent-` matches every window created by the
// agents extension's tmux-terminal backend (it names windows `pi-agent-<runId>`).
// Users can override with /tmux-config prefix <value>.
import { DEFAULT_WINDOW_PREFIX } from "./constants.ts";

export function isValidWindowName(name: string): boolean {
	// tmux window names: any non-empty string up to tmux's limits; we also
	// forbid shell metacharacters defensively.
	if (!name || name.length > 256) return false;
	if (/[\s"'`$\\;|&<>(){}!]/.test(name)) return false;
	return true;
}

export function matchesPrefix(name: string, prefix: string): boolean {
	if (!prefix) return true; // empty prefix = allow all (caller opted in)
	return name.startsWith(prefix);
}

/**
 * Resolve a user-supplied identifier (runId, windowId, or window name)
 * to a session-qualified target, validating against the safety prefix.
 *
 * Returns { target: { sessionName, windowIndex } } on success, or { error }.
 */
export interface ResolvedTarget {
	sessionName: string;
	windowIndex: string;
	windowName: string;
}

export function resolveTarget(
	id: string,
	knownWindows: Array<{ sessionName: string; windowIndex: string; windowName: string }>,
	opts: { prefix: string; allowUnprefixed?: boolean },
): { target: ResolvedTarget } | { error: string } {
	if (!id) return { error: "empty window identifier" };
	if (!isValidWindowName(id)) return { error: `invalid window identifier: ${id}` };

	// Exact match first (safest).
	const exact = knownWindows.find((w) => w.windowName === id);
	if (exact) {
		if (!opts.allowUnprefixed && !matchesPrefix(exact.windowName, opts.prefix)) {
			return { error: `window "${exact.windowName}" does not match prefix "${opts.prefix}" (use --force to override)` };
		}
		return { target: exact };
	}

	// runId-style: full window name is `${prefix}${id}`. Only allowed if id
	// looks like a runId (no prefix chars).
	const candidate = opts.prefix + id;
	const found = knownWindows.find((w) => w.windowName === candidate);
	if (found) {
		return { target: found };
	}

	return { error: `no window matched "${id}" (tried exact and "${candidate}")` };
}

/** Backward-compat alias for older call sites. */
export function resolveWindowName(
	id: string,
	knownWindows: string[],
	opts: { prefix: string; allowUnprefixed?: boolean },
): { windowName: string } | { error: string } {
	const r = resolveTarget(
		id,
		knownWindows.map((w) => (typeof w === "string" ? { sessionName: "?", windowIndex: "?", windowName: w } : w)),
		opts,
	);
	if ("error" in r) return r;
	return { windowName: r.target.windowName };
}