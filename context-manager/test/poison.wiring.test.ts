// context-manager/test/poison.wiring.test.ts — Phase-4 wire tests
// (spec-phase4.md@8c4a3d0d (v1.1): M7 poison battery, M8 secret redaction, M9 error-loop
// collapse, M10 incident fixtures. Pattern per AGENTS.md: wiring bugs get wiring
// tests. Battery semantics honored: candidates need a PRIOR burst (warm exempt),
// act enqueues via the single authoritative path, degraded is capped at review,
// and the context hot path makes ZERO network calls (AC-4/AC-22).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { default: createExtension } = await import("../index.ts");

function cfg(dir: string, obj: Record<string, unknown>): void {
	fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".pi", "context-manager.json"), JSON.stringify(obj));
}

type Handler = (event: any, ctx: any) => Promise<any>;
function mockPi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	return {
		pi: {
			on: (e: string, h: Handler) => {
				const l = handlers.get(e) ?? [];
				l.push(h);
				handlers.set(e, l);
				return () => {};
			},
			registerCommand: (n: string, o: any) => commands.set(n, o),
			events: { emit: () => {}, on: () => () => {} },
		} as any,
		handlers,
		commands,
	};
}
function mockCtx(opts: { cwd: string; tokens?: number; prompt?: string }) {
	const compactCalls: string[] = [];
	const notices: string[] = [];
	const statusByKey = new Map<string, string | undefined>();
	const ctx: any = {
		cwd: opts.cwd,
		hasUI: true,
		model: { provider: "litellm", id: "minimax" },
		ui: {
			setStatus: (k: string, v?: string) => statusByKey.set(k, v),
			notify: (m: string) => notices.push(m),
		},
		sessionManager: { getSessionId: () => "poison-test", getEntries: () => [] },
		getContextUsage: () => ({ tokens: opts.tokens ?? 10_000, contextWindow: 1_048_576, percent: 1 }),
		isIdle: () => true,
		hasPendingMessages: () => false,
		getSystemPrompt: () => opts.prompt ?? "◐ TEST-1 [in_progress] alpha beta gamma",
		signal: undefined,
		compact: (o: { customInstructions: string }) => compactCalls.push(o.customInstructions),
	};
	return { ctx, compactCalls, notices, statusByKey };
}
async function drive(h: Map<string, Handler[]>, e: string, ev: any, ctx: any): Promise<any> {
	let out: any;
	for (const handler of h.get(e) ?? []) out = await handler(ev, ctx);
	return out;
}
function jsonl(cwd: string): any[] {
	const f = path.join(cwd, ".pi", "context-telemetry.jsonl");
	if (!fs.existsSync(cwd) || !fs.existsSync(f)) return [];
	return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function userMsg(text: string) {
	return { role: "user", content: [{ type: "text", text }] };
}
function asstMsg(id: string) {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "working" },
			{ type: "toolCall", id, name: "bash", arguments: { cmd: "x" } },
		],
		usage: { input: 10, cacheRead: 0, cacheWrite: 0 },
	};
}
function toolMsg(id: string, text: string, toolName = "bash", isError = false) {
	return { role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text }], isError };
}
/** Fetch mock with body log; respond(body, attempt) → {status?, body?}. */
function mockFetch(respond: (body: any, attempt: number) => { status?: number; body?: any }) {
	const bodies: any[] = [];
	let attempts = 0;
	const orig = globalThis.fetch;
	globalThis.fetch = (async (_url: any, init?: any) => {
		attempts += 1;
		const body = JSON.parse(init?.body ?? "{}");
		bodies.push(body);
		const r = respond(body, attempts);
		if (r.status != null && r.status !== 200) return { ok: false, status: r.status, json: async () => ({}) } as any;
		return { ok: true, status: 200, json: async () => r.body } as any;
	}) as any;
	return {
		bodies,
		attempts: () => attempts,
		restore: () => (globalThis.fetch = orig),
	};
}
const isBatteryCall = (b: any) => Array.isArray(b?.state?.poisonSpans);
const isIngestCall = (b: any) => b?.questions?.new_info != null;

const DUMP = "line of healthy output ".repeat(160); // ~3600 chars ⇒ ~900 tok ≥ dump floor

/** Turn 1: open burst, capture spans (warm — battery must skip them), close at turn_end. */
async function seedTurn(h: Map<string, Handler[]>, ctx: any, spans: Array<{ text: string; isError?: boolean; args?: any }>) {
	await drive(h, "message_end", { message: { role: "user", content: "turn: do things" } }, ctx);
	let i = 0;
	for (const t of spans) {
		await drive(h, "tool_execution_end", { toolName: "bash", args: t.args ?? { cmd: `run ${i}` }, result: t.text, isError: t.isError }, ctx);
		i++;
	}
	await drive(h, "turn_end", {}, ctx);
	await new Promise((r) => setTimeout(r, 3)); // same-ms captures read as "warm" (Phase-3 capturedAt < openedAt) — make the boundary strict
}
const nextTurn = async (h: Map<string, Handler[]>, ctx: any) => drive(h, "message_end", { message: { role: "user", content: "next turn" } }, ctx);
/** Context call over a transcript carrying `texts` (burst must be open). Returns the view. */
async function driveContext(h: Map<string, Handler[]>, ctx: any, texts: string[]) {
	const messages: any[] = [userMsg("turn: do things")];
	let i = 0;
	for (const t of texts) {
		messages.push(asstMsg(`call-${i}`));
		messages.push(toolMsg(`call-${i}`, t));
		i++;
	}
	return drive(h, "context", { messages }, ctx);
}
function viewText(view: any): string {
	return JSON.stringify(view?.messages?.map((m: any) => m.content) ?? []);
}

test("P4 AC-5/AC-3/AC-7: truth table — act(contra), act(stale∧conf), review(mid), pass; one call; stubs in view", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p4-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	const fm = mockFetch((body) => {
		if (isBatteryCall(body)) {
			const answers: Record<string, any> = {};
			for (const s of body.state.poisonSpans) {
				const ex = String(s.excerpt);
				answers[`contra_${s.sha8}`] = { noul: ex.includes("CONTRA_MARKER") ? 0.95 : ex.includes("MID_MARKER") ? 0.5 : 0.02 };
				answers[`stale_${s.sha8}`] = ex.includes("STALE_MARKER") ? { score: 2.5, confidence: 0.9 } : { score: 0, confidence: 0.9 };
			}
			return { body: { answers, usage: { input_tokens: 42 } } };
		}
		return { body: {} };
	});
	try {
		await drive(handlers, "session_start", {}, ctx);
		await seedTurn(handlers, ctx, [
			{ text: `CONTRA_MARKER ${DUMP}`, args: { cmd: "a" } },
			{ text: `STALE_MARKER ${DUMP}`, args: { cmd: "b" } },
			{ text: `MID_MARKER ${DUMP}`, args: { cmd: "c" } },
			{ text: `plain ${DUMP}`, args: { cmd: "d" } },
		]);
		const before = fm.bodies.filter(isBatteryCall).length;
		await nextTurn(handlers, ctx); // burst 2 — turn-1 spans are now non-warm
		await drive(handlers, "turn_end", {}, ctx);
		const batteryCalls = fm.bodies.filter(isBatteryCall);
		assert.equal(batteryCalls.length - before, 1, "exactly ONE battery call (AC-3)");
		assert.equal(batteryCalls.at(-1).state.poisonSpans.length, 4, "all four non-warm dumps are candidates");
		assert.equal(Object.keys(batteryCalls.at(-1).questions).length, 8, "two questions per candidate (AC-3)");
		const last = jsonl(dir).at(-1);
		assert.equal(last.shape.poisonActed, 2, "act: contra≥0.80 OR stale≥2∧conf≥0.5 (AC-5)");
		assert.equal(last.shape.poisonReview, 1, "review: contra in [0.35,0.80) band (AC-5)");
		assert.equal(last.poison.degraded, 0);
		// AC-7: acted spans appear stubbed at the NEXT context call's view
		await nextTurn(handlers, ctx);
		const view = await driveContext(handlers, ctx, [`CONTRA_MARKER ${DUMP}`, `plain ${DUMP}`]);
		const vt = viewText(view);
		assert.ok(vt.includes("[shaped:"), "acted span stubbed in view");
		assert.ok(vt.includes("CONTRA_MARKER") === false, "acted span content replaced by stub");
	} finally {
		fm.restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("P4 AC-24: stale arm requires scoreConf ≥ 0.5 — low-confidence stale stays review", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p4-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	const fm = mockFetch((body) => {
		if (isBatteryCall(body)) {
			const answers: Record<string, any> = {};
			for (const s of body.state.poisonSpans) {
				answers[`contra_${s.sha8}`] = { noul: 0.1 };
				answers[`stale_${s.sha8}`] = { score: 3, confidence: 0.2 }; // wrong, but LOW confidence
			}
			return { body: { answers, usage: { input_tokens: 10 } } };
		}
		return { body: {} };
	});
	try {
		await drive(handlers, "session_start", {}, ctx);
		await seedTurn(handlers, ctx, [{ text: `whatever ${DUMP}`, args: { cmd: "a" } }]);
		await nextTurn(handlers, ctx);
		await drive(handlers, "turn_end", {}, ctx);
		const last = jsonl(dir).at(-1);
		assert.equal(last.shape.poisonActed, 0, "no act on low-confidence stale (AC-24)");
		assert.equal(last.shape.poisonReview, 1, "routes to review instead");
	} finally {
		fm.restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("P4 AC-6: degraded battery capped at review — newer-same-args heuristic never acts", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p4-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	const prevEndpoint = process.env.JEV_ENDPOINT;
	process.env.JEV_ENDPOINT = "http://127.0.0.1:9/unreachable"; // every fetch fails ⇒ degraded
	const fm = mockFetch(() => ({ body: {} }));
	try {
		await drive(handlers, "session_start", {}, ctx);
		await seedTurn(handlers, ctx, [
			{ text: `older copy ${DUMP}`, args: { cmd: "same" } },
			{ text: `newer copy ${DUMP}`, args: { cmd: "same" } },
		]);
		await nextTurn(handlers, ctx);
		await drive(handlers, "turn_end", {}, ctx);
		const last = jsonl(dir).at(-1);
		assert.equal(last.poison.degraded, 1, "degradation visible (AC-6)");
		assert.equal(last.shape.poisonActed, 0, "degraded never acts (AC-6)");
		assert.ok(last.shape.poisonReview >= 1, "newer-same heuristic (contra 0.6) routes to review (>= — same-ms captures may flag both)");
		// NOTE: no view assertion — same-args spans are ALSO superseded-collapse
		// candidates for Phase-3 M3, which legitimately shapes them at the next plan;
		// the battery-level guarantee is poisonActed=0, asserted above.
	} finally {
		fm.restore();
		process.env.JEV_ENDPOINT = prevEndpoint;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("P4 AC-8/AC-22: 429 retries once then succeeds; 401 degrades with no retry", async () => {
	// 429 → retry → success
	{
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p4-"));
		const { pi, handlers } = mockPi();
		createExtension(pi);
		const { ctx } = mockCtx({ cwd: dir });
		let batteryCalls = 0; // drift/ingest calls share the mock — count battery calls only
		const fm = mockFetch((_b) => {
			if (isBatteryCall(_b)) {
				batteryCalls++;
				if (batteryCalls === 1) return { status: 429 };
				const answers: Record<string, any> = {};
				for (const s of _b.state.poisonSpans) {
					answers[`contra_${s.sha8}`] = { noul: 0.95 };
					answers[`stale_${s.sha8}`] = { score: 0, confidence: 0.9 };
				}
				return { body: { answers, usage: { input_tokens: 5 } } };
			}
			return { body: {} };
		});
		try {
			await drive(handlers, "session_start", {}, ctx);
			await seedTurn(handlers, ctx, [{ text: `${DUMP} retry-me`, args: { cmd: "a" } }]);
			await nextTurn(handlers, ctx);
			await drive(handlers, "turn_end", {}, ctx);
			assert.equal(fm.bodies.filter(isBatteryCall).length, 2, "exactly one retry after 429 (AC-8) — ≤2 battery calls total (AC-22)");
			assert.equal(jsonl(dir).at(-1).shape.poisonActed, 1, "verdicts land after retry");
		} finally {
			fm.restore();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
	// 401 → no retry, degrade
	{
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p4-"));
		const { pi, handlers } = mockPi();
		createExtension(pi);
		const { ctx } = mockCtx({ cwd: dir });
		const fm = mockFetch(() => ({ status: 401 }));
		try {
			await drive(handlers, "session_start", {}, ctx);
			await seedTurn(handlers, ctx, [{ text: `${DUMP} solo`, args: { cmd: "a" } }]);
			await nextTurn(handlers, ctx);
			await drive(handlers, "turn_end", {}, ctx);
			assert.equal(fm.bodies.filter(isBatteryCall).length, 1, "401 degrades immediately — battery call made once, NO retry (AC-8)");
			const last = jsonl(dir).at(-1);
			assert.equal(last.poison.degraded, 1);
			assert.equal(last.shape.poisonActed, 0, "degraded never acts");
		} finally {
			fm.restore();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
});

test("P4 AC-1/AC-4: battery needs an open burst; context hot path makes zero fetches", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p4-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	const fm = mockFetch(() => ({ body: {} }));
	try {
		await drive(handlers, "session_start", {}, ctx);
		// ambient turn_end: NO message_end(user) ever ran ⇒ no burst ⇒ no battery (AC-1)
		await drive(handlers, "tool_execution_end", { toolName: "bash", args: { cmd: "x" }, result: DUMP }, ctx);
		await drive(handlers, "turn_end", {}, ctx);
		assert.equal(fm.bodies.filter(isBatteryCall).length, 0, "no battery without an open burst (AC-1)");
		// now open a burst and hit the context path — zero fetches during context events (AC-4)
		await nextTurn(handlers, ctx);
		const nBefore = fm.attempts();
		await driveContext(handlers, ctx, [DUMP]);
		await driveContext(handlers, ctx, [DUMP]);
		assert.equal(fm.attempts() - nBefore, 0, "context handler performs ZERO network I/O (AC-4/AC-22)");
	} finally {
		fm.restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("P4 AC-23: re-ask suppression until freeze consumes the review metadata", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p4-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	const fm = mockFetch((body) => {
		if (isBatteryCall(body)) {
			const answers: Record<string, any> = {};
			for (const s of body.state.poisonSpans) {
				answers[`contra_${s.sha8}`] = { noul: 0.5 }; // mid-band ⇒ review
				answers[`stale_${s.sha8}`] = { score: 0, confidence: 0.9 };
			}
			return { body: { answers, usage: { input_tokens: 1 } } };
		}
		return { body: {} };
	});
	const TEXT = `${DUMP} reviewable`;
	try {
		await drive(handlers, "session_start", {}, ctx);
		await seedTurn(handlers, ctx, [{ text: TEXT, args: { cmd: "a" } }]);
		await nextTurn(handlers, ctx);
		await drive(handlers, "turn_end", {}, ctx); // battery #1: review-stamped
		await nextTurn(handlers, ctx);
		await drive(handlers, "turn_end", {}, ctx); // battery must be SUPPRESSED here
		assert.equal(fm.bodies.filter(isBatteryCall).length, 1, "live-unconsumed metadata is not re-asked (AC-23)");
		// freeze consumption: a context call during burst 3 consumes the metadata
		await nextTurn(handlers, ctx);
		await driveContext(handlers, ctx, [TEXT]);
		await drive(handlers, "turn_end", {}, ctx); // battery #2: re-ask allowed now
		assert.equal(fm.bodies.filter(isBatteryCall).length, 2, "after freeze consumption the span is re-candidated (AC-23)");
	} finally {
		fm.restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("P4 AC-9/AC-12: capture-time redaction — view shows redacted text, transcript stays raw, idempotent", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p4-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	const fm = mockFetch(() => ({ body: {} }));
	const SECRET = "api_key=sk-projT0kEnAbCdEfGh123456";
	const RAW = `config api_key=sk-projT0kEnAbCdEfGh123456 ${DUMP}`;
	try {
		await drive(handlers, "session_start", {}, ctx);
		await seedTurn(handlers, ctx, [{ text: RAW, args: { cmd: "a" } }]);
		await nextTurn(handlers, ctx); // open burst 2
		const transcript = [RAW];
		const snapshot = JSON.stringify(transcript);
		const view = await driveContext(handlers, ctx, transcript);
		const vt = viewText(view);
		assert.ok(vt.includes("[REDACTED:openai]"), "view carries the redacted form (AC-12) — sk- fires before assignment");
		assert.ok(vt.includes("sk-projT0kEnAbCdEfGh123456") === false, "view carries no raw secret");
		assert.equal(JSON.stringify(transcript), snapshot, "the transcript input is untouched (per-call view only)");
		// second call over the same raw transcript: still redacted, exactly ONE [REDACTED:openai]
		const view2 = await driveContext(handlers, ctx, transcript);
		assert.equal(viewText(view2).split("[REDACTED:openai]").length - 1, 1, "idempotent — no double redaction (AC-9)");
		const hits = jsonl(dir).at(-1).shape.redactHits;
		assert.equal(hits.openai, 1, "redaction hits counted once per span (AC-20)");
	} finally {
		fm.restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("P4 AC-11: battery state carries zero unredacted secrets (independent auditor set)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p4-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	const fm = mockFetch((body) => {
		if (isBatteryCall(body)) {
			const answers: Record<string, any> = {};
			for (const s of body.state.poisonSpans) {
				answers[`contra_${s.sha8}`] = { noul: 0.1 };
				answers[`stale_${s.sha8}`] = { score: 0, confidence: 0.9 };
			}
			return { body: { answers, usage: { input_tokens: 1 } } };
		}
		return { body: {} };
	});
	// large dump whose TEXT embeds one of every default battery class
	const SECRET = `key=sk-projT0kEnAbCdEfGh123456 id=AKIAIOSFODNN7EXAMPLE jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk auth: bearer Zx9kQ2VydGFpblNlY3JldFRva2VuMTIzNDU2Nzg= gh ghp_abc123ABCDEFghijklmnoprstuvw123456 slack xoxb-123456789-abcdef`;
	// secrets FIRST — the battery excerpt caps at excerptCap and the auditor must see them
	const RAW = `${SECRET} ${DUMP}`;
	try {
		await drive(handlers, "session_start", {}, ctx);
		await seedTurn(handlers, ctx, [{ text: RAW, args: { cmd: "a" } }]);
		await nextTurn(handlers, ctx);
		await drive(handlers, "turn_end", {}, ctx);
		const batteryBody = JSON.stringify(fm.bodies.filter(isBatteryCall).at(-1));
		// INDEPENDENT auditor patterns (not the redaction battery itself)
		assert.ok(!/sk-[A-Za-z0-9_-]{10,}/.test(batteryBody), "no openai-style key in battery state");
		assert.ok(!/AKIA[0-9A-Z]{16}/.test(batteryBody), "no AWS id in battery state");
		assert.ok(!/eyJ[A-Za-z0-9_-]{8,}\./.test(batteryBody), "no JWT in battery state");
		assert.ok(!/ghp_[A-Za-z0-9]{20,}/.test(batteryBody), "no GitHub token in battery state");
		assert.ok(!/xoxb-[0-9-]+/.test(batteryBody), "no Slack token in battery state");
		assert.ok(batteryBody.includes("[REDACTED:"), "redacted markers present instead");
	} finally {
		fm.restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("P4 AC-10/AC-13/AC-15/AC-16: error-loop collapse — format, side-car redaction, re-hydration; M3/M4 exemption", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p4-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	const fm = mockFetch(() => ({ body: {} }));
	const ERR = "ECONNREFUSED 127.0.0.1:5432\nexit code 1\ntoken=sk-secretValue123456789";
	const ERR2 = "ECONNREFUSED 127.0.0.1:5433\nexit code 1"; // different port ⇒ different signature
	try {
		await drive(handlers, "session_start", {}, ctx);
		await seedTurn(handlers, ctx, [
			{ text: ERR, isError: true, args: { cmd: "db" } },
			{ text: ERR, isError: true, args: { cmd: "db" } },
			{ text: ERR, isError: true, args: { cmd: "db" } },
			{ text: ERR2, isError: true, args: { cmd: "other" } },
		]);
		await nextTurn(handlers, ctx); // burst 2 — turn-1 errors are non-warm now
		const view = await driveContext(handlers, ctx, [ERR, ERR, ERR, ERR2]);
		const vt = viewText(view);
		// newest error kept raw; the three older identical ones collapsed to stubs
		const stubs = vt.match(/\[error-loop: bash ×3 identical failures @turn \d+; sha=[0-9a-f]{8}; \/ctx:restore [0-9a-f]{8}\]/g) ?? [];
		assert.equal(stubs.length, 2, "3 identical errors → 2 stubs (newest kept raw) (AC-13/AC-15)");
		assert.ok(!stubs.some((s) => s.includes("rerun")), "stub has NO rerun affordance (AC-15)");
		assert.ok(vt.includes("127.0.0.1:5433"), "differing-signature error untouched (selection precision)");
		// AC-10: side-car redacted even though this is an error span
		const sideCarPath = path.join(dir, ".pi", "context-elisions.jsonl");
		assert.ok(fs.existsSync(sideCarPath), "side-car written before first application (AC-33)");
		const sc = fs.readFileSync(sideCarPath, "utf8");
		assert.ok(!sc.includes("sk-secretValue123456789"), "side-car carries NO raw secret (AC-10)");
		assert.ok(sc.includes("[REDACTED:openai]"), "side-car carries the redacted marker (sk- class)");
		// battery never saw error spans (AC-14)
		assert.equal(fm.bodies.filter(isBatteryCall).length, 0, "errors are never battery candidates (AC-14)");
	} finally {
		fm.restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("P4 AC-13 E6 split: SENT error spans enqueue via M5 (queued, not applied mid-burst)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p4-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	const fm = mockFetch(() => ({ body: {} }));
	const ERR = "ECONNREFUSED 127.0.0.1:5432\nexit code 1";
	try {
		await drive(handlers, "session_start", {}, ctx);
		// turn 1: capture errors AND send them (context during burst 1 stamps sentPrefix)
		await drive(handlers, "message_end", { message: { role: "user", content: "t1" } }, ctx);
		for (let i = 0; i < 3; i++) await drive(handlers, "tool_execution_end", { toolName: "bash", args: { cmd: "db" }, result: ERR, isError: true }, ctx);
		await driveContext(handlers, ctx, [ERR, ERR, ERR]); // sent — warm anyway, no collapse yet
		await drive(handlers, "turn_end", {}, ctx);
		await new Promise((r) => setTimeout(r, 3)); // strict warm boundary
		// turn 2: errors are non-warm AND sent ⇒ collapse must QUEUE via M5, not apply
		await nextTurn(handlers, ctx);
		const view = await driveContext(handlers, ctx, [ERR, ERR, ERR]);
		await drive(handlers, "turn_end", {}, ctx); // close turn 2 — telemetry is written at turn_end
		const vt = view === undefined ? "ECONNREFUSED" : viewText(view); // undefined view = no shaping = raw content reached the model
		assert.ok(vt.includes("ECONNREFUSED"), "sent error content NOT stubbed mid-burst (E6/AC-13)");
		const last = jsonl(dir).at(-1);
		assert.equal(last.shape.dirtyDepth, 1, "ONE group op queued for the flush (AC-13 E6 split)");
		assert.equal(last.shape.errorLoopCollapsed, 2, "collapsed occurrence count = size − 1 (AC-20)");
	} finally {
		fm.restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("P4 AC-19: poison.enabled=false — no battery calls; capture redaction still runs", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p4-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	cfg(dir, { poison: { enabled: false } });
	const { ctx } = mockCtx({ cwd: dir });
	const fm = mockFetch(() => ({ body: {} }));
	const RAW = `key=sk-projT0kEnAbCdEfGh123456 ${DUMP}`;
	try {
		await drive(handlers, "session_start", {}, ctx);
		await seedTurn(handlers, ctx, [{ text: RAW, args: { cmd: "a" } }]);
		await nextTurn(handlers, ctx);
		await drive(handlers, "turn_end", {}, ctx);
		assert.equal(fm.bodies.filter(isBatteryCall).length, 0, "no battery calls when disabled (AC-19)");
		await nextTurn(handlers, ctx);
		const view = await driveContext(handlers, ctx, [RAW]);
		assert.ok(viewText(view).includes("[REDACTED:openai]"), "capture redaction STILL runs (AC-19/AC-10)");
	} finally {
		fm.restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("P4 AC-21: battery failure fails open — turn_end completes, extension stays loaded", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p4-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	const fm = mockFetch(() => {
		throw new Error("socket exploded");
	});
	try {
		await drive(handlers, "session_start", {}, ctx);
		await seedTurn(handlers, ctx, [{ text: DUMP, args: { cmd: "a" } }]);
		await nextTurn(handlers, ctx);
		await drive(handlers, "turn_end", {}, ctx); // must not throw (AC-21)
		const last = jsonl(dir).at(-1);
		assert.ok(last, "telemetry still written after battery throw (AC-21)");
		assert.equal(last.poison.degraded, 1, "throw degrades the battery");
		await nextTurn(handlers, ctx);
		const view = await driveContext(handlers, ctx, [DUMP]);
		assert.ok(view === undefined || viewText(view).includes("healthy output"), "context path unaffected after failure (AC-21/AC-34)");
	} finally {
		fm.restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("P4 AC-20: telemetry carries shape.poison counters + poison turn record", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p4-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	const fm = mockFetch((body) => {
		if (isBatteryCall(body)) {
			const answers: Record<string, any> = {};
			for (const s of body.state.poisonSpans) {
				answers[`contra_${s.sha8}`] = { noul: 0.9 };
				answers[`stale_${s.sha8}`] = { score: 1, confidence: 0.9 };
			}
			return { body: { answers, usage: { input_tokens: 77 } } };
		}
		return { body: {} };
	});
	try {
		await drive(handlers, "session_start", {}, ctx);
		await seedTurn(handlers, ctx, [{ text: DUMP, args: { cmd: "a" } }]);
		await nextTurn(handlers, ctx);
		await drive(handlers, "turn_end", {}, ctx);
		const last = jsonl(dir).at(-1);
		assert.equal(last.shape.poisonActed, 1);
		assert.equal(last.poison.inputTokens, 77, "token usage recorded (AC-3/AC-20)");
		assert.equal(last.poison.candidates, 1);
		assert.equal(last.poison.acted, 1);
	} finally {
		fm.restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ---------- M10: incident fixture replay (AC-17/AC-18) ----------
const INCIDENTS = path.join(import.meta.dirname, "incidents");
const incidentFiles = fs.existsSync(INCIDENTS) ? fs.readdirSync(INCIDENTS).filter((f) => f.endsWith(".jsonl")).sort() : [];
for (const file of incidentFiles) {
	test(`P4 AC-17 fixture replay: ${file}`, async () => {
		const lines = fs.readFileSync(path.join(INCIDENTS, file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
		const header = lines.shift();
		const spans: Array<{ text: string; isError?: boolean; args: any }> = lines.map((l, i) => ({
			text: l.text,
			isError: Boolean(l.isError),
			// fixture-declared args win (error-loop needs IDENTICAL args; contradiction
			// needs DISTINCT args to avoid Phase-3 superseded-collapse preemption)
			args: l.args ?? { cmd: `fixture-${i}` },
		}));
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p4-fix-"));
		const { pi, handlers } = mockPi();
		createExtension(pi);
		const { ctx } = mockCtx({ cwd: dir });
		const fm = mockFetch((body) => {
			if (isBatteryCall(body)) {
				const answers: Record<string, any> = {};
				for (const s of body.state.poisonSpans) {
					const ex = String(s.excerpt);
					answers[`contra_${s.sha8}`] = { noul: ex.includes("canary") ? 0.98 : 0.02 };
					answers[`stale_${s.sha8}`] = ex.includes("VERSION=1.2.3") ? { score: 2.5, confidence: 0.9 } : { score: 0, confidence: 0.9 };
				}
				return { body: { answers, usage: { input_tokens: 9 } } };
			}
			return { body: {} };
		});
		try {
			await drive(handlers, "session_start", {}, ctx);
			await seedTurn(handlers, ctx, spans);
			await nextTurn(handlers, ctx);
			await driveContext(handlers, ctx, spans.map((sp) => sp.text)); // M9/M8 fire at buildPlan (AC-13/AC-12)
			await drive(handlers, "turn_end", {}, ctx); // battery (M7) + telemetry (AC-20)
			const last = jsonl(dir).at(-1);
			assert.equal(last.shape.poisonActed, header.expect.act.length, `${file}: acted count matches fixture header`);
			assert.equal(last.shape.poisonReview, header.expect.review.length, `${file}: review count matches fixture header`);
			assert.equal(last.shape.errorLoopCollapsed, header.expect.collapse, `${file}: collapsed count matches fixture header`);
			if (header.expect.redactKinds) {
				const hits = Object.keys(last.shape.redactHits ?? {});
				for (const k of header.expect.redactKinds) assert.ok(hits.includes(k), `${file}: redaction kind ${k} recorded`);
			}
			if (header.expect.act.length > 0) {
				// act ops enqueue via the single path (AC-7): unsent → appliedShas (stubbed
				// at the next plan), sent → dirty (stubbed at flush). The turn-2 context
				// above marks spans sent, so acts ride the M5 queue — the full stub-in-view
				// contract is covered by the AC-5 wire test.
				await nextTurn(handlers, ctx);
				await driveContext(handlers, ctx, spans.map((x) => x.text));
			}
			if (file === "mixed-clean.jsonl") {
				assert.equal(last.shape.poisonActed, 0, "AC-18: zero false-positive acts on clean traffic");
			}
		} finally {
			fm.restore();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
}
