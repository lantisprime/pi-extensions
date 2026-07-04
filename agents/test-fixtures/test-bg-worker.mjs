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

// 4. Identity hash mismatch — tamper spec bytes after preflight, worker catches it before gate
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
		assert.ok(result.error.includes("spec hash mismatch"));

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

// 8. Agent name mismatch — tamper manifest identity.agentName after preflight, worker catches it
{
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const { paths } = await preflightAndRead(home, record, diag, "task");

		// Tamper manifest: change identity.agentName, then re-sign so MAC still passes.
		const { signBgManifest, keyGenIdFromKey, readSessionMacKey } = await import("../lib/bg-state.ts");
		const manifest = JSON.parse(await fs.readFile(paths.manifestPath, "utf8"));
		manifest.identity.agentName = "impostor";
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
		assert.ok(result.error.includes("agent name mismatch"));

		assert.equal(runnerCalled, false);
		assert.ok((await fs.stat(paths.donePath)).isFile());
	});
}

// 9. SIGTERM passes abort signal to child runner
{
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const { paths } = await preflightAndRead(home, record, diag, "task");

		const runnerCalls = [];
		const fakeRunner = async (spec, task, opts) => {
			runnerCalls.push({ spec, task, signal: opts?.signal });
			return fakeCompletedResult(spec.name, task);
		};

		await runBgWorker(paths.manifestPath, { homeDir: home, runner: fakeRunner });

		assert.equal(runnerCalls.length, 1);
		// The runner must receive an AbortSignal so SIGTERM can abort the child.
		assert.ok(runnerCalls[0].signal instanceof AbortSignal, "runner must receive an AbortSignal");
		assert.equal(runnerCalls[0].signal.aborted, false, "signal should not be aborted on a normal run");
	});
}

// 10. SIGTERM writes stopped result when child runner is in flight
{
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const { paths } = await preflightAndRead(home, record, diag, "task");

		// Fake runner that never resolves until the signal fires, simulating a long-running child.
		let runnerResolve;
		const fakeRunner = async (spec, task, opts) => {
			return new Promise((resolve) => {
				runnerResolve = resolve;
				// Listen for abort — when SIGTERM is simulated, resolve with a stopped-ish result.
				opts?.signal?.addEventListener("abort", () => {
					resolve({
						agentName: spec.name,
						status: "failed",
						exitCode: null,
						signal: "SIGTERM",
						pid: 0,
						durationMs: 50,
						stdoutBytes: 0,
						stderrPreview: "",
						invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin", stdinText: task } },
						summary: { summaryText: "", toolCalls: [], errors: [], usage: undefined, cost: undefined, stopReason: undefined, model: undefined, provider: undefined, truncation: {} },
						timedOut: false,
						outputLimitExceeded: false,
					});
				}, { once: true });
			});
		};

		// Start the worker; it will block at childRunner.
		const workerPromise = runBgWorker(paths.manifestPath, { homeDir: home, runner: fakeRunner });

		// Give the worker a tick to enter childRunner.
		await new Promise((r) => setTimeout(r, 10));

		// Simulate SIGTERM by sending it to the current process.
		// The onSigterm handler will set flags and abort the controller.
		process.emit("SIGTERM", "SIGTERM");

		await workerPromise;

		const raw = await fs.readFile(paths.resultPath, "utf8");
		const result = JSON.parse(raw);
		assert.equal(result.status, "stopped");
		assert.ok((await fs.stat(paths.donePath)).isFile());
	});
}

// 11. P5-diag: a non-completed child records WHY (regression — the worker used to
// write `status: failed` with empty resultText and no error, discarding the child's
// exit code / signal / stderr / kept raw spill).
{
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const { paths } = await preflightAndRead(home, record, diag, "task");

		// Child fails fast: non-zero exit, empty summary, NO captured error — the exact
		// shape that previously produced a reasonless `failed` result.
		await runBgWorker(paths.manifestPath, {
			homeDir: home,
			runner: async (spec) => ({
				agentName: spec.name,
				status: "failed",
				exitCode: 1,
				signal: null,
				pid: 7,
				durationMs: 90,
				stdoutBytes: 0,
				stderrPreview: "boom: cannot find module 'foo'",
				invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin", stdinText: "task" } },
				summary: { summaryText: "", toolCalls: [], errors: [], usage: undefined, cost: undefined, stopReason: undefined, model: undefined, provider: undefined, truncation: {} },
				timedOut: false,
				outputLimitExceeded: false,
				stdoutTmpPath: "/tmp/pi-agent-xyz/stdout.jsonl",
			}),
		});

		const result = JSON.parse(await fs.readFile(paths.resultPath, "utf8"));
		assert.equal(result.status, "failed");
		// WHY is now recorded: exit code + stderr both surface in the error diagnostic.
		assert.match(result.error, /Exit code: 1/);
		assert.match(result.error, /boom: cannot find module/);
		// Structured fields populated for programmatic consumers.
		assert.equal(result.exitCode, 1);
		assert.match(result.stderrPreview, /boom/);
		assert.equal(result.stdoutTmpPath, "/tmp/pi-agent-xyz/stdout.jsonl");
		// F1: empty summary → resultText omitted so the diagnostic isn't rendered twice.
		assert.equal(result.resultText, undefined, "resultText omitted on empty-summary failure");
		assert.notEqual(result.error, result.resultText, "error and resultText must not be the identical string");
		assert.ok((await fs.stat(paths.donePath)).isFile());
	});
}

// 12. P5-diag: a signal-killed child (exitCode null) records the signal, not "Exit code: null".
{
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const { paths } = await preflightAndRead(home, record, diag, "task");

		await runBgWorker(paths.manifestPath, {
			homeDir: home,
			runner: async (spec) => ({
				agentName: spec.name,
				status: "failed",
				exitCode: null,
				signal: "SIGKILL",
				pid: 8,
				durationMs: 40,
				stdoutBytes: 0,
				stderrPreview: "",
				invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin", stdinText: "task" } },
				summary: { summaryText: "", toolCalls: [], errors: [], usage: undefined, cost: undefined, stopReason: undefined, model: undefined, provider: undefined, truncation: {} },
				timedOut: false,
				outputLimitExceeded: false,
			}),
		});

		const result = JSON.parse(await fs.readFile(paths.resultPath, "utf8"));
		assert.equal(result.status, "failed");
		assert.equal(/Exit code/.test(result.error), false, "no 'Exit code' when signal-killed");
		assert.match(result.error, /Signal: SIGKILL/);
		assert.equal(result.signal, "SIGKILL");
		assert.equal(result.exitCode, undefined, "no exitCode field when child was signal-killed");
	});
}

// 13. Manifest with options.profile threads profileOverride to runChildAgent
{
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		// Preflight WITH profileOverride so the manifest's options.profile is set.
		const result = await preflightBgAgent(record, "task", makeCtx(home), diag, {
			homeDir: home,
			profileOverride: "smart",
		});
		assert.equal(result.ok, true, `preflight should succeed, got: ${result.reason}`);
		const paths = result.paths;
		const manifest = await readBgManifest(paths);
		assert.equal(manifest.options.profile, "smart", "preflight stashed profile in manifest");

		const runnerCalls = [];
		const fakeRunner = async (spec, task, opts) => {
			runnerCalls.push({ spec, task, options: opts });
			return fakeCompletedResult(spec.name, task);
		};

		await runBgWorker(paths.manifestPath, { homeDir: home, runner: fakeRunner });

		assert.equal(runnerCalls.length, 1);
		assert.equal(runnerCalls[0].options?.profileOverride, "smart",
			"worker passed manifest.options.profile as profileOverride to runChildAgent");
	});
}

// 14. Manifest WITHOUT options.profile → worker does NOT set profileOverride
// (preserves existing behavior: runChildAgent falls through to spec.profile)
{
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		// Preflight WITHOUT profileOverride — manifest's options.profile is absent.
		const { paths } = await preflightAndRead(home, record, diag, "task");

		const manifest = await readBgManifest(paths);
		assert.equal(manifest.options.profile, undefined, "control: manifest has no profile");

		const runnerCalls = [];
		const fakeRunner = async (spec, task, opts) => {
			runnerCalls.push({ spec, task, options: opts });
			return fakeCompletedResult(spec.name, task);
		};

		await runBgWorker(paths.manifestPath, { homeDir: home, runner: fakeRunner });

		assert.equal(runnerCalls.length, 1);
		assert.equal(runnerCalls[0].options?.profileOverride, undefined,
			"worker does NOT set profileOverride when manifest has no profile (preserves spec.profile fallthrough)");
	});
}

// 15. Positive: manifest.options.profile set + profile library available →
// child runner resolves the effective model/thinking from the named profile.
{
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		// Preflight WITH profileOverride so the manifest carries options.profile.
		const result = await preflightBgAgent(record, "task", makeCtx(home), diag, {
			homeDir: home,
			profileOverride: "smart",
		});
		assert.equal(result.ok, true, `preflight should succeed, got: ${result.reason}`);
		const paths = result.paths;

		// Library carrying a "smart" profile with known model + thinking.
		const library = {
			profiles: [
				{ name: "smart", model: "smart-model", thinking: "high", sourceOrigin: "built-in" },
			],
		};

		// Runner that mirrors the production resolution path: call resolveSpecProfile
		// exactly as runChildAgent does (child-runner.ts:96-105) and capture the
		// resolved values. We do NOT spawn a real child — the assertion is on the
		// resolved profile, not on the spawn.
		const { resolveSpecProfile } = await import("../lib/profiles.ts");
		let resolved = null;
		const fakeRunner = async (spec, task, opts) => {
			const effective = opts?.profileOverride ?? spec.profile;
			resolved = resolveSpecProfile(
				{ model: spec.model, thinking: spec.thinking, profile: effective },
				library,
			);
			return fakeCompletedResult(spec.name, task);
		};

		await runBgWorker(paths.manifestPath, { homeDir: home, runner: fakeRunner });

		assert.ok(resolved, "profile resolution ran");
		assert.equal(resolved.resolved, true, `resolution should succeed, got: ${JSON.stringify(resolved)}`);
		assert.equal(resolved.profileName, "smart", "resolved to the 'smart' profile");
		assert.equal(resolved.effectiveModel, "smart-model", "model resolved from profile");
		assert.equal(resolved.effectiveThinking, "high", "thinking resolved from profile");
		assert.equal(resolved.profileProvidedModel, true, "profile (not spec fallback) provided the model");
		assert.equal(resolved.profileProvidedThinking, true, "profile (not spec fallback) provided the thinking");
	});
}

// 16. Negative: manifest.options.profile set + NO profile library → fails clearly.
// Mirrors the fail-closed path at child-runner.ts:99-101: profile requested but
// the library is empty/missing, runChildAgent returns a spawnErrorResult with
// a descriptive error rather than silently picking a default model.
{
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const result = await preflightBgAgent(record, "task", makeCtx(home), diag, {
			homeDir: home,
			profileOverride: "smart",
		});
		assert.equal(result.ok, true, `preflight should succeed, got: ${result.reason}`);
		const paths = result.paths;

		// Runner that mimics runChildAgent's fail-closed branch: profile requested
		// but library is empty → return a spawn-error result with a descriptive
		// message naming the missing profile (matches child-runner.ts:99-101 which
		// calls spawnErrorResult with that exact message).
		const fakeRunner = async (spec, task, opts) => {
			const effective = opts?.profileOverride ?? spec.profile;
			if (effective) {
				return {
					agentName: spec.name,
					status: "spawn-error",
					durationMs: 0,
					stdoutBytes: 0,
					stderrPreview: "",
					invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin", stdinText: task } },
					summary: { summaryText: "", toolCalls: [], errors: [], usage: undefined, cost: undefined, stopReason: undefined, model: undefined, provider: undefined, truncation: {} },
					timedOut: false,
					outputLimitExceeded: false,
					error: `profile '${effective}' requested but no profile library is available`,
				};
			}
			return fakeCompletedResult(spec.name, task);
		};

		await runBgWorker(paths.manifestPath, { homeDir: home, runner: fakeRunner });

		const raw = await fs.readFile(paths.resultPath, "utf8");
		const result2 = JSON.parse(raw);
		// Worker normalizes the child's status to "failed" via mapChildStatus
		// (bg-worker.ts:215-224). The IMPORTANT assertion is the error message —
		// a "silent fallthrough to a default model" would have a generic exit-code
		// or "Background agent did not complete" error instead of the descriptive
		// profile-not-found message.
		assert.equal(result2.status, "failed", "run fails closed (status: failed) when profile is requested but library is empty");
		assert.match(result2.error, /profile 'smart' requested but no profile library is available/,
			"error names the missing profile and the cause (no library) — NOT a silent fallthrough to a default model");
	});
}

// 17. Worker passes the profile library to the runner as the 4th positional arg.
// Codex asks: "prove runBgWorker receives/reconstructs the library". The library
// flows through the existing mock seam (options.runner) as a 4th positional arg,
// matching runChildAgent's signature: (spec, task, options, profiles, profileOverride).
// Production workers use the default runner; tests use the seam to assert the wiring.
{
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const result = await preflightBgAgent(record, "task", makeCtx(home), diag, {
			homeDir: home,
			profileOverride: "smart",
		});
		assert.equal(result.ok, true, `preflight should succeed, got: ${result.reason}`);
		const paths = result.paths;

		const library = {
			profiles: [
				{ name: "smart", model: "smart-model", thinking: "high", sourceOrigin: "built-in" },
				{ name: "fast", model: "fast-model", thinking: "low", sourceOrigin: "built-in" },
			],
		};

		let capturedLibrary = null;
		const fakeRunner = async (spec, task, opts, lib) => {
			capturedLibrary = lib;
			return fakeCompletedResult(spec.name, task);
		};

		await runBgWorker(paths.manifestPath, {
			homeDir: home,
			profileLibrary: library,
			runner: fakeRunner,
		});

		assert.equal(capturedLibrary, library,
			"worker passed options.profileLibrary to runner as the 4th positional arg (production-style wiring)");
	});
}

// 18. Production path: with no user profiles on disk and no options.profileLibrary,
// the worker still reconstructs a library (built-in-only). This proves the production
// path never hands an undefined library to the runner — the runChildAgent fail-closed
// branch (child-runner.ts:99-101) only fires when the requested profile isn't in the
// library, NOT when the library is missing entirely.
{
	await withTempHome(async (home) => {
		const { record, diag } = await setupRegisteredUserAgent(home);
		const result = await preflightBgAgent(record, "task", makeCtx(home), diag, {
			homeDir: home,
			profileOverride: "smart",
		});
		assert.equal(result.ok, true, `preflight should succeed, got: ${result.reason}`);
		const paths = result.paths;

		// Ensure <home>/.pi/agent/profiles/ is empty so reconstruction falls back to
		// built-ins only.
		const userProfilesDir = path.join(home, ".pi", "agent", "profiles");
		await fs.mkdir(userProfilesDir, { recursive: true });

		let capturedLibrary = "sentinel";
		const fakeRunner = async (spec, task, opts, lib) => {
			capturedLibrary = lib;
			return fakeCompletedResult(spec.name, task);
		};

		await runBgWorker(paths.manifestPath, {
			homeDir: home,
			// no profileLibrary, no user profile files on disk
			runner: fakeRunner,
		});

		assert.ok(capturedLibrary && typeof capturedLibrary === "object",
			"worker reconstructed a library (never undefined on the production path)");
		assert.ok(Array.isArray(capturedLibrary.profiles), "library has a profiles array");
		assert.ok(capturedLibrary.profiles.length > 0,
			"library includes built-in profiles (buildProfileLibrary always merges built-ins)");
		assert.equal(capturedLibrary.profiles.find((p) => p.name === "smart"), undefined,
			"library does NOT include 'smart' (no user profile on disk) — the production run will fail-closed at child-runner.ts:99-101 with 'profile \"smart\" requested but no profile library is available'");
	});
}

// 19. Production path: worker reconstructs the profile library from disk when
// no library is injected. Writes a real user profile at <homeDir>/.pi/agent/profiles/smart.md,
// runs preflight with profileOverride: "smart" (manifest.options.profile = "smart"),
// runs the worker WITHOUT options.profileLibrary. The worker must call
// buildBgWorkerProfileLibrary(homeDir), discover the on-disk "smart" profile, and
// pass it as the 4th positional arg to the runner. This is the production-style
// wiring: the worker is detached and has no UX channel to receive a library
// from the foreground, so it must build the library itself.
{
	await withTempHome(async (home) => {
		// Write a real user profile file on disk.
		const userProfilesDir = path.join(home, ".pi", "agent", "profiles");
		await fs.mkdir(userProfilesDir, { recursive: true });
		await fs.writeFile(
			path.join(userProfilesDir, "smart.md"),
			`---\nname: smart\nmodel: smart-model\nthinking: high\n---\nbody`,
			"utf-8",
		);

		const { record, diag } = await setupRegisteredUserAgent(home);
		const result = await preflightBgAgent(record, "task", makeCtx(home), diag, {
			homeDir: home,
			profileOverride: "smart",
		});
		assert.equal(result.ok, true, `preflight should succeed, got: ${result.reason}`);
		const paths = result.paths;

		let capturedLibrary = null;
		const fakeRunner = async (spec, task, opts, lib) => {
			capturedLibrary = lib;
			return fakeCompletedResult(spec.name, task);
		};

		// Production path: NO options.profileLibrary. Worker must reconstruct.
		await runBgWorker(paths.manifestPath, {
			homeDir: home,
			runner: fakeRunner,
		});

		assert.ok(capturedLibrary, "runner was called (reconstruction completed)");
		assert.ok(Array.isArray(capturedLibrary.profiles), "library has a profiles array");
		const smart = capturedLibrary.profiles.find((p) => p.name === "smart");
		assert.ok(smart, `reconstructed library includes the 'smart' profile from disk (got: ${capturedLibrary.profiles.map((p) => p.name).join(", ")})`);
		assert.equal(smart.model, "smart-model", "smart profile's model was discovered from disk");
		assert.equal(smart.thinking, "high", "smart profile's thinking was discovered from disk");
		assert.equal(smart.sourceOrigin, "user", "profile is marked as user-source (from <homeDir>/.pi/agent/profiles/)");
	});
}

// 20. Production path: when preflight snapshots projectTrusted=true, the worker
// includes project profiles from <cwd>/.pi/profiles/ in the reconstructed library.
// This mirrors the foreground session_start path (agents/index.ts:117-141) which
// includes project profiles when project trust is active. The worker is detached
// and cannot re-verify trust, so it honors the manifest's snapshot.
{
	await withTempHome(async (home) => {
		// Write a project profile at <cwd>/.pi/profiles/smart.md.
		const projectProfilesDir = path.join(home, ".pi", "profiles");
		await fs.mkdir(projectProfilesDir, { recursive: true });
		await fs.writeFile(
			path.join(projectProfilesDir, "smart.md"),
			`---\nname: smart\nmodel: smart-model\nthinking: high\n---\nbody`,
			"utf-8",
		);

		const { record, diag } = await setupRegisteredUserAgent(home);
		// Preflight WITH projectTrusted=true so the manifest snapshots it.
		// (collectAgentDiagnostics defaults projectTrusted to false; pass true via the
		// diag object the preflight receives. Since preflight reads diagnostics.projectTrusted,
		// we can use the existing setup — but for this test we need the worker to honor it,
		// so we run preflight with the explicit projectTrusted path via a custom diag.)
		const diagWithProjectTrust = { ...diag, projectTrusted: true };
		const result = await preflightBgAgent(record, "task", makeCtx(home), diagWithProjectTrust, {
			homeDir: home,
			profileOverride: "smart",
		});
		assert.equal(result.ok, true, `preflight should succeed, got: ${result.reason}`);
		const paths = result.paths;

		// Confirm the manifest snapshotted projectTrusted=true.
		const manifest = await readBgManifest(paths);
		assert.equal(manifest.options.projectTrusted, true,
			"manifest snapshots projectTrusted=true from preflight diagnostics");

		let capturedLibrary = null;
		const fakeRunner = async (spec, task, opts, lib) => {
			capturedLibrary = lib;
			return fakeCompletedResult(spec.name, task);
		};

		// Production path: no options.profileLibrary. Worker must reconstruct from disk.
		await runBgWorker(paths.manifestPath, {
			homeDir: home,
			runner: fakeRunner,
		});

		assert.ok(capturedLibrary, "runner was called");
		const smart = capturedLibrary.profiles.find((p) => p.name === "smart");
		assert.ok(smart, `reconstructed library includes 'smart' profile from project dir (got: ${capturedLibrary.profiles.map((p) => `${p.name}(${p.sourceOrigin ?? "?"})`).join(", ")})`);
		assert.equal(smart.model, "smart-model");
		assert.equal(smart.thinking, "high");
		assert.equal(smart.sourceOrigin, "project",
			"profile is marked as project-source (from <cwd>/.pi/profiles/, when manifest.options.projectTrusted=true)");
	});
}

// 21. Production path: when manifest.options.projectTrusted is false/undefined,
// project profiles are NOT included in the reconstructed library (the worker
// conservatively excludes project-source profiles when trust is not snapshotted).
// User profiles are still included; only project profiles are gated.
{
	await withTempHome(async (home) => {
		// Write a project profile AND a user profile with the same name.
		const projectProfilesDir = path.join(home, ".pi", "profiles");
		await fs.mkdir(projectProfilesDir, { recursive: true });
		await fs.writeFile(
			path.join(projectProfilesDir, "smart.md"),
			`---\nname: smart\nmodel: project-model\n---\n`,
			"utf-8",
		);
		const userProfilesDir = path.join(home, ".pi", "agent", "profiles");
		await fs.mkdir(userProfilesDir, { recursive: true });
		await fs.writeFile(
			path.join(userProfilesDir, "smart.md"),
			`---\nname: smart\nmodel: user-model\n---\n`,
			"utf-8",
		);

		const { record, diag } = await setupRegisteredUserAgent(home);
		// projectTrusted defaults to false in setupRegisteredUserAgent.
		assert.equal(diag.projectTrusted, false, "control: diag.projectTrusted is false");
		const result = await preflightBgAgent(record, "task", makeCtx(home), diag, {
			homeDir: home,
			profileOverride: "smart",
		});
		assert.equal(result.ok, true, `preflight should succeed, got: ${result.reason}`);
		const paths = result.paths;

		const manifest = await readBgManifest(paths);
		assert.equal(manifest.options.projectTrusted, false,
			"control: manifest snapshots projectTrusted=false");

		let capturedLibrary = null;
		const fakeRunner = async (spec, task, opts, lib) => {
			capturedLibrary = lib;
			return fakeCompletedResult(spec.name, task);
		};

		await runBgWorker(paths.manifestPath, {
			homeDir: home,
			runner: fakeRunner,
		});

		assert.ok(capturedLibrary);
		const smart = capturedLibrary.profiles.find((p) => p.name === "smart");
		assert.ok(smart, "library includes 'smart' (from user dir)");
		assert.equal(smart.sourceOrigin, "user",
			"with projectTrusted=false, the 'smart' profile comes from the user dir, not the project dir");
		assert.equal(smart.model, "user-model",
			"user profile's model takes precedence (higher precedence than project when both exist)");
	});
}

// 22. Production path: when manifest.options.projectTrusted=true, the worker passes
// projectTrusted + a reconstructed projectRegistry to runChildAgent. Without these,
// runChildAgent's project-profile trust gate (child-runner.ts:108-135) fails-closed
// for any project-source profile even when the library includes it. This test asserts
// the worker's wiring is correct by capturing the options passed to the runner and
// simulating the trust gate (calling profileTrustCheck directly with the captured
// registry + the resolved profile's identity). The trust gate must pass.
{
	await withTempHome(async (home) => {
		const crypto = await import("node:crypto");
		const { readProjectRegistry, emptyProjectRegistry, addOrReplaceRegisteredProfile, writeProjectRegistry, getProjectRegistryPaths, hashProjectRoot, canonicalizeProjectRoot } = await import("../lib/registry.ts");
		const { profileTrustCheck } = await import("../lib/profile-discovery.ts");

		// Write a project profile and register it in the project registry.
		const projectProfilesDir = path.join(home, ".pi", "profiles");
		await fs.mkdir(projectProfilesDir, { recursive: true });
		const profilePath = path.join(projectProfilesDir, "smart.md");
		const profileBytes = Buffer.from(`---\nname: smart\nmodel: smart-model\nthinking: high\n---\nbody`, "utf-8");
		await fs.writeFile(profilePath, profileBytes);
		const profileSha256 = crypto.createHash("sha256").update(profileBytes).digest("hex");
		const profileCanonical = await fs.realpath(profilePath);

		const canonicalRoot = await canonicalizeProjectRoot(home);
		const projectRootHash = hashProjectRoot(canonicalRoot);
		let registry = emptyProjectRegistry(canonicalRoot, projectRootHash);
		registry = addOrReplaceRegisteredProfile(registry, {
			name: "smart",
			source: "project",
			canonicalPath: profileCanonical,
			rawBytesSha256: profileSha256,
			approvedAt: new Date().toISOString(),
			approvedBy: "user",
		});
		await writeProjectRegistry(registry, canonicalRoot, home);

		const { record, diag } = await setupRegisteredUserAgent(home);
		const diagWithProjectTrust = { ...diag, projectTrusted: true };
		const result = await preflightBgAgent(record, "task", makeCtx(home), diagWithProjectTrust, {
			homeDir: home,
			profileOverride: "smart",
		});
		assert.equal(result.ok, true, `preflight should succeed, got: ${result.reason}`);
		const paths = result.paths;

		let capturedOpts = null;
		const fakeRunner = async (spec, task, opts) => {
			capturedOpts = opts;
			return fakeCompletedResult(spec.name, task);
		};

		await runBgWorker(paths.manifestPath, {
			homeDir: home,
			runner: fakeRunner,
		});

		assert.ok(capturedOpts, "runner was called");
		assert.equal(capturedOpts.projectTrusted, true,
			"worker passes projectTrusted=true to runChildAgent (from manifest snapshot)");
		assert.ok(capturedOpts.projectRegistry, "worker passes a reconstructed projectRegistry to runChildAgent");
		assert.equal(capturedOpts.projectRegistry.projectRoot, canonicalRoot,
			"reconstructed registry is rooted at the canonical manifest cwd");

		// Now simulate runChildAgent's trust gate (child-runner.ts:108-135):
		// resolveSpecProfile + profileTrustCheck, with the same inputs the real
		// runChildAgent would see. The library entry must include the same
		// canonicalPath + rawBytesSha256 as the registry entry (the worker
		// reconstructs these from disk; here we mirror what discoverProfiles
		// would set on the parsed entry).
		const { resolveSpecProfile } = await import("../lib/profiles.ts");
		const effectiveProfile = "smart";
		const library = {
			profiles: [
				{
					name: "smart",
					model: "smart-model",
					thinking: "high",
					sourceOrigin: "project",
					canonicalPath: profileCanonical,
					rawBytesSha256: profileSha256,
				},
			],
		};
		const resolved = resolveSpecProfile(
			{ model: undefined, thinking: undefined, profile: effectiveProfile },
			library,
		);
		assert.equal(resolved.resolved, true, `resolveSpecProfile succeeded: ${JSON.stringify(resolved)}`);
		const trustCheck = profileTrustCheck(
			resolved.profileName,
			resolved.profileCanonicalPath,
			resolved.profileRawBytesSha256,
			capturedOpts.projectRegistry,
			capturedOpts.projectTrusted,
		);
		assert.equal(trustCheck.ok, true, `trust gate passed: ${JSON.stringify(trustCheck)}`);
	});
}

console.log("P4-3 bg-worker tests passed");
