// P5b-1-S1: real-cmux integration smoke test.
//
// Exercises cmux-backend.ts against a REAL cmux 0.64.17+ daemon via the default
// CmuxExecutor (no fake). This is the integration counterpart to the 12 unit
// tests in test-cmux-backend.mjs — those tests verify argv shape via a fake
// executor; this test verifies the real cmux CLI accepts those args and the
// workspace lifecycle (create → alive → close-workspace → dead) actually works.
//
// What it verifies (per /tmp/p5b1s1-realfix.md spec):
//   1. cmux 0.64.17+ is installed and on $PATH
//   2. CMUX_SOCKET_MODE=allowAll is set (cmux has an ancestry check on its
//      Unix socket — without this, sibling/unrelated processes get denied)
//   3. `cmux version` succeeds against the running socket (sanity probe)
//   4. createCmuxBackend end-to-end:
//        a. isAvailable() → true
//        b. launch()     → ok, returns a workspace:N handle
//        c. isAlive()    → true (window appears in `workspace list --json`)
//        d. kill()       → ok (via `close-workspace --workspace <id>`,
//                          NOT `close-window` which would kill other
//                          workspaces in the same window)
//        e. isAlive()    → false after kill
//   5. Best-effort cleanup (kills the workspace if anything fails mid-test)
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

let launchedHandle = null;
let cleanedUp = false;
async function cleanup() {
	if (cleanedUp) return;
	cleanedUp = true;
	if (launchedHandle) {
		try {
			await execFileP("cmux", ["close-workspace", "--workspace", launchedHandle], { timeout: 3000 });
		} catch {
			/* may already be gone */
		}
	}
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
	const runId = `bg-${Date.now()}-cmux-smoke`;
	const manifestPath = path.join(bgStateDir, runId, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, runId }, null, 2));

	const executor = defaultCmuxExecutor();
	const backend = createCmuxBackend({ executor, workerPath: resolvedWorkerPath, bgStateDir });

	try {
		await step("backend.name === 'cmux'", async () => {
			assert.equal(backend.name, "cmux");
		});

		await step("isAvailable() returns true against real cmux daemon", async () => {
			const result = await backend.isAvailable();
			assert.equal(result, true, "isAvailable must be true when cmux is installed and socket is reachable");
		});

		await step("launch() creates a workspace and returns workspace:N handle", async () => {
			const r = await backend.launch({
				agentName: "scout",
				runId,
				manifestPath,
				cwd: os.homedir(),
			});
			assert.equal(r.status, "ok", `launch failed: ${JSON.stringify(r)}`);
			assert.ok(r.windowId, "launch must return a non-empty windowId");
			// cmux 0.64.17 prints the workspace handle (e.g. "workspace:7") to
			// stdout. Accept either the handle or a fallback to the workspace
			// title — both are valid windowId values per the backend contract.
			const looksLikeRef = /^workspace:\d+$/.test(r.windowId);
			const looksLikeTitle = r.windowId === `pi-cmux-${runId}`;
			assert.ok(looksLikeRef || looksLikeTitle,
				`windowId must be either a workspace:N ref or the title 'pi-cmux-${runId}', got: ${r.windowId}`);
			launchedHandle = r.windowId;
		});

		await step("isAlive() returns true after launch", async () => {
			const alive = await backend.isAlive(launchedHandle);
			assert.equal(alive, true, `isAlive must be true immediately after launch (handle: ${launchedHandle})`);
		});

		await step("kill() succeeds via close-workspace (NOT close-window)", async () => {
			const r = await backend.kill(launchedHandle);
			assert.equal(r.status, "ok", `kill failed: ${JSON.stringify(r)}`);
		});

		await step("isAlive() returns false after kill", async () => {
			// Give cmux a moment to actually remove the workspace from its list.
			// The handle we got was a ref like workspace:7 — after close-workspace
			// that index may either be gone or get reused. Either way, the title
			// match against `pi-cmux-<runId>` (the backend's isAlive lookup) must
			// fail because the workspace with that title no longer exists.
			await new Promise((resolve) => setTimeout(resolve, 200));
			const alive = await backend.isAlive(`pi-cmux-${runId}`);
			assert.equal(alive, false, `isAlive must be false after kill (looked up by title 'pi-cmux-${runId}')`);
			launchedHandle = null; // cleanup no longer needed
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