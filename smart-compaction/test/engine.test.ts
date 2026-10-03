// smart-compaction/test/engine.test.ts — unit tests for AC-2, AC-3, AC-5, AC-8, AC-12.
// Run: node --test test/engine.test.ts

import assert from "node:assert/strict";
import test from "node:test";
import {
	evaluateEconomy,
	evaluateWarnings,
	focusInstructions,
	initState,
	inputCost,
	isCacheHot,
	savingsEstimate,
	tierFor,
	type EvalInput,
} from "../lib/engine.ts";
import { heuristicRelevance, mapAction } from "../lib/gate.ts";
import { BUILTIN_PROFILES, globMatch, loadConfig, resolvePrices, resolveProfile } from "../lib/profiles.ts";

const GEMINI_TIERS = [
	{ upTo: 200_000, inputMult: 1, outputMult: 1 },
	{ upTo: Number.POSITIVE_INFINITY, inputMult: 2, outputMult: 1.5 },
];
const P2 = { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 }; // gemini-3.1-pro-like

test("AC-2: tierFor picks correct tier", () => {
	assert.equal(tierFor(GEMINI_TIERS, 200_000)?.inputMult, 1);
	assert.equal(tierFor(GEMINI_TIERS, 200_001)?.inputMult, 2);
	assert.equal(tierFor([], 500_000), undefined);
});

test("AC-2: inputCost blends tiers (gemini-3.1-pro shape)", () => {
	// 250k tokens at $2/M base: 200k×$2 + 50k×$4 per M = 0.4 + 0.2 = $0.60
	assert.ok(Math.abs(inputCost(P2, GEMINI_TIERS, 250_000) - 0.6) < 1e-9);
	// 100k tokens: all tier 1 = 0.1 × $2 = $0.20
	assert.ok(Math.abs(inputCost(P2, GEMINI_TIERS, 100_000) - 0.2) < 1e-9);
	// no tiers: flat
	assert.ok(Math.abs(inputCost(P2, [], 1_000_000) - 2) < 1e-9);
});

function baseInput(over: Partial<EvalInput> = {}): EvalInput {
	const state = initState();
	state.tokensStale = false; // simulate: assistant usage has been seen
	return {
		profile: {
			match: "test/model",
			mode: "cost",
			tiers: GEMINI_TIERS,
			cache: { readRatio: 0.1, writePremium: 0, ttlShort: 300, ttlLong: 3600 },
			compaction: { tokenFloor: 40_000, minIntervalTurns: 4 },
			gate: { enabled: true, aggressiveBelow: 0.35, deferAbove: 0.7 },
		},
		prices: P2,
		config: { reserveTokens: 16_384, continuationProbability: 0.7, tierSafety: 1.5 },
		state,
		usage: { tokens: 250_000, contextWindow: 1_048_576 },
		now: 1_000_000,
		modelKey: "test/model",
		...over,
	};
}

test("AC-8: guards — null usage, stale tokens, min-interval, tokenFloor", () => {
	assert.equal(evaluateEconomy(baseInput({ usage: { tokens: null, contextWindow: 1_000_000 } })).kind, "none");
	const stale = baseInput();
	stale.state.tokensStale = true;
	const dStale = evaluateEconomy(stale);
	assert.equal(dStale.kind, "none");
	assert.ok((dStale as { why: string }).why.includes("stale"));

	const interval = baseInput();
	interval.state.turnsSinceCompaction = 2; // < 4
	const dInterval = evaluateEconomy(interval);
	assert.ok((dInterval as { why: string }).why.includes("min-interval"));

	const floor = baseInput({ usage: { tokens: 23_000, contextWindow: 1_000_000 } });
	floor.state.turnsSinceCompaction = 10; // past min-interval so the floor guard is what fires
	const dFloor = evaluateEconomy(floor);
	assert.ok((dFloor as { why: string }).why.includes("tokenFloor"));
});

test("economy floor scales with the context window, not just a flat token count", () => {
	// baseline recipe that the suite already proves selects a compaction
	const mk = (over?: Partial<EvalInput>) => {
		const input = baseInput(over);
		input.state.turnsSinceCompaction = 10;
		input.state.growthPerTurn = 5_000;
		return input;
	};

	// No floorFraction: unchanged behaviour.
	assert.equal(evaluateEconomy(mk()).kind, "economy");

	// 0.4 of a 1M window is a 419k floor, so 250k must NOT compact. A flat 40k
	// floor would have let this through.
	const strict = mk();
	strict.profile.compaction.floorFraction = 0.4;
	const dStrict = evaluateEconomy(strict);
	assert.equal(dStrict.kind, "none");
	assert.ok((dStrict as { why: string }).why.includes("window-floor"));

	// 0.2 of a 1M window is a 209k floor, which 250k clears.
	const loose = mk();
	loose.profile.compaction.floorFraction = 0.2;
	assert.equal(evaluateEconomy(loose).kind, "economy");

	// Relative, not absolute: 0.4 of a 200k window is an 80k floor, so 60k is
	// held back there too.
	const smallWindow = mk({ usage: { tokens: 60_000, contextWindow: 200_000 } });
	smallWindow.profile.compaction.floorFraction = 0.4;
	const dSmall = evaluateEconomy(smallWindow);
	assert.equal(dSmall.kind, "none");
	assert.ok((dSmall as { why: string }).why.includes("window-floor"));
});

test("post-compaction gap stops near-zero-savings recompaction churn", () => {
	const mk = (lastCompactionTokens: number | null) => {
		const input = baseInput();
		input.state.turnsSinceCompaction = 10;
		input.state.growthPerTurn = 5_000;
		input.profile.compaction.minGapTokens = 20_000;
		input.state.lastCompactionTokens = lastCompactionTokens;
		return evaluateEconomy(input);
	};

	// Nothing compacted yet this session → guard is vacuous.
	assert.equal(mk(null).kind, "economy");

	// Compacted at 245k, context is 250k — only 5k of regrowth, so wait.
	const inGap = mk(245_000);
	assert.equal(inGap.kind, "none");
	assert.ok((inGap as { why: string }).why.includes("post-compaction gap"));

	// Regrown 50k past the last compaction → proceeds.
	assert.equal(mk(200_000).kind, "economy");

	// The churn case: the context is smaller than it was when last compacted, so
	// re-compacting it would reclaim almost nothing.
	assert.equal(mk(300_000).kind, "none");

	// Inert when minGapTokens is unset → pre-existing behaviour preserved.
	const noGap = baseInput();
	noGap.state.turnsSinceCompaction = 10;
	noGap.state.growthPerTurn = 5_000;
	noGap.state.lastCompactionTokens = 300_000;
	assert.equal(evaluateEconomy(noGap).kind, "economy");

	// Never a permanent wedge: a watermark at or beyond pi's overflow line
	// (window - reserveTokens) can never be regrown past, so it must be ignored
	// rather than silencing economy for the rest of the session. config here is
	// the baseInput default, reserveTokens 16_384, so the line is 1_032_192.
	const atOverflow = baseInput();
	atOverflow.state.turnsSinceCompaction = 10;
	atOverflow.state.growthPerTurn = 5_000;
	atOverflow.profile.compaction.minGapTokens = 20_000;
	atOverflow.state.lastCompactionTokens = 1_032_192;
	assert.equal(evaluateEconomy(atOverflow).kind, "economy");
});

test("tokenFloor still blocks in the band the window fraction does not cover", () => {
	// 30k sits above the 24k keepRecent minimum but below a 40k tokenFloor, and
	// no floorFraction is set. Without tokenFloor in the max this would compact.
	const input = baseInput({ usage: { tokens: 30_000, contextWindow: 1_048_576 } });
	input.state.turnsSinceCompaction = 10;
	input.state.growthPerTurn = 5_000;
	assert.equal(input.profile.compaction.floorFraction, undefined);
	const d = evaluateEconomy(input);
	assert.equal(d.kind, "none");
	assert.ok((d as { why: string }).why.includes("tokenFloor"));
});

test("the shipped generic profile actually stops the observed compaction treadmill", () => {
	// Production shape: an unmatched model falls through to GENERIC_PROFILE, and
	// observed sessions compacted repeatedly at 44k-61k on a 200k window. Resolve
	// the profile the way the extension does, so the merge path (GENERIC is the
	// base for every profile, not just a fallback) is covered too.
	const resolved = resolveProfile("litellm", "minimax-m3.1-flash-preview", loadConfig());
	const profile = "profile" in resolved ? resolved.profile : resolved;
	assert.equal(profile.compaction.floorFraction, 0.4);
	assert.equal(profile.compaction.minGapTokens, 20_000);

	// Every context size observed in the treadmill must now decline.
	for (const tokens of [44_740, 46_479, 58_691, 60_472, 61_223]) {
		const input = baseInput({ usage: { tokens, contextWindow: 200_000 } });
		input.profile = profile;
		input.state.turnsSinceCompaction = 50; // far past any min-interval
		input.state.growthPerTurn = 5_000;
		const d = evaluateEconomy(input);
		assert.equal(d.kind, "none", `${tokens} tokens on a 200k window should not compact`);
		assert.ok((d as { why: string }).why.includes("window-floor"));
	}

	// A context that genuinely needs reclaiming still compacts.
	const big = baseInput({ usage: { tokens: 180_000, contextWindow: 200_000 } });
	big.profile = profile;
	big.state.turnsSinceCompaction = 50;
	big.state.growthPerTurn = 5_000;
	assert.equal(evaluateEconomy(big).kind, "economy");
});

test("AC-5: cache hot/cold detection", () => {
	const hot = baseInput();
	hot.state.lastLLMCallAt = 1_000_000 - 60_000; // 60s ago < 300s TTL
	hot.state.cacheModelKey = "test/model";
	assert.equal(isCacheHot(hot), true);
	const cold = baseInput();
	cold.state.lastLLMCallAt = 1_000_000 - 600_000; // 10min ago > TTL
	cold.state.cacheModelKey = "test/model";
	assert.equal(isCacheHot(cold), false);
	const otherModel = baseInput();
	otherModel.state.lastLLMCallAt = 1_000_000 - 60_000;
	otherModel.state.cacheModelKey = "other/model";
	assert.equal(isCacheHot(otherModel), false); // model switch = cold
});

test("AC-3: economy fires past boundary with margin, uses continuation", () => {
	const input = baseInput();
	input.state.turnsSinceCompaction = 10;
	input.state.growthPerTurn = 5_000;
	// force cheap summary cost scenario: savings driven by tier avoidance
	const d = evaluateEconomy(input);
	// at 250k with growth, tier avoidance should make savings exceed cost
	assert.equal(d.kind, "economy");
	const eco = d as Extract<typeof d, { kind: "economy" }>;
	assert.equal(eco.continuationProbability, 0.7);
	assert.ok(eco.savings > eco.cost * 1.25);
});

test("AC-3: economy suppressed when savings tiny (small context, hot cache)", () => {
	const input = baseInput({
		usage: { tokens: 45_000, contextWindow: 1_000_000 },
	});
	input.state.turnsSinceCompaction = 10;
	input.state.lastLLMCallAt = 1_000_000 - 10_000;
	input.state.cacheModelKey = "test/model";
	// 45k tokens: all tier-1, hot cache: marginal = cacheRead; tiny savings
	const d = evaluateEconomy(input);
	assert.equal(d.kind, "none");
});

test("v2 formula: no output term in savings; hot-cache marginal is cacheRead", () => {
	const input = baseInput();
	input.state.turnsSinceCompaction = 10;
	input.state.growthPerTurn = 5_000; // observed growth: economy math applies
	const hot = savingsEstimate(input, 250_000, 1_048_576, true, 1, 2000);
	const cold = savingsEstimate(input, 250_000, 1_048_576, false, 1, 2000);
	// cold must include the full-price rebuild-avoidance term → strictly larger
	assert.ok(cold.savings > hot.savings);
	// with continuation 0 savings must be 0
	const zero = savingsEstimate(input, 250_000, 1_048_576, true, 0, 2000);
	assert.equal(zero.savings, 0);
	// no growth observed → no speculative savings
	const noGrowth = baseInput();
	noGrowth.state.turnsSinceCompaction = 10;
	assert.equal(savingsEstimate(noGrowth, 250_000, 1_048_576, true, 1, 2000).savings, 0);
});

test("warnings: tier prediction + overflow line", () => {
	const input = baseInput({ usage: { tokens: 180_000, contextWindow: 1_048_576 } });
	input.state.growthPerTurn = 30_000; // projected 210k > 200k boundary
	const dTier = evaluateWarnings(input);
	assert.equal(dTier.kind, "warn-tier");
	assert.equal((dTier as { boundary: number }).boundary, 200_000);

	const overflow = baseInput({ usage: { tokens: 1_048_576 - 16_384, contextWindow: 1_048_576 } });
	assert.equal(evaluateWarnings(overflow).kind, "warn-overflow");

	const calm = baseInput({ usage: { tokens: 100_000, contextWindow: 1_048_576 } });
	assert.equal(evaluateWarnings(calm).kind, "none");
});

test("AC-12: profile resolution precedence", () => {
	// builtin family
	const gemini = resolveProfile("google", "gemini-3.1-pro", loadConfig());
	assert.equal(gemini.source, "builtin");
	assert.equal(gemini.profile.mode, "cost");
	// claude family
	const claude = resolveProfile("anthropic", "claude-sonnet-4-5", loadConfig());
	assert.equal(claude.profile.mode, "balanced");
	assert.equal(claude.profile.cache.writePremium, 1.25);
	// local family → quality
	const local = resolveProfile("litellm", "qwen3-coder-30b-local_mlx", loadConfig());
	assert.equal(local.profile.mode, "quality");
	// generic
	const unknown = resolveProfile("weird", "model-x", loadConfig());
	assert.equal(unknown.source, "generic");
	// config exact beats builtin
	const cfg = loadConfig();
	cfg.profiles = [{ match: "google/gemini-3.1-pro", mode: "balanced", tiers: [] }];
	const exact = resolveProfile("google", "gemini-3.1-pro", cfg);
	assert.equal(exact.source, "config-exact");
	assert.equal(exact.profile.mode, "balanced");
	// config glob order: first listed wins
	const cfg2 = loadConfig();
	cfg2.profiles = [
		{ match: "litellm/mini*", mode: "quality" },
		{ match: "litellm/*", mode: "cost" },
	];
	assert.equal(resolveProfile("litellm", "minimax", cfg2).profile.mode, "quality");
});

test("AC-12: price resolution precedence", () => {
	const prof = BUILTIN_PROFILES[0]; // gemini, readRatio 0.1
	const cfg = loadConfig();
	// catalog present: input/output win; cacheRead derived from ratio
	const p1 = resolvePrices({ input: 2, output: 12 }, prof, cfg);
	assert.equal(p1.input, 2);
	assert.equal(p1.output, 12);
	assert.ok(Math.abs(p1.cacheRead - 0.2) < 1e-9);
	assert.equal(p1.cacheWrite, 0); // writePremium 0
	// no catalog: config defaultPrices then profile.prices
	const cfg2 = loadConfig();
	cfg2.defaultPrices = { input: 1, output: 3 };
	const p2 = resolvePrices(undefined, { ...prof, prices: { input: 5 } }, cfg2);
	assert.equal(p2.input, 5); // profile beats config defaults
});

test("AC-12: an all-zero catalog is treated as ABSENT, not as a free model", () => {
	const prof = BUILTIN_PROFILES[0];
	const cfg = loadConfig();
	// Regression: a LiteLLM-proxied model reported cost {0,0,0,0}. resolvePrices
	// honoured those zeros, so the economy gate computed savings 0 and cost 0 and
	// compared 0 > 0 — permanently false, so compaction never fired and the only
	// trace was "savings $0.0000 <= cost $0.0000". An all-zero catalog means "no
	// pricing data", so it must fall through to the generic prices.
	const zeroed = resolvePrices({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, prof, cfg);
	const absent = resolvePrices(undefined, prof, cfg);
	assert.deepEqual(zeroed, absent, "all-zero catalog must resolve identically to an absent one");
	assert.ok(zeroed.input > 0, "input price must not stay 0 — that is what killed the gate");
	// null must behave the same way (the live path passed null in one build).
	assert.deepEqual(resolvePrices(null, prof, cfg), absent);
	// A PARTIAL catalog is still honoured field-by-field: a real zero alongside a
	// real price is meaningful data, not a missing catalog.
	const partial = resolvePrices({ input: 3, output: 9, cacheRead: 0, cacheWrite: 0 }, prof, cfg);
	assert.equal(partial.input, 3);
	assert.equal(partial.output, 9);
	assert.equal(partial.cacheRead, 0, "an explicit 0 cacheRead on a priced model is real and must survive");
});

test("economy gate fires for a proxied model with an all-zero catalog", () => {
	// End-to-end shape of the live failure: 55k tokens (well past the 40k floor),
	// cache hot, growth 400/turn. Before the fix this returned
	// "savings $0.0000 <= cost $0.0000" forever; it must now decide.
	const prof = { mode: "balanced", cache: { readRatio: 0.1, writePremium: 1.25, ttlShort: 300, ttlLong: 3600 }, tiers: [], compaction: { minIntervalTurns: 4, tokenFloor: 40_000, qualityLine: 0.5 } } as never;
	const config = { reserveTokens: 20_000, marginFactor: 1.25, summaryTokens: 2000 } as never;
	const prices = resolvePrices({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, prof, config);
	const input = {
		usage: { tokens: 55_000, contextWindow: 1_000_000 },
		state: { turnsSinceCompaction: 50, growthPerTurn: 400, tokensStale: false, recentWarm: { continuationProbability: 0.7 } },
		profile: prof, prices, config, modelKey: "litellm/proxied", cacheHot: true,
	} as never;
	const d = evaluateEconomy(input);
	assert.equal(d.kind, "economy", `expected compaction to be selected, got ${JSON.stringify(d)}`);
});

test("degenerate all-zero pricing is reported, not silently declined", () => {
	// If prices ever degenerate again, the gate must SAY so rather than compare
	// 0 > 0 and look like an ordinary no-warning.
	const prof = { mode: "balanced", cache: { readRatio: 0.1, writePremium: 0, ttlShort: 300, ttlLong: 3600 }, tiers: [], compaction: { minIntervalTurns: 4, tokenFloor: 40_000, qualityLine: 0.5 } } as never;
	const config = { reserveTokens: 20_000, marginFactor: 1.25, summaryTokens: 2000 } as never;
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as never;
	const input = {
		usage: { tokens: 55_000, contextWindow: 1_000_000 },
		state: { turnsSinceCompaction: 50, growthPerTurn: 400, tokensStale: false, recentWarm: { continuationProbability: 0.7 } },
		profile: prof, prices: zero, config, modelKey: "x", cacheHot: true,
	} as never;
	const d = evaluateEconomy(input);
	assert.equal(d.kind, "none");
	assert.match((d as { why: string }).why, /pricing-unavailable/);
});

test("AC-6: gate mapping thresholds", () => {
	const gate = { enabled: true, aggressiveBelow: 0.35, deferAbove: 0.7 };
	assert.equal(mapAction(0.2, gate), "aggressive");
	assert.equal(mapAction(0.5, gate), "focused");
	assert.equal(mapAction(0.9, gate), "defer");
	assert.equal(mapAction(0.9, { ...gate, enabled: false }), "focused");
});

test("AC-6: heuristic relevance sanity", () => {
	const p1 = heuristicRelevance(["fix the auth login bug in session.ts"], "we edited session.ts to fix the login bug; auth now works");
	const p2 = heuristicRelevance(["fix the auth login bug in session.ts"], "refactor the pricing page styles and update README badges");
	assert.ok(p1 > p2);
	assert.equal(heuristicRelevance([], "anything"), 0.5);
});

test("focus instructions reference tasks when focused", () => {
	const fi = focusInstructions("focused", ["Implement smart-compaction plugin"]);
	assert.ok(fi.includes("Implement smart-compaction plugin"));
	const ag = focusInstructions("aggressive", []);
	assert.ok(ag.includes("aggressively"));
});

test("glob semantics (family patterns match model ids, full-string)", () => {
	assert.equal(globMatch("gemini-*-pro*", "gemini-3.1-pro"), true);
	assert.equal(globMatch("*-local_mlx", "qwen3-coder-30b-local_mlx"), true);
	assert.equal(globMatch("exact", "exact"), true);
	assert.equal(globMatch("exact", "exact2"), false);
});

// ---- part-2 review (LESSON-2): regression + gap tests ----

test("part-2 fix: tierAvoided counts only the above-boundary shrink (was ~5.6x inflated)", () => {
	const input = baseInput();
	input.state.turnsSinceCompaction = 10;
	input.state.growthPerTurn = 5_000;
	// hot, cacheRead 0.2: marginal = H×shrink×cRead + tier term aboveShrink×delta
	// H=50, shrink=228000, boundary=200000 → aboveShrink=50000, delta=2×(2−1)=2
	const { savings } = savingsEstimate(input, 250_000, 1_048_576, true, 1, 2000);
	const expected = 50 * (228_000 / 1e6) * 0.2 + 50 * (50_000 / 1e6) * 2;
	assert.ok(Math.abs(savings - expected) < 1e-9, `savings ${savings} != ${expected}`);
});

test("part-2 fix: cold savings = one full-price turn + (H−1) cached turns (no +1 double-count)", () => {
	const input = baseInput();
	input.state.turnsSinceCompaction = 10;
	input.state.growthPerTurn = 5_000;
	// H=1 (force: growth so large that nextLine−afterTokens fits in one turn)
	input.state.growthPerTurn = 5_000_000;
	const { savings } = savingsEstimate(input, 250_000, 1_048_576, false, 1, 2000);
	// H=1 cold: 1 full-price turn on the shrink, plus the tier term (H=1):
	// shrink×input = 0.456, aboveShrink(50000)×delta(2)/1e6 = 0.1 → 0.556
	const expected = 0.456 + 0.1;
	assert.ok(Math.abs(savings - expected) < 1e-9, `savings ${savings} != ${expected}`);
});

test("part-2 gap: inputCost prices tokens beyond a finite last tier at last-tier rate", () => {
	const tiers = [{ upTo: 1_000, inputMult: 1, outputMult: 1 }];
	// 1500 tokens, $1/M base: last finite tier must absorb the tail → 0.0015
	assert.ok(Math.abs(inputCost({ input: 1, output: 1, cacheRead: 0.1, cacheWrite: 0 }, tiers, 1_500) - 0.0015) < 1e-12);
});

test("part-2 gap: quality-mode economy path fires above qualityLine, below it does not", () => {
	const quality = baseInput();
	quality.profile = { ...quality.profile, mode: "quality", compaction: { tokenFloor: 20_000, minIntervalTurns: 0, qualityLine: 0.5 } };
	quality.state.turnsSinceCompaction = 5;
	const above = evaluateEconomy({ ...quality, usage: { tokens: 600_000, contextWindow: 1_048_576 } });
	assert.equal(above.kind, "quality");
	const below = evaluateEconomy({ ...quality, usage: { tokens: 300_000, contextWindow: 1_048_576 } });
	assert.equal(below.kind, "none");
});

test("part-2 gap: horizon clamps — cap at 50, floor at 1", () => {
	const input = baseInput();
	input.state.turnsSinceCompaction = 10;
	input.state.growthPerTurn = 1; // tiny growth → huge H → capped at 50
	const capped = savingsEstimate(input, 150_000, 1_048_576, true, 1, 2000);
	assert.equal(capped.horizonTurns, 50);
	// floor 1: regrow target already behind afterTokens
	input.state.growthPerTurn = 5_000_000;
	const floored = savingsEstimate(input, 150_000, 1_048_576, true, 1, 2000);
	assert.equal(floored.horizonTurns, 1);
});

test("part-2 gap: evaluateWarnings no-usage / tokens-stale; isCacheHot ttl<=0", () => {
	const d = evaluateWarnings(baseInput({ usage: undefined }));
	assert.equal(d.kind, "none");
	const stale = baseInput();
	stale.state.tokensStale = true;
	assert.equal(evaluateWarnings(stale).kind, "none");
	const q = baseInput();
	q.profile = { ...q.profile, mode: "quality", cache: { ...q.profile.cache, ttlShort: 0 } };
	assert.equal(isCacheHot(q), false);
	const zeroTtl = baseInput();
	zeroTtl.profile = { ...zeroTtl.profile, cache: { ...zeroTtl.profile.cache, ttlShort: 0 } };
	zeroTtl.state.lastLLMCallAt = 999_999;
	zeroTtl.state.cacheModelKey = "test/model";
	assert.equal(isCacheHot(zeroTtl), false);
});

test("floor guard names the constraint that is actually binding", () => {
	// Live finding: with tokenFloor 2000, floorFraction 0 and a 1M window the
	// binding floor is the 24k keepRecent minimum, but the why-string said
	// "tokenFloor" — sending debugging after a setting that was not in force.
	const keepRecent = baseInput({ usage: { tokens: 932, contextWindow: 1_048_576 } });
	keepRecent.state.turnsSinceCompaction = 10;
	keepRecent.state.growthPerTurn = 5_000;
	keepRecent.profile.compaction.tokenFloor = 2_000;
	keepRecent.profile.compaction.floorFraction = 0;
	const d = evaluateEconomy(keepRecent);
	assert.equal(d.kind, "none");
	assert.equal((d as { why: string }).why, "below keepRecent floor (932 < 24000)");

	// Each constraint must be able to win the label in turn.
	const win = baseInput({ usage: { tokens: 30_000, contextWindow: 1_048_576 } });
	win.state.turnsSinceCompaction = 10;
	win.state.growthPerTurn = 5_000;
	win.profile.compaction.tokenFloor = 40_000;
	win.profile.compaction.floorFraction = 0;
	assert.match((evaluateEconomy(win) as { why: string }).why, /^below tokenFloor /);

	const frac = baseInput({ usage: { tokens: 60_000, contextWindow: 1_048_576 } });
	frac.state.turnsSinceCompaction = 10;
	frac.state.growthPerTurn = 5_000;
	frac.profile.compaction.tokenFloor = 40_000;
	frac.profile.compaction.floorFraction = 0.5;
	assert.match((evaluateEconomy(frac) as { why: string }).why, /^below window-floor /);
});
