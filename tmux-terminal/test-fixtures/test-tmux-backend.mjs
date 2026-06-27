// P5 test-tmux-backend.mjs — 45 tests across Groups 1–11.
// Verifies tmux-backend.ts: identity, isAvailable probe, launch (argv security,
// path escaping, validation, window naming/options, UX, resilience), kill, isAlive, list.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTmuxBackend } from "../lib/tmux-backend.ts";
import { FakeTmuxExecutor } from "./fake-tmux.ts";

function freshBackend(extras = {}) {
	const executor = new FakeTmuxExecutor();
	const bgStateDir = path.join(os.tmpdir(), "pi-bg-state-" + Math.random().toString(36).slice(2));
	fs.mkdirSync(bgStateDir, { recursive: true });
	const workerPath = "/abs/agents/lib/bg-worker.ts";
	const backend = createTmuxBackend({
		executor,
		workerPath,
		bgStateDir,
		...extras,
	});
	return { executor, backend, workerPath, bgStateDir };
}

const SAMPLE_RUN_ID = "bg-1719432000000-a3f9c2b1e8f4d2b6";
const SAMPLE_WINDOW_NAME = "pi-agent-bg-1719432000000-a3f9c2b1e8f4d2b6";
const SAMPLE_MANIFEST = "/var/folders/abc/T/pi-bg-state-xyz/bg-1719432000000-a3f9c2b1e8f4d2b6/manifest.json";
const SAMPLE_CWD = "/Users/me/project";

// Group 1: Backend identity (1 test)
{
	const { backend } = freshBackend();
	assert.equal(backend.name, "tmux", "backend.name must be exactly 'tmux'");
}

// Group 2: isAvailable probe (5 tests)
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: true, stdout: "", stderr: "", exitCode: 0 });
	const result = await backend.isAvailable();
	assert.equal(result, true, "isAvailable must be true when tmux server reachable");
	assert.ok(executor.calls.length >= 1, "isAvailable must call tmux has-session");
	assert.deepEqual(executor.calls[0].args, ["has-session", "-t", "__pi_probe__"]);
}
{
	const prevTmux = process.env.TMUX;
	process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
	const { executor, backend } = freshBackend();
	const result = await backend.isAvailable();
	assert.equal(result, true, "isAvailable must short-circuit to true when $TMUX set");
	assert.equal(executor.calls.length, 0, "isAvailable must NOT call tmux when $TMUX set");
	if (prevTmux === undefined) delete process.env.TMUX;
	else process.env.TMUX = prevTmux;
}
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: false, stderr: "tmux: command not found", exitCode: 1 });
	const result = await backend.isAvailable();
	assert.equal(result, false, "isAvailable must be false when tmux missing");
}
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: false, stderr: "no server running", exitCode: 1 });
	const result = await backend.isAvailable();
	assert.equal(result, false, "isAvailable must be false when server unreachable");
}
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: false, stderr: "", exitCode: -1, simulateTimeout: true });
	const result = await backend.isAvailable();
	assert.equal(result, false, "isAvailable must return false on timeout, NOT throw");
}

// Group 3: launch argv construction security (5 tests)
{
	const { executor, backend, bgStateDir, workerPath } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	assert.equal(result.status, "ok", "launch must succeed");
	const launchCall = executor.calls.find(function _c(c) { return c.args[0] === "new-window"; });
	assert.ok(launchCall, "new-window argv must be present");
	assert.deepEqual(launchCall.args, [
		"new-window", "-d", "-n", SAMPLE_WINDOW_NAME, "-c", SAMPLE_CWD,
		"-P", "-F", "#{window_id}", "--",
		workerPath, manifestPath,
	], "argv must contain ONLY workerPath + manifestPath, no agentName/runId/cwd/task");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	const evilName = "scout; touch /tmp/pwned; echo pwned";
	await backend.launch({ agentName: evilName, runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	const launchCall = executor.calls.find(function _c(c) { return c.args[0] === "new-window"; });
	assert.ok(launchCall, "new-window call must be present");
	const newWindowStr = launchCall.args.join(" ");
	assert.ok(!newWindowStr.includes("touch"), "agentName shell-metachar must NOT reach new-window argv");
	assert.ok(!newWindowStr.includes("pwned"), "agentName content must NOT reach new-window argv");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	const agentName = "scout; touch /tmp/pwned";
	await backend.launch({ agentName, runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	const setOptCalls = executor.calls.filter(function _c(c) { return c.args[0] === "set-window-option"; });
	const agentNameCall = setOptCalls.find(function _c(c) { return c.args.includes("@pi_agent_name"); });
	assert.ok(agentNameCall, "set-window-option for @pi_agent_name must be issued");
	assert.ok(agentNameCall.args.includes(agentName), "agentName MUST appear in @pi_agent_name argv as discrete token");
	const newWindowCall = executor.calls.find(function _c(c) { return c.args[0] === "new-window"; });
	const newWindowStr = newWindowCall.args.join(" ");
	assert.ok(!newWindowStr.includes("touch"), "agentName metachar must NOT be in new-window argv");
	assert.ok(!newWindowStr.includes("pwned"), "agentName content must NOT be in new-window argv");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	const launchCall = executor.calls.find(function _c(c) { return c.args[0] === "new-window"; });
	// REQ-5 mandates the window name be `pi-agent-<runId>`, so runId DOES appear
	// inside the `-n <windowName>` argv element. The discriminator is that runId
	// must NOT appear as a standalone token (i.e. not in cwd, worker, manifest, etc.).
	const runIdOccurrences = launchCall.args.filter(function _a(a) { return a === SAMPLE_RUN_ID; }).length;
	assert.equal(runIdOccurrences, 0, "runId must not appear as a standalone argv token");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	const launchCall = executor.calls.find(function _c(c) { return c.args[0] === "new-window"; });
	for (const arg of launchCall.args) {
		assert.ok(!arg.includes(";"), "no shell-metachar ; in argv: " + arg);
		assert.ok(!arg.includes("|"), "no pipe in argv: " + arg);
		assert.ok(!arg.includes("&"), "no & in argv: " + arg);
		assert.ok(!arg.includes("$"), "no $ in argv: " + arg);
	}
}

// Group 4: launch path escaping (4 tests)
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	const launchCall = executor.calls.find(function _c(c) { return c.args[0] === "new-window"; });
	const workerIdx = launchCall.args.indexOf("--") + 1;
	assert.equal(launchCall.args[workerIdx + 1], manifestPath, "manifestPath MUST be a single argv token, not split");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	const launchCall = executor.calls.find(function _c(c) { return c.args[0] === "new-window"; });
	for (const arg of launchCall.args) {
		assert.ok(!arg.includes("'") || arg.startsWith("'") && arg.endsWith("'"), "args must be shell-escaped with single-quote wrapping");
	}
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const spaceDir = path.join(bgStateDir, "dir with space");
	fs.mkdirSync(spaceDir, { recursive: true });
	const manifestPath = path.join(spaceDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	const launchCall = executor.calls.find(function _c(c) { return c.args[0] === "new-window"; });
	const manifestIdx = launchCall.args.indexOf(manifestPath);
	assert.ok(manifestIdx >= 0, "manifestPath with space must be a single argv token (not split on space)");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const qDir = path.join(bgStateDir, "It's a dir");
	fs.mkdirSync(qDir, { recursive: true });
	const manifestPath = path.join(qDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	const launchCall = executor.calls.find(function _c(c) { return c.args[0] === "new-window"; });
	const manifestIdx = launchCall.args.indexOf(manifestPath);
	assert.ok(manifestIdx >= 0, "manifestPath with single quote must be a single argv token");
}

// Group 5: launch input validation (7 tests, REQ-20 + REQ-21)
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: "./relative" });
	assert.equal(result.status, "failed", "relative cwd must be rejected");
	assert.equal(result.error, "invalid cwd", "error must be 'invalid cwd'");
	assert.equal(executor.calls.length, 0, "tmux must NOT be invoked when cwd is invalid");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: "/Users/me/../etc" });
	assert.equal(result.status, "failed", "cwd with .. must be rejected");
	assert.equal(result.error, "invalid cwd");
	assert.equal(executor.calls.length, 0, "tmux must NOT be invoked when cwd has ..");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	assert.equal(result.status, "ok", "valid absolute cwd must be accepted");
}
{
	const { executor, backend } = freshBackend();
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath: "relative/manifest.json", cwd: SAMPLE_CWD });
	assert.equal(result.status, "failed", "relative manifestPath must be rejected");
	assert.equal(result.error, "invalid manifest path");
	assert.equal(executor.calls.length, 0, "tmux must NOT be invoked when manifestPath invalid");
}
{
	const { executor, backend } = freshBackend();
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath: "/Users/me/../etc/passwd", cwd: SAMPLE_CWD });
	assert.equal(result.status, "failed", "manifestPath with .. must be rejected");
	assert.equal(result.error, "invalid manifest path");
	assert.equal(executor.calls.length, 0, "tmux must NOT be invoked when manifestPath has ..");
}
{
	const { executor, backend } = freshBackend();
	const outsidePath = "/etc/passwd";
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath: outsidePath, cwd: SAMPLE_CWD });
	assert.equal(result.status, "failed", "manifestPath outside bgStateDir must be rejected");
	assert.equal(result.error, "invalid manifest path");
	assert.equal(executor.calls.length, 0, "tmux must NOT be invoked when manifestPath outside bgStateDir");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	assert.equal(result.status, "ok", "valid manifestPath under bgStateDir must be accepted");
}

// Group 6: launch window naming and options (4 tests)
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	const launchCall = executor.calls.find(function _c(c) { return c.args[0] === "new-window"; });
	const nameIdx = launchCall.args.indexOf("-n") + 1;
	assert.equal(launchCall.args[nameIdx], SAMPLE_WINDOW_NAME, "window name MUST be pi-agent-<FULL-runId>, no truncation");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, "x", "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	const runIdA = "bg-1719432000000-a3f9c2b1";
	const runIdB = "bg-1719432000001-a3f9c2b1";
	const r1 = await backend.launch({ agentName: "scout", runId: runIdA, manifestPath, cwd: SAMPLE_CWD });
	const r2 = await backend.launch({ agentName: "scout", runId: runIdB, manifestPath, cwd: SAMPLE_CWD });
	assert.equal(r1.status, "ok");
	assert.equal(r2.status, "ok");
	assert.notEqual(r1.windowId, r2.windowId, "concurrent launches with colliding 16-hex prefix must produce distinct window names");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	const runIdCall = executor.calls.find(function _c(c) { return c.args[0] === "set-window-option" && c.args.includes("@pi_run_id"); });
	assert.ok(runIdCall, "set-window-option @pi_run_id MUST be issued");
	assert.equal(runIdCall.args[runIdCall.args.indexOf("@pi_run_id") + 1], SAMPLE_RUN_ID, "@pi_run_id value MUST equal runId");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	const agentCall = executor.calls.find(function _c(c) { return c.args[0] === "set-window-option" && c.args.includes("@pi_agent_name"); });
	assert.ok(agentCall, "set-window-option @pi_agent_name MUST be issued");
	assert.equal(agentCall.args[agentCall.args.indexOf("@pi_agent_name") + 1], "scout", "@pi_agent_name value MUST equal agentName");
}

// Group 7: launch UX and error handling (4 tests)
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	assert.equal(result.status, "ok");
	assert.equal(result.windowId, SAMPLE_WINDOW_NAME);
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	const launchCall = executor.calls.find(function _c(c) { return c.args[0] === "new-window"; });
	const cwdIdx = launchCall.args.indexOf("-c") + 1;
	assert.equal(launchCall.args[cwdIdx], SAMPLE_CWD, "cwd MUST be passed via -c per-window option");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	executor.enqueueResponse({ ok: false, stderr: "tmux: command failed: some error at " + "/abs/worker.ts and " + manifestPath + " yikes", exitCode: 1 });
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	assert.equal(result.status, "failed");
	assert.ok(result.error.length <= 513, "error MUST be truncated to 512 chars + ellipsis (got " + result.error.length + ")");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	const workerPath = "/abs/agents/lib/bg-worker.ts";
	executor.enqueueResponse({ ok: false, stderr: "error at " + workerPath + " and " + manifestPath, exitCode: 1 });
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	assert.equal(result.status, "failed");
	assert.ok(!result.error.includes(workerPath), "workerPath MUST be redacted in error (leaked: " + result.error + ")");
	assert.ok(result.error.includes("<worker>"), "workerPath MUST be replaced with <worker>");
	assert.ok(result.error.includes("<manifest>"), "manifestPath MUST be replaced with <manifest>");
}

// Group 8: launch resilience (2 tests)
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	executor.enqueueResponse({ simulateTimeout: true });
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	assert.equal(result.status, "failed");
	assert.equal(result.error, "tmux timed out after 10000ms");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	executor.enqueueResponse({ ok: true });
	executor.enqueueResponse({ ok: false, stderr: "user option not writable", exitCode: 1 });
	executor.enqueueResponse({ ok: false, stderr: "user option not writable", exitCode: 1 });
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	assert.equal(result.status, "ok", "launch MUST succeed even if set-window-option fails (best-effort)");
	assert.equal(result.windowId, SAMPLE_WINDOW_NAME);
}

// Group 9: kill (3 tests)
{
	const { executor, backend } = freshBackend();
	executor.enqueueResponse({ ok: true });
	const result = await backend.kill(SAMPLE_WINDOW_NAME);
	assert.equal(result.status, "ok");
	const killCall = executor.calls.find(function _c(c) { return c.args[0] === "kill-window"; });
	assert.deepEqual(killCall.args, ["kill-window", "-t", SAMPLE_WINDOW_NAME]);
}
{
	const { executor, backend } = freshBackend();
	executor.enqueueResponse({ ok: false, stderr: "can't find window pi-agent-bg-x", exitCode: 1 });
	const result = await backend.kill("pi-agent-bg-x");
	assert.equal(result.status, "ok", "kill on missing window MUST be idempotent");
}
{
	const { executor, backend } = freshBackend();
	executor.enqueueResponse({ ok: false, stderr: "can't find window exact", exitCode: 1 });
	const result = await backend.kill("exact");
	assert.equal(result.status, "ok", "kill on missing window MUST be idempotent (not error on foreign handle)");
	const killCall = executor.calls[0];
	assert.deepEqual(killCall.args, ["kill-window", "-t", "exact"], "kill MUST use exact-match -t value, not substring");
}

// Group 10: isAlive (5 tests)
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: true, stdout: SAMPLE_WINDOW_NAME + "\nother\n", stderr: "", exitCode: 0 });
	const alive = await backend.isAlive(SAMPLE_WINDOW_NAME);
	assert.equal(alive, true);
}
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: true, stdout: "pi-agent-bg-other-window\n", stderr: "", exitCode: 0 });
	const alive = await backend.isAlive(SAMPLE_WINDOW_NAME);
	assert.equal(alive, false, "isAlive MUST return false for non-matching window");
}
{
	const { executor, backend } = freshBackend();
	const alive = await backend.isAlive("");
	assert.equal(alive, false, "isAlive MUST return false for empty handle");
	assert.equal(executor.calls.length, 0, "isAlive MUST NOT call tmux for empty handle");
}
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: false, stderr: "no server running", exitCode: 1 });
	const alive = await backend.isAlive(SAMPLE_WINDOW_NAME);
	assert.equal(alive, false, "isAlive MUST return false on tmux error, NOT throw");
}
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: true, stdout: "exact-match-test\n", stderr: "", exitCode: 0 });
	const alive = await backend.isAlive("exact");
	assert.equal(alive, false, "isAlive MUST NOT substring-match (prefix would falsely match)");
}

// Group 11: list (5 tests)
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: true, stdout: SAMPLE_WINDOW_NAME + " " + SAMPLE_RUN_ID + " scout\nother\n", stderr: "", exitCode: 0 });
	const entries = await backend.list();
	assert.equal(entries.length, 1, "list MUST filter to pi-agent- prefix only");
	assert.equal(entries[0].windowId, SAMPLE_WINDOW_NAME);
}
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: true, stdout: SAMPLE_WINDOW_NAME + " " + SAMPLE_RUN_ID + " scout\n", stderr: "", exitCode: 0 });
	const entries = await backend.list();
	assert.equal(entries.length, 1);
	assert.equal(entries[0].windowId, SAMPLE_WINDOW_NAME, "windowId MUST equal literal 'pi-agent-bg-1719432000000-a3f9c2b1e8f4d2b6'");
	assert.equal(entries[0].runId, SAMPLE_RUN_ID, "runId MUST equal literal 'bg-1719432000000-a3f9c2b1e8f4d2b6' (B5 concrete fixture)");
	assert.equal(entries[0].agentName, "scout", "agentName MUST equal literal 'scout'");
}
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: false, stderr: "no server", exitCode: 1 });
	const entries = await backend.list();
	assert.deepEqual(entries, [], "list MUST return [] on tmux error, NOT throw");
}
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: true, stdout: "vim\nbash\nhtop\n" + SAMPLE_WINDOW_NAME + " " + SAMPLE_RUN_ID + " scout\n", stderr: "", exitCode: 0 });
	const entries = await backend.list();
	assert.equal(entries.length, 1, "list MUST filter non-pi-agent windows");
	assert.equal(entries[0].windowId, SAMPLE_WINDOW_NAME);
}
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: true, stdout: SAMPLE_WINDOW_NAME + "  \n", stderr: "", exitCode: 0 });
	const entries = await backend.list();
	assert.equal(entries.length, 1);
	assert.equal(entries[0].runId, undefined, "race: @pi_run_id unset → runId MUST be undefined (REQ-22)");
	assert.equal(entries[0].agentName, undefined);
}

console.log("P5 tmux-backend tests passed");