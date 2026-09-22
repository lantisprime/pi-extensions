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
};

type SpanClass = "fresh" | "stale" | "dup" | "error" | "unclassified";
type Verdict = "duplicate" | "relevant" | "unrelated";
type DriftSource = "task-diff" | "jev" | "heuristic-degraded";

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
}

function loadConfig(cwd: string): CMConfig {
	const base: CMConfig = {
		...DEFAULTS,
		classification: { ...DEFAULTS.classification },
		statusLine: { ...DEFAULTS.statusLine },
		taskSwitch: { ...DEFAULTS.taskSwitch },
		elision: { ...DEFAULTS.elision, readToolNames: [...DEFAULTS.elision.readToolNames] },
		purityBudget: { ...DEFAULTS.purityBudget },
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
		};
	} catch {
		return base;
	}
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
					existingInventory: existing.slice(-30).map((s) => ({ path: s.path, tok: s.tok, class: s.cls, excerpt: s.excerpt.slice(0, 120) })),
					candidate: { path: candidate.path, excerpt: candidate.excerpt.slice(0, 2000) },
				},
				questions: {
					new_info: { type: "noul", instructions: "noul: the candidate artifact contains substantive information NOT already covered by the existing inventory." },
					on_task: { type: "noul", instructions: "noul: the candidate artifact is relevant to the listed current tasks." },
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
		if (!st || !st.config.taskSwitch.enabled) return;
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
						spans: batch.map((s, i) => ({ i, path: s.path ?? null, tok: s.tok, class: s.cls, excerpt: s.excerpt.slice(0, 120) })),
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
		const args = (event as { args?: Record<string, unknown> }).args ?? {};
		const p = typeof args.path === "string" ? args.path : undefined;
		const text = textOf((event as { result?: unknown }).result);
		if (!text) return; // all tool results fingerprinted (error loops/dumps from any tool are poison candidates); path captured when present (spec §2.1/§2.2)
		const tok = Math.ceil(text.length / 4);
		const isError = Boolean((event as { isError?: boolean }).isError);
		const span: Span = {
			id: `${Date.now()}-${st.spans.length}`,
			path: p,
			contentHash: createHash("sha1").update(text).digest("hex"),
			tok,
			capturedAt: Date.now(),
			cls: classify(tok, isError, text, st.config),
			excerpt: text.slice(0, 400),
			isError,
		};
		if (st.hashCount.size > st.config.keepSpans * 2) st.hashCount.clear();
		if (st.verdictMemo.size > st.config.keepSpans * 2) st.verdictMemo.clear();
		const seen = st.hashCount.get(span.contentHash) ?? 0;
		st.hashCount.set(span.contentHash, seen + 1);
		if (seen > 0 && span.cls === "fresh") span.cls = "dup";
		// M2: record toolName keyed by contentHash (spec-phase2 M2 eligibility)
		st.toolNames.set(span.contentHash, (event as { toolName?: string }).toolName ?? "unknown");
		if (st.toolNames.size > st.config.keepSpans * 2) st.toolNames.clear();
		st.spans.push(span);
		if (st.spans.length > st.config.keepSpans) st.spans.shift();
		// non-blocking (review MED): never stall the tool pipeline on Jev;
		// turn_end awaits pending scores so telemetry stays complete (B5 discipline)
		const pending = maybeScoreRelevance(span, ctx).finally(() => st!.pendingScores.delete(pending));
		st.pendingScores.add(pending);
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
		const telemetrySpans = rt.spans.slice(-50); // snapshot BEFORE the M3 decision — a compact clears the ledger, but the flush-turn record must show what triggered it
		// M3: purity budget — soft queue / hard flush (spec-phase2 M3, B4)
		const budget = rt.config.purityBudget.budget;
		let flush: "hard" | "soft-exec" | null = null;
		if (rt.lastPurity >= budget) {
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
				lastHealthText =
					shares.join(" ") +
					(rt.lastChPct != null ? ` CH${Math.round(rt.lastChPct)}` : "") +
					(rt.flushQueued ? ` p:${Math.round((rt.lastPurity ?? 0) * 100)}%⚠(queued)` : "");
				renderSuite(ctx);
			} else {
				ctx.ui.setStatus(LEGACY_STATUS_KEY, `f:${f} s:${s} d:${d} e:${e}${ch}${pq}`);
			}
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
					spans: telemetrySpans.map((s) => ({ id: s.id, path: s.path, contentHash: s.contentHash, tok: s.tok, class: s.cls, verdict: s.verdict?.v ?? null, source: s.verdict?.source ?? null, rescoredAtTurn: s.rescoredAtTurn ?? null })),
				})}\n`,
			);
		} catch {
			/* telemetry never breaks the session */
		}
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
					`stale paths: ${stale.map((s) => `${s.path} (read ${Math.round((Date.now() - s.capturedAt) / 60000)}min ago)`).join(", ") || "none"}`,
				].join("\n"),
				"info",
			);
		},
	});
}
