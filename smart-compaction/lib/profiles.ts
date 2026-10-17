// smart-compaction/lib/profiles.ts — per-model strategy profiles.
//
// Spec: .plans/COMPACT/spec.md@474c6e30 (AC-2, AC-12)
// Design: .plans/COMPACT/design.md@0787b4a8 §Model profiles, §Runtime model detection
//
// Every model resolves to one profile (tiers + cache economics + strategy
// mode). Resolution precedence (AC-12):
//   1. exact "provider/id" entry from user config profiles[]
//   2. user config glob entries, in config order
//   3. built-in family glob, in BUILTIN order
//   4. GENERIC default
//
// Price resolution (SCFIX 2026-10-06) returns a PROVENANCE, not just numbers:
//   catalog cost fields → user config (defaultPrices / profile prices) →
//   built-in family price table (BUILTIN_PRICES) → assumed generic.
// Only "assumed" disables the economy gate (AC-10); the first three count as
// pricingKnown (see resolvePricing).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Prices {
	/** $ per million tokens. cacheWrite 0 = free/auto (no write premium). */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface Tier {
	/** Upper bound of this tier in context tokens. */
	upTo: number;
	/** Multiplier on base input price for tokens in this tier. */
	inputMult: number;
	/** Multiplier on base output price when the request lands in this tier. */
	outputMult: number;
}

export type ProfileMode = "cost" | "quality" | "balanced";

export interface Profile {
	/** Exact "provider/id" or glob with `*`. Arrays allowed for built-in families. */
	match: string | string[];
	mode: ProfileMode;
	/** Fallback prices when the model catalog has no cost fields. */
	prices?: Partial<Prices>;
	tiers: Tier[];
	cache: {
		/** cacheRead ÷ input, when catalog lacks cacheRead. */
		readRatio: number;
		/** 1.25 on Anthropic; 0 when writes are known free (e.g. OpenAI prompt caching). */
		writePremium: number;
		/** seconds; hot = now − lastLLMCall < ttlShort */
		ttlShort: number;
		ttlLong: number;
	};
	compaction: {
		/** Never compact below this context size. */
		tokenFloor: number;
		/**
		 * Floor as a fraction of the live context window: a permission floor that
		 * keeps compaction away from tiny contexts. The DECISION to compact is made
		 * at qualityLine (see below), not here.
		 *
		 * 0.15 engages only when window > tokenFloor / 0.15 (~267k); below that the
		 * flat tokenFloor governs.
		 */
		floorFraction?: number;
		/**
		 * Minimum context growth after a compaction before economy may fire again.
		 * A compaction that barely shrank the context would otherwise re-fire as
		 * soon as minIntervalTurns elapsed, at near-zero net saving.
		 */
		minGapTokens?: number;
		/** Min turns between compactions (any origin). */
		minIntervalTurns: number;
		/**
		 * The context-quality line as a fraction of the window. Compaction becomes
		 * rational at this point for EVERY mode (2026-10-04 amendment): quality
		 * mode fires directly on it; balanced/cost modes gate the economy path on
		 * it. Default 0.5 — compacting later means the model works through a
		 * rotten, slow, near-overflow context; compacting earlier discards context
		 * the window could still hold while summarization is measurably lossy.
		 */
		qualityLine?: number;
	};
	gate: {
		enabled: boolean;
		aggressiveBelow: number;
		deferAbove: number;
	};
}

export interface SmartCompactionConfig {
	enabled: boolean;
	/** Reserve tokens for overflow line estimation (pi default 16384). */
	reserveTokens: number;
	/** Continuation probability assumed when pi's warmer is silent. */
	continuationProbability: number;
	/** Safety multiple on growth when predicting tier crossing. */
	tierSafety: number;
	defaultPrices?: Partial<Prices>;
	profiles?: Partial<Profile>[];
}

const DEFAULT_CONFIG: SmartCompactionConfig = {
	enabled: true,
	reserveTokens: 16_384,
	continuationProbability: 0.7,
	tierSafety: 1.5,
};

export const GENERIC_PROFILE: Profile = {
	match: "*",
	mode: "balanced",
	tiers: [],
	// Unknown write premium must not model the hot rebuild as free — that made
	// the cost side of the economy test collapse (live: rebuild priced at $0
	// fired compaction at 15% of a 1M window). Profiles with KNOWN free writes
	// pin writePremium: 0 explicitly (gemini, gpt-5.6-sol, local), and
	// resolvePrices honors catalog/config cacheWrite when the provider
	// publishes real numbers.
	cache: { readRatio: 0.1, writePremium: 1.25, ttlShort: 300, ttlLong: 3600 },
	compaction: {
		tokenFloor: 40_000,
		minIntervalTurns: 4,
		floorFraction: 0.15,
		minGapTokens: 20_000,
	},
	gate: { enabled: true, aggressiveBelow: 0.35, deferAbove: 0.7 },
};

function clone(p: Profile): Profile {
	return JSON.parse(JSON.stringify(p)) as Profile;
}

/** Built-in families; order is precedence (first match wins). */
export const BUILTIN_PROFILES: Profile[] = [
	{
		...clone(GENERIC_PROFILE),
		match: "gemini-*-pro*",
		mode: "cost",
		tiers: [{ upTo: 200_000, inputMult: 1, outputMult: 1 }, { upTo: Number.POSITIVE_INFINITY, inputMult: 2, outputMult: 1.5 }],
		cache: { readRatio: 0.1, writePremium: 0, ttlShort: 300, ttlLong: 3600 },
	},
	{
		...clone(GENERIC_PROFILE),
		match: "gpt-5.6-sol*",
		mode: "cost",
		tiers: [{ upTo: 272_000, inputMult: 1, outputMult: 1 }, { upTo: Number.POSITIVE_INFINITY, inputMult: 2, outputMult: 1.5 }],
		// OpenAI prompt caching carries no write premium — do not inherit GENERIC's
		// conservative 1.25 (which would overprice the hot rebuild).
		cache: { readRatio: 0.1, writePremium: 0, ttlShort: 300, ttlLong: 3600 },
	},
	{
		...clone(GENERIC_PROFILE),
		match: "claude-*",
		mode: "balanced",
		tiers: [],
		// Anthropic: reads 10% of input, writes cost 1.25x, 5min short / 1h long TTL.
		cache: { readRatio: 0.1, writePremium: 1.25, ttlShort: 300, ttlLong: 3600 },
	},
	{
		...clone(GENERIC_PROFILE),
		// Free local models: cost math is meaningless; context rot dominates.
		match: ["*-local_mlx", "*-inferx", "*local*", "*inferx*"],
		mode: "quality",
		tiers: [],
		cache: { readRatio: 0, writePremium: 0, ttlShort: 0, ttlLong: 0 },
		compaction: { tokenFloor: 24_000, minIntervalTurns: 3, qualityLine: 0.5 },
	},
];

export type PriceSource = "catalog" | "config" | "builtin" | "assumed";

/**
 * Built-in family price table — $/MTok, standard (non-batch) tier, sourced
 * from OpenRouter's public model list (https://openrouter.ai/api/v1/models,
 * fetched 2026-10-06). Gateway catalogs (LiteLLM proxies) publish no cost
 * fields for these families, which left the economy gate permanently declined
 * ("pricing-unknown") for 74/75 models in the live fleet (SCFIX-1); the
 * gateway's own /model/info carries no prices either (verified: priced=0).
 *
 * Entries are FAMILY list prices: variant suffixes (-inferx, -opencode,
 * -openrouter, -zai, quantization/community tags) inherit the family base.
 * cacheWrite 0 means the provider publishes free cache writes; unlike the
 * all-zero-catalog rule in resolvePrices, these zeros are PUBLISHED data and
 * are honored as real. Corroboration: minimax-m3's entry (0.30/1.20) matches
 * the one manually-captured catalog cost (litellm/minimax) exactly.
 *
 * Order matters: first match wins (full "provider/id" key or bare model id).
 */
export interface FamilyPrices {
	/** Glob(s) matched against the bare model id and the full provider/id key. */
	match: string | string[];
	prices: Prices;
	/** Where the numbers come from / what they approximate. */
	note?: string;
}

export const BUILTIN_PRICES: FamilyPrices[] = [
	// --- Z.ai GLM ---
	{ match: "glm-5.3-flash*", prices: { input: 0.036, output: 0.9, cacheRead: 0.011, cacheWrite: 0 }, note: "z-ai/glm-5.3-flash" },
	{ match: "glm-5.3*", prices: { input: 0.079, output: 4.8, cacheRead: 0.059, cacheWrite: 0 }, note: "z-ai/glm-5.3" },
	{ match: ["glm-5.2*", "glm-5*"], prices: { input: 0.05, output: 7.0, cacheRead: 0.049, cacheWrite: 0 }, note: "z-ai/glm-5.2; bare glm-5 variants approximated by the nearest published generation" },
	// --- Moonshot Kimi ---
	{ match: "kimi-k2.7*", prices: { input: 0.671, output: 3.35, cacheRead: 0.18, cacheWrite: 0 }, note: "moonshotai/kimi-k2.7-code" },
	{ match: "kimi-k2.6*", prices: { input: 0.65, output: 3.41, cacheRead: 0.15, cacheWrite: 0 }, note: "moonshotai/kimi-k2.6" },
	{ match: "kimi-k2.5*", prices: { input: 0.5, output: 2.5, cacheRead: 0.15, cacheWrite: 0 }, note: "moonshotai/kimi-k2.5" },
	{ match: "kimi-k3*", prices: { input: 0.7, output: 15.0, cacheRead: 0.32, cacheWrite: 0 }, note: "moonshotai/kimi-k3" },
	{ match: "kimi-k2*", prices: { input: 0.671, output: 3.35, cacheRead: 0.18, cacheWrite: 0 }, note: "unversioned kimi-k2 → k2.7 base" },
	// --- MiniMax (corroborated by live catalog cost on litellm/minimax) ---
	{ match: "minimax*", prices: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 }, note: "minimax/minimax-m3; matches manual catalog capture for litellm/minimax" },
	// --- DeepSeek ---
	{ match: "deepseek-v4-pro*", prices: { input: 0.955, output: 1.911, cacheRead: 0.08, cacheWrite: 0 }, note: "deepseek/deepseek-v4-pro" },
	{ match: "deepseek-v4.1*", prices: { input: 0.02, output: 0.891, cacheRead: 0.005, cacheWrite: 0 }, note: "deepseek/deepseek-v4.1-flash" },
	{ match: "deepseek-v4-flash*", prices: { input: 0.091, output: 0.182, cacheRead: 0.018, cacheWrite: 0 }, note: "deepseek/deepseek-v4-flash (0731/vision variants approximated by base)" },
	{ match: "deepseek-reasoner*", prices: { input: 0.955, output: 1.911, cacheRead: 0.08, cacheWrite: 0 }, note: "bare alias → v4-pro class" },
	{ match: "deepseek", prices: { input: 0.091, output: 0.182, cacheRead: 0.018, cacheWrite: 0 }, note: "bare alias → v4-flash class" },
	// --- Qwen ---
	{ match: "qwen3.8-max*", prices: { input: 2.0, output: 6.0, cacheRead: 0.25, cacheWrite: 0 }, note: "qwen/qwen3.8-max-0902" },
	{ match: "qwen3.8-flash*", prices: { input: 0.15, output: 0.47, cacheRead: 0.016, cacheWrite: 0 }, note: "qwen/qwen3.8-flash" },
	{ match: "qwen3.8-27b*", prices: { input: 0.04, output: 2.3, cacheRead: 0.02, cacheWrite: 0 }, note: "qwen/qwen3.8-27b" },
	{ match: "qwen3.8", prices: { input: 0.15, output: 0.47, cacheRead: 0.016, cacheWrite: 0 }, note: "bare alias → flash class" },
	{ match: "qwen3.7-max*", prices: { input: 1.475, output: 4.425, cacheRead: 0.295, cacheWrite: 1.844 }, note: "qwen/qwen3.7-max (published cache-write premium)" },
	{ match: "qwen3.7-flash*", prices: { input: 0.03, output: 0.13, cacheRead: 0.006, cacheWrite: 0.038 }, note: "qwen/qwen3.7-flash" },
	{ match: ["qwen3.7-plus*", "qwen-plus*", "qwen"], prices: { input: 0.32, output: 1.28, cacheRead: 0.064, cacheWrite: 0.4 }, note: "qwen/qwen3.7-plus; bare qwen/qwen-plus aliases → Plus tier" },
	{ match: "qwen3.6-plus*", prices: { input: 0.325, output: 1.95, cacheRead: 0, cacheWrite: 0.406 }, note: "qwen/qwen3.6-plus (cache reads published free)" },
	{ match: "qwen3.6-35b*", prices: { input: 0.1, output: 0.95, cacheRead: 0.1, cacheWrite: 0 }, note: "qwen/qwen3.6-35b-a3b" },
	{ match: "qwen3.6*", prices: { input: 0.325, output: 1.95, cacheRead: 0, cacheWrite: 0.406 }, note: "unversioned qwen3.6 → plus tier" },
	{ match: "qwen3.5-plus*", prices: { input: 0.325, output: 1.95, cacheRead: 0, cacheWrite: 0.406 }, note: "no published 3.5-plus listing → nearest (3.6-plus)" },
	{ match: "qwen3-coder-next*", prices: { input: 0.12, output: 0.8, cacheRead: 0.07, cacheWrite: 0 }, note: "qwen/qwen3-coder-next" },
	{ match: "qwen3-coder-30b*", prices: { input: 0.07, output: 0.28, cacheRead: 0, cacheWrite: 0 }, note: "qwen/qwen3-coder-30b-a3b-instruct; cache pricing unpublished (quality-mode models anyway)" },
	// --- xAI / OpenAI / others ---
	{ match: "grok-4.5*", prices: { input: 2.0, output: 6.0, cacheRead: 0.3, cacheWrite: 0 }, note: "x-ai/grok-4.5" },
	{ match: "grok-4.6*", prices: { input: 2.0, output: 6.0, cacheRead: 0.5, cacheWrite: 0 }, note: "x-ai/grok-4.6" },
	{ match: "gpt-5.6-luna*", prices: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 }, note: "openai/gpt-5.6-luna" },
	{ match: "gpt-5.6-sol*", prices: { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.5 }, note: "openai/gpt-5.6-sol; the builtin profile's writePremium:0 pin still wins for cacheWrite (known-free OpenAI prompt-cache writes)" },
	{ match: "longcat-2.0*", prices: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 }, note: "meituan/longcat-2.0" },
	{ match: "hy3-preview*", prices: { input: 0.18, output: 0.6, cacheRead: 0.06, cacheWrite: 0 }, note: "tencent/hy3-preview" },
	{ match: "hy3*", prices: { input: 0.132, output: 0.528, cacheRead: 0.033, cacheWrite: 0 }, note: "tencent/hy3" },
	{ match: ["mimo-v2.5-pro*", "mimo-v2-pro*"], prices: { input: 0.435, output: 0.87, cacheRead: 0.004, cacheWrite: 0 }, note: "xiaomi/mimo-v2.5-pro" },
	{ match: "mimo-v2*", prices: { input: 0.14, output: 0.28, cacheRead: 0.003, cacheWrite: 0 }, note: "xiaomi/mimo-v2.5" },
	{ match: "gpt-oss-20b*", prices: { input: 0.018, output: 0.09, cacheRead: 0.009, cacheWrite: 0 }, note: "openai/gpt-oss-20b" },
	{ match: "gemma-4-31b*", prices: { input: 0.09, output: 0.34, cacheRead: 0.05, cacheWrite: 0 }, note: "google/gemma-4-31b-it" },
	{ match: "gemma-4-26b*", prices: { input: 0.09, output: 0.3, cacheRead: 0.05, cacheWrite: 0 }, note: "google/gemma-4-26b-a4b-it" },
	{ match: "devstral*", prices: { input: 0.4, output: 2.0, cacheRead: 0.04, cacheWrite: 0 }, note: "mistralai/devstral-2512" },
];

/** Family-table lookup: full "provider/id" key first, then the bare model id. */
export function lookupBuiltinPrices(provider: string, modelId: string): Prices | undefined {
	const key = `${provider}/${modelId}`;
	for (const fam of BUILTIN_PRICES) {
		const pats = Array.isArray(fam.match) ? fam.match : [fam.match];
		if (pats.some((p) => globMatch(p, modelId) || globMatch(p, key))) return { ...fam.prices };
	}
	return undefined;
}

/** Simple glob: only `*` wildcards, full-string match. */
export function globMatch(pattern: string, value: string): boolean {
	if (!pattern.includes("*")) return pattern === value;
	const re = new RegExp(
		`^${pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`,
	);
	return re.test(value);
}

export interface ProfileMatch {
	profile: Profile;
	/** Where the profile came from (telemetry / /compact:why). */
	source: "config-exact" | "config-glob" | "builtin" | "generic";
}

/** Resolve the profile for a live model key (AC-11: call per event, never cache). */
export function resolveProfile(provider: string, modelId: string, config: SmartCompactionConfig): ProfileMatch {
	const key = `${provider}/${modelId}`;
	const cfg = config.profiles ?? [];
	const pats = (m: string | string[] | undefined): string[] => (m === undefined ? [] : Array.isArray(m) ? m : [m]);
	for (const p of cfg) {
		if (pats(p.match).some((pat) => !pat.includes("*") && pat === key)) {
			return { profile: mergeProfile(clone(GENERIC_PROFILE), p, key), source: "config-exact" };
		}
	}
	for (const p of cfg) {
		if (pats(p.match).some((pat) => pat.includes("*") && globMatch(pat, key))) {
			return { profile: mergeProfile(clone(GENERIC_PROFILE), p, key), source: "config-glob" };
		}
	}
	// built-in families match on full key or model id alone
	for (const bp of BUILTIN_PROFILES) {
		const patterns = Array.isArray(bp.match) ? bp.match : [bp.match];
		if (patterns.some((p) => globMatch(p, key) || globMatch(p, modelId))) {
			return { profile: clone(bp), source: "builtin" };
		}
	}
	return { profile: clone(GENERIC_PROFILE), source: "generic" };
}

/** Overlay a partial config profile onto the generic base. */
function mergeProfile(base: Profile, patch: Partial<Profile>, key: string): Profile {
	const out = { ...base, ...patch } as Profile;
	out.match = key;
	out.cache = { ...base.cache, ...(patch.cache ?? {}) };
	out.compaction = { ...base.compaction, ...(patch.compaction ?? {}) };
	out.gate = { ...base.gate, ...(patch.gate ?? {}) };
	out.tiers = patch.tiers ?? base.tiers;
	return out;
}

/** Deep-merge partial config over defaults; last file wins. */
export function mergeConfig(base: SmartCompactionConfig, patch: Partial<SmartCompactionConfig>): SmartCompactionConfig {
	return {
		...base,
		...patch,
		defaultPrices: { ...(base.defaultPrices ?? {}), ...(patch.defaultPrices ?? {}) },
		profiles: [...(patch.profiles ?? []), ...(base.profiles ?? [])],
	};
}

/** Load config: ~/.pi/agent/smart-compaction.json then <project>/.pi/smart-compaction.json. */
export function loadConfig(projectDir?: string): SmartCompactionConfig {
	let cfg = { ...DEFAULT_CONFIG };
	const paths: string[] = [join(homedir(), ".pi", "agent", "smart-compaction.json")];
	if (projectDir) paths.push(join(projectDir, ".pi", "smart-compaction.json"));
	for (const p of paths) {
		if (!existsSync(p)) continue;
		try {
			const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<SmartCompactionConfig>;
			cfg = mergeConfig(cfg, raw);
		} catch {
			// corrupt config: keep defaults (AC-10)
		}
	}
	return cfg;
}

const hasAnyPrice = (c: Partial<Prices> | null | undefined): boolean =>
	!!c && Object.values(c).some((v) => typeof v === "number" && v > 0);

/**
 * True when the model catalog carried at least one positive price field — i.e.
 * the economy math would run on PUBLISHED prices rather than fabricated
 * fallbacks. False (null/undefined/all-zero catalog) disables the economy path
 * (design "Model profiles": economy trigger disabled, AC-10); users opt back
 * in via explicit config defaultPrices or profile prices.
 *
 * SCFIX 2026-10-06: catalog-only. The live wiring must use resolvePricing()
 * instead — a config opt-in (defaultPrices / profile prices) or a
 * BUILTIN_PRICES family match both count as known even when the catalog is
 * empty, and only the "assumed" generic fallback keeps the gate closed.
 */
export function pricingKnown(catalog: Partial<Prices> | null | undefined): boolean {
	return hasAnyPrice(catalog);
}

const hasAnyDefinedPrice = (c: Partial<Prices> | null | undefined): boolean =>
	!!c && Object.values(c).some((v) => typeof v === "number");

/** Economy gate may run on this provenance (AC-10: only fabricated numbers may not). */
export function pricingKnownSource(source: PriceSource): boolean {
	return source !== "assumed";
}

/**
 * Resolve prices WITH provenance (SCFIX 2026-10-06). Precedence:
 *   catalog cost fields → user config (profile prices / defaultPrices) →
 *   built-in family table (BUILTIN_PRICES) → assumed generic.
 * The source is what the economy gate reasons about: catalog/config/builtin
 * are published or user-pinned numbers (gate runs); "assumed" is fabricated
 * (gate declines, AC-10) — /compact:why surfaces it as ASSUMED.
 */
export function resolvePricing(
	catalog: Partial<Prices> | null | undefined,
	provider: string,
	modelId: string,
	profile: Profile,
	config: SmartCompactionConfig,
): { prices: Prices; source: PriceSource } {
	if (hasAnyPrice(catalog)) return { prices: resolvePrices(catalog, profile, config), source: "catalog" };
	// Any user-pinned price field counts as explicit intent, including 0 pins
	// (cacheRead: 0 for genuinely free cache) — hasAnyDefinedPrice, not >0.
	if (hasAnyDefinedPrice(profile.prices) || hasAnyDefinedPrice(config.defaultPrices)) {
		return { prices: resolvePrices(null, profile, config), source: "config" };
	}
	const family = lookupBuiltinPrices(provider, modelId);
	if (family) {
		// A profile with a KNOWN-free-write pin (writePremium 0, e.g. gpt-5.6-sol)
		// outranks the table's published cache-write number — the pin is the
		// stronger, provider-documented fact (design "Model profiles").
		const prices: Prices = profile.cache.writePremium === 0 ? { ...family, cacheWrite: 0 } : family;
		return { prices, source: "builtin" };
	}
	return { prices: resolvePrices(null, profile, config), source: "assumed" };
}

/**
 * Resolve effective prices for a model (AC-12 precedence):
 * catalog cost fields → profile.prices → config.defaultPrices → conservative generic.
 * `catalog` values may be undefined but are never overridden when present —
 * except cacheWrite===undefined falls to profile/default (catalog 0 is real "free").
 */
export function resolvePrices(
	catalog: Partial<Prices> | null | undefined,
	profile: Profile,
	config: SmartCompactionConfig,
): Prices {
	const generic: Prices = { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 0 };
	const fallback: Partial<Prices> = { ...generic, ...(config.defaultPrices ?? {}), ...(profile.prices ?? {}) };
	// An all-zero catalog is NOT "this model is free" — it is a provider that has
	// no pricing data (LiteLLM proxies report {0,0,0,0} for unpriced models).
	// Honouring those zeros yields an all-zero Prices, which makes the economy gate
	// mathematically unsatisfiable: savings and cost both evaluate to 0, so
	// `savings > cost * margin` becomes `0 > 0` and compaction can NEVER fire. That
	// is a silent permanent no-op, not a policy decision — it was observed on a
	// live LiteLLM model that sat at 55k tokens for 20+ turns declining with
	// "savings $0.0000 <= cost $0.0000".
	//
	// So: treat an all-zero (or null/undefined) catalog as absent and fall through
	// to profile/config/generic. A catalog with ANY positive field is still
	// respected field-by-field, so genuine free or partially-priced models keep
	// their real zeros.
	const cat = hasAnyPrice(catalog) ? (catalog as Partial<Prices>) : {};
	const baseInput = cat.input ?? fallback.input ?? generic.input;
	// A catalog cacheRead of exactly 0 alongside a positive input price is the
	// same "provider has no data" signal as an all-zero catalog: LiteLLM reports
	// a real input price but leaves the cache fields at 0 for unpriced cache
	// tiers. Honoring that 0 makes the engine's hot-cache marginal savings
	// (horizon × shrink × cacheRead) identically $0, so the economy path can
	// never fire for such models in ANY cache state — live-verified on
	// litellm/minimax 2026-10-04: 'savings $0.0000 <= cost $0.0527' at 167,828
	// tokens, past the window floor. So a catalog 0 falls through to the derived
	// readRatio price, while a genuinely free-cache model can still pin
	// cacheRead: 0 explicitly via config (defaultPrices or profile prices),
	// which outranks the catalog-zero fallback below.
	const explicitCacheRead = profile.prices?.cacheRead ?? config.defaultPrices?.cacheRead;
	const explicitCacheWrite = profile.prices?.cacheWrite ?? config.defaultPrices?.cacheWrite;
	const catalogCacheRead = cat.cacheRead !== undefined && cat.cacheRead !== 0 ? cat.cacheRead : undefined;
	return {
		input: baseInput,
		output: cat.output ?? fallback.output ?? generic.output,
		cacheRead:
			catalogCacheRead !== undefined
				? catalogCacheRead
				: explicitCacheRead !== undefined
					? explicitCacheRead
					: cat.input !== undefined
						? baseInput * profile.cache.readRatio
						: (fallback.cacheRead ?? generic.cacheRead),
		cacheWrite: cat.cacheWrite ?? explicitCacheWrite ?? baseInput * profile.cache.writePremium,
	};
}
