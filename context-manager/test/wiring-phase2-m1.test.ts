// context-manager/test/wiring-phase2-m1.test.ts — Phase-2 M1 wire tests
// (spec-phase2.md@48c998a7 M1: AC-1 ≤1 Jev drift fetch/user turn + degraded
// decides keyless; AC-2 task-list diff ⇒ drift with zero fetches; AC-3
// p=0.70 stages ⇒ applied at NEXT user turn, ingest scoring OLD→NEW per B2).
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
function mockCtx(opts: { cwd: string; tokens?: number; prompt?: string }) {
	const promptRef = { current: opts.prompt ?? "◐ TEST-1 [in_progress] alpha subject one" };
	const ctx = {
		cwd: opts.cwd,
		hasUI: true,
		model: { provider: "litellm", id: "minimax" },
		ui: { setStatus: (_k: string, v?: string) => {}, notify: () => {} },
		sessionManager: { getSessionId: () => "ctx-m1-test", getEntries: () => [] },
		getContextUsage: () => ({ tokens: opts.tokens ?? 10_000, contextWindow: 1_048_576, percent: 1 }),
		isIdle: () => true,
		hasPendingMessages: () => false,
		getSystemPrompt: () => promptRef.current,
		signal: undefined,
		compact: () => {},
	};
	return { ctx, promptRef };
}
async function drive(h: Map<string, Handler[]>, e: string, ev: any, ctx: any) {
	for (const handler of h.get(e) ?? []) await handler(ev, ctx);
}
function userTurn(handlers: Map<string, Handler[]>, ctx: any, text: string) {
	return drive(handlers, "message_end", { message: { role: "user", content: text } }, ctx);
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
const isDriftCall = (b: FBody) => b?.questions?.drift != null;
const isIngestCall = (b: FBody) => b?.questions?.new_info != null;

test("M1 AC-1: at most ONE Jev drift fetch per user turn; first turn pins without scoring", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m1-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	const { calls, restore } = mockFetch(() => ({ answers: { drift: { noul: 0.9 } } }));
	try {
		await drive(handlers, "session_start", {}, ctx);
		await userTurn(handlers, ctx, "lets start the alpha phase");
		await drive(handlers, "turn_end", {}, ctx);
		await userTurn(handlers, ctx, "second message same focus");
		await drive(handlers, "turn_end", {}, ctx);
		await userTurn(handlers, ctx, "third message same focus");
		await drive(handlers, "turn_end", {}, ctx);
		const driftCalls = calls.filter(isDriftCall);
		assert.equal(driftCalls.length, 2, "turn 1 pins (no scoring); turns 2+3 one drift fetch each");
		for (const c of driftCalls) {
			assert.match(
				String(c.questions.drift.instructions),
				/shifts focus away from the pinned task model/,
				"spec-locked noul phrasing",
			);
		}
		const lines = jsonl(dir);
		assert.equal(lines[0].taskSwitch.staged, false, "turn 1: pinned, nothing staged");
		assert.equal(lines[1].taskSwitch.driftSource, "jev");
		assert.equal(lines[1].taskSwitch.staged, true, "drift stages at turn 2");
	} finally {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("M1 AC-2: task-list diff yields drift with ZERO Jev fetches; staged model applies next user turn", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m1-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx, promptRef } = mockCtx({ cwd: dir, prompt: "◐ TEST-1 [in_progress] alpha one" });
	const { calls, restore } = mockFetch(() => ({ answers: { drift: { noul: 0.0 } } })); // would say NO drift if consulted
	try {
		await drive(handlers, "session_start", {}, ctx);
		await userTurn(handlers, ctx, "start on alpha");
		await drive(handlers, "turn_end", {}, ctx);
		assert.equal(calls.filter(isDriftCall).length, 0, "pin turn makes no drift fetch");
		promptRef.current = "◐ TEST-2 [in_progress] beta two"; // different non-completed ID set
		await userTurn(handlers, ctx, "next user message");
		await drive(handlers, "turn_end", {}, ctx);
		assert.equal(calls.filter(isDriftCall).length, 0, "task-list diff ⇒ drift with zero Jev fetches");
		let lines = jsonl(dir);
		assert.equal(lines[0].taskSwitch.staged, false);
		assert.equal(lines[1].taskSwitch.driftSource, "task-diff");
		assert.equal(lines[1].taskSwitch.staged, true);
		// B2 apply at the NEXT user turn; detection then runs vs the new model (mock says no drift)
		await userTurn(handlers, ctx, "continue");
		await drive(handlers, "turn_end", {}, ctx);
		lines = jsonl(dir);
		assert.equal(lines[2].taskSwitch.staged, false, "staged model applied at next user turn");
		assert.ok(lines[2].taskSwitch.pinnedTurn > lines[1].taskSwitch.pinnedTurn, "pinned model advanced");
		assert.equal(calls.filter(isDriftCall).length, 1, "only the post-apply consult fetched");
	} finally {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("M1 AC-3: Jev p=0.70 stages; ingest scoring uses OLD tasks until apply, NEW after (B2)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m1-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx, promptRef } = mockCtx({ cwd: dir, prompt: "◐ TEST-1 [in_progress] alpha subject one" });
	const ingestTasks: any[] = [];
	const { calls, restore } = mockFetch((body) => {
		if (isIngestCall(body)) {
			ingestTasks.push(body.state.tasks);
			return { answers: { new_info: { noul: 0.9 }, on_task: { noul: 0.9 } } };
		}
		// drift only vs the ORIGINAL pin (topic of turn-1 model); post-apply model says no drift
		const topic = String(body.state?.pinnedTaskModel?.topic ?? "");
		return { answers: { drift: { noul: topic.startsWith("kick off") ? 0.7 : 0.0 } } };
	});
	const big = (tag: string) => `${tag} filler `.repeat(1400); // ~4550 tok ≥ relevanceMinTokens
	try {
		await drive(handlers, "session_start", {}, ctx);
		await userTurn(handlers, ctx, "kick off the alpha phase"); // pin OLD tasks
		await drive(handlers, "tool_execution_end", { toolName: "bash", args: {}, result: big("alpha") }, ctx);
		await drive(handlers, "turn_end", {}, ctx);
		promptRef.current = "◐ TEST-1 [in_progress] beta subject two"; // same ID ⇒ no task-diff; subject changed
		await userTurn(handlers, ctx, "pivot the entire plan to beta"); // Jev 0.70 ⇒ stage NEW
		await drive(handlers, "tool_execution_end", { toolName: "bash", args: {}, result: big("beta") }, ctx);
		await drive(handlers, "turn_end", {}, ctx);
		await userTurn(handlers, ctx, "continue on beta"); // apply staged (B2)
		await drive(handlers, "tool_execution_end", { toolName: "bash", args: {}, result: big("gamma") }, ctx);
		await drive(handlers, "turn_end", {}, ctx);

		const driftCalls = calls.filter(isDriftCall);
		assert.equal(driftCalls.length, 2, "Jev consulted on the drift turn and the post-apply turn (no task diff either turn)");
		assert.equal(ingestTasks.length, 3, "all three big spans scored");
		assert.deepEqual(ingestTasks[0], ["alpha subject one"], "turn N scoring uses OLD (pinned) tasks");
		assert.deepEqual(ingestTasks[1], ["alpha subject one"], "staged-but-unapplied still scores OLD");
		assert.deepEqual(ingestTasks[2], ["beta subject two"], "after apply, scoring uses NEW tasks");
		const lines = jsonl(dir);
		assert.equal(lines[1].taskSwitch.driftSource, "jev");
		assert.equal(lines[1].taskSwitch.staged, true);
		assert.equal(lines[2].taskSwitch.staged, false, "applied at turn 3");
	} finally {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("M1 review: Jev fetch fails with key present ⇒ degraded decides, source recorded", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m1-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir, prompt: "◐ TEST-1 [in_progress] alpha beta gamma" });
	const orig = globalThis.fetch;
	globalThis.fetch = (async () => {
		throw new TypeError("network down");
	}) as any;
	try {
		await drive(handlers, "session_start", {}, ctx);
		await userTurn(handlers, ctx, "hello there team");
		await drive(handlers, "turn_end", {}, ctx);
		await userTurn(handlers, ctx, "completely unrelated totally different");
		await drive(handlers, "turn_end", {}, ctx);
		const lines = jsonl(dir);
		assert.equal(lines[1].taskSwitch.driftSource, "heuristic-degraded", "fetch failure degrades to heuristic (AC-1)");
		assert.equal(lines[1].taskSwitch.staged, true);
	} finally {
		globalThis.fetch = orig;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("M1 review: threshold is strict > — p=0.65 no drift, p=0.66 drift", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m1-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir, prompt: "◐ TEST-1 [in_progress] alpha subject one" });
	const { calls, restore } = mockFetch(() => {
		const n = calls.filter(isDriftCall).length; // current call already pushed
		return { answers: { drift: { noul: n === 1 ? 0.65 : 0.66 } } };
	});
	try {
		await drive(handlers, "session_start", {}, ctx);
		await userTurn(handlers, ctx, "start the alpha work");
		await drive(handlers, "turn_end", {}, ctx);
		await userTurn(handlers, ctx, "totally new direction now"); // consult #1: 0.65 ⇒ NOT drift
		await drive(handlers, "turn_end", {}, ctx);
		await userTurn(handlers, ctx, "pivot to something else entirely"); // consult #2: 0.66 ⇒ drift
		await drive(handlers, "turn_end", {}, ctx);
		const lines = jsonl(dir);
		assert.equal(calls.filter(isDriftCall).length, 2);
		assert.equal(lines[1].taskSwitch.staged, false, "p=0.65 is not > 0.65 ⇒ no drift");
		assert.equal(lines[2].taskSwitch.driftSource, "jev");
		assert.equal(lines[2].taskSwitch.staged, true, "p=0.66 ⇒ drift staged");
	} finally {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("M1 AC-1b: no key ⇒ degraded overlap decides drift, zero fetches, source recorded", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m1-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir, prompt: "◐ TEST-1 [in_progress] alpha beta gamma" });
	const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m1-home-"));
	const origHome = process.env.HOME;
	const origKey = process.env.JEV_API_KEY;
	delete process.env.JEV_API_KEY;
	process.env.HOME = fakeHome; // jevKey(): no env key + no models.json ⇒ null
	const { calls, restore } = mockFetch(() => {
		throw new Error("must not fetch without a key");
	});
	try {
		await drive(handlers, "session_start", {}, ctx);
		await userTurn(handlers, ctx, "hello there team"); // pins; topic words hello/there/team
		await drive(handlers, "turn_end", {}, ctx);
		await userTurn(handlers, ctx, "completely unrelated totally different"); // overlap 0 < 0.15 ⇒ drift
		await drive(handlers, "turn_end", {}, ctx);
		assert.equal(calls.length, 0, "no fetch without a key");
		const lines = jsonl(dir);
		assert.equal(lines[1].taskSwitch.driftSource, "heuristic-degraded");
		assert.equal(lines[1].taskSwitch.staged, true);
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
