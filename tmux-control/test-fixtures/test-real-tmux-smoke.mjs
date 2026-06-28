// tmux-control: real-tmux integration smoke test.
//
// Exercises the actual tmux-control modules against a real tmux server on
// an ISOLATED socket. Does NOT touch the user's default tmux session.
// Cleans up on exit (kill-server).
//
// Verifies:
//   1. launchSession creates a new top-level session
//   2. new-window + listAgentWindows sees the window with session:index
//   3. captureWindow uses session:index target successfully
//      (NOT bare name — bare name breaks when multiple sessions exist)
//   4. sendText writes into the shell window
//   5. resolveRunId falls back to prefix-match when no backend is registered
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { listAgentWindows } from "../lib/list.ts";
import { captureWindow } from "../lib/capture.ts";
import { sendText } from "../lib/send.ts";
import { pasteText } from "../lib/paste.ts";
import { waitForWindow } from "../lib/wait.ts";
import { launchSession } from "../lib/launch.ts";
import { resolveRunId } from "../lib/resolve.ts";
import { defaultTmuxExecutor } from "../lib/exec.ts";
import { isolatedServerPrefix } from "../lib/socket.ts";

const execFileP = promisify(execFile);

const PID = process.pid;
const SOCKET = `pi-ctrl-smoke-${PID}`;
const SOCK = isolatedServerPrefix(SOCKET);

let cleanedUp = false;
async function cleanup() {
	if (cleanedUp) return;
	cleanedUp = true;
	try { await execFileP("tmux", [...SOCK, "kill-server"], { timeout: 3000 }); } catch { /* may be gone */ }
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

async function main() {
	console.log(`tmux-control real-tmux smoke (isolated socket: ${SOCKET})`);

	// Step 0: tmux available?
	try {
		const { stdout } = await execFileP("tmux", ["-V"]);
		console.log(`  tmux version: ${stdout.trim()}`);
	} catch {
		console.log("SKIPPED: tmux not on $PATH");
		await cleanup();
		process.exit(0);
	}

	// Step 1: Start isolated server
	try { await execFileP("tmux", [...SOCK, "kill-server"], { timeout: 2000 }); } catch { /* no prior */ }
	await execFileP("tmux", [...SOCK, "new-session", "-d", "-s", "smoke", "-x", "200", "-y", "50"], { timeout: 5000 });
	console.log(`  ✓ tmux server started on socket '${SOCKET}'`);

	// Step 2: Use default executor; pass SOCK prefix to every call directly.
	const executor = defaultTmuxExecutor();
	const prefix = "pi-agent-";

	try {
		let capturedRunId;

		await step("launchSession creates a top-level session 'logs'", async () => {
			const r = await launchSession(executor, SOCK, "logs");
			assert.equal(r.ok, true);
			assert.equal(r.sessionName, "logs");
		});

		// Step B: explicitly create an agent-style window via new-window, named
		// `pi-agent-bg-run-1`. This is the tmux-terminal backend's pattern.
		await step("new-window creates a 'pi-agent-bg-run-1' window in 'smoke' session", async () => {
			const r = await executor.exec([...SOCK, "new-window", "-d", "-n", "pi-agent-bg-run-1", "-t", "smoke"], { timeoutMs: 5000 });
			assert.equal(r.ok, true);
			capturedRunId = "bg-run-1";
		});

		let listedTarget;
		await step("listAgentWindows sees it under prefix pi-agent-", async () => {
			const wins = await listAgentWindows(executor, SOCK, prefix);
			const found = wins.find((w) => w.windowName === "pi-agent-bg-run-1");
			assert.ok(found, `expected window in list, got: ${JSON.stringify(wins)}`);
			assert.equal(found.sessionName, "smoke");
			assert.equal(found.windowIndex, "2", "second window in smoke session");
			listedTarget = { sessionName: found.sessionName, windowIndex: found.windowIndex };
		});

		await step("listAgentWindows hides non-prefixed windows", async () => {
			const wins = await listAgentWindows(executor, SOCK, prefix);
			assert.ok(!wins.some((w) => w.windowName === "zsh"), `default window leaked`);
		});

		await step("captureWindow works via session:index target", async () => {
			const r = await captureWindow(executor, SOCK, listedTarget, { lines: 50 });
			assert.equal(r.ok, true, `capture failed: ${r.error ?? "?"}`);
			assert.equal(typeof r.output, "string", "output is a string");
		});

		await step("sendText writes into the window", async () => {
			const r = await sendText(executor, SOCK, listedTarget, "echo hello-from-tmux-control");
			assert.equal(r.ok, true);
			await new Promise((r) => setTimeout(r, 500));
			const cap = await captureWindow(executor, SOCK, listedTarget, { lines: 100 });
			assert.equal(cap.ok, true);
			assert.ok((cap.output ?? "").includes("hello-from-tmux-control"), `expected echo in pane: ${cap.output}`);
		});

		await step("resolveRunId falls back to prefix-match without backend", async () => {
			const r = await resolveRunId(capturedRunId, executor, SOCK, { prefix });
			assert.equal(r.ok, true);
			assert.equal(r.window.windowName, "pi-agent-bg-run-1");
			assert.ok(["prefix-match", "backend"].includes(r.window.source), `unexpected source: ${r.window.source}`);
			assert.equal(r.window.sessionName, "smoke", "session filled in by prefix-match path");
		});

		await step("pasteText delivers multi-line text to live pane (bracketed paste, no premature submit)", async () => {
			const marker = `paste-${Date.now()}`;
			// Use comment lines so even if prematurely submitted, the shell
			// wouldn't error — but with paste-buffer -p, the text lands as ONE
			// bracketed-paste event in the prompt without any submission.
			const prompt = `# ${marker} line A\n# ${marker} line B\n# ${marker} line C`;
			const r = await pasteText(executor, SOCK, listedTarget, prompt, { pressEnter: false });
			assert.equal(r.ok, true, `paste failed: ${r.error ?? "?"}`);
			await new Promise((r) => setTimeout(r, 500));
			const cap = await captureWindow(executor, SOCK, listedTarget, { lines: 100 });
			assert.equal(cap.ok, true, `capture failed: ${cap.error ?? "?"}`);
			const output = cap.output ?? "";
			assert.ok(output.includes(`${marker} line A`), `line A missing in pane`);
			assert.ok(output.includes(`${marker} line B`), `line B missing in pane`);
			assert.ok(output.includes(`${marker} line C`), `line C missing in pane`);
		});

		await step("pasteText with pressEnter:true executes multi-line script (single paste + Enter)", async () => {
			const marker = `paste-exec-${Date.now()}`;
			// printf with literal newlines — shell interprets each line as a
			// separate command. Premature submission (send-keys -l with \n)
			// would break this; bracketed paste keeps it intact.
			const prompt = `printf '${marker}-A\\n${marker}-B\\n${marker}-C\\n'`;
			const r = await pasteText(executor, SOCK, listedTarget, prompt, { pressEnter: true });
			assert.equal(r.ok, true, `paste failed: ${r.error ?? "?"}`);
			await new Promise((r) => setTimeout(r, 1000));
			const cap = await captureWindow(executor, SOCK, listedTarget, { lines: 100 });
			assert.equal(cap.ok, true);
			const output = cap.output ?? "";
			assert.ok(output.includes(`${marker}-A`), `expected ${marker}-A in pane output`);
			assert.ok(output.includes(`${marker}-B`), `expected ${marker}-B in pane output`);
			assert.ok(output.includes(`${marker}-C`), `expected ${marker}-C in pane output`);
		});

		await step("waitForWindow regex detection against live pane (REQ-5 smoke)", async () => {
			const marker = `wait-marker-${Date.now()}`;
			// Send a command that prints the marker. The shell prompt will
			// echo the marker line, which our regex should detect on the next
			// poll. Use a short interval to keep the test fast (~200ms total).
			const r = await sendText(executor, SOCK, listedTarget, `echo ${marker}`);
			assert.equal(r.ok, true, `sendText failed: ${r.error ?? "?"}`);
			const wait = await waitForWindow(executor, SOCK, listedTarget,
				{ regex: marker, timeoutMs: 5000, intervalMs: 200, lines: 100 });
			assert.equal(wait.ok, true, `waitForWindow failed: ${JSON.stringify(wait)}`);
			assert.equal(wait.matched, "regex", `expected regex match, got: ${wait.matched}`);
			assert.match(wait.output, new RegExp(marker));
			assert.ok(wait.polls >= 1 && wait.polls <= 10, `polls ${wait.polls} out of expected range`);
		});

		await step("waitForWindow timeout against live pane (REQ-6 smoke)", async () => {
			// Use a marker that will NEVER appear, so we hit timeoutMs cleanly.
			const wait = await waitForWindow(executor, SOCK, listedTarget,
				{ regex: `NEVER-APPEARS-${Date.now()}`, timeoutMs: 1500, intervalMs: 300, lines: 50 });
			assert.equal(wait.ok, false);
			assert.equal(wait.reason, "timeout");
			// polls should be bounded: ceil(1500/300)+1 = 6
			assert.ok(wait.polls <= 6, `polls ${wait.polls} exceeds bound 6`);
		});

		await step("resolveRunId returns error for unknown runId", async () => {
			const r = await resolveRunId("bg-doesnotexist0000", executor, SOCK, { prefix });
			assert.equal(r.ok, false);
			assert.match(r.error, /no window found/);
		});

		console.log("\n✅ All tmux-control real-tmux smoke tests passed");
		await cleanup();
		process.exit(0);
	} catch (err) {
		await cleanup();
		console.error("\n❌ tmux-control smoke failed:", err.message);
		process.exit(1);
	}
}

main().catch(async (err) => {
	await cleanup();
	console.error("Unexpected error:", err);
	process.exit(1);
});
