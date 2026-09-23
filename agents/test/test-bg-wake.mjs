// agents/test/test-bg-wake.mjs — P12 bg push-wake unit tests.
// Conventions mirror test-bg-trust.mjs: plain node, tmpdir fixtures, no runner deps.
// Covers the review-amendment regressions from agents/docs/P12_BG_PUSH_WAKE_PLAN.md.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert";
import { createBgWakeWatcher, frameBgWakeEvent, frameConsolidatedWake, sanitizeWakeField, BG_WAKE_BANNER, BG_WAKE_INDIVIDUAL_CAP } from "../lib/bg-wake.ts";

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

function tmpHome() { return mkdtempSync(path.join(tmpdir(), "p11-")); }

/** Minimal BgRunSummary factory (structurally compatible with bg-state). */
function fakeRun(runId, { done = true, status = "completed", updatedAtMs = 1 } = {}) {
	return {
		runId,
		stateDir: "/tmp/bg", runDir: `/tmp/bg/${runId}`,
		manifestPath: `/tmp/bg/${runId}/manifest.json`, resultPath: `/tmp/bg/${runId}/result.json`,
		eventsPath: `/tmp/bg/${runId}/events.jsonl`, donePath: `/tmp/bg/${runId}/done`,
		reservationPath: `/tmp/bg/${runId}/.reserved`,
		createdAtMs: 0, updatedAtMs, reserved: false, done, status,
	};
}

function harness({ runs = [], results = new Map(), sendThrows = 0 } = {}) {
	const sends = [];
	const notifs = [];
	const w = createBgWakeWatcher({
		homeDir: tmpHome(),
		listBgRuns: async () => runs.slice(),
		readBgResult: async (run) => results.get(run.runId),
		sendMessage: (message, options) => {
			if (sendThrows > 0) { sendThrows--; throw new Error("print mode"); }
			sends.push({ message, options });
		},
		notify: (m, l) => notifs.push([m, l]),
		setInterval: () => ({ unref() {} }),
		clearInterval: () => {},
	});
	return { w, sends, notifs };
}

// ── framing ──────────────────────────────────────────────────────────────

test("frameBgWakeEvent: banner + factual + status from summary + preview cap + control strip", () => {
	const run = fakeRun("bg-abc", { status: "completed" });
	const result = { version: 1, runId: "bg-abc", status: "completed", agentName: "glm-design-reviewer\x1b[31m", resultText: "line1\nline2\x00 ctrl".repeat(80) };
	const frame = frameBgWakeEvent(run, result);
	assert.ok(frame.startsWith(BG_WAKE_BANNER));
	assert.ok(frame.includes("status: completed"), "status from summary");
	assert.ok(frame.includes("agent: glm-design-reviewer"), "agent name present");
	assert.ok(!/\x1b|\x00/.test(frame), "control chars stripped");
	assert.ok(!frame.includes("line1\nline2"), "newlines collapsed in preview");
	const previewLine = frame.split("\n").find((l) => l.startsWith("preview: "));
	assert.ok(previewLine && previewLine.length <= 600 + "preview: ".length + 1, "preview capped");
	assert.ok(frame.includes("/agents bg-result bg-abc"), "pull pointer present");
});

test("frameBgWakeEvent: no preview line for empty resultText (timed-out runs)", () => {
	const frame = frameBgWakeEvent(fakeRun("bg-t", { status: "timed-out" }), { version: 1, runId: "bg-t", status: "timed-out" });
	assert.ok(!frame.includes("preview:"), "preview omitted");
	assert.ok(frame.includes("status: timed-out"));
});

test("sanitizeWakeField: undefined/empty → undefined", () => {
	assert.strictEqual(sanitizeWakeField(undefined, 10), undefined);
	assert.strictEqual(sanitizeWakeField("   \x01\x02 ", 10), undefined);
});

test("frameConsolidatedWake: lists runs, caps at 10 +1 more line, factual", () => {
	const runs = Array.from({ length: 12 }, (_, i) => fakeRun(`bg-${i}`, { status: "failed" }));
	const frame = frameConsolidatedWake(runs);
	assert.ok(frame.startsWith(BG_WAKE_BANNER));
	assert.ok(frame.includes("12 background run(s) reached completion:"));
	assert.ok(frame.includes("…and 2 more"));
	assert.ok(frame.includes("/agents bg-status"));
});

// ── baseline + missed-while-away ────────────────────────────────────────

test("start baselines ONLY done runs — in-flight run wakes on completion (kimi #1 regression)", async () => {
	const runs = [fakeRun("bg-inflight", { done: false, status: "running" })];
	const { w, sends } = harness({ runs });
	await w.start({ hasUI: true });
	assert.strictEqual(sends.length, 0, "in-flight run must not be baselined as missed");
	// completes between ticks
	runs[0] = fakeRun("bg-inflight", { done: true, status: "completed", updatedAtMs: 2 });
	await w.tick();
	assert.strictEqual(sends.length, 1, "completion wakes");
	assert.ok(sends[0].message.content.includes("bg-inflight"));
	assert.strictEqual(sends[0].options?.deliverAs, "steer");
	assert.strictEqual(sends[0].options?.triggerTurn, true);
	await w.stop();
});

test("start emits ONE consolidated nextTurn frame for missed-while-away completions", async () => {
	const runs = [fakeRun("bg-a"), fakeRun("bg-b", { status: "failed" })];
	const { w, sends, notifs } = harness({ runs });
	await w.start({ hasUI: true });
	assert.strictEqual(sends.length, 1, "single consolidated frame");
	assert.strictEqual(sends[0].options?.deliverAs, "nextTurn", "no self-start");
	assert.strictEqual(sends[0].options?.triggerTurn, undefined);
	assert.ok(sends[0].message.content.includes("2 background run(s)"));
	assert.ok(notifs.length === 1);
	await w.stop();
});

test("start with hasUI false never consumes wakes (glm #1)", async () => {
	const runs = [fakeRun("bg-headless")];
	const { w, sends } = harness({ runs });
	await w.start({ hasUI: false });
	assert.strictEqual(w.isRunning(), false);
	assert.strictEqual(sends.length, 0);
});

// ── tick semantics ──────────────────────────────────────────────────────

test("tick dedups: second tick sends nothing for the same run", async () => {
	const runs = [fakeRun("bg-once")];
	const { w, sends } = harness({ runs });
	await w.start({ hasUI: true });
	await w.tick(); // already consumed by start's baseline — nothing here either
	assert.strictEqual(sends.length, 1, "only the start-baseline frame");
	runs.push(fakeRun("bg-once2"));
	await w.tick();
	assert.strictEqual(sends.length, 2);
	await w.tick();
	assert.strictEqual(sends.length, 2, "no re-wake");
	await w.stop();
});

test("storm cap: 5 completions in one tick → 3 individual steer + 1 consolidated nextTurn", async () => {
	const runs = Array.from({ length: 5 }, (_, i) => fakeRun(`bg-s${i}`));
	const { w, sends } = harness({ runs });
	await w.start({ hasUI: true }); // baseline: these are "missed" → 1 consolidated nextTurn
	sends.length = 0;
	// fresh storm: 5 NEW completions appear
	const storm = Array.from({ length: 5 }, (_, i) => fakeRun(`bg-n${i}`));
	runs.push(...storm);
	await w.tick();
	const steer = sends.filter((s) => s.options?.triggerTurn === true);
	const next = sends.filter((s) => s.options?.deliverAs === "nextTurn");
	assert.strictEqual(steer.length, BG_WAKE_INDIVIDUAL_CAP, "3 individual wakes");
	assert.strictEqual(next.length, 1, "one consolidated tail");
	assert.ok(next[0].message.content.includes("2 background run(s)"));
	await w.stop();
});

test("mark-before-send: a throwing send loses the wake exactly once — no re-wake, tick does not throw", async () => {
	// Start with an IN-FLIGHT run so start()'s missed-frame path doesn't consume sendThrows.
	const runs = [fakeRun("bg-lost", { done: false, status: "running" })];
	const { w, sends } = harness({ runs, sendThrows: 1 });
	await w.start({ hasUI: true });
	assert.strictEqual(sends.length, 0, "in-flight: nothing sent at start");
	runs[0] = fakeRun("bg-lost", { done: true, status: "completed", updatedAtMs: 2 });
	await w.tick(); // send throws → swallowed, but run is already marked known
	assert.strictEqual(sends.length, 0, "throwing send produces no frame");
	await w.tick(); // marked → no retry, no throw
	assert.strictEqual(sends.length, 0, "no re-wake after lost send");
	await w.stop();
});

test("whole-tick isolation: listBgRuns throwing does not propagate (glm #5)", async () => {
	let boom = true;
	const sends = [];
	const w = createBgWakeWatcher({
		homeDir: tmpHome(),
		listBgRuns: async () => { if (boom) throw Object.assign(new Error("EACCES"), { code: "EACCES" }); return []; },
		sendMessage: () => {},
		setInterval: () => ({ unref() {} }),
		clearInterval: () => {},
	});
	await w.start({ hasUI: true });
	await assert.doesNotReject(() => w.tick());
	boom = false;
	await w.stop();
});

test("re-entrancy guard: overlapping ticks do not double-send", async () => {
	const runs = [];
	const sends = [];
	const w = createBgWakeWatcher({
		homeDir: tmpHome(),
		listBgRuns: async () => { await new Promise((r) => { setTimeout(r, 30); }); return runs.slice(); },
		sendMessage: (m, o) => sends.push({ message: m, options: o }),
		setInterval: () => ({ unref() {} }),
		clearInterval: () => {},
	});
	await w.start({ hasUI: true });
	runs.push(fakeRun("bg-race"));
	const t1 = w.tick(); const t2 = w.tick(); // overlap before t1's list resolves
	await Promise.all([t1, t2]);
	assert.strictEqual(sends.filter((s) => s.options?.triggerTurn).length, 1, "exactly one wake");
	await w.stop();
});

// ── watermark persistence ───────────────────────────────────────────────

async function watermarkFile(home) {
	return path.join(home, ".pi", "agent", "bg", "wake-watermark.json");
}

test("watermark: persisted, reloaded on next session, union-merges foreign disk entries", async () => {
	const home = tmpHome();
	// A foreign session marked runX on disk.
	const foreign = path.join(home, ".pi/agent/bg");
	mkdirSync(foreign, { recursive: true, mode: 0o700 });
	writeFileSync(path.join(foreign, "wake-watermark.json"), JSON.stringify({ version: 1, runIds: ["bg-foreign"] }), { mode: 0o600 });

	const runs = [fakeRun("bg-mine")];
	const sends = [];
	const w = createBgWakeWatcher({
		homeDir: home,
		listBgRuns: async () => runs.slice(),
		readBgResult: async () => undefined,
		sendMessage: () => {},
		setInterval: () => ({ unref() {} }),
		clearInterval: () => {},
	});
	await w.start({ hasUI: true }); // sees bg-foreign on disk (no frame) + bg-mine missed
	sends.length = 0;
	runs.push(fakeRun("bg-new"));
	await w.tick();
	await w.stop();
	const disk = JSON.parse(readFileSync(await watermarkFile(home), "utf8"));
	assert.ok(disk.runIds.includes("bg-foreign"), "foreign entry survives (union-merge, no clobber)");
	assert.ok(disk.runIds.includes("bg-mine"));
	assert.ok(disk.runIds.includes("bg-new"));
});

test("watermark: corrupt file → empty set, no throw; run wakes once", async () => {
	const home = tmpHome();
	const dir = path.join(home, ".pi/agent/bg");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(path.join(dir, "wake-watermark.json"), "{not json", { mode: 0o600 });
	const runs = [fakeRun("bg-corrupt")];
	const sends = [];
	const w = createBgWakeWatcher({
		homeDir: home, listBgRuns: async () => runs.slice(), sendMessage: (m, o) => sends.push({ message: m, options: o }),
		setInterval: () => ({ unref() {} }), clearInterval: () => {},
	});
	await w.start({ hasUI: true }); // treats corrupt as empty → bg-corrupt is "missed"
	await w.tick();
	assert.ok(readFileSync(await watermarkFile(home), "utf8").includes("bg-corrupt"));
	assert.strictEqual(sends.length, 1, "exactly the missed frame");
	await w.stop();
});

test("watermark: symlinked file is refused (treated as empty)", async () => {
	const home = tmpHome();
	const dir = path.join(home, ".pi/agent/bg");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const real = path.join(dir, "real.json");
	writeFileSync(real, JSON.stringify({ version: 1, runIds: ["bg-real"] }), { mode: 0o600 });
	const wmark = path.join(dir, "wake-watermark.json");
	symlinkSync(real, wmark);
	const runs = [fakeRun("bg-sym")];
	const sends = [];
	const w = createBgWakeWatcher({
		homeDir: home, listBgRuns: async () => runs.slice(), sendMessage: (m, o) => sends.push({ message: m, options: o }),
		setInterval: () => ({ unref() {} }), clearInterval: () => {},
	});
	await w.start({ hasUI: true });
	await w.stop();
	assert.ok(sends.length >= 1, "symlink not trusted as watermark; bg-sym treated as missed");
	// Persist renamed OVER the symlink: real file now, carrying our marks —
	// the attacker-controlled bg-real entry must NOT have leaked in.
	const stat = (await import("node:fs")).lstatSync(wmark);
	assert.ok(!stat.isSymbolicLink(), "watermark replaced by regular file");
	const disk = readFileSync(wmark, "utf8");
	assert.ok(disk.includes("bg-sym"), "our mark persisted");
	assert.ok(!disk.includes("bg-real"), "symlinked (untrusted) content not merged");
});

test("start with no sendMessage does not consume missed runs (kimi impl-review #1)", async () => {
	const home = tmpHome();
	const runs = [fakeRun("bg-capable")];
	// Session 1: has UI but no sendMessage (pre-P12 pi build) — must not baseline-consume.
	const sendless = createBgWakeWatcher({
		homeDir: home, listBgRuns: async () => runs.slice(),
		setInterval: () => ({ unref() {} }), clearInterval: () => {},
	});
	await sendless.start({ hasUI: true });
	await sendless.stop();
	// Session 2: capable sender on the same watermark — must still see the missed run.
	const sends = [];
	const capable = createBgWakeWatcher({
		homeDir: home, listBgRuns: async () => runs.slice(), sendMessage: (m, o) => sends.push({ message: m, options: o }),
		setInterval: () => ({ unref() {} }), clearInterval: () => {},
	});
	await capable.start({ hasUI: true });
	assert.strictEqual(sends.length, 1, "missed frame not suppressed by the sendless session");
	await capable.stop();
});

// ── run ─────────────────────────────────────────────────────────────────
for (const [name, fn] of tests) {
	try { await fn(); passed++; console.log("ok " + name); }
	catch (e) { failed++; console.log("not ok " + name + ": " + (e?.message || e)); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
