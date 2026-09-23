// context-manager — Phase 1: Observe + health/purity metrics (spec@6540546f + Amendment v1.1.0).
//
// Status line: renders the consolidated "ctx-suite" footer segment (health
// shares + CH + any status-line bus publishers such as smart-compaction) when
// statusLine.consolidate (default true); legacy standalone "ctx-health"
// segment when false. Protocol: ../shared/status-line-protocol.md
//
// Phase 1 is OBSERVE-ONLY: no context-event views, no message replacement, no
// warmer interference (spec §7). Fingerprints spans, classifies them, attributes
// cache misses (reusing pi's cache-stats), scores ingest relevance of large
// artifacts against the existing context via Jev (degraded heuristic fallback).
//
// Phase 2 (spec-phase2.md@48c998a7) M1: task-switch detection at
// message_end(role=user) — pin per user turn (B2), deterministic task-list
// diff (zero Jev), else ONE Jev drift noul (p > 0.65), else degraded overlap
// (< 0.15). Drift STAGES {tasks, topic}; applied at the NEXT user turn (B2).

// Phase 3 (spec-phase3.md@56e0c00a): per-call view shaping via the `context`
// event (E1/E2) - stale-dedupe, superseded-output collapse, task-switch
// eviction. Plan frozen per burst (B5); unsent ops apply immediately (zero
// cache cost), ops on already-sent content queue (dirty-prefix batching, M5)
// and flush ONCE at a burst boundary (ttl/floor/hard/cap; XOR M3 per turn).
// Transcript NEVER mutated (E5); forced-prompt requests bypassed (M6);
// toolCall/toolResult adjacency self-validated in-handler (E4).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const JEV_ENDPOINT_DEFAULT = "https://litellm.lab.znp.pw/typesafe/v1/systemone";
const JEV_TIMEOUT_MS = 15_000;

interface CMConfig {
	enabled: boolean;
	probeFreshness: boolean;
	relevanceMinTokens: number;
	classification: { dumpTokens: number; conclusionTokens: number };
	statusLine: { enabled: boolean; consolidate: boolean };
	telemetryPath: string;
	keepSpans: number;
	taskSwitch: { enabled: boolean; driftThreshold: number; rescoreBatch: number };
	elision: { enabled: boolean; sideCarPath: string; readToolNames: string[] };
	purityBudget: { budget: number; hardMultiplier: number; compactCooldownMin: number };
	compactInstructions: string;
	shaping: { enabled: boolean; qualityFloor: number; cacheTtlMin: number; maxEvictShare: number; argsCap: number };
	dirtyQueue: { maxEntries: number; maxTok: number };
	poison: {
		enabled: boolean;
		contradictionAct: number;
		reviewFloor: number;
		stalenessAct: number;
		stalenessReview: number;
		spansPerCall: number;
		excerptCap: number;
		redact: boolean;
		errorLoopMin: number;
		redactionPatterns: string[];
	};
}

const DEFAULTS: CMConfig = {
	enabled: true,
	probeFreshness: true,
	relevanceMinTokens: 2000,
	classification: { dumpTokens: 800, conclusionTokens: 64 },
	statusLine: { enabled: true, consolidate: true },
	telemetryPath: ".pi/context-telemetry.jsonl",
	keepSpans: 500,
	taskSwitch: { enabled: true, driftThreshold: 0.65, rescoreBatch: 30 },
	elision: { enabled: true, sideCarPath: ".pi/context-elisions.jsonl", readToolNames: ["read"] },
	purityBudget: { budget: 0.15, hardMultiplier: 2, compactCooldownMin: 10 },
	compactInstructions: "drop unrelated/dup/stale content",
	shaping: { enabled: true, qualityFloor: 0.85, cacheTtlMin: 5, maxEvictShare: 0.4, argsCap: 2048 },
	dirtyQueue: { maxEntries: 64, maxTok: 32768 },
	poison: {
		enabled: true,
		contradictionAct: 0.8,
		reviewFloor: 0.35,
		stalenessAct: 2,
		stalenessReview: 1,
		spansPerCall: 8,
		excerptCap: 1200,
		redact: true,
		errorLoopMin: 3,
		redactionPatterns: [],
	},
};

type SpanClass = "fresh" | "stale" | "dup" | "error" | "unclassified";
type Verdict = "duplicate" | "relevant" | "unrelated";
type DriftSource = "task-diff" | "jev" | "heuristic-degraded";

// ---------- Phase 3: per-call view shaping (spec-phase3.md) ----------
type ShapeKind = "stale-dedupe" | "superseded-collapse" | "task-evict" | "poison-stub" | "error-loop";
interface ShapeOpMeta {
	/** Pre-rendered stub text (error-loop carries ×N + newest-sha the view may no longer show). */
	stub?: string;
	/** error-loop: total failures in the loop and the kept (newest) span sha. */
	n?: number;
	newestSha?: string;
	/** error-loop group identity: member shas, tool name, args key, normalized signature. */
	shas?: string[];
	toolName?: string;
	argsKey?: string;
	sig?: string;
}
interface ShapePlan {
	computedAt: number;
	ops: Array<{ kind: ShapeKind; sha: string; idx: number; meta?: ShapeOpMeta }>;
}
interface Burst {
	id: number;
	userTurn: number;
	callNo: number;
	plan: ShapePlan | null;
	openedAt: number;
}
interface DirtyOp {
	kind: ShapeKind;
	sha: string;
	toolName: string;
	tok: number;
	turn: number;
	enqueuedAt: number;
	meta?: ShapeOpMeta;
}
interface ShapeStats {
	plans: number;
	applied: number;
	droppedAdjacency: number;
	flushed: number;
	flushedTok: number;
	bypassed: number;
	pruned: number;
	sideCarSkips: number;
	// Phase 4 (spec-phase4.md@43a7f0c1)
	poisonActed: number;
	poisonReview: number;
	poisonDegraded: number;
	redactHits: Record<string, number>;
	errorLoopCollapsed: number;
	errorLoopKept: number;
}

interface TaskModel {
	tasks: string[];
	topic: string;
	turn: number;
}

interface Span {
	id: string;
	path?: string;
	contentHash: string;
	tok: number;
	capturedAt: number;
	cls: SpanClass;
	verdict?: { v: Verdict; source: "jev" | "heuristic-degraded" };
	excerpt: string;
	isError: boolean;
	rescoredAtTurn?: number;
	// Phase 4: capture-time redacted text (M8) + poison verdicts (M7).
	// TWO pinned identities (GLM post-review): contentHash = sha1(RAW transcript text)
	// for index/sentPrefix bookkeeping; restoreHash = sha1(REDACTED text) for stubs,
	// side-car records, and /ctx:restore lookups (no secret-derived hashes in artifacts).
	textRedacted?: string;
	restoreHash?: string;
	redactKinds?: Record<string, number>;
	poison?: PoisonMeta;
}

interface PoisonMeta {
	contra: number;
	stale: number;
	/** Score-answer confidence — NEVER present on noul-only spans (AC-24, api.md: nouls carry none). */
	scoreConf?: number;
	source: "jev" | "poison-degraded";
	at: number;
	consumedAt?: number;
}

interface CMState {
	config: CMConfig;
	spans: Span[];
	hashCount: Map<string, number>;
	verdictMemo: Map<string, { v: Verdict; source: "jev" | "heuristic-degraded" }>;
	pendingScores: Set<Promise<void>>;
	turn: number;
	lastModelKey: string | null;
	lastPromptTokens: number | null;
	lastLLMAt: number | null;
	lastChPct: number | undefined;
	cacheSource: "cache-stats" | "usage-fallback" | "unresolved";
	missStats: { missedTokens: number; cause: string | null };
	taskModel: TaskModel | null;
	stagedModel: TaskModel | null;
	lastDriftSource: DriftSource | null;
	lastSeenTaskIds: string[];
	toolNames: Map<string, string>;
	lastPurity: number | null;
	elisionStats: { elided: number; skipped: number; tokens: number };
	flushQueued: boolean;
	lastCompactAt: number | null;
	compactInFlight: boolean;
	b6SuppressNext: boolean;
	// Phase 3
	burst: Burst | null;
	burstSeq: number;
	lastCtxCallAt: number | null;
	sentPrefix: Set<string>;
	appliedShas: Set<string>;
	appliedKinds: Map<string, ShapeKind>;
	appliedTurns: Map<string, number>;
	dirty: DirtyOp[];
	baselineViewTokens: number;
	lastViewTokens: number;
	compacting: boolean;
	shapeStats: ShapeStats;
	lastFlush: { trigger: string; turn: number } | null;
	argsKeyBySha: Map<string, string>;
	// Phase 4
	appliedMeta: Map<string, ShapeOpMeta>;
	redactApplied: Set<string>;
	lastPoison: { turn: number; candidates: number; acted: number; review: number; degraded: number; inputTokens: number; noulPolicy: "raw-probability" } | null;
}

function loadConfig(cwd: string): CMConfig {
	const base: CMConfig = {
		...DEFAULTS,
		classification: { ...DEFAULTS.classification },
		statusLine: { ...DEFAULTS.statusLine },
		taskSwitch: { ...DEFAULTS.taskSwitch },
		elision: { ...DEFAULTS.elision, readToolNames: [...DEFAULTS.elision.readToolNames] },
		purityBudget: { ...DEFAULTS.purityBudget },
		shaping: { ...DEFAULTS.shaping },
		dirtyQueue: { ...DEFAULTS.dirtyQueue },
		poison: { ...DEFAULTS.poison, redactionPatterns: [...DEFAULTS.poison.redactionPatterns] },
	};
	const p = join(cwd, ".pi", "context-manager.json");
	if (!existsSync(p)) return base;
	try {
		const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<CMConfig>;
		return {
			...base,
			...raw,
			classification: { ...base.classification, ...(raw.classification ?? {}) },
			statusLine: { ...base.statusLine, ...(raw.statusLine ?? {}) },
			// deep-merge EVERY sub-config: a partial user override must not drop sibling
			// defaults — e.g. purityBudget{budget} alone left hardMultiplier undefined ⇒
			// NaN gates silently defeated the pressure tiers (GLM CTX2-3 review #1)
			taskSwitch: { ...base.taskSwitch, ...(raw.taskSwitch ?? {}) },
			elision: {
				...base.elision,
				...(raw.elision ?? {}),
				readToolNames: [...(raw.elision?.readToolNames ?? base.elision.readToolNames)],
			},
			purityBudget: { ...base.purityBudget, ...(raw.purityBudget ?? {}) },
			shaping: sanitizeShaping({ ...base.shaping, ...(raw.shaping ?? {}) }),
			dirtyQueue: sanitizeDirtyQueue({ ...base.dirtyQueue, ...(raw.dirtyQueue ?? {}) }),
			poison: sanitizePoison({ ...base.poison, ...(raw.poison ?? {}) }),
		};
	} catch {
		return base;
	}
}

// AC-43: malformed shaping/dirtyQueue values fall back to defaults with a warning
function num(v: unknown, dflt: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}

function sanitizeShaping(s: CMConfig["shaping"]): CMConfig["shaping"] {
	const d = DEFAULTS.shaping;
	const out = {
		enabled: typeof s.enabled === "boolean" ? s.enabled : d.enabled,
		qualityFloor: num(s.qualityFloor, d.qualityFloor),
		cacheTtlMin: num(s.cacheTtlMin, d.cacheTtlMin),
		maxEvictShare: num(s.maxEvictShare, d.maxEvictShare),
		argsCap: num(s.argsCap, d.argsCap),
	};
	if (out.qualityFloor !== s.qualityFloor || out.cacheTtlMin !== s.cacheTtlMin || out.maxEvictShare !== s.maxEvictShare || out.argsCap !== s.argsCap || out.enabled !== s.enabled) {
		console.warn("[context-manager] malformed shaping config value(s); default(s) applied");
	}
	return out;
}

function sanitizeDirtyQueue(q: CMConfig["dirtyQueue"]): CMConfig["dirtyQueue"] {
	const d = DEFAULTS.dirtyQueue;
	const out = { maxEntries: num(q.maxEntries, d.maxEntries), maxTok: num(q.maxTok, d.maxTok) };
	if (out.maxEntries !== q.maxEntries || out.maxTok !== q.maxTok) {
		console.warn("[context-manager] malformed dirtyQueue config value(s); default(s) applied");
	}
	return out;
}

// AC-19/AC-43 (spec-phase4): malformed poison values warn + default; never throw.
function sanitizePoison(p: CMConfig["poison"]): CMConfig["poison"] {
	const d = DEFAULTS.poison;
	const out = {
		enabled: typeof p.enabled === "boolean" ? p.enabled : d.enabled,
		contradictionAct: num(p.contradictionAct, d.contradictionAct),
		reviewFloor: num(p.reviewFloor, d.reviewFloor),
		stalenessAct: num(p.stalenessAct, d.stalenessAct),
		stalenessReview: num(p.stalenessReview, d.stalenessReview),
		spansPerCall: num(p.spansPerCall, d.spansPerCall),
		excerptCap: num(p.excerptCap, d.excerptCap),
		redact: typeof p.redact === "boolean" ? p.redact : d.redact,
		errorLoopMin: num(p.errorLoopMin, d.errorLoopMin),
		redactionPatterns: Array.isArray(p.redactionPatterns) ? p.redactionPatterns.filter((x): x is string => typeof x === "string") : [...d.redactionPatterns],
	};
	if (
		out.enabled !== p.enabled || out.contradictionAct !== p.contradictionAct || out.reviewFloor !== p.reviewFloor ||
		out.stalenessAct !== p.stalenessAct || out.stalenessReview !== p.stalenessReview || out.spansPerCall !== p.spansPerCall ||
		out.excerptCap !== p.excerptCap || out.redact !== p.redact || out.errorLoopMin !== p.errorLoopMin ||
		JSON.stringify(out.redactionPatterns) !== JSON.stringify(p.redactionPatterns)
	) {
		console.warn("[context-manager] malformed poison config value(s); default(s) applied");
	}
	return out;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return (content as Array<{ type?: string; text?: string }>)
			.map((c) => (c?.type === "text" && c.text ? c.text : ""))
			.join("\n");
	}
	return "";
}

function classify(tok: number, isError: boolean, text: string, cfg: CMConfig): SpanClass {
	if (isError || /exit (code )?[1-9]\d*/i.test(text) || /^(stderr:)/im.test(text)) return "error";
	if (tok >= cfg.classification.dumpTokens) return "unclassified"; // dump-class; unclassified share
	if (tok <= cfg.classification.conclusionTokens) return "fresh";
	return "fresh";
}

// ---------- Phase 4 M8: secret redaction (spec-phase4.md@43a7f0c1, deterministic, zero Jev) ----------
// Capture-time redaction: span text, side-car records, and every downstream consumer share
// ONE identity computed on redacted text (AC-12). Raw text persists only in pi's own session
// transcript. Negative lookahead keeps already-redacted spans idempotent (AC-9).
const REDACTION_PATTERNS: Array<{ kind: string; re: RegExp; repl?: (m: string, ...groups: string[]) => string }> = [
	{ kind: "openai", re: /sk-[A-Za-z0-9_-]{16,}/g },
	{ kind: "github", re: /gh[pousr]_[A-Za-z0-9]{30,}/g },
	{ kind: "aws", re: /AKIA[0-9A-Z]{16}/g },
	{ kind: "slack", re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
	{ kind: "jwt", re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
	{ kind: "pem", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
	{ kind: "bearer", re: /bearer\s+(?!\[REDACTED)[A-Za-z0-9._~+/=-]{20,}/gi },
	{
		kind: "assignment",
		// preserves the key name in the view; quoted values of ANY length per spec
		re: /\b(api[_-]?key|token|secret|password)(\s*[=:]\s*)("[^"]*"|'[^']*'|(?!\[REDACTED)[^\s"']{20,})/gi,
		repl: (_m: string, p1: string, p2: string) => `${p1}${p2}[REDACTED:assignment]`,
	},
];

function compileExtraPatterns(extra: string[]): Array<{ kind: string; re: RegExp; repl?: (m: string, ...groups: string[]) => string }> {
	const out: Array<{ kind: string; re: RegExp; repl?: (m: string, ...groups: string[]) => string }> = [];
	for (const src of extra) {
		try {
			out.push({ kind: "custom", re: new RegExp(src, "g") });
		} catch {
			console.warn("[context-manager] invalid poison.redaction.patterns entry skipped");
		}
	}
	return out;
}

/** Apply the redaction battery; returns redacted text and the per-kind hit counts. */
function redactText(text: string, extra: string[] = []): { text: string; kinds: Record<string, number> } {
	const kinds: Record<string, number> = {};
	let out = text;
	for (const { kind, re, repl } of [...REDACTION_PATTERNS, ...compileExtraPatterns(extra)]) {
		// custom (user-supplied) patterns scan a bounded head only — a catastrophic
		// regex must not hang every capture (GLM post-review S2-7)
		const bounded = kind === "custom" && out.length > 65_536;
		const scanHead = bounded ? out.slice(0, 65_536) : out;
		const tail = bounded ? out.slice(65_536) : "";
		const scanned = scanHead.replace(re, (...args: unknown[]) => {
			const m = args[0] as string;
			if (m.includes("[REDACTED")) return m; // idempotence guard (AC-9)
			kinds[kind] = (kinds[kind] ?? 0) + 1;
			if (repl) {
				const groups = (args.slice(1) as string[]).slice(0, Math.max(repl.length - 1, 0));
				return repl(m, ...groups);
			}
			return `[REDACTED:${kind}]`;
		});
		out = tail ? scanned + tail : scanned;
	}
	return { text: out, kinds };
}

/** M9 error-signature normalization: first line, digits → N (spec AC-13). */
function errorSignature(text: string): string {
	const first = (text.split("\n", 1)[0] ?? "").trim();
	return first.replace(/\d+/g, "N").slice(0, 160);
}

// ---------- cache-stats import (AC-10: locked resolution) ----------
type CacheStatsModule = {
	CACHE_TTL_MS: number;
	detectCacheMiss: (entries: unknown, message: unknown, models?: unknown) => unknown;
};
let cacheStatsState: CacheStatsModule | null | undefined;
async function loadCacheStats(): Promise<CacheStatsModule | null> {
	if (cacheStatsState !== undefined) return cacheStatsState;
	try {
		cacheStatsState = (await import("@earendil-works/pi-coding-agent/dist/core/cache-stats.js")) as CacheStatsModule;
	} catch {
		cacheStatsState = null; // Fallback B: usage-fallback math (locked by test)
	}
	return cacheStatsState;
}

// ---------- Jev ingest-relevance (Amendment v1.1.0, degraded mode) ----------
function jevKey(): string | null {
	const env = process.env.JEV_API_KEY?.trim();
	if (env) return env;
	try {
		const parsed = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "models.json"), "utf8")) as {
			providers?: Record<string, { apiKey?: string }>;
		};
		return parsed.providers?.litellm?.apiKey ?? null;
	} catch {
		return null;
	}
}

function overlapScore(candidate: string, existing: string[]): number {
	const stop = new Set(["the", "and", "for", "with", "this", "that", "from", "are", "was", "were", "not", "into"]);
	const words = (t: string) => {
		const out = new Set<string>();
		for (const m of t.toLowerCase().matchAll(/[a-z0-9_./-]{4,}/g)) if (!stop.has(m[0])) out.add(m[0]);
		return out;
	};
	const cw = words(candidate);
	if (cw.size === 0) return 1;
	const ew = words(existing.join(" "));
	let hit = 0;
	for (const w of cw) if (ew.has(w)) hit++;
	return hit / cw.size;
}

// ---------- M1: task-list parsing + drift helpers (spec-phase2 M1a) ----------
function parseTaskRows(prompt: string): Array<{ id: string; status: string; subject: string }> {
	const rows: Array<{ id: string; status: string; subject: string }> = [];
	const re = /^[^\w\n]*([A-Z][A-Z0-9]*-\d+)\s+\[([^\]]+)\]\s+(.+)$/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(prompt)) !== null) rows.push({ id: m[1], status: m[2].trim(), subject: m[3].trim() });
	return rows;
}

function taskListDiffers(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return true;
	const ids = new Set(b);
	for (const id of a) if (!ids.has(id)) return true;
	return false;
}

function currentNonCompletedTaskIds(ctx: ExtensionContext): string[] {
	try {
		return parseTaskRows(ctx.getSystemPrompt())
			.filter((r) => r.status !== "completed" && r.status !== "cancelled")
			.map((r) => r.id);
	} catch {
		return [];
	}
}

async function ingestRelevance(
	candidate: Span,
	existing: Span[],
	tasks: string[],
	cfg: CMConfig,
): Promise<{ v: Verdict; source: "jev" | "heuristic-degraded" }> {
	const key = jevKey();
	if (key) {
		try {
			const body = JSON.stringify({
				model: "jev-latest",
				state: {
					question: "Does this new artifact add information not already present in the existing context, and is it relevant to the current tasks?",
					tasks,
					existingInventory: existing.slice(-30).map((s) => ({ path: s.path, tok: s.tok, class: s.cls, excerpt: s.excerpt.slice(0, 600) })),
					candidate: { path: candidate.path, excerpt: candidate.excerpt.slice(0, 2000) },
				},
				questions: {
					new_info: { type: "noul", instructions: "noul: the candidate artifact contains substantive information NOT already covered by the existing inventory." },
					on_task: { type: "noul", instructions: "noul: the candidate artifact is relevant to the listed current tasks, including progress, verification, dependencies, or constraints that affect completing them." },
				},
			});
			const res = await fetch(process.env.JEV_ENDPOINT?.trim() || JEV_ENDPOINT_DEFAULT, {
				method: "POST",
				headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
				body,
				signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
			});
			if (res.ok) {
				const parsed = (await res.json()) as { answers?: Record<string, { noul?: number }> };
				const newInfo = parsed.answers?.new_info?.noul;
				const onTask = parsed.answers?.on_task?.noul;
				if (typeof newInfo === "number" && typeof onTask === "number") {
					if (newInfo < 0.35) return { v: "duplicate", source: "jev" };
					if (onTask < 0.35) return { v: "unrelated", source: "jev" };
					return { v: "relevant", source: "jev" };
				}
			}
		} catch {
			// degrade (AC-14)
		}
	}
	// degraded heuristic (AC-14): overlap vs existing texts
	const p = overlapScore(candidate.excerpt, existing.map((s) => s.excerpt));
	if (p > 0.7) return { v: "duplicate", source: "heuristic-degraded" };
	if (tasks.length > 0 && p < 0.15) return { v: "unrelated", source: "heuristic-degraded" };
	return { v: "relevant", source: "heuristic-degraded" };
}

// M1: ONE drift noul per user turn, spec-locked phrasing (spec-phase2 M1b).
// Returns null when keyless or fetch fails ⇒ caller falls back to heuristic (M1c).
/** Phase 4 M7/AC-8: POST /v1/systemone with one backoff retry on 429/529; other errors
 *  (401/422/timeout/network) return null immediately → degraded heuristics. */
async function postSystemOne(
	key: string,
	body: unknown,
	retries: number,
): Promise<{ answers?: Record<string, { noul?: number; score?: number; confidence?: number }>; usage?: { input_tokens?: number } } | null> {
	for (let attempt = 0; ; attempt++) {
		try {
			const res = await fetch(process.env.JEV_ENDPOINT?.trim() || JEV_ENDPOINT_DEFAULT, {
				method: "POST",
				headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
			});
			if ((res.status === 429 || res.status === 529) && attempt < retries) {
				await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
				continue;
			}
			if (!res.ok) return null;
			return (await res.json()) as { answers?: Record<string, { noul?: number; score?: number; confidence?: number }>; usage?: { input_tokens?: number } };
		} catch {
			return null;
		}
	}
}

async function jevDriftCall(userMsg: string, model: TaskModel): Promise<number | null> {
	const key = jevKey();
	if (!key) return null;
	try {
		const body = JSON.stringify({
			model: "jev-latest",
			state: {
				question: "Does the newest user message shift focus away from the pinned task model?",
				pinnedTaskModel: { tasks: model.tasks, topic: model.topic },
				newestUserMessage: userMsg.slice(0, 2000),
			},
			questions: {
				drift: { type: "noul", instructions: "noul: the newest user message shifts focus away from the pinned task model." },
			},
		});
		const res = await fetch(process.env.JEV_ENDPOINT?.trim() || JEV_ENDPOINT_DEFAULT, {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body,
			signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
		});
		if (res.ok) {
			const parsed = (await res.json()) as { answers?: Record<string, { noul?: number }> };
			const p = parsed.answers?.drift?.noul;
			if (typeof p === "number") return p;
		}
	} catch {
		// degrade (spec M1c)
	}
	return null;
}

// __eval — test/eval-only access to the judgment functions (L1 wire-contract
// test, L2 eval runner; .plans/CTXEVAL/eval-plan.md@4961e6ff). Not an
// extension API surface.
export const __eval = { ingestRelevance, jevDriftCall, overlapScore };

const STATUS_CHANNEL = "pi-extensions:status-line";
const SUITE_KEY = "ctx-suite";
const LEGACY_STATUS_KEY = "ctx-health";

export default function (pi: ExtensionAPI) {
	let st: CMState | undefined;
	// Status-line consolidation (../shared/status-line-protocol.md): latest
	// status per publisher source; rendered into the single ctx-suite segment.
	const busParts = new Map<string, { text?: string; short?: string }>();
	let lastRenderCtx: ExtensionContext | undefined;

	/** Latest health text for this extension (condensed in consolidated mode). */
	let lastHealthText = "";

	function consolidateOn(): boolean {
		return Boolean(st?.config.statusLine.enabled && st.config.statusLine.consolidate);
	}

	/** Render the combined ctx-suite segment: bus parts + own health text. */
	function renderSuite(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		lastRenderCtx = ctx;
		const parts: string[] = [];
		for (const p of busParts.values()) parts.push(p.short ?? p.text ?? "");
		if (lastHealthText) parts.push(lastHealthText);
		const joined = parts.filter(Boolean).join(" · ");
		ctx.ui.setStatus(SUITE_KEY, joined === "" ? undefined : joined);
	}

	pi.events.on(STATUS_CHANNEL, (data: unknown) => {
		const msg = data as { type?: string; source?: string; text?: string; short?: string } | undefined;
		if (!msg?.type || !consolidateOn()) return;
		if (msg.type === "publisher-hello") {
			pi.events.emit(STATUS_CHANNEL, { type: "renderer-hello" });
			return;
		}
		if (msg.type === "status" && msg.source) {
			if (msg.text === undefined && msg.short === undefined) busParts.delete(msg.source);
			else busParts.set(msg.source, { text: msg.text, short: msg.short });
			if (lastRenderCtx) renderSuite(lastRenderCtx);
		}
	});

	function refreshConfig(ctx: ExtensionContext) {
		st = {
			config: loadConfig(ctx.cwd),
			spans: [],
			hashCount: new Map(),
			verdictMemo: new Map(),
		pendingScores: new Set(),
			turn: 0,
			lastModelKey: null,
			lastPromptTokens: null,
			lastLLMAt: null,
		lastChPct: undefined,
			cacheSource: "unresolved",
			missStats: { missedTokens: 0, cause: null },
			taskModel: null,
			stagedModel: null,
			lastDriftSource: null,
			lastSeenTaskIds: [],
			toolNames: new Map(),
			lastPurity: null,
			elisionStats: { elided: 0, skipped: 0, tokens: 0 },
			flushQueued: false,
			lastCompactAt: null,
			compactInFlight: false,
			b6SuppressNext: false,
		burst: null,
		burstSeq: 0,
		lastCtxCallAt: null,
		sentPrefix: new Set(),
		appliedShas: new Set(),
		appliedKinds: new Map(),
		appliedTurns: new Map(),
		dirty: [],
		baselineViewTokens: 0,
		lastViewTokens: 0,
		compacting: false,
		shapeStats: { plans: 0, applied: 0, droppedAdjacency: 0, flushed: 0, flushedTok: 0, bypassed: 0, pruned: 0, sideCarSkips: 0, poisonActed: 0, poisonReview: 0, poisonDegraded: 0, redactHits: {}, errorLoopCollapsed: 0, errorLoopKept: 0 },
		lastFlush: null,
		argsKeyBySha: new Map(),
		appliedMeta: new Map(),
		redactApplied: new Set(),
		lastPoison: null,
		};
	}

	function taskSubjects(ctx: ExtensionContext): string[] {
		try {
			const subjects: string[] = [];
			for (const r of parseTaskRows(ctx.getSystemPrompt())) {
				if (r.status !== "completed" && r.status !== "cancelled") {
					subjects.push(r.subject);
					if (subjects.length >= 8) break;
				}
			}
			return subjects;
		} catch {
			return [];
		}
	}

	async function maybeScoreRelevance(span: Span, ctx: ExtensionContext): Promise<void> {
		if (!st) return;
		if (span.tok < st.config.relevanceMinTokens) return;
		const memo = st.verdictMemo.get(span.contentHash);
		if (memo) {
			span.verdict = memo;
			return;
		}
		// AC-3 (B2): ingest relevance scores against the PINNED task model, not the
		// live task list — staged switches apply only at the next user turn.
		const v = await ingestRelevance(span, st.spans, st.taskModel?.tasks ?? taskSubjects(ctx), st.config);
		st.verdictMemo.set(span.contentHash, v);
		span.verdict = v;
	}

	// M1: pin/detect/stage at message_end(role=user) (spec-phase2 M1, B2)
	async function handleUserTurn(userText: string, ctx: ExtensionContext): Promise<void> {
		if (!st) return;
		st.compacting = false; // Phase 3 M6: cleared at the next message_end(user)
		if (!st.burst) {
			st.burstSeq += 1; // Phase 3 M1: burst opens at the start of the new user turn
			st.burst = { id: st.burstSeq, userTurn: st.turn + 1, callNo: 0, plan: null, openedAt: Date.now() };
		}
		if (!st.config.taskSwitch.enabled) return;
		st.lastDriftSource = null; // per-turn: telemetry reports THIS turn's drift only (GLM review follow-up)
		const curIds = currentNonCompletedTaskIds(ctx);
		// B2 apply: a model staged by an earlier drift applies NOW, before pin/detect.
		// This is the ONLY path that ever mutates a pinned taskModel (circularity guard).
		if (st.stagedModel) {
			st.taskModel = st.stagedModel;
			st.stagedModel = null;
			rescoreAgainstModel(ctx); // M4: re-score spans vs the NEW model (AC-12)
		}
		if (!st.taskModel) {
			// first user turn: pin without scoring
			st.taskModel = { tasks: taskSubjects(ctx), topic: userText.slice(0, 200), turn: st.turn };
		} else {
			let drift = false;
			let source: DriftSource | null = null;
			if (taskListDiffers(curIds, st.lastSeenTaskIds)) {
				drift = true; // deterministic diff ⇒ drift, zero Jev fetches (AC-2)
				source = "task-diff";
			} else {
				const p = await jevDriftCall(userText, st.taskModel); // ≤1 Jev fetch per user turn (AC-1)
				if (p != null) {
					if (p > st.config.taskSwitch.driftThreshold) {
						drift = true;
						source = "jev";
					}
				} else {
					// degraded: keyless/failed fetch ⇒ overlap heuristic decides (AC-1)
					const ov = overlapScore(userText, [...st.taskModel.tasks, st.taskModel.topic]);
					if (ov < 0.15) {
						drift = true;
						source = "heuristic-degraded";
					}
				}
			}
			if (drift && source) {
				st.lastDriftSource = source;
				// STAGE only — applied at the NEXT message_end(role=user) (B2, AC-3)
				st.stagedModel = { tasks: taskSubjects(ctx), topic: userText.slice(0, 200), turn: st.turn };
			}
		}
		st.lastSeenTaskIds = curIds;
	}

	// M2: dump-class elision at message_end(role=toolResult) (spec-phase2 M2).
	// Fail-open everywhere: any side-car failure leaves the original message intact (AC-7).
	function elideToolResult(msg: { content?: unknown }, ctx: ExtensionContext): void {
		if (!st) return;
		const cfg = st.config.elision;
		if (!cfg.enabled) return;
		const text = textOf(msg.content);
		if (!text || text.startsWith("[elided ")) return; // idempotent stub skip (spec M2)
		const hash = createHash("sha1").update(text).digest("hex");
		const toolName = st.toolNames.get(hash);
		if (toolName === undefined) return; // unrecorded provenance ⇒ fail-open
		if (cfg.readToolNames.includes(toolName)) return; // B1: read results never elided (AC-5)
		let span: Span | undefined;
		for (let i = st.spans.length - 1; i >= 0; i--) {
			if (st.spans[i].contentHash === hash) {
				span = st.spans[i];
				break;
			}
		}
		if (!span || span.isError || span.cls === "error") return; // errors never elided (AC-6)
		const tok = Math.ceil(text.length / 4);
		if (tok < st.config.classification.dumpTokens) return; // below dump floor
		if (span.cls !== "unclassified" && span.cls !== "dup") return; // dump-class only
		const p = st.lastPurity ?? 0; // pressure = purity from last turn_end
		const budget = st.config.purityBudget.budget;
		if (p < budget) return; // under budget ⇒ no elision
		const hard = budget * st.config.purityBudget.hardMultiplier;
		const unrelated = span.verdict?.v === "unrelated";
		if (p < hard) {
			if (!unrelated) return; // soft tier: unrelated verdict only (AC-8)
		} else if (!unrelated && span.cls !== "dup") {
			return; // hard tier: unrelated verdict ∪ dup-class ONLY — an unclassified span without an unrelated verdict is retained (GLM M2 review Q1)
		}
		// side-car FIRST (AC-7)
		const sideCar = join(ctx.cwd, cfg.sideCarPath);
		try {
			let seq = 0;
			try {
				seq = readFileSync(sideCar, "utf8").split("\n").filter(Boolean).length;
			} catch {
				/* first append */
			}
			mkdirSync(dirname(sideCar), { recursive: true });
			appendFileSync(
				sideCar,
				`${JSON.stringify({
					ts: new Date().toISOString(),
					sessionId: ctx.sessionManager.getSessionId?.(),
					sha: hash,
					...(span.path ? { path: span.path } : {}),
					tok,
					text,
				})}\n`,
			);
			msg.content = `[elided ${tok} tok dump: sha=${hash}; archived: ${cfg.sideCarPath}#${seq}]`;
			st.elisionStats.elided += 1;
			st.elisionStats.tokens += tok;
		} catch {
			st.elisionStats.skipped += 1; // {elision:"skipped"} telemetry via turn_end (AC-7)
		}
	}

	// M3: compact trigger with cooldown + in-flight guards (spec-phase2 M3; B4 instructions locked)
	function triggerCompact(ctx: ExtensionContext): boolean {
		if (!st || st.compactInFlight) return false;
		const now = Date.now();
		if (st.lastCompactAt !== null && now - st.lastCompactAt < st.config.purityBudget.compactCooldownMin * 60_000) return false;
		st.compactInFlight = true;
		st.compacting = true; // Phase 3 M6: forced-prompt calls bypass shaping until the next user turn
		try {
			const res = (ctx as { compact?: (o: { customInstructions: string }) => unknown }).compact?.({
				customInstructions: st.config.compactInstructions,
			});
			if (res && typeof (res as Promise<void>).finally === "function") {
				// attach catch so a rejected compact promise never becomes unhandledRejection (GLM M3 review)
				(res as Promise<void>).finally(() => {
					if (st) st.compactInFlight = false;
				}).catch(() => {
					if (st) st.compactInFlight = false;
				});
			} else {
				st.compactInFlight = false;
			}
			st.lastCompactAt = now;
			st.b6SuppressNext = true; // B6: next assistant message_end skips cache-loss attribution
			// Post-compact ledger reset (GLM CTX2-3 review #2): the compacted context is
			// new ground — stale spans kept purity ≥ budget forever, re-triggering
			// cooldown-gated flushes. Task model (M1) intentionally survives compaction.
			// Fail-safe: armed even if the compact promise later rejects (throttles retries).
			st.spans = [];
			st.hashCount.clear();
			st.verdictMemo.clear();
			st.toolNames.clear();
			// GLM review F3: the compacted transcript is a NEW baseline — shaping state
			// referencing the dead prefix must reset too, or turn_end can graduate dead
			// shas from the dirty queue (burning the M5/M3 XOR on a no-op flush)
			st.dirty = [];
			st.appliedShas.clear();
			st.appliedTurns.clear();
			st.argsKeyBySha.clear();
			st.sentPrefix.clear();
			return true;
		} catch {
			st.compactInFlight = false;
			return false;
		}
	}

	// M4: re-score recent spans against the newly applied task model (spec-phase2 M4, AC-12).
	// ONE batched Jev call (per-span on_task noul); degraded ⇒ overlap heuristic per span.
	// Non-blocking: promise joins st.pendingScores, awaited at turn_end BEFORE M3 purity.
	function rescoreAgainstModel(ctx: ExtensionContext): void {
		if (!st || !st.taskModel) return;
		const model = st.taskModel;
		const turn = st.turn;
		const candidates = st.spans.filter((s) => s.verdict != null || s.tok >= st!.config.relevanceMinTokens);
		const batch = candidates.slice(-st.config.taskSwitch.rescoreBatch);
		if (batch.length === 0) return;
		const applyAnswer = (span: Span, onTask: number | null): void => {
			if (onTask != null) {
				span.verdict = { v: onTask < 0.35 ? "unrelated" : "relevant", source: "jev" };
			} else {
				const ov = overlapScore(span.excerpt, [...model.tasks, model.topic]);
				span.verdict = { v: ov < 0.15 ? "unrelated" : "relevant", source: "heuristic-degraded" };
			}
			span.rescoredAtTurn = turn;
		};
		const key = jevKey();
		if (!key) {
			for (const span of batch) applyAnswer(span, null); // degraded (AC-12)
			return;
		}
		const pending = (async (): Promise<void> => {
			try {
				const questions: Record<string, { type: string; instructions: string }> = {};
				for (let i = 0; i < batch.length; i++) {
					questions[`span${i}`] = {
						type: "noul",
						instructions: `noul: span ${i} (${batch[i].path ?? "tool result"}, ~${batch[i].tok} tok) is relevant to the listed current tasks.`,
					};
				}
				const body = JSON.stringify({
					model: "jev-latest",
					state: {
						question: "After a task switch, which of these spans are relevant to the new pinned task model?",
						pinnedTaskModel: { tasks: model.tasks, topic: model.topic },
						spans: batch.map((s, i) => ({ i, path: s.path ?? null, tok: s.tok, class: s.cls, excerpt: s.excerpt.slice(0, 600) })),
					},
					questions,
				});
				const res = await fetch(process.env.JEV_ENDPOINT?.trim() || JEV_ENDPOINT_DEFAULT, {
					method: "POST",
					headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
					body,
					signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
				});
				if (res.ok) {
					const parsed = (await res.json()) as { answers?: Record<string, { noul?: number }> };
					for (let i = 0; i < batch.length; i++) {
						const onTask = parsed.answers?.[`span${i}`]?.noul;
						applyAnswer(batch[i], typeof onTask === "number" ? onTask : null);
					}
					return;
				}
			} catch {
				// degrade below (AC-12)
			}
			for (const span of batch) applyAnswer(span, null);
		})();
		const tracked = pending.finally(() => {
			st?.pendingScores.delete(tracked);
		});
		st.pendingScores.add(tracked);
	}

	// ---------- Phase 3: per-call view shaping (spec-phase3.md M1–M6) ----------

	function msgTok(m: { content?: unknown }): number {
		return Math.ceil(textOf(m.content).length / 4);
	}

	interface ToolResultInfo {
		idx: number;
		sha: string;
		toolName?: string;
		toolCallId?: string;
		text: string;
		tok: number;
		assistantIdx: number;
	}

	/** Index toolResult messages by content sha; locate the assistant carrying each call. */
	function indexToolResults(messages: any[]): Map<string, ToolResultInfo> {
		const bySha = new Map<string, ToolResultInfo>();
		for (let i = 0; i < messages.length; i++) {
			const m = messages[i] as { role?: string; content?: unknown; toolName?: string; toolCallId?: string };
			if (!m || m.role !== "toolResult") continue;
			const text = textOf(m.content);
			if (!text) continue;
			const sha = createHash("sha1").update(text).digest("hex");
			if (bySha.has(sha)) continue;
			const info: ToolResultInfo = { idx: i, sha, toolName: m.toolName, toolCallId: m.toolCallId, text, tok: Math.ceil(text.length / 4), assistantIdx: -1 };
			if (info.toolCallId) {
				for (let j = i - 1; j >= 0; j--) {
					const a = messages[j] as { role?: string; content?: Array<{ type?: string; id?: string }> };
					if (a?.role === "assistant" && Array.isArray(a.content) && a.content.some((c) => c?.type === "toolCall" && c.id === info.toolCallId)) {
						info.assistantIdx = j;
						break;
					}
				}
			}
			bySha.set(sha, info);
		}
		return bySha;
	}

	function spanBySha(sha: string): Span | undefined {
		if (!st) return undefined;
		for (let i = st.spans.length - 1; i >= 0; i--) if (st.spans[i].contentHash === sha) return st.spans[i];
		return undefined;
	}

	/** Eligibility (spec M3/M4). Returns the shape class or null. */
	function shapeKind(sha: string, info: ToolResultInfo): ShapeKind | null {
		if (!st) return null;
		if (info.text.startsWith("[shaped ") || info.text.startsWith("[elided ")) return null; // AC-35 idempotence
		if (info.tok < st.config.classification.dumpTokens) return null; // dump floor
		const toolName = info.toolName ?? st.toolNames.get(sha);
		if (toolName != null && st.config.elision.readToolNames.includes(toolName)) return null; // B1 (AC-14)
		// pick the newest NON-warm span for this sha (M3 warm check is per-span: a copy
		// re-emitted in the current burst must not shadow the sent, eligible original)
		const sp = st.spans
			.filter((s) => s.contentHash === sha && (!st.burst || s.capturedAt < st.burst.openedAt))
			.at(-1);
		if (!sp) return null; // only warm copies ⇒ nothing eligible (AC-15)
		if (sp.isError || sp.cls === "error") return null; // AC-16
		if (st.appliedShas.has(sha)) return null; // already baseline
		if (sp.cls === "dup" || sp.cls === "stale") return "stale-dedupe"; // M2 left it: below pressure tier
		if (sp.verdict?.v === "unrelated" && sp.rescoredAtTurn !== undefined) return "task-evict"; // AC-20
		const key = st.argsKeyBySha.get(sha);
		if (key) {
			// superseded-collapse precondition: a newer span with identical toolName+args exists
			const newer = st.spans.some(
				(s) => s.contentHash !== sha && s.capturedAt > sp.capturedAt && st.argsKeyBySha.get(s.contentHash) === key,
			);
			if (newer) return "superseded-collapse";
		}
		return null;
	}

	/** Side-car BEFORE first application in any view (AC-33). Fail-open. */
	function writeSideCar(ctx: ExtensionContext, info: ToolResultInfo, kind: ShapeKind): boolean {
		if (!st) return false;
		try {
			const sideCarPath = join(ctx.cwd, st.config.elision.sideCarPath);
			let seq = 0;
			try {
				seq = readFileSync(sideCarPath, "utf8").split("\n").filter(Boolean).length;
			} catch {
				/* first append */
			}
			mkdirSync(dirname(sideCarPath), { recursive: true });
			const args = st.argsKeyBySha.get(info.sha);
			const redArgs = redactText((args ?? "").slice(0, st.config.shaping.argsCap), st.config.poison.redactionPatterns).text;
			const redText = redactText(info.text, st.config.poison.redactionPatterns).text; // AC-10: idempotent for capture-redacted text; covers legacy spans
			appendFileSync(
				sideCarPath,
				`${JSON.stringify({
					ts: new Date().toISOString(),
					sessionId: ctx.sessionManager.getSessionId?.(),
					kind: "shape",
					shapeKind: kind,
					sha: spanBySha(info.sha)?.restoreHash ?? info.sha,
					...(info.toolName ? { toolName: info.toolName } : {}),
					...(args ? { args: redArgs } : {}),
					tok: info.tok,
					text: redText,
				})}\n`,
			);
			return true;
		} catch {
			return false;
		}
	}

	/** Prune queued ops whose target vanished from the transcript (post-compact, AC-32). */
	function pruneDirty(index: Map<string, ToolResultInfo>): void {
		if (!st || st.dirty.length === 0) return;
		const before = st.dirty.length;
		st.dirty = st.dirty.filter((d) => index.has(d.sha));
		st.shapeStats.pruned += before - st.dirty.length;
	}

	/** Shared enqueue path (AC-7 single authoritative act path): side-car BEFORE any
	 *  application (AC-33); unsent applies this burst at zero cost (AC-8), sent queues via M5 (E6).
	 *  Idempotence: appliedShas + dirty membership block double-enqueue from battery AND freeze. */
	function enqueueOp(ctx: ExtensionContext, index: Map<string, ToolResultInfo>, ops: ShapePlan["ops"], sha: string, kind: ShapeKind, meta?: ShapeOpMeta, skipSideCar = false): void {
		if (!st) return;
		const info = index.get(sha);
		if (!info) return;
		if (st.appliedShas.has(sha) || st.dirty.some((d) => d.sha === sha)) return;
		if (st.sentPrefix.has(sha)) {
			if (skipSideCar || writeSideCar(ctx, info, kind)) {
				st.dirty.push({
					kind,
					sha,
					toolName: info.toolName ?? st.toolNames.get(sha) ?? "unknown",
					tok: info.tok,
					turn: st.turn,
					enqueuedAt: Date.now(),
					meta,
				});
			} else {
				st.shapeStats.sideCarSkips += 1;
			}
		} else if (skipSideCar || writeSideCar(ctx, info, kind)) {
			st.appliedShas.add(sha);
			st.appliedKinds.set(sha, kind);
			st.appliedTurns.set(sha, st.turn);
			if (meta) st.appliedMeta.set(sha, meta);
			ops.push({ kind, sha, idx: info.idx, meta });
		} else {
			st.shapeStats.sideCarSkips += 1;
		}
	}

	/** M9 error-loop groups (AC-13/AC-14): ≥ errorLoopMin error spans sharing toolName +
	 *  argsKey + normalized signature. Sole error-shaping class; M3/M4 never touch errors. */
	/** M9 error-loop collapse (AC-13/AC-15/AC-16). OCCURRENCE-AWARE: byte-identical
	 *  errors share ONE sha (index dedupes) — the loop size is the total capture count
	 *  (hashCount); near-identical errors share the normalized signature. The newest
	 *  content's LAST view occurrence stays raw; every other occurrence stubs. */
	function errorLoopOps(ctx: ExtensionContext, index: Map<string, ToolResultInfo>): ShapePlan["ops"] {
		const ops: ShapePlan["ops"] = [];
		if (!st || !st.config.poison.enabled) return ops;
		const groups = new Map<string, { shas: string[]; size: number }>();
		for (const info of index.values()) {
			const toolName = info.toolName ?? st.toolNames.get(info.sha);
			if (!toolName || st.config.elision.readToolNames.includes(toolName)) continue; // B1 (AC-14)
			const sp = spanBySha(info.sha);
			if (!sp?.isError) continue; // error spans only
			const capturedSpan = st.spans.filter((s) => s.contentHash === info.sha).at(-1);
			if (st.burst && capturedSpan && capturedSpan.capturedAt >= st.burst.openedAt) continue; // warm exempt (one-burst delay is deliberate — spec M9)
			const key = `${toolName}|${st.argsKeyBySha.get(info.sha) ?? ""}|${errorSignature(sp.textRedacted ?? info.text)}`;
			const g = groups.get(key) ?? { shas: [], size: 0 };
			g.shas.push(info.sha);
			g.size += Math.max(1, st.hashCount.get(info.sha) ?? 1); // occurrences, not unique shas
			groups.set(key, g);
		}
		for (const [key, g] of groups) {
			if (g.size < st.config.poison.errorLoopMin) continue;
			// E6 split (AC-13): a group can straddle the sent boundary — each subset gets
			// its own op (unsent applies this burst; sent queues via M5 for the flush)
			const subsets = [
				g.shas.filter((s) => !st!.sentPrefix.has(s)),
				g.shas.filter((s) => st!.sentPrefix.has(s)),
			];
			for (const members of subsets) {
				if (members.length === 0) continue;
				const newestSha = [...members].sort((a, b) => (spanBySha(b)?.capturedAt ?? 0) - (spanBySha(a)?.capturedAt ?? 0))[0];
				const representative = members[0];
				const repInfo = index.get(representative);
				if (!repInfo) continue;
				const toolName = repInfo.toolName ?? st.toolNames.get(repInfo.sha) ?? "tool";
				const parts = key.split("|");
				// the stub advertises the KEPT span's RESTORABLE hash (redacted identity)
				const newestSpan = spanBySha(newestSha);
				const restoreSha8 = (newestSpan?.restoreHash ?? newestSha).slice(0, 8);
				const meta: ShapeOpMeta = {
					n: g.size,
					newestSha,
					shas: [...members],
					toolName,
					argsKey: parts[1] ?? "",
					sig: parts.slice(2).join("|"),
					stub: `[error-loop: ${toolName} ×${g.size} identical failures @turn ${st.turn}; sha=${restoreSha8}; /ctx:restore ${restoreSha8}]`,
				};
				// side-car BEFORE first application (AC-33/AC-16): per-member entries carry
				// the restorable redacted text; enqueueOp skips its own write (no duplicates)
				for (const sha of members) {
					const mi = index.get(sha);
					if (mi) writeSideCar(ctx, mi, "error-loop");
				}
				enqueueOp(ctx, index, ops, representative, "error-loop", meta, true);
				st.shapeStats.errorLoopCollapsed += g.size - 1;
				st.shapeStats.errorLoopKept += 1;
			}
		}
		return ops;
	}

	/** M9 view application: stub every occurrence of the loop's members except the LAST
	 *  occurrence of the kept (newest) sha. Text-only swaps — structure/adjacency intact. */
	function applyErrorLoop(view: any[], op: ShapePlan["ops"][number]): { view: any[]; applied: number } {
		const meta = op.meta;
		if (!meta?.shas?.length || !meta.newestSha || !meta.stub) return { view, applied: 0 };
		const memberShas = new Set(meta.shas);
		const occurrences: Array<{ idx: number; sha: string }> = [];
		for (let i = 0; i < view.length; i++) {
			const m = view[i] as { role?: string; content?: unknown };
			if (!m || m.role !== "toolResult") continue;
			const text = textOf(m.content);
			if (!text || text.startsWith("[error-loop") || text.startsWith("[shaped ") || text.startsWith("[elided ")) continue; // AC-35 idempotence
			const sha = createHash("sha1").update(text).digest("hex");
			if (memberShas.has(sha)) occurrences.push({ idx: i, sha });
		}
		let keptIdx = -1;
		for (let i = occurrences.length - 1; i >= 0; i--) {
			if (occurrences[i].sha === meta.newestSha) {
				keptIdx = occurrences[i].idx;
				break;
			}
		}
		if (keptIdx === -1 && occurrences.length > 0) keptIdx = occurrences[occurrences.length - 1].idx; // kept content absent ⇒ keep the last remaining
		const targets = occurrences.filter((o) => o.idx !== keptIdx);
		if (targets.length === 0) return { view, applied: 0 };
		let newView = view.slice();
		for (const t of targets) {
			const m = { ...(newView[t.idx] as Record<string, unknown>) };
			m.content = [{ type: "text", text: meta.stub }];
			newView[t.idx] = m;
		}
		return { view: newView, applied: targets.length };
	}

	/** M2: frozen plan for the burst. Unsent ops apply immediately; sent ops queue (E6/M5). */
	function buildPlan(messages: any[], ctx: ExtensionContext): ShapePlan {
		if (!st) return { computedAt: Date.now(), ops: [] };
		const index = indexToolResults(messages);
		pruneDirty(index); // AC-32
		const ops: ShapePlan["ops"] = [];
		for (const info of index.values()) {
			const kind = shapeKind(info.sha, info);
			if (!kind) continue;
			enqueueOp(ctx, index, ops, info.sha, kind);
		}
		// Phase 4 M9 (after M3/M4: AC-14 error exemption intact for those classes)
		for (const op of errorLoopOps(ctx, index)) ops.push(op);
		// Phase 4 AC-23/AC-7: freeze CONSUMES pre-existing unconsumed poison metadata it
		// indexed (read-only bookkeeping — the routing decision already happened at turn_end).
		const nowTs = Date.now();
		for (const sha of index.keys()) {
			const sp = spanBySha(sha);
			if (sp?.poison && sp.poison.consumedAt === undefined) sp.poison.consumedAt = nowTs;
		}
		// baseline ops: appliedShas re-apply on every call of every burst (M5 flush outcome)
		for (const sha of st.appliedShas) {
			if (ops.some((o) => o.sha === sha)) continue;
			const info = index.get(sha);
			if (info) ops.push({ kind: st.appliedKinds.get(sha) ?? "stale-dedupe", sha, idx: info.idx, meta: st.appliedMeta.get(sha) });
		}
		st.shapeStats.plans += 1;
		return { computedAt: Date.now(), ops };
	}

	function stubText(info: ToolResultInfo, turn: number, meta?: ShapeOpMeta): string {
		if (meta?.stub) return meta.stub;
		if (meta?.n != null && meta.newestSha != null) {
			// M9 error-loop stub (AC-15): NO rerun affordance — an identical signature ×N
			// is persistent; re-running invites the loop M9 exists to suppress.
			const restoreSha8 = (spanBySha(meta.newestSha)?.restoreHash ?? meta.newestSha).slice(0, 8);
			return `[error-loop: ${info.toolName ?? "tool"} ×${meta.n} identical failures @turn ${turn}; sha=${restoreSha8}; /ctx:restore ${restoreSha8}]`;
		}
		return `[shaped: ${info.toolName ?? "tool"} -${info.tok} tok @turn ${turn}; sha=${info.sha.slice(0, 8)}; rerun call above or /ctx:restore ${info.sha.slice(0, 8)}]`;
	}

	function removeFromPlan(plan: ShapePlan, op: ShapePlan["ops"][number]): void {
		plan.ops = plan.ops.filter((o) => o !== op); // dropped FOR THE WHOLE BURST — views stay identical (AC-10..12)
	}

	/** E4 self-validation (pi validates nothing — agent-loop.js:24–26). */
	function adjacencyValid(messages: any[]): boolean {
		if (messages.length === 0) return true;
		const calls = new Map<string, number>();
		for (let ci = 0; ci < messages.length; ci++) {
			const msg = messages[ci] as { role?: string; content?: Array<{ type?: string; id?: string }> };
			if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
			for (const c of msg.content) {
				if (c?.type === "toolCall" && c.id) calls.set(c.id, ci); // record position for A0 (order)
			}
		}
		const seen = new Set<string>();
		for (let ri = 0; ri < messages.length; ri++) {
			const msg = messages[ri] as { role?: string; toolCallId?: string };
			if (msg?.role !== "toolResult") continue;
			// A2: every surviving toolResult's call must exist in the view
			const callIdx = msg.toolCallId ? calls.get(msg.toolCallId) : undefined;
			if (callIdx === undefined) return false;
			// A0 (GLM review F5): results may not precede their call
			if (ri < callIdx) return false;
			// A1: one result per call occurrence — duplicates leave residual counts > 1
			if (seen.has(msg.toolCallId)) return false;
			seen.add(msg.toolCallId);
		}
		// A1: every surviving call occurrence must have its result present
		for (const id of calls.keys()) if (!seen.has(id)) return false;
		// A3: last message must convert to user | toolResult
		const lastRole = (messages[messages.length - 1] as { role?: string } | undefined)?.role;
		return lastRole === "user" || lastRole === "toolResult";
	}

	function applyPlan(messages: any[], plan: ShapePlan): { view: any[]; applied: number; droppedAdjacency: number } {
		let view = messages;
		let applied = 0;
		let droppedAdjacency = 0;
		const turnOf = (sha: string) => st?.appliedTurns.get(sha) ?? st?.turn ?? 0;
		const stubOps: ShapePlan["ops"] = [];
		const dropOps: ShapePlan["ops"] = [];
		for (const op of plan.ops) (op.kind === "superseded-collapse" ? dropOps : stubOps).push(op);
		// P1 stubs first, per-op (a violation drops ONLY that op — AC-10..12)
		for (const op of stubOps) {
			if (op.kind === "error-loop") {
				// M9 group application: stubs every loop occurrence except the kept newest
				const r = applyErrorLoop(view, op);
				if (r.applied === 0) continue; // nothing to stub this call (fail-safe)
				if (adjacencyValid(r.view)) {
					view = r.view;
					applied += r.applied;
				} else {
					droppedAdjacency += 1;
					removeFromPlan(plan, op);
				}
				continue;
			}
			const index = indexToolResults(view);
			const info = index.get(op.sha);
			if (!info) continue; // target absent this call ⇒ skip (fail-safe)
			const newView = view.slice();
			const m = { ...(newView[info.idx] as Record<string, unknown>) };
			m.content = [{ type: "text", text: stubText(info, turnOf(op.sha), op.meta) }];
			newView[info.idx] = m;
			if (adjacencyValid(newView)) {
				view = newView;
				applied += 1;
			} else {
				droppedAdjacency += 1;
				removeFromPlan(plan, op);
			}
		}
		// P2 pair-drop: superseded-collapse only, strictly guarded (AC-18/AC-21)
		for (const op of dropOps) {
			const index = indexToolResults(view);
			const info = index.get(op.sha);
			const candidate = pairDropView(view, op, info);
			if (candidate) {
				if (adjacencyValid(candidate)) {
					view = candidate;
					applied += 1;
					continue;
				}
				droppedAdjacency += 1;
				removeFromPlan(plan, op);
				continue;
			}
			// guards not met ⇒ P1 stub (default action, Jev D3)
			if (!info) continue;
			const newView = view.slice();
			const m = { ...(newView[info.idx] as Record<string, unknown>) };
			m.content = [{ type: "text", text: stubText(info, turnOf(op.sha), op.meta) }];
			newView[info.idx] = m;
			if (adjacencyValid(newView)) {
				view = newView;
				applied += 1;
			} else {
				droppedAdjacency += 1;
				removeFromPlan(plan, op);
			}
		}
		return { view, applied, droppedAdjacency };
	}

	/** P2 pair-drop for superseded-collapse: drop old call+result together (AC-18 guards). */
	function pairDropView(messages: any[], op: ShapePlan["ops"][number], info: ToolResultInfo | undefined): any[] | null {
		if (!st || !info || info.assistantIdx < 0 || info.toolCallId == null) return null;
		const asst = messages[info.assistantIdx] as { role?: string; content?: Array<{ type?: string; id?: string }> } | undefined;
		if (!asst || asst.role !== "assistant") return null;
		const calls = (asst.content ?? []).filter((c) => c?.type === "toolCall");
		if (calls.length !== 1) return null; // multi-call batch ⇒ stub instead (adjacency-safe)
		const sp = spanBySha(op.sha);
		const key = sp ? st.argsKeyBySha.get(op.sha) : undefined;
		if (!sp || key == null) return null;
		// AC-18: a newer equivalent output must remain in view
		let newerInView = false;
		for (const sha2 of indexToolResults(messages).keys()) {
			if (sha2 === op.sha) continue;
			const s2 = spanBySha(sha2);
			if (s2 && s2.capturedAt > sp.capturedAt && st.argsKeyBySha.get(sha2) === key) {
				newerInView = true;
				break;
			}
		}
		if (!newerInView) return null;
		const view = messages.slice();
		view[info.idx] = null as unknown as object;
		view[info.assistantIdx] = null as unknown as object;
		return view.filter((m) => m !== null);
	}

	/** M5 trigger evaluation at a burst boundary. Priority: cap > ttl > floor > hard. */
	function shapeFlushTrigger(rt: CMState): "ttl" | "floor" | "hard" | "cap" | null {
		if (rt.dirty.length === 0) return null;
		const dirtyTok = rt.dirty.reduce((a, d) => a + d.tok, 0);
		if (rt.dirty.length >= rt.config.dirtyQueue.maxEntries || dirtyTok >= rt.config.dirtyQueue.maxTok) return "cap"; // AC-24
		const last = rt.lastCtxCallAt ?? rt.lastLLMAt;
		if (last != null && Date.now() - last >= rt.config.shaping.cacheTtlMin * 60_000) return "ttl"; // AC-25 (a)
		if (rt.lastPurity != null) {
			if (1 - rt.lastPurity < rt.config.shaping.qualityFloor) return "floor"; // AC-26 (b)
			if (rt.lastPurity >= rt.config.purityBudget.budget * rt.config.purityBudget.hardMultiplier) return "hard"; // AC-27 (c)
		}
		return null;
	}

	/** M5 flush: graduate queued ops into the applied baseline — ONE prefix-dirtying. */
	function flushDirty(rt: CMState, trigger: "ttl" | "floor" | "hard" | "cap"): void {
		const capTok = rt.config.shaping.maxEvictShare * (rt.baselineViewTokens || rt.lastViewTokens || 1); // AC-23
		const flushing: DirtyOp[] = [];
		const rest: DirtyOp[] = [];
		let tok = 0;
		for (const op of rt.dirty) {
			if (tok + op.tok <= capTok) {
				flushing.push(op);
				tok += op.tok;
			} else {
				rest.push(op); // excess stays queued (oldest-first dequeue)
			}
		}
		for (const op of flushing) {
			rt.appliedShas.add(op.sha);
			rt.appliedKinds.set(op.sha, op.kind);
			rt.appliedTurns.set(op.sha, rt.turn);
		}
		rt.dirty = rest;
		rt.shapeStats.flushed += flushing.length;
		rt.shapeStats.flushedTok += tok;
		rt.lastFlush = { trigger, turn: rt.turn };
		rt.b6SuppressNext = true; // B6 extension: the flush dirties the prefix once (spec M5)
	}

	// ---------- Phase 4 M7: poison battery (spec-phase4.md@43a7f0c1) ----------
	/** AC-2/AC-23: pre-eligible spans NOT already acted/queued; re-ask suppressed while
	 *  poison metadata is live-unconsumed; oldest-first so deep-prefix poison is not
	 *  starved by the spansPerCall cap; errors excluded (M9's domain, AC-14). */
	function poisonCandidates(): Span[] {
		if (!st || !st.burst || st.compacting || !st.config.poison.enabled) return [];
		const out: Span[] = [];
		for (const s of st.spans) {
			if (s.isError) continue;
			if (s.tok < st.config.classification.dumpTokens) continue; // dump floor
			const toolName = st.toolNames.get(s.contentHash);
			if (!toolName) continue; // assistant/user spans are not battery candidates
			if (st.config.elision.readToolNames.includes(toolName)) continue; // B1 (AC-2)
			if (st.burst && s.capturedAt >= st.burst.openedAt) continue; // warm/current-burst (AC-2)
			if (st.appliedShas.has(s.contentHash)) continue; // already baseline
			if (st.dirty.some((d) => d.sha === s.contentHash)) continue; // pending (AC-23)
			if (s.poison && s.poison.consumedAt === undefined) continue; // re-ask suppressed (AC-23)
			out.push(s);
		}
		out.sort((a, b) => a.capturedAt - b.capturedAt); // oldest-unverdicted-first (AC-23)
		return out.slice(0, st.config.poison.spansPerCall);
	}

	/** AC-5/AC-6/AC-24: scale-clean truth table; confidence gates the Score arm only
	 *  (nouls carry none — api.md); degraded sources are capped at review. */
	function routePoison(s: Span): "act" | "review" | "pass" {
		const cfg = st!.config.poison;
		const p = s.poison!;
		const actOnStale = p.stale >= cfg.stalenessAct && (p.scoreConf ?? 0) >= 0.5; // AC-24
		const act = p.contra >= cfg.contradictionAct || actOnStale;
		if (act) return p.source === "poison-degraded" ? "review" : "act"; // AC-6 degraded ceiling
		const review = p.contra >= cfg.reviewFloor || p.stale >= cfg.stalenessReview;
		return review ? "review" : "pass";
	}

	/** AC-1/AC-3/AC-4/AC-7/AC-8/AC-22: one call per turn, inside turn_end, before burst
	 *  teardown and M5 flush evaluation; act enqueues via the single authoritative path. */
	async function poisonBattery(rt: CMState, ctx: ExtensionContext): Promise<void> {
		const cfg = rt.config.poison;
		if (!cfg.enabled || !rt.burst || rt.compacting) return; // AC-1
		const candidates = poisonCandidates();
		if (candidates.length === 0) return;
		let degraded = false;
		let inputTokens = 0;
		let live: Span[] = candidates;
		const key = jevKey();
		if (!key) {
			degraded = true;
		} else {
			const questions: Record<string, unknown> = {};
			const candTools = new Set(candidates.map((s) => rt.toolNames.get(s.contentHash)));
			// newest-per-candidate-tools inventory (spec: "newest same-tool outputs")
			const newestOutputs = rt.spans
				.filter((x) => candTools.has(rt.toolNames.get(x.contentHash)))
				.slice(-5)
				.map((x) => ({
					sha8: x.contentHash.slice(0, 8),
					tool: rt.toolNames.get(x.contentHash) ?? "tool",
					excerpt: redactText(x.excerpt, rt.config.poison.redactionPatterns).text.slice(0, 200),
				}));
			for (const s of candidates) {
				const sha8 = s.contentHash.slice(0, 8);
				questions[`contra_${sha8}`] = {
					type: "noul",
					instructions: {
						question: `Does span ${sha8} (tool ${rt.toolNames.get(s.contentHash) ?? "tool"}) contain content that contradicts any newer retained output in newest_outputs or the current task list?`,
						// defense-in-depth: send-time redaction even for legacy spans whose
						// captured excerpt predates M8 (GLM post-review finding 1)
						span_excerpt: redactText(s.textRedacted ?? s.excerpt, rt.config.poison.redactionPatterns).text.slice(0, cfg.excerptCap),
					},
				};
				questions[`stale_${sha8}`] = {
					type: "score",
					instructions: `Rate how stale or superseded span ${sha8} is now, given newest_outputs.`,
					criteria: ["fresh — current and consistent", "aged but still valid", "superseded by newer content", "wrong or contradicted"],
				};
			}
			const state = {
				turn: rt.turn,
				taskList: rt.taskModel?.tasks ?? [],
				// field names avoid `state.spans` — that key is the Phase-2 M4 rescore-call
				// contract (tests/wiring discriminate batteries from rescores by it)
				poisonSpans: candidates.map((s) => ({
					sha8: s.contentHash.slice(0, 8),
					tool: rt.toolNames.get(s.contentHash) ?? "tool",
					ageMin: Math.round((Date.now() - s.capturedAt) / 60000),
					excerpt: redactText(s.textRedacted ?? s.excerpt, rt.config.poison.redactionPatterns).text.slice(0, cfg.excerptCap),
				})),
				poisonNewest: newestOutputs,
			};
			const parsed = await postSystemOne(key, { model: "jev-latest", state, questions }, 1);
			// AC-1 effect-time revalidation (GLM post-review finding 2): the await window
			// may have seen compaction start or span eviction — only LIVE candidates route
			const live = rt.compacting || !rt.burst ? [] : candidates.filter((s) => rt.spans.includes(s));
			if (!parsed) {
				degraded = true;
			} else {
				inputTokens = parsed.usage?.input_tokens ?? 0;
				for (const s of live) {
					const sha8 = s.contentHash.slice(0, 8);
					const contra = parsed.answers?.[`contra_${sha8}`]?.noul;
					const staleAns = parsed.answers?.[`stale_${sha8}`];
					if (typeof contra !== "number" || typeof staleAns?.score !== "number") {
						degraded = true; // malformed answer ⇒ degrade THIS candidate only (finding 7)
						continue;
					}
					s.poison = {
						contra,
						stale: staleAns.score,
						...(typeof staleAns.confidence === "number" ? { scoreConf: staleAns.confidence } : {}),
						source: "jev",
						at: Date.now(),
					};
				}
			}
		}
		if (degraded) {
			// AC-6: heuristic fallback, capped at review downstream
			for (const s of live) {
				if (s.poison?.source === "jev") continue; // valid verdicts survive partial degrade (finding 7)
				const own = rt.argsKeyBySha.get(s.contentHash);
				const newerSame = rt.spans.some(
					(x) => x.contentHash !== s.contentHash && x.capturedAt >= s.capturedAt && own != null && rt.argsKeyBySha.get(x.contentHash) === own,
				);
				const ageMin = (Date.now() - s.capturedAt) / 60000;
				s.poison = {
					contra: newerSame ? 0.6 : 0.1,
					stale: ageMin >= 3 * rt.config.shaping.cacheTtlMin ? 2 : 0,
					source: "poison-degraded",
					at: Date.now(),
				};
			}
		}
		let acted = 0;
		let review = 0;
		for (const s of live) {
			if (!s.poison) continue;
			const route = routePoison(s);
			if (route === "act") {
				// AC-7 single authoritative path: enqueue through enqueueOp (side-car first,
				// appliedShas/dirty idempotence; sent → M5 queue rides THIS boundary's flush).
				const info: ToolResultInfo = {
					idx: -1,
					sha: s.contentHash,
					toolName: rt.toolNames.get(s.contentHash),
					text: s.textRedacted ?? s.excerpt,
					tok: s.tok,
					assistantIdx: -1,
				};
				enqueueOp(ctx, new Map([[s.contentHash, info]]), [], s.contentHash, "poison-stub");
				if (s.poison) s.poison.consumedAt = Date.now();
				acted += 1;
			} else if (route === "review") {
				review += 1; // metadata stays live-unconsumed; next freeze consumes it (AC-23)
			}
		}
		if (degraded) rt.shapeStats.poisonDegraded += 1;
		rt.shapeStats.poisonActed += acted;
		rt.shapeStats.poisonReview += review;
		rt.lastPoison = { turn: rt.turn, candidates: candidates.length, acted, review, degraded: degraded ? 1 : 0, inputTokens, noulPolicy: "raw-probability" as const };
	}

	// Phase 3 M1–M6: `context` handler — per-call view ONLY, transcript never mutated (E5).
	pi.on("context", async (event, ctx) => {
		if (!st?.config.enabled || !st.config.shaping.enabled) return undefined; // AC-44
		st.lastCtxCallAt = Date.now(); // M1 spy: doubles as the cache-temperature stamp (AC-4)
		if (st.compacting || !st.burst) {
			st.shapeStats.bypassed += 1; // M6 forced-prompt/ambient bypass (AC-30)
			return undefined;
		}
		const burst = st.burst;
		burst.callNo += 1;
		try {
			const messages = ((event as { messages?: unknown }).messages ?? []) as any[];
			st.lastViewTokens = messages.reduce((a: number, m: { content?: unknown }) => a + msgTok(m), 0);
			if (!burst.plan) {
				burst.plan = buildPlan(messages, ctx);
				st.baselineViewTokens = st.lastViewTokens;
			}
			const r = applyPlan(messages, burst.plan);
			st.shapeStats.droppedAdjacency += r.droppedAdjacency;
			// Phase 4 M8 view substitution (AC-12) — runs LAST, on the final view, so
			// plan-time indexing keeps the RAW-transcript identity (contentHash = raw sha).
			// The REDACTED form is what the model sees from the FIRST send — no extra
			// prefix-dirtying, deterministic per call. Text-only swaps; adjacency holds.
			let redactShipped = false;
			{
				try {
					let view = r.view;
					let changed = false;
					for (const [sha, info] of indexToolResults(r.view)) {
						const sp = spanBySha(sha);
						if (!sp?.textRedacted || sp.textRedacted === info.text) continue;
						if (!changed) {
							view = view.slice();
							changed = true;
						}
						const m = { ...(view[info.idx] as Record<string, unknown>) };
						m.content = [{ type: "text", text: sp.textRedacted }];
						view[info.idx] = m;
						if (!st.redactApplied.has(sha)) {
							st.redactApplied.add(sha);
							const sp2 = spanBySha(sha);
							if (sp2?.redactKinds) for (const [k, n] of Object.entries(sp2.redactKinds)) st.shapeStats.redactHits[k] = (st.shapeStats.redactHits[k] ?? 0) + n;
						}
					}
					if (changed && adjacencyValid(view)) {
						r.view = view;
						redactShipped = true;
					}
				} catch {
					/* substitution never breaks the call (AC-21) */
				}
			}
			// stamp sent-prefix AFTER the decision: what counts is PRIOR payloads (E6/M2);
			// everything in this input becomes sent history once the call goes out
			try {
				for (const sha of indexToolResults(messages).keys()) st.sentPrefix.add(sha);
				// GLM review F1: on overflow retain only shas LIVE in this input — a blind
				// clear() misclassified still-live sent content as unsent and re-stubbed it
				// mid-burst (invisible unbatched prefix-dirtying — what M5 exists to prevent)
				if (st.sentPrefix.size > st.config.keepSpans * 8) {
					st.sentPrefix = new Set(indexToolResults(messages).keys());
				}
			} catch {
				/* stamping is best-effort */
			}
			if (r.applied === 0 && !redactShipped) return undefined;
			st.shapeStats.applied += r.applied;
			return { messages: r.view };
		} catch (e) {
			if (process.env.CM_DEBUG) console.error("[context-manager] context handler:", e);
			return undefined; // fail-open (AC-34)
		}
	});

	pi.on("session_start", async (_e, ctx) => {
		refreshConfig(ctx);
		busParts.clear();
		lastHealthText = "";
		if (consolidateOn()) {
			if (ctx.hasUI) ctx.ui.setStatus(LEGACY_STATUS_KEY, undefined);
			// Render immediately (empty for now) so lastRenderCtx is set: bus parts
			// arriving from the hello handshake below must be visible BEFORE the
			// first turn_end, not after it.
			renderSuite(ctx);
			pi.events.emit(STATUS_CHANNEL, { type: "renderer-hello" });
		} else if (ctx.hasUI) {
			ctx.ui.setStatus(SUITE_KEY, undefined);
		}
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!st?.config.enabled) return;
		try {
		const args = (event as { args?: Record<string, unknown> }).args ?? {};
		const p = typeof args.path === "string" ? args.path : undefined;
		const text = textOf((event as { result?: unknown }).result);
		if (!text) return; // all tool results fingerprinted (error loops/dumps from any tool are poison candidates); path captured when present (spec §2.1/§2.2)
		const tok = Math.ceil(text.length / 4);
		const isError = Boolean((event as { isError?: boolean }).isError);
		// Phase 4 M8 (AC-9/AC-12): capture-time redaction — the REDACTED text is what the
		// span, its excerpt, side-car, and battery consumers see; contentHash stays computed
		// over the RAW transcript text so index/sentPrefix bookkeeping keeps ONE identity (AC-12).
		const red = redactText(text, st.config.poison.redactionPatterns);
		for (const [k, n] of Object.entries(red.kinds)) st.shapeStats.redactHits[k] = (st.shapeStats.redactHits[k] ?? 0) + n;
		const span: Span = {
			id: `${Date.now()}-${st.spans.length}`,
			path: p,
			contentHash: createHash("sha1").update(text).digest("hex"),
			tok,
			capturedAt: Date.now(),
			cls: classify(tok, isError, red.text, st.config),
			excerpt: red.text.slice(0, 400),
			isError,
			textRedacted: red.text.slice(0, 16384),
			restoreHash: createHash("sha1").update(red.text).digest("hex"),
			...(Object.keys(red.kinds).length > 0 ? { redactKinds: red.kinds } : {}),
		};
		if (st.hashCount.size > st.config.keepSpans * 2) {
			// prune the OLDEST half — a blind clear() loses live occurrence counts and a
			// 4× identical-error loop straddling the clear silently never reaches
			// errorLoopMin (GLM post-review, AC-13)
			const keptEntries = [...st.hashCount.entries()].slice(-(st.config.keepSpans >> 1));
			st.hashCount = new Map(keptEntries);
		}
		if (st.verdictMemo.size > st.config.keepSpans * 2) st.verdictMemo.clear();
		const seen = st.hashCount.get(span.contentHash) ?? 0;
		st.hashCount.set(span.contentHash, seen + 1);
		if (seen > 0 && span.cls === "fresh") span.cls = "dup";
		// M2: record toolName keyed by contentHash (spec-phase2 M2 eligibility)
		st.toolNames.set(span.contentHash, (event as { toolName?: string }).toolName ?? "unknown");
		// Phase 3: args signature for superseded-collapse grouping (equal args = newer supersedes)
		st.argsKeyBySha.set(span.contentHash, JSON.stringify(args ?? {}));
		if (st.toolNames.size > st.config.keepSpans * 2) st.toolNames.clear();
		st.spans.push(span);
		if (st.spans.length > st.config.keepSpans) st.spans.shift();
		// non-blocking (review MED): never stall the tool pipeline on Jev;
		// turn_end awaits pending scores so telemetry stays complete (B5 discipline)
		const pending = maybeScoreRelevance(span, ctx).finally(() => st!.pendingScores.delete(pending));
		st.pendingScores.add(pending);
		} catch (e) {
			if (process.env.CM_DEBUG) console.error("[context-manager] tool_execution_end:", e);
			// fail-open (AC-21): a capture failure never breaks the tool pipeline
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (!st?.config.enabled) return;
		const msg = (event as { message?: { role?: string; content?: unknown; usage?: unknown } }).message;
		if (!msg) return;
		if (msg.role === "user") {
			await handleUserTurn(textOf(msg.content), ctx);
		} else if (msg.role === "toolResult") {
			elideToolResult(msg, ctx);
		} else if (msg.role === "assistant") {
			const text = textOf(msg.content);
			if (text) {
				const tok = Math.ceil(text.length / 4);
				st.spans.push({
					id: `${Date.now()}-a${st.spans.length}`,
					contentHash: createHash("sha1").update(text).digest("hex"),
					tok,
					capturedAt: Date.now(),
					cls: classify(tok, false, text, st.config),
					excerpt: text.slice(0, 400),
					isError: false,
				});
				if (st.spans.length > st.config.keepSpans) st.spans.shift();
			}
			// cache miss attribution (spec §2.3): primary cache-stats, locked fallback usage-math
			const usage = msg.usage as { input?: number; cacheRead?: number; cacheWrite?: number } | undefined;
			if (usage) {
				const b6Suppress = st.b6SuppressNext;
				st.b6SuppressNext = false; // B6 flag consumed exactly once
				const cs = b6Suppress ? null : await loadCacheStats();
				if (b6Suppress) {
					// B6 (spec-phase2 M3): compaction disabled cache writes ⇒ the next
					// assistant miss is expected — suppress cache-loss attribution entirely.
				} else if (cs) {
					st.cacheSource = "cache-stats";
					try {
						const entries = ctx.sessionManager.getEntries();
						const miss = cs.detectCacheMiss(entries, msg, undefined) as
							| { missedTokens?: number; idleMs?: number; modelChanged?: boolean }
							| undefined;
						if (miss && typeof miss.missedTokens === "number") {
							st.missStats = {
								missedTokens: miss.missedTokens,
								cause: miss.idleMs != null && miss.idleMs > cs.CACHE_TTL_MS ? "ttl" : miss.modelChanged ? "model" : "prefix-break",
							};
						}
					} catch {
						st.cacheSource = "usage-fallback";
					}
				} else {
					st.cacheSource = "usage-fallback";
				}
				st.lastPromptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
				const denom = st.lastPromptTokens;
				st.lastChPct = denom > 0 && usage.cacheRead != null ? (usage.cacheRead / denom) * 100 : undefined;
				st.lastLLMAt = Date.now();
			}
		}
	});

	pi.on("turn_end", async (_e, ctx) => {
		if (!st?.config.enabled) return;
		const rt = st;
		await Promise.allSettled(rt.pendingScores);
		rt.turn += 1;
		// staleness probe (stat metadata only)
		if (rt.config.probeFreshness) {
			const probed = new WeakSet<object>();
			for (const s of rt.spans) {
				if (s.path && !s.isError && s.cls !== "dup" && !probed.has(s) && existsSync(s.path)) {
					probed.add(s);
					try {
						if (statSync(s.path).mtimeMs > s.capturedAt && s.cls === "fresh") s.cls = "stale";
					} catch {
						/* vanished file: leave class */
					}
				}
			}
		}
		// superseded-dump (spec §2.2): dump followed by a small conclusion → dump counts as superseded (dup-class)
		const turnSpans = rt.spans.slice(-20);
		const dumpIdx = turnSpans.map((s, i) => (s.tok >= rt.config.classification.dumpTokens ? i : -1)).filter((i) => i >= 0);
		const last = turnSpans[turnSpans.length - 1];
		if (dumpIdx.length > 0 && last && !last.isError && last.tok <= rt.config.classification.conclusionTokens) {
			for (const i of dumpIdx) if (turnSpans[i].cls === "unclassified") turnSpans[i].cls = "dup";
		}
		// shares (spec §3)
		const total = rt.spans.reduce((a, s) => a + s.tok, 0);
		const share = (cls: SpanClass) => (total > 0 ? rt.spans.filter((s) => s.cls === cls).reduce((a, s) => a + s.tok, 0) / total : 0);
		const unrelatedTok = rt.spans.filter((s) => s.verdict?.v === "unrelated").reduce((a, s) => a + s.tok, 0);
		// M2/M3 purity numerator (spec-phase2 M3): unrelated[verdict] + dup[cls] + stale[cls]
		const dupTok = rt.spans.filter((s) => s.cls === "dup").reduce((a, s) => a + s.tok, 0);
		const staleTok = rt.spans.filter((s) => s.cls === "stale").reduce((a, s) => a + s.tok, 0);
		rt.lastPurity = total > 0 ? (unrelatedTok + dupTok + staleTok) / total : 0;
		// Phase 4 M7: poison battery (AC-1) — inside turn_end, after pendingScores, BEFORE
		// burst teardown and the M5 flush evaluation below, so act ops ride the same flush.
		if (rt.config.shaping.enabled) {
			try {
				await poisonBattery(rt, ctx);
			} catch {
				/* fail-open (AC-21) */
			}
		}
		const telemetrySpans = rt.spans.slice(-50); // snapshot BEFORE the M3 decision — a compact clears the ledger, but the flush-turn record must show what triggered it
		// Phase 3 M5: dirty-prefix flush at the burst boundary — XOR with M3 (AC-29):
		// exactly one of {shaping flush, M3 compact} acts per turn.
		let shapeFlushed = false;
		if (rt.config.shaping.enabled) {
			const trig = shapeFlushTrigger(rt);
			if (trig) {
				flushDirty(rt, trig);
				shapeFlushed = true;
			}
		}
		const budget = rt.config.purityBudget.budget;
		let flush: "hard" | "soft-exec" | null = null;
		if (!shapeFlushed && rt.lastPurity >= budget) {
			if (rt.lastPurity >= budget * rt.config.purityBudget.hardMultiplier) {
				if (triggerCompact(ctx)) {
					flush = "hard";
					rt.flushQueued = false; // hard flush addresses the excess
				}
			} else if (rt.flushQueued) {
				// queued from previous turn: flush NOW iff purity still ≥ budget (AC-10)
				if (triggerCompact(ctx)) {
					flush = "soft-exec";
					rt.flushQueued = false;
				}
			} else {
				rt.flushQueued = true; // queue; NO compact this turn (AC-10)
			}
		} else {
			rt.flushQueued = false; // back under budget ⇒ clear pending queue
		}
		const anyVerdict = rt.spans.some((s) => s.verdict != null);
		const metrics = {
			freshShare: share("fresh"),
			staleShare: share("stale"),
			dupShare: share("dup"),
			errorShare: share("error"),
			unclassifiedShare: share("unclassified"),
			unrelatedShare: anyVerdict ? unrelatedTok / total : null,
			totalTokens: total,
		};
		const usage = ctx.getContextUsage();
		const chPct =
			usage?.tokens != null
				? undefined // CH% comes from assistant usage, captured at message_end (per-call)
				: undefined;
		void chPct;

		try {
			if (rt.config.statusLine.enabled && ctx.hasUI) {
			const f = Math.round(metrics.freshShare * 100);
			const s = Math.round(metrics.staleShare * 100);
			const d = Math.round(metrics.dupShare * 100);
			const e = Math.round(metrics.errorShare * 100);
			const ch = rt.lastChPct != null ? ` | CH:${Math.round(rt.lastChPct)}` : "";
			const pq = rt.flushQueued ? ` | p:${Math.round((rt.lastPurity ?? 0) * 100)}%⚠(queued)` : "";
			if (rt.config.statusLine.consolidate) {
				// Consolidated segment (../shared/status-line-protocol.md): condensed
				// shares — zero shares omitted — joined with any bus publishers.
				const shares = [`f${f}`];
				if (s > 0) shares.push(`s${s}`);
				if (d > 0) shares.push(`d${d}`);
				if (e > 0) shares.push(`e${e}`);
				const shapeTag = rt.config.shaping.enabled
					? rt.dirty.length > 0
						? ` dq${rt.dirty.length}`
						: rt.shapeStats.applied > 0
							? ` sh${rt.shapeStats.applied}`
							: ""
					: "";
				lastHealthText =
					shares.join(" ") +
					(rt.lastChPct != null ? ` CH${Math.round(rt.lastChPct)}` : "") +
					(rt.flushQueued ? ` p:${Math.round((rt.lastPurity ?? 0) * 100)}%\u26a0(queued)` : "") +
					shapeTag;
				renderSuite(ctx);
			} else {
				ctx.ui.setStatus(LEGACY_STATUS_KEY, `f:${f} s:${s} d:${d} e:${e}${ch}${pq}`);
			}
		}
		} catch {
			/* status rendering never breaks the turn (GLM review F2) */
		}
		// JSONL telemetry (AC-9)
		try {
			const out = join(ctx.cwd, rt.config.telemetryPath);
			mkdirSync(dirname(out), { recursive: true });
			appendFileSync(
				out,
				`${JSON.stringify({
					v: 1,
					ts: new Date().toISOString(),
					sessionId: ctx.sessionManager.getSessionId?.(),
					turn: rt.turn,
					metrics,
					cache: { source: rt.cacheSource, chPct: rt.lastChPct ?? null, missedTokens: rt.missStats.missedTokens, missedCost: 0, cause: rt.missStats.cause, modelChanged: null },
				taskSwitch: { driftSource: rt.lastDriftSource, staged: rt.stagedModel != null, pinnedTurn: rt.taskModel?.turn ?? null },
				elision: { ...rt.elisionStats },
				purity: rt.lastPurity,
				flush,
				shape: rt.config.shaping.enabled
					? {
						plans: rt.shapeStats.plans,
						applied: rt.shapeStats.applied,
						droppedAdjacency: rt.shapeStats.droppedAdjacency,
						flushed: rt.shapeStats.flushed,
						flushedTok: rt.shapeStats.flushedTok,
						bypassed: rt.shapeStats.bypassed,
						pruned: rt.shapeStats.pruned,
						dirtyDepth: rt.dirty.length,
						dirtyTok: rt.dirty.reduce((a, d) => a + d.tok, 0),
						viewTokens: rt.lastViewTokens,
						lastFlush: rt.lastFlush,
						poisonActed: rt.shapeStats.poisonActed,
						poisonReview: rt.shapeStats.poisonReview,
						poisonDegraded: rt.shapeStats.poisonDegraded,
						redactHits: rt.shapeStats.redactHits,
						errorLoopCollapsed: rt.shapeStats.errorLoopCollapsed,
						errorLoopKept: rt.shapeStats.errorLoopKept,
					}
					: undefined,
					poison: rt.lastPoison,
					spans: telemetrySpans.map((s) => ({ id: s.id, path: s.path, contentHash: s.contentHash, tok: s.tok, class: s.cls, verdict: s.verdict?.v ?? null, source: s.verdict?.source ?? null, rescoredAtTurn: s.rescoredAtTurn ?? null })),
				})}\n`,
			);
		} catch {
			/* telemetry never breaks the session */
		}
		rt.burst = null; // Phase 3 M1: burst closes at turn_end
	});

	pi.registerCommand("ctx:health", {
		description: "Context health report: status-segment legend, purity shares, staleness, cache miss attribution",
		handler: async (_args, ctx) => {
			if (!st) return;
			const total = st.spans.reduce((a, s) => a + s.tok, 0);
			const pct = (n: number) => `${Math.round((n / Math.max(total, 1)) * 100)}%`;
			const stale = st.spans.filter((s) => s.cls === "stale").slice(-5);
			const unrelated = st.spans.filter((s) => s.verdict?.v === "unrelated");
			ctx.ui.notify(
				[
					`status segment legend:`,
					`  f/s/d/e = fresh/stale/dup/error share of tracked tool output (zero shares hidden)`,
					`  CH<n> = cache health of last LLM call (prompt-cache hit %, per-call)`,
					`  p:<n>%⚠(queued) = purity budget exceeded, compaction flush queued`,
					`  sc … = smart-compaction mode/state (shared segment via status-line bus)`,
					``,
					`spans: ${st.spans.length} · ~${total} tok · cache attribution: ${st.cacheSource}`,
					`fresh ${pct(st.spans.filter((s) => s.cls === "fresh").reduce((a, s) => a + s.tok, 0))} · stale ${pct(st.spans.filter((s) => s.cls === "stale").reduce((a, s) => a + s.tok, 0))} · dup ${pct(st.spans.filter((s) => s.cls === "dup").reduce((a, s) => a + s.tok, 0))} · error ${pct(st.spans.filter((s) => s.cls === "error").reduce((a, s) => a + s.tok, 0))}`,
					`unrelated (Jev/heuristic verdicts): ${unrelated.length} spans · ~${unrelated.reduce((a, s) => a + s.tok, 0)} tok (eviction candidates, phase 3)`,
					`cache miss: ${st.missStats.missedTokens} tok (cause: ${st.missStats.cause ?? "none recorded"})`,
				...(st.config.shaping.enabled
					? [
						`shaping: burst ${st.burst ? `#${st.burst.id} call ${st.burst.callNo}` : "closed"} · baseline ${st.appliedShas.size} sha · dirty queue ${st.dirty.length} op/~${st.dirty.reduce((a, d) => a + d.tok, 0)} tok`,
						`  view ~${st.lastViewTokens} tok vs baseline ~${st.baselineViewTokens} tok · last flush: ${st.lastFlush ? `${st.lastFlush.trigger} @turn ${st.lastFlush.turn}` : "none"}`,
						`  evicted (stub + /ctx:restore <sha8>): ${unrelated.map((s) => s.contentHash.slice(0, 8)).join(", ") || "none"}`,
						`poison: acted ${st.shapeStats.poisonActed} · review ${st.shapeStats.poisonReview} · degraded ${st.shapeStats.poisonDegraded}${st.lastPoison ? ` (last turn: ${st.lastPoison.candidates} candidates, ${st.lastPoison.acted} acted, ${st.lastPoison.inputTokens} input tok)` : ""} · noulPolicy raw-probability`,
						`error-loop: collapsed ${st.shapeStats.errorLoopCollapsed} · kept ${st.shapeStats.errorLoopKept} · redaction hits: ${Object.entries(st.shapeStats.redactHits).map(([k, n]) => `${k}:${n}`).join(", ") || "none"}`,
					]
					: []),
					`stale paths: ${stale.map((s) => `${s.path} (read ${Math.round((Date.now() - s.capturedAt) / 60000)}min ago)`).join(", ") || "none"}`,
				].join("\n"),
				"info",
			);
		},
	});
}
