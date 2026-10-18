// Bounded steering strings. Every function here is pure and returns text at or
// below its budget. The gate reason is the only place a rule is spelled out;
// the standing line is constant.

import type { PackageSpec } from "./types.ts";

export const STANDING_LINE = "[workflow] plan → tests → PR · commits are gated until changed packages are green · /workflow status";
export const STANDING_LINE_DISABLED = "[workflow] enforcement OFF for this session · /workflow enforce on";
export const MAX_STANDING_BYTES = 180;
export const MAX_DELTA_BYTES = 240;
export const MAX_REASON_BYTES = 400;

export function truncateBytes(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= maxBytes) return text;
	const sliced = buffer.subarray(0, Math.max(0, maxBytes - 3)).toString("utf8");
	// Avoid splitting a multi-byte code point at the cut.
	return `${sliced.replace(/\uFFFD+$/u, "")}…`;
}

export function clamp(text: string, maxBytes: number): string {
	return truncateBytes(text.trim(), maxBytes);
}

export function standingLine(enforcing: boolean): string {
	return enforcing ? STANDING_LINE : STANDING_LINE_DISABLED;
}

/** First dirty package + count only: bounded regardless of package count. */
export function deltaLine(dirty: PackageSpec[]): string | null {
	if (dirty.length === 0) return null;
	const first = dirty[0];
	const more = dirty.length > 1 ? ` (+${dirty.length - 1} more)` : "";
	return clamp(`[workflow] tests not green since edits: ${first.glob}${more} · run: ${first.test}`, MAX_DELTA_BYTES);
}

/** Actionable one-liner for a blocked commit; names the exact command. */
export function gateReason(dirty: PackageSpec[]): string {
	if (dirty.length === 0) return "";
	const first = dirty[0];
	const more = dirty.length > 1 ? ` (+${dirty.length - 1} more package${dirty.length > 2 ? "s" : ""})` : "";
	return clamp(
		`blocked: no green test since edits in ${first.glob}${more}. Run: ${first.test}. ` +
			`Then retry. Override once with: /workflow override <reason>`,
		MAX_REASON_BYTES,
	);
}

export function protectedReason(target: string): string {
	return clamp(`blocked: ${target} is operator-owned steering. Ask the operator to confirm this change.`, MAX_REASON_BYTES);
}

export function enforcementStatus(enforcing: boolean): string {
	return enforcing ? "workflow: enforce on (G1+G2)" : "workflow: enforce OFF (session)";
}
