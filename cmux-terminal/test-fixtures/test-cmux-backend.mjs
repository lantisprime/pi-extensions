// P5b-1 test-cmux-backend.mjs — 16 unit tests.
// Verifies cmux-backend.ts: isAvailable probe (4 tests), launch (6 tests:
//   correct argv with shell-escaping, invalid cwd, invalid manifestPath,
//   manifestPath outside bgStateDir, spaces in workerPath, metacharacters
//   in manifestPath), kill (1), isAlive (2), list (3 — incl. P1 list→kill
//   round-trip and ref-missing fallback).
// Each test is independent and uses a fresh backend + temp bgStateDir.
//
// cmux 0.64.17 command surface asserted by these tests:
//   isAvailable  → `cmux workspace list --json` (P2: real socket-roundtrip)
//   launch       → `cmux workspace create --name --cwd --command --focus`
//   kill         → `cmux close-workspace --workspace <id>`
//   isAlive/list → `cmux workspace list --json`
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

// Test 1: isAvailable — macOS + workspace list --json succeeds → true
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: true, stdout: JSON.stringify({ workspaces: [] }), stderr: "", exitCode: 0 });
	const prevPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
	try {
		const result = await backend.isAvailable();
		assert.equal(result, true, "isAvailable must be true on darwin when workspace list --json succeeds (real socket-roundtrip)");
		assert.ok(executor.calls.length >= 1, "isAvailable must call cmux");
		assert.deepEqual(executor.calls[0].args, ["workspace", "list", "--json"], "P5b-1-S1 P2: isAvailable MUST probe via `cmux workspace list --json` (a real socket-roundtrip), NOT `cmux version` which exits 0 even when the socket is broken");
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

// Test 3: isAvailable — workspace list --json fails → false
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: false, stderr: "Socket not found at /Users/me/.local/state/cmux/cmux.sock", exitCode: 1 });
	const prevPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
	try {
		const result = await backend.isAvailable();
		assert.equal(result, false, "isAvailable must be false when workspace list --json fails (socket unreachable)");
		const probeCall = executor.calls.find(function _c(c) { return c.args[0] === "workspace" && c.args[1] === "list"; });
		assert.ok(probeCall, "isAvailable MUST probe via workspace list --json (not version)");
		assert.deepEqual(probeCall.args, ["workspace", "list", "--json"]);
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
	assert.equal(result.windowId, SAMPLE_WORKSPACE_NAME, "windowId MUST equal pi-cmux-<runId> (falls back to title when stdout is empty)");
	const launchCall = executor.calls.find(function _c(c) { return c.args[0] === "workspace" && c.args[1] === "create"; });
	assert.ok(launchCall, "workspace create argv must be present");
	const escape = function _e(s) { return "'" + s.replace(/'/g, "'\\''") + "'"; };
	assert.deepEqual(launchCall.args, [
		"workspace", "create",
		"--name", SAMPLE_WORKSPACE_NAME,
		"--cwd", SAMPLE_CWD,
		"--command", "node " + escape(workerPath) + " " + escape(manifestPath),
		"--focus", "false",
	], "argv MUST match spec exactly (--command payload MUST shell-escape workerPath + manifestPath)");
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
	assert.deepEqual(killCall.args, ["close-workspace", "--workspace", SAMPLE_WORKSPACE_NAME], "kill MUST use close-workspace --workspace <name> (NOT close-window, which kills the whole window and other workspaces inside it)");
}

// Test 7: isAlive — workspace list JSON parse, match found → true
{
	const { executor, backend } = freshBackend();
	// cmux JSON shape uses `ref` (e.g. "workspace:3"), not `id`. Use realistic
	// shape so the test data matches the production contract.
	const listJson = JSON.stringify({
		workspaces: [
			{ ref: "workspace:1", title: "vim" },
			{ ref: "workspace:2", title: SAMPLE_WORKSPACE_NAME },
			{ ref: "workspace:3", title: "bash" },
		],
	});
	executor.setDefaultResponse({ ok: true, stdout: listJson, stderr: "", exitCode: 0 });
	const alive = await backend.isAlive(SAMPLE_WORKSPACE_NAME);
	assert.equal(alive, true, "isAlive must be true when workspace name is found in workspace list output");
	const listCall = executor.calls.find(function _c(c) { return c.args[0] === "workspace" && c.args[1] === "list"; });
	assert.deepEqual(listCall.args, ["workspace", "list", "--json"]);
}

// Test 7b: isAlive — match found by ref (NOT title) → true
// Defends the symmetric path: after P1, list() returns the ref, so isAlive()
// must accept it the same way kill() does.
{
	const { executor, backend } = freshBackend();
	const listJson = JSON.stringify({
		workspaces: [
			{ ref: "workspace:7", title: SAMPLE_WORKSPACE_NAME },
		],
	});
	executor.setDefaultResponse({ ok: true, stdout: listJson, stderr: "", exitCode: 0 });
	const alive = await backend.isAlive("workspace:7");
	assert.equal(alive, true, "isAlive must be true when windowId matches ws.ref (the value list() now returns)");
}

// Test 8: list — filters by prefix, returns ws.ref as windowId (P1), extracts runId from title
{
	const { executor, backend } = freshBackend();
	// cmux 0.64.17 JSON shape: { workspaces: [{ ref, title, ... }, ...] }.
	// P5b-1-S1 P1: windowId MUST equal ws.ref (NOT title) so callers can feed it
	// straight back into kill()/close-workspace which accepts id|ref|index.
	const listJson = JSON.stringify({
		workspaces: [
			{ ref: "workspace:1", title: "vim" },
			{ ref: "workspace:2", title: SAMPLE_WORKSPACE_NAME },
			{ ref: "workspace:3", title: "pi-cmux-bg-other-runid-x7y8" },
			{ ref: "workspace:4", title: "bash" },
		],
	});
	executor.setDefaultResponse({ ok: true, stdout: listJson, stderr: "", exitCode: 0 });
	const entries = await backend.list();
	assert.equal(entries.length, 2, "list MUST filter to pi-cmux- prefix only (2 of 4)");
	assert.equal(entries[0].windowId, "workspace:2", "P1: windowId MUST equal ws.ref (close-workspace accepts id|ref|index, NOT title)");
	assert.equal(entries[0].runId, SAMPLE_RUN_ID, "runId MUST be extracted by stripping pi-cmux- prefix from the title");
	assert.equal(entries[0].agentName, undefined, "agentName MUST be undefined (cmux limitation: no user-options equivalent)");
	assert.equal(entries[1].windowId, "workspace:3", "P1: second entry windowId MUST also be the ref");
	assert.equal(entries[1].runId, "bg-other-runid-x7y8");
}

// Test 9: launch — invalid manifestPath (relative) → failed, 0 cmux calls
{
	const { executor, backend } = freshBackend();
	const result = await backend.launch({
		agentName: "scout",
		runId: SAMPLE_RUN_ID,
		manifestPath: "relative/manifest.json",
		cwd: SAMPLE_CWD,
	});
	assert.equal(result.status, "failed", "relative manifestPath MUST be rejected");
	assert.equal(result.error, "invalid manifest path", "error MUST be 'invalid manifest path'");
	assert.equal(executor.calls.length, 0, "cmux MUST NOT be invoked when manifestPath is relative");
}

// Test 10: launch — manifestPath outside bgStateDir → failed, 0 cmux calls
{
	const { executor, backend } = freshBackend();
	// /etc/passwd is absolute and has no `..` segments, so isAbsoluteNoDotDot passes,
	// but isUnderDir fails because /etc is not under the random tmp bgStateDir.
	const outsidePath = "/etc/passwd";
	const result = await backend.launch({
		agentName: "scout",
		runId: SAMPLE_RUN_ID,
		manifestPath: outsidePath,
		cwd: SAMPLE_CWD,
	});
	assert.equal(result.status, "failed", "manifestPath outside bgStateDir MUST be rejected");
	assert.equal(result.error, "invalid manifest path", "error MUST be 'invalid manifest path'");
	assert.equal(executor.calls.length, 0, "cmux MUST NOT be invoked when manifestPath is outside bgStateDir");
}

// Test 11: launch — spaces in workerPath → correctly escaped in --command argv
{
	const spaceWorkerPath = "/abs/agents/lib with space/bg-worker.ts";
	const { executor, backend, bgStateDir } = freshBackend({ workerPath: spaceWorkerPath });
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	const result = await backend.launch({
		agentName: "scout",
		runId: SAMPLE_RUN_ID,
		manifestPath,
		cwd: SAMPLE_CWD,
	});
	assert.equal(result.status, "ok", "launch must succeed with spaces in workerPath");
	const launchCall = executor.calls.find(function _c(c) { return c.args[0] === "workspace" && c.args[1] === "create"; });
	assert.ok(launchCall, "workspace create argv must be present");
	const cmdIdx = launchCall.args.indexOf("--command");
	assert.ok(cmdIdx >= 0, "argv MUST contain --command");
	const cmdPayload = launchCall.args[cmdIdx + 1];
	assert.ok(cmdPayload.includes("'" + spaceWorkerPath + "'"), "workerPath with spaces MUST be POSIX-shell-escaped inside --command payload (got: " + cmdPayload + ")");
	// No unquoted spaces: the path appears wrapped in single quotes so the shell
	// treats it as one token, even though the path itself contains a space.
	const unquotedSpace = cmdPayload.indexOf(" " + spaceWorkerPath);
	assert.equal(unquotedSpace, -1, "workerPath MUST NOT appear unquoted in --command payload (would split on space)");
}

// Test 12: launch — metacharacters in manifestPath → escaped in --command argv
{
	const { executor, backend, bgStateDir } = freshBackend();
	// Build a path with shell metacharacters that would, if unquoted, inject extra tokens.
	const evilDir = path.join(bgStateDir, "dir; touch /tmp/pwned; #");
	fs.mkdirSync(evilDir, { recursive: true });
	const manifestPath = path.join(evilDir, "manifest.json");
	fs.writeFileSync(manifestPath, "{}");
	const result = await backend.launch({
		agentName: "scout",
		runId: SAMPLE_RUN_ID,
		manifestPath,
		cwd: SAMPLE_CWD,
	});
	assert.equal(result.status, "ok", "launch must succeed with metacharacters in manifestPath");
	const launchCall = executor.calls.find(function _c(c) { return c.args[0] === "workspace" && c.args[1] === "create"; });
	assert.ok(launchCall, "workspace create argv must be present");
	const cmdIdx = launchCall.args.indexOf("--command");
	const cmdPayload = launchCall.args[cmdIdx + 1];
	// Path must be wrapped in single quotes — the entire metachar-containing
	// segment is one quoted token, not a sequence of `;`-separated commands.
	assert.ok(cmdPayload.includes("'" + manifestPath + "'"), "manifestPath with metacharacters MUST be POSIX-shell-escaped (single-quote wrapped) inside --command payload (got: " + cmdPayload + ")");
	// The whole quoted path must be a contiguous substring — no `;` outside the quotes.
	const beforeQuote = cmdPayload.indexOf("'" + manifestPath + "'");
	const surrounding = cmdPayload.slice(Math.max(0, beforeQuote - 1), beforeQuote + manifestPath.length + 3);
	assert.ok(!surrounding.startsWith(";"), "manifestPath with metacharacters MUST NOT appear unquoted (would inject commands) in --command payload (got: " + cmdPayload + ")");
}

// Test 13: list → kill round-trip (P5b-1-S1 P1 regression guard).
// Spec: list() returns windowId === ws.ref so callers can feed it straight
// into kill(). Verify the returned windowId is exactly what close-workspace
// sees as `--workspace`, NOT the title.
{
	const { executor, backend } = freshBackend();
	const listJson = JSON.stringify({
		workspaces: [
			{ ref: "workspace:42", title: SAMPLE_WORKSPACE_NAME },
		],
	});
	executor.setDefaultResponse({ ok: true, stdout: listJson, stderr: "", exitCode: 0 });
	const entries = await backend.list();
	assert.equal(entries.length, 1);
	assert.equal(entries[0].windowId, "workspace:42", "P1: list() windowId MUST be ws.ref so kill(entries[0].windowId) works");
	// Reset call log so the next assertion sees only kill's call.
	executor.reset();
	executor.enqueueResponse({ ok: true, stdout: "", stderr: "", exitCode: 0 });
	const killResult = await backend.kill(entries[0].windowId);
	assert.equal(killResult.status, "ok", "kill(refFromList) must succeed");
	const killCall = executor.calls[0];
	assert.deepEqual(killCall.args, ["close-workspace", "--workspace", "workspace:42"], "kill MUST receive the ref from list() (NOT the title) so cmux's close-workspace accepts it");
}

// Test 14: list — falls back to title when ws.ref is missing (defensive).
// P1 calls for returning ws.ref; if a workspace entry lacks a ref (older
// cmux shape, partial JSON), list() should fall back to the title rather
// than emit an unusable empty windowId, so the entry is still killable.
{
	const { executor, backend } = freshBackend();
	const listJson = JSON.stringify({
		workspaces: [
			{ title: SAMPLE_WORKSPACE_NAME }, // no ref field at all
		],
	});
	executor.setDefaultResponse({ ok: true, stdout: listJson, stderr: "", exitCode: 0 });
	const entries = await backend.list();
	assert.equal(entries.length, 1);
	assert.equal(entries[0].windowId, SAMPLE_WORKSPACE_NAME, "list() MUST fall back to title when ws.ref is missing (defensive — entry must still be killable)");
	assert.equal(entries[0].runId, SAMPLE_RUN_ID);
}

// Test 14b: list — skips entries with empty-string ref and falls back to title.
// Some JSON variants may carry `ref: ""`. The defensive fallback must use the
// title in that case too, not emit an unusable empty windowId.
{
	const { executor, backend } = freshBackend();
	const listJson = JSON.stringify({
		workspaces: [
			{ ref: "", title: SAMPLE_WORKSPACE_NAME },
		],
	});
	executor.setDefaultResponse({ ok: true, stdout: listJson, stderr: "", exitCode: 0 });
	const entries = await backend.list();
	assert.equal(entries.length, 1);
	assert.equal(entries[0].windowId, SAMPLE_WORKSPACE_NAME, "list() MUST fall back to title when ws.ref is empty string");
}

// Test 15: isAvailable — executor throws (not just ok:false) → still returns false.
// Guards the try/catch path: a runtime exception from the executor (e.g. ENOENT
// translated by the defaultCmuxExecutor already, but a custom executor might
// throw) MUST surface as `false`, not crash the caller.
{
	const { executor, backend } = freshBackend();
	const prevPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
	executor.exec = async () => { throw new Error("exec blew up"); };
	try {
		const result = await backend.isAvailable();
		assert.equal(result, false, "isAvailable MUST return false when executor throws (no crash)");
	} finally {
		if (prevPlatform) Object.defineProperty(process, "platform", prevPlatform);
	}
}

// Test 16: isAvailable — list-OK but non-JSON stdout → still returns true.
// The probe only needs to confirm the socket is reachable; whether the stdout
// is parseable is a list()/isAlive() concern, not isAvailable()'s. (We don't
// want isAvailable() to mask a real socket with a JSON-parser regression.)
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: true, stdout: "not-json-but-ok", stderr: "", exitCode: 0 });
	const prevPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
	try {
		const result = await backend.isAvailable();
		assert.equal(result, true, "isAvailable MUST return true when `workspace list --json` exits 0 (socket reachable), regardless of stdout shape");
	} finally {
		if (prevPlatform) Object.defineProperty(process, "platform", prevPlatform);
	}
}

console.log("P5b-1 cmux-backend tests passed");
