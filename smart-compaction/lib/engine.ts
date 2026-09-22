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
		recentWarm: null,
		turnCounter: 0,
	};
}

// ---------- evaluation ----------

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
	const tokens = usage.tokens;
	const window = usage.contextWindow;

	const minInterval = profile.compaction.minIntervalTurns;
	if (state.turnsSinceCompaction < minInterval) {
		return { kind: "none", why: `min-interval (${state.turnsSinceCompaction}/${minInterval})` };
	}
	// Effective floor respects pi's keepRecent budget: a context below keep+margin
	// has nothing to summarize (pi fails with "session too small").
	const effectiveFloor = Math.max(profile.compaction.tokenFloor, 24_000);
	if (tokens < effectiveFloor) {
		return { kind: "none", why: `below tokenFloor (${tokens} < ${effectiveFloor})` };
	}

	// quality mode: fixed line at settled time, cache math skipped (AC-5 vacuous).
	if (profile.mode === "quality") {
		const ql = (profile.compaction.qualityLine ?? 0.5) * window;
		if (tokens > ql) return { kind: "quality", tokens, line: ql };
		return { kind: "none", why: `below qualityLine (${tokens} <= ${ql})` };
	}

	const hot = input.cacheHot ?? isCacheHot(input);
	const continuation = state.recentWarm ? state.recentWarm.continuationProbability : config.continuationProbability;
	const margin = config.marginFactor ?? 1.25;
	const summaryTokens = config.summaryTokens ?? 2000;
	const { savings, cost, horizonTurns } = savingsEstimate(input, tokens, window, hot, continuation, summaryTokens);

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
	const keepTokens = Math.min(20_000, tokens); // pi keepRecentTokens default
	const afterTokens = keepTokens + summaryTokens;

	// Compaction cost: summarize tokensBefore + write the summary, then the
	// next call rebuilds (kept + summary) — write premium applies when hot.
	const summaryInputCost = inputCost(prices, tiers, tokens);
	const summaryOutputCost = (summaryTokens / 1_000_000) * prices.output;
	const rebuildCost = hot
		? (afterTokens / 1_000_000) * prices.input * profile.cache.writePremium
		: (afterTokens / 1_000_000) * prices.input; // cold: full-price rebuild happens anyway
	const cost = summaryInputCost + summaryOutputCost + rebuildCost;

	// Horizon: turns to regrow back to the next trigger line (self-consistent).
	// No growth observed → no regrowth → economy savings are 0; tier/overflow
	// rules cover those cases instead (spec AC-3 rationale).
	const growth = state.growthPerTurn;
	if (growth == null) return { savings: 0, cost, horizonTurns: 0 };
	const g = Math.max(growth, 250); // dampen sub-250 turn growth to a floor
	// (quality mode never reaches here: evaluateEconomy returns before the formula.)
	const nextLine =
		tiers[0] && Number.isFinite(tiers[0].upTo) && tokens < tiers[0].upTo
			? tiers[0].upTo
			: window - config.reserveTokens;
	const horizonTurns = Math.min(50, Math.max(1, Math.ceil(Math.max(nextLine - afterTokens, 0) / g)));

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
		". Include open questions, decisions, file paths, and exact commands tied to those tasks. " +
		"Summarize unrelated content more briefly."
	);
}
