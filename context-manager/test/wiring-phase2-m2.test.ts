// context-manager/test/wiring-phase2-m2.test.ts — Phase-2 M2 wire tests
// (spec-phase2.md@48c998a7 M2: AC-4 persistent dump elision under hard pressure;
// AC-5 read-tool never elided (B1); AC-6 errors never elided; AC-7 side-car
// written before stub + fail-open with {elision:"skipped"} telemetry; AC-8
// soft tier elides unrelated-only, hard tier also dup-class; under-budget no-op).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";

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
	const ctx = {
		cwd: opts.cwd,
		hasUI: true,
		model: { provider: "litellm", id: "minimax" },
		ui: { setStatus: (_k: string, v?: string) => {}, notify: () => {} },
		sessionManager: { getSessionId: () => "ctx-m2-test", getEntries: () => [] },
		getContextUsage: () => ({ tokens: opts.tokens ?? 10_000, contextWindow: 1_048_576, percent: 1 }),
		isIdle: () => true,
		hasPendingMessages: () => false,
		getSystemPrompt: () => "◐ TEST-1 [in_progress] alpha subject one",
		signal: undefined,
		compact: () => {},
	};
	return { ctx };
}
async function drive(h: Map<string, Handler[]>, e: string, ev: any, ctx: any) {
	for (const handler of h.get(e) ?? []) await handler(ev, ctx);
}
async function toolResultMsg(h: Map<string, Handler[]>, ctx: any, content: string) {
	const msg = { role: "toolResult", content };
	await drive(h, "message_end", { message: msg }, ctx);
	return msg;
}
async function runTools(h: Map<string, Handler[]>, ctx: any, items: Array<{ text: string; toolName?: string; isError?: boolean }>) {
	for (const it of items) {
		await drive(h, "tool_execution_end", { toolName: it.toolName ?? "bash", args: {}, result: it.text, isError: it.isError }, ctx);
	}
}
function jsonl(cwd: string): any[] {
	const f = path.join(cwd, ".pi", "context-telemetry.jsonl");
	if (!fs.existsSync(f)) return [];
	return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function sidecarLines(cwd: string): any[] {
	const f = path.join(cwd, ".pi", "context-elisions.jsonl");
	if (!fs.existsSync(f)) return [];
	return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
type FBody = any;
function mockFetch(respond: (body: FBody) => any) {
	const calls: FBody[] = [];
	const orig = globalThis.fetch;
	globalThis.fetch = (async (_url: any, init?: any) => {
		const body = JSON.parse(init?.body ?? "{}");
		calls.push(body);
		return { ok: true, json: async () => respond(body) } as any;
	}) as any;
	return { calls, restore: () => (globalThis.fetch = orig) };
}
const isIngestCall = (b: FBody) => b?.questions?.new_info != null;
// ALPHA → unrelated verdict; FILLER → relevant; both ≥2000 tok so they get scored
function ingestAware() {
	return mockFetch((body) => {
		if (isIngestCall(body)) {
			const ex = String(body.state?.candidate?.excerpt ?? "");
			return ex.includes("FILLER")
				? { answers: { new_info: { noul: 0.9 }, on_task: { noul: 0.9 } } }
				: { answers: { new_info: { noul: 0.9 }, on_task: { noul: 0.05 } } };
		}
		return { answers: { drift: { noul: 0.0 } } };
	});
}

const A_TXT = "ALPHA ".repeat(1400); // 8400 chars = 2100 tok (dump-class, scored unrelated)
const FILLER_SOFT = "FILLER ".repeat(4300); // 7525 tok, relevant — dilutes purity to soft tier
const FILLER_HARD = "FILLER ".repeat(1144); // 2002 tok, relevant — purity lands hard tier
const FILLER_HUGE = "FILLER ".repeat(6860); // 12005 tok, relevant — purity lands under budget
const B_TXT = "BETA ".repeat(648); // 3240 chars = 810 tok (dump-class, dup via supersession, unscored)
const A_SHA = createHash("sha1").update(A_TXT).digest("hex");
const smalls = (n: number) => Array.from({ length: n }, () => ({ text: "ok" }));
// Post-CTX2-3 flow: a hard-pressure turn now triggers M3 compact + ledger reset. To test
// hard-tier elision (pressure + INTACT ledger), rebuild pressure while compact is blocked
// by cooldown — the legitimate persistent-hard-pressure state.
async function armHardPressure(h: Map<string, Handler[]>, ctx: any) {
	// turn 1: pressure ⇒ M3 hard flush, ledger reset, cooldown armed
	await runTools(h, ctx, [{ text: FILLER_HARD }, ...smalls(22), { text: A_TXT }]);
	await drive(h, "turn_end", {}, ctx);
	// turn 2: rebuild pressure (both A copies count as unrelated ⇒ p ≈ 0.51 ≥ hard);
	// triggerCompact blocked by cooldown ⇒ flush null, ledger intact
	await runTools(h, ctx, [{ text: FILLER_HARD }, ...smalls(22), { text: A_TXT }]);
	await drive(h, "turn_end", {}, ctx);
}

test("M2 AC-4: hard pressure elides dump toolResult persistently with exact stub + side-car", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m2-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	const { restore } = ingestAware();
	try {
		await drive(handlers, "session_start", {}, ctx);
		await armHardPressure(handlers, ctx); // lastPurity ≥ hard, ledger intact, compact cooldown-blocked
		const msg = await toolResultMsg(handlers, ctx, A_TXT);
		assert.equal(
			msg.content,
			`[elided 2100 tok dump: sha=${A_SHA}; archived: .pi/context-elisions.jsonl#0]`,
			"persistent stub replaces content (AC-4)",
		);
		// GLM M2 review Q1: hard tier = unrelated verdict ∪ dup-class ONLY —
		// an unclassified span with a RELEVANT verdict must be retained
		const rel = await toolResultMsg(handlers, ctx, FILLER_HARD);
		assert.equal(rel.content, FILLER_HARD, "unclassified + relevant verdict retained even under hard pressure");
		const sc = sidecarLines(dir);
		assert.equal(sc.length, 1, "side-car written before stub applies (AC-7)");
		assert.equal(sc[0].sha, A_SHA);
		assert.equal(sc[0].tok, 2100);
		assert.equal(sc[0].text, A_TXT, "full original text archived");
		assert.ok(sc[0].ts && sc[0].sessionId);
		// idempotency: re-delivering the stub is a no-op
		const again = await toolResultMsg(handlers, ctx, msg.content as string);
		assert.equal(again.content, msg.content);
		await drive(handlers, "turn_end", {}, ctx);
		assert.deepEqual(jsonl(dir)[2].elision, { elided: 1, skipped: 0, tokens: 2100 });
	} finally {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("M2 AC-5: read-tool result never elided even under hard pressure (B1)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m2-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	const { restore } = ingestAware();
	const READ_TXT = "READ ".repeat(700); // 875 tok, dump-class
	try {
		await drive(handlers, "session_start", {}, ctx);
		await armHardPressure(handlers, ctx);
		await runTools(handlers, ctx, [{ text: READ_TXT, toolName: "read" }]); // arrives post-rebuild, elision armed
		const msg = await toolResultMsg(handlers, ctx, READ_TXT);
		assert.equal(msg.content, READ_TXT, "read result intact under hard pressure");
		const a = await toolResultMsg(handlers, ctx, A_TXT);
		assert.match(String(a.content), /^\[elided /, "elision IS armed — the read gate (B1), not missing pressure, spared READ");
		assert.equal(sidecarLines(dir).length, 1, "nothing archived for read results");
	} finally {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("M2 AC-6: error results never elided", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m2-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	const { restore } = ingestAware();
	const ERR_TXT = "ERR ".repeat(810); // 810 tok, isError ⇒ error class
	try {
		await drive(handlers, "session_start", {}, ctx);
		await armHardPressure(handlers, ctx);
		await runTools(handlers, ctx, [{ text: ERR_TXT, isError: true }]); // arrives post-rebuild, elision armed
		const msg = await toolResultMsg(handlers, ctx, ERR_TXT);
		assert.equal(msg.content, ERR_TXT, "error result intact");
		const a = await toolResultMsg(handlers, ctx, A_TXT);
		assert.match(String(a.content), /^\[elided /, "elision IS armed — the error gate, not missing pressure, spared ERR");
		assert.equal(sidecarLines(dir).length, 1);
	} finally {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("M2 AC-7: side-car append failure ⇒ fail-open, original intact, {elision:skipped} telemetry", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m2-"));
	fs.mkdirSync(path.join(dir, ".pi"));
	fs.writeFileSync(
		path.join(dir, ".pi", "context-manager.json"),
		JSON.stringify({ elision: { enabled: true, sideCarPath: "blocked/elisions.jsonl", readToolNames: ["read"] } }),
	);
	fs.writeFileSync(path.join(dir, "blocked"), "regular file blocks mkdir/append"); // ENOTDIR/EEXIST path
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	const { restore } = ingestAware();
	try {
		await drive(handlers, "session_start", {}, ctx);
		await armHardPressure(handlers, ctx); // elision armed, append target blocked ⇒ fail-open provable
		const msg = await toolResultMsg(handlers, ctx, A_TXT); // eligible, but append must fail
		assert.equal(msg.content, A_TXT, "fail-open: original content intact");
		assert.ok(!fs.existsSync(path.join(dir, "blocked", "elisions.jsonl")), "no side-car written");
		await drive(handlers, "turn_end", {}, ctx);
		assert.deepEqual(jsonl(dir)[2].elision, { elided: 0, skipped: 1, tokens: 0 }, "{elision:skipped} telemetry");
	} finally {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("M2 AC-8 soft tier: elides unrelated dump, retains dup-class dump (0.15 ≤ p < 0.30)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m2-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	const { restore } = ingestAware();
	try {
		await drive(handlers, "session_start", {}, ctx);
		// p = (2100 unrelated + 810 dup) / 10466 ≈ 0.278 ⇒ soft tier
		// A, fillerR early (out of 20-span supersession window), B + conclusion last (B → dup)
		await runTools(handlers, ctx, [
			{ text: A_TXT },
			{ text: FILLER_SOFT },
			...smalls(25),
			{ text: B_TXT },
			...smalls(5),
			{ text: "done" },
		]);
		await drive(handlers, "turn_end", {}, ctx);
		const msgA = await toolResultMsg(handlers, ctx, A_TXT);
		assert.match(String(msgA.content), /^\[elided 2100 tok dump/, "unrelated dump elided in soft tier");
		const msgB = await toolResultMsg(handlers, ctx, B_TXT);
		assert.equal(msgB.content, B_TXT, "dup-class dump retained in soft tier (verdict not unrelated)");
		const sc = sidecarLines(dir);
		assert.equal(sc.length, 1);
		assert.equal(sc[0].sha, A_SHA);
	} finally {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("M2 AC-8 hard tier: elides both unrelated and dup-class dumps (p ≥ 2×budget)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m2-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	const { restore } = ingestAware();
	try {
		await drive(handlers, "session_start", {}, ctx);
		await armHardPressure(handlers, ctx); // cooldown-blocked flush ⇒ hard-tier elision state persists
		// rebuild + dup fixture: p stays ≥ hard with ledger intact
		await runTools(handlers, ctx, [
			{ text: A_TXT },
			{ text: FILLER_HARD },
			...smalls(25),
			{ text: B_TXT },
			...smalls(5),
			{ text: "done" },
		]);
		await drive(handlers, "turn_end", {}, ctx);
		const msgA = await toolResultMsg(handlers, ctx, A_TXT);
		assert.match(String(msgA.content), /^\[elided 2100 tok dump.*#0\]$/, "unrelated elided (seq 0)");
		const msgB = await toolResultMsg(handlers, ctx, B_TXT);
		assert.match(String(msgB.content), /^\[elided 810 tok dump.*#1\]$/, "dup-class also elided in hard tier (seq 1)");
		assert.equal(sidecarLines(dir).length, 2);
	} finally {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("M2 under budget: p < budget ⇒ no elision at all", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m2-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	const { restore } = ingestAware();
	try {
		await drive(handlers, "session_start", {}, ctx);
		// p = 2100 / (2100 + 12005) ≈ 0.149 < 0.15 ⇒ under budget
		await runTools(handlers, ctx, [{ text: A_TXT }, { text: FILLER_HUGE }]);
		await drive(handlers, "turn_end", {}, ctx);
		assert.ok(jsonl(dir)[0].purity !== undefined && jsonl(dir)[0].purity < 0.15, "purity under budget");
		const msg = await toolResultMsg(handlers, ctx, A_TXT);
		assert.equal(msg.content, A_TXT, "dump intact under budget");
		assert.equal(sidecarLines(dir).length, 0);
	} finally {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
