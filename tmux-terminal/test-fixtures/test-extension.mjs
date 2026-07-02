// P5 test-extension.mjs — 6 tests (Groups 12, 13 missing-worker, 14).
// P5b-1-S2 updates: getBgTerminalBackend() is now async + probes availability.
// "Registered" assertions use listBgTerminalBackends(); "selected" assertions
// use getBgTerminalBackend(). Legacy single-slot tests rewritten to assert
// registration persistence (REQ-D1) — both backends coexist in the multi-backend
// registry.
import assert from "node:assert/strict";
import tmuxTerminalExtension from "../index.ts";
import { __resetBgTerminalBackend, getBgTerminalBackend, listBgTerminalBackends, registerBgTerminalBackend } from "../../agents/lib/bg-terminal.ts";
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

// Group 12 + Group 13 (missing-worker) + Group 14: 6 tests
await (async () => {
	// testRegistersOnSessionStart — assert registration, not selection (selector may
	// return null if tmux daemon is unavailable in the test environment).
	__resetBgTerminalBackend();
	__resetResolveWorkerPathForTest();
	__setResolveWorkerPathForTest(function _r() { return "/abs/agents/lib/bg-worker.ts"; });
	const pi = fakePi();
	tmuxTerminalExtension(pi);
	pi.dispatch("session_start");
	const list = listBgTerminalBackends();
	assert.equal(list.length, 1, "backend MUST be registered after session_start");
	assert.equal(list[0].name, "tmux", "tmux-terminal registered the tmux backend");
})();
await (async () => {
	// testRegistersIdempotently — same-pi dispatch now appends (single-slot is removed).
	// First dispatch registers 1 backend; second dispatch registers a second copy.
	// The selector still returns the first-registered (preference tie-break).
	__resetBgTerminalBackend();
	__resetResolveWorkerPathForTest();
	__setResolveWorkerPathForTest(function _r() { return "/abs/agents/lib/bg-worker.ts"; });
	const pi = fakePi();
	tmuxTerminalExtension(pi);
	pi.dispatch("session_start");
	const firstList = listBgTerminalBackends();
	const first = firstList[0];
	pi.dispatch("session_start");
	const secondList = listBgTerminalBackends();
	assert.equal(secondList.length, firstList.length + 1, "same-pi: re-dispatch appends (single-slot removed)");
	assert.equal(secondList[0], first, "first registration is preserved at index 0");
})();
await (async () => {
	// testRegistryPersistsAcrossLoadOrders: a sibling backend registered first MUST remain
	// in the registry alongside tmux-terminal. Selector returns the available backend
	// (sibling's isAvailable returns true; tmux's may return false in test env).
	__resetBgTerminalBackend();
	__resetResolveWorkerPathForTest();
	__setResolveWorkerPathForTest(function _r() { return "/abs/agents/lib/bg-worker.ts"; });
	registerBgTerminalBackend(siblingBackend("sibling"));
	const pi = fakePi();
	tmuxTerminalExtension(pi);
	pi.dispatch("session_start");
	const list = listBgTerminalBackends();
	assert.equal(list.length, 2, "both backends must be retained (REQ-D1 — append-only registry)");
	assert.equal(list[0].name, "sibling", "registration order preserved");
	assert.equal(list[1].name, "tmux", "tmux-terminal appended after sibling");
	// Selector should pick the available one. If tmux daemon is running, tmux wins by
	// registration order; if not, sibling wins.
	const got = await getBgTerminalBackend();
	assert.ok(got, "selector must return an available backend");
})();
await (async () => {
	// testRegistryAppendsOnReload: a second extension instance appends to the list
	// (legacy single-slot is removed). Same-pi instance does not (tested above).
	__resetBgTerminalBackend();
	__resetResolveWorkerPathForTest();
	__setResolveWorkerPathForTest(function _r() { return "/abs/agents/lib/bg-worker.ts"; });
	const pi = fakePi();
	tmuxTerminalExtension(pi);
	pi.dispatch("session_start");
	const before = listBgTerminalBackends();
	// Simulate reload: a fresh extension instance dispatches session_start.
	const pi2 = fakePi();
	tmuxTerminalExtension(pi2);
	pi2.dispatch("session_start");
	const after = listBgTerminalBackends();
	assert.equal(after.length, before.length + 1, "reload appends a second registration; single-slot is removed");
})();
await (async () => {
	// testExtensionSkipsRegistrationWhenWorkerMissing (B2b force-null)
	__resetBgTerminalBackend();
	__resetResolveWorkerPathForTest();
	__setResolveWorkerPathForTest(function _r() { return null; });
	const pi = fakePi();
	tmuxTerminalExtension(pi);
	pi.dispatch("session_start");
	assert.equal(listBgTerminalBackends().length, 0, "missing worker MUST skip registration (REQ-12 + B2b)");
})();
await (async () => {
	// testExtensionLoadsWithoutAgentsPresent (Group 14)
	const noOnPi = { on: undefined };
	tmuxTerminalExtension(noOnPi);
	assert.equal(listBgTerminalBackends().length, 0, "tmux-terminal MUST NOT crash when pi.on is absent");
});

console.log("P5 extension tests passed");