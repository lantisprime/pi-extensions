// P5b-1 test-cmux-backend.mjs — 8 unit tests (the 8 specified in the task).
// Verifies cmux-backend.ts: isAvailable probe (3 tests), launch (2 tests),
// kill (1), isAlive (1), list (1). Each test is independent and uses a fresh
// backend + temp bgStateDir.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCmuxBackend } from "../lib/cmux-backend.ts";
import { FakeCmuxExecutor } from "./fake-cmux.ts";

function freshBackend(extras = {}) {
	const executor = new FakeCmuxExecutor();
	const bgStateDir = path.join(os.tmpdir(), "pi-bg-state-" + Math.random().toString(36).slice(2));
	fs.mkdirSync(bgStateDir, { recursive: true });
	const workerPath = "/abs/agents/lib/bg-worker.ts";
	const backend = createCmuxBackend({
		executor,
		workerPath,
		bgStateDir,
		...extras,
	});
	return { executor, backend, workerPath, bgStateDir };
}

const SAMPLE_RUN_ID = "bg-1719432000000-a3f9c2b1e8f4d2b6";
const SAMPLE_WORKSPACE_NAME = "pi-cmux-bg-1719432000000-a3f9c2b1e8f4d2b6";
const SAMPLE_MANIFEST = "/var/folders/abc/T/pi-bg-state-xyz/bg-1719432000000-a3f9c2b1e8f4d2b6/manifest.json";
const SAMPLE_CWD = "/Users/me/project";

// Test 1: isAvailable — macOS + identify succeeds → true
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: true, stdout: JSON.stringify({ server: "cmux-0.64.17" }), stderr: "", exitCode: 0 });
	const prevPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
	try {
		const result = await backend.isAvailable();
		assert.equal(result, true, "isAvailable must be true on darwin when identify succeeds with non-empty stdout");
		assert.ok(executor.calls.length >= 1, "isAvailable must call cmux identify");
		assert.deepEqual(executor.calls[0].args, ["identify", "--json"]);
	} finally {
		if (prevPlatform) Object.defineProperty(process, "platform", prevPlatform);
	}
}

// Test 2: isAvailable — non-macOS → false (no cmux call)
{
	const { executor, backend } = freshBackend();
	const prevPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: "linux", configurable: true });
	try {
		const result = await backend.isAvailable();
		assert.equal(result, false, "isAvailable must be false on non-darwin (cmux is macOS-only)");
		assert.equal(executor.calls.length, 0, "isAvailable MUST NOT call cmux on non-darwin");
	} finally {
		if (prevPlatform) Object.defineProperty(process, "platform", prevPlatform);
	}
}

// Test 3: isAvailable — identify fails → false
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: false, stderr: "Socket not found at /Users/me/.local/state/cmux/cmux.sock", exitCode: 1 });
	const prevPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
	try {
		const result = await backend.isAvailable();
		assert.equal(result, false, "isAvailable must be false when identify fails (no cmux server running)");
	} finally {
		if (prevPlatform) Object.defineProperty(process, "platform", prevPlatform);
	}
}

// Test 4: launch — creates workspace with correct argv
{
	const { executor, backend, bgStateDir, workerPath } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	assert.equal(result.status, "ok", "launch must succeed with valid inputs");
	assert.equal(result.windowId, SAMPLE_WORKSPACE_NAME, "windowId MUST equal pi-cmux-<runId>");
	const launchCall = executor.calls.find(function _c(c) { return c.args[0] === "new-workspace"; });
	assert.ok(launchCall, "new-workspace argv must be present");
	assert.deepEqual(launchCall.args, [
		"new-workspace",
		"--name", SAMPLE_WORKSPACE_NAME,
		"--cwd", SAMPLE_CWD,
		"--command", "node " + workerPath + " " + manifestPath,
		"--focus", "false",
	], "argv MUST match spec exactly");
}

// Test 5: launch — invalid cwd → failed, no cmux call
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: "./relative" });
	assert.equal(result.status, "failed", "relative cwd must be rejected");
	assert.equal(result.error, "invalid cwd", "error must be 'invalid cwd'");
	assert.equal(executor.calls.length, 0, "cmux MUST NOT be invoked when cwd is invalid");
}

// Test 6: kill — close-workspace with workspace ID
{
	const { executor, backend } = freshBackend();
	executor.enqueueResponse({ ok: true });
	const result = await backend.kill(SAMPLE_WORKSPACE_NAME);
	assert.equal(result.status, "ok", "kill must succeed on a live workspace");
	const killCall = executor.calls.find(function _c(c) { return c.args[0] === "close-workspace"; });
	assert.deepEqual(killCall.args, ["close-workspace", "--workspace", SAMPLE_WORKSPACE_NAME], "kill MUST use close-workspace --workspace <name>");
}

// Test 7: isAlive — list-workspaces JSON parse, match found → true
{
	const { executor, backend } = freshBackend();
	const listJson = JSON.stringify({
		workspaces: [
			{ id: "uuid-1", title: "vim" },
			{ id: "uuid-2", title: SAMPLE_WORKSPACE_NAME },
			{ id: "uuid-3", title: "bash" },
		],
	});
	executor.setDefaultResponse({ ok: true, stdout: listJson, stderr: "", exitCode: 0 });
	const alive = await backend.isAlive(SAMPLE_WORKSPACE_NAME);
	assert.equal(alive, true, "isAlive must be true when workspace name is found in list-workspaces output");
	const listCall = executor.calls.find(function _c(c) { return c.args[0] === "list-workspaces"; });
	assert.deepEqual(listCall.args, ["list-workspaces", "--json"]);
}

// Test 8: list — filters by prefix, extracts runId
{
	const { executor, backend } = freshBackend();
	const listJson = JSON.stringify({
		workspaces: [
			{ id: "uuid-1", title: "vim" },
			{ id: "uuid-2", title: SAMPLE_WORKSPACE_NAME },
			{ id: "uuid-3", title: "pi-cmux-bg-other-runid-x7y8" },
			{ id: "uuid-4", title: "bash" },
		],
	});
	executor.setDefaultResponse({ ok: true, stdout: listJson, stderr: "", exitCode: 0 });
	const entries = await backend.list();
	assert.equal(entries.length, 2, "list MUST filter to pi-cmux- prefix only (2 of 4)");
	assert.equal(entries[0].windowId, SAMPLE_WORKSPACE_NAME, "first entry windowId MUST equal full workspace name");
	assert.equal(entries[0].runId, SAMPLE_RUN_ID, "runId MUST be extracted by stripping pi-cmux- prefix");
	assert.equal(entries[0].agentName, undefined, "agentName MUST be undefined (cmux limitation: no user-options equivalent)");
	assert.equal(entries[1].windowId, "pi-cmux-bg-other-runid-x7y8");
	assert.equal(entries[1].runId, "bg-other-runid-x7y8");
}

console.log("P5b-1 cmux-backend tests passed");
