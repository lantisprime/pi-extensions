// context-manager/test/wiring-phase2-m3.test.ts — Phase-2 M3 wire tests
// (spec-phase2.md@48c998a7 M3: AC-9 telemetry purity matches harness share;
// AC-10 soft excess queues ⚠(queued) with NO compact that turn, queued flush
// executes exactly once next turn iff purity still ≥ budget; AC-11 hard excess
// compacts same turn with locked customInstructions, cooldown suppresses
// repeats, B6 — next assistant message_end skips cache-loss attribution).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.JEV_ENDPOINT = "http://mock.jev.test/systemone";
process.env.JEV_API_KEY = "test-key";

const { default: createExtension } = await import("../index.ts");

type Handler = (event: any, ctx: any) => Promise<any>;
function mockPi() {
	const handlers = new Map<string, Handler[]>();
	return {
		pi: {
			on: (e: string, h: Handler) => {
				const l = handlers.get(e) ?? [];
				l.push(h);
				handlers.set(e, l);
				return () => {};
			},
			registerCommand: (_n: string, _o: any) => {},
			events: { emit: () => {}, on: () => () => {} },
		} as any,
		handlers,
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

const A_TXT = "ALPHA ".repeat(1400); // 2100 tok — unrelated verdict, dump-class
const FILLER_SOFT = "FILLER ".repeat(4300); // 7525 tok, relevant — p ≈ 0.278 (soft)
const FILLER_HARD = "FILLER ".repeat(1144); // 2002 tok, relevant — p ≈ 0.51 (hard)
const FILLER_HUGE = "FILLER ".repeat(6860); // 12005 tok, relevant — dilutes p below budget
const B_TXT = "BETA ".repeat(648); // 810 tok — dup via supersession, unscored
const READ_TXT = "READ ".repeat(700); // 875 tok — dump-class read result
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

test("M3 AC-10a: soft excess queues ⚠(queued), NO compact that turn", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m3-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx, statusSets, compactCalls } = mockCtx({ cwd: dir });
	const { restore } = ingestAware();
	try {
		await drive(handlers, "session_start", {}, ctx);
		await seedSoft(handlers, ctx);
		assert.equal(compactCalls.length, 0, "no compact on the queueing turn");
		assert.ok(statusSets.some((s) => s.includes("⚠(queued)")), "status shows ⚠(queued)");
		assert.equal(jsonl(dir)[0].flush, null, "no flush telemetry on queue turn");
	} finally {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("M3 AC-10b: queued flush executes exactly once next turn iff purity still ≥ budget", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m3-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx, compactCalls } = mockCtx({ cwd: dir });
	const { restore } = ingestAware();
	try {
		await drive(handlers, "session_start", {}, ctx);
		await seedSoft(handlers, ctx); // turn 1: queued
		await drive(handlers, "turn_end", {}, ctx); // turn 2: purity still ≥ budget ⇒ soft-exec flush
		assert.equal(compactCalls.length, 1, "exactly one compact on the flush turn");
		assert.equal(compactCalls[0]?.customInstructions, "drop unrelated/dup/stale content", "B4 locked instructions");
		assert.equal(jsonl(dir)[1].flush, "soft-exec");
		await drive(handlers, "turn_end", {}, ctx); // turn 3: queue cleared ⇒ no second compact
		assert.equal(compactCalls.length, 1, "queue cleared after flush");
		assert.equal(jsonl(dir)[2].flush, null);
	} finally {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("M3 AC-10c: queued flush clears without compact when purity drops back under budget", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m3-"));
	fs.mkdirSync(path.join(dir, ".pi"));
	fs.writeFileSync(
		path.join(dir, ".pi", "context-manager.json"),
		JSON.stringify({ purityBudget: { budget: 0.25, hardMultiplier: 2, compactCooldownMin: 10 } }),
	);
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx, compactCalls } = mockCtx({ cwd: dir });
	const { restore } = ingestAware();
	try {
		await drive(handlers, "session_start", {}, ctx);
		await seedSoft(handlers, ctx); // p ≈ 0.278 ≥ 0.25 ⇒ queued
		assert.ok(jsonl(dir)[0].purity >= 0.25);
		await runTools(handlers, ctx, [{ text: FILLER_HUGE }]); // dilute: p = 2910/22471 ≈ 0.13 < 0.25
		await drive(handlers, "turn_end", {}, ctx);
		assert.equal(compactCalls.length, 0, "dropped purity clears the queue silently");
		assert.equal(jsonl(dir)[1].flush, null);
		await drive(handlers, "turn_end", {}, ctx); // turn 3: no deferred flush
		assert.equal(compactCalls.length, 0, "no compact after queue cleared");
	} finally {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("M3 AC-11+B6: hard flush same turn, locked instructions, cooldown suppresses repeat, next assistant skips cache attribution", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m3-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx, compactCalls } = mockCtx({ cwd: dir });
	const { restore } = ingestAware();
	try {
		await drive(handlers, "session_start", {}, ctx);
		await seedHard(handlers, ctx); // turn 1: hard flush, same turn
		assert.equal(compactCalls.length, 1, "hard excess compacts same turn");
		assert.equal(compactCalls[0]?.customInstructions, "drop unrelated/dup/stale content");
		assert.equal(jsonl(dir)[0].flush, "hard");
		// B6: first assistant message after the compact — attribution suppressed
		await assistantMsg(handlers, ctx, "post-compact reply");
		await drive(handlers, "turn_end", {}, ctx); // turn 2: purity still hard, but cooldown suppresses
		assert.equal(compactCalls.length, 1, "cooldown suppresses repeat compact");
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
	fs.mkdirSync(path.join(dir, ".pi"));
	fs.writeFileSync(
		path.join(dir, ".pi", "context-manager.json"),
		JSON.stringify({ purityBudget: { budget: 0.25 }, elision: { enabled: true, sideCarPath: ".pi/context-elisions.jsonl" } }),
	);
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx, compactCalls } = mockCtx({ cwd: dir });
	const { restore } = ingestAware();
	const READ_TXT = "READ ".repeat(700); // 875 tok dump-class read result
	try {
		await drive(handlers, "session_start", {}, ctx);
		await seedHard(handlers, ctx); // p ≈ 0.51 ≥ 0.25×2 (default hardMultiplier) ⇒ hard flush
		assert.equal(compactCalls.length, 1, "hard flush fires with default hardMultiplier (NaN gate fixed)");
		assert.equal(jsonl(dir)[0].flush, "hard");
		// rebuild pressure — compact blocked by cooldown ⇒ ledger intact, elision armed
		await runTools(handlers, ctx, [
			{ text: FILLER_HARD },
			...smalls(22),
			{ text: A_TXT },
			{ text: READ_TXT, toolName: "read" },
		]);
		await drive(handlers, "turn_end", {}, ctx);
		assert.equal(jsonl(dir)[1].flush, null, "cooldown blocks repeat compact");
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

test("M3 GLM#2 (CTX2-3): successful compact resets span ledger — purity reflects post-flush context", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m3-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx, compactCalls } = mockCtx({ cwd: dir });
	const { restore } = ingestAware();
	try {
		await drive(handlers, "session_start", {}, ctx);
		await seedHard(handlers, ctx); // turn 1: hard flush
		assert.ok(jsonl(dir)[0].spans.length > 0, "flush-turn telemetry shows the spans that triggered it");
		await runTools(handlers, ctx, [{ text: "fresh" }]);
		await drive(handlers, "turn_end", {}, ctx); // turn 2: ledger was reset ⇒ purity 0
		assert.equal(jsonl(dir)[1].purity, 0, "no stale purity carry-over after compact");
		assert.equal(jsonl(dir)[1].spans.length, 1, "ledger holds only post-compact spans");
		assert.equal(compactCalls.length, 1);
		await drive(handlers, "turn_end", {}, ctx); // turn 3: no cooldown-gated re-flush loop
		assert.equal(compactCalls.length, 1, "no re-compaction after ledger reset");
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
