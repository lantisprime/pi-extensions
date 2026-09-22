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
		/** 1.25 on Anthropic; 0 when writes are free. */
		writePremium: number;
		/** seconds; hot = now − lastLLMCall < ttlShort */
		ttlShort: number;
		ttlLong: number;
	};
	compaction: {
		/** Never compact below this context size. */
		tokenFloor: number;
		/** Min turns between compactions (any origin). */
		minIntervalTurns: number;
		/** quality mode: compact at settled when tokens > window × line. */
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
	cache: { readRatio: 0.1, writePremium: 0, ttlShort: 300, ttlLong: 3600 },
	compaction: { tokenFloor: 40_000, minIntervalTurns: 4 },
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

/**
 * Resolve effective prices for a model (AC-12 precedence):
 * catalog cost fields → profile.prices → config.defaultPrices → conservative generic.
 * `catalog` values may be undefined but are never overridden when present —
 * except cacheWrite===undefined falls to profile/default (catalog 0 is real "free").
 */
export function resolvePrices(
	catalog: Partial<Prices> | undefined,
	profile: Profile,
	config: SmartCompactionConfig,
): Prices {
	const generic: Prices = { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 0 };
	const fallback: Partial<Prices> = { ...generic, ...(config.defaultPrices ?? {}), ...(profile.prices ?? {}) };
	const cat = catalog ?? {};
	const baseInput = cat.input ?? fallback.input ?? generic.input;
	return {
		input: baseInput,
		output: cat.output ?? fallback.output ?? generic.output,
		cacheRead:
			cat.cacheRead !== undefined
				? cat.cacheRead
				: cat.input !== undefined
					? baseInput * profile.cache.readRatio
					: (fallback.cacheRead ?? generic.cacheRead),
		cacheWrite: cat.cacheWrite ?? baseInput * profile.cache.writePremium,
	};
}
