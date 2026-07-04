// P5b-2 test-zellij-backend.mjs — 33 unit tests across Groups 1–9.
//
// Verifies zellij-backend.ts: registration (via the extension), name +
// preference, isAvailable probe, launch (argv security, path escaping,
// validation, session naming, polling, malformed output), kill (idempotent +
// zombie fallback), isAlive (exact-match), list (prefix filter, runId
// recovery), and helper-file byte-identity with tmux-terminal.
//
// Each test uses a fresh backend + temp bgStateDir + a fresh FakeZellijExecutor
// + a fresh fake attachSpawner. The fake attachSpawner is the B1 seam — it
// captures the session name passed by the backend without spawning a real
// `zellij attach -b`. This is what the unit tests rely on for asserting
// "the backend was about to create session X" without ever calling zellij.
//
// zellij 0.44.3+ command surface asserted by these tests:
//   isAvailable / isAlive / list / kill-zombie  → `zellij list-sessions -s`
//   launch step 1                              → `zellij attach -b <name>` (via INJECTED attachSpawner)
//   launch step 2                              → `zellij list-sessions -s` (poll)
//   launch step 3                              → `zellij -s <name> run --name --cwd --close-on-exit -- node <worker> <manifest>`
//   kill                                        → `zellij kill-session <name>` (or `delete-session -f` for zombies)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createZellijBackend } from "../lib/zellij-backend.ts";
import { defaultZellijExecutor, spawnAttachSession } from "../lib/exec.ts";
import {
	__resetBgTerminalBackend,
	listBgTerminalBackends,
} from "../../agents/lib/bg-terminal.ts";
import {
	__resetResolveWorkerPathForTest,
	__setResolveWorkerPathForTest,
} from "../lib/resolve-worker-path.ts";
import zellijTerminalExtension from "../index.ts";

// ── FakeZellijExecutor ─────────────────────────────────────────────────────
// Mirrors tmux/cmux fake executors. Records calls, replays scripted responses.

class FakeZellijExecutor {
	constructor() {
		this.calls = [];
		this.responses = [];
		this.defaultResponse = { ok: true, stdout: "", stderr: "", exitCode: 0 };
	}
	enqueueResponse(r) { this.responses.push(r); }
	setDefaultResponse(r) { this.defaultResponse = r; }
	reset() { this.calls = []; this.responses = []; this.defaultResponse = { ok: true, stdout: "", stderr: "", exitCode: 0 }; }
	async exec(args, opts) {
		this.calls.push({ args, opts });
		const s = this.responses.shift() ?? this.defaultResponse;
		if (s.simulateTimeout) {
			const err = new Error("timeout");
			err.killed = true;
			err.signal = "SIGTERM";
			throw err;
		}
		if (s.ok) return { ok: true, stdout: s.stdout ?? "", stderr: s.stderr ?? "", exitCode: 0 };
		return { ok: false, stdout: s.stdout ?? "", stderr: s.stderr ?? "", exitCode: s.exitCode ?? 1 };
	}
}

// ── FakeAttachSpawner ──────────────────────────────────────────────────────
// Captures the session name (so tests can assert on the B1 seam) but does NOT
// actually spawn a subprocess. Mirrors the production contract: the spawner
// is async and returns a Promise<void>. Tests resolve immediately.

class FakeAttachSpawner {
	constructor() { this.calls = []; }
	async spawn(name) { this.calls.push(name); }
	reset() { this.calls = []; }
}

function freshBackend(extras = {}) {
	const executor = new FakeZellijExecutor();
	const attach = new FakeAttachSpawner();
	const bgStateDir = path.join(os.tmpdir(), "pi-bg-state-" + Math.random().toString(36).slice(2));
	fs.mkdirSync(bgStateDir, { recursive: true });
	const workerPath = "/abs/agents/lib/bg-worker.ts";
	const backend = createZellijBackend({
		executor,
		attachSpawner: attach.spawn.bind(attach),
		workerPath,
		bgStateDir,
		...extras,
	});
	return { executor, attach, backend, workerPath, bgStateDir };
}

const SAMPLE_RUN_ID = "bg-1719432000000-a3f9c2b1e8f4d2b6";
const SAMPLE_SESSION_NAME = "pi-zellij-bg-1719432000000-a3f9c2b1e8f4d2b6";
const SAMPLE_PANE_NAME = "pi-zellij-pane-bg-17194"; // runId.slice(0,8) = "bg-17194"
const SAMPLE_MANIFEST = "/var/folders/abc/T/pi-bg-state-xyz/bg-1719432000000-a3f9c2b1e8f4d2b6/manifest.json";
const SAMPLE_CWD = "/Users/me/project";

let passed = 0;
let testNum = 0;
function test(name, fn) {
	testNum++;
	try {
		const r = fn();
		if (r && typeof r.then === "function") {
			return r.then(
				() => { passed++; console.log("  \u2713 " + name); },
				(err) => { console.error("  \u2717 " + name + " (async): " + (err.stack || err.message)); process.exit(1); },
			);
		}
		passed++;
		console.log("  \u2713 " + name);
	} catch (err) {
		console.error("  \u2717 " + name + ": " + (err.stack || err.message));
		process.exit(1);
	}
}

function fakePi() {
	const handlers = new Map();
	return {
		on(event, handler) { handlers.set(event, handler); },
		dispatch(event) { const h = handlers.get(event); if (h) return h(); },
	};
}

// ── Group 1: registration (2 tests) ────────────────────────────────────────

await test("testRegistersOnSessionStart", async () => {
	__resetBgTerminalBackend();
	__resetResolveWorkerPathForTest();
	__setResolveWorkerPathForTest(() => "/abs/agents/lib/bg-worker.ts");
	const pi = fakePi();
	zellijTerminalExtension(pi);
	pi.dispatch("session_start");
	const list = listBgTerminalBackends();
	assert.equal(list.length, 1, "zellij backend MUST be registered after session_start");
	assert.equal(list[0].name, "zellij", "registered backend.name must be exactly 'zellij'");
	__resetResolveWorkerPathForTest();
});

await test("testSkipsRegistrationWhenWorkerMissing", async () => {
	__resetBgTerminalBackend();
	__resetResolveWorkerPathForTest();
	__setResolveWorkerPathForTest(() => null);
	const pi = fakePi();
	zellijTerminalExtension(pi);
	pi.dispatch("session_start");
	assert.equal(listBgTerminalBackends().length, 0, "missing worker MUST skip registration");
	__resetResolveWorkerPathForTest();
});

// ── Group 2: name + preference (2 tests) ───────────────────────────────────

test("testBackendNameIsZellij", () => {
	const { backend } = freshBackend();
	assert.equal(backend.name, "zellij", "backend.name must be exactly 'zellij'");
});

test("testPreferenceIsZero", () => {
	const { backend } = freshBackend();
	assert.equal(backend.preference, 0, "zellij backend.preference must be 0 (user must opt in via --backend)");
});

// ── Group 3: isAvailable (4 tests) ────────────────────────────────────────

await test("testIsAvailableTrueWhenListSessionsExits0", async () => {
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: true, stdout: "pi-zellij-foo\n", stderr: "", exitCode: 0 });
	const result = await backend.isAvailable();
	assert.equal(result, true, "isAvailable must be true when list-sessions -s exits 0");
	assert.deepEqual(executor.calls[0].args, ["list-sessions", "-s"]);
});

await test("testIsAvailableTrueWhenNoSessionsMessage", async () => {
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: false, stderr: "No active zellij sessions found.\n", exitCode: 1 });
	const result = await backend.isAvailable();
	assert.equal(result, true, "isAvailable must be true when list-sessions exits 1 with 'No active zellij sessions found.' (healthy-but-empty)");
});

await test("testIsAvailableFalseOnENOENT", async () => {
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: false, stderr: "spawn zellij ENOENT", exitCode: -1 });
	const result = await backend.isAvailable();
	assert.equal(result, false, "isAvailable must be false when zellij is not installed (ENOENT)");
});

await test("testIsAvailableFalseOnThrow", async () => {
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ simulateTimeout: true });
	const result = await backend.isAvailable();
	assert.equal(result, false, "isAvailable must return false on executor throw, NOT re-throw");
});

// ── Group 4: launch (7 tests) ─────────────────────────────────────────────

await test("testLaunchCreatesSessionAndPane", async () => {
	const { executor, attach, backend, bgStateDir, workerPath } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	// Step 2 (poll): list-sessions returns the session name immediately.
	executor.setDefaultResponse({ ok: true, stdout: SAMPLE_SESSION_NAME + "\n", stderr: "", exitCode: 0 });
	// Step 3 (run): the fake's default ok:true with empty stdout will FAIL the
	// /terminal_\d+/ check; we need to set up the run response explicitly.
	executor.enqueueResponse({ ok: true, stdout: SAMPLE_SESSION_NAME + "\n", stderr: "", exitCode: 0 }); // poll
	executor.enqueueResponse({ ok: true, stdout: "terminal_1\n", stderr: "", exitCode: 0 }); // run
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	assert.equal(result.status, "ok", "launch must succeed with valid inputs");
	assert.equal(result.windowId, SAMPLE_SESSION_NAME, "windowId MUST equal pi-zellij-<runId>");
	// attachSpawner was called with the session name (B1 seam)
	assert.equal(attach.calls.length, 1, "attachSpawner must be called exactly once");
	assert.equal(attach.calls[0], SAMPLE_SESSION_NAME, "attachSpawner must be called with the session name");
	// The run argv is well-formed.
	const runCall = executor.calls.find((c) => c.args[0] === "-s" && c.args[1] === SAMPLE_SESSION_NAME && c.args[2] === "run");
	assert.ok(runCall, "zellij run argv must be present and targeted via -s <session>");
});

await test("testLaunchValidatesCwdBeforeCall", async () => {
	const { executor, attach, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: "/tmp/../etc" });
	assert.equal(result.status, "failed", "launch must fail for cwd with ..");
	assert.equal(result.error, "invalid cwd", "error must be 'invalid cwd'");
	assert.equal(executor.calls.length, 0, "no executor calls on invalid cwd (REQ-4)");
	assert.equal(attach.calls.length, 0, "no attachSpawner call on invalid cwd (REQ-4)");
});

await test("testLaunchValidatesManifestPathBeforeCall", async () => {
	const { executor, attach, backend, bgStateDir } = freshBackend();
	// manifestPath is outside bgStateDir (in /tmp, not realpathed under bgStateDir).
	const result = await backend.launch({
		agentName: "scout",
		runId: SAMPLE_RUN_ID,
		manifestPath: "/tmp/elsewhere/manifest.json",
		cwd: SAMPLE_CWD,
	});
	assert.equal(result.status, "failed", "launch must fail for manifest outside bgStateDir");
	assert.equal(result.error, "invalid manifest path", "error must be 'invalid manifest path'");
	assert.equal(executor.calls.length, 0, "no executor calls on invalid manifest (REQ-4)");
	assert.equal(attach.calls.length, 0, "no attachSpawner call on invalid manifest (REQ-4)");
});

await test("testLaunchReturnsSessionNameAsWindowId", async () => {
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	executor.enqueueResponse({ ok: true, stdout: SAMPLE_SESSION_NAME + "\n", stderr: "", exitCode: 0 }); // poll
	executor.enqueueResponse({ ok: true, stdout: "terminal_42\n", stderr: "", exitCode: 0 }); // run
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	assert.equal(result.status, "ok");
	assert.equal(result.windowId, SAMPLE_SESSION_NAME, "windowId MUST be the session name (NOT the pane id)");
});

await test("testLaunchPollsUntilSessionAppears", async () => {
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	// First 2 list-sessions responses do NOT include the session. 3rd one does.
	executor.enqueueResponse({ ok: true, stdout: "other-session\n", stderr: "", exitCode: 0 });
	executor.enqueueResponse({ ok: true, stdout: "another\n", stderr: "", exitCode: 0 });
	executor.enqueueResponse({ ok: true, stdout: "yet-another\n" + SAMPLE_SESSION_NAME + "\n", stderr: "", exitCode: 0 });
	executor.enqueueResponse({ ok: true, stdout: "terminal_7\n", stderr: "", exitCode: 0 });
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	assert.equal(result.status, "ok", "launch must succeed after polling finds the session");
	const listCalls = executor.calls.filter((c) => c.args[0] === "list-sessions");
	assert.ok(listCalls.length >= 3, "must poll list-sessions at least 3 times (got " + listCalls.length + ")");
});

await test("testLaunchReturnsFailedOnPollTimeout", async () => {
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	// list-sessions NEVER returns the session name → poll times out.
	executor.setDefaultResponse({ ok: true, stdout: "other-session\n", stderr: "", exitCode: 0 });
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	assert.equal(result.status, "failed");
	assert.equal(result.error, "zellij session did not appear within 5000ms", "error must match exact poll-timeout message");
});

await test("testLaunchRejectsMalformedRunOutput", async () => {
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	executor.enqueueResponse({ ok: true, stdout: SAMPLE_SESSION_NAME + "\n", stderr: "", exitCode: 0 }); // poll
	executor.enqueueResponse({ ok: true, stdout: "garbage-output-not-terminal-id\n", stderr: "", exitCode: 0 }); // run
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	assert.equal(result.status, "failed");
	assert.ok(result.error.startsWith("unexpected run output:"), "error must start with 'unexpected run output:'");
});

// ── Group 5: launch security (5 tests) ─────────────────────────────────────

await test("testLaunchArgvContainsNoAgentName", async () => {
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	executor.enqueueResponse({ ok: true, stdout: SAMPLE_SESSION_NAME + "\n", stderr: "", exitCode: 0 });
	executor.enqueueResponse({ ok: true, stdout: "terminal_1\n", stderr: "", exitCode: 0 });
	const evilName = "scout; touch /tmp/pwned; echo pwned";
	await backend.launch({ agentName: evilName, runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	const runCall = executor.calls.find((c) => c.args[0] === "-s" && c.args[2] === "run");
	assert.ok(runCall, "run argv must be present");
	const runStr = runCall.args.join(" ");
	assert.ok(!runStr.includes("touch"), "agentName shell metachar MUST NOT reach the run argv");
	assert.ok(!runStr.includes("pwned"), "agentName payload MUST NOT reach the run argv");
});

await test("testLaunchArgvContainsNoRunId", async () => {
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	executor.enqueueResponse({ ok: true, stdout: SAMPLE_SESSION_NAME + "\n", stderr: "", exitCode: 0 });
	executor.enqueueResponse({ ok: true, stdout: "terminal_1\n", stderr: "", exitCode: 0 });
	await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	const runCall = executor.calls.find((c) => c.args[0] === "-s" && c.args[2] === "run");
	// SAMPLE_RUN_ID appears in the session name (-s <name>) and the slice(0,8)
	// appears in the pane name. Neither is a positional arg after `--`, which
	// is the security invariant.
	const idx = runCall.args.indexOf("--");
	assert.ok(idx >= 0, "run argv MUST contain `--` terminator");
	const afterDash = runCall.args.slice(idx + 1);
	assert.deepEqual(afterDash, ["node", "/abs/agents/lib/bg-worker.ts", manifestPath], "argv after `--` MUST be exactly [node, workerPath, manifestPath]");
});

await test("testLaunchPaneNameIsNotAgentName", async () => {
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	executor.enqueueResponse({ ok: true, stdout: SAMPLE_SESSION_NAME + "\n", stderr: "", exitCode: 0 });
	executor.enqueueResponse({ ok: true, stdout: "terminal_1\n", stderr: "", exitCode: 0 });
	const evilName = "scout-pwned";
	await backend.launch({ agentName: evilName, runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	const runCall = executor.calls.find((c) => c.args[0] === "-s" && c.args[2] === "run");
	const nameIdx = runCall.args.indexOf("--name");
	assert.ok(nameIdx >= 0, "run argv MUST have --name");
	const paneName = runCall.args[nameIdx + 1];
	assert.notEqual(paneName, evilName, "pane name MUST NOT be the agentName");
	assert.equal(paneName, SAMPLE_PANE_NAME, "pane name MUST be the derived pi-zellij-pane-<runId.slice(0,8)>");
});

await test("testLaunchUsesSessionFlagOnRun", async () => {
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	executor.enqueueResponse({ ok: true, stdout: SAMPLE_SESSION_NAME + "\n", stderr: "", exitCode: 0 });
	executor.enqueueResponse({ ok: true, stdout: "terminal_1\n", stderr: "", exitCode: 0 });
	await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	const runCall = executor.calls.find((c) => c.args[0] === "-s" && c.args[2] === "run");
	assert.equal(runCall.args[0], "-s", "run MUST use -s <session-name> as the first two args");
	assert.equal(runCall.args[1], SAMPLE_SESSION_NAME, "run MUST target the session name as -s value");
});

await test("testLaunchArgvHasDoubleDashTerminator", async () => {
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	executor.enqueueResponse({ ok: true, stdout: SAMPLE_SESSION_NAME + "\n", stderr: "", exitCode: 0 });
	executor.enqueueResponse({ ok: true, stdout: "terminal_1\n", stderr: "", exitCode: 0 });
	await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	const runCall = executor.calls.find((c) => c.args[0] === "-s" && c.args[2] === "run");
	assert.ok(runCall.args.includes("--"), "run argv MUST contain `--` terminator before the worker command");
	const idx = runCall.args.indexOf("--");
	assert.equal(runCall.args[idx + 1], "node", "after `--` MUST come `node`");
});

// ── Group 6: kill (4 tests) ────────────────────────────────────────────────

await test("testKillExistingSession", async () => {
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: true, stdout: "", stderr: "", exitCode: 0 });
	const result = await backend.kill(SAMPLE_SESSION_NAME);
	assert.equal(result.status, "ok");
	assert.equal(result.windowId, SAMPLE_SESSION_NAME);
	const killCall = executor.calls.find((c) => c.args[0] === "kill-session");
	assert.ok(killCall, "kill must call zellij kill-session");
	assert.deepEqual(killCall.args, ["kill-session", SAMPLE_SESSION_NAME]);
});

await test("testKillMissingSessionIsOk", async () => {
	const { executor, backend } = freshBackend();
	// kill-session returns "not found"; list-sessions shows the session is gone.
	executor.enqueueResponse({ ok: false, stdout: "", stderr: "No session named \"" + SAMPLE_SESSION_NAME + "\" found.\n", exitCode: 1 });
	executor.enqueueResponse({ ok: true, stdout: "other-session\n", stderr: "", exitCode: 0 });
	const result = await backend.kill(SAMPLE_SESSION_NAME);
	assert.equal(result.status, "ok", "kill of missing session must be idempotent ok");
	assert.equal(result.windowId, SAMPLE_SESSION_NAME);
});

await test("testKillZombieFallsBackToDeleteSession", async () => {
	const { executor, backend } = freshBackend();
	// kill-session: not found
	executor.enqueueResponse({ ok: false, stdout: "", stderr: "No session named \"" + SAMPLE_SESSION_NAME + "\" found.\n", exitCode: 1 });
	// list-sessions: zombie still listed
	executor.enqueueResponse({ ok: true, stdout: SAMPLE_SESSION_NAME + "\nother\n", stderr: "", exitCode: 0 });
	// delete-session -f: best-effort, any result is fine
	executor.setDefaultResponse({ ok: true, stdout: "", stderr: "", exitCode: 0 });
	const result = await backend.kill(SAMPLE_SESSION_NAME);
	assert.equal(result.status, "ok", "kill of zombie must still return ok after delete-session -f fallback");
	const deleteCall = executor.calls.find((c) => c.args[0] === "delete-session" && c.args[1] === "-f");
	assert.ok(deleteCall, "zombie fallback MUST call delete-session -f");
});

await test("testKillFailureReturnsFailed", async () => {
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: false, stdout: "", stderr: "some other error\n", exitCode: 1 });
	const result = await backend.kill(SAMPLE_SESSION_NAME);
	assert.equal(result.status, "failed");
	assert.ok(result.error.includes("some other error"), "kill failure must surface stderr");
});

// ── Group 7: isAlive (4 tests) ─────────────────────────────────────────────

await test("testIsAliveTrueWhenSessionListed", async () => {
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: true, stdout: "unrelated\n" + SAMPLE_SESSION_NAME + "\nother\n", stderr: "", exitCode: 0 });
	const result = await backend.isAlive(SAMPLE_SESSION_NAME);
	assert.equal(result, true, "isAlive must be true when windowId appears in list-sessions -s");
});

await test("testIsAliveFalseWhenSessionNotListed", async () => {
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: true, stdout: "unrelated\nother\n", stderr: "", exitCode: 0 });
	const result = await backend.isAlive(SAMPLE_SESSION_NAME);
	assert.equal(result, false, "isAlive must be false when windowId is not in list-sessions -s");
});

await test("testIsAliveFalseOnEmptyWindowId", async () => {
	const { executor, backend } = freshBackend();
	const result = await backend.isAlive("");
	assert.equal(result, false, "isAlive must be false for empty windowId");
	assert.equal(executor.calls.length, 0, "isAlive must not call executor for empty windowId");
});

await test("testIsAliveFalseOnError", async () => {
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ simulateTimeout: true });
	const result = await backend.isAlive(SAMPLE_SESSION_NAME);
	assert.equal(result, false, "isAlive must return false on executor throw, NOT re-throw");
});

// ── Group 8: list (4 tests) ────────────────────────────────────────────────

await test("testListFiltersPrefixedSessions", async () => {
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: true, stdout: "vim\n" + SAMPLE_SESSION_NAME + "\nhtop\n", stderr: "", exitCode: 0 });
	const entries = await backend.list();
	assert.equal(entries.length, 1, "list MUST filter non-pi-zellij- sessions");
	assert.equal(entries[0].windowId, SAMPLE_SESSION_NAME);
});

await test("testListRecoversRunIdFromName", async () => {
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: true, stdout: SAMPLE_SESSION_NAME + "\n", stderr: "", exitCode: 0 });
	const entries = await backend.list();
	assert.equal(entries.length, 1);
	assert.equal(entries[0].runId, SAMPLE_RUN_ID, "runId MUST be the suffix after the pi-zellij- prefix");
	assert.equal(entries[0].agentName, undefined, "agentName MUST be undefined (zellij has no user-options equivalent)");
});

await test("testListReturnsEmptyOnNoSessions", async () => {
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: false, stdout: "", stderr: "No active zellij sessions found.\n", exitCode: 1 });
	const entries = await backend.list();
	assert.deepEqual(entries, [], "list MUST return [] on exit-1 (healthy-but-empty)");
});

await test("testListReturnsEmptyOnError", async () => {
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ simulateTimeout: true });
	const entries = await backend.list();
	assert.deepEqual(entries, [], "list MUST return [] on executor throw, NOT throw");
});

// ── Group 9: helpers (1 test) ─────────────────────────────────────────────

await test("testHelpersByteIdenticalToTmux", async () => {
	const { execFileSync } = await import("node:child_process");
	const repoRoot = process.cwd();
	// REQ-11: the 4 helpers are byte-identical to tmux-terminal/lib/ copies.
	// diff -q returns exit 0 + no stdout when files match.
	for (const f of ["path-validate.ts", "redact-error.ts", "shell-escape.ts", "resolve-worker-path.ts"]) {
		const tmuxPath = path.resolve(repoRoot, "tmux-terminal/lib/" + f);
		const zellijPath = path.resolve(repoRoot, "zellij-terminal/lib/" + f);
		const r = execFileSync("diff", ["-q", tmuxPath, zellijPath], { encoding: "utf8" });
		assert.ok(r === "" || r === undefined || r === null, f + " must be byte-identical to tmux-terminal/lib/" + f + " (diff -q stdout: " + r + ")");
	}
});

console.log("P5b-2 zellij-backend tests passed (" + passed + " unit tests)");
