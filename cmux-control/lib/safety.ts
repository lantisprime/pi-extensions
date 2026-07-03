// cmux-control: reference and workspace-name safety validation.

export const DEFAULT_CMUX_PREFIX = "pi-cmux-";

export interface CmuxRef {
	type: "workspace" | "surface" | "pane";
	id: number;
}

const CMUX_REF_RE = /^(workspace|surface|pane):(\d+)$/;

export function parseCmuxRef(raw: string): CmuxRef | null {
	const match = CMUX_REF_RE.exec(raw);
	if (!match) return null;

	const id = Number(match[2]);
	if (!Number.isSafeInteger(id) || id <= 0) return null;

	return { type: match[1] as CmuxRef["type"], id };
}

export function requireCmuxRef(raw: string, expected: "workspace" | "surface" | "pane"): CmuxRef | { error: string } {
	const ref = parseCmuxRef(raw);
	if (!ref) return { error: `invalid cmux ref: ${raw}` };
	if (ref.type !== expected) return { error: `expected ${expected} ref, got ${ref.type} ref: ${raw}` };
	return ref;
}

export function matchesPrefix(name: string, prefix = DEFAULT_CMUX_PREFIX): boolean {
	if (!prefix) return true; // empty prefix = allow all (caller opted in)
	return name.startsWith(prefix);
}

export function isValidWorkspaceName(name: string): boolean {
	// cmux workspace names: any non-empty string up to cmux's limits; we also
	// forbid shell metacharacters defensively.
	if (!name || name.length > 256) return false;
	if (/[\s"'`$\\;|&<>(){}!]/.test(name)) return false;
	return true;
}
