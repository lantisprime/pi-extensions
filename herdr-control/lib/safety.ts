// herdr-control: name/ref/key safety validation.
import { AGENT_NAME_RE, PANE_REF_RE } from "./constants.ts";

export function isValidAgentName(name: string): boolean {
	return AGENT_NAME_RE.test(name);
}

export function matchesPrefix(name: string, prefix: string): boolean {
	if (!prefix) return true; // empty prefix = allow all (caller opted in)
	return name.startsWith(prefix);
}

export function isPaneRef(raw: string): boolean {
	return PANE_REF_RE.test(raw);
}

export function requirePaneRef(raw: string): { ok: true; ref: string } | { ok: false; error: string } {
	if (!isPaneRef(raw)) return { ok: false, error: `invalid herdr pane ref: ${raw} (expected w<N>:p<N>)` };
	return { ok: true, ref: raw };
}

// herdr validates key names itself; we pre-filter defensively so the LLM can
// only send a bounded allowlist of logical keys / modifier chords.
const SIMPLE_KEY_RE = /^[a-z][a-z0-9]{0,11}$/;
const CHORD_KEY_RE = /^(?:ctrl|alt|shift|meta)(?:\+[a-z0-9]{1,11}){1,2}$/;
const KNOWN_KEYS = new Set([
	"esc", "escape", "enter", "return", "tab", "space", "backspace", "delete",
	"up", "down", "left", "right", "home", "end", "pageup", "pagedown",
	"insert", "btab",
]);

export function validateKeyTokens(keys: string): { ok: true; tokens: string[] } | { ok: false; error: string } {
	const tokens = keys.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { ok: false, error: "no keys provided" };
	if (tokens.length > 8) return { ok: false, error: `too many keys (${tokens.length}); send at most 8 at a time` };
	for (const token of tokens) {
		const lower = token.toLowerCase();
		if (KNOWN_KEYS.has(lower)) continue;
		if (SIMPLE_KEY_RE.test(lower)) continue;
		if (CHORD_KEY_RE.test(lower)) continue;
		return { ok: false, error: `key not allowed: "${token}" (use logical keys like esc, enter, up, ctrl+c)` };
	}
	return { ok: true, tokens: tokens.map((t) => t.toLowerCase()) };
}

// Entry gate: herdr control only makes sense from inside a herdr pane, where
// --current / HERDR_PANE_ID resolve to the calling terminal.
export function insideHerdr(): boolean {
	return process.env.HERDR_ENV === "1";
}

export function herdrGateError(): string {
	return (
		"not running inside a herdr pane (HERDR_ENV!=1). " +
		"Start herdr and launch pi inside it, or use tmux/cmux tooling instead."
	);
}
