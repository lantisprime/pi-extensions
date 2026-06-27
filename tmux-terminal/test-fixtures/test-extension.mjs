// P5 test-extension.mjs — 6 tests (Groups 12, 13 missing-worker, 14).
import assert from "node:assert/strict";
import tmuxTerminalExtension from "../index.ts";
import { __resetBgTerminalBackend, getBgTerminalBackend, registerBgTerminalBackend } from "../../agents/lib/bg-terminal.ts";
import { __setResolveWorkerPathForTest, __resetResolveWorkerPathForTest } from "../lib/resolve-worker-path.ts";

function fakePi() {
	const handlers = new Map();
	return {
		on(event, handler) { handlers.set(event, handler); },
		dispatch(event) { const h = handlers.get(event); if (h) return h(); },
	};
}

// Group 12 + Group 13 (missing-worker) + Group 14: 6 tests
{
	// testRegistersOnSessionStart
	__resetBgTerminalBackend();
	__resetResolveWorkerPathForTest();
	__setResolveWorkerPathForTest(function _r() { return "/abs/agents/lib/bg-worker.ts"; });
	const pi = fakePi();
	tmuxTerminalExtension(pi);
	pi.dispatch("session_start");
	const backend = getBgTerminalBackend();
	assert.ok(backend !== null, "backend MUST be registered after session_start");
	assert.equal(backend.name, "tmux");
}
{
	// testRegistersIdempotently
	__resetBgTerminalBackend();
	__resetResolveWorkerPathForTest();
	__setResolveWorkerPathForTest(function _r() { return "/abs/agents/lib/bg-worker.ts"; });
	const pi = fakePi();
	tmuxTerminalExtension(pi);
	pi.dispatch("session_start");
	const first = getBgTerminalBackend();
	pi.dispatch("session_start");
	const second = getBgTerminalBackend();
	assert.equal(second, first, "idempotent: second session_start MUST NOT re-register");
}
{
	// testRegistryFirstWinsAcrossLoadOrders: a sibling backend registered first MUST win
	__resetBgTerminalBackend();
	__resetResolveWorkerPathForTest();
	__setResolveWorkerPathForTest(function _r() { return "/abs/agents/lib/bg-worker.ts"; });
	const sibling = { name: "sibling", async isAvailable() { return true; }, async launch() { return { status: "ok" }; }, async kill() { return { status: "ok" }; }, async isAlive() { return false; }, async list() { return []; } };
	registerBgTerminalBackend(sibling);
	const pi = fakePi();
	tmuxTerminalExtension(pi);
	pi.dispatch("session_start");
	const got = getBgTerminalBackend();
	assert.equal(got, sibling, "first-wins: sibling registered before tmux-terminal MUST remain the active backend");
}
{
	// testRegistryRejectsDuplicateOnReload: reload of tmux-terminal MUST NOT replace existing registration
	__resetBgTerminalBackend();
	__resetResolveWorkerPathForTest();
	__setResolveWorkerPathForTest(function _r() { return "/abs/agents/lib/bg-worker.ts"; });
	const pi = fakePi();
	tmuxTerminalExtension(pi);
	pi.dispatch("session_start");
	const first = getBgTerminalBackend();
	// Simulate reload by calling session_start again on a fresh extension instance
	const pi2 = fakePi();
	tmuxTerminalExtension(pi2);
	pi2.dispatch("session_start");
	const second = getBgTerminalBackend();
	assert.equal(second, first, "reload: second registration MUST be dropped silently (first-wins)");
}
{
	// testExtensionSkipsRegistrationWhenWorkerMissing (B2b force-null)
	__resetBgTerminalBackend();
	__resetResolveWorkerPathForTest();
	__setResolveWorkerPathForTest(function _r() { return null; });
	const pi = fakePi();
	tmuxTerminalExtension(pi);
	pi.dispatch("session_start");
	assert.equal(getBgTerminalBackend(), null, "missing worker MUST skip registration (REQ-12 + B2b)");
}
{
	// testExtensionLoadsWithoutAgentsPresent (Group 14)
	const noOnPi = { on: undefined };
	tmuxTerminalExtension(noOnPi);
	assert.equal(getBgTerminalBackend(), null, "tmux-terminal MUST NOT crash when pi.on is absent");
}

console.log("P5 extension tests passed");