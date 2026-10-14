// context-manager/test/wiring-phase5-judge.test.ts — Phase-5 M12 wire tests
// (spec-phase5.md@e9c4194e): per-site judge backend gates. The shipped DEFAULTS
// are heuristic for relevance/drift/rescore and kev for poison (2026-10-14
// corpus sweep: kev misses Jev floors at every cutoff on the similarity sites —
// scores/sweep.json; guardrail AC-6). These tests pin:
//   AC-3  judge.backends config deep-merge + sanitize (malformed → warn + default)
//   AC-6  heuristic defaults make ZERO judge fetches; explicit "kev" fetches once
//   AC-3  CM_JUDGE_BACKENDS env hatch forces kev (hermetic-test escape)
//   AC-4  turn telemetry records judge.backends (≤1/turn)
//   M11   default endpoint is the kev passthrough route (URL-level assertion)
// NOTE: this file deliberately does NOT set CM_JUDGE_BACKENDS — it tests the
// shipped defaults; the phase2 suites opt in via the env hatch.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.JEV_ENDPOINT = "http://mock.kev.test/kev/v1/systemone";
process.env.JEV_API_KEY = "test-key";

const { default: createExtension, __eval } = await import("../index.ts");

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
function mockCtx(opts: { cwd: string; prompt?: string }) {
	const promptRef = { current: opts.prompt ?? "" };
	return {
		ctx: {
			cwd: opts.cwd,
			hasUI: true,
			model: { provider: "litellm", id: "minimax" },
			ui: { setStatus: () => {}, notify: () => {} },
			sessionManager: { getSessionId: () => "p5-test", getEntries: () => [] },
			getContextUsage: () => ({ tokens: 10_000, contextWindow: 1_048_576, percent: 1 }),
			isIdle: () => true,
			hasPendingMessages: () => false,
			getSystemPrompt: () => promptRef.current,
			signal: undefined,
			compact: () => {},
		} as any,
		promptRef,
	};
}
async function drive(h: Map<string, Handler[]>, e: string, ev: any, ctx: any) {
	for (const handler of h.get(e) ?? []) await handler(ev, ctx);
}
function jsonl(cwd: string): any[] {
	const f = path.join(cwd, ".pi", "context-telemetry.jsonl");
	if (!fs.existsSync(f)) return [];
	return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
interface FCall {
	url: string;
	body: any;
}
function mockFetch(respond: (body: any) => any) {
	const calls: FCall[] = [];
	const orig = globalThis.fetch;
	globalThis.fetch = (async (url: any, init?: any) => {
		let parsed: any = {};
		try {
			parsed = JSON.parse(String(init?.body ?? "{}"));
		} catch {
			/* keep */
		}
		calls.push({ url: String(url), body: parsed });
		return { ok: true, status: 200, json: async () => respond(parsed) } as any;
	}) as any;
	return { calls, restore: () => (globalThis.fetch = orig) };
}
function span(excerpt: string): any {
	return { id: "s1", contentHash: "h", tok: 5000, capturedAt: Date.now(), cls: "unclassified", excerpt, isError: false };
}

test("P5 AC-6/M11: shipped drift default is heuristic — ZERO judge fetches; heuristic still detects drift", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p5-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir, prompt: "◐ TEST-1 [in_progress] refactor the auth gate" });
	const { calls, restore } = mockFetch(() => ({ answers: { drift: { noul: 0.99 } } }));
	try {
		await drive(handlers, "session_start", {}, ctx);
		await drive(handlers, "message_end", { message: { role: "user", content: "kick off the auth refactor" } }, ctx);
		await drive(handlers, "turn_end", {}, ctx);
		await drive(handlers, "message_end", { message: { role: "user", content: "completely unrelated pivot to garden irrigation sensors and watering schedules" } }, ctx);
		await drive(handlers, "turn_end", {}, ctx);
		assert.equal(calls.length, 0, "heuristic drift default makes zero judge fetches");
		const rows = jsonl(dir).map((l) => l.taskSwitch).filter(Boolean);
		assert.equal(rows[1].staged, true, "low-overlap message still stages via heuristic");
		assert.equal(rows[1].driftSource, "heuristic-degraded");
	} finally {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("P5 AC-6: explicit kev drift config fetches exactly once per user turn at the kev URL", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p5-"));
	fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".pi", "context-manager.json"), JSON.stringify({ judge: { backends: { drift: "kev" } } }));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	const { calls, restore } = mockFetch(() => ({ answers: { drift: { noul: 0.9 } } }));
	try {
		await drive(handlers, "session_start", {}, ctx);
		await drive(handlers, "message_end", { message: { role: "user", content: "first pinned turn" } }, ctx);
		await drive(handlers, "turn_end", {}, ctx);
		await drive(handlers, "message_end", { message: { role: "user", content: "second turn" } }, ctx);
		await drive(handlers, "turn_end", {}, ctx);
		assert.equal(calls.length, 1, "turn 1 pins; turn 2 → exactly one judge fetch");
		assert.equal(calls[0].url, "http://mock.kev.test/kev/v1/systemone", "M11: default endpoint is the kev passthrough");
		const rows = jsonl(dir).map((l) => l.taskSwitch).filter(Boolean);
		assert.equal(rows[1].driftSource, "jev", "kev verdict keeps the jev source label (D2)");
	} finally {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("P5 AC-3: CM_JUDGE_BACKENDS env hatch forces kev without file config", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p5-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	const { calls, restore } = mockFetch(() => ({ answers: { drift: { noul: 0.1 } } }));
	const prev = process.env.CM_JUDGE_BACKENDS;
	process.env.CM_JUDGE_BACKENDS = "drift";
	try {
		await drive(handlers, "session_start", {}, ctx);
		await drive(handlers, "message_end", { message: { role: "user", content: "first pinned turn" } }, ctx);
		await drive(handlers, "turn_end", {}, ctx);
		await drive(handlers, "message_end", { message: { role: "user", content: "second turn" } }, ctx);
		await drive(handlers, "turn_end", {}, ctx);
		assert.equal(calls.length, 1, "env hatch opted drift into kev");
	} finally {
		if (prev === undefined) delete process.env.CM_JUDGE_BACKENDS;
		else process.env.CM_JUDGE_BACKENDS = prev;
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("P5 AC-3: relevance gate — heuristic skips fetch; kev path used unless explicitly heuristic", async () => {
	const { calls, restore } = mockFetch(() => ({ answers: { new_info: { noul: 0.2 }, on_task: { noul: 0.9 } } }));
	try {
		const cfgH = { judge: { backends: { relevance: "heuristic" } } } as any;
		const outH = await __eval.ingestRelevance(span("fresh unique content about widgets"), [span("other stuff")], ["TASK-A"], cfgH);
		assert.equal(calls.length, 0, "explicit heuristic never fetches");
		assert.equal(outH.source, "heuristic-degraded");

		const cfgK = { judge: { backends: { relevance: "kev" } } } as any;
		const outK = await __eval.ingestRelevance(span("fresh unique content about widgets"), [span("other stuff")], ["TASK-A"], cfgK);
		assert.equal(calls.length, 1);
		assert.equal(outK.v, "duplicate", "new_info 0.2 < 0.35");
		assert.equal(outK.source, "jev");

		const outAbsent = await __eval.ingestRelevance(span("fresh unique content about widgets"), [span("other stuff")], ["TASK-A"], {} as any);
		assert.equal(calls.length, 2, "absent judge config (raw __eval calls) still attempts the judge");
		assert.equal(outAbsent.source, "jev");
	} finally {
		restore();
	}
});

test("P5 AC-3: malformed judge.backends values warn + default (never throw)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p5-"));
	fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".pi", "context-manager.json"),
		JSON.stringify({ judge: { backends: { relevance: "gpt4", drift: 42, poison: "kev" } } }),
	);
	const warnings: string[] = [];
	const origWarn = console.warn;
	console.warn = (m: string) => warnings.push(m);
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	const { calls, restore } = mockFetch(() => ({ answers: {} }));
	try {
		await drive(handlers, "session_start", {}, ctx);
		await drive(handlers, "message_end", { message: { role: "user", content: "pin turn" } }, ctx);
		await drive(handlers, "turn_end", {}, ctx);
		await drive(handlers, "message_end", { message: { role: "user", content: "second turn" } }, ctx);
		await drive(handlers, "turn_end", {}, ctx);
		assert.ok(warnings.some((w) => w.includes("judge.backends")), "warn on malformed values");
		assert.equal(calls.filter((c) => c.body?.questions?.drift).length, 0, "drift fell back to default heuristic");
	} finally {
		console.warn = origWarn;
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("P5 AC-4: turn telemetry records judge.backends exactly once per turn row", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p5-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	try {
		await drive(handlers, "session_start", {}, ctx);
		await drive(handlers, "message_end", { message: { role: "user", content: "one turn" } }, ctx);
		await drive(handlers, "turn_end", {}, ctx);
		const rows = jsonl(dir);
		assert.equal(rows.length, 1);
		assert.deepEqual(rows[0].judge.backends, { relevance: "heuristic", drift: "heuristic", rescore: "heuristic", poison: "kev" });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
