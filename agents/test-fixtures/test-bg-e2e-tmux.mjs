// REAL end-to-end background-agent test: launches pi through an ACTUAL tmux
// session and asserts the run completes. This is the test that would have caught
// the two P5 launch bugs (manifest-dir mismatch + worker re-invoking itself as
// pi) that 63 unit tests and the review rounds missed — because it drives the
// real preflight -> real tmux backend -> real worker -> real pi -> result.json
// chain instead of a fake.
//
// Requires tmux + pi on PATH + working model auth. Skips (exit 0) when tmux/pi
// are unavailable, or when a FOREGROUND agent run can't complete in this
// environment (e.g. no model auth) — so it never fails for environment reasons,
// only for an actual regression of the bg launch path.

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const HOME = os.userInfo().homedir;

function skip(msg) {
	console.log(`SKIP bg-e2e-tmux: ${msg}`);
	process.exit(0);
}
async function resolveOnPath(cmd) {
	try {
		const { stdout } = await exec("which", [cmd]);
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

async function main() {
	const tmuxPath = await resolveOnPath("tmux");
	if (!tmuxPath) skip("tmux not on PATH");
	const piPath = await resolveOnPath("pi");
	if (!piPath) skip("pi not on PATH");

	const reg = await import("../lib/registration.ts");
	const diagMod = await import("../lib/diagnostics.ts");
	const resolver = await import("../lib/run-resolver.ts");
	const cr = await import("../lib/child-runner.ts");
	const preflightMod = await import("../lib/bg-preflight.ts");
	const bg = await import("../lib/bg-state.ts");
	const tmuxBackend = await import("../../tmux-terminal/lib/tmux-backend.ts");
	const execMod = await import("../../tmux-terminal/lib/exec.ts");
	const workerResolve = await import("../../tmux-terminal/lib/resolve-worker-path.ts");

	const name = "bg-e2e-probe";
	const MARKER = "BG_E2E_TMUX_OK";
	const agentsDir = path.join(HOME, ".pi", "agent", "agents");
	const specPath = path.join(agentsDir, `${name}.md`);
	const ui = { notify: () => {}, confirm: async () => true, setStatus: () => {}, setWidget: () => {} };
	const ctx = { cwd: REPO, homeDir: HOME, hasUI: true, agentsHomeDir: HOME, projectTrusted: false, ui };
	const sessionName = "bg-e2e-probe-session";
	const created = [];

	async function cleanup() {
		try { await exec("tmux", ["kill-session", "-t", sessionName]); } catch {}
		for (const dir of created) { try { await fs.rm(dir, { recursive: true, force: true }); } catch {} }
		try { await reg.unregisterAgent(name, ctx); } catch {}
		try { await fs.rm(specPath, { force: true }); } catch {}
	}

	try {
		// 1. Register a uniquely-named probe agent in the real user-agents dir.
		await fs.mkdir(agentsDir, { recursive: true });
		await fs.writeFile(specPath,
			`---\nname: ${name}\ndescription: background-agent e2e probe\ntools: [ls]\n---\n` +
			`Output exactly the single line ${MARKER} and then stop. Do not use any tools.\n`);
		const r = await reg.registerAgent(specPath, ctx);
		assert.equal(r.status, "registered", `probe registration must succeed (got ${r.status}: ${r.message})`);

		const diag = await diagMod.collectAgentDiagnostics({ cwd: REPO, homeDir: HOME, projectTrusted: false });
		const resolved = await resolver.resolveRegisteredRunTarget(name, diag);
		assert.equal(resolved.ok, true, "probe must resolve as runnable");

		// 2. Foreground pre-check: if the agent can't even run in-process here
		//    (e.g. no model auth), SKIP — this is an environment limit, not our bug.
		const fg = await cr.runChildAgent(resolved.record.spec, "go", { cwd: REPO });
		if (fg.status !== "completed") skip(`foreground agent run did not complete (${fg.status}); environment cannot run agents (model auth?)`);

		// 3. Real tmux session for the worker window to land in.
		await exec("tmux", ["new-session", "-d", "-s", sessionName]);

		// 4. Real signed preflight.
		const pf = await preflightMod.preflightBgAgent(resolved.record, `say ${MARKER}`, ctx, diag);
		assert.equal(pf.ok, true, "preflight must succeed");
		created.push(pf.paths.runDir);

		// 5. LAUNCH through the real tmux backend into the real session.
		const backend = tmuxBackend.createTmuxBackend({
			executor: execMod.defaultTmuxExecutor(),
			workerPath: workerResolve.resolveWorkerPath(),
			bgStateDir: bg.getBgStateDir(),
		});
		const launch = await backend.launch({ agentName: name, runId: pf.runId, manifestPath: pf.paths.manifestPath, cwd: REPO });
		assert.equal(launch.status, "ok", `launch must be accepted (Bug 1: manifest dir). got: ${JSON.stringify(launch)}`);
		assert.equal(launch.windowId, `pi-agent-${pf.runId}`, "windowId must be the full-runId window name");

		// 6. The worker (in the tmux window) spawns pi and writes result.json.
		let result = null;
		for (let i = 0; i < 24; i++) {
			await new Promise((res) => setTimeout(res, 1000));
			try { result = JSON.parse(await fs.readFile(pf.paths.resultPath, "utf8")); break; } catch {}
		}
		assert.ok(result, "worker must write result.json within 24s (Bug 2: worker must spawn pi, not re-invoke itself)");
		assert.equal(result.status, "completed", `bg run via tmux must complete (Bug 2). got status=${result.status}, resultText=${JSON.stringify((result.resultText || "").slice(0, 200))}`);
		assert.ok((result.resultText || "").includes(MARKER), `result must contain the agent's output marker ${MARKER}`);

		console.log("  ✓ launched pi through a real tmux session; bg run completed with marker");
		console.log("OK: bg-e2e-tmux passed");
	} finally {
		await cleanup();
	}
}

main().catch((error) => { console.error(error); process.exit(1); });
