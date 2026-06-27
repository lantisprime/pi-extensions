import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
	startBackgroundRun,
	startBackgroundPhase,
	disposeBackgroundRuns,
	__resetBackgroundRuns,
	sanitizeProgressLine,
	summarizeProgressLine,
	WIDGET_KEY,
	SPINNER_FRAMES,
	BG_RUN_CAP_MESSAGE,
	BG_RUN_MAX_CONCURRENT,
	TAIL_SLOTS,
} from "../lib/bg-run.ts";

const flush = () => new Promise((r) => setImmediate(r));

function makeUI() {
	return {
		widgets: [],
		notifies: [],
		setWidget(key, content, options) { this.widgets.push({ key, content, options }); },
		notify(message, level) { this.notifies.push({ message, level }); },
		lastWidget() { return this.widgets[this.widgets.length - 1]; },
		lastNotify() { return this.notifies[this.notifies.length - 1]; },
	};
}

function makeFakeTimer() {
	return {
		fn: undefined,
		cleared: false,
		setInterval(fn) { this.fn = fn; return { unref() {} }; },
		clearInterval() { this.cleared = true; },
		tick() { if (this.fn) this.fn(); },
	};
}

function deferred() {
	let resolve, reject;
	const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

// Header line is `${frame} ${label} · ${elapsed}s`; the frame is its first char.
function frameOf(widget) { return widget.content[0][0]; }
// Tail lines are the indented ("   ") lines after each header.
function tailLines(widget) { return widget.content.filter((l) => l.startsWith("   ")); }

// REQ-3: spinner frame advances over time.
async function testSpinnerFrameAdvances() {
	__resetBackgroundRuns();
	const ui = makeUI();
	const timer = makeFakeTimer();
	const d = deferred();
	startBackgroundRun({ ui, label: "do→reviewer", run: () => d.promise, now: () => 1000, setInterval: timer.setInterval.bind(timer), clearInterval: timer.clearInterval.bind(timer) });
	const first = frameOf(ui.lastWidget());
	timer.tick();
	const second = frameOf(ui.lastWidget());
	assert.notEqual(second, first, "spinner frame char must change across an interval tick");
	assert.ok(SPINNER_FRAMES.includes(first) && SPINNER_FRAMES.includes(second), "frames come from SPINNER_FRAMES");
	d.resolve({ message: "ok", level: "info" });
	await flush();
	__resetBackgroundRuns();
}

// REQ-4: widget shows the last <=TAIL_SLOTS activity lines, dropping the oldest as new ones arrive.
async function testTailKeepsLastNLines() {
	__resetBackgroundRuns();
	const ui = makeUI();
	const timer = makeFakeTimer();
	let handle;
	const d = deferred();
	startBackgroundRun({ ui, label: "run:scout", run: (h) => { handle = h; return d.promise; }, now: () => 0, setInterval: timer.setInterval.bind(timer), clearInterval: timer.clearInterval.bind(timer) });
	await flush(); // let run() execute so `handle` is set
	const widgetsBefore = ui.widgets.length;
	const tool = (name) => JSON.stringify({ toolName: name }); // real progress lines are JSONL
	// Push one more than the slot count so the oldest must scroll off.
	const labels = Array.from({ length: TAIL_SLOTS + 1 }, (_, i) => `t${i}`);
	for (const name of labels) handle.onProgress(tool(name));
	handle.onProgress('{"type":"message_update","assistantMessageEvent":{"type":"thinking_start"}}'); // noise → skipped
	// Throttle: onProgress updates the tail buffer but must NOT render (no setWidget flood).
	assert.equal(ui.widgets.length, widgetsBefore, "onProgress does not render per line (redraws are throttled to the interval)");
	timer.tick(); // the spinner interval renders the latest tail
	const expected = labels.slice(-TAIL_SLOTS).map((name) => `   → ${name}`); // newest TAIL_SLOTS, oldest dropped
	assert.deepEqual(tailLines(ui.lastWidget()), expected, "keeps last TAIL_SLOTS MEANINGFUL lines; oldest scrolls off; noise (thinking) is skipped");
	d.resolve({ message: "ok", level: "info" });
	await flush();
	__resetBackgroundRuns();
}

// REQ-7 / N4: sanitize strips C0, DEL, and C1 (\x9b) controls and truncates.
async function testProgressLineSanitized() {
	const rawC0 = "\x1b[2Jhello";
	const rawC1 = "\x9bdanger";
	assert.ok(rawC0.includes("\x1b"), "negative control: raw input contains ESC");
	assert.ok(rawC1.includes("\x9b"), "negative control: raw input contains C1 CSI");
	const s0 = sanitizeProgressLine(rawC0);
	const s1 = sanitizeProgressLine(rawC1);
	assert.ok(!s0.includes("\x1b"), "ESC (C0) stripped");
	assert.ok(!s1.includes("\x9b"), "C1 CSI (\\x9b) stripped");
	assert.equal(s0, "[2Jhello"); // only the control byte removed; printable chars kept
	assert.equal(sanitizeProgressLine("a".repeat(300)).length, 200, "truncated to MAX_TAIL_LINE_CHARS");
	// summarizeProgressLine routes a JSONL tool event to a short arrow line, sanitized.
	const sum = summarizeProgressLine(JSON.stringify({ toolName: "read", args: { path: "README.md" } }));
	assert.match(sum, /^→ read/);
}

// REQ-5: resolve path notifies and clears the widget once the registry empties.
async function testWidgetClearedAndNotifyOnSettle() {
	__resetBackgroundRuns();
	const ui = makeUI();
	const timer = makeFakeTimer();
	startBackgroundRun({ ui, label: "do→scout", run: () => Promise.resolve({ message: "Agent completed", level: "info" }), now: () => 0, setInterval: timer.setInterval.bind(timer), clearInterval: timer.clearInterval.bind(timer) });
	await flush();
	assert.deepEqual(ui.lastNotify(), { message: "Agent completed", level: "info" }, "result notify fires");
	assert.deepEqual(ui.lastWidget(), { key: WIDGET_KEY, content: undefined, options: undefined }, "widget cleared when registry empties");
	assert.equal(timer.cleared, true, "interval stopped when idle");
	__resetBackgroundRuns();
}

// REQ-5 / B3: reject path also notifies (error) and clears the widget.
async function testWidgetClearedOnRejectPath() {
	__resetBackgroundRuns();
	const ui = makeUI();
	const timer = makeFakeTimer();
	startBackgroundRun({ ui, label: "do→reviewer", run: () => Promise.reject(new Error("boom")), now: () => 0, setInterval: timer.setInterval.bind(timer), clearInterval: timer.clearInterval.bind(timer) });
	await flush();
	assert.equal(ui.lastNotify().level, "error", "reject path notifies at error level");
	assert.match(ui.lastNotify().message, /boom/, "error message surfaced");
	assert.deepEqual(ui.lastWidget(), { key: WIDGET_KEY, content: undefined, options: undefined }, "widget cleared on reject");
	__resetBackgroundRuns();
}

// REQ-10: the 6th concurrent run is rejected with a notify; no slot consumed.
async function testConcurrencyCapRejects() {
	__resetBackgroundRuns();
	const ui = makeUI();
	const timer = makeFakeTimer();
	const ds = [];
	for (let i = 0; i < BG_RUN_MAX_CONCURRENT; i++) {
		const d = deferred();
		ds.push(d);
		startBackgroundRun({ ui, label: `run-${i}`, run: () => d.promise, now: () => 0, setInterval: timer.setInterval.bind(timer), clearInterval: timer.clearInterval.bind(timer) });
	}
	const notifiesBefore = ui.notifies.length;
	startBackgroundRun({ ui, label: "run-overflow", run: () => deferred().promise, now: () => 0, setInterval: timer.setInterval.bind(timer), clearInterval: timer.clearInterval.bind(timer) });
	assert.equal(ui.notifies.length, notifiesBefore + 1, "the 6th run emits exactly one notify");
	assert.deepEqual(ui.lastNotify(), { message: BG_RUN_CAP_MESSAGE, level: "warning" }, "cap message at warning level");
	for (const d of ds) d.resolve({ message: "ok", level: "info" });
	await flush();
	__resetBackgroundRuns();
}

// REQ-10 / B3: a settled (rejected) run frees its slot so a later run is accepted.
async function testCapDecrementsOnReject() {
	__resetBackgroundRuns();
	const ui = makeUI();
	const timer = makeFakeTimer();
	const ds = [];
	for (let i = 0; i < BG_RUN_MAX_CONCURRENT; i++) {
		const d = deferred();
		ds.push(d);
		startBackgroundRun({ ui, label: `run-${i}`, run: () => d.promise, now: () => 0, setInterval: timer.setInterval.bind(timer), clearInterval: timer.clearInterval.bind(timer) });
	}
	ds[0].reject(new Error("died")); // one slot should free on the reject path
	await flush();
	startBackgroundRun({ ui, label: "run-after-free", run: () => deferred().promise, now: () => 0, setInterval: timer.setInterval.bind(timer), clearInterval: timer.clearInterval.bind(timer) });
	assert.equal(ui.notifies.filter((n) => n.message === BG_RUN_CAP_MESSAGE).length, 0, "no cap rejection — the freed slot was reused");
	for (let i = 1; i < ds.length; i++) ds[i].resolve({ message: "ok", level: "info" });
	await flush();
	__resetBackgroundRuns();
}

// REQ-11: shutdown clears the interval timer and the widget.
async function testShutdownClearsTimerAndWidget() {
	__resetBackgroundRuns();
	const ui = makeUI();
	const timer = makeFakeTimer();
	const d = deferred();
	startBackgroundRun({ ui, label: "do→planner", run: () => d.promise, now: () => 0, setInterval: timer.setInterval.bind(timer), clearInterval: timer.clearInterval.bind(timer) });
	disposeBackgroundRuns(ui);
	assert.equal(timer.cleared, true, "interval cleared on shutdown");
	assert.deepEqual(ui.lastWidget(), { key: WIDGET_KEY, content: undefined, options: undefined }, "widget cleared on shutdown");
	d.resolve({ message: "ok", level: "info" });
	await flush();
	__resetBackgroundRuns();
}

// REQ-2: bg-run never touches input — static guard over its own source.
async function testNoInputInterception() {
	const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "bg-run.ts"), "utf8");
	// Strip comments so the guard checks actual code, not prose that names the forbidden APIs.
	const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
	assert.equal(/onTerminalInput/.test(code), false, "bg-run must not register onTerminalInput");
	assert.equal(/\bcustom\s*\(/.test(code), false, "bg-run must not open a focus-stealing custom() overlay");
}

// P8-4: index.ts must wire disposeBackgroundRuns to session_shutdown (REQ-11 integration).
async function testIndexRegistersShutdownDispose() {
	const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.ts"), "utf8");
	assert.match(src, /on\?\.\(\s*"session_shutdown"/, "index.ts registers a session_shutdown handler");
	assert.match(src, /disposeBackgroundRuns\(/, "index.ts calls disposeBackgroundRuns on shutdown");
}

// P8-followup: a synchronous-phase spinner (e.g. intent classifier) animates then clears.
async function testPhaseSpinnerAnimatesThenClears() {
	__resetBackgroundRuns();
	const ui = makeUI();
	const timer = makeFakeTimer();
	const stop = startBackgroundPhase(ui, "routing — selecting agent…", { now: () => 0, setInterval: timer.setInterval.bind(timer), clearInterval: timer.clearInterval.bind(timer) });
	assert.ok(ui.lastWidget().content[0].includes("routing"), "phase label is shown");
	const first = frameOf(ui.lastWidget());
	timer.tick();
	assert.notEqual(frameOf(ui.lastWidget()), first, "spinner animates during the blocking phase");
	stop();
	assert.deepEqual(ui.lastWidget(), { key: WIDGET_KEY, content: undefined, options: undefined }, "phase spinner cleared on stop");
	assert.equal(timer.cleared, true, "interval stopped when idle");
	stop(); // idempotent — second call is a no-op
	__resetBackgroundRuns();
}

async function main() {
	await testPhaseSpinnerAnimatesThenClears();
	await testSpinnerFrameAdvances();
	await testTailKeepsLastNLines();
	await testProgressLineSanitized();
	await testWidgetClearedAndNotifyOnSettle();
	await testWidgetClearedOnRejectPath();
	await testConcurrencyCapRejects();
	await testCapDecrementsOnReject();
	await testShutdownClearsTimerAndWidget();
	await testNoInputInterception();
	await testIndexRegistersShutdownDispose();
	console.log("agents bg-run tests passed");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
