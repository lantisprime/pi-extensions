// smart-compaction/test/wiring.test.ts — wire-level regression tests (LESSON-1).
//
// Lesson (episodic-memory 20260921-223548): unit tests over lib/ cannot catch
// wiring/state-lifecycle bugs in index.ts. These tests drive the REAL handler
// map through a mock ExtensionAPI.
//
// Regression 1 (GLM-review blocker): a gate defer on the first economy
//   trigger must not wedge rt.compacting — the second agent_settled must
//   still evaluate.
// Regression 2 (design A5): session_compact_failed resets min-interval counters.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// transpile-on-the-fly is unnecessary: node strip-types handles .ts directly.
const { default: createExtension } = await import("../index.ts");

process.env.JEV_ENDPOINT = "http://127.0.0.1:9/unreachable"; // deterministic: gate falls back to heuristic

type Handler = (event: any, ctx: any) => Promise<any>;

function mockPi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const busHandlers = new Map<string, Array<(data: unknown) => void>>();
	const busEmissions: Array<{ channel: string; data: unknown }> = [];
	const pi = {
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerCommand: (name: string, opts: any) => commands.set(name, opts),
		events: {
			emit: (channel: string, data: unknown) => {
				busEmissions.push({ channel, data });
				for (const h of busHandlers.get(channel) ?? []) h(data);
			},
			on: (channel: string, handler: (data: unknown) => void) => {
				const list = busHandlers.get(channel) ?? [];
				list.push(handler);
				busHandlers.set(channel, list);
				return () => {};
			},
		},
	} as any;
	return { pi, handlers, commands, busEmissions };
}

function mockCtx(opts: {
	sessionId: string;
	cwd: string;
	tokens: number;
	systemPrompt?: string;
	entries?: unknown[];
}) {
	const statusSets: string[] = [];
	const compactCalls: any[] = [];
	const ctx = {
		cwd: opts.cwd,
		hasUI: true,
		model: { provider: "litellm", id: "minimax", cost: { input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0 } },
		ui: { setStatus: (_k: string, v?: string) => statusSets.push(v ?? ""), notify: () => {}, theme: { fg: (_a: string, s: string) => s } },
		sessionManager: {
			getSessionId: () => opts.sessionId,
			getEntries: () => opts.entries ?? [],
		},
		getContextUsage: () => ({ tokens: opts.tokens, contextWindow: 1_048_576, percent: (opts.tokens / 1_048_576) * 100 }),
		isIdle: () => true,
		hasPendingMessages: () => false,
		getSystemPrompt: () => opts.systemPrompt ?? "",
		signal: undefined,
		compact: (o: any) => {
			compactCalls.push(o);
		},
	};
	return { ctx, statusSets, compactCalls };
}

function telemetryLines(sessionId: string): any[] {
	const file = path.join(process.env.HOME ?? "/", ".pi", "agent", "cache", "smart-compaction", `telemetry-${sessionId}.jsonl`);
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

async function drive(handlers: Map<string, Handler[]>, event: string, eventObj: any, ctx: any) {
	for (const h of handlers.get(event) ?? []) await h(eventObj, ctx);
}

test("LESSON-1 regression 1: gate defer does not wedge the economy trigger", async () => {
	// sandbox config: low floor, no min-interval, tier at 30k → economy fires at 40k
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-wiring-"));
	fs.mkdirSync(path.join(dir, ".pi"));
	fs.writeFileSync(
		path.join(dir, ".pi", "smart-compaction.json"),
		JSON.stringify({
			enabled: true,
			profiles: [
				{
					match: "litellm/minimax",
					mode: "cost",
					prices: { input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0 },
					tiers: [
						{ upTo: 30_000, inputMult: 1, outputMult: 1 },
						{ upTo: 1e9, inputMult: 2, outputMult: 1.5 },
					],
					cache: { readRatio: 0.1, writePremium: 0, ttlShort: 300, ttlLong: 3600 },
					compaction: { tokenFloor: 20_000, minIntervalTurns: 0 },
					gate: { enabled: true, aggressiveBelow: 0.35, deferAbove: 0.7 },
				},
			],
		}),
	);

	const { pi, handlers } = mockPi();
	createExtension(pi);
	const sessionId = `wedge-${Date.now()}`;
	// task subject words fully present in old-context excerpt → heuristic p=1.0 → defer
	const { ctx, statusSets, compactCalls } = mockCtx({
		sessionId,
		cwd: dir,
		tokens: 40_000,
		systemPrompt: "◐ TEST-1 [in_progress] alpha beta gamma delta",
		entries: [{ type: "message", message: { role: "user", content: "alpha beta gamma delta" } }],
	});

	await drive(handlers, "session_start", {}, ctx);
	await drive(handlers, "message_end", { message: { role: "assistant", usage: { totalTokens: 40_000 } } }, ctx);
	await drive(handlers, "turn_end", {}, { ...ctx, getContextUsage: () => ({ tokens: 39_000, contextWindow: 1_048_576, percent: 4 }) });
	await drive(handlers, "turn_end", {}, ctx); // growth > 0 → economy math armed

	// first settle: economy → gate defers
	await drive(handlers, "agent_settled", {}, ctx);
	assert.equal(compactCalls.length, 0, "defer must not compact");
	assert.ok(statusSets.some((s) => s.includes("deferred")), "first settle should report defer");

	// second settle: MUST evaluate again (the reviewed blocker wedged here)
	const before = telemetryLines(sessionId).length;
	await drive(handlers, "agent_settled", {}, ctx);
	const lines = telemetryLines(sessionId).slice(before);
	assert.equal(compactCalls.length, 0, "defer again: still no compaction");
	assert.ok(
		lines.some((r) => r.event === "gate"),
		"second settle must reach the gate — wedging here is the reviewed blocker",
	);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("LESSON-1 regression 2: session_compact_failed resets min-interval counters", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-wiring2-")); // no config → defaults (minInterval 4)
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const sessionId = `failed-${Date.now()}`;
	const { ctx } = mockCtx({ sessionId, cwd: dir, tokens: 50_000 });

	await drive(handlers, "session_start", {}, ctx);
	await drive(handlers, "message_end", { message: { role: "assistant", usage: { totalTokens: 50_000 } } }, ctx);
	await drive(handlers, "turn_end", {}, ctx);
	await drive(handlers, "turn_end", {}, ctx);
	// turnsSinceCompaction is now 2 (< default 4): without reset the next settle
	// reports min-interval; design A5 requires session_compact_failed to clear it.
	await drive(handlers, "session_compact_failed", { aborted: false, errorMessage: "x" }, ctx);
	await drive(handlers, "agent_settled", {}, ctx);
	const lines = telemetryLines(sessionId);
	const lastSettle = [...lines].reverse().find((r) => r.event === "agent_settled");
	assert.ok(lastSettle, "settle recorded");
	assert.ok(
		(lastSettle.why ?? "").includes("min-interval (0/4)"),
		`counter must be reset to 0 by session_compact_failed, got: ${lastSettle.why}`,
	);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("status-line consolidation: legacy segment standalone, bus publish after renderer-hello", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-status-")); // no config → defaults
	const { pi, handlers, busEmissions } = mockPi();
	createExtension(pi);
	const { ctx, statusSets } = mockCtx({ sessionId: `status-${Date.now()}`, cwd: dir, tokens: 50_000 });
	const clears: string[] = [];
	const origSet = ctx.ui.setStatus;
	ctx.ui.setStatus = (k: string, v?: string) => {
		if (v === undefined) clears.push(k);
		origSet(k, v);
	};

	await drive(handlers, "session_start", {}, ctx);

	// handshake: publisher-hello emitted; no renderer → legacy setStatus segment
	assert.ok(
		busEmissions.some((e) => e.channel === "pi-extensions:status-line" && (e.data as any).type === "publisher-hello"),
		"session_start must emit publisher-hello",
	);
	assert.ok(
		statusSets.some((s) => /^sc \d+% /.test(s)),
		`standalone mode must render own segment, got: ${JSON.stringify(statusSets)}`,
	);
	assert.ok(
		!busEmissions.some((e) => (e.data as any).type === "status"),
		"no bus status before a renderer appears",
	);

	// renderer appears → own segment cleared, status re-published with short variant
	pi.events.emit("pi-extensions:status-line", { type: "renderer-hello" });
	assert.ok(clears.includes("smart-compact"), "renderer-hello must clear the own segment");
	const pub = busEmissions.find((e) => (e.data as any).type === "status")?.data as any;
	assert.ok(pub, "status published after renderer-hello");
	assert.equal(pub.source, "smart-compact");
	assert.match(pub.text, /^sc \d+% /);
	assert.ok(!pub.short.includes("%"), `short must drop the redundant pct, got: ${pub.short}`);

	// subsequent updates go to the bus, not the segment
	const segmentWrites = statusSets.length;
	await drive(handlers, "turn_end", {}, ctx);
	assert.equal(statusSets.length, segmentWrites, "bus mode: no further direct setStatus writes");
	fs.rmSync(dir, { recursive: true, force: true });
});
