// P4-2: Shared background-agent preflight. Re-reads current spec bytes, runs the
// canRunAgent gate (user-agents-first; project trust DEFERRED), then creates a bg
// run state and writes a signed manifest the worker (P4-3) will verify.
//
// The manifest is identity-only (verified, not trusted): homeDir is checked against
// resolveTrustedHome() by the worker's assertManifestIdentityMatchesRuntime. All
// authority roots come from resolveTrustedHome() (os.userInfo().homedir), never
// $HOME / os.homedir() / a manifest field.

import path from "node:path";
import { promises as fs } from "node:fs";
import {
	assertManifestIdentityMatchesRuntime,
	createBgRunState,
	keyGenIdFromKey,
	readOrCreateSessionMacKey,
	resolveTrustedHome,
	signBgManifest,
	writeBgManifest,
	type BgRunManifest,
	type BgRunPaths,
} from "./bg-state.ts";
import { preflightAgentGate, type AgentsContextLike, type RunnableRegisteredRecord } from "./run-resolver.ts";
import type { AgentDiagnostics } from "./diagnostics.ts";

export type BgPreflightOptions = {
	/** Trusted home root for state/MAC location. Defaults to resolveTrustedHome() (os.userInfo().homedir).
	 *  Test seam; in production the parent preflight runs in the trusted host session. The worker
	 *  (P4-3) ALWAYS derives roots from resolveTrustedHome(), never from this or a manifest field. */
	homeDir?: string;
	/** Advisory child-process timeout (manifest options.maxDurationSec). Optional; <= BG_MAX_DURATION_SEC. */
	maxDurationSec?: number;
	/** Opaque backend handle (window/pgid) recorded on the reservation for bg-stop. */
	ownerHandle?: string;
	/** Slot-accounting timeout written to .reserved (distinct from maxDurationSec). */
	effectiveTimeoutSec?: number;
};

export type BgPreflightResult =
	| { ok: true; runId: string; paths: BgRunPaths; manifest: BgRunManifest }
	| { ok: false; code: string; reason: string };

/** P4-2: preflight a background agent run — gate + write signed identity manifest.
 *  Does NOT launch the worker (that is P4-3/P4-4). Returns the runId + paths so the
 *  terminal backend can launch the worker with manifestPath. */
export async function preflightBgAgent(
	record: RunnableRegisteredRecord,
	task: string,
	ctx: AgentsContextLike,
	diagnostics: AgentDiagnostics,
	options: BgPreflightOptions = {},
): Promise<BgPreflightResult> {
	const trustedHome = options.homeDir ?? resolveTrustedHome();

	// 1. Shared gate: re-read spec bytes, recompute status, canRunAgent (user-registry;
	//    project trust is consulted by canRunAgent only on source:project, which is the
	//    DEFERRED project-agent scope — user-agents-first gates on user registry + hash).
	const preflight = await preflightAgentGate(record, ctx, diagnostics);
	if (!preflight.ok) return { ok: false, code: preflight.code, reason: preflight.reason };
	const liveSpec = preflight.parsed.spec!;

	// 2. Allocate a bg run state (reservation written as JSON with keyGenId).
	const paths = await createBgRunState({
		homeDir: trustedHome,
		ownerHandle: options.ownerHandle,
		effectiveTimeoutSec: options.effectiveTimeoutSec,
	});

	// 3. Build the identity-only manifest. homeDir is identity verified against
	//    resolveTrustedHome() by the worker; cwd is advisory identity (N6: not compared).
	const manifestWithoutMac: Omit<BgRunManifest, "mac"> = {
		version: 1,
		runId: paths.runId,
		identity: {
			agentName: liveSpec.name,
			canonicalPath: record.canonicalPath,
			expectedHash: record.rawBytesSha256,
		},
		task,
		options: {
			cwd: ctx.cwd ?? process.cwd(),
			homeDir: trustedHome,
			...(options.maxDurationSec !== undefined ? { maxDurationSec: options.maxDurationSec } : {}),
		},
		keyGenId: "", // filled below after we have the key
	};

	// 4. Sign with the session MAC key (located via the trusted root). keyGenId ties the
	//    manifest to the current key generation so a rotated key fails verify loudly.
	const key = await readOrCreateSessionMacKey(trustedHome);
	const keyGenId = keyGenIdFromKey(key);
	const signedManifest: Omit<BgRunManifest, "mac"> = { ...manifestWithoutMac, keyGenId };
	const mac = signBgManifest(signedManifest, key);
	const manifest: BgRunManifest = { ...signedManifest, mac };

	// 5. Sanity: the manifest's homeDir MUST match the trusted root we just used, or the
	//    worker's assertManifestIdentityMatchesRuntime will reject it. (Defense-in-depth;
	//    here they are the same by construction.)
	assertManifestIdentityMatchesRuntime(manifest, { homeDir: trustedHome });

	// 6. Persist the manifest (writeBgManifest re-asserts reservation + path safety).
	await writeBgManifest(paths, manifest);

	return { ok: true, runId: paths.runId, paths, manifest };
}
