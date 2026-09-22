// smart-compaction — self-aware, cost-aware compaction timing for pi.
//
// Spec: .plans/COMPACT/spec.md@474c6e30 · Design: .plans/COMPACT/design.md@0787b4a8 (v2)
//
// Observation plane: turn_end / message_end / model_select / cache_warming_decision
// Action plane:      economy compaction ONLY at agent_settled + idle (A1);
//                    focus instructions ride only compactions WE initiate —
//                    pi-initiated ones are observed, never cancelled (A4).
//
// Commands: /compact:smart  /compact:why  /compact:config
// Status:   "sc <pct>% <mode>" — own setStatus segment when standalone, or
//           published on the status-line bus when a consolidator (context-manager)
//           is present. Protocol: ../shared/status-line-protocol.md

import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
	evaluateEconomy,
	evaluateWarnings,
	focusInstructions,
	initState,
	type Decision,
	type EngineState,
} from "./lib/engine.ts";
import { relevanceGate } from "./lib/gate.ts";
import {
	loadConfig,
	resolvePrices,
	resolveProfile,
	type Prices,
	type Profile,
	type SmartCompactionConfig,
} from "./lib/profiles.ts";
import { Telemetry } from "./lib/telemetry.ts";

const STATUS_KEY = "smart-compact";
const STATUS_CHANNEL = "pi-extensions:status-line";

interface SessionRuntime {
	config: SmartCompactionConfig;
	state: EngineState;
	telemetry: Telemetry;
	profile?: Profile;
	prices?: Prices;
	profileSource?: string;
	lastDecision?: { decision: Decision; at: number };
	compacting: boolean;
}

export default function (pi: ExtensionAPI) {
	let rt: SessionRuntime | undefined;
	// Status-line consolidation (../shared/status-line-protocol.md): set when a
	// renderer has announced itself on the bus; reset per session and
	// re-established by the hello handshake.
	let rendererSeen = false;
	let lastStatusCtx: ExtensionContext | undefined;

	pi.events.on(STATUS_CHANNEL, (data: unknown) => {
		const msg = data as { type?: string } | undefined;
		if (msg?.type !== "renderer-hello") return;
		rendererSeen = true;
		// Hand over the footer: clear our own segment, re-publish current status.
		// Done on EVERY hello (not just the first): the renderer may have
		// reloaded and wiped its part map — re-publishing is idempotent.
		if (lastStatusCtx?.hasUI) {
			lastStatusCtx.ui.setStatus(STATUS_KEY, undefined);
			statusLine(lastStatusCtx);
		}
	});

	function modelKey(ctx: ExtensionContext): { provider: string; id: string } | null {
		const m = ctx.model;
		if (!m) return null;
		return { provider: String(m.provider ?? ""), id: String(m.id ?? "") };
	}

	/** Re-resolve profile + prices from the LIVE model (AC-11). */
	function refreshModel(ctx: ExtensionContext): void {
		if (!rt) return;
		const key = modelKey(ctx);
		if (!key) return;
		const match = resolveProfile(key.provider, key.id, rt.config);
		rt.profile = match.profile;
		rt.profileSource = match.source;
		const catalog = ctx.model?.cost as Partial<Prices> | undefined;
		rt.prices = resolvePrices(catalog, match.profile, rt.config);
	}

	function statusLine(ctx: ExtensionContext, extra?: string): void {
		if (!ctx.hasUI || !rt) return;
		lastStatusCtx = ctx;
		const usage = ctx.getContextUsage();
		const pct = usage?.percent != null ? `${Math.round(usage.percent)}%` : "–";
		const mode = rt.profile?.mode ?? "?";
		const text = `sc ${pct} ${mode}${extra ? ` ${extra}` : ""}`;
		// Consolidated mode: a renderer (context-manager) owns the footer segment;
		// publish instead. `short` drops the pct — pi's built-in footer already
		// shows ctx usage, so the combined segment isn't redundant.
		if (rendererSeen) {
			pi.events.emit(STATUS_CHANNEL, {
				type: "status",
				source: STATUS_KEY,
				text,
				short: `sc ${mode}${extra ? ` ${extra}` : ""}`,
			});
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	/** Active task subjects from the system prompt's task block (bounded). */
	function taskSubjects(ctx: ExtensionContext): string[] {
		try {
			const prompt = ctx.getSystemPrompt();
			const subjects: string[] = [];
			const re = /^[^\w\n]*[A-Z][A-Z0-9]*-\d+\s+\[([^\]]+)\]\s+(.+)$/gm;
			let m: RegExpExecArray | null;
			while ((m = re.exec(prompt)) !== null) {
				const [, status, subject] = m;
				if (status !== "completed" && status !== "cancelled") subjects.push(subject.trim());
				if (subjects.length >= 8) break;
			}
			return subjects;
		} catch {
			return [];
		}
	}

	/** Bounded excerpt of the OLDEST half of the conversation (gate input). */
	function oldContextExcerpt(ctx: ExtensionContext): string {
		try {
			const entries = ctx.sessionManager.getEntries() as unknown as Array<Record<string, unknown>>;
			const texts: string[] = [];
			for (const e of entries) {
				if (e?.type !== "message") continue;
				const msg = e.message as { role?: string; content?: unknown } | undefined;
				if (!msg || msg.role === "toolResult") continue;
				const content = msg.content;
				if (typeof content === "string") texts.push(content);
				else if (Array.isArray(content)) {
					for (const c of content as Array<{ type?: string; text?: string }>) {
						if (c?.type === "text" && c.text) texts.push(c.text);
					}
				}
			}
			const half = texts.slice(0, Math.ceil(texts.length / 2)).join("\n");
			return half.slice(0, 4000);
		} catch {
			return "";
		}
	}

	function evalInput(ctx: ExtensionContext) {
		if (!rt?.profile || !rt.prices) return undefined;
		return {
			profile: rt.profile,
			prices: rt.prices,
			config: {
				reserveTokens: rt.config.reserveTokens,
				continuationProbability: rt.config.continuationProbability,
				tierSafety: rt.config.tierSafety,
			},
			state: rt.state,
			usage: ctx.getContextUsage(),
			now: Date.now(),
		};
	}

	function record(ctx: ExtensionContext, event: string, decision: Decision, gate?: { probability: number; source: string; action: string }, estimates?: Record<string, number | string | boolean | null>): void {
		if (!rt) return;
		rt.lastDecision = { decision, at: Date.now() };
		const key = modelKey(ctx);
		rt.telemetry.log({
			ts: new Date().toISOString(),
			event,
			modelKey: key ? `${key.provider}/${key.id}` : undefined,
			profileSource: rt.profileSource,
			mode: rt.profile?.mode,
			decision: decision.kind,
			why: decision.kind === "none" ? decision.why : undefined,
			...(decision.kind === "economy"
				? {
						estimates: estimates ?? {
							savings: decision.savings,
							cost: decision.cost,
							cacheHot: decision.cacheHot,
							continuationProbability: decision.continuationProbability,
							horizonTurns: decision.horizonTurns,
						},
					}
				: {}),
			...(gate ? { gate } : {}),
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		rt = {
			config: loadConfig(ctx.cwd),
			state: initState(),
			telemetry: new Telemetry(ctx.sessionManager.getSessionId?.()),
			compacting: false,
		};
		rendererSeen = false;
		refreshModel(ctx);
		statusLine(ctx);
		// Re-handshake every session (covers renderer reloading between sessions).
		pi.events.emit(STATUS_CHANNEL, { type: "publisher-hello", source: STATUS_KEY });
	});

	pi.on("model_select", async (_event, ctx) => {
		if (!rt) return;
		// AC-11: new model → new cache (cold), token counts from the old
		// tokenizer are stale until the next assistant usage.
		rt.state.cacheModelKey = null;
		rt.state.lastLLMCallAt = null;
		rt.state.tokensStale = true;
		rt.state.growthPerTurn = null;
		rt.state.lastTurnTokens = null;
		refreshModel(ctx);
		statusLine(ctx, "rebaselining");
	});

	pi.on("message_end", async (event, ctx) => {
		if (!rt) return;
		const msg = event.message as { role?: string; usage?: unknown };
		if (msg?.role !== "assistant") return;
		if (msg.usage) {
			const key = modelKey(ctx);
			rt.state.lastLLMCallAt = Date.now();
			rt.state.cacheModelKey = key ? `${key.provider}/${key.id}` : null;
			rt.state.tokensStale = false;
		}
	});

	pi.on("cache_warming_decision", async (event) => {
		if (!rt) return;
		rt.state.recentWarm = {
			at: Date.now(),
			continuationProbability: event.continuationProbability,
		};
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!rt) return;
		rt.state.turnCounter += 1;
		rt.state.turnsSinceCompaction += 1;
		const usage = ctx.getContextUsage();
		if (usage?.tokens != null) {
			const delta = rt.state.lastTurnTokens != null ? usage.tokens - rt.state.lastTurnTokens : null;
			if (delta != null) {
				rt.state.growthPerTurn =
					rt.state.growthPerTurn == null ? delta : rt.state.growthPerTurn * 0.7 + delta * 0.3;
			}
			rt.state.lastTurnTokens = usage.tokens;
		}
		const input = evalInput(ctx);
		if (!input) return;
		const d = evaluateWarnings(input);
		record(ctx, "turn_end", d);
		if (d.kind === "warn-tier") statusLine(ctx, `tier@${Math.round(d.boundary / 1000)}k soon`);
		else if (d.kind === "warn-overflow") statusLine(ctx, "overflow imminent");
		else statusLine(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!rt || !rt.config.enabled || rt.compacting) return;
		// AC-3: settled + idle + no pending messages.
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
		const input = evalInput(ctx);
		if (!input) return;
		const d = evaluateEconomy(input);
		record(ctx, "agent_settled", d);
		if (d.kind !== "economy" && d.kind !== "quality") {
			statusLine(ctx);
			return;
		}

		try {
			const subjects = taskSubjects(ctx);
			const gate = await relevanceGate(subjects, oldContextExcerpt(ctx), rt.profile!.gate, ctx.signal);
			record(ctx, "gate", d, gate);

			if (gate.action === "defer") {
				statusLine(ctx, "deferred (task-relevant)");
				return;
			}
			const instructions = focusInstructions(gate.action === "aggressive" ? "aggressive" : "focused", subjects);
			statusLine(ctx, "compacting");
			// Guard flag set only at the point of no return: a defer or gate error
			// above must leave the trigger live (review blocker fix).
			rt.compacting = true;
			ctx.compact({
				customInstructions: instructions,
				onComplete: (result) => {
					rt!.compacting = false;
					rt!.state.turnsSinceCompaction = 0; // AC-8: our own compaction resets counters
					rt!.telemetry.log({
						ts: new Date().toISOString(),
						event: "compact_complete",
						decision: "compacted",
						estimates: { tokensBefore: result.tokensBefore },
					});
				},
				onError: () => {
					rt!.compacting = false;
				},
			});
		} catch {
			rt.compacting = false;
		}
	});

	pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx) => {
		if (!rt) return;
		// Observation only in v1: pi-initiated compactions pass through untouched
		// (never cancel — design A4). Telemetry pairs with outcomes via
		// session_compact / session_compact_failed.
		record(ctx, `session_before_compact:${event.reason}`, { kind: "none", why: "observed" });
	});

	pi.on("session_compact", async (_event, ctx) => {
		if (!rt) return;
		// AC-8: reset interval counters regardless of who compacted.
		rt.state.turnsSinceCompaction = 0;
		rt.state.lastTurnTokens = null; // token basis changed
		rt.compacting = false;
		record(ctx, "session_compact", { kind: "none", why: "compacted" });
		statusLine(ctx);
	});

	pi.on("session_compact_failed", async (event, ctx) => {
		if (!rt) return;
		rt.compacting = false;
		// Failed compaction did not shrink context; allow prompt retry (design A5:
		// counters reset on compact/_failed regardless of origin).
		rt.state.turnsSinceCompaction = 0;
		record(ctx, "session_compact_failed", {
			kind: "none",
			why: event.aborted ? "aborted" : (event.errorMessage ?? "failed"),
		});
	});

	// ----- commands -----

	pi.registerCommand("compact:smart", {
		description: "Force a smart-compaction evaluation now (bypasses min-interval, not guards)",
		handler: async (_args, ctx) => {
			if (!rt?.profile || !rt.prices) return;
			const input = evalInput(ctx);
			if (!input) return;
			// user explicitly asked: bypass min-interval only
			const forced = { ...input, state: { ...input.state, turnsSinceCompaction: Number.MAX_SAFE_INTEGER } };
			const d = evaluateEconomy(forced);
			record(ctx, "compact:smart", d);
			if (d.kind === "economy" || d.kind === "quality") {
				const subjects = taskSubjects(ctx);
				const gate = await relevanceGate(subjects, oldContextExcerpt(ctx), rt.profile.gate, ctx.signal);
				if (gate.action === "defer") {
					ctx.ui.notify(`smart-compaction: deferred — context is task-relevant (p=${gate.probability.toFixed(2)}, ${gate.source})`, "info");
					return;
				}
				ctx.compact({ customInstructions: focusInstructions(gate.action === "aggressive" ? "aggressive" : "focused", subjects) });
				ctx.ui.notify(`smart-compaction: compacting (${gate.action}, p=${gate.probability.toFixed(2)}, ${gate.source})`, "info");
			} else {
				ctx.ui.notify(`smart-compaction: no compaction — ${(d as { why?: string }).why ?? d.kind}`, "info");
			}
		},
	});

	pi.registerCommand("compact:why", {
		description: "Explain the last smart-compaction decision and active profile",
		handler: async (_args, ctx) => {
			if (!rt) return;
			const key = modelKey(ctx);
			const lines = [
				`model: ${key ? `${key.provider}/${key.id}` : "unknown"} (profile: ${rt.profileSource})`,
				`mode: ${rt.profile?.mode} · tiers: ${JSON.stringify(rt.profile?.tiers ?? [])}`,
				`prices: ${JSON.stringify(rt.prices)}`,
				`cache: ${JSON.stringify(rt.profile?.cache)} · lastLLMCall: ${rt.state.lastLLMCallAt ? `${Math.round((Date.now() - rt.state.lastLLMCallAt) / 1000)}s ago` : "never"}`,
				`growth/turn: ${rt.state.growthPerTurn?.toFixed(0) ?? "?"} tok · turnsSinceCompaction: ${rt.state.turnsSinceCompaction}`,
				`last decision: ${rt.lastDecision ? `${rt.lastDecision.decision.kind} (${JSON.stringify(rt.lastDecision.decision.kind === "none" ? rt.lastDecision.decision.why : rt.lastDecision.decision)})` : "none yet"}`,
				`telemetry: ${rt.telemetry.filePath}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("compact:config", {
		description: "Show resolved smart-compaction config and a suggested pi modelOverrides block",
		handler: async (_args, ctx) => {
			if (!rt) return;
			const suggested =
				rt.profile?.tiers[0] && Number.isFinite(rt.profile.tiers[0].upTo)
					? Math.min(rt.profile.tiers[0].upTo, (ctx.getContextUsage()?.contextWindow ?? rt.profile.tiers[0].upTo)) - rt.config.reserveTokens
					: undefined;
			const suggestion = suggested
				? JSON.stringify(
						{
							compaction: {
								reserveTokens: (ctx.getContextUsage()?.contextWindow ?? 0) - suggested > 0 ? (ctx.getContextUsage()?.contextWindow ?? 0) - suggested : rt.config.reserveTokens,
							},
						},
						null,
						2,
					)
				: "(no tier configured — pi default reserve applies)";
			ctx.ui.notify(
				`config: ${JSON.stringify(rt.config)}\n\nsuggested settings.json (apply manually; extensions cannot mutate settings):\n${suggestion}`,
				"info",
			);
		},
	});
}
