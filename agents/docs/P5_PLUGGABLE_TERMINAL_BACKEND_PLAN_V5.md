# P5 Pluggable Terminal Backend Plan (v5)

## Status

Planning v5. Supersedes v1, v2, v3, v4.

Re-review of v4 (`20260627-073654-p5-v4-plan-re-review-response-changes-re-0ba8`): verdict CHANGES-REQUESTED. Scorecard: B2a stub-defect **genuinely fixed** (architecture correct), but **one new blocker** surfaced — both B2a tests fail on macOS due to `os.tmpdir()` realpath canonicalization (`/var` → `/private/var`).

v5 fixes:
- **NEW (macOS portability):** both B2a tests now assert against `fs.realpathSync(expected)` instead of raw `expected`. Still discriminating — `path.resolve` returns symlink path (≠ canonicalized target); wrong-precedence impl returns canonicalized mjs (≠ canonicalized ts).
- **Mutation-proof wording:** corrected. The realpath test's falsifying mutation is `fs.realpathSync` → `path.resolve` (symlink not followed). The precedence test's falsifying mutation is **reordering WORKER_BASENAMES** (e.g. `.mjs` before `.ts`), NOT the realpath mutation. The two tests have different falsifiers.

v5 is a small, surgical follow-up to v4. v4's architecture (the `resolveWorkerPath(searchDir?)` parameter) was correct; v5 fixes two test-construction issues exposed when v4's tests would actually run on the dev platform.

## Episode Search Summary

Key active memories:

- `20260627-073654-p5-v4-plan-re-review-response-changes-re-0ba8`: v4 re-review, NEW blocker (macOS realpath).
- `20260627-073203-p5-v4-plan-drafted-as-focused-surgical-f-d9f6`: v4 plan status (superseded by v5).
- `20260627-072939-p5-v3-plan-re-review-response-changes-re-58ed`: v3 re-review (B2a stub-defect).

## Why this v5 fix is necessary

v4's test bodies wrote:

```js
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p5-realpath-"));
const realWorker = path.join(tmpDir, "bg-worker.ts");
// ... create realWorker file, create symlinkPath ...
const result = resolveWorkerPath(agentsLibDir);
assert.equal(result, realWorker, "...");
```

On macOS, `os.tmpdir()` returns `/var/folders/...`. `mkdtempSync` returns `/var/folders/.../p5-realpath-XXXX`. So `realWorker = "/var/folders/.../bg-worker.ts"`. But production `resolveWorkerPath` calls `fs.realpathSync(candidate)` which canonicalizes — `agentLibDir` resolves to `/private/var/folders/.../agents/lib` because `/var` is a symlink to `/private/var`. So `result = "/private/var/folders/.../bg-worker.ts"` (canonicalized). The assert compares `/private/var/...` vs `/var/...` → **false**.

Verified empirically by the v4 reviewer on this machine.

## Objective

Same as v4: ship `tmux-terminal` extension implementing `TermBgBackend` with tmux.

## Requirements (Ground Truth)

22 requirements, unchanged from v3. v5 only fixes the two test bodies.

## Non-Goals

Same as v3.

## Safety / Security

Same as v3.

## Design

### Changes from v4

The production code (`resolve-worker-path.ts`) is **unchanged** in v5. Only the two test bodies change.

```ts
// test-helpers.mjs — REPLACED testWorkerPathIsRealpathed body:

{
  // B2a: real symlink fixture. resolveWorkerPath(searchDir) runs the REAL
  // production existsSync + realpathSync loop at agentsLibDir.
  // Assert against fs.realpathSync(realWorker) for macOS portability
  // (os.tmpdir() returns /var/... on macOS but fs.realpathSync canonicalizes
  // to /private/var/...). Still discriminating: a path.resolve-only impl
  // returns the symlink path (under agents/lib/), which != the canonicalized
  // target path.
  __resetResolveWorkerPathForTest();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p5-realpath-"));
  const realWorker = path.join(tmpDir, "bg-worker.ts");
  fs.writeFileSync(realWorker, "// real worker");
  const agentsLibDir = path.join(tmpDir, "agents", "lib");
  fs.mkdirSync(agentsLibDir, { recursive: true });
  const symlinkPath = path.join(agentsLibDir, "bg-worker.ts");
  fs.symlinkSync(realWorker, symlinkPath);
  const result = resolveWorkerPath(agentsLibDir);
  const canonicalExpected = fs.realpathSync(realWorker);
  __resetResolveWorkerPathForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.ok(result !== null, "resolveWorkerPath must find the symlink");
  assert.equal(result, canonicalExpected, "MUST return realpath of symlink target, canonicalized for macOS (B2a portability fix)");
}
```

```ts
// test-helpers.mjs — REPLACED testWorkerPathPrefersTsOverMjs body:

{
  // Precedence: .ts wins over .mjs. resolveWorkerPath(searchDir) runs the REAL
  // production WORKER_BASENAMES loop at tmpDir.
  // Assert against fs.realpathSync(tsPath) for macOS portability.
  // Still discriminating: a wrong-precedence impl returns realpathSync(mjsPath)
  // ≠ realpathSync(tsPath).
  __resetResolveWorkerPathForTest();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p5-precedence-"));
  const tsPath = path.join(tmpDir, "bg-worker.ts");
  const mjsPath = path.join(tmpDir, "bg-worker.mjs");
  fs.writeFileSync(tsPath, "ts");
  fs.writeFileSync(mjsPath, "mjs");
  const result = resolveWorkerPath(tmpDir);
  const canonicalTs = fs.realpathSync(tsPath);
  __resetResolveWorkerPathForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(result, canonicalTs, ".ts MUST win over .mjs when both present (canonicalized for macOS)");
}
```

### Why this still discriminates against wrong impls

| Impl | realpath test result | precedence test result |
|---|---|---|
| `fs.realpathSync` (correct) | passes | passes |
| `path.resolve` (wrong for realpath) | fails — returns symlink path | passes — both files are real (no symlinks) |
| Wrong precedence (`.mjs` before `.ts`) | (irrelevant) | fails — returns canonicalized mjs |
| Both wrong | fails | fails |

So each test has its own falsifying mutation, and both must pass for the production code to be correct.

## Existing Hook Points

Unchanged.

## Slice Ladder

Single slice, 63 tests. v5 changes only the bodies of two tests in test-helpers.mjs.

## Cut Order

Same as v3.

## Edge Cases

EC16 (B2a symlink fixture): unchanged from v4.
EC17 (NEW in v5): macOS realpath canonicalization. Asserts against `fs.realpathSync(expected)` to compare canonical paths.

## Test Case Catalog

**Canonical test count: 63 tests across 16 groups.** Single source of truth. **Same count as v4.**

v5 changes ONLY the bodies of two tests in test-helpers.mjs:
- `testWorkerPathIsRealpathed` (Group 13): now asserts `result === fs.realpathSync(realWorker)` (was `result === realWorker`).
- `testWorkerPathPrefersTsOverMjs` (Group 13): now asserts `result === fs.realpathSync(tsPath)` (was `result === tsPath`).

No other test changes.

## Risk Analysis

| Risk | Severity | Mitigation |
|---|---|---|
| macOS canonicalization bug returns on Linux (where `/var` is not a symlink) | Low | `fs.realpathSync(realWorker)` on Linux returns the same path as `realWorker` (no symlink). The assert reduces to the v4 form on Linux. |
| macOS canonicalization bug returns on Windows | Low | Windows users should already use `path.resolve` semantically; `fs.realpathSync` works on Windows and produces canonical paths. |
| Wrong-precedence impl still passes precedence test if `WORKER_BASENAMES` order happens to be `.ts`-first AND the loop is implemented differently | Low | The assertion is on `result === canonicalTs`, which only succeeds if the loop yields `.ts`. Any other ordering yields `mjs` and fails. |

## Done Criteria

- [ ] All 63 tests pass on macOS (verified by reviewer running tests on this machine).
- [ ] `testWorkerPathIsRealpathed` and `testWorkerPathPrefersTsOverMjs` assert against `fs.realpathSync(expected)` (canonicalized).
- [ ] Mutation proofs (run on macOS):
  - **Realpath test falsifier:** replace `fs.realpathSync(candidate)` with `path.resolve(candidate)` in `resolve-worker-path.ts` line ~22 → realpath test fails (path.resolve doesn't follow symlinks).
  - **Precedence test falsifier:** change `WORKER_BASENAMES` order to `["bg-worker.mjs", "bg-worker.ts", "bg-worker.js"]` in `constants.ts` line ~6 → precedence test fails.
  - **Both falsifiers must independently fail their respective tests.**

## Review Consensus

| Pass | Reviewer | Verdict |
|---|---|---|
| 1 | v1 reviewer | conditional-go (14 blockers) |
| 2 | v2 reviewer | conditional-go (B1 + B2/B5/B6) |
| 3 | v3 reviewer | conditional-go (B2a stub-defect) |
| 4 | v4 reviewer | conditional-go (NEW macOS realpath blocker) |
| 5 | _TBD_ | _pending_ |

## Appendix: Implementation Plan

### Files to modify (v5)

| File | Change |
|---|---|
| `tmux-terminal/test-fixtures/test-helpers.mjs` (step 1.11) | Rewrite the bodies of `testWorkerPathIsRealpathed` and `testWorkerPathPrefersTsOverMjs`. Each now computes `fs.realpathSync(expected)` and asserts against the canonicalized value. |

### Files unchanged from v4

All other files (resolve-worker-path.ts body is identical to v4; tmux-backend.ts, index.ts, etc. all inherit from v3).

## Appendix B: Mechanical Execution Spec (executor-ready)

### v5-only diff

Only step 1.11 changes. All other steps identical to v4.

| Step | File | Action | Verify |
|---|---|---|---|
| 1.11 | `tmux-terminal/test-fixtures/test-helpers.mjs` | **CREATE**. Same as v4 EXCEPT the `testWorkerPathIsRealpathed` and `testWorkerPathPrefersTsOverMjs` bodies are rewritten to assert against `fs.realpathSync(expected)`. **12 tests total** (unchanged count). | `node tmux-terminal/test-fixtures/test-helpers.mjs` exits 0 on macOS AND on Linux. Mutation proofs: realpathSync→path.resolve fails realpath test only; reordering WORKER_BASENAMES fails precedence test only. |

### test-helpers.mjs diff (v5, step 1.11)

**REPLACE** the two test bodies from v4 with:

```js
{
  // B2a: real symlink fixture. resolveWorkerPath(searchDir) runs the REAL
  // production existsSync + realpathSync loop at agentsLibDir.
  // Assert against fs.realpathSync(realWorker) for macOS portability:
  // os.tmpdir() returns /var/... on macOS but fs.realpathSync canonicalizes
  // to /private/var/... . Still discriminating: a path.resolve-only impl
  // returns the symlink path (under agents/lib/), which != canonicalized target.
  __resetResolveWorkerPathForTest();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p5-realpath-"));
  const realWorker = path.join(tmpDir, "bg-worker.ts");
  fs.writeFileSync(realWorker, "// real worker");
  const agentsLibDir = path.join(tmpDir, "agents", "lib");
  fs.mkdirSync(agentsLibDir, { recursive: true });
  const symlinkPath = path.join(agentsLibDir, "bg-worker.ts");
  fs.symlinkSync(realWorker, symlinkPath);
  const result = resolveWorkerPath(agentsLibDir);
  const canonicalExpected = fs.realpathSync(realWorker);
  __resetResolveWorkerPathForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.ok(result !== null, "resolveWorkerPath must find the symlink");
  assert.equal(result, canonicalExpected, "MUST return realpath of symlink target, canonicalized for macOS");
}
{
  // Precedence: .ts wins over .mjs. resolveWorkerPath(searchDir) runs the REAL
  // production WORKER_BASENAMES loop at tmpDir.
  // Assert against fs.realpathSync(tsPath) for macOS portability.
  // Still discriminating: a wrong-precedence impl returns realpathSync(mjsPath)
  // != realpathSync(tsPath).
  __resetResolveWorkerPathForTest();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p5-precedence-"));
  const tsPath = path.join(tmpDir, "bg-worker.ts");
  const mjsPath = path.join(tmpDir, "bg-worker.mjs");
  fs.writeFileSync(tsPath, "ts");
  fs.writeFileSync(mjsPath, "mjs");
  const result = resolveWorkerPath(tmpDir);
  const canonicalTs = fs.realpathSync(tsPath);
  __resetResolveWorkerPathForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(result, canonicalTs, ".ts MUST win over .mjs when both present");
}
```

All other tests in test-helpers.mjs (3 shellEscape + 2 redactError + 1 force-null + 5 defaultTmuxExecutor/Fake + the final `console.log`) are identical to v4.

### Falsifiable Verify (v5 additions)

The v4 verify commands apply. v5 additions:

- **Mutation proof (manual verification during implementation):**
  - Replace `fs.realpathSync(candidate)` with `path.resolve(candidate)` in `resolve-worker-path.ts` line ~22. Run `node tmux-terminal/test-fixtures/test-helpers.mjs`. Only `testWorkerPathIsRealpathed` MUST fail; the precedence test is unaffected (real files, no symlinks).
  - Change `WORKER_BASENAMES` to `["bg-worker.mjs", "bg-worker.ts", "bg-worker.js"]` in `constants.ts` line ~6. Run tests. Only `testWorkerPathPrefersTsOverMjs` MUST fail; the realpath test is unaffected.
- **macOS empirical verification:** the v5 reviewer must run `node tmux-terminal/test-fixtures/test-helpers.mjs` on this macOS machine and verify all 12 tests pass.

### Blast-radius patterns applied

- **Test-preserving seam:** `resolveWorkerPath(searchDir?)` unchanged from v4. The canonicalization fix is in the test bodies, not the production code.
- **Thin wrapper:** unchanged.

### Definition of done (v5)

`bash tmux-terminal/test-fixtures/run-p5-tests.sh` prints all 63 tests passing on macOS, prints "REQ-13 OK", exits 0.
Two independent mutation proofs each fail their respective test only.

## Appendix C: v4 → v5 deltas summary

For the reviewer's convenience:

1. **`tmux-terminal/test-fixtures/test-helpers.mjs`** (step 1.11 body): Two test bodies rewritten:
   - `testWorkerPathIsRealpathed` (was L268/279): now computes `const canonicalExpected = fs.realpathSync(realWorker);` after the production call, then `assert.equal(result, canonicalExpected, ...)`. Adds 1 line.
   - `testWorkerPathPrefersTsOverMjs` (was L286/293): now computes `const canonicalTs = fs.realpathSync(tsPath);` after the production call, then `assert.equal(result, canonicalTs, ...)`. Adds 1 line.

2. **Done Criteria mutation-proof wording corrected:** two distinct falsifying mutations, one per test:
   - Realpath test → `fs.realpathSync` → `path.resolve` (fails this test only).
   - Precedence test → reorder `WORKER_BASENAMES` (fails this test only).

3. **No changes to:** resolve-worker-path.ts body, tmux-backend.ts, index.ts, any other test file, run-p5-tests.sh, README.

v5 is a 2-line test fix plus a wording correction.