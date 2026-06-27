// P5 real-tmux integration smoke test.
//
// Exercises the actual tmux-backend.ts implementation against a real tmux
// server on an ISOLATED socket. Does NOT touch the user's default tmux
// session. Cleans up on exit (kill-server + temp dirs).
//
// Approach: wraps defaultTmuxExecutor with a thin test adapter that always
// passes `-L <socket>` to every tmux invocation. This makes the test
// independent of $TMUX env (and thus doesn't require parsing the complex
// socket-path,PID,session-id format).
//
// What it verifies:
//   1. isAvailable() probes via real tmux has-session
//   2. launch() creates a real tmux window with the expected name
//   3. The new-window argv is well-formed (verified via direct tmux CLI)
//   4. @pi_run_id + @pi_agent_name user-options are set correctly
//   5. list() recovers runId/agentName from user-options
//   6. isAlive() returns true while the window exists
//   7. kill() removes the window and is idempotent on missing windows
//
// Skips (exit 0) if tmux is not on $PATH.
//
// Usage:
//   node --experimental-strip-types tmux-terminal/test-fixtures/test-real-tmux-smoke.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createTmuxBackend } from "../lib/tmux-backend.ts";
import { defaultTmuxExecutor } from "../lib/exec.ts";

const execFileP = promisify(execFile);

const PID = process.pid;
const SOCKET = `p5-smoke-${PID}`;
const TMPDIR_BASE = path.join(os.tmpdir(), `p5-smoke-${PID}`);

let cleanedUp = false;
async function cleanup() {
	if (cleanedUp) return;
	cleanedUp = true;
	try {
		await execFileP("tmux", ["-L", SOCKET, "kill-server"], { timeout: 3000 });
	} catch {
		/* may already be gone */
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

/** Wrap defaultTmuxExecutor to always pass -L <socket> on every tmux call. */
function testExecutor(socket) {
	const inner = defaultTmuxExecutor();
	return {
		async exec(args, opts) {
			return await inner.exec(["-L", socket, ...args], opts);
		},
	};
}

async function main() {
	console.log(`P5 real-tmux smoke test (isolated socket: ${SOCKET})`);

	// Step 0: tmux available?
	let tmuxVersion;
	try {
		const { stdout } = await execFileP("tmux", ["-V"]);
		tmuxVersion = stdout.trim();
	} catch {
		console.log("SKIPPED: tmux not on $PATH");
		await cleanup();
		process.exit(0);
	}
	console.log(`  tmux version: ${tmuxVersion}`);

	// Step 1: Start isolated tmux server with a session
	fs.mkdirSync(TMPDIR_BASE, { recursive: true });
	try {
		await execFileP("tmux", ["-L", SOCKET, "kill-server"], { timeout: 2000 });
	} catch {
		/* no prior server */
	}
	const { stdout: startOut } = await execFileP("tmux", [
		"-L", SOCKET, "new-session", "-d",
		"-s", "smoke",
		"-x", "200", "-y", "50",
	], { timeout: 5000 });
	console.log(`  ✓ tmux server started on socket '${SOCKET}'`);

	// Step 2: Create bg-state dir + manifest file (REQ-20)
	const bgStateDir = path.join(TMPDIR_BASE, "bg-state");
	const runId = `bg-${Date.now()}-smoke`;
	const manifestPath = path.join(bgStateDir, runId, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(
		manifestPath,
		JSON.stringify({ version: 1, manifestPath, homeDir: os.homedir() }, null, 2),
	);

	// Step 3: Stub worker that sleeps long enough for the test to complete
	const workerPath = path.join(TMPDIR_BASE, "p5-smoke-worker.mjs");
	fs.writeFileSync(
		workerPath,
		"// P5 smoke stub worker — sleeps so the window stays open\nprocess.stdin.resume();\nsetTimeout(() => process.exit(0), 60000);\n",
	);

	const executor = testExecutor(SOCKET);
	const backend = createTmuxBackend({ executor, workerPath, bgStateDir });

	try {
		await step("backend.name === 'tmux'", async () => {
			assert.equal(backend.name, "tmux");
		});

		await step("isAvailable() probes real tmux server", async () => {
			// Unset TMUX so isAvailable() takes the has-session probe path
			const prevTmux = process.env.TMUX;
			delete process.env.TMUX;
			try {
				const result = await backend.isAvailable();
				assert.equal(result, true);
			} finally {
				if (prevTmux !== undefined) process.env.TMUX = prevTmux;
			}
		});

		let windowId;
		await step("launch() creates tmux window", async () => {
			const r = await backend.launch({
				agentName: "scout",
				runId,
				manifestPath,
				cwd: os.homedir(),
			});
			assert.equal(r.status, "ok", JSON.stringify(r));
			assert.equal(r.windowId, `pi-agent-${runId}`);
			windowId = r.windowId;
		});

		await step("window visible via direct tmux CLI on test socket", async () => {
			const { stdout } = await execFileP("tmux", [
				"-L", SOCKET, "list-windows", "-t", "smoke", "-F", "#{window_name}",
			], { timeout: 3000 });
			assert.ok(stdout.includes(`pi-agent-${runId}`),
				`window not in list-windows: ${stdout}`);
		});

		await step("@pi_run_id + @pi_agent_name set correctly", async () => {
			const { stdout } = await execFileP("tmux", [
				"-L", SOCKET, "list-windows", "-t", "smoke",
				"-F", "#{window_name} #{@pi_run_id} #{@pi_agent_name}",
			], { timeout: 3000 });
			assert.ok(stdout.includes(runId), `@pi_run_id missing: ${stdout}`);
			assert.ok(stdout.includes("scout"), `@pi_agent_name missing: ${stdout}`);
		});

		await step("isAlive() returns true while window exists", async () => {
			const alive = await backend.isAlive(windowId);
			assert.equal(alive, true);
		});

		await step("list() recovers runId + agentName from user-options", async () => {
			const entries = await backend.list();
			assert.equal(entries.length, 1, `expected 1 entry, got ${entries.length}`);
			assert.equal(entries[0].windowId, windowId);
			assert.equal(entries[0].runId, runId);
			assert.equal(entries[0].agentName, "scout");
		});

		await step("kill() removes window", async () => {
			const r = await backend.kill(windowId);
			assert.equal(r.status, "ok", JSON.stringify(r));
			const { stdout } = await execFileP("tmux", [
				"-L", SOCKET, "list-windows", "-t", "smoke", "-F", "#{window_name}",
			], { timeout: 3000 });
			assert.ok(!stdout.includes(windowId),
				`window still in list after kill: ${stdout}`);
		});

		await step("isAlive() returns false after kill", async () => {
			const alive = await backend.isAlive(windowId);
			assert.equal(alive, false);
		});

		await step("kill() is idempotent on missing window", async () => {
			const r = await backend.kill(windowId);
			assert.equal(r.status, "ok", "kill on missing window must be idempotent");
		});

		console.log("\n✅ All real-tmux smoke tests passed");
		await cleanup();
		process.exit(0);
	} catch (err) {
		await cleanup();
		console.error("\n❌ Real-tmux smoke test failed:", err.message);
		process.exit(1);
	}
}

main().catch(async (err) => {
	await cleanup();
	console.error("Unexpected error:", err);
	process.exit(1);
});