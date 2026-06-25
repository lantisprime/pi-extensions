import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { collectAgentDiagnostics } from "../lib/diagnostics.ts";
import { registerAgent } from "../lib/registration.ts";
import { resolveRegisteredRunTarget } from "../lib/run-resolver.ts";
import { preflightBgAgent } from "../lib/bg-preflight.ts";
import { runBgWorker } from "../lib/bg-worker.ts";
import {
	readBgManifest,
	countActiveBgRuns,
	listBgRuns,
} from "../lib/bg-state.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTempHome(fn) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "p4-3-worker-"));
	const home = path.join(root, "home");
	try {
		await fn(home, root);
	} finally {
		await fs.rm(root, { recursive: true, force: true }).catch(() => {});
	}
}

function makeCtx(home) {
	return {
		cwd: home,
		hasUI: false,
		agentsHomeDir: home,
		ui: { notify: () => {}, confirm: async () => true },
	};
}

async function setupRegisteredUserAgent(home, name = "researcher") {
	const userAgentsDir = path.join(home, ".pi", "agent", "agents");
	await fs.mkdir(userAgentsDir, { recursive: true });
	const specPath = path.join(userAgentsDir, `${name}.md`);
	await fs.writeFile(specPath, `---\nname: ${name}\ndescription: d\nsource: user\ntools: [read]\nprompt: p\n---\nbody`);
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

/** Preflight an agent and return the full manifest + paths. */
async function preflightAndRead(home, record, diag, task) {
	const result = await preflightBgAgent(record, task, makeCtx(home), diag, { homeDir: home });
	assert.equal(result.ok, true, `preflight should succeed, got: ${result.reason}`);
	const paths = result.paths;
	const manifest = await readBgManifest(paths);
	return { manifest, paths };
}

/** Fake child runner that returns a completed result. */
function fakeCompletedResult(name, task) {
	return {
		agentName: name,
		status: "completed",
		exitCode: 0,
		signal: null,
		pid: 12345,
		durationMs: 100,
		stdoutBytes: 200,
		stderrPreview: "",
		invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin", stdinText: task } },
		summary: { summaryText: "all done", toolCalls: [], errors: [], usage: undefined, cost: undefined, stopReason: undefined, model: undefined, provider: undefined, truncation: {} },
		timedOut: false,
		outputLimitExceeded: false,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// 1. Worker reads valid manifest, gates, spawns, writes completed result
{
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const { paths } = await preflightAndRead(home, record, diag, "hello world");

		const runnerCalls = [];
		const fakeRunner = async (spec, task) => {
			runnerCalls.push({ spec, task });
			return fakeCompletedResult(spec.name, task);
		};

		await runBgWorker(paths.manifestPath, { homeDir: home, runner: fakeRunner });

		// Result was written
		const raw = await fs.readFile(paths.resultPath, "utf8");
		const result = JSON.parse(raw);
		assert.equal(result.version, 1);
		assert.equal(result.runId, paths.runId);
		assert.equal(result.status, "completed");
		assert.equal(result.agentName, "researcher");
		assert.ok(result.resultText);

		// Done sentinel exists
		const doneStat = await fs.stat(paths.donePath);
		assert.ok(doneStat.isFile());

		// Runner was called exactly once with correct args
		assert.equal(runnerCalls.length, 1);
		assert.equal(runnerCalls[0].spec.name, "researcher");
		assert.equal(runnerCalls[0].task, "hello world");

		// Run is listed as done
		const runs = await listBgRuns(home);
		const run = runs.find((r) => r.runId === paths.runId);
		assert.ok(run);
		assert.equal(run.done, true);
		assert.equal(run.status, "completed");
	});
}

// 2. Manifest tamper — MAC fails, worker writes failed
{
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const { paths } = await preflightAndRead(home, record, diag, "task");

		// Tamper: change task text without updating MAC
		const manifest = JSON.parse(await fs.readFile(paths.manifestPath, "utf8"));
		manifest.task = "tampered task";
		await fs.writeFile(paths.manifestPath, JSON.stringify(manifest, null, 2));

		let runnerCalled = false;
		await runBgWorker(paths.manifestPath, {
			homeDir: home,
			runner: async () => { runnerCalled = true; return fakeCompletedResult("x", "x"); },
		});

		// Result is failed
		const raw = await fs.readFile(paths.resultPath, "utf8");
		const result = JSON.parse(raw);
		assert.equal(result.status, "failed");
		assert.ok(result.error.includes("MAC"));

		// Runner was never called
		assert.equal(runnerCalled, false);

		// Done sentinel exists
		assert.ok((await fs.stat(paths.donePath)).isFile());
	});
}

// 3. Agent spec file deleted after preflight — worker writes failed
{
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const { paths } = await preflightAndRead(home, record, diag, "task");

		// Delete the spec file
		await fs.rm(record.filePath);

		let runnerCalled = false;
		await runBgWorker(paths.manifestPath, {
			homeDir: home,
			runner: async () => { runnerCalled = true; return fakeCompletedResult("x", "x"); },
		});

		const raw = await fs.readFile(paths.resultPath, "utf8");
		const result = JSON.parse(raw);
		assert.equal(result.status, "failed");
		assert.ok(result.error.includes("re-read"));

		assert.equal(runnerCalled, false);
		assert.ok((await fs.stat(paths.donePath)).isFile());
	});
}

// 4. Gate denial — tamper spec bytes to break hash match
{
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const { paths } = await preflightAndRead(home, record, diag, "task");

		// Tamper the spec file so the hash changes
		const original = await fs.readFile(record.filePath, "utf8");
		await fs.writeFile(record.filePath, original.replace("body", "tampered body"));

		let runnerCalled = false;
		await runBgWorker(paths.manifestPath, {
			homeDir: home,
			runner: async () => { runnerCalled = true; return fakeCompletedResult("x", "x"); },
		});

		const raw = await fs.readFile(paths.resultPath, "utf8");
		const result = JSON.parse(raw);
		assert.equal(result.status, "failed");
		assert.ok(result.error.includes("gate denied"));

		assert.equal(runnerCalled, false);
		assert.ok((await fs.stat(paths.donePath)).isFile());
	});
}

// 5. homeDir mismatch — worker rejects (N1)
{
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const { paths } = await preflightAndRead(home, record, diag, "task");

		// Tamper: change homeDir in manifest to a different path, then re-sign
		// so MAC still passes but identity check fails.
		const { signBgManifest, keyGenIdFromKey, readSessionMacKey } = await import("../lib/bg-state.ts");
		const manifest = JSON.parse(await fs.readFile(paths.manifestPath, "utf8"));
		manifest.options.homeDir = "/nonexistent/home";
		const key = await readSessionMacKey(home);
		const unsigned = { ...manifest, mac: undefined };
		unsigned.keyGenId = keyGenIdFromKey(key);
		manifest.keyGenId = unsigned.keyGenId;
		manifest.mac = signBgManifest(unsigned, key);
		await fs.writeFile(paths.manifestPath, JSON.stringify(manifest, null, 2));

		let runnerCalled = false;
		await runBgWorker(paths.manifestPath, {
			homeDir: home,
			runner: async () => { runnerCalled = true; return fakeCompletedResult("x", "x"); },
		});

		const raw = await fs.readFile(paths.resultPath, "utf8");
		const result = JSON.parse(raw);
		assert.equal(result.status, "failed");
		assert.ok(result.error.includes("homeDir"));

		assert.equal(runnerCalled, false);
		assert.ok((await fs.stat(paths.donePath)).isFile());
	});
}

// 6. Reservation exists and is counted active during worker, then cleared on done
{
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const { paths } = await preflightAndRead(home, record, diag, "task");

		// Before worker: reservation counts as active
		const before = await countActiveBgRuns(home);
		assert.equal(before, 1);

		await runBgWorker(paths.manifestPath, { homeDir: home, runner: async (spec, task) => fakeCompletedResult(spec.name, task) });

		// After worker: run is done, not active
		const after = await countActiveBgRuns(home);
		assert.equal(after, 0);

		// Done sentinel exists, reservation removed
		assert.ok((await fs.stat(paths.donePath)).isFile());
		await fs.access(paths.reservationPath).then(
			() => assert.fail("reservation should be removed after done"),
			() => {} /* expected ENOENT */,
		);
	});
}

// 7. resultText is capped at 64KB
{
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const { paths } = await preflightAndRead(home, record, diag, "task");

		await runBgWorker(paths.manifestPath, {
			homeDir: home,
			runner: async () => ({
				agentName: "researcher",
				status: "completed",
				exitCode: 0, signal: null, pid: 1, durationMs: 1, stdoutBytes: 0, stderrPreview: "",
				invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin", stdinText: "x" } },
				summary: { summaryText: "A".repeat(70_000), toolCalls: [], errors: [], usage: undefined, cost: undefined, stopReason: undefined, model: undefined, provider: undefined, truncation: {} },
				timedOut: false, outputLimitExceeded: false,
			}),
		});

		const raw = await fs.readFile(paths.resultPath, "utf8");
		const result = JSON.parse(raw);
		assert.equal(result.status, "completed");
		assert.ok(result.resultText.length <= 64_000 + 15, "resultText should be capped at ~64KB");
		assert.ok(result.resultText.includes("[truncated]"));
	});
}

console.log("P4-3 bg-worker tests passed");
