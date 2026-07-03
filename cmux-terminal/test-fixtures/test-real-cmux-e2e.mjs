// P5b-1-S3: Real-cmux end-to-end /agents bg dispatch test.
//
// UNGUARDED-IN-CI per REQ-R2. Drives the REAL `handleBgCommand` flow against
// a LIVE cmux ≥0.64.17 daemon — no FakeCmuxExecutor. Mirrors the S1 smoke
// test's cmux CLI invocation pattern (real `cmux workspace list --json`,
// real `cmux close-workspace --workspace <ref>`) and the S2 dispatch test's
// `handleBgCommand` harness (`withTempHome`, `setupRegisteredUserAgent`,
// `makeCtx`, `cleanupRealHomeRun`).
//
// Why three tests share one backend-registration shape:
//   - LaunchCreatesWorkspace (REQ-R2): /agents bg scout task creates a
//     pi-cmux-<runId> cmux workspace running the worker. Verified by
//     `cmux workspace list --json` returning an entry with title === pi-cmux-<runId>.
//   - StatusListsRun (REQ-R2): /agents bg-status lists the same runId prefix.
//   - StopClosesWorkspace (REQ-R2): /agents bg-stop <runId> drives
//     `cmux close-workspace --workspace <ref>` (not the title — P1 fix from
//     the S1 smoke test) and the workspace disappears from the list.
//
// Why FallbackWhenCmuxDown is a manual stub (REQ-R3, UNGUARDED-IN-CI):
//   Taking the cmux daemon down is a user-environment operation that can't
//   be automated inside a single test process. The same dispatch fall-through
//   is covered programmatically by `agents/test-fixtures/test-bg.mjs:testBgCommandFallsThroughToTmux`
//   (FakeCmux with isAvailable=false + FakeTmux with isAvailable=true) —
//   the only thing this manual step adds is the live cmux CLI for
//   confirmation, which the existing test already proves for the dispatch
//   layer.
//
// Each test:
//   - calls __resetBgTerminalBackend() at start AND end to isolate the
//     process-global registry slot (Symbol.for("pi.agents.bgTerminalBackend"))
//   - registers a uniquely-named user agent (p5b1s3-{launch,status,stop}-probe)
//     in a temp home so /agents resolveRegisteredRunTarget accepts the name
//   - leaves a real bg-state reservation at <resolveTrustedHome()>/.pi/agent/bg
//     (preflight writes to the trusted root per N3), and cleans it up via
//     cleanupRealHomeRun(runId) so a failed assertion doesn't pollute the
//     developer's bg state
//
// Stub worker: a 60s-sleeping .mjs placed in a temp dir, located via the
// production `resolveWorkerPath(searchDir)` seam (matches the S1 smoke
// pattern). The cmux backend's `workspace create --command` invokes
// `node <workerPath> <manifestPath>` — the stub just needs to not crash
// immediately so the workspace stays alive for the test to query.
//
// Exit behavior (per spec):
//   - macOS-only (cmux is darwin/Ghostty)
//   - skip (exit 0) if cmux < 0.64.17 or cmux not on $PATH
//   - skip (exit 0) if CMUX_SOCKET_MODE=allowAll is not set (CONFIG-REQUIRED)
//   - skip (exit 0) if `cmux workspace list --json` can't reach the daemon
//   - otherwise run all 4 tests; non-zero on any test failure

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

import { createCmuxBackend } from "../lib/cmux-backend.ts";
import { defaultCmuxExecutor } from "../lib/exec.ts";
import { resolveWorkerPath } from "../lib/resolve-worker-path.ts";
import { CMUX_WINDOW_PREFIX, CMUX_BACKEND_PREFERENCE } from "../lib/constants.ts";
import {
	getBgStateDir,
	getBgRunPaths,
	markBgRunDone,
	resolveTrustedHome,
} from "../../agents/lib/bg-state.ts";
import { registerAgent } from "../../agents/lib/registration.ts";
import { collectAgentDiagnostics } from "../../agents/lib/diagnostics.ts";
import { resolveRegisteredRunTarget } from "../../agents/lib/run-resolver.ts";
import {
	__resetBgTerminalBackend,
	registerBgTerminalBackend,
} from "../../agents/lib/bg-terminal.ts";
import {
	handleBgCommand,
	handleBgStatus,
	handleBgStop,
} from "../../agents/index.ts";

const execFileP = promisify(execFile);

const MIN_CMUX_VERSION = "0.64.17";
const TMPDIR_BASE = path.join(os.tmpdir(), `p5b1s3-e2e-${process.pid}`);

let cleanedUp = false;
async function globalCleanup() {
	if (cleanedUp) return;
	cleanedUp = true;
	try { fs.rmSync(TMPDIR_BASE, { recursive: true, force: true }); } catch { /* best effort */ }
}

function parseCmuxVersion(stdout) {
	const m = stdout.match(/cmux\s+(\d+)\.(\d+)\.(\d+)/);
	if (!m) return null;
	return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function versionGte(a, b) {
	if (a.major !== b.major) return a.major > b.major;
	if (a.minor !== b.minor) return a.minor > b.minor;
	return a.patch >= b.patch;
}

/** Run `cmux workspace list --json` and return the workspaces array.
 *  Mirrors the S1 smoke test's parsing of `{ workspaces: [...] }` (or a bare
 *  array, as a defensive fallback). */
async function listWorkspaces() {
	const { stdout } = await execFileP("cmux", ["workspace", "list", "--json"], { timeout: 3000 });
	const parsed = JSON.parse(stdout);
	return Array.isArray(parsed?.workspaces) ? parsed.workspaces : (Array.isArray(parsed) ? parsed : []);
}

/** Run `cmux close-workspace --workspace <refOrTitle>`.
 *  cmux accepts id|ref|index (NOT the title) — P1 fix from the S1 smoke test.
 *  Returns true on success, false on failure (best-effort cleanup). */
async function closeWorkspace(refOrTitle) {
	try {
		await execFileP("cmux", ["close-workspace", "--workspace", refOrTitle], { timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}

/** Snapshot the bg-state dir at <resolveTrustedHome()>/.pi/agent/bg/.
 *  Used to compute the diff after handleBgCommand runs (the new runId is
 *  whichever bg-* dir wasn't there before). The dir may not exist yet
 *  (preflight creates it on first run) — return [] in that case. */
async function snapshotBgRunDirs() {
	const bgDir = path.join(resolveTrustedHome(), ".pi", "agent", "bg");
	const entries = await fsp.readdir(bgDir).catch(() => []);
	return new Set(entries.filter((e) => e.startsWith("bg-")));
}

/** Given a before-snapshot, find the single new bg-* run dir. The preflight
 *  call inside handleBgCommand creates exactly one new dir, so the diff has
 *  exactly one element when the test is well-isolated. Throw if there's
 *  more than one (caller forgot to clean up) or none (handleBgCommand never
 *  reached preflight — likely a backend-selection failure). */
async function findNewBgRunDir(before) {
	const bgDir = path.join(resolveTrustedHome(), ".pi", "agent", "bg");
	const after = await fsp.readdir(bgDir).catch(() => []);
	const newDirs = after.filter((e) => !before.has(e) && e.startsWith("bg-"));
	if (newDirs.length === 0) {
		throw new Error("no new bg-* run dir was created — handleBgCommand did not reach preflight (backend selection likely failed)");
	}
	if (newDirs.length > 1) {
		throw new Error(`expected exactly 1 new bg-* run dir, got ${newDirs.length}: ${newDirs.join(", ")} — previous test left state behind`);
	}
	return newDirs[0];
}

async function withTempHome(fn) {
	const root = await fsp.mkdtemp(path.join(TMPDIR_BASE, "home-"));
	const home = path.join(root, "home");
	await fsp.mkdir(home, { recursive: true });
	try {
		return await fn(home, root);
	} finally {
		// Best-effort cleanup of the temp home. Specs and user registry live
		// here; the bg-state reservation is at the real home and is cleaned
		// per-test by cleanupRealHomeRun(runId).
		await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
	}
}

function makeCtx(home, captured) {
	return {
		cwd: home,
		hasUI: false,
		agentsHomeDir: home,
		ui: {
			notify: (msg, level) => { captured.push({ msg: String(msg), level: level ?? "info" }); },
			confirm: async () => true,
			setStatus: () => {},
			setWidget: () => {},
		},
	};
}

async function setupRegisteredUserAgent(home, name) {
	const userAgentsDir = path.join(home, ".pi", "agent", "agents");
	await fsp.mkdir(userAgentsDir, { recursive: true });
	const specPath = path.join(userAgentsDir, `${name}.md`);
	await fsp.writeFile(
		specPath,
		`---\nname: ${name}\ndescription: p5b1-s3 e2e probe\nsource: user\ntools: [read]\nprompt: p\n---\nP5b-1-S3 e2e probe body.\n`,
	);
	await registerAgent(specPath, {
		cwd: home, homeDir: home, projectTrusted: false,
		hasUI: true,
		ui: { notify: () => {}, confirm: async () => true },
	});
	const diag = await collectAgentDiagnostics({ cwd: home, homeDir: home, projectTrusted: false });
	const resolved = await resolveRegisteredRunTarget(name, diag);
	assert.equal(resolved.ok, true, `agent '${name}' should resolve as runnable: ${resolved.ok ? "" : resolved.message}`);
	return { record: resolved.record, diag };
}

/** Clean up a real-home bg-state reservation. Best-effort: mark done then
 *  remove the run dir. Matches the pattern at
 *  `agents/test-fixtures/test-bg.mjs:cleanupRealHomeRun` exactly — handleBgCommand
 *  writes under <resolveTrustedHome()>/.pi/agent/bg/ regardless of the
 *  temp-home ctx.agentsHomeDir (N3 invariant). */
async function cleanupRealHomeRun(runId) {
	if (!runId) return;
	try {
		const realPaths = getBgRunPaths(runId);
		await markBgRunDone(realPaths).catch(() => {});
		await fsp.rm(realPaths.runDir, { recursive: true, force: true }).catch(() => {});
	} catch { /* swallow — cleanup is best-effort */ }
}

/** Set up the stub worker once per test process. The cmux backend's
 *  `workspace create --command` invokes `node <workerPath> <manifestPath>`,
 *  so the worker just needs to not crash immediately. SIGTERM handling
 *  ensures `cmux close-workspace` shuts the worker down cleanly. */
function setupStubWorker() {
	const workerDir = path.join(TMPDIR_BASE, "workers");
	fs.mkdirSync(workerDir, { recursive: true });
	const stubWorkerPath = path.join(workerDir, "bg-worker.mjs");
	fs.writeFileSync(
		stubWorkerPath,
		"// P5b-1-S3 e2e stub worker — sleeps so the cmux workspace stays open\n" +
		"process.stdin.resume();\n" +
		"const t = setTimeout(() => process.exit(0), 60000);\n" +
		"process.on('SIGTERM', () => { clearTimeout(t); process.exit(0); });\n" +
		"process.on('SIGINT', () => { clearTimeout(t); process.exit(0); });\n",
	);
	// Exercise the production resolution loop (existsSync + realpathSync over
	// WORKER_BASENAMES) instead of hardcoding the stub path — same discipline
	// as the S1 smoke test.
	const resolved = resolveWorkerPath(workerDir);
	if (!resolved) throw new Error("resolveWorkerPath could not locate the stub worker in " + workerDir);
	return resolved;
}

function makeCmuxBackend(workerPath) {
	return createCmuxBackend({
		executor: defaultCmuxExecutor(),
		workerPath,
		bgStateDir: getBgStateDir(),
		preference: CMUX_BACKEND_PREFERENCE,
	});
}

function step(name) {
	return {
		pass: () => process.stdout.write(`  ✓ ${name}\n`),
		fail: (err) => {
			process.stdout.write(`  ✗ ${name}\n`);
			throw err;
		},
	};
}

// ---------------------------------------------------------------------------
// Test 1: LaunchCreatesWorkspace (REQ-R2)
// ---------------------------------------------------------------------------

async function testLaunchCreatesWorkspace() {
	await withTempHome(async (home) => {
		const workerPath = setupStubWorker();
		__resetBgTerminalBackend();

		const backend = makeCmuxBackend(workerPath);
		registerBgTerminalBackend(backend);

		const { record, diag } = await setupRegisteredUserAgent(home, "p5b1s3-launch-probe");
		const captured = [];
		const ctx = makeCtx(home, captured);

		const before = await snapshotBgRunDirs();
		let runId;
		try {
			await handleBgCommand(`${record.name} test-task`, ctx, diag);
			runId = await findNewBgRunDir(before);

			// Capture the success notification. The handleBgCommand success
			// message is `Background agent <name> running (<prefix>…) via <backend>.`
			const success = captured.find((n) => /Background agent.*running/.test(n.msg));
			assert.ok(success, `expected success notification, got: ${captured.map((n) => n.msg).join(" | ")}`);
			assert.match(success.msg, /via cmux/, `success message must name the cmux backend; got: ${success.msg}`);
			assert.equal(success.level, "info", "success message must be info-level");

			// Verify the cmux workspace exists with the expected title.
			// The cmux backend encodes runId into the workspace name as
			// `pi-cmux-<runId>` (CMUX_WINDOW_PREFIX + runId). Filtering by
			// title avoids false positives from stale workspaces left over
			// by prior runs / failed tests.
			const workspaces = await listWorkspaces();
			const expectedTitle = `${CMUX_WINDOW_PREFIX}${runId}`;
			const ours = workspaces.find((ws) => ws.title === expectedTitle);
			assert.ok(ours, `cmux workspace '${expectedTitle}' not found; saw ${workspaces.length} workspaces: ${workspaces.map((w) => w.title ?? "(no title)").join(", ")}`);

			// The workspace must have a `ref` (opaque handle) so
			// close-workspace can use it. P1 fix from the S1 smoke test:
			// the title is NOT accepted by close-workspace; only
			// id|ref|index is.
			assert.ok(ours.ref, `workspace '${expectedTitle}' must have a ref; got: ${JSON.stringify(ours)}`);

			step("LaunchCreatesWorkspace").pass();
		} finally {
			// Cleanup: close the workspace (uses the ref, not the title) and
			// free the bg-state reservation. Even on assertion failure, the
			// try/finally ensures the developer's cmux + bg state are clean.
			const workspaces = await listWorkspaces().catch(() => []);
			const ours = workspaces.find((ws) => ws.title === `${CMUX_WINDOW_PREFIX}${runId ?? ""}`);
			if (ours) await closeWorkspace(ours.ref || ours.title);
			await cleanupRealHomeRun(runId);
			__resetBgTerminalBackend();
		}
	});
}

// ---------------------------------------------------------------------------
// Test 2: StatusListsRun (REQ-R2)
// ---------------------------------------------------------------------------

async function testStatusListsRun() {
	await withTempHome(async (home) => {
		const workerPath = setupStubWorker();
		__resetBgTerminalBackend();

		const backend = makeCmuxBackend(workerPath);
		registerBgTerminalBackend(backend);

		const { record, diag } = await setupRegisteredUserAgent(home, "p5b1s3-status-probe");
		const captured = [];
		const ctx = makeCtx(home, captured);

		const before = await snapshotBgRunDirs();
		let runId;
		try {
			// Drive the launch path so the run exists on disk.
			await handleBgCommand(`${record.name} test-task`, ctx, diag);
			runId = await findNewBgRunDir(before);
			assert.ok(runId, "preflight must have created a run dir");

			// Clear notifications and drive handleBgStatus. It reads the
			// real-home bg-state, joins it with backend.list() (live windows),
			// and emits one notify per run. The runId prefix (16 chars) is
			// what handleBgStatus surfaces — same as the success-message
			// truncation in handleBgCommand.
			captured.length = 0;
			await handleBgStatus(ctx);

			const statusMsg = captured.find((n) => /Background agent runs/.test(n.msg));
			assert.ok(statusMsg, `expected bg-status notification, got: ${captured.map((n) => n.msg).join(" | ")}`);
			const expectedPrefix = runId.slice(0, 16);
			assert.ok(statusMsg.msg.includes(expectedPrefix), `bg-status must include runId prefix '${expectedPrefix}'; got: ${statusMsg.msg}`);
			const statusLine = statusMsg.msg.split("\n").find((line) => line.includes(expectedPrefix));
			assert.ok(statusLine, `bg-status must include a line for runId prefix '${expectedPrefix}'; got: ${statusMsg.msg}`);
			assert.doesNotMatch(statusLine, /\(stale\)/, `bg-status line for '${expectedPrefix}' must not be stale; got: ${statusLine}`);

			step("StatusListsRun").pass();
		} finally {
			const workspaces = await listWorkspaces().catch(() => []);
			const ours = workspaces.find((ws) => ws.title === `${CMUX_WINDOW_PREFIX}${runId ?? ""}`);
			if (ours) await closeWorkspace(ours.ref || ours.title);
			await cleanupRealHomeRun(runId);
			__resetBgTerminalBackend();
		}
	});
}

// ---------------------------------------------------------------------------
// Test 3: StopClosesWorkspace (REQ-R2)
// ---------------------------------------------------------------------------

async function testStopClosesWorkspace() {
	await withTempHome(async (home) => {
		const workerPath = setupStubWorker();
		__resetBgTerminalBackend();

		const backend = makeCmuxBackend(workerPath);
		registerBgTerminalBackend(backend);

		const { record, diag } = await setupRegisteredUserAgent(home, "p5b1s3-stop-probe");
		const captured = [];
		const ctx = makeCtx(home, captured);

		const before = await snapshotBgRunDirs();
		let runId;
		try {
			await handleBgCommand(`${record.name} test-task`, ctx, diag);
			runId = await findNewBgRunDir(before);
			assert.ok(runId, "preflight must have created a run dir");

			// Sanity: workspace exists before stop.
			const beforeList = await listWorkspaces();
			const expectedTitle = `${CMUX_WINDOW_PREFIX}${runId}`;
			const beforeOurs = beforeList.find((ws) => ws.title === expectedTitle);
			assert.ok(beforeOurs, `cmux workspace '${expectedTitle}' should exist before stop; saw: ${beforeList.map((w) => w.title ?? "(no title)").join(", ")}`);
			assert.ok(beforeOurs.ref, "workspace must have a ref for close-workspace");

			// Drive the REAL handleBgStop. It correlates runId → windowId
			// via backend.list() (P1 round-trip), then calls backend.kill
			// which dispatches to `cmux close-workspace --workspace <ref>`.
			await handleBgStop(runId, ctx);

			// Give cmux a brief moment to actually remove the workspace
			// from its index. close-workspace is synchronous on the cmux
			// side, but the worker's SIGTERM delivery can race with the
			// workspace eviction; 250ms is the same back-off the S1
			// smoke test uses.
			await new Promise((r) => setTimeout(r, 300));

			const afterList = await listWorkspaces();
			const afterOurs = afterList.find((ws) => ws.title === expectedTitle);
			assert.ok(!afterOurs, `cmux workspace '${expectedTitle}' should be gone after stop; saw: ${afterList.map((w) => w.title ?? "(no title)").join(", ")}`);

			step("StopClosesWorkspace").pass();
		} finally {
			// Defensive cleanup: if the assertion failed mid-way, the
			// workspace may still be open. Close it so a retry isn't
			// polluted by a duplicate `pi-cmux-<runId>` workspace.
			const workspaces = await listWorkspaces().catch(() => []);
			const ours = workspaces.find((ws) => ws.title === `${CMUX_WINDOW_PREFIX}${runId ?? ""}`);
			if (ours) await closeWorkspace(ours.ref || ours.title);
			await cleanupRealHomeRun(runId);
			__resetBgTerminalBackend();
		}
	});
}

// ---------------------------------------------------------------------------
// Test 4: FallbackWhenCmuxDown (REQ-R3, UNGUARDED-IN-CI)
// ---------------------------------------------------------------------------

/** UNGUARDED-IN-CI manual stub. Taking the cmux daemon down is an
 *  out-of-band environment operation that can't be automated from inside
 *  the test process. This stub prints the manual step + the existing
 *  programmatic coverage, then exits 0 (the test "passes" by being a
 *  documented manual verification gate, per the slice spec). */
async function testFallbackWhenCmuxDown() {
	process.stdout.write("  ◌ FallbackWhenCmuxDown ... SKIP (UNGUARDED-IN-CI)\n");
	process.stdout.write("    MANUAL: stop cmux and run the test (per the S3 slice spec).\n");
	process.stdout.write("    Concretely:\n");
	process.stdout.write("      1. Cmd-Q the cmux GUI to take the daemon down.\n");
	process.stdout.write("      2. From this terminal:  /agents bg scout 'echo hi'\n");
	process.stdout.write("      3. Expect: `tmux ls` shows a new `pi-agent-bg-…` window AND\n");
	process.stdout.write("         the pi success message names `via tmux` (REQ-R3).\n");
	process.stdout.write("         Note: the plan is internally inconsistent here: REQ-R3 says the\n");
	process.stdout.write("         message should include 'cmux unavailable', but the executable\n");
	process.stdout.write("         plan pins only `via tmux`.\n");
	process.stdout.write("      4. Re-launch cmux when done; the fallback run is no longer\n");
	process.stdout.write("         addressable via /agents bg-stop (R1 lifecycle gap, EC14).\n");
	process.stdout.write("    Programmatic coverage of the dispatch fall-through (with a\n");
	process.stdout.write("    fake down-cmux backend) lives in\n");
	process.stdout.write("    agents/test-fixtures/test-bg.mjs : testBgCommandFallsThroughToTmux.\n");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
	console.log("P5b-1-S3 real-cmux end-to-end /agents bg dispatch test");
	console.log("(UNGUARDED-IN-CI: requires macOS + cmux ≥0.64.17 + CMUX_SOCKET_MODE=allowAll)\n");

	// Gate 1: macOS-only (cmux is Ghostty-based darwin multiplexer).
	if (process.platform !== "darwin") {
		console.log(`SKIPPED: this test requires macOS (process.platform=${process.platform}).`);
		await globalCleanup();
		process.exit(0);
	}

	// Gate 2: CMUX_SOCKET_MODE=allowAll. cmux 0.64.17+ ancestry-checks its
	// Unix socket; this test runs in a foreign process tree.
	if (process.env.CMUX_SOCKET_MODE !== "allowAll") {
		console.log("CONFIG-REQUIRED: CMUX_SOCKET_MODE=allowAll is not set.");
		console.log("cmux 0.64.17+ has a default ancestry check on its Unix socket.");
		console.log("This test exercises the backend from a foreign process tree.");
		console.log("Re-run with:  CMUX_SOCKET_MODE=allowAll bash cmux-terminal/test-fixtures/run-real-cmux-e2e.sh");
		await globalCleanup();
		process.exit(0);
	}

	// Gate 3: cmux installed + on $PATH.
	let versionOut;
	try {
		const { stdout } = await execFileP("cmux", ["version"], { timeout: 3000 });
		versionOut = stdout;
	} catch (err) {
		console.log("SKIPPED: cmux not on $PATH (or `cmux version` failed):", err.message);
		await globalCleanup();
		process.exit(0);
	}
	const v = parseCmuxVersion(versionOut);
	if (!v) {
		console.log(`SKIPPED: could not parse cmux version from: ${JSON.stringify(versionOut)}`);
		await globalCleanup();
		process.exit(0);
	}
	const minV = (() => {
		const [maj, min, pat] = MIN_CMUX_VERSION.split(".").map(Number);
		return { major: maj, minor: min, patch: pat };
	})();
	if (!versionGte(v, minV)) {
		console.log(`SKIPPED: cmux ${v.major}.${v.minor}.${v.patch} < required ${MIN_CMUX_VERSION}`);
		await globalCleanup();
		process.exit(0);
	}
	console.log(`  cmux version: ${v.major}.${v.minor}.${v.patch}`);

	// Gate 4: cmux socket actually reachable. Probes via the same command
	// the backend uses for isAvailable() (P2: real socket-roundtrip, not
	// the misleading `cmux version` which exits 0 even when the socket
	// is broken).
	try {
		await execFileP("cmux", ["workspace", "list", "--json"], { timeout: 3000 });
	} catch (err) {
		console.log("SKIPPED: cmux daemon unreachable from this process tree.");
		console.log("  Verify cmux GUI is running AND CMUX_SOCKET_MODE=allowAll is set in cmux's environment (not just this shell).");
		console.log("  Underlying error:", err.stderr?.toString() || err.message);
		await globalCleanup();
		process.exit(0);
	}

	// Set up the temp dir for the stub worker (shared across all 3 scripted tests).
	fs.mkdirSync(TMPDIR_BASE, { recursive: true });

	const tests = [
		{ name: "LaunchCreatesWorkspace", fn: testLaunchCreatesWorkspace },
		{ name: "StatusListsRun", fn: testStatusListsRun },
		{ name: "StopClosesWorkspace", fn: testStopClosesWorkspace },
		{ name: "FallbackWhenCmuxDown", fn: testFallbackWhenCmuxDown, unguarded: true },
	];

	let failures = 0;
	for (const t of tests) {
		try {
			await t.fn();
		} catch (err) {
			failures++;
			console.error(`\n  ✗ ${t.name} FAILED: ${err.message}`);
			if (err.stack) console.error(err.stack);
		}
	}

	await globalCleanup();

	if (failures > 0) {
		console.error(`\n❌ ${failures} of ${tests.length} test(s) failed`);
		process.exit(1);
	} else {
		const guarded = tests.filter((t) => !t.unguarded).length;
		console.log(`\n✅ All ${guarded} scripted test(s) passed (${tests.length - guarded} UNGUARDED-IN-CI manual stub also ran)`);
		process.exit(0);
	}
}

main().catch(async (err) => {
	await globalCleanup();
	console.error("Unexpected error:", err);
	process.exit(1);
});
