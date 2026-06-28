// P5b-1-S1: real-cmux integration smoke test.
//
// Exercises cmux-backend.ts against a REAL cmux 0.64.17+ daemon via the default
// CmuxExecutor (no fake). This is the integration counterpart to the 16 unit
// tests in test-cmux-backend.mjs — those tests verify argv shape via a fake
// executor; this test verifies the real cmux CLI accepts those args and the
// workspace lifecycle (create → list → kill-by-list-windowId → dead) actually
// works.
//
// What it verifies (per /tmp/p5b1s1-r3-fix.md spec):
//   1. cmux 0.64.17+ is installed and on $PATH
//   2. CMUX_SOCKET_MODE=allowAll is set (cmux has an ancestry check on its
//      Unix socket — without this, sibling/unrelated processes get denied)
//   3. `cmux workspace list --json` succeeds against the running socket
//      (sanity probe; P2 also relies on this command as the isAvailable probe)
//   4. createCmuxBackend end-to-end:
//        a. isAvailable() → true  (P2: socket-roundtrip probe)
//        b. launch() x2   → ok, returns a workspace:N handle each
//        c. list()        → returns both pi-cmux-* workspaces with windowId
//                           === the ref returned by launch (P1: NOT the title)
//        d. kill(windowId-from-list) → ok (P1: list() → kill() round-trip
//                           actually works against a real cmux)
//        e. isAlive()    → false for each, looked up by the same windowId
//   5. Best-effort cleanup (kills any leftover workspaces if anything fails)
//
// Skips (exit 0) if cmux is not on $PATH or version is below 0.64.17.
// FAILS HARD if CMUX_SOCKET_MODE is not allowAll — by spec, the test refuses
// to silently pass when the ancestry guard would mask socket failures.
//
// Worker: a tiny sleep-only .mjs placed in a temp dir, located via the existing
// resolveWorkerPath(searchDir) seam. This exercises the real resolution loop
// (existsSync + realpathSync over WORKER_BASENAMES) instead of hardcoding paths.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createCmuxBackend } from "../lib/cmux-backend.ts";
import { defaultCmuxExecutor } from "../lib/exec.ts";
import { resolveWorkerPath } from "../lib/resolve-worker-path.ts";

const execFileP = promisify(execFile);

const MIN_CMUX_VERSION = "0.64.17";
const TMPDIR_BASE = path.join(os.tmpdir(), `p5b1-cmux-smoke-${process.pid}`);

let launchedHandles = [];
let cleanedUp = false;
async function cleanup() {
	if (cleanedUp) return;
	cleanedUp = true;
	for (const h of launchedHandles) {
		try {
			await execFileP("cmux", ["close-workspace", "--workspace", h], { timeout: 3000 });
		} catch {
			/* may already be gone */
		}
	}
	launchedHandles = [];
	try {
		fs.rmSync(TMPDIR_BASE, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
}

function step(name, fn) {
	return (async () => {
		process.stdout.write(`  ${name} ... `);
		try {
			await fn();
			console.log("ok");
		} catch (err) {
			console.log("FAIL");
			throw err;
		}
	})();
}

/** Parse cmux's `cmux version` stdout (e.g. `cmux 0.64.17 (97) [hash]`). */
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

async function main() {
	console.log("P5b-1-S1 real-cmux smoke test");

	// ── Step 0: gate on CMUX_SOCKET_MODE=allowAll ────────────────────────────
	// cmux 0.64.17 performs an ancestry check on its Unix socket — only the
	// process tree that started cmux can talk to it by default. Other processes
	// (e.g. a node script spawned by a CI runner, a different shell, a sub-agent)
	// are denied unless the user opts in via CMUX_SOCKET_MODE=allowAll in the
	// cmux environment. The smoke test must be opt-in: if it's not set, the
	// socket call below will fail in a way that's hard to distinguish from a
	// genuine bug. Refuse to silently pass; surface the misconfiguration.
	if (process.env.CMUX_SOCKET_MODE !== "allowAll") {
		console.error("FAIL: CMUX_SOCKET_MODE=allowAll is required.");
		console.error("cmux 0.64.17 has a default ancestry check on its Unix socket.");
		console.error("This smoke test exercises the backend from a foreign process tree,");
		console.error("so the socket must be configured to accept all callers.");
		console.error("Re-run with:  CMUX_SOCKET_MODE=allowAll bash cmux-terminal/test-fixtures/test-real-cmux-smoke.sh");
		await cleanup();
		process.exit(1);
	}

	// ── Step 1: cmux installed? ──────────────────────────────────────────────
	let versionOut;
	try {
		const { stdout } = await execFileP("cmux", ["version"], { timeout: 3000 });
		versionOut = stdout;
	} catch (err) {
		console.log("SKIPPED: cmux not on $PATH (or `cmux version` failed):", err.message);
		await cleanup();
		process.exit(0);
	}
	const v = parseCmuxVersion(versionOut);
	if (!v) {
		console.log(`SKIPPED: could not parse cmux version from: ${JSON.stringify(versionOut)}`);
		await cleanup();
		process.exit(0);
	}
	const minV = (() => {
		const [maj, min, pat] = MIN_CMUX_VERSION.split(".").map(Number);
		return { major: maj, minor: min, patch: pat };
	})();
	if (!versionGte(v, minV)) {
		console.log(`SKIPPED: cmux ${v.major}.${v.minor}.${v.patch} < required ${MIN_CMUX_VERSION}`);
		await cleanup();
		process.exit(0);
	}
	console.log(`  cmux version: ${v.major}.${v.minor}.${v.patch}`);

	// ── Step 2: cmux socket actually reachable? ─────────────────────────────
	// Sanity probe — if the socket is missing or unreachable, `cmux version`
	// still prints to stdout but other cmux cmds will fail. Re-probe with a
	// command that round-trips through the socket (`workspace list`).
	try {
		await execFileP("cmux", ["workspace", "list", "--json"], { timeout: 3000 });
	} catch (err) {
		console.error("FAIL: `cmux workspace list --json` failed — socket unreachable from this process tree.");
		console.error("  Verify CMUX_SOCKET_MODE=allowAll is set in cmux's environment (not just this shell).");
		console.error("  Underlying error:", err.stderr?.toString() || err.message);
		await cleanup();
		process.exit(1);
	}

	// ── Step 3: build backend + temp worker + temp bgStateDir ──────────────
	fs.mkdirSync(TMPDIR_BASE, { recursive: true });

	// Stub worker: sleeps 60s then exits cleanly. cmux's `workspace create
	// --command <shell-string>` will run `node <workerPath> <manifestPath>`,
	// so the worker just needs to not crash. Manifest path is ignored — we
	// never read it in the stub.
	const workerDir = path.join(TMPDIR_BASE, "workers");
	fs.mkdirSync(workerDir, { recursive: true });
	const stubWorkerPath = path.join(workerDir, "bg-worker.mjs");
	fs.writeFileSync(
		stubWorkerPath,
		"// P5b-1-S1 smoke stub worker — sleeps so the workspace stays open\n" +
		"process.stdin.resume();\n" +
		"const t = setTimeout(() => process.exit(0), 60000);\n" +
		"process.on('SIGTERM', () => { clearTimeout(t); process.exit(0); });\n",
	);

	// Exercise the production resolution loop (existsSync + realpathSync over
	// WORKER_BASENAMES) instead of hardcoding the stub path.
	const resolvedWorkerPath = resolveWorkerPath(workerDir);
	if (!resolvedWorkerPath) {
		console.error("FAIL: resolveWorkerPath could not locate the stub worker in", workerDir);
		await cleanup();
		process.exit(1);
	}
	if (resolvedWorkerPath !== fs.realpathSync(stubWorkerPath)) {
		console.error(`FAIL: resolveWorkerPath returned ${resolvedWorkerPath}, expected realpath of ${stubWorkerPath}`);
		await cleanup();
		process.exit(1);
	}

	const bgStateDir = path.join(TMPDIR_BASE, "bg-state");
	fs.mkdirSync(bgStateDir, { recursive: true });
	// P5b-1-S1: create TWO workspaces so list() → kill() round-trip can be
	// exercised against a non-empty result. Two distinct runIds keep the
	// workspace titles unique so cmux doesn't deduplicate.
	const runIdA = `bg-${Date.now()}-cmux-smoke-a`;
	const runIdB = `bg-${Date.now()}-cmux-smoke-b`;
	const manifestPathA = path.join(bgStateDir, runIdA, "manifest.json");
	const manifestPathB = path.join(bgStateDir, runIdB, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPathA), { recursive: true });
	fs.mkdirSync(path.dirname(manifestPathB), { recursive: true });
	fs.writeFileSync(manifestPathA, JSON.stringify({ version: 1, runId: runIdA }, null, 2));
	fs.writeFileSync(manifestPathB, JSON.stringify({ version: 1, runId: runIdB }, null, 2));

	const executor = defaultCmuxExecutor();
	const backend = createCmuxBackend({ executor, workerPath: resolvedWorkerPath, bgStateDir });

	// Track every windowId we launch so cleanup() can sweep them all, even on
	// mid-test failure. This list is the source of truth for both the test
	// logic and cleanup.
	const windowIds = [];
	const runIds = [runIdA, runIdB];

	try {
		await step("backend.name === 'cmux'", async () => {
			assert.equal(backend.name, "cmux");
		});

		await step("isAvailable() returns true against real cmux daemon (P2: socket-roundtrip probe)", async () => {
			const result = await backend.isAvailable();
			assert.equal(result, true, "isAvailable must be true when cmux socket is reachable (probes via `workspace list --json`, not `version`)");
		});

		// Launch both workspaces and capture the windowIds returned by cmux.
		// We don't pre-judge whether launch() returns a workspace:N ref or
		// falls back to the title — both are valid per the backend contract.
		// The P1 assertion that matters is whether list() agrees with launch()
		// on what the windowId is.
		for (const [i, runId] of runIds.entries()) {
			const stepName = `launch() #${i + 1} creates a workspace for runId=${runId}`;
			await step(stepName, async () => {
				const r = await backend.launch({
					agentName: "scout",
					runId,
					manifestPath: i === 0 ? manifestPathA : manifestPathB,
					cwd: os.homedir(),
				});
				assert.equal(r.status, "ok", `launch failed: ${JSON.stringify(r)}`);
				assert.ok(r.windowId, "launch must return a non-empty windowId");
				const looksLikeRef = /^workspace:\d+$/.test(r.windowId);
				const looksLikeTitle = r.windowId === `pi-cmux-${runId}`;
				assert.ok(looksLikeRef || looksLikeTitle,
					`windowId must be either a workspace:N ref or the title 'pi-cmux-${runId}', got: ${r.windowId}`);
				windowIds.push(r.windowId);
				launchedHandles.push(r.windowId);
			});
		}

		await step("list() returns both pi-cmux-* workspaces with windowId === launch's ref (P1)", async () => {
			const entries = await backend.list();
			// Filter to just the two we launched — there may be other pi-cmux-*
			// workspaces from prior runs. We assert on the union, not the
			// count, to stay robust against stale state.
			const ours = entries.filter((e) => runIds.includes(e.runId));
			assert.equal(ours.length, 2, `list() must return both our pi-cmux-* workspaces (got runs: ${ours.map((e) => e.runId).join(", ")})`);
			for (const entry of ours) {
				assert.ok(entry.windowId, `list() entry for runId=${entry.runId} must have a non-empty windowId`);
				const looksLikeRef = /^workspace:\d+$/.test(entry.windowId);
				const looksLikeTitle = entry.windowId.startsWith("pi-cmux-");
				assert.ok(looksLikeRef || looksLikeTitle,
					`P1: list() windowId must be either a workspace:N ref or a pi-cmux-* title, got: ${entry.windowId}`);
				// P1: windowId from list() MUST round-trip into kill() — the
				// whole point of the fix. It must be acceptable to cmux's
				// `close-workspace --workspace` as id|ref|index.
				assert.ok(!entry.windowId.startsWith("pi-cmux-"),
					`P1: list() windowId must NOT be the title (close-workspace rejects titles); got: ${entry.windowId}`);
				assert.equal(entry.runId === runIdA ? windowIds[0] : windowIds[1], entry.windowId,
					`P1: list().windowId for runId=${entry.runId} must equal launch()'s windowId (ref)`);
				assert.equal(entry.agentName, undefined, "agentName MUST be undefined (cmux has no user-options equivalent)");
			}
		});

		// Snapshot the list-windowIds, then kill them via the IDs list() returned.
		// P1 is validated by the fact that this works against a real daemon:
		// the previous shape (title-as-windowId) would have caused cmux to
		// reject `close-workspace --workspace pi-cmux-bg-...`.
		const listWindowIds = (await backend.list())
			.filter((e) => runIds.includes(e.runId))
			.map((e) => e.windowId);

		await step("kill(windowId-from-list) succeeds for each workspace (P1 round-trip)", async () => {
			assert.equal(listWindowIds.length, 2, "expected 2 windowIds from list() before killing");
			for (const [i, wid] of listWindowIds.entries()) {
				const r = await backend.kill(wid);
				assert.equal(r.status, "ok", `kill(windowId-from-list) failed for #${i + 1} (${wid}): ${JSON.stringify(r)}`);
			}
		});

		await step("isAlive(windowId-from-list) returns false for each after kill", async () => {
			// Give cmux a moment to actually remove the workspaces from its list.
			// The handle we got was a ref like workspace:7 — after close-workspace
			// that index may either be gone or get reused. Either way, isAlive
			// against the same windowId MUST now report false.
			await new Promise((resolve) => setTimeout(resolve, 250));
			for (const wid of listWindowIds) {
				const alive = await backend.isAlive(wid);
				assert.equal(alive, false, `isAlive must be false after kill for windowId=${wid}`);
			}
			// Drop from cleanup list — they're dead.
			launchedHandles = [];
			windowIds.length = 0;
		});

		console.log("\n✅ ALL SMOKE TESTS PASSED");
		await cleanup();
		process.exit(0);
	} catch (err) {
		await cleanup();
		console.error("\n❌ Real-cmux smoke test failed:", err.message);
		if (err.stack) console.error(err.stack);
		process.exit(1);
	}
}

main().catch(async (err) => {
	await cleanup();
	console.error("Unexpected error:", err);
	process.exit(1);
});