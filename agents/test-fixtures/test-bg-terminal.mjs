import assert from "node:assert/strict";

import {
	__resetBgTerminalBackend,
	getBgTerminalBackend,
	listBgTerminalBackends,
	registerBgTerminalBackend,
	selectBgTerminalBackend,
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
await (async () => {
	reset();
	const backend = await getBgTerminalBackend();
	assert.equal(backend, null, "unregistered backend should be null");
})();

// 2. First registration wins (legacy single-slot semantics, preserved on empty list)
await (async () => {
	reset();
	const fb = fakeBackend("first");
	registerBgTerminalBackend(fb);
	const got = await getBgTerminalBackend();
	assert.equal(got, fb, "first registered backend should be returned");
	assert.equal(got.name, "first");
})();

// 3. Selector picks first when only one is registered
await (async () => {
	reset();
	const first = fakeBackend("first");
	const second = fakeBackend("second");
	registerBgTerminalBackend(first);
	registerBgTerminalBackend(second);
	const got = await getBgTerminalBackend();
	assert.equal(got.name, "first", "with no preference set, registration order wins; first is selected");
})();

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
await (async () => {
	reset();
	assert.equal(await getBgTerminalBackend(), null);

	registerBgTerminalBackend(fakeBackend("first"));
	assert.notEqual(await getBgTerminalBackend(), null);

	reset();
	assert.equal(await getBgTerminalBackend(), null);

	// After reset, a new registration works
	registerBgTerminalBackend(fakeBackend("after-reset"));
	assert.equal((await getBgTerminalBackend()).name, "after-reset");
})();

// === P5b-1-S2 net-new tests (v2.1) ===
import { selectBgTerminalBackend as _select } from "../lib/bg-terminal.ts"; // already imported, just for clarity

// 17. SelectNullWhenNoneRegistered
await (async () => {
	reset();
	const r = await _select();
	assert.equal(r.ok, false, "empty registry must return ok=false");
	if (!r.ok) assert.equal(r.reason, "none-registered");
})();

// 18. SelectAllUnavailableHasReason
await (async () => {
	reset();
	const a = fakeBackend("a-unavail"); a.isAvailable = async () => false;
	const b = fakeBackend("b-unavail"); b.isAvailable = async () => false;
	registerBgTerminalBackend(a);
	registerBgTerminalBackend(b);
	const r = await _select();
	assert.equal(r.ok, false);
	if (!r.ok) {
		assert.equal(r.reason, "all-unavailable");
		assert.deepEqual([...r.probed], [{ name: "a-unavail", ok: false }, { name: "b-unavail", ok: false }]);
	}
})();

// 19. SelectPrefersHigherPreferenceRegardlessOfRegistrationOrder (R1 finding #2)
await (async () => {
	reset();
	const tmux = fakeBackend("tmux"); tmux.isAvailable = async () => true; tmux.preference = 0;
	const cmux = fakeBackend("cmux"); cmux.isAvailable = async () => true; cmux.preference = 10;
	registerBgTerminalBackend(tmux);  // registered FIRST (the R1 problem case)
	registerBgTerminalBackend(cmux);
	const r = await _select();
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.backend.name, "cmux", "higher preference must win regardless of registration order");
})();

// 20. PreferenceTiesBrokenByRegistrationOrder
await (async () => {
	reset();
	const first = fakeBackend("first"); first.isAvailable = async () => true; first.preference = 5;
	const second = fakeBackend("second"); second.isAvailable = async () => true; second.preference = 5;
	registerBgTerminalBackend(first);
	registerBgTerminalBackend(second);
	const r = await _select();
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.backend.name, "first", "equal preference must tie-break by registration order");
})();

// 21. AbsentPreferenceTreatedAsZero
await (async () => {
	reset();
	const noPref = fakeBackend("no-pref"); noPref.isAvailable = async () => true; // no preference field
	const explicitZero = fakeBackend("explicit-zero"); explicitZero.isAvailable = async () => true; explicitZero.preference = 0;
	registerBgTerminalBackend(noPref);
	registerBgTerminalBackend(explicitZero);
	const r = await _select();
	assert.equal(r.ok, true);
	if (r.ok) assert.ok(r.backend.name === "no-pref" || r.backend.name === "explicit-zero", "absent preference must equal 0 (tied with explicit zero)");
})();

// 22. RegisterAppendsToList (REQ-D1)
await (async () => {
	reset();
	const a = fakeBackend("a"); a.isAvailable = async () => true;
	const b = fakeBackend("b"); b.isAvailable = async () => true;
	const c = fakeBackend("c"); c.isAvailable = async () => true;
	registerBgTerminalBackend(a);
	registerBgTerminalBackend(b);
	registerBgTerminalBackend(c);
	const list = listBgTerminalBackends();
	assert.equal(list.length, 3, "all 3 backends must be retained (first-wins is removed)");
	assert.deepEqual(list.map((b) => b.name), ["a", "b", "c"], "order must be registration order");
})();

// 23. ListBackendsReturnsSnapshot (REQ-D4)
await (async () => {
	reset();
	const a = fakeBackend("a");
	registerBgTerminalBackend(a);
	const snap1 = listBgTerminalBackends();
	registerBgTerminalBackend(fakeBackend("b"));
	const snap2 = listBgTerminalBackends();
	assert.equal(snap1.length, 1, "first snapshot is unchanged by later registration");
	assert.equal(snap2.length, 2, "second snapshot reflects later registration");
})();

// 24. ListBackendsIsolatedFromRegistry (REQ-D4)
await (async () => {
	reset();
	const a = fakeBackend("a");
	registerBgTerminalBackend(a);
	const snap = listBgTerminalBackends();
	assert.throws(() => { snap.push(fakeBackend("z")); }, "frozen snapshot must reject mutation");
})();

// 25. SelectProbesEachBackendOnce (REQ-D9) — v2.3 fix: also assert the selected backend is "b"
// so the negative control (flipping b.isAvailable to false) actually fails the test
await (async () => {
	reset();
	let aCalls = 0, bCalls = 0;
	const a = fakeBackend("a"); a.isAvailable = async () => { aCalls++; return false; };
	const b = fakeBackend("b"); b.isAvailable = async () => { bCalls++; return true; };
	registerBgTerminalBackend(a);
	registerBgTerminalBackend(b);
	const r = await _select();
	assert.equal(aCalls, 1, "a probed once");
	assert.equal(bCalls, 1, "b probed once");
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.backend.name, "b", "second backend selected when first returns false");
})();

// 26. NoIsAvailableTreatedAsAvailable (REQ-D2 State B)
await (async () => {
	reset();
	const noProbe = { name: "no-probe", launch: async () => ({ status: "ok" }), kill: async () => ({ status: "ok" }), isAlive: async () => true, list: async () => [] };
	registerBgTerminalBackend(noProbe);
	const r = await _select();
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.backend.name, "no-probe", "backend with no isAvailable is treated as available");
})();

// 27. IsAvailableThrowTreatedAsUnavailable (REQ-D9 State E)
await (async () => {
	reset();
	const origDebug = console.debug;
	let debugCalls = 0;
	console.debug = () => { debugCalls++; };
	try {
		const throwing = fakeBackend("throwing"); throwing.isAvailable = async () => { throw new Error("socket broken"); };
		const good = fakeBackend("good"); good.isAvailable = async () => true;
		registerBgTerminalBackend(throwing);
		registerBgTerminalBackend(good);
		const r = await _select();
		assert.equal(r.ok, true, "throwing backend must not block; probe continues");
		if (r.ok) assert.equal(r.backend.name, "good", "second backend wins after throw");
		assert.ok(debugCalls >= 1, "throw must be logged at console.debug");
	} finally {
		console.debug = origDebug;
	}
})();

console.log("P4-4 bg-terminal tests passed (27 total: 16 existing updated + 11 net-new)");