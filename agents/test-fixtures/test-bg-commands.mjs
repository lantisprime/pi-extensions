// P4-5: Background agent command tests (library-level).
// Full command-handler integration tests are deferred to P4-7.

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	readBgResult,
	getBgRunPaths,
	createBgRunState,
	writeBgResult,
} from "../lib/bg-state.ts";

import {
	handleBgStop,
	handleBgOpen,
	handleBgResult,
	updateBgStatusLine,
	ensureBgStatusPolling,
	__setBgStatusHomeOverride,
	__resetBgStatusPolling,
} from "../index.ts";

import {
	__resetBgTerminalBackend,
	registerBgTerminalBackend,
} from "../lib/bg-terminal.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTempHome(fn) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "p4-5-cmds-"));
	const home = path.join(root, "home");
	try {
		return await fn(home, root);
	} finally {
		await fs.rm(root, { recursive: true, force: true }).catch(() => {});
	}
}

async function test(name, fn) {
	await fn();
	console.log(`  ✓ ${name}`);
}

// ---------------------------------------------------------------------------
// readBgResult tests
// ---------------------------------------------------------------------------

/** No result file exists → undefined. */
async function testReadBgResultNoFile() {
	await withTempHome(async (home) => {
		const paths = getBgRunPaths("bg-test-no-result", home);
		const result = await readBgResult(paths);
		assert.equal(result, undefined, "missing result file should return undefined");
	});
}

/** Empty file (not valid JSON) → undefined. */
async function testReadBgResultEmptyFile() {
	await withTempHome(async (home) => {
		const paths = await createBgRunState({ homeDir: home, runId: "bg-test-empty" });
		await fs.writeFile(paths.resultPath, "", { mode: 0o600 });
		const result = await readBgResult(paths);
		assert.equal(result, undefined, "empty result file should return undefined (not valid JSON)");
	});
}

/** Corrupt JSON → undefined. */
async function testReadBgResultCorruptJson() {
	await withTempHome(async (home) => {
		const paths = await createBgRunState({ homeDir: home, runId: "bg-test-corrupt" });
		await fs.writeFile(paths.resultPath, "not { valid json", { mode: 0o600 });
		const result = await readBgResult(paths);
		assert.equal(result, undefined, "corrupt JSON should return undefined");
	});
}

/** Valid minimal result → parsed correctly. */
async function testReadBgResultMinimal() {
	await withTempHome(async (home) => {
		const paths = await createBgRunState({ homeDir: home, runId: "bg-test-minimal" });
		const written = {
			version: 1,
			runId: "bg-test-minimal",
			status: "completed",
		};
		await writeBgResult(paths, written);

		const result = await readBgResult(paths);
		assert.ok(result, "valid result file should return a result");
		assert.equal(result.version, 1);
		assert.equal(result.runId, "bg-test-minimal");
		assert.equal(result.status, "completed");
	});
}

/** Valid complete result (with all fields) → parsed correctly. */
async function testReadBgResultFull() {
	await withTempHome(async (home) => {
		const paths = await createBgRunState({ homeDir: home, runId: "bg-test-full" });
		const written = {
			version: 1,
			runId: "bg-test-full",
			status: "failed",
			agentName: "researcher",
			startedAt: "2026-06-25T00:00:00.000Z",
			finishedAt: "2026-06-25T00:05:00.000Z",
			resultText: "found 3 bugs:\n- bug 1\n- bug 2\n- bug 3",
			error: "timeout after 300s",
		};
		await writeBgResult(paths, written);

		const result = await readBgResult(paths);
		assert.ok(result, "valid result file should return a result");
		assert.equal(result.status, "failed");
		assert.equal(result.agentName, "researcher");
		assert.equal(result.startedAt, "2026-06-25T00:00:00.000Z");
		assert.equal(result.finishedAt, "2026-06-25T00:05:00.000Z");
		assert.ok(result.resultText.includes("3 bugs"), "resultText should include the body");
		assert.equal(result.error, "timeout after 300s");
	});
}

/** Multi-line result text survives JSON round-trip. */
async function testReadBgResultMultiLineText() {
	await withTempHome(async (home) => {
		const paths = await createBgRunState({ homeDir: home, runId: "bg-test-multiline" });
		const text = "line one\nline two\n\nline four";
		await writeBgResult(paths, { version: 1, runId: "bg-test-multiline", status: "completed", resultText: text });

		const result = await readBgResult(paths);
		assert.ok(result, "valid result file should return a result");
		assert.equal(result.resultText, text, "multi-line resultText should round-trip precisely");
	});
}

/** Result written by one call is readable immediately. */
async function testReadBgResultRoundTrip() {
	await withTempHome(async (home) => {
		const paths = await createBgRunState({ homeDir: home, runId: "bg-test-roundtrip" });

		const statuses = ["running", "completed", "failed", "timed-out", "stopped"];
		let lastResult;
		for (const status of statuses) {
			await writeBgResult(paths, { version: 1, runId: "bg-test-roundtrip", status, agentName: "test" });
			lastResult = await readBgResult(paths);
			assert.ok(lastResult, `result for status '${status}' should be readable`);
			assert.equal(lastResult.status, status, `status should be '${status}'`);
		}
	});
}

// ---------------------------------------------------------------------------
// Handler-level tests (bg-stop, bg-open, bg-result)
// ---------------------------------------------------------------------------

/** Mock backend where windowId differs from runId (prefix "w-").
 *  Tests that bg-stop/bg-open correlate via list() instead of passing
 *  runId directly to kill()/isAlive(). */
function distinctWindowIdBackend() {
	const windows = new Map(); // windowId -> { runId, agentName }
	const killed = []; // windowIds passed to kill()
	const aliveChecked = []; // windowIds passed to isAlive()
	return {
		name: "distinct-window-id-backend",
		async isAvailable() { return true; },
		async launch(config) {
			const windowId = "w-" + config.runId; // deliberately different from runId
			windows.set(windowId, { runId: config.runId, agentName: config.agentName });
			return { status: "ok", windowId };
		},
		async kill(windowId) {
			killed.push(windowId);
			if (!windowId || !windows.has(windowId)) return { status: "failed", error: "not found" };
			windows.delete(windowId);
			return { status: "ok", windowId };
		},
		async isAlive(windowId) {
			aliveChecked.push(windowId);
			if (!windowId) return false;
			return windows.has(windowId);
		},
		async list() {
			return [...windows.entries()].map(([windowId, val]) => ({
				windowId,
				runId: val.runId,
				agentName: val.agentName,
			}));
		},
		// Expose inspector hooks for assertions
		_killed: killed,
		_aliveChecked: aliveChecked,
	};
}

/** Create a minimal AgentsContext stub for handler tests. */
function stubCtx(overrides = {}) {
	const notifications = [];
	return {
		ui: {
			notify(message, level) { notifications.push({ message, level }); },
		},
		_notifications: notifications,
		...overrides,
	};
}

/** bg-stop correlates runId → windowId via list() then kills correct windowId. */
async function testBgStopCorrelatesWindowId() {
	__resetBgTerminalBackend();
	const backend = distinctWindowIdBackend();
	registerBgTerminalBackend(backend);

	// Launch a run so the backend has a window to correlate.
	await backend.launch({ agentName: "test", runId: "abc123-run", manifestPath: "/m", cwd: "/c" });

	const ctx = stubCtx();
	await handleBgStop("abc123-run", ctx);

	// The kill should have been called with the windowId "w-abc123-run",
	// NOT the raw runId "abc123-run".
	assert.ok(
		backend._killed.includes("w-abc123-run"),
		"bg-stop should correlate runId → windowId and kill the correct windowId",
	);
	assert.ok(
		!backend._killed.includes("abc123-run"),
		"bg-stop must NOT pass raw runId to kill() — windowId != runId by design",
	);

	__resetBgTerminalBackend();
}

/** bg-stop handles backend.list() throwing gracefully. */
async function testBgStopBackendListThrows() {
	__resetBgTerminalBackend();
	let killCalled = false;
	const backend = {
		name: "throwy-backend",
		async isAvailable() { return true; },
		async launch() { return { status: "ok", windowId: "w1" }; },
		async kill() { killCalled = true; return { status: "ok", windowId: "x" }; },
		async isAlive() { return true; },
		async list() { throw new Error("backend unavailable"); },
	};
	registerBgTerminalBackend(backend);

	const ctx = stubCtx();
	// Should not throw — catches list() failure and falls through to reaper.
	await handleBgStop("abc123", ctx);

	// Since list() threw, kill() should never have been called.
	assert.equal(killCalled, false, "kill() must not be called when list() throws");
	// Should still notify "Stop requested" regardless.
	const lastMsg = ctx._notifications[ctx._notifications.length - 1]?.message ?? "";
	assert.ok(lastMsg.includes("Stop requested"), "should still report stop even on list failure");

	__resetBgTerminalBackend();
}

/** bg-open correlates runId → windowId via list() then calls isAlive with correct windowId. */
async function testBgOpenCorrelatesWindowId() {
	__resetBgTerminalBackend();
	const backend = distinctWindowIdBackend();
	registerBgTerminalBackend(backend);

	// Launch a run.
	await backend.launch({ agentName: "test", runId: "run-open-1", manifestPath: "/m", cwd: "/c" });

	const ctx = stubCtx();
	await handleBgOpen("run-open-1", ctx);

	// isAlive should have been called with "w-run-open-1", not "run-open-1".
	assert.ok(
		backend._aliveChecked.includes("w-run-open-1"),
		"bg-open should correlate runId → windowId and check isAlive on correct windowId",
	);
	assert.ok(
		!backend._aliveChecked.includes("run-open-1"),
		"bg-open must NOT pass raw runId to isAlive() — windowId != runId by design",
	);

	__resetBgTerminalBackend();
}

/** bg-open reports "no live terminal window" when list() has no entry for the runId. */
async function testBgOpenNotFound() {
	__resetBgTerminalBackend();
	const backend = distinctWindowIdBackend();
	registerBgTerminalBackend(backend);

	const ctx = stubCtx();
	await handleBgOpen("nonexistent-run", ctx);

	const lastMsg = ctx._notifications[ctx._notifications.length - 1]?.message ?? "";
	assert.ok(lastMsg.includes("No live terminal window"), "should report no live window for unknown runId");

	__resetBgTerminalBackend();
}

/** bg-result with a malformed runId returns a graceful warning instead of throwing. */
async function testBgResultMalformedRunId() {
	const ctx = stubCtx();

	// "abc" fails /^[A-Za-z0-9_-]{8,80}$/ — getBgRunPaths would throw.
	// The handler must catch and emit a friendly warning.
	await handleBgResult("abc", ctx);

	const lastMsg = ctx._notifications[ctx._notifications.length - 1]?.message ?? "";
	assert.ok(lastMsg.includes("Invalid run ID"), "malformed runId should emit 'Invalid run ID' warning");
	assert.ok(!lastMsg.includes("No result found"), "malformed runId must NOT reach the 'No result found' path — would mean throw escaped");
}

/** bg-result with a valid but unknown runId shows the "no result" message. */
async function testBgResultValidButUnknownRunId() {
	const ctx = stubCtx();

	// Valid format, but no run directory exists.
	await handleBgResult("a-valid-run-id-x", ctx);

	const lastMsg = ctx._notifications[ctx._notifications.length - 1]?.message ?? "";
	assert.ok(lastMsg.includes("No result found"), "valid-but-unknown runId should show 'No result found'");
}

// ── P4-6: Status line tests ──────────────────────────────────────────────

/** updateBgStatusLine clears the status when no runs are active. */
async function testStatusLineClearsWhenIdle() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "p4-6-idle-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	try {
		__setBgStatusHomeOverride(home);
		const statuses = [];
		const ctx = {
			ui: {
				setStatus(key, text) { statuses.push({ key, text }); },
			},
		};

		// Empty temp home → count should be 0 → status cleared.
		await updateBgStatusLine(ctx);

		const last = statuses[statuses.length - 1];
		assert.ok(last, "setStatus should have been called");
		assert.equal(last.key, "agents:bg-count");
		assert.equal(last.text, undefined, "status should be cleared when no agents are running");
	} finally {
		__setBgStatusHomeOverride(undefined);
		await fs.rm(root, { recursive: true, force: true }).catch(() => {});
	}
}

/** updateBgStatusLine sets a count when runs are active.  Uses a temp
 *  home dir to stay isolated from real bg-state on the developer's machine. */
async function testStatusLineShowsCount() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "p4-6-count-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	try {
		__setBgStatusHomeOverride(home);

		// Create one reserved run → count should be 1.
		const state = await createBgRunState({ homeDir: home, runId: "bg-p46-ct-01" });
		try {
			const statuses = [];
			const ctx = {
				ui: {
					setStatus(key, text) { statuses.push({ key, text }); },
				},
			};

			await updateBgStatusLine(ctx);

			const last = statuses[statuses.length - 1];
			assert.ok(last, "setStatus should have been called");
			assert.equal(last.key, "agents:bg-count");
			assert.equal(last.text, "1 agent running",
				`singular: expected '1 agent running', got: '${last.text}'`);
		} finally {
			await writeBgResult(state, { version: 1, runId: "bg-p46-ct-01", status: "stopped" });
			await fs.writeFile(path.join(state.runDir, "done"), "");
		}

		// Create two reserved runs → count should be 2.
		const s1 = await createBgRunState({ homeDir: home, runId: "bg-p46-ct-02" });
		const s2 = await createBgRunState({ homeDir: home, runId: "bg-p46-ct-03" });
		try {
			const statuses = [];
			const ctx = {
				ui: {
					setStatus(key, text) { statuses.push({ key, text }); },
				},
			};

			await updateBgStatusLine(ctx);

			const last = statuses[statuses.length - 1];
			assert.equal(last.text, "2 agents running",
				`plural: expected '2 agents running', got: '${last.text}'`);
		} finally {
			for (const s of [s1, s2]) {
				await writeBgResult(s, { version: 1, runId: s.runDir.split(path.sep).pop() ?? "x", status: "stopped" });
				await fs.writeFile(path.join(s.runDir, "done"), "");
			}
		}
	} finally {
		__setBgStatusHomeOverride(undefined);
		await fs.rm(root, { recursive: true, force: true }).catch(() => {});
	}
}

/** updateBgStatusLine silently no-ops when setStatus is unavailable. */
async function testStatusLineNoOpWithoutSetStatus() {
	// Should not throw on ctx without setStatus
	await updateBgStatusLine({ ui: {} });
}

// ── P4-6: Poll timer tests ───────────────────────────────────────────────

/** ensureBgStatusPolling creates a timer when setStatus is available. */
async function testPollingCreatesTimer() {
	__resetBgStatusPolling();
	const ctx = { ui: { setStatus() {} } };

	// Should not throw — creates a real setInterval.
	ensureBgStatusPolling(ctx);

	__resetBgStatusPolling();
}

/** ensureBgStatusPolling no-ops when setStatus is unavailable. */
async function testPollingNoOpWithoutSetStatus() {
	__resetBgStatusPolling();

	// Should not throw and should not create a timer.
	ensureBgStatusPolling({ ui: {} });
	ensureBgStatusPolling({});
	ensureBgStatusPolling(null);

	__resetBgStatusPolling();
}

/** ensureBgStatusPolling restarts an existing timer (restart-race defense). */
async function testPollingRestartsExistingTimer() {
	__resetBgStatusPolling();
	const ctx = { ui: { setStatus() {} } };

	// First call creates a timer.
	ensureBgStatusPolling(ctx);
	// Second call should clear old + create new without errors.
	ensureBgStatusPolling(ctx);
	// Third call — same, verifies idempotent restart.
	ensureBgStatusPolling(ctx);

	__resetBgStatusPolling();
}

/** __resetBgStatusPolling cleans module-level state so a fresh call works. */
async function testResetCleansState() {
	const ctx = { ui: { setStatus() {} } };

	// Setup: create a timer, then reset.
	__resetBgStatusPolling();
	ensureBgStatusPolling(ctx);
	__resetBgStatusPolling();

	// After reset, another call should work (timer was cleared).
	ensureBgStatusPolling(ctx);
	__resetBgStatusPolling();

	// After second reset, a third call should work.
	ensureBgStatusPolling(ctx);
	__resetBgStatusPolling();
}

async function main() {
	console.log("P4-5 bg-commands tests");
	await test("readBgResult: no file → undefined", testReadBgResultNoFile);
	await test("readBgResult: empty file → undefined", testReadBgResultEmptyFile);
	await test("readBgResult: corrupt JSON → undefined", testReadBgResultCorruptJson);
	await test("readBgResult: minimal result parsed", testReadBgResultMinimal);
	await test("readBgResult: full result parsed", testReadBgResultFull);
	await test("readBgResult: multi-line text round-trip", testReadBgResultMultiLineText);
	await test("readBgResult: status sequence round-trip", testReadBgResultRoundTrip);
	await test("bg-stop: correlates runId → windowId via list()", testBgStopCorrelatesWindowId);
	await test("bg-stop: survives backend.list() throwing", testBgStopBackendListThrows);
	await test("bg-open: correlates runId → windowId via list()", testBgOpenCorrelatesWindowId);
	await test("bg-open: reports no window for unknown runId", testBgOpenNotFound);
	await test("bg-result: malformed runId → graceful warning", testBgResultMalformedRunId);
	await test("bg-result: valid unknown runId → 'No result found'", testBgResultValidButUnknownRunId);
	await test("P4-6: status line clears when idle", testStatusLineClearsWhenIdle);
	await test("P4-6: status line shows running agent count", testStatusLineShowsCount);
	await test("P4-6: status line no-ops without setStatus", testStatusLineNoOpWithoutSetStatus);
	await test("P4-6: polling creates timer", testPollingCreatesTimer);
	await test("P4-6: polling no-ops without setStatus", testPollingNoOpWithoutSetStatus);
	await test("P4-6: polling restarts existing timer", testPollingRestartsExistingTimer);
	await test("P4-6: reset cleans polling state", testResetCleansState);
	console.log("P4-5 bg-commands tests passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
