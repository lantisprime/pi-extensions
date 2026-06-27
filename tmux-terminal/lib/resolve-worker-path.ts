// P5 (v4): Locate the bg-worker.{ts,mjs,js} file relative to a search directory.
//
// Production mode (no args): uses the directory adjacent to the importing module's
// `bg-terminal.ts` location (i.e. `agents/lib/`). Caches the result for the
// process lifetime. Honors `__setResolveWorkerPathForTest` for B2b's missing-worker test.
//
// Test mode (searchDir provided): runs the REAL production loop (existsSync +
// realpathSync over WORKER_BASENAMES) rooted at `searchDir`. Does NOT cache, does
// NOT consult `injectedResolver`. This is the seam used by B2a's realpath and
// precedence tests so they exercise the production code path — a path.resolve-only
// impl fails both tests.
//
// Returns the realpath of the matched worker, or null if none found / read error.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_BASENAMES } from "./constants.ts";

let cachedWorkerPath: string | null = null;
let resolved = false;
let injectedResolver: (() => string | null) | null = null;

export function resolveWorkerPath(searchDir?: string): string | null {
	if (searchDir === undefined && injectedResolver) return injectedResolver();
	const baseDir = searchDir ?? path.dirname(path.dirname(fileURLToPath(import.meta.url)));
	try {
		for (const basename of WORKER_BASENAMES) {
			const candidate = path.join(baseDir, basename);
			if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Force-null seam for B2b's missing-worker test ONLY. Realpath/precedence tests
 * must use resolveWorkerPath(searchDir) instead so the production loop runs.
 */
export function __setResolveWorkerPathForTest(fn: (() => string | null) | null): void {
	injectedResolver = fn;
}

export function __resetResolveWorkerPathForTest(): void {
	injectedResolver = null;
	cachedWorkerPath = null;
	resolved = false;
}