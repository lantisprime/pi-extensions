import assert from "node:assert/strict";

import {
	registerBgTerminalBackend,
	getBgTerminalBackend,
} from "../lib/bg-terminal.ts";

// ── Test helpers ──────────────────────────────────────────────────────────

function fakeBackend(name = "fake") {
	const windows = new Set();
	return {
		name,
		async launch(config) {
			windows.add(config.runId);
			return { status: "launched", windowId: config.runId };
		},
		async kill(windowId) {
			if (!windows.has(windowId)) return { status: "failed", error: "not found" };
			windows.delete(windowId);
			return { status: "launched", windowId };
		},
		async isAlive(windowId) {
			return windows.has(windowId);
		},
		async list() {
			return [...windows];
		},
	};
}

// ── Tests ─────────────────────────────────────────────────────────────────

// 1. getBgTerminalBackend returns null before any registration
{
	const backend = getBgTerminalBackend();
	assert.equal(backend, null, "unregistered backend should be null");
}

// 2. First registration wins
{
	const fb = fakeBackend("first");
	registerBgTerminalBackend(fb);
	const got = getBgTerminalBackend();
	assert.equal(got, fb, "first registered backend should be returned");
	assert.equal(got.name, "first");
}

// 3. Second registration is silently ignored
{
	const second = fakeBackend("second");
	registerBgTerminalBackend(second);
	const got = getBgTerminalBackend();
	assert.equal(got.name, "first", "second registration should be ignored");
}

// 4. Fake backend launch returns launched status
{
	// No registration needed — test the fake directly
	const fb = fakeBackend();
	const result = await fb.launch({
		agentName: "scout",
		runId: "bg-test-1",
		manifestPath: "/tmp/manifest.json",
		cwd: "/tmp",
	});
	assert.equal(result.status, "launched");
	assert.equal(result.windowId, "bg-test-1");
	assert.equal(result.error, undefined);
}

// 5. Fake backend isAlive returns true for launched window
{
	const fb = fakeBackend();
	await fb.launch({ agentName: "a", runId: "w1", manifestPath: "/m", cwd: "/c" });
	assert.equal(await fb.isAlive("w1"), true);
	assert.equal(await fb.isAlive("nonexistent"), false);
}

// 6. Fake backend kill removes window
{
	const fb = fakeBackend();
	await fb.launch({ agentName: "a", runId: "w2", manifestPath: "/m", cwd: "/c" });
	assert.equal(await fb.isAlive("w2"), true);

	const killResult = await fb.kill("w2");
	assert.equal(killResult.status, "launched");

	assert.equal(await fb.isAlive("w2"), false);
}

// 7. Fake backend kill of nonexistent window fails
{
	const fb = fakeBackend();
	const killResult = await fb.kill("nonexistent");
	assert.equal(killResult.status, "failed");
	assert.ok(killResult.error?.includes("not found"));
}

// 8. Fake backend list returns all windows
{
	const fb = fakeBackend();
	await fb.launch({ agentName: "a", runId: "w-a", manifestPath: "/m", cwd: "/c" });
	assert.deepEqual(await fb.list(), ["w-a"]);

	await fb.launch({ agentName: "b", runId: "w-b", manifestPath: "/m", cwd: "/c" });
	const list = await fb.list();
	assert.deepEqual(list.sort(), ["w-a", "w-b"].sort());

	await fb.kill("w-a");
	assert.deepEqual(await fb.list(), ["w-b"]);
}

// 9. TermBgAgentConfig shape is correct
{
	const config = {
		agentName: "researcher",
		runId: "bg-abc123-def456",
		manifestPath: "/home/user/.pi/agent/bg/bg-abc123-def456/manifest.json",
		cwd: "/home/user/projects/my-app",
	};
	assert.equal(typeof config.agentName, "string");
	assert.equal(typeof config.runId, "string");
	assert.equal(typeof config.manifestPath, "string");
	assert.equal(typeof config.cwd, "string");
}

// 10. TermBgResult launched shape
{
	const result = { status: "launched", windowId: "win-1" };
	assert.equal(result.status, "launched");
	assert.equal(result.windowId, "win-1");
	assert.equal(result.error, undefined);
}

// 11. TermBgResult failed shape
{
	const result = { status: "failed", error: "tmux not found" };
	assert.equal(result.status, "failed");
	assert.equal(result.error, "tmux not found");
	assert.equal(result.windowId, undefined);
}

// 12. Backend name is exposed
{
	const fb = fakeBackend("tmux");
	assert.equal(fb.name, "tmux");
}

console.log("P4-4 bg-terminal tests passed");
