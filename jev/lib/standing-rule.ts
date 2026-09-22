// Jev standing rule: the chain-of-thought hook.
//
// The `jev_ask` tool description and Guidelines bullets only help once the model
// is already looking at the tool. The tasks extension solved the same problem
// for task discipline with a constant standing rule appended to the system
// prompt on every turn — this module gives Jev the same mechanism.
//
// Pure logic, no pi imports, so tests can run it hermetically.

import type { JevAvailability } from "./availability.ts";

/**
 * Constant standing rule — appended to the system prompt on every turn while
 * Jev is known-available, so grounded-judgement routing is known from turn one.
 * Bounded and fixed: no per-turn growth, cache-friendly after first inclusion.
 */
export const JEV_STANDING_RULE_TEXT =
	"[jev] Rule: for grounded judgement — ranking candidates, verifying a claim against evidence, scoring along levels — gather candidates with grep/find/read first, then make ONE jev_ask call with packed questions over bounded state.";

/**
 * What (if anything) to append to the system prompt this turn. Fail-safe in the
 * same direction as availability itself: an unknown, stale, or negative probe
 * means no rule, because advertising a judgement tool the gateway cannot serve
 * burns turns on failed calls. The tool's own short-circuit message covers
 * mid-session outages after the rule is already in place.
 */
export function standingRuleAppend(availability: JevAvailability): string | undefined {
	return availability.available ? JEV_STANDING_RULE_TEXT : undefined;
}
