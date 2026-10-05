// context-manager/test/wiring-phase2-m3.test.ts — M3 wire tests, AMENDED 2026-10-04.
// M3 is now the compact-REQUEST protocol (../../shared/compact-request-protocol.md):
// CM emits compact-request on the pi.events bus and NEVER calls ctx.compact() —
// the executor (smart-compaction) fires; the session_compact event (any origin)
// resets ledger/shaping ground and anchors the cooldown. AC-9 purity math and
// AC-10 soft-queue semantics are unchanged; AC-11 hard excess requests same turn.
// Incident regression (2026-10-04): sub-floor reclaimable (~870 dup tok, 86:1
// cost against) must never even request — that mass belongs to view shaping.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.JEV_ENDPOINT = "http://mock.jev.test/systemone";
process.env.JEV_API_KEY = "test-key";

const { default: createExtension } = await import("../index.ts");

const COMPACT_CHANNEL = "pi-extensions:compact-request";

type Handler = (event: any, ctx: any) => Promise<any>;
function mockPi() {
	const handlers = new Map<string, Handler[]>();
	const busHandlers = new Map<string, Handler[]>();
	const emissions: Array<{ channel: string; data: any }> = [];
	return {
		pi: {
			on: (e: string, h: Handler) => {
				const l = handlers.get(e) ?? [];
				l.push(h);
				handlers.set(e, l);
				return () => {};
			},
			registerCommand: (_n: string, _o: any) => {},
			events: {
				emit: (ch: string, data: any) => {
					emissions.push({ channel: ch, data });
				},
				on: (ch: string, h: Handler) => {
					const l = busHandlers.get(ch) ?? [];
					l.push(h);
					busHandlers.set(ch, l);
					return () => {};
				},
			},
		} as any,
		handlers,
		busHandlers,
		emissions,
	};
}
function mockCtx(opts: { cwd: string; tokens?: number }) {
	const statusSets: string[] = [];
	const compactCalls: Array<{ customInstructions?: string } | undefined> = [];
	const ctx = {
		cwd: opts.cwd,
		hasUI: true,
		model: { provider: "litellm", id: "minimax" },
		ui: { setStatus: (_k: string, v?: string) => statusSets.push(v ?? ""), notify: () => {} },
		sessionManager: { getSessionId: () => "ctx-m3-test", getEntries: () => [] },
		getContextUsage: () => ({ tokens: opts.tokens ?? 10_000, contextWindow: 1_048_576, percent: 1 }),
		isIdle: () => true,
		hasPendingMessages: () => false,
		getSystemPrompt: () => "◐ TEST-1 [in_progress] alpha subject one",
		signal: undefined,
		compact: (o: { customInstructions: string }) => {
			compactCalls.push(o);
		},
	};
	return { ctx, statusSets, compactCalls };
}
async function drive(h: Map<string, Handler[]>, e: string, ev: any, ctx: any) {
	for (const handler of h.get(e) ?? []) await handler(ev, ctx);
}
async function runTools(h: Map<string, Handler[]>, ctx: any, items: Array<{ text: string; toolName?: string }>) {
	for (const it of items) {
		await drive(h, "tool_execution_end", { toolName: it.toolName ?? "bash", args: {}, result: it.text }, ctx);
	}
}
async function assistantMsg(h: Map<string, Handler[]>, ctx: any, text: string) {
	return drive(h, "message_end", { message: { role: "assistant", content: text, usage: { input: 100, cacheRead: 0, cacheWrite: 900 } } }, ctx);
}
function jsonl(cwd: string): any[] {
	const f = path.join(cwd, ".pi", "context-telemetry.jsonl");
	if (!fs.existsSync(f)) return [];
	return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function mockFetch(respond: (body: any) => any) {
	const orig = globalThis.fetch;
	globalThis.fetch = (async (_url: any, init?: any) => {
		const body = JSON.parse(init?.body ?? "{}");
		return { ok: true, json: async () => respond(body) } as any;
	}) as any;
	return { restore: () => (globalThis.fetch = orig) };
}
function ingestAware() {
	return mockFetch((body) => {
		if (body?.questions?.new_info != null) {
			const ex = String(body.state?.candidate?.excerpt ?? "");
			return ex.includes("FILLER")
				? { answers: { new_info: { noul: 0.9 }, on_task: { noul: 0.9 } } }
				: { answers: { new_info: { noul: 0.9 }, on_task: { noul: 0.05 } } };
		}
		return { answers: { drift: { noul: 0.0 } } };
	});
}
/** Compact-requests emitted on the bus (CM's only compaction output now). */
const requests = (emissions: Array<{ channel: string; data: any }>) =>
	emissions.filter((e) => e.channel === COMPACT_CHANNEL && e.data?.type === "compact-request").map((e) => e.data);
function cfgFile(dir: string, obj: unknown) {
	fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".pi", "context-manager.json"), JSON.stringify(obj));
}
/** Simulates the executor accepting a request: compaction lifecycle events. */
async function executorFires(h: Map<string, Handler[]>, ctx: any) {
	await drive(h, "session_before_compact", {}, ctx);
	await drive(h, "session_compact", {}, ctx);
}

const A_TXT = "ALPHA ".repeat(1400); // 2100 tok — unrelated verdict, dump-class
const FILLER_SOFT = "FILLER ".repeat(4300); // 7525 tok, relevant — p ≈ 0.278 (soft)
const FILLER_HARD = "FILLER ".repeat(1144); // 2002 tok, relevant — p ≈ 0.51 (hard)
const FILLER_HUGE = "FILLER ".repeat(6860); // 12005 tok, relevant — dilutes p below budget
const B_TXT = "BETA ".repeat(648); // 810 tok — dup via supersession, unscored
const smalls = (n: number) => Array.from({ length: n }, () => ({ text: "ok" }));
async function seedSoft(h: Map<string, Handler[]>, ctx: any) {
	// p = (2100 unrelated + 810 dup) / 10466 ≈ 0.278 ⇒ soft tier (queue)
	await runTools(h, ctx, [{ text: A_TXT }, { text: FILLER_SOFT }, ...smalls(25), { text: B_TXT }, ...smalls(5), { text: "done" }]);
	await drive(h, "turn_end", {}, ctx);
}
async function seedHard(h: Map<string, Handler[]>, ctx: any) {
	// p = 2100 / (2002 + 22 + 2100) ≈ 0.51 ≥ 2×0.15 ⇒ hard tier
	await runTools(h, ctx, [{ text: FILLER_HARD }, ...smalls(22), { text: A_TXT }]);
	await drive(h, "turn_end", {}, ctx);
}
async function reseedHard(h: Map<string, Handler[]>, ctx: any) {
	await runTools(h, ctx, [{ text: FILLER_HARD }, ...smalls(22), { text: A_TXT }]);
}

test("M3 AC-10a: soft excess queues ⚠(queued), NO request that turn", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m3-"));
	const { pi, handlers, emissions } = mockPi();
	createExtension(pi);
	const { ctx, statusSets, compactCalls } = mockCtx({ cwd: dir });
	const { restore } = ingestAware();
	try {
		await drive(handlers, "session_start", {}, ctx);
		await seedSoft(handlers, ctx);
		assert.equal(requests(emissions).length, 0, "no compact-request on the queueing turn");
		assert.equal(compactCalls.length, 0, "CM never calls ctx.compact");
		assert.ok(statusSets.some((s) => s.includes("⚠(queued)")), "status shows ⚠(queued)");
		assert.equal(jsonl(dir)[0].flush, null, "no flush telemetry on queue turn");
	} finally {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("M3 AC-10b: queued request emitted exactly once next turn iff purity still ≥ budget", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m3-"));
	cfgFile(dir, { compactRequest: { minReclaimableTokens: 1000 } });
	const { pi, handlers, emissions } = mockPi();
	createExtension(pi);
	const { ctx, compactCalls } = mockCtx({ cwd: dir });
	const { restore } = ingestAware();
	try {
		await drive(handlers, "session_start", {}, ctx);
		await seedSoft(handlers, ctx); // turn 1: queued
		await drive(handlers, "turn_end", {}, ctx); // turn 2: purity still ≥ budget ⇒ soft request
		const reqs = requests(emissions);
		assert.equal(reqs.length, 1, "exactly one compact-request on the flush turn");
		assert.equal(reqs[0].kind, "content");
		assert.equal(reqs[0].suggestedInstructions, "drop unrelated/dup/stale content", "B4 instructions ride as suggestedInstructions");
		assert.equal(reqs[0].reclaimableTokens, 2939, "reclaimable = unrelated(2100) + dup(810) + flipped smalls(29)");
		assert.equal(reqs[0].breakdown.totalTokens > reqs[0].reclaimableTokens, true, "breakdown carries the ledger total");
		assert.equal(compactCalls.length, 0, "CM never calls ctx.compact");
		assert.equal(jsonl(dir)[1].flush, "req-content");
		await drive(handlers, "turn_end", {}, ctx); // turn 3: retryTurns spaces re-requests
		assert.equal(requests(emissions).length, 1, "retryTurns suppresses an immediate re-request");
		assert.equal(jsonl(dir)[2].flush, null);
	} finally {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("M3 AC-10c: queued request clears without emission when purity drops back under budget", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m3-"));
	cfgFile(dir, { purityBudget: { budget: 0.25, hardMultiplier: 2, compactCooldownMin: 10 }, compactRequest: { minReclaimableTokens: 1000 } });
	const { pi, handlers, emissions } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	const { restore } = ingestAware();
	try {
		await drive(handlers, "session_start", {}, ctx);
		await seedSoft(handlers, ctx); // p ≈ 0.278 ≥ 0.25 ⇒ queued
		assert.ok(jsonl(dir)[0].purity >= 0.25);
		await runTools(handlers, ctx, [{ text: FILLER_HUGE }]); // dilute: p = 2910/22471 ≈ 0.13 < 0.25
		await drive(handlers, "turn_end", {}, ctx);
		assert.equal(requests(emissions).length, 0, "dropped purity clears the queue silently");
		assert.equal(jsonl(dir)[1].flush, null);
		await drive(handlers, "turn_end", {}, ctx); // turn 3: no deferred request
		assert.equal(requests(emissions).length, 0, "no request after queue cleared");
	} finally {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("M3 AC-11+B6: hard request same turn; session_compact anchors cooldown + B6; retry blocked", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m3-"));
	cfgFile(dir, { compactRequest: { minReclaimableTokens: 1000 } });
	const { pi, handlers, emissions } = mockPi();
	createExtension(pi);
	const { ctx, compactCalls } = mockCtx({ cwd: dir });
	const { restore } = ingestAware();
	try {
		await drive(handlers, "session_start", {}, ctx);
		await seedHard(handlers, ctx); // turn 1: hard tier ⇒ request, same turn
		assert.equal(requests(emissions).length, 1, "hard excess requests same turn");
		assert.equal(compactCalls.length, 0, "CM never calls ctx.compact");
		assert.equal(jsonl(dir)[0].flush, "req-content");
		// Executor accepts: lifecycle events anchor cooldown + B6 + ledger reset
		await executorFires(handlers, ctx);
		// B6: first assistant message after the compact — attribution suppressed
		await assistantMsg(handlers, ctx, "post-compact reply");
		await reseedHard(handlers, ctx);
		await drive(handlers, "turn_end", {}, ctx); // turn 2: purity hard again, cooldown suppresses
		assert.equal(requests(emissions).length, 1, "cooldown (anchored to session_compact) suppresses repeat request");
		assert.equal(jsonl(dir)[1].flush, null);
		assert.equal(jsonl(dir)[1].cache.source, "unresolved", "B6: attribution skipped after compact");
		// second assistant message: B6 flag consumed ⇒ attribution runs
		await assistantMsg(handlers, ctx, "second reply");
		await drive(handlers, "turn_end", {}, ctx);
		assert.notEqual(jsonl(dir)[2].cache.source, "unresolved", "attribution resumes after B6 consumed");
	} finally {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("M3 GLM#1 (CTX2-3): partial config override deep-merges — siblings keep defaults (NaN gate fix)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m3-"));
	cfgFile(dir, {
		purityBudget: { budget: 0.25 },
		compactRequest: { minReclaimableTokens: 1000 },
		elision: { enabled: true, sideCarPath: ".pi/context-elisions.jsonl" },
	});
	const { pi, handlers, emissions } = mockPi();
	createExtension(pi);
	const { ctx, compactCalls } = mockCtx({ cwd: dir });
	const { restore } = ingestAware();
	const READ_TXT = "READ ".repeat(700); // 875 tok dump-class read result
	try {
		await drive(handlers, "session_start", {}, ctx);
		await seedHard(handlers, ctx); // p ≈ 0.51 ≥ 0.25×2 (default hardMultiplier) ⇒ hard request
		assert.equal(requests(emissions).length, 1, "hard request fires with default hardMultiplier (NaN gate fixed)");
		assert.equal(jsonl(dir)[0].flush, "req-content");
		await executorFires(handlers, ctx);
		// rebuild pressure — request blocked by cooldown ⇒ ledger intact, elision armed
		await runTools(handlers, ctx, [
			{ text: FILLER_HARD },
			...smalls(22),
			{ text: A_TXT },
			{ text: READ_TXT, toolName: "read" },
		]);
		await drive(handlers, "turn_end", {}, ctx);
		assert.equal(jsonl(dir)[1].flush, null, "cooldown blocks repeat request");
		assert.equal(requests(emissions).length, 1);
		// partial elision override {enabled, sideCarPath} must keep default readToolNames ["read"]
		const readMsg = { role: "toolResult", content: READ_TXT };
		await drive(handlers, "message_end", { message: readMsg }, ctx);
		assert.equal(readMsg.content, READ_TXT, "partial elision override keeps default readToolNames ⇒ read intact");
		const aMsg = { role: "toolResult", content: A_TXT };
		await drive(handlers, "message_end", { message: aMsg }, ctx);
		assert.match(
			String(aMsg.content),
			/\[elided 2100 tok dump: sha=[0-9a-f]{40}; archived: \.pi\/context-elisions\.jsonl#0\]/,
			"elision armed and sideCarPath default honored under partial config",
		);
	} finally {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("M3 GLM#2 (CTX2-3): session_compact resets span ledger — purity reflects post-compact context", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m3-"));
	cfgFile(dir, { compactRequest: { minReclaimableTokens: 1000 } });
	const { pi, handlers, emissions } = mockPi();
	createExtension(pi);
	const { ctx, compactCalls } = mockCtx({ cwd: dir });
	const { restore } = ingestAware();
	try {
		await drive(handlers, "session_start", {}, ctx);
		await seedHard(handlers, ctx); // turn 1: hard request
		assert.ok(jsonl(dir)[0].spans.length > 0, "flush-turn telemetry shows the spans that triggered it");
		await executorFires(handlers, ctx); // executor fires — ANY-origin compaction resets ground
		await runTools(handlers, ctx, [{ text: "fresh" }]);
		await drive(handlers, "turn_end", {}, ctx); // turn 2: ledger was reset ⇒ purity 0
		assert.equal(jsonl(dir)[1].purity, 0, "no stale purity carry-over after compact");
		assert.equal(jsonl(dir)[1].spans.length, 1, "ledger holds only post-compact spans");
		assert.equal(requests(emissions).length, 1);
		await drive(handlers, "turn_end", {}, ctx); // turn 3: no cooldown-gated re-request loop
		assert.equal(requests(emissions).length, 1, "no re-request after ledger reset");
		assert.equal(compactCalls.length, 0);
	} finally {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("M3 AC-9: telemetry purity matches harness share exactly", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m3-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	const { restore } = ingestAware();
	try {
		await drive(handlers, "session_start", {}, ctx);
		await seedSoft(handlers, ctx);
		const line = jsonl(dir)[0];
		const num = line.spans.reduce(
			(a: number, s: any) => a + (s.verdict === "unrelated" || s.class === "dup" || s.class === "stale" ? s.tok : 0),
			0,
		);
		const tot = line.spans.reduce((a: number, s: any) => a + s.tok, 0);
		assert.equal(num, 2939, "unrelated(2100) + dup-superseded(810) + 29 repeated-ok smalls flipped dup(29)");
		assert.equal(line.metrics.totalTokens, tot, "total matches span sum");
		assert.ok(Math.abs(line.purity - num / tot) < 1e-9, "purity field == harness share");
	} finally {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("M3 incident 2026-10-04 regression: sub-floor reclaimable NEVER requests (defaults)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m3-"));
	// NO config file: defaults — minReclaimableTokens 8000. The live incident:
	// purity 0.2528 over a 3.4k-token ledger ⇒ ~870 dup tokens requested a
	// compact that cost ~75k (86:1 against) into a 96.9%-hot cache.
	const { pi, handlers, emissions } = mockPi();
	createExtension(pi);
	const { ctx, compactCalls } = mockCtx({ cwd: dir });
	const { restore } = ingestAware();
	try {
		await drive(handlers, "session_start", {}, ctx);
		await seedSoft(handlers, ctx); // soft tier: queue (reclaimable 2939 < 8000)
		await drive(handlers, "turn_end", {}, ctx); // turn 2: queued path attempts — blocked by reclaimable floor
		assert.equal(requests(emissions).length, 0, "870-token-class mass is a SHAPING job, not a compaction job");
		assert.equal(compactCalls.length, 0, "CM never calls ctx.compact");
		assert.equal(jsonl(dir)[1].flush, null, "no req-content telemetry");
		await drive(handlers, "turn_end", {}, ctx);
		assert.equal(requests(emissions).length, 0, "stays silent on retry too");
	} finally {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("M3 pressure watch (Option A): window pressure requests with kind=pressure; decision-ack lands in telemetry", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m3-"));
	const { pi, handlers, busHandlers, emissions } = mockPi();
	createExtension(pi);
	const { ctx, compactCalls } = mockCtx({ cwd: dir, tokens: 600_000 }); // 57% of the 1M window ≥ 0.5
	const { restore } = ingestAware();
	try {
		await drive(handlers, "session_start", {}, ctx);
		await runTools(handlers, ctx, smalls(3)); // clean ledger: purity 0 — invisible to content tiers
		await drive(handlers, "turn_end", {}, ctx);
		const reqs = requests(emissions);
		assert.equal(reqs.length, 1, "big-and-clean contexts request via the pressure path");
		assert.equal(reqs[0].kind, "pressure", "kind distinguishes window pressure from content impurity");
		assert.equal(jsonl(dir)[0].flush, "req-pressure");
		assert.equal(compactCalls.length, 0, "CM never calls ctx.compact");
		// executor replies on the bus — CM records the decision for telemetry
		const decision = { type: "compact-decision", decision: "declined", why: "reclaimable-below-cost" };
		for (const h of busHandlers.get(COMPACT_CHANNEL) ?? []) await h(decision, ctx);
		await drive(handlers, "turn_end", {}, ctx);
		const line = jsonl(dir).at(-1);
		assert.equal(line.request?.decision, "declined", "decision ack recorded");
		assert.equal(line.request?.why, "reclaimable-below-cost");
		assert.equal(requests(emissions).length, 1, "retryTurns spaces pressure re-requests");
	} finally {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
