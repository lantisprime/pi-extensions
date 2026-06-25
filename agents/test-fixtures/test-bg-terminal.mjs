import assert from "node:assert/strict";

import {
	__resetBgTerminalBackend,
	getBgTerminalBackend,
	registerBgTerminalBackend,
} from "../lib/bg-terminal.ts";

// ── Test helpers ──────────────────────────────────────────────────────────

function fakeBackend(name = "fake") {
	const windows = new Map(); // windowId -> { runId, agentName }
	return {
		name,
		async isAvailable() { return true; },
		async launch(config) {
			windows.set(config.runId, { runId: config.runId, agentName: config.agentName });
			return { status: "ok", windowId: config.runId };
		},
		async kill(windowId) {
			if (!windowId || !windows.has(windowId)) return { status: "failed", error: "not found" };
			windows.delete(windowId);
			return { status: "ok", windowId };
		},
		async isAlive(windowId) {
			if (!windowId) return false;
			return windows.has(windowId);
		},
		async list() {
			return [...windows.entries()].map(function _a(_b) {
				var key = _b[0], val = _b[1];
				return { windowId: key, runId: val.runId, agentName: val.agentName };
			});
		},
	};
}

function reset() {
	__resetBgTerminalBackend();
}

// ── Tests ─────────────────────────────────────────────────────────────────

// 1. getBgTerminalBackend returns null before any registration
{
	reset();
	const backend = getBgTerminalBackend();
	assert.equal(backend, null, "unregistered backend should be null");
}

// 2. First registration wins
{
	reset();
	const fb = fakeBackend("first");
	registerBgTerminalBackend(fb);
	const got = getBgTerminalBackend();
	assert.equal(got, fb, "first registered backend should be returned");
	assert.equal(got.name, "first");
}

// 3. Second registration is ignored with no throw
{
	reset();
	const first = fakeBackend("first");
	const second = fakeBackend("second");
	registerBgTerminalBackend(first);
	registerBgTerminalBackend(second);
	const got = getBgTerminalBackend();
	assert.equal(got.name, "first", "second registration should be ignored");
}

// 4. Launch returns discriminated ok result
{
	const fb = fakeBackend();
	const result = await fb.launch({
		agentName: "scout",
		runId: "bg-test-1",
		manifestPath: "/tmp/manifest.json",
		cwd: "/tmp",
	});
	assert.equal(result.status, "ok");
	assert.equal(result.windowId, "bg-test-1");
}

// 5. Failed result has no windowId and has error
{
	const fb = fakeBackend();
	const result = await fb.kill("nonexistent");
	assert.equal(result.status, "failed");
	assert.equal(result.windowId, undefined);
	assert.ok(result.error, "failed result must have error");
}

// 6. isAlive returns true for launched window
{
	const fb = fakeBackend();
	const r = await fb.launch({ agentName: "a", runId: "w1", manifestPath: "/m", cwd: "/c" });
	assert.equal(await fb.isAlive(r.windowId), true);
	assert.equal(await fb.isAlive("nonexistent"), false);
}

// 7. isAlive returns false for empty windowId (exact-match contract)
{
	const fb = fakeBackend();
	assert.equal(await fb.isAlive(""), false, "empty windowId must return false");
}

// 8. isAlive returns false for foreign windowId (exact-match contract)
{
	const fb = fakeBackend();
	await fb.launch({ agentName: "a", runId: "exact-match-test", manifestPath: "/m", cwd: "/c" });
	// "exact" is a prefix of "exact-match-test" — substring match would return true
	assert.equal(await fb.isAlive("exact"), false, "prefix match must NOT count as alive");
}

// 9. Kill returns ok on success
{
	const fb = fakeBackend();
	await fb.launch({ agentName: "a", runId: "w2", manifestPath: "/m", cwd: "/c" });
	assert.equal(await fb.isAlive("w2"), true);

	const killResult = await fb.kill("w2");
	assert.equal(killResult.status, "ok");

	assert.equal(await fb.isAlive("w2"), false);
}

// 10. Kill of empty windowId fails
{
	const fb = fakeBackend();
	const result = await fb.kill("");
	assert.equal(result.status, "failed");
	assert.ok(result.error?.includes("not found"));
}

// 11. Kill of foreign windowId fails
{
	const fb = fakeBackend();
	await fb.launch({ agentName: "a", runId: "unique-id", manifestPath: "/m", cwd: "/c" });
	const result = await fb.kill("uniqu");
	assert.equal(result.status, "failed");
}

// 12. list returns structured entries with windowId, runId, agentName
{
	const fb = fakeBackend();
	await fb.launch({ agentName: "scout", runId: "bg-run-a", manifestPath: "/m", cwd: "/c" });
	await fb.launch({ agentName: "planner", runId: "bg-run-b", manifestPath: "/m", cwd: "/c" });

	const entries = await fb.list();
	assert.equal(entries.length, 2);

	// Entries carry windowId (the kill/isAlive handle)
	const ids = entries.map(function _a(e) { return e.windowId; }).sort();
	assert.deepEqual(ids, ["bg-run-a", "bg-run-b"]);

	// Entries carry runId for P4-5/P4-6 correlation
	const runs = entries.map(function _a(e) { return e.runId; }).sort();
	assert.deepEqual(runs, ["bg-run-a", "bg-run-b"]);

	// Entries carry agentName
	const names = entries.map(function _a(e) { return e.agentName; }).sort();
	assert.deepEqual(names, ["planner", "scout"]);
}

// 13. list returns empty array with zero windows
{
	const fb = fakeBackend();
	const entries = await fb.list();
	assert.ok(Array.isArray(entries));
	assert.equal(entries.length, 0);
}

// 14. isAvailable probe
{
	const fb = fakeBackend();
	assert.equal(await fb.isAvailable(), true);
}

// 15. Backend name is exposed
{
	const fb = fakeBackend("tmux");
	assert.equal(fb.name, "tmux");
}

// 16. __resetBgTerminalBackend resets state
{
	reset();
	assert.equal(getBgTerminalBackend(), null);

	registerBgTerminalBackend(fakeBackend("first"));
	assert.notEqual(getBgTerminalBackend(), null);

	reset();
	assert.equal(getBgTerminalBackend(), null);

	// After reset, a new registration works
	registerBgTerminalBackend(fakeBackend("after-reset"));
	assert.equal(getBgTerminalBackend().name, "after-reset");
}

console.log("P4-4 bg-terminal tests passed");
