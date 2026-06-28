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
	if (searchDir !== undefined) {
		try {
			for (const basename of WORKER_BASENAMES) {
				const candidate = path.join(searchDir, basename);
				if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
			}
			return null;
		} catch {
			return null;
		}
	}
	// Production mode (D7): walk up from this module's directory looking for
	// an `agents/lib/` sibling containing bg-worker.{ts,mjs,js}. This is robust
	// to:
	//   - symlinked extensions (e.g. ~/.pi/agent/extensions/tmux-terminal)
	//   - arbitrary repo depth (the agents/ dir may be N levels above)
	//   - ts vs mjs vs js worker variants
	let dir = path.dirname(fileURLToPath(import.meta.url));
	const root = path.parse(dir).root;
	while (dir !== root) {
		const agentsLibDir = path.join(dir, "agents", "lib");
		try {
			for (const basename of WORKER_BASENAMES) {
				const candidate = path.join(agentsLibDir, basename);
				if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
			}
		} catch {
			// ignore read errors and keep walking up
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
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