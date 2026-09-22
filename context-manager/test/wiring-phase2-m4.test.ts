// context-manager/test/wiring-phase2-m4.test.ts — Phase-2 M4 wire tests
// (spec-phase2.md@48c998a7 M4: AC-12 task-switch apply re-scores ≤30 spans via
// ONE batched Jev fetch; degraded updates heuristically with zero fetches;
// pendingScores resolve before turn_end metrics; rescoredAtTurn recorded).
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
	const ctx = {
		cwd: opts.cwd,
		hasUI: true,
		model: { provider: "litellm", id: "minimax" },
		ui: { setStatus: (_k: string, v?: string) => {}, notify: () => {} },
		sessionManager: { getSessionId: () => "ctx-m4-test", getEntries: () => [] },
		getContextUsage: () => ({ tokens: opts.tokens ?? 10_000, contextWindow: 1_048_576, percent: 1 }),
		isIdle: () => true,
		hasPendingMessages: () => false,
		getSystemPrompt: () => promptRef.current,
		signal: undefined,
		compact: () => {},
	};
	const promptRef = { current: opts.prompt ?? "◐ TEST-1 [in_progress] alpha subject one" };
	return { ctx, promptRef };
}
async function drive(h: Map<string, Handler[]>, e: string, ev: any, ctx: any) {
	for (const handler of h.get(e) ?? []) await handler(ev, ctx);
}
async function userTurn(h: Map<string, Handler[]>, ctx: any, text: string) {
	await drive(h, "message_end", { message: { role: "user", content: text } }, ctx);
}
async function runTools(h: Map<string, Handler[]>, ctx: any, texts: string[]) {
	for (const text of texts) {
		await drive(h, "tool_execution_end", { toolName: "bash", args: {}, result: text }, ctx);
	}
}
function jsonl(cwd: string): any[] {
	const f = path.join(cwd, ".pi", "context-telemetry.jsonl");
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
const isRescoreCall = (b: FBody) => Array.isArray(b?.state?.spans);
const isIngestCall = (b: FBody) => b?.questions?.new_info != null;

const A_TXT = "ALPHA filler ".repeat(700); // 2275 tok, scored at ingest
const FILLER_TXT = "beta FILLER ".repeat(1300); // 3900 tok, scored at ingest

test("M4 AC-12: apply re-scores batch via ONE fetch; verdicts updated vs NEW model; rescoredAtTurn recorded", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m4-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx, promptRef } = mockCtx({ cwd: dir, prompt: "◐ TEST-1 [in_progress] alpha subject one" });
	const { calls, restore } = mockFetch((body) => {
		if (isRescoreCall(body)) {
			// batched: per-span on_task answers keyed span0..spanN
			const answers: Record<string, { noul: number }> = {};
			for (const s of body.state.spans) {
				answers[`span${s.i}`] = { noul: String(s.excerpt).includes("FILLER") ? 0.9 : 0.05 };
			}
			return { answers };
		}
		if (isIngestCall(body)) {
			const ex = String(body.state?.candidate?.excerpt ?? "");
			// at INGEST both look relevant to the OLD model; rescore flips ALPHA later
			return { answers: { new_info: { noul: 0.9 }, on_task: { noul: 0.9 } } };
		}
		// drift consult: only vs the ORIGINAL pin topic
		const topic = String(body.state?.pinnedTaskModel?.topic ?? "");
		return { answers: { drift: { noul: topic.startsWith("kick off") ? 0.7 : 0.0 } } };
	});
	try {
		await drive(handlers, "session_start", {}, ctx);
		await userTurn(handlers, ctx, "kick off the alpha phase"); // pin OLD
		await runTools(handlers, ctx, [A_TXT, FILLER_TXT]); // both ingest-scored relevant
		await drive(handlers, "turn_end", {}, ctx);
		promptRef.current = "◐ TEST-1 [in_progress] beta subject two"; // same ID ⇒ Jev drift path
		await userTurn(handlers, ctx, "pivot the plan to beta"); // 0.70 ⇒ stage NEW
		await drive(handlers, "turn_end", {}, ctx);
		await userTurn(handlers, ctx, "continue on beta"); // apply staged ⇒ M4 re-score
		await drive(handlers, "turn_end", {}, ctx);

		const rescores = calls.filter(isRescoreCall);
		assert.equal(rescores.length, 1, "exactly ONE batched rescore fetch");
		assert.equal(Object.keys(rescores[0].questions).length, 2, "one question per span");
		assert.deepEqual(rescores[0].state.pinnedTaskModel.tasks, ["beta subject two"], "scored vs NEW model");
		const spans = jsonl(dir)[2].spans;
		const a = spans.find((s: any) => s.tok === Math.ceil(A_TXT.length / 4));
		const f = spans.find((s: any) => s.tok === Math.ceil(FILLER_TXT.length / 4));
		assert.equal(a.verdict, "unrelated", "ALPHA flipped to unrelated vs NEW model (was relevant)");
		assert.equal(a.source, "jev");
		assert.equal(a.rescoredAtTurn, 2, "rescoredAtTurn recorded");
		assert.equal(f.verdict, "relevant");
		assert.equal(f.rescoredAtTurn, 2);
	} finally {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("M4 AC-12 degraded: no key ⇒ heuristic re-score with zero fetches", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m4-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx, promptRef } = mockCtx({ cwd: dir, prompt: "◐ TEST-1 [in_progress] alpha subject one" });
	const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m4-home-"));
	const origHome = process.env.HOME;
	const origKey = process.env.JEV_API_KEY;
	delete process.env.JEV_API_KEY;
	process.env.HOME = fakeHome;
	const { calls, restore } = mockFetch(() => {
		throw new Error("must not fetch without a key");
	});
	try {
		await drive(handlers, "session_start", {}, ctx);
		await userTurn(handlers, ctx, "kick off the alpha phase"); // pin OLD (topic words: kick/alpha/phase)
		await runTools(handlers, ctx, [A_TXT, FILLER_TXT]); // degraded ingest: ALPHA relevant (alpha hit), beta-FILLER unrelated (0 overlap)
		await drive(handlers, "turn_end", {}, ctx);
		promptRef.current = "◐ TEST-2 [in_progress] beta subject two"; // NEW ID ⇒ task-diff drift, zero Jev
		await userTurn(handlers, ctx, "pivot to beta");
		await drive(handlers, "turn_end", {}, ctx);
		await userTurn(handlers, ctx, "continue beta"); // apply ⇒ degraded rescore
		await drive(handlers, "turn_end", {}, ctx);
		assert.equal(calls.length, 0, "zero fetches without a key");
		const spans = jsonl(dir)[2].spans;
		const a = spans.find((s: any) => s.tok === Math.ceil(A_TXT.length / 4));
		const f = spans.find((s: any) => s.tok === Math.ceil(FILLER_TXT.length / 4));
		assert.equal(a.verdict, "unrelated", "ALPHA has no overlap with NEW model ⇒ unrelated");
		assert.equal(a.source, "heuristic-degraded");
		assert.equal(f.verdict, "relevant", "beta-FILLER shares 'beta' with NEW model ⇒ relevant (flipped back)");
		assert.equal(f.source, "heuristic-degraded");
		assert.equal(a.rescoredAtTurn, 2);
	} finally {
		restore();
		if (origHome !== undefined) process.env.HOME = origHome;
		else delete process.env.HOME;
		if (origKey !== undefined) process.env.JEV_API_KEY = origKey;
		else delete process.env.JEV_API_KEY;
		fs.rmSync(fakeHome, { recursive: true, force: true });
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("M4 AC-12: rescoreBatch cap — 35 candidates ⇒ exactly 30 re-scored, oldest 5 untouched", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m4-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx, promptRef } = mockCtx({ cwd: dir, prompt: "◐ TEST-1 [in_progress] alpha subject one" });
	const { calls, restore } = mockFetch((body) => {
		if (isRescoreCall(body)) {
			const answers: Record<string, { noul: number }> = {};
			for (const s of body.state.spans) answers[`span${s.i}`] = { noul: 0.05 };
			return { answers };
		}
		if (isIngestCall(body)) return { answers: { new_info: { noul: 0.9 }, on_task: { noul: 0.9 } } };
		return { answers: { drift: { noul: 0.0 } } };
	});
	const spanText = (i: number) => `SPAN${i} `.repeat(1400); // 2100 tok each, distinct
	try {
		await drive(handlers, "session_start", {}, ctx);
		await userTurn(handlers, ctx, "kick off the alpha phase");
		await runTools(
			handlers,
			ctx,
			Array.from({ length: 35 }, (_, i) => spanText(i)),
		);
		await drive(handlers, "turn_end", {}, ctx);
		promptRef.current = "◐ TEST-2 [in_progress] beta subject two"; // ID change ⇒ task-diff stage
		await userTurn(handlers, ctx, "pivot to beta");
		await drive(handlers, "turn_end", {}, ctx);
		await userTurn(handlers, ctx, "continue beta"); // apply ⇒ rescore
		await drive(handlers, "turn_end", {}, ctx);
		const rescores = calls.filter(isRescoreCall);
		assert.equal(rescores.length, 1);
		assert.equal(Object.keys(rescores[0].questions).length, 30, "rescoreBatch cap of 30 respected");
		const spans = jsonl(dir)[2].spans.filter((s: any) => s.tok >= 2000); // all 35 fixture spans (2-digit ids have 2450 tok)
		assert.equal(spans.length, 35);
		const rescored = spans.filter((s: any) => s.rescoredAtTurn === 2);
		assert.equal(rescored.length, 30, "most-recent 30 re-scored");
		assert.ok(rescored.every((s: any) => s.verdict === "unrelated"), "batch answers applied (on_task 0.05 ⇒ unrelated)");
		const untouched = spans.filter((s: any) => s.rescoredAtTurn === null);
		assert.equal(untouched.length, 5, "oldest 5 candidates untouched");
		assert.ok(untouched.every((s: any) => s.verdict === "relevant" && s.source === "jev"));
	} finally {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
