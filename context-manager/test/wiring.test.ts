// context-manager/test/wiring.test.ts — Phase-1 wire tests (spec@6540546f + v1.1.0).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.JEV_ENDPOINT = "http://127.0.0.1:9/unreachable"; // deterministic degraded mode (AC-14)

const { default: createExtension } = await import("../index.ts");

type Handler = (event: any, ctx: any) => Promise<any>;
function mockPi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const busHandlers = new Map<string, Array<(data: unknown) => void>>();
	const busEmissions: Array<{ channel: string; data: unknown }> = [];
	return {
		pi: {
			on: (e: string, h: Handler) => {
				const l = handlers.get(e) ?? [];
				l.push(h);
				handlers.set(e, l);
				return () => {};
			},
			registerCommand: (n: string, o: any) => commands.set(n, o),
			events: {
				emit: (channel: string, data: unknown) => {
					busEmissions.push({ channel, data });
					for (const h of busHandlers.get(channel) ?? []) h(data);
				},
				on: (channel: string, h: (data: unknown) => void) => {
					const l = busHandlers.get(channel) ?? [];
					l.push(h);
					busHandlers.set(channel, l);
					return () => {};
				},
			},
		} as any,
		handlers,
		commands,
		busEmissions,
	};
}
function mockCtx(opts: { cwd: string; tokens?: number }) {
	const statusSets: string[] = [];
	const statusByKey = new Map<string, string | undefined>();
	const notices: string[] = [];
	const ctx = {
		cwd: opts.cwd,
		hasUI: true,
		model: { provider: "litellm", id: "minimax" },
		ui: {
			setStatus: (k: string, v?: string) => {
				statusSets.push(v ?? "");
				statusByKey.set(k, v);
			},
			notify: (m: string) => notices.push(m),
		},
		sessionManager: { getSessionId: () => "ctx-test", getEntries: () => [] },
		getContextUsage: () => ({ tokens: opts.tokens ?? 10_000, contextWindow: 1_048_576, percent: 1 }),
		isIdle: () => true,
		hasPendingMessages: () => false,
		getSystemPrompt: () => "◐ TEST-1 [in_progress] alpha beta gamma",
		signal: undefined,
		compact: () => {},
	};
	return { ctx, statusSets, statusByKey, notices };
}
async function drive(h: Map<string, Handler[]>, e: string, ev: any, ctx: any) {
	for (const handler of h.get(e) ?? []) await handler(ev, ctx);
}
function jsonl(cwd: string): any[] {
	const f = path.join(cwd, ".pi", "context-telemetry.jsonl");
	if (!fs.existsSync(f)) return [];
	return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("AC-1: subscribes only to observe events — no context/warmer handlers", async () => {
	const { pi, handlers } = mockPi();
	createExtension(pi);
	for (const forbidden of ["context", "cache_warming_decision", "session_before_compact"]) {
		assert.equal(handlers.has(forbidden), false, `must not subscribe to ${forbidden}`);
	}
	for (const required of ["tool_execution_end", "message_end", "turn_end"]) {
		assert.ok(handlers.has(required));
	}
});

test("AC-2/AC-4: read fingerprinted once, second identical result = dup", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-"));
	const file = path.join(dir, "f.txt");
	fs.writeFileSync(file, "hello world content");
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir, tokens: 100 });
	await drive(handlers, "session_start", {}, ctx);
	const resultText = "x".repeat(500);
	await drive(handlers, "tool_execution_end", { toolName: "read", args: { path: file }, result: resultText }, ctx);
	await drive(handlers, "tool_execution_end", { toolName: "read", args: { path: file }, result: resultText }, ctx);
	await drive(handlers, "turn_end", {}, ctx);
	const lines = jsonl(dir);
	assert.equal(lines.length, 1, "one JSONL record per turn_end (AC-9)");
	const spans = lines[0].spans.filter((s: any) => s.path === file);
	assert.equal(spans.length, 2);
	assert.equal(spans[0].class, "fresh", "first copy fresh (AC-4)");
	assert.equal(spans[1].class, "dup", "second copy dup (AC-4)");
	assert.equal(spans[0].contentHash, spans[1].contentHash);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("AC-3: file touched after capture becomes stale", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-"));
	const file = path.join(dir, "f.txt");
	fs.writeFileSync(file, "v1");
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	await drive(handlers, "session_start", {}, ctx);
	await drive(handlers, "tool_execution_end", { toolName: "read", args: { path: file }, result: "v1" }, ctx);
	// touch: bump mtime past capturedAt
	const future = new Date(Date.now() + 60_000);
	fs.utimesSync(file, future, future);
	await drive(handlers, "turn_end", {}, ctx);
	const spans = jsonl(dir)[0].spans.filter((s: any) => s.path === file);
	assert.equal(spans[spans.length - 1].class, "stale", "edited-after-read = stale");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("AC-5: classification table (error / dump / conclusion)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir });
	await drive(handlers, "session_start", {}, ctx);
	await drive(handlers, "tool_execution_end", { toolName: "bash", args: {}, result: "boom" , isError: true }, ctx);
	await drive(handlers, "tool_execution_end", { toolName: "bash", args: {}, result: "y".repeat(4000) }, ctx);
	await drive(handlers, "tool_execution_end", { toolName: "bash", args: {}, result: "exit code 1\ntrace" }, ctx);
	await drive(handlers, "tool_execution_end", { toolName: "bash", args: {}, result: "done" }, ctx);
	await drive(handlers, "turn_end", {}, ctx);
	const spans = jsonl(dir)[0].spans;
	assert.equal(spans.some((s: any) => s.class === "error"), true, "isError/exit-code = error");
	assert.ok(spans.some((s: any) => s.tok === 1000 && s.class === "dup"), "dump superseded by later conclusion (spec §2.2) → dup-class");
	assert.equal(spans[spans.length - 1].class, "fresh", "tiny result = conclusion/fresh");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("AC-12/AC-14: malformed config tolerated; degraded relevance verdict on dead Jev", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-"));
	fs.mkdirSync(path.join(dir, ".pi"));
	fs.writeFileSync(path.join(dir, ".pi", "context-manager.json"), "{corrupt json!!");
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx } = mockCtx({ cwd: dir, tokens: 20_000 });
	await drive(handlers, "session_start", {}, ctx); // must not throw
	const big = "word ".repeat(12_000); // ~3000 tokens ≥ relevanceMinTokens(2000)
	await drive(handlers, "tool_execution_end", { toolName: "read", args: { path: "/tmp/x" }, result: big }, ctx);
	await drive(handlers, "tool_execution_end", { toolName: "read", args: { path: "/tmp/x" }, result: big }, ctx); // identical → memo + dup
	await drive(handlers, "turn_end", {}, ctx);
	const lines = jsonl(dir);
	const scored = lines.flatMap((l: any) => l.spans).filter((s: any) => s.verdict);
	assert.ok(scored.length >= 2, "large spans scored");
	assert.ok(scored.every((s: any) => s.source === "heuristic-degraded"), "degraded source (AC-14)");
	// AC-13 memoization: second span same hash → same verdict, no extra call possible (dead endpoint)
	assert.equal(scored[0].contentHash, scored[1].contentHash);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("status-line consolidation: ctx-suite combines bus parts with condensed health", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-suite-")); // no config → consolidate default on
	const { pi, handlers, busEmissions } = mockPi();
	createExtension(pi);
	const { ctx, statusByKey } = mockCtx({ cwd: dir });

	await drive(handlers, "session_start", {}, ctx);
	assert.ok(
		busEmissions.some((e) => e.channel === "pi-extensions:status-line" && (e.data as any).type === "renderer-hello"),
		"renderer must announce itself on session_start",
	);

	// one small fresh tool span → f100, zero shares omitted
	await drive(handlers, "tool_execution_end", { args: {}, result: "hello world", isError: false, toolName: "bash" }, ctx);
	await drive(handlers, "turn_end", {}, ctx);
	const healthOnly = statusByKey.get("ctx-suite");
	assert.ok(healthOnly, "suite rendered after turn_end");
	assert.match(healthOnly!, /^f100( CH\d+)?$/);
	assert.ok(!healthOnly!.includes("s0"), "zero shares omitted");
	assert.equal(statusByKey.get("ctx-health"), undefined, "legacy key unused in consolidated mode");

	// publisher-hello is answered with renderer-hello
	const before = busEmissions.length;
	pi.events.emit("pi-extensions:status-line", { type: "publisher-hello", source: "smart-compact" });
	assert.ok(
		busEmissions.slice(before).some((e) => (e.data as any).type === "renderer-hello"),
		"publisher-hello must be answered",
	);

	// bus status from smart-compaction joins the suite via its short text
	pi.events.emit("pi-extensions:status-line", {
		type: "status",
		source: "smart-compact",
		text: "sc 5% balanced",
		short: "sc balanced",
	});
	assert.equal(statusByKey.get("ctx-suite"), `sc balanced · ${healthOnly}`);

	// clearing a publisher removes its part
	pi.events.emit("pi-extensions:status-line", { type: "status", source: "smart-compact" });
	assert.equal(statusByKey.get("ctx-suite"), healthOnly);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("status-line consolidation off: legacy ctx-health segment, no renderer-hello", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-legacy-"));
	fs.mkdirSync(path.join(dir, ".pi"));
	fs.writeFileSync(
		path.join(dir, ".pi", "context-manager.json"),
		JSON.stringify({ statusLine: { enabled: true, consolidate: false } }),
	);
	const { pi, handlers, busEmissions } = mockPi();
	createExtension(pi);
	const { ctx, statusByKey } = mockCtx({ cwd: dir });

	await drive(handlers, "session_start", {}, ctx);
	assert.ok(
		!busEmissions.some((e) => (e.data as any).type === "renderer-hello"),
		"consolidate:false must not announce a renderer",
	);
	await drive(handlers, "tool_execution_end", { args: {}, result: "hello world", isError: false, toolName: "bash" }, ctx);
	await drive(handlers, "turn_end", {}, ctx);
	assert.match(statusByKey.get("ctx-health") ?? "", /^f:100 s:0 d:0 e:0/);
	assert.equal(statusByKey.get("ctx-suite"), undefined, "no suite segment in legacy mode");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("/ctx:health shows the status-segment legend plus the health report", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-legend-"));
	const { pi, handlers, commands } = mockPi();
	createExtension(pi);
	const { ctx, notices } = mockCtx({ cwd: dir });
	await drive(handlers, "session_start", {}, ctx);
	await drive(handlers, "tool_execution_end", { args: {}, result: "hello world", isError: false, toolName: "bash" }, ctx);

	const cmd = commands.get("ctx:health");
	assert.ok(cmd, "ctx:health command registered");
	await cmd.handler("", ctx);
	const out = notices.join("\n");
	assert.ok(out.includes("f/s/d/e = fresh/stale/dup/error"), "legend explains the share codes");
	assert.ok(out.includes("CH<n> = cache health"), "legend explains CH");
	assert.ok(out.includes("sc … = smart-compaction"), "legend explains the sc bus part");
	assert.ok(/fresh 100%/.test(out), "report still carries the shares");
	fs.rmSync(dir, { recursive: true, force: true });
});
