// context-manager/test/shape.wiring.test.ts — Phase-3 wire tests (spec-phase3.md@56e0c00a).
// Pattern per AGENTS.md: wiring bugs get wiring tests (wiring.test.ts harness).
// Turn semantics honored: a dump SENT in a prior turn ⇒ queued (AC-9); a dump never
// sent ⇒ stubbed immediately (AC-8); rescore is async ⇒ eviction visible the burst
// after it settles; the bypass discriminator is the shape.bypassed counter.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.JEV_ENDPOINT = "http://127.0.0.1:9/unreachable"; // deterministic degraded mode

const { default: createExtension } = await import("../index.ts");

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
function mockCtx(opts: { cwd: string; tokens?: number }) {
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
		sessionManager: { getSessionId: () => "shape-test", getEntries: () => [] },
		getContextUsage: () => ({ tokens: opts.tokens ?? 10_000, contextWindow: 1_048_576, percent: 1 }),
		isIdle: () => true,
		hasPendingMessages: () => false,
		getSystemPrompt: () => "◐ TEST-1 [in_progress] alpha beta gamma",
		signal: undefined,
		compact: (o: { customInstructions: string }) => {
			compactCalls.push(o.customInstructions);
		},
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
	if (!fs.existsSync(f)) return [];
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
function cfg(dir: string, obj: Record<string, unknown>): void {
	fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".pi", "context-manager.json"), JSON.stringify(obj));
}
const NOCOMPACT = { purityBudget: { budget: 0.9, hardMultiplier: 2 } };

const DUMP = "d".repeat(3400); // ~850 tok ≥ dumpTokens(800)
const BIGPAD = "u".repeat(40_000); // ~10k tok — widens the evict-cap denominator

interface TurnOpts {
	user: string;
	results?: Array<{ id: string; text: string; toolName?: string; isError?: boolean }>;
	call?: boolean; // drive the context (LLM call) hook — default true
	extraMessages?: any[]; // appended to the context input
}
/** Full turn: user msg → tool results → (one LLM call) → assistant → turn_end. */
async function runTurn(h: Map<string, Handler[]>, ctx: any, opts: TurnOpts): Promise<any> {
	await rest();
	await drive(h, "message_end", { message: userMsg(opts.user) }, ctx);
	for (const r of opts.results ?? []) {
		await drive(h, "tool_execution_end", { toolName: r.toolName ?? "bash", args: { cmd: "x" }, result: r.text, isError: r.isError ?? false }, ctx);
	}
	let out: any;
	if (opts.call !== false) {
		const messages = [userMsg("prior"), asstMsg("t0"), toolMsg("t0", "old small result"), userMsg(opts.user)];
		for (const r of opts.results ?? []) messages.push(asstMsg(r.id), toolMsg(r.id, r.text, r.toolName ?? "bash", r.isError));
		messages.push(...(opts.extraMessages ?? []));
		out = await drive(h, "context", { type: "context", messages }, ctx);
	}
	await drive(h, "message_end", { message: asstMsg("a1") }, ctx);
	await drive(h, "turn_end", {}, ctx);
	return out;
}
const rest = (): Promise<void> => new Promise((r) => setTimeout(r, 3)); // burst-open must not share a ms with prior captures
function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "cm-shape-"));
}

test("P3-AC-1/E5/AC-8: unsent dup stubs immediately; per-call view; transcript byte-identical", async () => {
	const dir = tmpDir();
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	cfg(dir, NOCOMPACT);
	await drive(handlers, "session_start", {}, ctx);
	await runTurn(handlers, ctx, { user: "turn one", results: [{ id: "t1", text: DUMP }, { id: "t2", text: DUMP }], call: false }); // never sent
	await rest();
	await drive(handlers, "message_end", { message: userMsg("burst two") }, ctx); // opens burst 2
	const messages = [userMsg(BIGPAD), asstMsg("t1"), toolMsg("t1", DUMP), userMsg("next")];
	const snapshot = JSON.stringify(messages);
	const out = await drive(handlers, "context", { type: "context", messages }, ctx);
	assert.notEqual(out, undefined, "handler returned a shaped view");
	assert.notEqual(out.messages, messages, "view is a NEW array (E1 clone semantics)");
	assert.equal(JSON.stringify(messages), snapshot, "input transcript byte-identical (E5/AC-1)");
	assert.ok(JSON.stringify(out.messages).includes("[shaped:"), "unsent dup stubbed immediately (AC-8)");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("P3-AC-6+35: frozen plan — two calls in one burst produce identical views, no double-stub", async () => {
	const dir = tmpDir();
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	cfg(dir, NOCOMPACT);
	await drive(handlers, "session_start", {}, ctx);
	await runTurn(handlers, ctx, { user: "warm", results: [{ id: "t1", text: DUMP }, { id: "t2", text: DUMP }], call: false });
	await rest();
	await drive(handlers, "message_end", { message: userMsg("burst two") }, ctx);
	const mk = () => [userMsg(BIGPAD), asstMsg("t1"), toolMsg("t1", DUMP), userMsg("next")];
	const out1 = await drive(handlers, "context", { type: "context", messages: mk() }, ctx);
	const out2 = await drive(handlers, "context", { type: "context", messages: mk() }, ctx);
	assert.notEqual(out1, undefined);
	assert.equal(JSON.stringify(out1.messages), JSON.stringify(out2.messages), "AC-6: identical application across burst calls");
	assert.equal(JSON.stringify(out1.messages).split("[shaped:").length - 1, 1, "AC-35: no double-stub");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("P3-AC-7: content appended mid-burst appears unshaped until next burst", async () => {
	const dir = tmpDir();
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	cfg(dir, NOCOMPACT);
	await drive(handlers, "session_start", {}, ctx);
	await runTurn(handlers, ctx, { user: "warm", results: [{ id: "t1", text: DUMP }, { id: "t2", text: DUMP }], call: false });
	await rest();
	await drive(handlers, "message_end", { message: userMsg("burst two") }, ctx);
	const base = [userMsg(BIGPAD), asstMsg("t1"), toolMsg("t1", DUMP), userMsg("next")];
	const out1 = await drive(handlers, "context", { type: "context", messages: base }, ctx);
	const mid = [...base, asstMsg("t7"), toolMsg("t7", DUMP)];
	const out2 = await drive(handlers, "context", { type: "context", messages: mid }, ctx);
	assert.ok(JSON.stringify(out1.messages).includes("[shaped:"), "burst opener shapes the dup");
	const appended = out2.messages[out2.messages.length - 2];
	assert.ok(!JSON.stringify(appended).includes("[shaped:"), "AC-7: mid-burst append unshaped in view 2");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("P3-AC-9+24+23: sent dup queues; cap flush at turn_end; baseline applies next burst", async () => {
	const dir = tmpDir();
	fs.mkdirSync(path.join(dir, ".pi"));
	cfg(dir, { ...NOCOMPACT, dirtyQueue: { maxEntries: 1, maxTok: 1 } });
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	await drive(handlers, "session_start", {}, ctx);
	await runTurn(handlers, ctx, { user: BIGPAD, results: [{ id: "t1", text: DUMP }] }); // turn 1: sent fresh (not eligible)
	await runTurn(handlers, ctx, { user: BIGPAD, results: [{ id: "t1", text: DUMP }] }); // turn 2: dup ⇒ queued; cap ⇒ flush
	const t2 = jsonl(dir).at(-1);
	assert.ok(t2.shape.flushed >= 1, "AC-24: cap (1 entry) forces flush at turn_end");
	assert.equal(t2.shape.lastFlush.trigger, "cap");
	const out = await runTurn(handlers, ctx, { user: BIGPAD, results: [{ id: "t1", text: DUMP }] }); // turn 3
	assert.ok(JSON.stringify(out?.messages ?? "").includes("[shaped:"), "flushed op applies in next burst (baseline)");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("P3-AC-29: shaping flush XOR M3 — floor breach flushes; compact NOT called", async () => {
	const dir = tmpDir();
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx, compactCalls } = mockCtx({ cwd: dir });
	cfg(dir, NOCOMPACT);
	await drive(handlers, "session_start", {}, ctx);
	await runTurn(handlers, ctx, { user: BIGPAD, results: [{ id: "t1", text: DUMP }] });
	await runTurn(handlers, ctx, { user: BIGPAD, results: [{ id: "t1", text: DUMP }] }); // dup ⇒ purity high; dirty=1 ⇒ floor flush
	const last = jsonl(dir).at(-1);
	assert.ok(last.shape.flushed >= 1, "floor flush fired");
	assert.equal(compactCalls.length, 0, "AC-29: XOR — no compact on a shaping-flush turn");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("P3-AC-14: B1 — read-tool dumps are never shaped", async () => {
	const dir = tmpDir();
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	cfg(dir, NOCOMPACT);
	await drive(handlers, "session_start", {}, ctx);
	await runTurn(handlers, ctx, { user: "warm", results: [{ id: "t1", text: DUMP, toolName: "read" }, { id: "t2", text: DUMP, toolName: "read" }], call: false });
	await rest();
	await drive(handlers, "message_end", { message: userMsg("burst two") }, ctx);
	const out = await drive(handlers, "context", { type: "context", messages: [userMsg(BIGPAD), asstMsg("t1"), toolMsg("t1", DUMP, "read"), userMsg("n")] }, ctx);
	assert.ok(!JSON.stringify(out ?? "").includes("[shaped:"), "B1: read results never shaped");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("P3-AC-16: error results are never shaped", async () => {
	const dir = tmpDir();
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	cfg(dir, NOCOMPACT);
	await drive(handlers, "session_start", {}, ctx);
	await runTurn(handlers, ctx, { user: "warm", results: [{ id: "t1", text: DUMP, isError: true }, { id: "t2", text: DUMP, isError: true }], call: false });
	await rest();
	await drive(handlers, "message_end", { message: userMsg("burst two") }, ctx);
	const out = await drive(handlers, "context", { type: "context", messages: [userMsg(BIGPAD), asstMsg("t1"), toolMsg("t1", DUMP, "bash", true), userMsg("n")] }, ctx);
	assert.ok(!JSON.stringify(out ?? "").includes("[shaped:"), "errors never shaped");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("P3-AC-15: current-burst dump is never shaped (warm)", async () => {
	const dir = tmpDir();
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	cfg(dir, NOCOMPACT);
	await drive(handlers, "session_start", {}, ctx);
	const out = await runTurn(handlers, ctx, { user: BIGPAD, results: [{ id: "t1", text: DUMP }, { id: "t2", text: DUMP }] });
	assert.ok(!JSON.stringify(out ?? "").includes("[shaped:"), "AC-15: same-burst dump stays warm in view");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("P3-AC-20: drifted rescored-unrelated span flushes and stubs next burst", async () => {
	const dir = tmpDir();
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	cfg(dir, NOCOMPACT);
	await drive(handlers, "session_start", {}, ctx);
	const unrelated = "zz9x ".repeat(2000); // ~875 tok ≥ dump floor, zero overlap with tasks
	const ctxMsgs = () => [userMsg(BIGPAD), asstMsg("t1"), toolMsg("t1", unrelated), userMsg("n")];
	await runTurn(handlers, ctx, { user: BIGPAD, results: [{ id: "t1", text: unrelated }] }); // t1: sent
	(ctx as any).getSystemPrompt = () => "◐ TEST-2 [in_progress] brand new topic"; // deterministic diff ⇒ drift
	await runTurn(handlers, ctx, { user: "switch to the new topic entirely", results: [], extraMessages: [asstMsg("t1"), toolMsg("t1", unrelated)] }); // t2: staged
	await runTurn(handlers, ctx, { user: "keep going", results: [], extraMessages: [asstMsg("t1"), toolMsg("t1", unrelated)] }); // t3: staged applied + rescore (degraded ⇒ unrelated)
	await rest();
	await drive(handlers, "message_end", { message: userMsg("burst 4") }, ctx);
	await drive(handlers, "context", { type: "context", messages: ctxMsgs() }, ctx); // burst 4: unrelated+rescored+sent ⇒ queued (AC-9)
	await drive(handlers, "turn_end", {}, ctx); // purity ⇒ floor flush (dirty=1)
	await rest();
	await drive(handlers, "message_end", { message: userMsg("burst 5") }, ctx);
	const out = await drive(handlers, "context", { type: "context", messages: ctxMsgs() }, ctx); // burst 5: baseline stub
	assert.ok(JSON.stringify(out?.messages ?? "").includes("[shaped:"), "AC-20: rescored-unrelated span evicted in view");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("P3-AC-33: side-car holds the full text before any stub applies", async () => {
	const dir = tmpDir();
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	cfg(dir, NOCOMPACT);
	await drive(handlers, "session_start", {}, ctx);
	await runTurn(handlers, ctx, { user: "warm", results: [{ id: "t1", text: DUMP }, { id: "t2", text: DUMP }], call: false });
	await rest();
	await drive(handlers, "message_end", { message: userMsg("burst two") }, ctx);
	await drive(handlers, "context", { type: "context", messages: [userMsg(BIGPAD), asstMsg("t1"), toolMsg("t1", DUMP), userMsg("n")] }, ctx);
	const sideCar = path.join(dir, ".pi", "context-elisions.jsonl");
	assert.ok(fs.existsSync(sideCar), "side-car file exists");
	const rows = fs.readFileSync(sideCar, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	const shapeRows = rows.filter((r) => r.kind === "shape");
	assert.ok(shapeRows.length >= 1, "shape record written");
	assert.ok(shapeRows.every((r) => r.text === DUMP), "full text archived, untruncated");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("P3-AC-30: forced-prompt bypass while compacting; lifted at next user turn (bypassed counter)", async () => {
	const dir = tmpDir();
	fs.mkdirSync(path.join(dir, ".pi"));
	fs.writeFileSync(path.join(dir, ".pi", "context-manager.json"), JSON.stringify({ purityBudget: { budget: 0.01, hardMultiplier: 1 } }));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx, compactCalls } = mockCtx({ cwd: dir });
	await drive(handlers, "session_start", {}, ctx);
	// read dups drive purity high but B1 keeps the dirty queue empty ⇒ no XOR conflict ⇒ hard compact
	await runTurn(handlers, ctx, { user: "warm", results: [{ id: "t1", text: DUMP, toolName: "read" }, { id: "t2", text: DUMP, toolName: "read" }] });
	assert.equal(compactCalls.length, 1, "hard compact fired (M3)");
	// still compacting (cleared only at message_end(user)): context ⇒ bypass
	const msgs = () => [userMsg(BIGPAD), asstMsg("t9"), toolMsg("t9", DUMP), userMsg("n")];
	const out1 = await drive(handlers, "context", { type: "context", messages: msgs() }, ctx);
	assert.equal(out1, undefined, "AC-30: bypass while compacting");
	await runTurn(handlers, ctx, { user: "clears compacting", results: [], extraMessages: [asstMsg("t9"), toolMsg("t9", DUMP)] });
	const bypassedMid = jsonl(dir).filter((l) => l.shape).map((l) => l.shape.bypassed).at(-1);
	assert.ok(bypassedMid >= 1, "bypass counted while compacting");
	const out2 = await drive(handlers, "context", { type: "context", messages: msgs() }, ctx); // burst open ⇒ normal path
	const bypassedAfter = jsonl(dir).at(-1)?.shape?.bypassed ?? 0;
	assert.equal(bypassedAfter, bypassedMid, "bypass counter flat after the next user turn (normal path)");
	assert.equal(out2, undefined, "dump sent in a prior turn ⇒ queued (AC-9), not bypassed silently");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("P3-AC-43+42: malformed shaping config falls back; defaults still shape", async () => {
	const dir = tmpDir();
	fs.mkdirSync(path.join(dir, ".pi"));
	cfg(dir, { ...NOCOMPACT, shaping: { qualityFloor: "big", cacheTtlMin: "soon" } });
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	await drive(handlers, "session_start", {}, ctx); // must not throw
	await runTurn(handlers, ctx, { user: "warm", results: [{ id: "t1", text: DUMP }, { id: "t2", text: DUMP }], call: false });
	await rest();
	await drive(handlers, "message_end", { message: userMsg("burst two") }, ctx);
	const out = await drive(handlers, "context", { type: "context", messages: [userMsg(BIGPAD), asstMsg("t1"), toolMsg("t1", DUMP), userMsg("n")] }, ctx);
	assert.ok(JSON.stringify(out ?? "").includes("[shaped:"), "defaults applied, shaping works (AC-42/43)");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("P3-AC-44: shaping disabled — no view, no shape telemetry", async () => {
	const dir = tmpDir();
	fs.mkdirSync(path.join(dir, ".pi"));
	fs.writeFileSync(path.join(dir, ".pi", "context-manager.json"), JSON.stringify({ shaping: { enabled: false } }));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	await drive(handlers, "session_start", {}, ctx);
	await runTurn(handlers, ctx, { user: "warm", results: [{ id: "t1", text: DUMP }, { id: "t2", text: DUMP }] });
	const out = await drive(handlers, "context", { type: "context", messages: [userMsg(BIGPAD), asstMsg("t9"), toolMsg("t9", DUMP), userMsg("n")] }, ctx);
	assert.equal(out, undefined, "AC-44: disabled ⇒ no view");
	const last = jsonl(dir).at(-1);
	assert.equal(last.shape, undefined, "AC-44: no shape telemetry when disabled");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("P3-E4: shaped view preserves toolCall/toolResult adjacency (A1/A2/A3)", async () => {
	const dir = tmpDir();
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	cfg(dir, NOCOMPACT);
	await drive(handlers, "session_start", {}, ctx);
	await runTurn(handlers, ctx, { user: "warm", results: [{ id: "t1", text: DUMP }, { id: "t2", text: DUMP }], call: false });
	await rest();
	await drive(handlers, "message_end", { message: userMsg("burst two") }, ctx);
	const out = await drive(handlers, "context", { type: "context", messages: [userMsg(BIGPAD), asstMsg("t1"), toolMsg("t1", DUMP), userMsg("n")] }, ctx);
	assert.notEqual(out, undefined);
	const calls = new Set<string>();
	for (const m of out.messages) {
		if (m.role === "assistant") for (const c of m.content) if (c.type === "toolCall" && c.id) calls.add(c.id);
	}
	for (const m of out.messages) {
		if (m.role === "toolResult") {
			assert.ok(calls.has(m.toolCallId), "A2: every surviving result's call is present");
			calls.delete(m.toolCallId);
		}
	}
	assert.equal(calls.size, 0, "A1: every surviving call has its result");
	const lastRole = out.messages.at(-1).role;
	assert.ok(lastRole === "user" || lastRole === "toolResult", "A3: last message converts to user|toolResult");
	fs.rmSync(dir, { recursive: true, force: true });
});
