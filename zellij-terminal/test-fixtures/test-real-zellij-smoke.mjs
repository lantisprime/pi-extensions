// P5b-2: real-zellij integration smoke test (UNGUARDED-IN-CI per REQ-13).
//
// Exercises zellij-backend.ts against a REAL zellij 0.44.3+ install via the
// default ZellijExecutor + the production spawnAttachSession (no fake). This
// is the integration counterpart to the 33 unit tests in test-zellij-backend.mjs
// — those tests verify argv shape via a fake executor; this test verifies
// the real zellij CLI accepts those args and the session lifecycle
// (attach -b → list-sessions → run → kill) actually works end-to-end.
//
// What it verifies (per REQ-13):
//   1. zellij >= 0.44.3 is installed and on $PATH
//   2. createZellijBackend end-to-end:
//        a. isAvailable() returns true
//        b. launch() creates a `pi-zellij-<runId>` session (visible in
//           `zellij list-sessions -s`) AND runs the stub worker (visible via
//           `zellij list-sessions -s` round-trip)
//        c. list() returns the session with windowId === session name
//        d. kill(windowId-from-list) → ok, session gone
//   3. Best-effort cleanup (deletes the test session if anything fails)
//
// Skips (exit 0) if zellij is not on $PATH or version is below 0.44.3.
// FAILS HARD if the stub worker exits immediately (i.e. pane crashes).
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
import { createZellijBackend } from "../lib/zellij-backend.ts";
import { defaultZellijExecutor, spawnAttachSession } from "../lib/exec.ts";
import { resolveWorkerPath } from "../lib/resolve-worker-path.ts";

const execFileP = promisify(execFile);

// Ensure ZELLIJ_SOCKET_DIR is set in process.env for this test's DIRECT
// execFileP verification calls (zellij --version, zellij list-sessions -s
// in the post-launch / post-kill assertions, cleanup). The production code's
// getZellijSpawnEnv() in lib/exec.ts sets it for the backend's spawn + the
// executor's execFile calls, but the direct execFileP calls in this smoke
// test inherit from process.env. Mirror the production default so the smoke
// is portable across machines with long TMPDIRs.
if (!process.env.ZELLIJ_SOCKET_DIR) {
	process.env.ZELLIJ_SOCKET_DIR = "/tmp/zellij-sockets";
}

const MIN_ZELLIJ_VERSION = "0.44.3";
const TMPDIR_BASE = path.join(os.tmpdir(), `p5b2-zellij-smoke-${process.pid}`);

let sessionNames = [];
let cleanedUp = false;
async function cleanup() {
	if (cleanedUp) return;
	cleanedUp = true;
	for (const s of sessionNames) {
		try {
			await execFileP("zellij", ["kill-session", s], { timeout: 3000 });
		} catch {
			/* may already be gone */
		}
		try {
			await execFileP("zellij", ["delete-session", "-f", s], { timeout: 3000 });
		} catch {
			/* may already be gone */
		}
	}
	sessionNames = [];
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

/** Parse zellij's `zellij --version` stdout (e.g. `zellij 0.44.3`). */
function parseZellijVersion(stdout) {
	const m = stdout.match(/zellij\s+(\d+)\.(\d+)\.(\d+)/);
	if (!m) return null;
	return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function versionGte(a, b) {
	if (a.major !== b.major) return a.major > b.major;
	if (a.minor !== b.minor) return a.minor > b.minor;
	return a.patch >= b.patch;
}

async function main() {
	console.log("P5b-2 real-zellij smoke test");

	// ── Step 1: zellij installed? ───────────────────────────────────────────
	let versionOut;
	try {
		const { stdout } = await execFileP("zellij", ["--version"], { timeout: 3000 });
		versionOut = stdout;
	} catch (err) {
		console.log("SKIPPED: zellij not on $PATH (or `zellij --version` failed):", err.message);
		await cleanup();
		process.exit(0);
	}
	const v = parseZellijVersion(versionOut);
	if (!v) {
		console.log(`SKIPPED: could not parse zellij version from: ${JSON.stringify(versionOut)}`);
		await cleanup();
		process.exit(0);
	}
	const minV = (() => {
		const [maj, min, pat] = MIN_ZELLIJ_VERSION.split(".").map(Number);
		return { major: maj, minor: min, patch: pat };
	})();
	if (!versionGte(v, minV)) {
		console.log(`SKIPPED: zellij ${v.major}.${v.minor}.${v.patch} < required ${MIN_ZELLIJ_VERSION}`);
		await cleanup();
		process.exit(0);
	}
	console.log(`  zellij version: ${v.major}.${v.minor}.${v.patch}`);

	// ── Step 2: build backend + temp worker + temp bgStateDir ──────────────
	fs.mkdirSync(TMPDIR_BASE, { recursive: true });

	// Stub worker: sleeps 60s then exits cleanly. zellij's `run -- <cmd>` will
	// run `node <workerPath> <manifestPath>`, so the worker just needs to not
	// crash. Manifest path is ignored — we never read it in the stub.
	const workerDir = path.join(TMPDIR_BASE, "workers");
	fs.mkdirSync(workerDir, { recursive: true });
	const stubWorkerPath = path.join(workerDir, "bg-worker.mjs");
	fs.writeFileSync(
		stubWorkerPath,
		"// P5b-2 smoke stub worker — sleeps so the session stays open\n" +
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

	const bgStateDir = path.join(TMPDIR_BASE, "bg-state");
	fs.mkdirSync(bgStateDir, { recursive: true });
	const runId = `bg-${Date.now()}-zellij-smoke`;
	const manifestPath = path.join(bgStateDir, runId, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, runId }, null, 2));

	// PRODUCTION attachSpawner (not a custom workaround). The production code
	// in lib/exec.ts:getZellijSpawnEnv() ensures ZELLIJ_SOCKET_DIR is set to a
	// short path so the IPC socket fits within zellij's 103-byte limit on
	// machines with long TMPDIRs (e.g. macOS /var/folders/.../T/).
	const executor = defaultZellijExecutor();
	const backend = createZellijBackend({
		executor,
		attachSpawner: spawnAttachSession,
		workerPath: resolvedWorkerPath,
		bgStateDir,
	});
	const expectedSessionName = "pi-zellij-" + runId;
	sessionNames.push(expectedSessionName);

	try {
		await step("backend.name === 'zellij'", async () => {
			assert.equal(backend.name, "zellij");
		});

		await step("LaunchCreatesSession (REQ-13: isAvailable true + launch creates the session)", async () => {
			const avail = await backend.isAvailable();
			assert.equal(avail, true, "isAvailable must be true when zellij is installed and reachable");
			const r = await backend.launch({
				agentName: "scout",
				runId,
				manifestPath,
				cwd: os.homedir(),
			});
			assert.equal(r.status, "ok", `launch failed: ${JSON.stringify(r)}`);
			assert.ok(r.windowId, "launch must return a non-empty windowId");
			assert.equal(r.windowId, expectedSessionName, "windowId MUST equal pi-zellij-<runId>");
			// Confirm the session actually exists in zellij's list.
			const { stdout } = await execFileP("zellij", ["list-sessions", "-s"], { timeout: 3000 });
			assert.ok(
				stdout.split("\n").includes(expectedSessionName),
				`session ${expectedSessionName} must be in 'zellij list-sessions -s' (got: ${stdout})`,
			);
		});

		await step("StatusListsRun (REQ-13: list() returns the session with the expected windowId)", async () => {
			const entries = await backend.list();
			const match = entries.find((e) => e.windowId === expectedSessionName);
			assert.ok(match, `list() must return an entry for ${expectedSessionName} (got: ${JSON.stringify(entries.map((e) => e.windowId))})`);
			assert.equal(match.runId, runId, "recovered runId must equal the original runId");
		});

		await step("StopClosesSession (REQ-13: kill(windowId) returns ok and the session is gone)", async () => {
			const k = await backend.kill(expectedSessionName);
			assert.equal(k.status, "ok", `kill failed: ${JSON.stringify(k)}`);
			// Confirm the session is no longer listed. Note: zellij exits 1 +
			// "No active zellij sessions found." when zero sessions remain
			// (the healthy-but-empty state), so we accept that as "no
			// session found" rather than a test failure.
			let stdout = "";
			try {
				const res = await execFileP("zellij", ["list-sessions", "-s"], { timeout: 3000 });
				stdout = res.stdout;
			} catch (e) {
				// Healthy-but-empty: list-sessions exits 1 with the "no sessions"
				// message. The session is confirmed gone in that case.
				const errMsg = e?.stderr?.toString() ?? "";
				if (!/No active zellij sessions found\./.test(errMsg)) throw e;
			}
			assert.ok(
				!stdout.split("\n").includes(expectedSessionName),
				`session ${expectedSessionName} must be gone after kill (got: ${stdout})`,
			);
			// Clear from cleanup list since we already killed it.
			sessionNames = sessionNames.filter((s) => s !== expectedSessionName);
		});
	} finally {
		await cleanup();
	}
}

main().catch(async (err) => {
	console.error("zellij smoke test failed:", err?.message ?? err);
	await cleanup();
	process.exit(1);
});
