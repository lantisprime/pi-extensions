// P4-3: Background-agent worker process. Reads the signed identity manifest,
// re-runs the full P3 security gate against live spec bytes + user registry,
// and spawns the agent. All authority roots from resolveTrustedHome()
// (os.userInfo().homedir), never $HOME / os.homedir() / a manifest field.
//
// The worker is launched by the terminal backend (P4-4) with the manifest path
// as its only argument. It re-derives everything from resolveTrustedHome() —
// the manifest homeDir is identity only, verified against the trusted runtime
// root (N1). cwd is advisory identity and is NOT compared (N6).

import path from "node:path";
import {
	appendBgEvent,
	assertManifestIdentityMatchesRuntime,
	getBgRunPaths,
	markBgRunDone,
	readBgManifest,
	readSessionMacKey,
	resolveTrustedHome,
	verifyBgManifest,
	writeBgResult,
	type BgRunManifest,
	type BgRunPaths,
	type BgRunStatus,
} from "./bg-state.ts";
import { canRunAgent } from "./can-run-agent.ts";
import { parseAgentMarkdownFile } from "./agent-markdown.ts";
import { readUserRegistry } from "./registry.ts";
import { runChildAgent, type ChildAgentRunResult, type RunChildAgentOptions } from "./child-runner.ts";
import type { AgentSpec } from "./specs.ts";

const TOOL_CONTEXT_LOADER_PATH_ENV = "PI_AGENTS_TOOL_CONTEXT_LOADER_PATH";

export type BgWorkerOptions = {
	/** Test-only seam: override the trusted home directory. Defaults to
	 *  resolveTrustedHome() (os.userInfo().homedir). In production the terminal
	 *  backend never passes this — the worker always derives the root from the OS.
	 *  Only use in unit tests with a temp home. */
	homeDir?: string;
	/** Test-only seam: override the child agent runner. Do not set in production.
	 *  The terminal backend never passes this — it's for unit tests only. */
	runner?: (spec: AgentSpec, task: string, options?: RunChildAgentOptions) => Promise<ChildAgentRunResult>;
};

/** P4-3: Entry point for the terminal-launched worker process.
 *  @param manifestPath - path to the signed manifest.json written by P4-2 preflight.
 *  The runId is derived from the parent directory name; paths are recomputed from
 *  resolveTrustedHome() so they match the preflight's write target.
 *  @param options - internal options including a test-only runner seam. */
export async function runBgWorker(manifestPath: string, options: BgWorkerOptions = {}): Promise<void> {
	const trustedHome = options.homeDir ?? resolveTrustedHome();
	const childRunner = options.runner ?? (runChildAgent as (spec: AgentSpec, task: string, options?: RunChildAgentOptions) => Promise<ChildAgentRunResult>);
	const runDir = path.dirname(manifestPath);
	const runId = path.basename(runDir);
	const paths = getBgRunPaths(runId, trustedHome);

	let status: BgRunStatus = "running";
	let sigtermReceived = false;
	let abortController: AbortController | undefined;

	// N3: SIGTERM writes stopped + done + aborts running child promptly;
	// the reaper never signals.
	const onSigterm = () => {
		sigtermReceived = true;
		status = "stopped";
		abortController?.abort();
	};
	process.on("SIGTERM", onSigterm);

	const startedAt = new Date().toISOString();

	try {
		const manifest = await readBgManifest(paths);
		await appendBgEvent(paths, { event: "worker-started", runId, startedAt });

		// HomeDir identity check (N1). cwd is advisory — NOT compared (N6).
		assertManifestIdentityMatchesRuntime(manifest, { homeDir: trustedHome });

		// MAC verification against the session key.
		const key = await readSessionMacKey(trustedHome);
		if (!verifyBgManifest(manifest, key)) {
			await failRun(paths, manifest, "manifest MAC verification failed", startedAt);
			return;
		}

		if (sigtermReceived) {
			await writeStopped(paths, manifest, startedAt);
			return;
		}

		// Re-read spec file bytes from the canonical path in the manifest, recompute hash.
		// First cut: user-agents-only — source is hard-coded to "user" (project agents deferred).
		let parsed;
		try {
			parsed = await parseAgentMarkdownFile(manifest.identity.canonicalPath, { source: "user" });
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			await failRun(paths, manifest, `failed to re-read spec: ${msg}`, startedAt);
			return;
		}

		// P4-3-fix: verify live spec identity matches the signed manifest identity.
		// This closes the TOCTOU window where both the spec file and user registry
		// could be updated after preflight — the signed manifest for agent A would
		// otherwise silently run agent B with different bytes.
		const parsedHash = parsed.rawBytesSha256;
		const parsedName = parsed.spec?.name;
		if (!parsedHash || !parsedName) {
			await failRun(paths, manifest, "re-read spec missing identity fields (rawBytesSha256 or name)", startedAt);
			return;
		}
		if (parsedHash !== manifest.identity.expectedHash) {
			await failRun(paths, manifest,
				`spec hash mismatch: manifest expects ${manifest.identity.expectedHash.slice(0, 12)}… but live spec hashes to ${parsedHash.slice(0, 12)}…`, startedAt);
			return;
		}
		if (parsedName !== manifest.identity.agentName) {
			await failRun(paths, manifest,
				`agent name mismatch: manifest expects '${manifest.identity.agentName}' but live spec is '${parsedName}'`, startedAt);
			return;
		}

		// Re-read user registry from disk (resolveTrustedHome path, never os.homedir()).
		const userRegistry = await readUserRegistry(trustedHome);

		// Full P3 gate: canRunAgent with live hash + re-read user registry.
		// Project trust is DEFERRED (user-agents-first scope; project agents are P4R-PROJ).
		const gate = await canRunAgent(
			{ parsed, canonicalPath: manifest.identity.canonicalPath },
			{ projectTrusted: false, homeDir: trustedHome, userRegistry },
		);
		if (!gate.ok) {
			await failRun(paths, manifest, `gate denied: ${gate.reason}`, startedAt);
			return;
		}

		if (sigtermReceived) {
			await writeStopped(paths, manifest, startedAt);
			return;
		}

		// Spawn the child agent via the shared runner.
		// explicitToolContextLoaderPath from env (NEVER manifest).
		// disableResourceDiscovery hard-pinned (NEVER manifest).
		// maxDurationSec from manifest options (advisory child timeout, distinct from
		// the reservation effectiveTimeoutSec used for slot-accounting).
		// P4-3-fix: AbortController wired so SIGTERM kills the child promptly.
		abortController = new AbortController();
		const spec = parsed.spec!; // safe: canRunAgent denies with missing-spec before this point
		const result = await childRunner(spec, manifest.task, {
			cwd: manifest.options.cwd,
			explicitToolContextLoaderPath: process.env[TOOL_CONTEXT_LOADER_PATH_ENV],
			disableResourceDiscovery: true,
			disableContextFiles: true,
			timeoutMs: manifest.options.maxDurationSec
				? manifest.options.maxDurationSec * 1000
				: undefined,
			signal: abortController.signal,
		});

		if (sigtermReceived) {
			// SIGTERM arrived during/after child run — write stopped, not the child's result.
			status = "stopped";
			await writeBgResult(paths, {
				version: 1,
				runId: paths.runId,
				status: "stopped",
				agentName: spec.name,
				startedAt,
				finishedAt: new Date().toISOString(),
			});
			await appendBgEvent(paths, { event: "worker-stopped", runId: paths.runId });
		} else {
			status = mapChildStatus(result.status);
			await writeBgResult(paths, buildBgResult(paths.runId, status, spec.name, startedAt, result));
			await appendBgEvent(paths, { event: "worker-finished", runId, status });
		}
	} catch (error) {
		status = sigtermReceived ? "stopped" : "failed";
		const msg = error instanceof Error ? error.message : String(error);
		await writeBgResult(paths, {
			version: 1,
			runId,
			status,
			agentName: undefined,
			startedAt,
			finishedAt: new Date().toISOString(),
			error: msg,
		});
		await appendBgEvent(paths, { event: "worker-error", runId, error: msg });
	} finally {
		process.off("SIGTERM", onSigterm);
		await markBgRunDone(paths);
	}
}

/** Map the child runner's status vocabulary to the bg run status vocabulary. */
function mapChildStatus(status: ChildAgentRunResult["status"]): BgRunStatus {
	switch (status) {
		case "completed":
			return "completed";
		case "timed-out":
			return "timed-out";
		case "failed":
		case "output-limit-exceeded":
		case "spill-error":
		case "spawn-error":
			return "failed";
		default:
			return "unknown";
	}
}

/** Build a BgRunResult from the child runner's result, capping result text at 64 KB. */
function buildBgResult(
	runId: string,
	status: BgRunStatus,
	agentName: string,
	startedAt: string,
	result: ChildAgentRunResult,
) {
	const resultText = result.summary.summaryText.length > 64_000
		? result.summary.summaryText.slice(0, 64_000) + "\n\n[truncated]"
		: result.summary.summaryText;
	return {
		version: 1,
		runId,
		status,
		agentName,
		startedAt,
		finishedAt: new Date().toISOString(),
		resultText,
		error: result.error,
	};
}

/** Write a failed result + event, then return so the caller exits without spawning. */
async function failRun(
	paths: BgRunPaths,
	manifest: BgRunManifest,
	reason: string,
	startedAt: string,
): Promise<void> {
	await writeBgResult(paths, {
		version: 1,
		runId: paths.runId,
		status: "failed",
		agentName: manifest.identity.agentName,
		startedAt,
		finishedAt: new Date().toISOString(),
		error: reason,
	});
	await appendBgEvent(paths, { event: "worker-failed", runId: paths.runId, reason });
}

/** Write stopped status for SIGTERM before spawn. */
async function writeStopped(
	paths: BgRunPaths,
	manifest: BgRunManifest,
	startedAt: string,
): Promise<void> {
	await writeBgResult(paths, {
		version: 1,
		runId: paths.runId,
		status: "stopped",
		agentName: manifest.identity.agentName,
		startedAt,
		finishedAt: new Date().toISOString(),
	});
	await appendBgEvent(paths, { event: "worker-stopped", runId: paths.runId });
}

// ── P4-3: Standalone worker process CLI entrypoint ───────────────────────
// When executed directly (not imported in tests), reads the manifest path
// from argv[2] and calls runBgWorker. Exits 0 on clean completion, non-zero
// on any failure so the terminal backend can detect crashed workers.

async function main(): Promise<void> {
	const manifestPath = process.argv[2];
	if (!manifestPath) {
		console.error("usage: node bg-worker.js <manifestPath>");
		process.exit(2);
	}
	try {
		await runBgWorker(manifestPath);
		process.exit(0);
	} catch (err) {
		console.error(String(err));
		process.exit(1);
	}
}

// Only run when executed directly — not imported by tests or other modules.
// Matches the exact script basename, not e.g. test-bg-worker.
const scriptBasename = path.basename(process.argv[1] ?? "");
if (scriptBasename === "bg-worker.js" || scriptBasename === "bg-worker.ts" || scriptBasename === "bg-worker.mjs") {
	main();
}
