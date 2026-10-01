// context-manager/test/compact-floor.wiring.test.ts — CTX-FIX regression.
// triggerCompact must skip ctx.compact() when st.lastPromptTokens is a positive
// measurement below COMPACT_MIN_TOKENS (24k): pi rejects with
// "Compaction failed: Nothing to compact (session too small)" below its
// keepRecent budget + margin. See .plans/CONTEXT/spec-phase2.md Amendments.
// Helper pattern: test/wiring-phase2-m3.test.ts (mockPi / drive / seedHard).
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
function mockCtx(opts: { cwd: string }) {
	const compactCalls: Array<{ customInstructions?: string } | undefined> = [];
	const ctx = {
		cwd: opts.cwd,
		hasUI: true,
		model: { provider: "litellm", id: "minimax" },
		ui: { setStatus: () => {}, notify: () => {} },
		sessionManager: { getSessionId: () => "ctx-floor-test", getEntries: () => [] },
		getContextUsage: () => ({ tokens: 10_000, contextWindow: 1_048_576, percent: 1 }),
		isIdle: () => true,
		hasPendingMessages: () => false,
		getSystemPrompt: () => "◐ TEST-1 [in_progress] alpha subject one",
		signal: undefined,
		compact: (o: { customInstructions: string }) => {
			compactCalls.push(o);
		},
	};
	return { ctx, compactCalls };
}
async function drive(h: Map<string, Handler[]>, e: string, ev: any, ctx: any) {
	for (const handler of h.get(e) ?? []) await handler(ev, ctx);
}
async function runTools(h: Map<string, Handler[]>, ctx: any, items: Array<{ text: string; toolName?: string }>) {
	for (const it of items) {
		await drive(h, "tool_execution_end", { toolName: it.toolName ?? "bash", args: {}, result: it.text }, ctx);
	}
}
// Drives message_end(assistant) with a usage payload — this is what sets
// st.lastPromptTokens (input + cacheRead + cacheWrite).
async function assistantUsage(h: Map<string, Handler[]>, ctx: any, totalTokens: number) {
	return drive(
		h,
		"message_end",
		{ message: { role: "assistant", content: "done", usage: { input: totalTokens - 100, cacheRead: 100, cacheWrite: 0 } } },
		ctx,
	);
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
const FILLER_HARD = "FILLER ".repeat(1144); // 2002 tok, relevant — p ≈ 0.51 (hard tier)
const smalls = (n: number) => Array.from({ length: n }, () => ({ text: "ok" }));
// Hard-tier seed WITHOUT turn_end — purity ≈ 0.51 ≥ 2×0.15 when turn_end fires.
async function seedHardTools(h: Map<string, Handler[]>, ctx: any) {
	await runTools(h, ctx, [{ text: FILLER_HARD }, ...smalls(22), { text: A_TXT }]);
}

test("CTX-FIX: hard purity excess below token floor does NOT call ctx.compact", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-floor-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx, compactCalls } = mockCtx({ cwd: dir });
	const { restore } = ingestAware();
	try {
		await drive(handlers, "session_start", {}, ctx);
		await seedHardTools(handlers, ctx);
		await assistantUsage(handlers, ctx, 1_000); // lastPromptTokens = 1000 < 24k floor
		await drive(handlers, "turn_end", {}, ctx);
		assert.equal(compactCalls.length, 0, "compact skipped: session below COMPACT_MIN_TOKENS");
		// Skip must not start cooldown or mutate the ledger: the same excess
		// re-evaluates cleanly once the session grows past the floor.
		await assistantUsage(handlers, ctx, 30_000); // now above floor
		await drive(handlers, "turn_end", {}, ctx);
		assert.equal(compactCalls.length, 1, "floor is not a permanent block — compacts once above floor");
		assert.equal(compactCalls[0]?.customInstructions, "drop unrelated/dup/stale content", "B4 locked instructions");
	} finally {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("CTX-FIX: hard purity excess above token floor still compacts (fail-open when usage unknown)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-floor-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx, compactCalls } = mockCtx({ cwd: dir });
	const { restore } = ingestAware();
	try {
		await drive(handlers, "session_start", {}, ctx);
		await seedHardTools(handlers, ctx);
		// NO assistantUsage: st.lastPromptTokens stays null ⇒ guard fails open,
		// preserving pre-CTX-FIX behavior (usage-less providers still compact).
		await drive(handlers, "turn_end", {}, ctx);
		assert.equal(compactCalls.length, 1, "fail-open: unknown tokens never block the compact");
	} finally {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
