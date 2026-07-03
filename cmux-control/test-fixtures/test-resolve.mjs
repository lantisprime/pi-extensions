// P5d-S4: cmux-control resolve tests.
import assert from "node:assert/strict";
import { resolveRunId } from "../lib/resolve.ts";
import { FakeCmuxExecutor } from "./fake-cmux-executor.ts";
import { __resetBgTerminalBackend, registerBgTerminalBackend } from "../../agents/lib/bg-terminal.ts";

function fakeBackend(entries, name = "cmux") {
	return {
		name,
		async launch() { return { status: "ok", windowId: "workspace:unused" }; },
		async kill() { return { status: "ok" }; },
		async isAlive() { return true; },
		async list() { return entries; },
	};
}

// ResolveViaBackend
{
	__resetBgTerminalBackend();
	registerBgTerminalBackend(fakeBackend([
		{ windowId: "workspace:7", runId: "bg-resolve-123", agentName: "scout" },
	]));
	const executor = new FakeCmuxExecutor();

	const resolved = await resolveRunId("bg-resolve-123", executor);

	assert.deepEqual(resolved, {
		ok: true,
		workspaceRef: "workspace:7",
		agentName: "scout",
		source: "backend",
	});
	assert.equal(executor.calls.length, 0, "backend match should not call cmux fallback");
	__resetBgTerminalBackend();
}

// ResolveRejectsNonCmuxBackend
{
	__resetBgTerminalBackend();
	registerBgTerminalBackend(fakeBackend([
		{ windowId: "@9", runId: "bg-tmux-123", agentName: "scout" },
	], "tmux"));
	const executor = new FakeCmuxExecutor();

	const resolved = await resolveRunId("bg-tmux-123", executor);

	assert.equal(resolved.ok, false);
	assert.match(resolved.error, /selected background terminal backend is "tmux", not "cmux"/);
	assert.equal(executor.calls.length, 0, "wrong selected backend should not fall back to cmux scan");
	__resetBgTerminalBackend();
}

// ResolveBackendUnavailable
{
	__resetBgTerminalBackend();
	const executor = new FakeCmuxExecutor();
	executor.enqueueResponse({ ok: true, stdout: JSON.stringify({ workspaces: [] }) });

	const resolved = await resolveRunId("bg-missing-123", executor);

	assert.equal(resolved.ok, false);
	assert.match(resolved.error, /no workspace found for runId "bg-missing-123"/);
	assert.deepEqual(executor.calls[0].args, ["workspace", "list", "--json"]);
	__resetBgTerminalBackend();
}

console.log("test-resolve: all tests passed");
