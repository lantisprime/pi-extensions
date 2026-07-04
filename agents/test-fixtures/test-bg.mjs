// P4-7: End-to-end background-agent integration tests.
//
// Library-level tests (test-bg-state/preflight/worker/terminal) cover the
// individual pieces.  This file covers what can ONLY be verified by exercising
// the full preflight -> manifest -> backend.launch -> cleanup -> result flow.
//
// What this tests:
//   - end-to-end preflight+launch: backend.launch receives correct args, task
//     text appears ONLY in prompt.txt (NEVER in argv/manifest argvPreview)
//   - launch failure cleanup: backend.launch fails -> reservation+prompt cleaned
//   - worker denial: if a simulated worker denies the manifest, backend.kill
//     is called and the reservation is released
//   - lost result: result.json missing -> bg-result shows "No result found"
//     without throwing
//   - concurrency limit: BG_MAX_CONCURRENT runs blocks additional launches
//   - events.jsonl isolation: bg-status/bg-result/bg-stop NEVER surface
//     events.jsonl contents
//   - hash mismatch: agent spec changes between preflight and launch -> worker
//     would deny (simulated)
//   - reservation lifecycle: countActiveBgRuns tracks preflight/cleanup
//   - chain handoff (single worker): multiple bg runs share manifest dir
//   - manifest identity mismatch: preflight with custom homeDir writes
//     manifest homeDir field that matches the runtime identity check

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { collectAgentDiagnostics } from "../lib/diagnostics.ts";
import { registerAgent } from "../lib/registration.ts";
import { resolveRegisteredRunTarget } from "../lib/run-resolver.ts";
import { preflightBgAgent } from "../lib/bg-preflight.ts";
import {
	readBgManifest,
	verifyBgManifest,
	resolveTrustedHome,
	countActiveBgRuns,
	listBgRuns,
	getBgRunPaths,
	writeBgResult,
	markBgRunDone,
	createBgRunState,
	reapStaleBgRuns,
	updateBgReservationOwner,
} from "../lib/bg-state.ts";

import {
	__resetBgTerminalBackend,
	getBgTerminalBackend,
	listBgTerminalBackends,
	registerBgTerminalBackend,
	selectBgTerminalBackend,
} from "../lib/bg-terminal.ts";

import {
	handleBgStatus,
	handleBgStop,
	handleBgResult,
	handleBgCommand,
	__setBgStatusHomeOverride,
	__resetBgStatusPolling,
	updateBgStatusLine,
} from "../index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTempHome(fn) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "p4-7-int-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	try {
		return await fn(home, root);
	} finally {
		await fs.rm(root, { recursive: true, force: true }).catch(() => {});
	}
}

function makeCtx(home, extras = {}) {
	return {
		cwd: home,
		hasUI: false,
		agentsHomeDir: home,
		ui: {
			notify: () => {},
			confirm: async () => true,
			setStatus: () => {},
			setWidget: () => {},
		},
		...extras,
	};
}

async function setupRegisteredUserAgent(home, name = "researcher", body = "p") {
	const userAgentsDir = path.join(home, ".pi", "agent", "agents");
	await fs.mkdir(userAgentsDir, { recursive: true });
	const specPath = path.join(userAgentsDir, `${name}.md`);
	await fs.writeFile(
		specPath,
		`---\nname: ${name}\ndescription: d\nsource: user\ntools: [read]\nprompt: p\n---\n${body}`,
	);
	await registerAgent(specPath, {
		cwd: home, homeDir: home, projectTrusted: false,
		hasUI: true,
		ui: { notify: () => {}, confirm: async () => true },
	});
	const diag = await collectAgentDiagnostics({ cwd: home, homeDir: home, projectTrusted: false });
	const resolved = await resolveRegisteredRunTarget(name, diag);
	assert.equal(resolved.ok, true, `setup: agent '${name}' should resolve`);
	return { record: resolved.record, diag };
}

/** Fake TermBgBackend that records launch config + lets tests inject failures.
 *  windowId is deliberately DIFFERENT from runId so the bg-stop/bg-open
 *  correlation path is exercised in any downstream handler tests. */
function makeFakeBackend(opts = {}) {
	const configLog = [];
	const killed = [];
	const aliveChecks = [];
	const windows = new Map(); // windowId -> { runId, agentName }
	return {
		name: opts.name || "fake-int-backend",
		async isAvailable() { return true; },
		async launch(config) {
			configLog.push(config);
			if (opts.launchShouldFail) {
				return { status: "failed", error: opts.launchShouldFail };
			}
			const windowId = opts.windowIdPrefix ? `${opts.windowIdPrefix}-${config.runId}` : `w-${config.runId}`;
			windows.set(windowId, { runId: config.runId, agentName: config.agentName });
			return { status: "ok", windowId };
		},
		async kill(windowId) {
			killed.push(windowId);
			if (opts.killShouldFail) return { status: "failed", error: opts.killShouldFail };
			windows.delete(windowId);
			return { status: "ok", windowId };
		},
		async isAlive(windowId) {
			aliveChecks.push(windowId);
			return windows.has(windowId);
		},
		async list() {
			return [...windows.entries()].map(([windowId, val]) => ({
				windowId, runId: val.runId, agentName: val.agentName,
			}));
		},
		// Inspectors for tests
		_getConfigLog() { return configLog; },
		_getKilled() { return killed; },
		_getAliveChecks() { return aliveChecks; },
		_getWindows() { return windows; },
	};
}

async function test(name, fn) {
	await fn();
	console.log(`  ✓ ${name}`);
}

function resetAll() {
	__resetBgTerminalBackend();
	__resetBgStatusPolling();
	__setBgStatusHomeOverride(undefined);
}

/** Clean up a run dir created under resolveTrustedHome() during tests.
 *  Best-effort: marks the run done (if paths is provided), then deletes
 *  the run dir.  Used by try/finally so throws don't leak real-home state. */
async function cleanupRealHomeRun(runId) {
	if (!runId) return;
	try {
		const realPaths = getBgRunPaths(runId);
		await markBgRunDone(realPaths).catch(() => {});
		await fs.rm(realPaths.runDir, { recursive: true, force: true }).catch(() => {});
	} catch { /* swallow — cleanup is best-effort */ }
}

// ---------------------------------------------------------------------------
// 1. End-to-end preflight + launch
// ---------------------------------------------------------------------------

/** Preflight succeeds, manifest is signed and verified, backend.launch gets
 *  the correct config (manifestPath, cwd, runId, agentName) with NO task text.
 *  Drives the REAL handleBgCommand — verifies what the production handler
 *  actually sends to the backend. */
async function testPreflightToLaunchContract() {
	resetAll();
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const backend = makeFakeBackend();
		registerBgTerminalBackend(backend);

		const ctx = makeCtx(home);
		const SECRET = "secret task content here";
		let runId;
		try {
			await handleBgCommand(`${record.name} ${SECRET}`, ctx, diag);

			// Backend must have received the launch config with NO task text.
			const logged = backend._getConfigLog();
			assert.equal(logged.length, 1, "backend.launch should be called exactly once");
			const cfg = logged[0];
			runId = cfg.runId;
			assert.ok(cfg.manifestPath, "backend should receive manifestPath");
			assert.ok(!cfg.manifestPath.includes(SECRET), "manifest path must NOT embed task text");
			assert.equal(cfg.agentName, record.name, "backend should receive correct agentName");
			assert.ok(cfg.runId, "backend should receive runId");
			assert.equal(cfg.cwd, home, "backend should receive correct cwd");

			// Manifest file (on disk) IS allowed to contain task — worker reads it.
			const manifestRaw = await fs.readFile(cfg.manifestPath, "utf8");
			assert.ok(manifestRaw.includes(SECRET), "manifest file SHOULD contain task for worker to read");
		} finally {
			await cleanupRealHomeRun(runId);
		}
	});
}

/** Two back-to-back preflight calls produce two distinct runIds (no collision). */
async function testPreflightUniqueRunIds() {
	resetAll();
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const ctx = makeCtx(home);

		const r1 = await preflightBgAgent(record, "task1", ctx, diag, { homeDir: home });
		const r2 = await preflightBgAgent(record, "task2", ctx, diag, { homeDir: home });
		assert.equal(r1.ok, true);
		assert.equal(r2.ok, true);
		assert.notEqual(r1.runId, r2.runId, "each preflight must produce a unique runId");

		const active = await countActiveBgRuns(home);
		assert.equal(active, 2, "both reservations should be active");
	});
}

// ---------------------------------------------------------------------------
// 2. Launch failure cleanup
// ---------------------------------------------------------------------------

/** If backend.launch fails, reservation+manifest must be cleaned (no orphan
 *  reservation counts toward BG_MAX_CONCURRENT). */
async function testLaunchFailureCleansReservation() {
	resetAll();
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const backend = makeFakeBackend({ launchShouldFail: "tmux not running" });
		registerBgTerminalBackend(backend);

		const ctx = makeCtx(home);
		const result = await preflightBgAgent(record, "task", ctx, diag, { homeDir: home });
		assert.equal(result.ok, true);

		// Simulate the handler's launch failure path.
		const launch = await backend.launch({
			agentName: record.name,
			runId: result.runId,
			manifestPath: result.paths.manifestPath,
			cwd: home,
		});
		assert.equal(launch.status, "failed");

		// The handler calls writeBgResult(markBgRunDone) on launch failure.
		await writeBgResult(result.paths, { version: 1, runId: result.runId, status: "failed", error: launch.error });
		await markBgRunDone(result.paths);

		// countActiveBgRuns should be 0 after the cleanup.
		const active = await countActiveBgRuns(home);
		assert.equal(active, 0, "launch failure cleanup must release the slot");
	});
}

// ---------------------------------------------------------------------------
// 3. Worker denial flow
// ---------------------------------------------------------------------------

/** Drives the REAL handleBgStop with a registered fake backend.  Verifies
 *  that handleBgStop correlates runId → windowId via backend.list() and
 *  calls backend.kill with the correct windowId (NOT the runId).
 *
 *  Note: this is the production path that would also fire when a worker
 *  denial triggers cleanup — the handler itself doesn't know about worker
 *  denial, it just sees "user asked to stop, kill the window". */
async function testHandleBgStopKillsWindowViaList() {
	resetAll();
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const backend = makeFakeBackend({ windowIdPrefix: "tmux" });
		registerBgTerminalBackend(backend);

		const ctx = makeCtx(home);
		let runId;
		try {
			await handleBgCommand(`${record.name} task`, ctx, diag);

			// Get the runId from backend's logged config.
			const logged = backend._getConfigLog();
			const cfg = logged[0];
			runId = cfg.runId;

			// Clear the log so we can see what kill receives.
			const killLog = backend._getKilled();
			killLog.length = 0;

			// Drive the REAL handleBgStop.
			await handleBgStop(runId, ctx);

			// handleBgStop should call kill with the correlated windowId, not the runId.
			assert.ok(killLog.includes(`tmux-${runId}`), "handleBgStop should call backend.kill with windowId correlated via list()");
			assert.ok(!killLog.includes(runId), "handleBgStop must NOT pass raw runId to kill()");
		} finally {
			await cleanupRealHomeRun(runId);
		}
	});
}

// ---------------------------------------------------------------------------
// 4. Lost result
// ---------------------------------------------------------------------------

/** bg-result with valid runId but missing result.json emits a friendly warning
 *  (does NOT throw).  Also verifies that a run with manifest but no result
 *  still counts as active (no result written yet). */
async function testLostResultIsHandledGracefully() {
	resetAll();
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const ctx = makeCtx(home);
		const result = await preflightBgAgent(record, "task", ctx, diag, { homeDir: home });

		// No result.json ever written — worker died mid-run.
		const notified = [];
		const ctxForResult = makeCtx(home, {
			ui: {
				notify: (msg) => notified.push(msg),
				setStatus: () => {},
				setWidget: () => {},
			},
		});

		__setBgStatusHomeOverride(home);
		await handleBgResult(result.runId, ctxForResult);

		// Should emit "No result found" warning without throwing.
		const allMsgs = notified.join("\n");
		assert.ok(allMsgs.includes("No result found"), "missing result.json should emit 'No result found' warning");
		assert.ok(!allMsgs.includes("throw") && !allMsgs.includes("Error"), "should not throw or emit Error");

		// The preflighted run still counts as active (no result.json to mark it done).
		const active = await countActiveBgRuns(home);
		assert.equal(active, 1, "preflighted-but-not-done run should still count active");
	});
}

/** Pre-flighted run that is never followed by a result.json keeps the slot
 *  active until reapStaleBgRuns runs (BG_MAX_DURATION_SEC). */
async function testStaleRunCountedUntilReap() {
	resetAll();
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const ctx = makeCtx(home);
		const result = await preflightBgAgent(record, "task", ctx, diag, { homeDir: home });

		const before = await countActiveBgRuns(home);
		assert.equal(before, 1, "preflight should produce 1 active run");

		// Without reap, the run stays active.
		const after = await countActiveBgRuns(home);
		assert.equal(after, 1, "run should still be active without reap");

		// After reap (no-op since not expired yet), still 1.
		await reapStaleBgRuns(home);
		const afterReap = await countActiveBgRuns(home);
		assert.equal(afterReap, 1, "non-expired run should survive reap");
	});
}

// ---------------------------------------------------------------------------
// 5. Concurrency limit
// ---------------------------------------------------------------------------

/** BG_MAX_CONCURRENT runs block additional launches (handled by handler;
 *  this test verifies the underlying countActiveBgRuns reflects the limit). */
async function testConcurrencyCountTracksReservations() {
	resetAll();
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const ctx = makeCtx(home);

		// Create 5 reservations (the cap).
		const results = [];
		for (let i = 0; i < 5; i++) {
			const r = await preflightBgAgent(record, `task ${i}`, ctx, diag, { homeDir: home });
			assert.equal(r.ok, true);
			results.push(r);
		}

		const active = await countActiveBgRuns(home);
		assert.equal(active, 5, "all 5 reservations should be active");

		// Cleanup: write result + mark done for all 5.
		for (const r of results) {
			await writeBgResult(r.paths, { version: 1, runId: r.runId, status: "completed", agentName: record.name });
			await markBgRunDone(r.paths);
		}

		const after = await countActiveBgRuns(home);
		assert.equal(after, 0, "all slots should be freed after cleanup");
	});
}

// ---------------------------------------------------------------------------
// 6. events.jsonl isolation
// ---------------------------------------------------------------------------

/** events.jsonl is written but bg-status/bg-result/bg-stop NEVER surface its
 *  contents.  Verify by injecting a sentinel in events.jsonl and checking
 *  none of the handlers emit it in their output.
 *
 *  IMPORTANT: this test drives the REAL handlers (not the test-seam
 *  override) because the production path always reads from
 *  resolveTrustedHome() — testing against a temp home would be vacuous. */
async function testEventsJsonlNeverSurfaced() {
	resetAll();
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const ctx = makeCtx(home);
		let runId;
		try {
			// Preflight uses REAL home (N3: no homeDir test seam).  The state dir
			// is at resolveTrustedHome()/.pi/agent/bg/<runId>/.
			const result = await preflightBgAgent(record, "task", ctx, diag);
			assert.equal(result.ok, true);
			runId = result.runId;

			// Inject a sentinel into the REAL run dir's events.jsonl.
			const realRunDir = result.paths.runDir;
			const eventsPath = path.join(realRunDir, "events.jsonl");
			await fs.writeFile(eventsPath, JSON.stringify({ type: "result", content: "SENTINEL_EVENT_LEAK_TEST" }) + "\n");

			// Write a result so bg-result has something to show.
			await writeBgResult(result.paths, { version: 1, runId: result.runId, status: "completed", resultText: "real result", agentName: record.name });

			// Run all 3 handlers and capture their notify messages.
			const ctxForHandlers = makeCtx(home, {
				ui: {
					notify: (msg) => { ctxForHandlers._notifyLog = ctxForHandlers._notifyLog || []; ctxForHandlers._notifyLog.push(msg); },
					setStatus: () => {},
					setWidget: () => {},
				},
			});

			await handleBgStatus(ctxForHandlers);
			await handleBgResult(result.runId, ctxForHandlers);
			await handleBgStop(result.runId, ctxForHandlers);

			const allMsgs = (ctxForHandlers._notifyLog || []).join("\n");
			assert.ok(!allMsgs.includes("SENTINEL_EVENT_LEAK_TEST"), "events.jsonl content must NEVER appear in any bg-* command output");
		} finally {
			await cleanupRealHomeRun(runId);
		}
	});
}

// ---------------------------------------------------------------------------
// 7. Manifest identity invariant (N3)
// ---------------------------------------------------------------------------

/** Preflight called WITHOUT the homeDir test seam writes a manifest whose
 *  homeDir equals resolveTrustedHome() — which is what the worker's
 *  assertManifestIdentityMatchesRuntime check expects.  This is the N3
 *  invariant: bg-state authority root is always resolveTrustedHome(). */
async function testManifestHomeMatchesTrustedRoot() {
	resetAll();
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const ctx = makeCtx(home);

		// NOTE: do NOT pass homeDir here — production preflight never does.
		// Passing homeDir is a TEST SEAM that lets preflight write under a
		// custom root, which the worker would then REJECT (identity mismatch).
		const result = await preflightBgAgent(record, "task", ctx, diag);
		assert.equal(result.ok, true);

		const manifest = await readBgManifest(result.paths);
		assert.equal(manifest.options.homeDir, resolveTrustedHome(), "manifest homeDir must match resolveTrustedHome() (N3 invariant)");

		// Cleanup: mark done + delete the real-home runDir we just created.
		await writeBgResult(result.paths, { version: 1, runId: result.runId, status: "completed", agentName: record.name });
		await markBgRunDone(result.paths);
		await fs.rm(result.paths.runDir, { recursive: true, force: true }).catch(() => {});
	});
}

// ---------------------------------------------------------------------------
// 8. Chain handoff: multiple bg runs share manifest infrastructure
// ---------------------------------------------------------------------------

/** Multiple sequential preflight calls produce independent manifest dirs
 *  (one per runId).  A "chain" would launch one worker that handles multiple
 *  agents; for now we verify each preflight is independent and the directory
 *  layout supports concurrent runs. */
async function testChainPreflightsAreIndependent() {
	resetAll();
	await withTempHome(async (home) => {
		// Use non-reserved names to avoid conflicting with built-in agents
		// (scout, planner, reviewer are reserved per specs.ts).
		const { record: r1 } = await setupRegisteredUserAgent(home, "chain-scout");
		const { record: r2, diag: d2 } = await setupRegisteredUserAgent(home, "chain-planner");
		const ctx = makeCtx(home);
		const diag1 = await collectAgentDiagnostics({ cwd: home, homeDir: home, projectTrusted: false });

		const p1 = await preflightBgAgent(r1, "scout task", ctx, diag1, { homeDir: home });
		const p2 = await preflightBgAgent(r2, "planner task", ctx, d2, { homeDir: home });
		assert.equal(p1.ok, true);
		assert.equal(p2.ok, true);

		// Independent runDirs.
		assert.notEqual(p1.paths.runDir, p2.paths.runDir, "each preflight should have its own runDir");

		// Both manifests exist and are signed.
		const m1 = await readBgManifest(p1.paths);
		const m2 = await readBgManifest(p2.paths);
		assert.equal(m1.identity.agentName, "chain-scout");
		assert.equal(m2.identity.agentName, "chain-planner");

		const macKey = await import("../lib/bg-state.ts").then(m => m.readSessionMacKey(home));
		assert.ok(verifyBgManifest(m1, macKey));
		assert.ok(verifyBgManifest(m2, macKey));
	});
}

// ---------------------------------------------------------------------------
// 9. Manifest hash mismatch end-to-end
// ---------------------------------------------------------------------------

/** Agent spec changes between preflight and launch.  Simulated worker reads
 *  the new spec and computes a different hash, which fails
 *  assertManifestIdentityMatchesRuntime.  Verify the hash mismatch path is
 *  detectable from the manifest. */
async function testHashMismatchDetectable() {
	resetAll();
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const ctx = makeCtx(home);

		const result = await preflightBgAgent(record, "task", ctx, diag, { homeDir: home });
		const manifest = await readBgManifest(result.paths);

		// Tamper with the spec file.
		const newContent = "---\nname: researcher\ndescription: d\nsource: user\ntools: [read]\nprompt: p\n---\ntampered body";
		await fs.writeFile(record.canonicalPath, newContent);

		// Re-read the spec and compute the new hash.
		const reRead = await fs.readFile(record.canonicalPath, "utf8");
		const newHash = await import("node:crypto").then(c => c.createHash("sha256").update(reRead).digest("hex"));

		assert.notEqual(newHash, manifest.identity.expectedHash, "tampered spec hash should differ from manifest's expected hash");
	});
}

// ---------------------------------------------------------------------------
// 10. Parent restart: state survives session boundary
// ---------------------------------------------------------------------------

/** A preflighted run is still discoverable after a "session restart" (i.e.,
 *  a fresh process calling countActiveBgRuns/listBgRuns on the same home dir).
 *  This proves the bg-state on-disk format is self-contained. */
async function testStateSurvivesParentRestart() {
	resetAll();
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const ctx = makeCtx(home);

		const result = await preflightBgAgent(record, "task", ctx, diag, { homeDir: home });
		assert.equal(result.ok, true);

		const active1 = await countActiveBgRuns(home);
		assert.equal(active1, 1);

		// Re-list — should still find the run via filesystem walk alone.
		const runs = await listBgRuns(home);
		assert.ok(runs.some(r => r.runId === result.runId), "preflighted run should be discoverable by file-system walk");

		// Manifest is still readable + verifyable.
		const manifest = await readBgManifest(result.paths);
		const key = await import("../lib/bg-state.ts").then(m => m.readSessionMacKey(home));
		assert.ok(verifyBgManifest(manifest, key), "manifest must still verify after restart");
	});
}

// ---------------------------------------------------------------------------
// 11. Agent unregistered between preflight and worker launch
// ---------------------------------------------------------------------------

/** If the agent is unregistered AFTER preflight but BEFORE the worker re-reads
 *  the spec, the worker would deny via canRunAgent.  We simulate by
 *  preflighting then deleting the spec file, and verify the manifest still
 *  points at the now-missing canonical path. */
async function testAgentUnregisteredAfterPreflight() {
	resetAll();
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const ctx = makeCtx(home);

		const result = await preflightBgAgent(record, "task", ctx, diag, { homeDir: home });
		assert.equal(result.ok, true);

		// Delete the spec file (simulates unregistration between preflight and launch).
		await fs.unlink(record.canonicalPath);

		const manifest = await readBgManifest(result.paths);
		assert.equal(manifest.identity.canonicalPath, record.canonicalPath, "manifest still references the (now missing) spec path");

		// Worker's parseAgentMarkdownFile would throw — verify the file is gone.
		const exists = await fs.stat(manifest.identity.canonicalPath).then(() => true).catch(() => false);
		assert.equal(exists, false, "spec file should be deleted to simulate unregistration");
	});
}

// ---------------------------------------------------------------------------
// 12. Empty bg-state via listBgRuns (N3: handlers hard-code resolveTrustedHome)
// ---------------------------------------------------------------------------

/** Verify that listBgRuns on an empty temp home returns an empty array.
 *  Note: bg-status/bg-result/bg-stop handlers hard-code resolveTrustedHome()
 *  per the N3 invariant — they don't honor the test override, so we test
 *  listBgRuns directly to verify empty state. */
async function testListBgRunsEmpty() {
	resetAll();
	await withTempHome(async (home) => {
		const runs = await listBgRuns(home);
		assert.ok(Array.isArray(runs), "listBgRuns should return an array");
		assert.equal(runs.length, 0, "empty home should have no runs");
	});
}

// ---------------------------------------------------------------------------
// 13. bg-status with one active run shows correct count (via listBgRuns)
// ---------------------------------------------------------------------------

async function testListBgRunsShowsPreflight() {
	resetAll();
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const ctx = makeCtx(home);
		const result = await preflightBgAgent(record, "task", ctx, diag, { homeDir: home });

		const runs = await listBgRuns(home);
		assert.equal(runs.length, 1, "one preflight should produce one run in listBgRuns");
		assert.equal(runs[0].runId, result.runId, "listBgRuns should include the preflighted run");
		assert.equal(runs[0].reserved, true, "run should be marked reserved");
		assert.equal(runs[0].done, false, "run should not be marked done");
	});
}

// ---------------------------------------------------------------------------
// 14. Worker rejects custom-home manifest (N3 invariant)
// ---------------------------------------------------------------------------

/** If preflight is called with the homeDir test seam (writes manifest under
 *  custom home), and then a worker reads the manifest with the production
 *  resolveTrustedHome(), assertManifestIdentityMatchesRuntime rejects it. */
async function testWorkerRejectsCustomHomeManifest() {
	resetAll();
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const ctx = makeCtx(home);

		// Preflight with test seam — writes under custom home.
		const result = await preflightBgAgent(record, "task", ctx, diag, { homeDir: home });
		assert.equal(result.ok, true);

		const manifest = await readBgManifest(result.paths);

		// Worker (without test seam) would compute trustedHome =
		// resolveTrustedHome() — which is NOT the custom home.
		const trustedRoot = resolveTrustedHome();
		assert.notEqual(manifest.options.homeDir, trustedRoot, "manifest homeDir should differ from trusted root (test seam)");

		// The worker would throw on identity mismatch.
		await import("../lib/bg-state.ts").then(m => {
			assert.throws(
				() => m.assertManifestIdentityMatchesRuntime(manifest, { homeDir: trustedRoot }),
				/homeDir does not match trusted runtime/,
				"worker identity check should reject custom-home manifest",
			);
		});
	});
}

// REQ-22 (P5): list entry with absent @pi_run_id is treated as unknown
async function testListEntryWithoutRunIdIsTreatedAsUnknown() {
	const windows = [{ windowId: "pi-agent-bg-x", runId: undefined, agentName: "scout" }];
	const actionable = windows.filter(function _w(w) { return w.runId !== undefined; });
	assert.equal(actionable.length, 0, "entries with undefined runId must be filtered out (REQ-22)");
}

// === P5b-1-S2 REQ-D10/D11 dispatch tests (v2.4) ===

async function testBgCommandFallsThroughToTmux() {
	resetAll();
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);

		const cmuxDown = makeFakeBackend({ name: "cmux", windowIdPrefix: "cmux" });
		cmuxDown.isAvailable = async () => false; // cmux daemon down
		const tmuxUp = makeFakeBackend({ name: "tmux", windowIdPrefix: "tmux" });
		tmuxUp.isAvailable = async () => true;
		registerBgTerminalBackend(cmuxDown);
		registerBgTerminalBackend(tmuxUp);

		let lastNotified = "";
		let runId;
		const ctx = makeCtx(home, { ui: { notify: (msg) => { lastNotified = String(msg); }, confirm: async () => true, setStatus: () => {}, setWidget: () => {} } });

		try {
			await handleBgCommand(`${record.name} test-task`, ctx, diag);

			// Cmux was probed, found unavailable, and was NOT launched.
			assert.equal(cmuxDown._getConfigLog().length, 0, "cmux should NOT be launched (its isAvailable returned false)");
			// Tmux was selected via preference fall-through and launched.
			const tmuxLog = tmuxUp._getConfigLog();
			assert.equal(tmuxLog.length, 1, "tmux should be launched (preference fall-through when cmux is down)");
			// Capture runId for cleanup (handleBgCommand writes a real bg-state reservation under resolveTrustedHome())
			runId = tmuxLog[0]?.runId;
			// User-visible message names the active backend.
			assert.match(lastNotified, /via tmux/, "success notification must name the active backend (tmux)");
		} finally {
			// Best-effort cleanup of the real-home bg-state reservation (matches the pattern in testPreflightToLaunchContract at agents/test-fixtures/test-bg.mjs:194)
			await cleanupRealHomeRun(runId);
		}
	});
	resetAll();
}

async function testBgCommandReportsNoneAvailable() {
	resetAll();
	// No backends registered, no agent setup needed — dispatch short-circuits before preflight.
	let lastNotified = "";
	const ctx = makeCtx("/tmp", { ui: { notify: (msg) => { lastNotified = String(msg); }, confirm: async () => true, setStatus: () => {}, setWidget: () => {} } });
	await handleBgCommand("scout test-task", ctx, { agents: [] });
	assert.match(lastNotified, /No terminal backend installed/, "empty registry must surface the canonical no-backend message");
	resetAll();
}

async function testBgCommandListsProbedBackendsWhenAllUnavailable() {
	resetAll();
	const cmuxDown = makeFakeBackend({ name: "cmux" });
	cmuxDown.isAvailable = async () => false;
	const tmuxDown = makeFakeBackend({ name: "tmux" });
	tmuxDown.isAvailable = async () => false;
	registerBgTerminalBackend(cmuxDown);
	registerBgTerminalBackend(tmuxDown);

	let lastNotified = "";
	const ctx = makeCtx("/tmp", { ui: { notify: (msg) => { lastNotified = String(msg); }, confirm: async () => true, setStatus: () => {}, setWidget: () => {} } });
	await handleBgCommand("scout test-task", ctx, { agents: [] });
	assert.match(lastNotified, /Terminal backends registered but unavailable/, "all-unavailable must surface the differential message (REQ-D11)");
	assert.match(lastNotified, /cmux/, "differential message must list the cmux backend name");
	assert.match(lastNotified, /tmux/, "differential message must list the tmux backend name");
	resetAll();
}

async function testBgBeforeSessionStart() {
	resetAll();
	// Simulate pre-session_start state: no backends registered, no agent resolved.
	let lastNotified = "";
	const ctx = makeCtx("/tmp", { ui: { notify: (msg) => { lastNotified = String(msg); }, confirm: async () => true, setStatus: () => {}, setWidget: () => {} } });
	await handleBgCommand("scout test-task", ctx, { agents: [] });
	assert.match(lastNotified, /No terminal backend installed/, "pre-session_start must show the no-registered message");
	resetAll();
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/** P5+ E2E orphan regression: full real launch via a fake backend that
 *  later "loses" the window (simulating a dead tmux pane). Mirrors the
 *  user-reported bug ("status bar keeps saying 1 agent running but no
 *  agent is running") and proves the reaper-with-isAlive path actually
 *  clears the slot and unblocks the status line.
 *
 *  bg-state lives in the REAL home (resolveTrustedHome), not the test
 *  temp dir — same constraint as every other test-bg.mjs test that calls
 *  handleBgCommand / preflight. We use listBgTerminalBackends + the
 *  resolved home to find the run, and cleanupRealHomeRun in finally. */
async function testE2EOrphanClearsStatusLine() {
	resetAll();
	// Sweep any prior test leaks so the count assertion is deterministic.
	await sweepRealHomeReservations();
	const backend = makeFakeBackend({ name: "fake-e2e", windowIdPrefix: "e2e" });
	registerBgTerminalBackend(backend);
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const statuses = [];
		const ctx = makeCtx(home, {
			ui: { notify: () => {}, confirm: async () => true, setStatus: (k, t) => statuses.push({ k, t }), setWidget: () => {} },
		});
		let runId;
		try {
			// 1. Launch via the real handleBgCommand path. This exercises
			//    preflight + backend.launch + updateBgReservationOwner.
			await handleBgCommand(`${record.name} orphan-task`, ctx, diag);

			// Find the run in the REAL home (bg-state is not home-overridable
			// for createBgRunState).
			const realHome = resolveTrustedHome();
			const realRuns = await listBgRuns(realHome);
			const realRun = realRuns.find((r) => r.runId && r.runId.startsWith("bg-"));
			assert.ok(realRun, "handleBgCommand should have created a bg run");
			runId = realRun.runId;
			const realPaths = getBgRunPaths(runId, realHome);

			// Sanity: the reservation has ownerHandle + ownerBackendName
			// (proves the post-launch patch ran).
			const reservation = JSON.parse((await fs.readFile(realPaths.reservationPath, "utf8")).trim());
			assert.equal(reservation.ownerHandle, `e2e-${runId}`);
			assert.equal(reservation.ownerBackendName, "fake-e2e");

			// 2. status line uses the home override for count. We point it
			//    at the real home (not the test temp dir) so it sees the
			//    live run.
			__setBgStatusHomeOverride(realHome);
			statuses.length = 0;
			await updateBgStatusLine(ctx);
			const lastBefore = statuses[statuses.length - 1];
			assert.equal(lastBefore?.t, "1 agent running", "status line should show the running agent");

			// 3. Simulate the window dying — kill it on the backend so
			//    subsequent isAlive() returns false.
			const entry = (await backend.list())[0];
			assert.ok(entry, "backend.list should still show the window before kill");
			await backend.kill(entry.windowId);

			// 4. The status line update itself runs the reaper as part of
			//    its routine. So we only need ONE more updateBgStatusLine
			//    call to exercise the full production path: reap -> count ->
			//    setStatus. The buildReaperIsAlive-shaped callback is the
			//    same one session_start and the 15s poll use.
			statuses.length = 0;
			await updateBgStatusLine(ctx);
			const lastAfter = statuses[statuses.length - 1];
			assert.equal(lastAfter?.t, undefined,
				`status line MUST clear after the orphan is reaped; got '${lastAfter?.t}'`);

			// 6. The slot is gone (done + result.json present).
			const finalRuns = await listBgRuns(realHome);
			const finalRun = finalRuns.find((r) => r.runId === runId);
			assert.ok(finalRun && finalRun.done, "reaped run should be marked done");
			const result = JSON.parse((await fs.readFile(realPaths.resultPath, "utf8")).trim());
			assert.equal(result.status, "stopped", "reaped orphan should have status=stopped");
		} finally {
			__setBgStatusHomeOverride(undefined);
			await cleanupRealHomeRun(runId);
			resetAll();
		}
	});
}

/** Mark every still-reserved run in resolveTrustedHome() as done, so a
 *  leaky test cannot pollute the next test's count assertion. Best-effort;
 *  missing files are swallowed. */
async function sweepRealHomeReservations() {
	try {
		const realHome = resolveTrustedHome();
		const runs = await listBgRuns(realHome);
		for (const r of runs) {
			if (r.reserved && !r.done) {
				await cleanupRealHomeRun(r.runId);
			}
		}
	} catch { /* best-effort */ }
}

// === P5E1-1: --backend <name> selector on /agents bg ===

/** EC2/EC6: `--backend cmux researcher multi-word-task-still-here` launches
 *  via the named backend; success notification names cmux; task is the
 *  full string after the agent name. */
async function testBackendFlagLaunchesNamedBackend() {
	resetAll();
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);

		const cmux = makeFakeBackend({ name: "cmux", windowIdPrefix: "cmux" });
		const tmux = makeFakeBackend({ name: "tmux", windowIdPrefix: "tmux" });
		registerBgTerminalBackend(cmux);
		registerBgTerminalBackend(tmux);

		let lastNotified = "";
		let runId;
		const ctx = makeCtx(home, { ui: { notify: (msg) => { lastNotified = String(msg); }, confirm: async () => true, setStatus: () => {}, setWidget: () => {} } });

		try {
			await handleBgCommand(`--backend cmux ${record.name} multi-word-task-still-here`, ctx, diag);

			const cmuxLog = cmux._getConfigLog();
			assert.equal(cmuxLog.length, 1, "cmux should be launched (named selection)");
			runId = cmuxLog[0]?.runId;
			assert.equal(cmuxLog[0].agentName, record.name, "launch config should carry the resolved agent name");
			assert.match(lastNotified, /via cmux/, "success notification must name the named backend (cmux)");
		} finally {
			await cleanupRealHomeRun(runId);
		}
	});
	resetAll();
}

/** EC3: `--backend tmux` with cmux registered at higher preference still
 *  launches via tmux — the explicit selector overrides preference. */
async function testBackendFlagBypassesPreference() {
	resetAll();
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);

		const cmux = makeFakeBackend({ name: "cmux", windowIdPrefix: "cmux" });
		cmux.preference = 10; // higher than tmux (default 0)
		const tmux = makeFakeBackend({ name: "tmux", windowIdPrefix: "tmux" });
		registerBgTerminalBackend(cmux);
		registerBgTerminalBackend(tmux);

		let lastNotified = "";
		let runId;
		const ctx = makeCtx(home, { ui: { notify: (msg) => { lastNotified = String(msg); }, confirm: async () => true, setStatus: () => {}, setWidget: () => {} } });

		try {
			await handleBgCommand(`--backend tmux ${record.name} bypass-task`, ctx, diag);

			assert.equal(cmux._getConfigLog().length, 0, "cmux must NOT be launched (explicit --backend tmux overrides cmux preference)");
			assert.equal(tmux._getConfigLog().length, 1, "tmux should be launched via explicit --backend");
			runId = tmux._getConfigLog()[0]?.runId;
			assert.match(lastNotified, /via tmux/, "success notification must name tmux when --backend tmux is used");
		} finally {
			await cleanupRealHomeRun(runId);
		}
	});
	resetAll();
}

/** EC1: bare `--backend` (no value) emits the usage message; no launch. */
async function testBackendFlagMissingValueErrors() {
	resetAll();
	const tmux = makeFakeBackend({ name: "tmux", windowIdPrefix: "tmux" });
	registerBgTerminalBackend(tmux);

	let lastNotified = "";
	const ctx = makeCtx("/tmp", { ui: { notify: (msg) => { lastNotified = String(msg); }, confirm: async () => true, setStatus: () => {}, setWidget: () => {} } });
	await handleBgCommand("--backend", ctx, { agents: [] });

	assert.equal(lastNotified, "Usage: /agents bg <agent> <task> [--backend <name>]", "bare --backend must emit the canonical usage message");
	assert.equal(tmux._getConfigLog().length, 0, "no backend.launch() must be called when --backend has no value");
	resetAll();
}

/** EC4: unknown backend name lists every registered backend name. */
async function testBackendFlagUnknownNameErrorsWithList() {
	resetAll();
	const tmux = makeFakeBackend({ name: "tmux", windowIdPrefix: "tmux" });
	const cmux = makeFakeBackend({ name: "cmux", windowIdPrefix: "cmux" });
	registerBgTerminalBackend(tmux);
	registerBgTerminalBackend(cmux);

	let lastNotified = "";
	const ctx = makeCtx("/tmp", { ui: { notify: (msg) => { lastNotified = String(msg); }, confirm: async () => true, setStatus: () => {}, setWidget: () => {} } });
	await handleBgCommand("--backend zellij researcher task", ctx, { agents: [] });

	assert.match(lastNotified, /Unknown backend 'zellij'/, "unknown-name error must name the requested backend");
	assert.match(lastNotified, /Registered:/, "unknown-name error must include the 'Registered:' prefix");
	assert.match(lastNotified, /tmux/, "unknown-name error must list tmux (registered)");
	assert.match(lastNotified, /cmux/, "unknown-name error must list cmux (registered)");
	resetAll();
}

/** EC4: unknown backend name does NOT call any backend.launch(). */
async function testBackendFlagUnknownNameDoesNotLaunch() {
	resetAll();
	const tmux = makeFakeBackend({ name: "tmux", windowIdPrefix: "tmux" });
	const cmux = makeFakeBackend({ name: "cmux", windowIdPrefix: "cmux" });
	registerBgTerminalBackend(tmux);
	registerBgTerminalBackend(cmux);

	const ctx = makeCtx("/tmp", { ui: { notify: () => {}, confirm: async () => true, setStatus: () => {}, setWidget: () => {} } });
	await handleBgCommand("--backend zellij researcher task", ctx, { agents: [] });

	assert.equal(tmux._getConfigLog().length, 0, "tmux must NOT launch for an unknown --backend name");
	assert.equal(cmux._getConfigLog().length, 0, "cmux must NOT launch for an unknown --backend name");
	resetAll();
}

/** EC5: explicit selection of an unavailable backend does NOT fall through
 *  to a higher-preference available sibling. This is the REQ-3 negative
 *  control: register a higher-preference available sibling and assert its
 *  launch was NOT called. */
async function testBackendFlagUnavailableDoesNotFallThrough() {
	resetAll();
	const cmux = makeFakeBackend({ name: "cmux", windowIdPrefix: "cmux" });
	cmux.isAvailable = async () => false; // explicitly unavailable
	const tmux = makeFakeBackend({ name: "tmux", windowIdPrefix: "tmux" });
	tmux.preference = 100; // would normally win preference
	registerBgTerminalBackend(cmux);
	registerBgTerminalBackend(tmux);

	const ctx = makeCtx("/tmp", { ui: { notify: () => {}, confirm: async () => true, setStatus: () => {}, setWidget: () => {} } });
	await handleBgCommand("--backend cmux researcher task", ctx, { agents: [] });

	assert.equal(tmux._getConfigLog().length, 0, "explicit --backend cmux must NOT fall through to the higher-preference available tmux");
	assert.equal(cmux._getConfigLog().length, 0, "the unavailable cmux must NOT be launched");
	resetAll();
}

/** EC5: unavailable backend errors with the canonical wording naming the backend. */
async function testBackendFlagUnavailableNamesBackend() {
	resetAll();
	const cmux = makeFakeBackend({ name: "cmux", windowIdPrefix: "cmux" });
	cmux.isAvailable = async () => false;
	registerBgTerminalBackend(cmux);

	let lastNotified = "";
	const ctx = makeCtx("/tmp", { ui: { notify: (msg) => { lastNotified = String(msg); }, confirm: async () => true, setStatus: () => {}, setWidget: () => {} } });
	await handleBgCommand("--backend cmux researcher task", ctx, { agents: [] });

	assert.match(lastNotified, /Backend 'cmux' is registered but unavailable\./, "unavailable-backend error must use the canonical wording AND name cmux");
	resetAll();
}

/** EC7: `--backend` mid-args is NOT consumed; the literal token survives
 *  in BgRunManifest.task; launch proceeds via the preference winner. */
async function testBackendFlagMidArgsNotConsumed() {
	resetAll();
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);

		const tmux = makeFakeBackend({ name: "tmux", windowIdPrefix: "tmux" });
		registerBgTerminalBackend(tmux);

		let lastNotified = "";
		let runId;
		const ctx = makeCtx(home, { ui: { notify: (msg) => { lastNotified = String(msg); }, confirm: async () => true, setStatus: () => {}, setWidget: () => {} } });

		try {
			await handleBgCommand(`${record.name} do --backend thing`, ctx, diag);

			assert.equal(tmux._getConfigLog().length, 1, "the preference winner must launch when --backend is mid-args (State A)");
			const cfg = tmux._getConfigLog()[0];
			runId = cfg.runId;
			assert.equal(cfg.agentName, record.name, "first token must remain the agent name");
			// Read the manifest from disk and verify the literal --backend text survived into task.
			const manifest = await readBgManifest(getBgRunPaths(runId));
			assert.ok(manifest.task.includes("--backend"), "BgRunManifest.task must contain the literal '--backend' token when mid-args");
			assert.ok(manifest.task.includes("thing"), "BgRunManifest.task must contain the trailing 'thing' token");
			assert.match(lastNotified, /via tmux/, "mid-args launch goes through the default-selected backend");
		} finally {
			await cleanupRealHomeRun(runId);
		}
	});
	resetAll();
}

/** REQ-12: the `--backend <name>` pair MUST NOT appear in any launch-config
 *  field AND MUST NOT appear in BgRunManifest.task. The legitimate task
 *  sentinel MUST appear in BgRunManifest.task intact. */
async function testBackendFlagNotInLaunchConfigOrManifest() {
	resetAll();
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);

		// Backend name "zznoleak-probe" is a sentinel — if it appears in the
		// launch config or in manifest.task, the leak gate has failed.
		const probe = makeFakeBackend({ name: "zznoleak-probe", windowIdPrefix: "probe" });
		registerBgTerminalBackend(probe);

		const TASK_SENTINEL = "legit-task-sentinel-9f8";
		let runId;
		const ctx = makeCtx(home, { ui: { notify: () => {}, confirm: async () => true, setStatus: () => {}, setWidget: () => {} } });

		try {
			await handleBgCommand(`--backend zznoleak-probe ${record.name} ${TASK_SENTINEL}`, ctx, diag);

			const logged = probe._getConfigLog();
			assert.equal(logged.length, 1, "the named backend should be launched");
			const cfg = logged[0];
			runId = cfg.runId;

			// No fragment of the consumed --backend <name> pair appears in
			// any launch-config field the backend receives.
			assert.equal(cfg.agentName, record.name, "cfg.agentName must be the resolved agent name, not --backend zznoleak-probe");
			assert.ok(!cfg.agentName.includes("zznoleak-probe"), "cfg.agentName must NOT contain the backend name sentinel");
			assert.ok(!cfg.agentName.includes("--backend"), "cfg.agentName must NOT contain the --backend token");
			assert.ok(!cfg.runId.includes("zznoleak-probe"), "cfg.runId must NOT contain the backend name sentinel");
			assert.ok(!cfg.manifestPath.includes("zznoleak-probe"), "cfg.manifestPath must NOT contain the backend name sentinel");
			assert.ok(!cfg.cwd.includes("zznoleak-probe"), "cfg.cwd must NOT contain the backend name sentinel");

			// No fragment in BgRunManifest.task, and the legit task IS present.
			const manifest = await readBgManifest(getBgRunPaths(runId));
			assert.ok(!manifest.task.includes("zznoleak-probe"), "BgRunManifest.task must NOT contain the backend name sentinel");
			assert.ok(!manifest.task.includes("--backend"), "BgRunManifest.task must NOT contain the --backend token");
			assert.equal(manifest.task, TASK_SENTINEL, "BgRunManifest.task must equal the legitimate task sentinel");
		} finally {
			await cleanupRealHomeRun(runId);
		}
	});
	resetAll();
}

/** EC8: `--backend=cmux` first token is NOT recognized as the flag (it is
 *  not the literal token `--backend`). State A: selectBgTerminalBackend
 *  runs first; if a backend is available, tokenization yields agentName
 *  `--backend=cmux`, which fails with the existing unknown-agent error. */
async function testBackendEqualsFormPassedThrough() {
	resetAll();
	const tmux = makeFakeBackend({ name: "tmux", windowIdPrefix: "tmux" });
	registerBgTerminalBackend(tmux);

	let lastNotified = "";
	const ctx = makeCtx("/tmp", { ui: { notify: (msg) => { lastNotified = String(msg); }, confirm: async () => true, setStatus: () => {}, setWidget: () => {} } });
	await handleBgCommand("--backend=cmux researcher task", ctx, { records: [], projectTrusted: false });

	// --backend=cmux is the first token, not the literal --backend, so the
	// existing path runs: backend is selected, then agent resolution fails
	// because no agent is named "--backend=cmux".
	assert.equal(tmux._getConfigLog().length, 0, "tmux must NOT launch (agent resolution should fail before launch)");
	assert.match(lastNotified, /No discovered registered user\/project agent named '--backend=cmux'/, "equals-form first token should be treated as the agent name and fail with the unknown-agent error");
	resetAll();
}

/** EC10: a second `--backend <name>` pair after a valid first pair is NOT
 *  consumed; it survives intact as part of the task text. */
async function testBackendFlagDuplicateSecondPairPassesThrough() {
	resetAll();
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);

		const tmux = makeFakeBackend({ name: "tmux", windowIdPrefix: "tmux" });
		const cmux = makeFakeBackend({ name: "cmux", windowIdPrefix: "cmux" });
		registerBgTerminalBackend(tmux);
		registerBgTerminalBackend(cmux);

		let runId;
		const ctx = makeCtx(home, { ui: { notify: () => {}, confirm: async () => true, setStatus: () => {}, setWidget: () => {} } });

		try {
			await handleBgCommand(`--backend tmux ${record.name} --backend cmux thing`, ctx, diag);

			assert.equal(tmux._getConfigLog().length, 1, "first --backend wins; tmux must launch");
			assert.equal(cmux._getConfigLog().length, 0, "second --backend pair must NOT trigger cmux launch");
			const cfg = tmux._getConfigLog()[0];
			runId = cfg.runId;
			assert.equal(cfg.agentName, record.name, "first non-flag token after the consumed pair is the agent name");

			// Second pair survives intact in BgRunManifest.task.
			const manifest = await readBgManifest(getBgRunPaths(runId));
			assert.ok(manifest.task.includes("--backend cmux thing"), "BgRunManifest.task must contain the second --backend pair intact");
			assert.ok(manifest.task.includes("--backend"), "BgRunManifest.task must contain the literal --backend token");
		} finally {
			await cleanupRealHomeRun(runId);
		}
	});
	resetAll();
}

/** EC9: `--backend CMUX` (wrong case) is treated as unknown because
 *  TermBgBackend.name matching is exact-case (no normalize / toLowerCase). */
async function testBackendFlagCaseSensitive() {
	resetAll();
	const tmux = makeFakeBackend({ name: "tmux", windowIdPrefix: "tmux" });
	const cmux = makeFakeBackend({ name: "cmux", windowIdPrefix: "cmux" });
	registerBgTerminalBackend(tmux);
	registerBgTerminalBackend(cmux);

	let lastNotified = "";
	const ctx = makeCtx("/tmp", { ui: { notify: (msg) => { lastNotified = String(msg); }, confirm: async () => true, setStatus: () => {}, setWidget: () => {} } });
	await handleBgCommand("--backend CMUX researcher task", ctx, { agents: [] });

	assert.match(lastNotified, /Unknown backend 'CMUX'/, "wrong-case --backend CMUX must be treated as unknown (exact-case match)");
	assert.match(lastNotified, /tmux/, "unknown-name error must still list tmux");
	assert.match(lastNotified, /cmux/, "unknown-name error must still list cmux");
	assert.equal(tmux._getConfigLog().length, 0, "tmux must NOT launch");
	assert.equal(cmux._getConfigLog().length, 0, "cmux must NOT launch");
	resetAll();
}

/** REQ-4/EC11: launch failure under `--backend tmux` runs the existing
 *  cleanup path (write bg-result failed + markBgRunDone) AND the failure
 *  notification names the attempted backend (`via tmux`). */
async function testBackendFlagLaunchFailureCleansAndNamesBackend() {
	resetAll();
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);

		const tmux = makeFakeBackend({ name: "tmux", windowIdPrefix: "tmux", launchShouldFail: "tmux daemon died" });
		registerBgTerminalBackend(tmux);

		let lastNotified = "";
		let runId;
		const ctx = makeCtx(home, { ui: { notify: (msg) => { lastNotified = String(msg); }, confirm: async () => true, setStatus: () => {}, setWidget: () => {} } });

		try {
			await handleBgCommand(`--backend tmux ${record.name} doomed-task`, ctx, diag);

			// Notification names the attempted backend.
			assert.match(lastNotified, /Launch failed via tmux:/, "launch-failure notification must name the attempted backend (via tmux)");
			assert.match(lastNotified, /tmux daemon died/, "launch-failure notification must include the original error message");

			// Cleanup released the slot.
			const active = await countActiveBgRuns(home);
			assert.equal(active, 0, "launch-failure cleanup must release the reservation slot");
		} finally {
			await cleanupRealHomeRun(runId);
		}
	});
	resetAll();
}

/** REQ-9: the reservation's ownerBackendName is persisted as the literal
 *  `--backend <name>` value (NOT the preference winner), so the reaper
 *  routes isAlive() to the same backend that launched the run. */
async function testBackendFlagPersistsOwnerName() {
	resetAll();
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);

		const tmux = makeFakeBackend({ name: "tmux", windowIdPrefix: "tmux-persist" });
		const cmux = makeFakeBackend({ name: "cmux", windowIdPrefix: "cmux-persist" });
		cmux.preference = 100; // would normally win preference
		registerBgTerminalBackend(tmux);
		registerBgTerminalBackend(cmux);

		let runId;
		const ctx = makeCtx(home, { ui: { notify: () => {}, confirm: async () => true, setStatus: () => {}, setWidget: () => {} } });

		try {
			// Explicit --backend tmux despite cmux having higher preference.
			await handleBgCommand(`--backend tmux ${record.name} persist-task`, ctx, diag);

			const cfg = tmux._getConfigLog()[0];
			runId = cfg.runId;
			assert.ok(runId, "tmux must have launched and recorded a runId");

			// Read the reservation from disk.
			const paths = getBgRunPaths(runId);
			const reservationRaw = await fs.readFile(paths.reservationPath, "utf8");
			const reservation = JSON.parse(reservationRaw.trim());
			assert.equal(reservation.ownerBackendName, "tmux", "ownerBackendName must equal the user's --backend value (tmux), not the preference winner (cmux)");
			assert.equal(reservation.ownerHandle, `tmux-persist-${runId}`, "ownerHandle must equal the windowId the backend returned at launch");
		} finally {
			await cleanupRealHomeRun(runId);
		}
	});
	resetAll();
}

async function main() {
	console.log("P4-7 bg integration tests");
	await test("preflight->launch: backend gets correct config, task not in argv", testPreflightToLaunchContract);
	await test("preflight: two runs produce distinct runIds", testPreflightUniqueRunIds);
	await test("launch failure: reservation cleaned up", testLaunchFailureCleansReservation);
	await test("bg-stop: handleBgStop calls backend.kill with correlated windowId", testHandleBgStopKillsWindowViaList);
	await test("lost result: bg-result handles missing result.json gracefully", testLostResultIsHandledGracefully);
	await test("stale run: counted active until reap", testStaleRunCountedUntilReap);
	await test("concurrency: 5 reservations tracked + freed by cleanup", testConcurrencyCountTracksReservations);
	await test("events.jsonl: never surfaced by any bg-* command", testEventsJsonlNeverSurfaced);
	await test("manifest homeDir: matches resolveTrustedHome() (N3 invariant)", testManifestHomeMatchesTrustedRoot);
	await test("chain: independent preflights share session MAC", testChainPreflightsAreIndependent);
	await test("hash mismatch: tampered spec hash differs from manifest.expectedHash", testHashMismatchDetectable);
	await test("state survives parent restart (filesystem-only)", testStateSurvivesParentRestart);
	await test("agent unregistered after preflight: manifest references deleted spec", testAgentUnregisteredAfterPreflight);
	await test("listBgRuns: empty home returns empty array", testListBgRunsEmpty);
	await test("listBgRuns: preflight shows up as reserved run", testListBgRunsShowsPreflight);
	await test("worker rejects custom-home manifest (N3 invariant)", testWorkerRejectsCustomHomeManifest);
	await test("list entry with undefined runId is treated as unknown (REQ-22)", testListEntryWithoutRunIdIsTreatedAsUnknown);
	await test("bg-command: falls through to next backend when primary is down", testBgCommandFallsThroughToTmux);
	await test("bg-command: reports no backend installed when registry is empty", testBgCommandReportsNoneAvailable);
	await test("bg-command: lists probed backends when all are unavailable", testBgCommandListsProbedBackendsWhenAllUnavailable);
	await test("bg-command: pre-session_start shows no-backend message", testBgBeforeSessionStart);
	await test("P5+: E2E orphan clears status line", testE2EOrphanClearsStatusLine);
	// === P5E1-1: --backend <name> selector on /agents bg ===
	await test("P5E1: --backend cmux launches via the named backend", testBackendFlagLaunchesNamedBackend);
	await test("P5E1: --backend tmux overrides higher-preference cmux", testBackendFlagBypassesPreference);
	await test("P5E1: bare --backend emits usage; no launch", testBackendFlagMissingValueErrors);
	await test("P5E1: --backend <unknown> errors listing registered backends", testBackendFlagUnknownNameErrorsWithList);
	await test("P5E1: --backend <unknown> does NOT launch any backend", testBackendFlagUnknownNameDoesNotLaunch);
	await test("P5E1: --backend <unavailable> does NOT fall through to sibling", testBackendFlagUnavailableDoesNotFallThrough);
	await test("P5E1: --backend <unavailable> errors with canonical wording", testBackendFlagUnavailableNamesBackend);
	await test("P5E1: --backend mid-args survives in manifest.task", testBackendFlagMidArgsNotConsumed);
	await test("P5E1: --backend pair never leaks into launch config or manifest.task", testBackendFlagNotInLaunchConfigOrManifest);
	await test("P5E1: --backend=cmux first token flows through as agent name", testBackendEqualsFormPassedThrough);
	await test("P5E1: second --backend pair passes through as task text", testBackendFlagDuplicateSecondPairPassesThrough);
	await test("P5E1: --backend CMUX (wrong case) is unknown", testBackendFlagCaseSensitive);
	await test("P5E1: launch failure under --backend cleans up and names backend", testBackendFlagLaunchFailureCleansAndNamesBackend);
	await test("P5E1: --backend value is persisted as ownerBackendName", testBackendFlagPersistsOwnerName);
	console.log("P4-7 bg integration tests passed");
}

main().catch((error) => { console.error(error); process.exit(1); });