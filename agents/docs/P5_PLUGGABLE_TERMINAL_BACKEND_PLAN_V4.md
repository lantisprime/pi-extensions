# P5 Pluggable Terminal Backend Plan (v4)

## Status

Planning v4. Supersedes v1, v2, v3.

Re-review of v3 (`20260627-072939-p5-v3-plan-re-review-response-changes-re-58ed`): verdict CHANGES-REQUESTED. Scorecard: **4 of 5 v2 residuals closed** (B1, B2b, B5, B6), **1 remaining blocker (B2a)**.

v4 fixes:
- **B2a**: replaces the broken `__setResolveWorkerPathForTest(fn)` short-circuit pattern with a new `resolveWorkerPath(searchDir?: string)` overload that **runs the real production `existsSync + realpathSync` loop** rooted at `searchDir` when provided. The two realpath/precedence tests now use `searchDir` (production code executes); the missing-worker test (B2b) keeps using `__setResolveWorkerPathForTest` because it tests the skip branch, not the resolution loop.
- **Tidy (non-blocking)**: REQ↔test mapping staleness corrected. `testFakeExecutorEnforcesTimeoutFromOpts` added to REQ-15's Test(s) cell. `testLaunchOkEvenIfSetWindowOptionFails` added to REQ-5a/REQ-8 cross-ref. `testDefaultTmuxExecutor{NeverRejects,HandlesMissingBinary}` added to REQ-15 cross-ref.

Implementation must NOT start until v4 receives unconditional go.

## Episode Search Summary

Key active memories:

- `20260627-072939-p5-v3-plan-re-review-response-changes-re-58ed`: v3 re-review, verdict CHANGES-REQUESTED, B2a blocker.
- `20260627-072025-p5-v3-plan-drafted-addressing-all-v2-re--92cb`: v3 plan status (now superseded by v4).
- `20260627-070955-p5-v2-plan-re-review-response-changes-re-ceee`: v2 re-review.
- `20260625-082608-p4-4-review-findings-resolved-discrimina-6c0c`: P4-4 interface forward-compatible.

## Why this v4 fix is necessary

The v3 test `testWorkerPathIsRealpathed` does this:

```js
__setResolveWorkerPathForTest(function _r() {
  const candidate = path.join(agentsLibDir, "bg-worker.ts");
  if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
  return null;
});
const result = resolveWorkerPath();  // ← production short-circuits, returns the test's stub
```

But production `resolveWorkerPath` (v3 step 1.6) short-circuits on the FIRST line: `if (injectedResolver) return injectedResolver();`. So `resolveWorkerPath()` returns the test's own stub — which hardcodes `fs.realpathSync` — and the production resolution path (the `existsSync + realpathSync` loop over `WORKER_BASENAMES` rooted at `import.meta.url`'s sibling dir) NEVER runs. A `path.resolve`-only production impl would still pass the test. Same defect for `testWorkerPathPrefersTsOverMjs`.

The fix in v4 introduces a `searchDir` parameter to `resolveWorkerPath` that, when provided, runs the **real** production loop rooted at `searchDir`. Tests call `resolveWorkerPath(searchDir)` with a tmpdir+symlink fixture; production code executes; a `path.resolve`-only impl fails the assert.

The `__setResolveWorkerPathForTest(fn)` seam is **kept** for B2b's missing-worker test because that test exercises the skip branch (which `searchDir` cannot drive) — production `resolveWorkerPath(undefined)` with a real path returns a non-null value, and the skip behavior happens in `tmuxTerminalExtension` itself when `resolveWorkerPath()` returns null.

## Objective

Same as v3: ship `tmux-terminal` extension implementing `TermBgBackend` with tmux.

## Requirements (Ground Truth)

22 requirements, unchanged from v3. v4 only adds the `searchDir` parameter to `resolveWorkerPath` (a test seam, not a requirement change). REQ-15's Test(s) cell now lists `testFakeExecutorEnforcesTimeoutFromOpts` (was missing).

## Non-Goals

Same as v3.

## Safety / Security

Same as v3. The `searchDir` parameter is a test-only seam; production callers always call `resolveWorkerPath()` with no argument.

## Design

### Key types (changes from v3)

```ts
// tmux-terminal/lib/resolve-worker-path.ts (v4)
// New: searchDir parameter that runs the REAL production loop at the provided directory.
// Without searchDir: uses the import.meta.url-derived default and the existing cache.
// With searchDir: bypasses the cache and the injectedResolver check (production loop runs).
export function resolveWorkerPath(searchDir?: string): string | null {
  if (injectedResolver && searchDir === undefined) return injectedResolver();
  const baseDir = searchDir ?? (function () {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.dirname(here);
  })();
  for (const basename of WORKER_BASENAMES) {
    const candidate = path.join(baseDir, basename);
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
  }
  return null;
}

// __setResolveWorkerPathForTest: now ONLY for B2b missing-worker. Realpath/precedence
// tests use resolveWorkerPath(searchDir) instead.
export function __setResolveWorkerPathForTest(fn: (() => string | null) | null): void {
  injectedResolver = fn;
}
```

### Key invariants

- `resolveWorkerPath()` (no args): production default — uses `import.meta.url` + cache + injectedResolver short-circuit.
- `resolveWorkerPath(searchDir)`: runs the REAL `existsSync + realpathSync` loop over `WORKER_BASENAMES` rooted at `searchDir`. No cache. No `injectedResolver` short-circuit.
- A `path.resolve`-only impl fails the realpath/precedence tests because:
  - `testWorkerPathIsRealpathed` symlink fixture: `path.resolve` returns the symlink path; assert `=== realWorker` fails.
  - `testWorkerPathPrefersTsOverMjs` precedence fixture: `path.resolve` doesn't iterate over `WORKER_BASENAMES`; precedence is undefined; assert `=== tsPath` fails.

### Contract state tables

`resolveWorkerPath` state table (updated for v4):

| State | Condition | Output |
|---|---|---|
| A. No args, cache hit | extension already resolved | cached path |
| B. No args, cache miss | first call | runs production loop at `import.meta.url` sibling; caches result |
| C. `searchDir` provided | test mode | runs production loop at `searchDir`; no cache; no injectedResolver |
| D. No args + `injectedResolver` set | B2b missing-worker test | returns injectedResolver() (may return null) |
| E. No basename found | directory exists, no `bg-worker.{ts,mjs,js}` | null |
| F. Directory missing / read error | fs error | null |

### Resolution / flow

Unchanged from v3.

## Existing Hook Points

Unchanged.

## Slice Ladder

Single slice, 63 tests. v4 changes only:
- Step 1.6 body: `resolveWorkerPath` signature + body
- Step 1.11 body: the two realpath/precedence tests rewritten

All other steps unchanged.

## Cut Order

Same as v3.

## Edge Cases

EC16 (B2a symlink fixture): production loop at tmpdir/agents/lib finds `bg-worker.ts` symlink; `fs.realpathSync` returns the realpath of the target. Assert: `result === realWorker`. A `path.resolve`-only impl returns the symlink path; assert fails.

## Test Case Catalog

**Canonical test count: 63 tests across 16 groups.** Single source of truth. **Same count as v3.**

Per-file: **45** (test-tmux-backend.mjs, Groups 1-11) + **12** (test-helpers.mjs, Group 13 partial + Group 15 + Group 16) + **6** (test-extension.mjs, Group 12 + Group 13 missing-worker + Group 14) = **63** ✓

v4 changes ONLY the bodies of two tests in test-helpers.mjs:
- `testWorkerPathIsRealpathed` (Group 13): now uses `resolveWorkerPath(agentsLibDir)` with the symlink fixture.
- `testWorkerPathPrefersTsOverMjs` (Group 13): now uses `resolveWorkerPath(tmpDir)` with both `.ts` and `.mjs` files.

No other test changes.

## Risk Analysis

| Risk | Severity | Mitigation |
|---|---|---|
| `searchDir` parameter bypasses cache — could cause unintended repeated fs I/O in production if misused | Low | `searchDir` is documented as test-only; production callers in `index.ts` and `tmux-backend.ts` only ever call `resolveWorkerPath()` (no arg). |
| `searchDir` parameter bypasses injectedResolver — could cause confusion if both are set | Low | v4 precedence: `searchDir` overrides `injectedResolver` only when `searchDir` is explicitly provided. The seam is documented: "Realpath/precedence tests use `searchDir`; missing-worker test uses `injectedResolver`." They are not used together. |
| A `path.resolve`-only impl still passes some test (false negative) | Low | The realpath test asserts `=== realWorker` (a different path than the symlink); the precedence test asserts `=== tsPath` (specific file in a list). Both fail for `path.resolve`-only impls. |

## Done Criteria

- [ ] All 63 tests pass.
- [ ] `testWorkerPathIsRealpathed` and `testWorkerPathPrefersTsOverMjs` exercise the **real** `resolveWorkerPath` production loop (verified by reading test bodies).
- [ ] `path.resolve`-only impl of `resolveWorkerPath` would fail both tests (verify by mutation: replace `fs.realpathSync` with `path.resolve`, run tests, expect both to fail).

## Review Consensus

| Pass | Reviewer | Verdict |
|---|---|---|
| 1 | v1 reviewer | conditional-go (14 blockers) |
| 2 | v2 reviewer | conditional-go (B1 unresolved, B2/B5/B6 partial) |
| 3 | v3 reviewer | conditional-go (1 blocker: B2a) |
| 4 | _TBD_ | _pending_ |

## Appendix: Implementation Plan

### Files to modify (v4)

| File | Change |
|---|---|
| `tmux-terminal/lib/resolve-worker-path.ts` (step 1.6) | Replace `resolveWorkerPath()` body with the v4 version supporting `searchDir?: string`. The `injectedResolver` short-circuit only applies when `searchDir === undefined`. |
| `tmux-terminal/test-fixtures/test-helpers.mjs` (step 1.11) | Rewrite `testWorkerPathIsRealpathed` and `testWorkerPathPrefersTsOverMjs` to use `resolveWorkerPath(searchDir)` with tmpdir fixtures. |

### Files unchanged from v3

All other files (constants, shell-escape, redact-error, path-validate, exec, tmux-backend, index, fake-tmux, test-tmux-backend, test-extension, run-p5-tests.sh, README, agents/test-bg.mjs, agents/P3_IMPLEMENTATION_SLICES.md).

## Appendix B: Mechanical Execution Spec (executor-ready)

### Executor contract

Same as v3. The executor runs steps in numeric order, makes no design decisions, etc.

### v4-only diff

Steps 1.6 and 1.11 bodies change. All other steps identical to v3.

| Step | File | Action | Verify |
|---|---|---|---|
| 1.6 | `tmux-terminal/lib/resolve-worker-path.ts` | **CREATE**. Full contents (v4 version, ~40 lines): see "resolve-worker-path.ts verbatim body (v4)" below. | `grep -n "searchDir" tmux-terminal/lib/resolve-worker-path.ts && grep -n "WORKER_BASENAMES" tmux-terminal/lib/resolve-worker-path.ts && grep -n "__setResolveWorkerPathForTest" tmux-terminal/lib/resolve-worker-path.ts` (all 3 required) |
| 1.11 | `tmux-terminal/test-fixtures/test-helpers.mjs` | **CREATE**. Same as v3 EXCEPT two test bodies are rewritten — see "test-helpers.mjs diff (v4)" below. **12 tests total** (unchanged count). | `node tmux-terminal/test-fixtures/test-helpers.mjs` prints "P5 helper tests passed" and exits 0 |

All other steps (1.1-1.5, 1.7-1.10, 1.12-1.16) inherit from v3 verbatim. The executor should re-read the v3 plan for unchanged step bodies.

#### resolve-worker-path.ts verbatim body (v4, step 1.6)

```ts
// tmux-terminal/lib/resolve-worker-path.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_BASENAMES } from "./constants.ts";

let cachedWorkerPath: string | null = null;
let resolved = false;
let injectedResolver: (() => string | null) | null = null;

/**
 * Locate the bg-worker.{ts,mjs,js} file relative to a search directory.
 *
 * Production mode (no args): uses the directory adjacent to the importing module's
 * `bg-terminal.ts` location (i.e. `agents/lib/`). Caches the result for the
 * process lifetime. Honors `__setResolveWorkerPathForTest` for B2b's missing-worker test.
 *
 * Test mode (searchDir provided): runs the REAL production loop (existsSync +
 * realpathSync over WORKER_BASENAMES) rooted at `searchDir`. Does NOT cache, does
 * NOT consult `injectedResolver`. This is the seam used by B2a's realpath and
 * precedence tests so they exercise the production code path — a path.resolve-only
 * impl fails both tests.
 *
 * Returns the realpath of the matched worker, or null if none found / read error.
 */
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
```

#### test-helpers.mjs diff (v4, step 1.11)

Only the `testWorkerPathIsRealpathed` and `testWorkerPathPrefersTsOverMjs` test bodies change. Everything else (3 shellEscape + 2 redactError + 1 force-null + 5 defaultTmuxExecutor/Fake + the final `console.log`) is identical to v3.

**REPLACE the two test bodies with:**

```js
{
	// B2a: real symlink fixture. resolveWorkerPath(searchDir) runs the REAL
	// production existsSync + realpathSync loop at agentsLibDir. A path.resolve-only
	// impl returns the symlink path and the assert fails.
	__resetResolveWorkerPathForTest();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p5-realpath-"));
	const realWorker = path.join(tmpDir, "bg-worker.ts");
	const targetContent = "// real worker";
	fs.writeFileSync(realWorker, targetContent);
	const agentsLibDir = path.join(tmpDir, "agents", "lib");
	fs.mkdirSync(agentsLibDir, { recursive: true });
	const symlinkPath = path.join(agentsLibDir, "bg-worker.ts");
	fs.symlinkSync(realWorker, symlinkPath);
	const result = resolveWorkerPath(agentsLibDir);
	__resetResolveWorkerPathForTest();
	fs.rmSync(tmpDir, { recursive: true, force: true });
	assert.ok(result !== null, "resolveWorkerPath must find the symlink");
	assert.equal(result, realWorker, "MUST return realpath of symlink target, not symlink path (B2a)");
}
{
	// Precedence: .ts wins over .mjs. resolveWorkerPath(searchDir) runs the REAL
	// production WORKER_BASENAMES loop at tmpDir. A wrong-precedence impl fails.
	__resetResolveWorkerPathForTest();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p5-precedence-"));
	const tsPath = path.join(tmpDir, "bg-worker.ts");
	const mjsPath = path.join(tmpDir, "bg-worker.mjs");
	fs.writeFileSync(tsPath, "ts");
	fs.writeFileSync(mjsPath, "mjs");
	const result = resolveWorkerPath(tmpDir);
	__resetResolveWorkerPathForTest();
	fs.rmSync(tmpDir, { recursive: true, force: true });
	assert.equal(result, tsPath, ".ts MUST win over .mjs when both present");
}
```

**The 3rd test (force-null seam unit test) keeps using `__setResolveWorkerPathForTest`** because it tests the seam itself, not the production loop:

```js
{
	// Force-null seam unit test (drives B2b's missing-worker test path)
	__resetResolveWorkerPathForTest();
	__setResolveWorkerPathForTest(function _r() { return null; });
	const result = resolveWorkerPath(); // no searchDir → uses injectedResolver
	__resetResolveWorkerPathForTest();
	assert.equal(result, null, "null seam MUST return null when injected");
}
```

**Test count remains 12** (3 shellEscape + 2 redactError + 2 realpath/precedence + 1 force-null + 2 defaultTmuxExecutor + 2 Fake seam = 12).

### Falsifiable Verify (v4 additions)

The v3 verify commands apply. The v4 addition is:

- **Mutation proof (manual verification during implementation):** temporarily replace `fs.realpathSync(candidate)` with `path.resolve(candidate)` in `resolve-worker-path.ts` (line 22). Run `node tmux-terminal/test-fixtures/test-helpers.mjs`. Both `testWorkerPathIsRealpathed` and `testWorkerPathPrefersTsOverMjs` MUST fail. Revert. Both MUST pass.

### Blast-radius patterns applied

- **Test-preserving seam (corrected):** `resolveWorkerPath(searchDir?)` is the new seam. Realpath/precedence tests drive production. The `__setResolveWorkerPathForTest` seam is now scoped to B2b only.
- **Thin wrapper:** unchanged.

### Definition of done (v4)

`bash tmux-terminal/test-fixtures/run-p5-tests.sh` prints all 63 tests passing, prints "REQ-13 OK", exits 0.
Mutation proof: replacing `fs.realpathSync` with `path.resolve` makes both B2a tests fail.

## Appendix C: v3 → v4 deltas summary

For the reviewer's convenience, the complete list of changes from v3 to v4:

1. **`tmux-terminal/lib/resolve-worker-path.ts`** (step 1.6 body): Added `searchDir?: string` parameter. Production loop is now a single function called by both modes (production default + test searchDir). `injectedResolver` short-circuit only applies when `searchDir === undefined`. ~40 lines (was ~28).

2. **`tmux-terminal/test-fixtures/test-helpers.mjs`** (step 1.11 body): Two test bodies rewritten:
   - `testWorkerPathIsRealpathed` (was L1006-1016): now calls `resolveWorkerPath(agentsLibDir)` instead of injecting a stub resolver.
   - `testWorkerPathPrefersTsOverMjs` (was L1018-1037): now calls `resolveWorkerPath(tmpDir)` instead of injecting a stub resolver.
   - `testExtensionSkipsRegistrationWhenWorkerMissing` (in test-extension.mjs): unchanged — still uses `__setResolveWorkerPathForTest`.

3. **Tidy (non-blocking, included proactively)**: REQ-15 Test(s) cell now lists `testFakeExecutorEnforcesTimeoutFromOpts` (was missing).

4. **v3 think-aloud cleanup**: The line "Test count remains 12..." in this v4 file replaces what would have been repeated think-aloud in v3. v3 had already deleted its think-aloud per B1; v4 carries forward.

No other changes. v4 is a focused, surgical fix to B2a.