// smart-compaction/lib/engine.ts — pure cost model + trigger evaluation.
//
// Spec: .plans/COMPACT/spec.md@474c6e30 (AC-2..AC-5, AC-8)
// Design: .plans/COMPACT/design.md@0787b4a8 §TriggerEngine (v2), §Savings formula (v2)
//
// No pi imports here — everything is data in / decision out, so the math is
// unit-testable without a running pi (COMPACT-4).

import type { Prices, Profile, Tier } from "./profiles.ts";

// ---------- pure math (AC-2) ----------

/** Tier containing `tokens` (tiers sorted by upTo ascending; last = infinity). */
export function tierFor(tiers: Tier[], tokens: number): Tier | undefined {
	for (const t of tiers) {
		if (tokens <= t.upTo) return t;
	}
	return tiers.length > 0 ? tiers[tiers.length - 1] : undefined;
}

/** Cost in dollars of sending `tokens` input tokens, spread across tiers.
 * Tokens beyond a finite last tier are priced at the last tier's rate. */
export function inputCost(prices: Prices, tiers: Tier[], tokens: number): number {
	if (tokens <= 0) return 0;
	if (tiers.length === 0) return (tokens / 1_000_000) * prices.input;
	let cost = 0;
	let prev = 0;
	let remaining = tokens;
	for (let i = 0; i < tiers.length; i++) {
		const t = tiers[i];
		const isLast = i === tiers.length - 1;
		const span = t.upTo === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : t.upTo - prev;
		const inTier = isLast && t.upTo !== Number.POSITIVE_INFINITY ? remaining : Math.min(remaining, span);
		if (inTier > 0) cost += (inTier / 1_000_000) * prices.input * t.inputMult;
		remaining -= inTier;
		prev = t.upTo;
		if (remaining <= 0) break;
	}
	return cost;
}

// ---------- runtime state ----------

export interface EngineState {
	/** Date.now() of last assistant message_end with usage (cache-state clock). */
	lastLLMCallAt: number | null;
	/** "provider/id" the cache state belongs to; reset on model switch. */
	cacheModelKey: string | null;
	/** True after model_select until the next assistant usage (old tokenizer). */
	tokensStale: boolean;
	/** EMA of per-turn context growth (tokens), for tier prediction. */
	growthPerTurn: number | null;
	lastTurnTokens: number | null;
	/** Turns since the last compaction of ANY origin (pi's or ours). */
	turnsSinceCompaction: number;
	/**
	 * Context size immediately before the last successful compaction, or null if
	 * none has happened this session. Drives the post-compaction growth gap.
	 */
	lastCompactionTokens: number | null;
	/** pi's most recent cache-warming decision. */
	recentWarm: { at: number; continuationProbability: number } | null;
	turnCounter: number;
}

export function initState(): EngineState {
	return {
		lastLLMCallAt: null,
		cacheModelKey: null,
		tokensStale: true,
		growthPerTurn: null,
		lastTurnTokens: null,
		turnsSinceCompaction: 0,
		lastCompactionTokens: null,
		recentWarm: null,
		turnCounter: 0,
	};
}

// ---------- evaluation ----------

/**
 * Horizon cap shared by the fire condition and the savings integral. Extracted
 * so the two cannot drift: the pressure gate fires when the context reaches
 * the next trigger line within this many turns, and savings are integrated
 * over the same horizon.
 */
export const HORIZON_CAP = 50;

/** pi keepRecent default (engine-level assumption; the profile does not know the session setting). */
const KEEP_RECENT_TOKENS = 20_000;

/**
 * Next line the context would regret crossing: the first tier-2 pricing
 * boundary when it still lies ahead, else pi's overflow line.
 */
export function nextTriggerLine(profile: Profile, tokens: number, window: number, reserveTokens: number): number {
	const boundary =
		profile.tiers[0] && Number.isFinite(profile.tiers[0].upTo) && tokens < profile.tiers[0].upTo
			? profile.tiers[0].upTo
			: undefined;
	return boundary ?? window - reserveTokens;
}

/**
 * Summarizer output estimate: fixed override when configured, else ~5% of the
 * context, clamped to the live-observed range (2,010-10,464 tokens across 15
 * real compactions, 2026-10-03/04 telemetry; the flat 2,000 assumption
 * under-counted large sessions ~5x).
 */
export function estimateSummaryTokens(tokens: number, fixed?: number): number {
	if (fixed != null) return fixed;
	return Math.min(10_000, Math.max(2_000, Math.round(tokens * 0.05)));
}

export interface EvalInput {
	profile: Profile;
	prices: Prices;
	config: {
		reserveTokens: number;
		continuationProbability: number;
		tierSafety: number;
		/** Multiplier required on savings vs cost to act (default 1.25). */
		marginFactor?: number;
		/** Estimated summary output tokens (default 2000). */
		summaryTokens?: number;
	};
	state: EngineState;
	/** From ctx.getContextUsage() — null tokens must no-op (AC-8). */
	usage: { tokens: number | null; contextWindow: number } | undefined;
	now: number;
	/** Live model key — cache state from another model does not apply (AC-11). */
	modelKey?: string;
	/** Cache state override for tests; defaults to ttlShort vs lastLLMCallAt. */
	cacheHot?: boolean;
	/**
	 * False when the model catalog carried no positive price field — the
	 * economy math would then run on fabricated fallback prices. Economy
	 * declines (design "Model profiles": economy trigger disabled, AC-10);
	 * explicit config defaultPrices / profile prices opt back in.
	 */
	pricingKnown?: boolean;
}

export type Decision =
	| { kind: "none"; why: string }
	| {
			kind: "economy";
			cacheHot: boolean;
			savings: number;
			cost: number;
			continuationProbability: number;
			horizonTurns: number;
	  }
	| { kind: "warn-overflow"; tokens: number; line: number }
	| { kind: "warn-tier"; tokens: number; boundary: number; projected: number }
	| { kind: "quality"; tokens: number; line: number };

/** Cache hot = same model, last LLM call within ttlShort. */
export function isCacheHot(input: EvalInput): boolean {
	if (input.profile.mode === "quality") return false;
	if (input.state.cacheModelKey === null || input.state.lastLLMCallAt === null) return false;
	if (input.modelKey !== undefined && input.state.cacheModelKey !== input.modelKey) return false;
	const ttl = input.profile.cache.ttlShort;
	if (ttl <= 0) return false;
	return input.now - input.state.lastLLMCallAt < ttl * 1000;
}

/**
 * Overflow / tier early-warning evaluation — runs at turn_end (observation
 * plane; never compacts directly, design v2 A1/A4).
 */
export function evaluateWarnings(input: EvalInput): Decision {
	const { usage, state, profile, config } = input;
	if (!usage || usage.tokens === null) return { kind: "none", why: "no-usage" };
	if (state.tokensStale) return { kind: "none", why: "tokens-stale-after-model-switch" };
	const tokens = usage.tokens;
	const window = usage.contextWindow;

	// overflow line: pi compacts at window - reserve; warn when at/near it.
	const line = window - config.reserveTokens;
	if (tokens >= line) return { kind: "warn-overflow", tokens, line };

	// tier crossing: current below the first finite boundary, projected above it.
	const boundary = profile.tiers[0]?.upTo;
	if (boundary !== undefined && Number.isFinite(boundary) && tokens < boundary) {
		const growth = Math.max(state.growthPerTurn ?? 0, 0) * config.tierSafety;
		const projected = tokens + growth;
		if (projected >= boundary) {
			return { kind: "warn-tier", tokens, boundary, projected };
		}
	}
	return { kind: "none", why: "no-warning" };
}

/**
 * Economy evaluation — runs ONLY at agent_settled + idle (design v2 A1).
 * Returns economy decision when savings > cost × margin, subject to
 * minInterval + tokenFloor guards (AC-3, AC-8).
 */
export function evaluateEconomy(input: EvalInput): Decision {
	const { usage, state, profile, config } = input;
	if (!usage || usage.tokens === null) return { kind: "none", why: "no-usage" };
	if (state.tokensStale) return { kind: "none", why: "tokens-stale-after-model-switch" };
	if (input.pricingKnown === false) {
		return {
			kind: "none",
			why: "pricing-unknown (catalog has no positive price fields; set config.defaultPrices or a profile prices block to opt in)",
		};
	}
	const tokens = usage.tokens;
	const window = usage.contextWindow;

	const minInterval = profile.compaction.minIntervalTurns;
	if (state.turnsSinceCompaction < minInterval) {
		return { kind: "none", why: `min-interval (${state.turnsSinceCompaction}/${minInterval})` };
	}
	// Effective floor respects pi's keepRecent budget: a context below keep+margin
	// has nothing to summarize (pi fails with "session too small"). The window
	// fraction keeps a flat tokenFloor from firing on a large context window.
	const windowFloor = profile.compaction.floorFraction ? window * profile.compaction.floorFraction : 0;
	const keepRecentFloor = 24_000;
	const effectiveFloor = Math.max(profile.compaction.tokenFloor, windowFloor, keepRecentFloor);
	if (tokens < effectiveFloor) {
		// Name the binding constraint, not merely the first one in the max: a
		// keepRecentFloor of 24k outranks a smaller tokenFloor, and reporting
		// "tokenFloor" there sent live debugging after a setting that was not
		// actually in force.
		const driver =
			windowFloor >= effectiveFloor ? "window-floor" : keepRecentFloor >= effectiveFloor ? "keepRecent floor" : "tokenFloor";
		return { kind: "none", why: `below ${driver} (${tokens} < ${Math.round(effectiveFloor)})` };
	}

	// Post-compaction gap. A compaction that barely shrank the context leaves the
	// floor satisfied almost immediately, so without this the economy path
	// re-compacts the same material every few turns for near-zero net saving.
	// Opt-in at the engine level: a profile that does not set minGapTokens gets
	// no gap guard. Note GENERIC_PROFILE is the merge *base* for every profile
	// (mergeProfile), so an unset value normally arrives as GENERIC's default
	// rather than undefined; a profile opts out by setting minGapTokens: 0.
	const minGap = profile.compaction.minGapTokens ?? 0;
	// A watermark at or beyond pi's overflow line can never be regrown past, so
	// it must not be allowed to silence the economy path for the rest of the
	// session. Treat it as "no gap recorded".
	const overflowLine = window - (config.reserveTokens ?? 0);
	const gapFrom = state.lastCompactionTokens != null && state.lastCompactionTokens < overflowLine
		? state.lastCompactionTokens
		: null;
	if (minGap > 0 && gapFrom != null && tokens < gapFrom + minGap) {
		return {
			kind: "none",
			why: `post-compaction gap (${tokens} < ${gapFrom} + ${minGap})`,
		};
	}

	// quality mode: fixed line at settled time, cache math skipped (AC-5 vacuous).
	if (profile.mode === "quality") {
		const ql = (profile.compaction.qualityLine ?? 0.5) * window;
		if (tokens > ql) return { kind: "quality", tokens, line: ql };
		return { kind: "none", why: `below qualityLine (${tokens} <= ${ql})` };
	}

	// Fire line (2026-10-04 amendment): compaction is rational when the context
	// is large enough that retention, latency, and cache-read costs outweigh its
	// lossiness — the SAME qualityLine concept quality mode already used, now
	// shared by every mode (default 0.5×window). Compacting there means the
	// summarizer still sees coherent recent work (better retention than a rotten
	// near-overflow context), the session returns to the fast low-context
	// regime, and the compaction runs WITH task-aware focus instructions
	// (session_before_compact enriches pi's uninstructed ~98% catch-up, design
	// A4 — that remains the backstop). The savings arithmetic cannot gate: for a
	// flat-priced hot model savings/cost ≈ cont × H × (shrink/tokens) ×
	// (cacheRead/input) ≈ 3 at ANY size past the floor (live: fired at 158,732
	// tokens = 15.1% of a 1M window, floor+1,446), so the line is the policy and
	// the margin test below is only a sanity check. Tiered models may also fire
	// once the expensive tier regime is already active (design D4) even below
	// the line. Sits AFTER the quality branch: quality mode fires on the same
	// line via its own path and must not be double-gated.
	const fireLine = (profile.compaction.qualityLine ?? 0.5) * window;
	const regimeActive =
		profile.tiers[0] !== undefined && Number.isFinite(profile.tiers[0].upTo) && tokens >= profile.tiers[0].upTo;
	if (tokens < fireLine && !regimeActive) {
		return {
			kind: "none",
			why: `below fire-line (${tokens} < ${Math.round(fireLine)} = (qualityLine ?? 0.5)×${window}; compaction waits for the context-quality line)`,
		};
	}

	const hot = input.cacheHot ?? isCacheHot(input);
	const continuation = state.recentWarm ? state.recentWarm.continuationProbability : config.continuationProbability;
	const margin = config.marginFactor ?? 1.25;
	const summaryTokens = estimateSummaryTokens(tokens, config.summaryTokens);
	const { savings, cost, horizonTurns } = savingsEstimate(input, tokens, window, hot, continuation, summaryTokens);

	// Defense in depth. resolvePrices already refuses an all-zero catalog, so this
	// should be unreachable — but if pricing ever degenerates again, the gate would
	// compare 0 > 0 and decline forever while looking like an ordinary "no warning".
	// Report it as the distinct, actionable condition it is instead of failing
	// silently.
	if (savings === 0 && cost === 0) {
		return {
			kind: "none",
			why: "pricing-unavailable (savings and cost are both 0 — every resolved price is zero; set config.defaultPrices to restore the economy gate)",
		};
	}

	if (savings > cost * margin) {
		return { kind: "economy", cacheHot: hot, savings, cost, continuationProbability: continuation, horizonTurns };
	}
	return {
		kind: "none",
		why: `savings $${savings.toFixed(4)} <= cost $${cost.toFixed(4)} × ${margin} (tokens=${tokens}, growth=${input.state.growthPerTurn?.toFixed(0) ?? "null"}, hot=${hot}, H=${horizonTurns}, cont=${continuation.toFixed(2)})`,
	};
}

/**
 * v2 savings formula (design A2): no output term; hot-cache marginal is the
 * cacheRead price; horizon = turns to regrow to the next trigger line;
 * continuationProbability gates everything.
 */
export function savingsEstimate(
	input: EvalInput,
	tokens: number,
	window: number,
	hot: boolean,
	continuation: number,
	summaryTokens: number,
): { savings: number; cost: number; horizonTurns: number } {
	const { profile, prices, config, state } = input;
	const tiers = profile.tiers;
	const keepTokens = Math.min(KEEP_RECENT_TOKENS, tokens); // pi keepRecentTokens default
	const afterTokens = keepTokens + summaryTokens;

	// Compaction cost: summarize tokensBefore + write the summary, then the
	// next call rebuilds (kept + summary) — write premium applies when hot.
	// The summary call is priced at FULL input even when the conversation cache
	// is hot: pi's summarizer request shape does not hit the conversation cache
	// (live usage on 14 compactions 2026-10-03: cacheRead ≈ 370 of 403k input).
	const summaryInputCost = inputCost(prices, tiers, tokens);
	const summaryOutputCost = (summaryTokens / 1_000_000) * prices.output;
	const rebuildCost = hot
		? (afterTokens / 1_000_000) * prices.cacheWrite // re-write (kept+summary) into the provider cache
		: (afterTokens / 1_000_000) * prices.input; // cold: full-price rebuild happens anyway
	const cost = summaryInputCost + summaryOutputCost + rebuildCost;

	// Horizon: turns to regrow back to the next trigger line (self-consistent).
	// No growth observed → no regrowth → economy savings are 0; tier/overflow
	// rules cover those cases instead (spec AC-3 rationale).
	const growth = state.growthPerTurn;
	if (growth == null) return { savings: 0, cost, horizonTurns: 0 };
	const g = Math.max(growth, 250); // dampen sub-250 turn growth to a floor
	// (quality mode never reaches here: evaluateEconomy returns before the formula.)
	const nextLine = nextTriggerLine(profile, tokens, window, config.reserveTokens);
	const horizonTurns = Math.min(HORIZON_CAP, Math.max(1, Math.ceil(Math.max(nextLine - afterTokens, 0) / g)));

	// Marginal savings of carrying (tokens − afterTokens) fewer tokens over the
	// horizon (review part-2 fix):
	//   hot: every future call re-reads the shrink at the (flat) cache-read rate.
	//   cold: the NEXT call pays full price on the shrink once, then it caches.
	// Tier effects apply only through full-price calls — covered by the tier
	// term below, not by multiplying the whole shrink at tier-2 rates.
	const shrink = tokens - afterTokens;
	let marginalSavings: number;
	if (hot) {
		marginalSavings = horizonTurns * (shrink / 1_000_000) * prices.cacheRead;
	} else {
		marginalSavings = (shrink / 1_000_000) * (prices.input + (horizonTurns - 1) * prices.cacheRead);
	}
	let savings = continuation * marginalSavings;

	// Tier avoidance: only the shrink that lies ABOVE the boundary earns the
	// tier-2 delta (the [afterTokens, boundary) part saves tier-1 money).
	const boundary = tiers[0] && Number.isFinite(tiers[0].upTo) ? tiers[0].upTo : undefined;
	if (boundary !== undefined && tokens > boundary && afterTokens < boundary) {
		const aboveTier = tierFor(tiers, boundary + 1);
		const delta = prices.input * ((aboveTier?.inputMult ?? tiers[0].inputMult) - tiers[0].inputMult);
		const aboveShrink = tokens - boundary; // shrink ∩ above-boundary span
		savings += continuation * horizonTurns * (aboveShrink / 1_000_000) * delta;
	}

	return { savings, cost, horizonTurns };
}

/** Focus instructions for extension-initiated compaction (AC-6 pairing). */
export function focusInstructions(gateAction: "aggressive" | "focused", subjects: string[]): string {
	if (gateAction === "aggressive") {
		return (
			"Compact aggressively: keep only a minimal summary. The summarized context is " +
			"largely unrelated to the current tasks" +
			(subjects.length ? ` (${subjects.join("; ")})` : "") +
			". Preserve any single line that does mention them."
		);
	}
	return (
		"Preserve ALL information related to the current tasks" +
		(subjects.length ? `: ${subjects.join("; ")}` : "") +
		". " +
		"Record task-related facts as structured lists, NOT prose — summaries retain tabulated facts and " +
		"lose prose (needle-eval evidence, 2026-10-04). The summary must keep, verbatim where possible: " +
		"exact identifiers, constants and their values, file paths, branch/PR names, exact commands, " +
		"decisions WITH their rationale, and open questions. " +
		"Summarize unrelated content more briefly."
	);
}
