// P5b-2 test-extension.mjs — extension-surface tests for zellij-terminal.
//
// Mirrors tmux-terminal/test-fixtures/test-extension.mjs:
//   - loads the extension default export
//   - asserts registerBgTerminalBackend was called with a backend whose
//     name === "zellij"
//   - tests the worker-missing skip path
//   - tests the pi.on missing graceful-skip path
import assert from "node:assert/strict";
import zellijTerminalExtension from "../index.ts";
import { __resetBgTerminalBackend, listBgTerminalBackends, registerBgTerminalBackend } from "../../agents/lib/bg-terminal.ts";
import { __setResolveWorkerPathForTest, __resetResolveWorkerPathForTest } from "../lib/resolve-worker-path.ts";

function fakePi() {
	const handlers = new Map();
	return {
		on(event, handler) { handlers.set(event, handler); },
		dispatch(event) { const h = handlers.get(event); if (h) return h(); },
	};
}

function siblingBackend(name, isAvailable = true) {
	return {
		name,
		async isAvailable() { return isAvailable; },
		async launch() { return { status: "ok" }; },
		async kill() { return { status: "ok" }; },
		async isAlive() { return false; },
		async list() { return []; },
	};
}

// Group 1 (extension-surface): 4 tests — mirrors tmux-terminal's 6 with the
// preflight-skip variants removed (those are P5E1 concerns, not P5b-2).

await (async () => {
	// testRegistersOnSessionStart — zellij backend is registered
	__resetBgTerminalBackend();
	__resetResolveWorkerPathForTest();
	__setResolveWorkerPathForTest(function _r() { return "/abs/agents/lib/bg-worker.ts"; });
	const pi = fakePi();
	zellijTerminalExtension(pi);
	pi.dispatch("session_start");
	const list = listBgTerminalBackends();
	assert.equal(list.length, 1, "zellij backend MUST be registered after session_start");
	assert.equal(list[0].name, "zellij", "registered backend.name must be exactly 'zellij'");
	__resetResolveWorkerPathForTest();
})();

await (async () => {
	// testSkipsRegistrationWhenWorkerMissing — worker not found → no registration
	__resetBgTerminalBackend();
	__resetResolveWorkerPathForTest();
	__setResolveWorkerPathForTest(function _r() { return null; });
	const pi = fakePi();
	zellijTerminalExtension(pi);
	pi.dispatch("session_start");
	assert.equal(listBgTerminalBackends().length, 0, "missing worker MUST skip registration (REQ-1)");
	__resetResolveWorkerPathForTest();
})();

await (async () => {
	// testRegistryPersistsAcrossLoadOrders — a sibling backend registered first
	// remains in the registry alongside zellij-terminal. The selector returns
	// the available one (sibling's isAvailable returns true).
	__resetBgTerminalBackend();
	__resetResolveWorkerPathForTest();
	__setResolveWorkerPathForTest(function _r() { return "/abs/agents/lib/bg-worker.ts"; });
	registerBgTerminalBackend(siblingBackend("sibling"));
	const pi = fakePi();
	zellijTerminalExtension(pi);
	pi.dispatch("session_start");
	const list = listBgTerminalBackends();
	assert.equal(list.length, 2, "both backends must be retained (REQ-1, append-only registry)");
	assert.equal(list[0].name, "sibling", "registration order preserved");
	assert.equal(list[1].name, "zellij", "zellij-terminal appended after sibling");
})();

await (async () => {
	// testExtensionLoadsWithoutAgentsPresent — pi.on is undefined → no crash
	const noOnPi = { on: undefined };
	zellijTerminalExtension(noOnPi);
	assert.equal(listBgTerminalBackends().length, 0, "zellij-terminal MUST NOT crash when pi.on is absent");
});

console.log("P5b-2 zellij-extension tests passed");
