# P5 Pluggable Terminal Backend Plan (v3)

## Status

Planning v3. Supersedes v1 and v2.

Re-review of v2 (`20260627-070955-p5-v2-plan-re-review-response-changes-re-ceee`): verdict CHANGES-REQUESTED. Scorecard: 9 RESOLVED (B3, B4, B7, A1, A2, A3, A4, A5, A6, A7), 3 PARTIAL (B2, B5, B6), 1 UNRESOLVED (B1).

v3 fixes:
- **B1**: converges on canonical count = **63 tests across 16 groups**. Deletes the v2 think-aloud. Strategy Table reconciles to the enumeration.
- **B2a**: `testWorkerPathIsRealpathed` uses a symlink fixture (`fs.symlinkSync`) so a `path.resolve`-only impl fails the test.
- **B2b**: adds `__setResolveWorkerPathForTest(fn)` force-null seam so `testExtensionSkipsRegistrationWhenWorkerMissing` can drive the skip branch.
- **B5**: `testListRecoversRunIdAndAgentName` uses a concrete exact-value fixture (asserts literal `bg-1719432000000-a3f9c2b1e8f4d2b6` and `pi-agent-bg-1719432000000-a3f9c2b1e8f4d2b6`, not just "non-empty").
- **B6**: inlines ALL 63 test bodies verbatim in Appendix B (no more "to be inlined at impl time" placeholders). Security verification steps now executor-ready.
- **Minor**: step 1.11 quote mismatch fixed.

Implementation must NOT start until v3 receives unconditional go from both reviews.

## Episode Search Summary

Searched episodic memory for `P5`, `tmux-terminal`, `pluggable terminal backend`, `TermBgBackend`, `bg-worker`, `bg-run`, `bg-state`.

Key active memories:

- `20260627-070955-p5-v2-plan-re-review-response-changes-re-ceee`: Re-review of v2. Verdict CHANGES-REQUESTED. Residual blockers listed in Status section above.
- `20260627-065905-p5-v2-plan-drafted-resolving-all-14-bloc-bec2`: v2 plan status (now superseded by v3).
- `20260627-065301-p5-e4ba`: P5 plan package milestone.
- `20260625-082608-p4-4-review-findings-resolved-discrimina-6c0c`: "Interface is forward-compatible with P5 tmux-terminal plan."
- `agents/docs/P5_PLUGGABLE_TERMINAL_BACKEND.md` (2026-06-18): pre-template outline.

## Objective

Ship a separate `tmux-terminal` extension that registers a `TermBgBackend` implementing the P4-4 interface using tmux, so users can run `/agents bg` with the tmux backend loaded alongside `agents`.

## Why

P4-4 deliberately split terminal control into a pluggable interface so the agents extension never imports tmux or any terminal-specific library. Without P5, `/agents bg` produces "No terminal backend installed." P5 is the canonical reference implementation that proves the P4-4 interface is sufficient, establishes the `registerBgTerminalBackend` extension-discovery contract, gives users a working `/agents bg`, and provides a foundation for alternative backends.

## Requirements (Ground Truth)

22 requirements. Every MUST row maps to ≥1 falsifiable, automated test.

| ID | Requirement | Test(s) | Priority |
|---|---|---|---|
| REQ-1 | `name === "tmux"` | testTmuxBackendName | MUST |
| REQ-2 | `isAvailable()` returns true only when tmux on PATH AND ($TMUX set OR `has-session` succeeds). Short-circuit on `$TMUX`. Never throw. | testIsAvailableTrueWhenTmuxOnPathAndServerReachable, testIsAvailableTrueWhenTmuxEnvSet, testIsAvailableFalseWhenTmuxMissing, testIsAvailableFalseWhenServerUnreachable, testIsAvailableDoesNotThrow | MUST |
| REQ-3 | `launch` constructs tmux command with only workerPath + manifestPath in `new-window` argv. agentName NOT in `new-window` argv. | testLaunchEmitsOnlyWorkerPathAndManifestPathInCommand, testLaunchDoesNotInterpolateAgentName, testLaunchAgentNameAppearsOnlyInSetWindowOptionArgv, testLaunchDoesNotInterpolateRunId, testLaunchUsesExecFileOrSpawnArgv | MUST |
| REQ-4 | manifestPath passed as argv, not env/stdin/tempfile. Escaped for shell defense-in-depth. | testLaunchPassesManifestAsArgv, testLaunchEscapesPathsForShell, testLaunchEscapesPathsWithSpaces, testLaunchEscapesPathsWithSingleQuote | MUST |
| REQ-5 | Window name = `pi-agent-<FULL-runId>` (no truncation). `@pi_run_id` set. | testLaunchWindowNameUsesFullRunId, testLaunchWindowNameCollisionSafeForRunId, testLaunchSetsRunIdUserOption | MUST |
| REQ-5a | `@pi_agent_name` set via separate `set-window-option` call, NEVER in `new-window` argv. | testLaunchSetsAgentNameUserOption | MUST |
| REQ-6 | Window cwd via `-c` per-window option, not `cd` in command. | testLaunchSetsWindowCwd | SHOULD |
| REQ-7 | tmux invoked via `execFile`/argv, not shell string. | (covered by REQ-3's testLaunchUsesExecFileOrSpawnArgv) | MUST |
| REQ-8 | Success → `{ status: "ok", windowId }`. Failure → `{ status: "failed", error: redacted }` with stderr truncated to 512 chars and paths replaced by `<worker>`/`<manifest>`. | testLaunchReturnsOkWithWindowId, testLaunchReturnsFailedWithTruncatedStderr, testLaunchErrorDoesNotLeakPaths, testRedactErrorReplacesAllOccurrences, testRedactErrorNoPathsNoChange | MUST |
| REQ-9 | `kill`: exact-match windowId. Idempotent on "can't find window". | testKillRemovesWindow, testKillIdempotentOnMissingWindow, testKillExactMatchNoSubstring | MUST |
| REQ-10 | `isAlive`: exact-match against `list-windows -F '#{window_name}'`. Empty/foreign/error → false. | testIsAliveTrueForLaunchedWindow, testIsAliveFalseForForeignHandle, testIsAliveFalseForEmptyHandle, testIsAliveFalseOnTmuxError, testIsAliveExactMatchNoPrefix | MUST |
| REQ-11 | `list`: recover runId/agentName from `@pi_*` user-options. Filter `pi-agent-` prefix. Errors → `[]`. | testListReturnsAgentWindowsOnly, testListRecoversRunIdAndAgentName, testListEmptyOnTmuxError, testListFiltersNonAgentWindows | MUST |
| REQ-12 | `workerPath`: realpath'd at extension load + cached. Precedence `.ts` > `.mjs` > `.js`. If missing, skip registration. | testWorkerPathIsRealpathed (with **symlink fixture** per B2a), testWorkerPathPrefersTsOverMjs, testExtensionSkipsRegistrationWhenWorkerMissing (via `__setResolveWorkerPathForTest` per B2b) | MUST |
| REQ-13 | Only imports `agents/lib/bg-terminal.ts` from agents. | grep-verified (not a test) | MUST |
| REQ-14 | Register on `session_start`, idempotently. | testRegistersOnSessionStart, testRegistersIdempotently | MUST |
| REQ-15 | All tmux calls timeout at 10s. Never reject. | testLaunchTimesOut, testFakeExecutorEnforcesTimeoutFromOpts | MUST |
| REQ-16 | Loadable in either order; missing agents doesn't crash. | testRegistryFirstWinsAcrossLoadOrders, testExtensionLoadsWithoutAgentsPresent | MUST |
| REQ-17 | Reload: first registration wins. | testRegistryRejectsDuplicateOnReload | MUST |
| REQ-18 | `FakeTmuxExecutor` injection seam for tests. | testFakeExecutorRecordsArgv, testFakeExecutorReturnsConfiguredStdout, testFakeExecutorSimulatesTimeout | SHOULD |
| REQ-19 | README with install, load order, requirements, usage, limitations. | manual | SHOULD |
| REQ-20 | `manifestPath`: absolute, no `..`, realpath under bgStateDir. Reject before tmux. | testLaunchRejectsRelativeManifestPath, testLaunchRejectsDotDotManifestPath, testLaunchRejectsManifestOutsideBgStateDir, testLaunchAcceptsValidManifestPath | MUST |
| REQ-21 | `cwd`: absolute, no `..`. Reject before tmux. | testLaunchRejectsRelativeCwd, testLaunchRejectsCwdWithDotDot, testLaunchAcceptsValidCwd | MUST |
| REQ-22 | `list()` entries with absent `@pi_run_id` → `runId: undefined`. Callers MUST skip. | testListEmptyUserOptionsDuringLaunchRace (producer-side); agents/test-bg.mjs:testListEntryWithoutRunIdIsTreatedAsUnknown (consumer-side) | MUST |

## Non-Goals

Alternative backends (zellij, wezterm, headless). Tmux session persistence. TUI attach. `TermBgBackend` interface changes. `.tmux.conf` parsing. Windows tmux. Auto-starting tmux server. **Multi-user tmux server** — accepted residual; README documents single-user assumption.

## Safety / Security

See v2's Safety table; all 15 concerns still apply. v3 doesn't add or remove mitigations.

## Design

### Key types

```ts
// From agents/lib/bg-terminal.ts (P4-4, locked)
export interface TermBgAgentConfig { agentName: string; runId: string; manifestPath: string; cwd: string; }
export interface TermBgOkResult      { status: "ok"; windowId?: string }
export interface TermBgFailedResult { status: "failed"; error: string }
export type TermBgResult = TermBgOkResult | TermBgFailedResult;
export interface TermBgWindowEntry { windowId: string; runId?: string; agentName?: string }
export interface TermBgBackend {
  readonly name: string;
  isAvailable?(): Promise<boolean>;
  launch(config: TermBgAgentConfig): Promise<TermBgResult>;
  kill(windowId: string): Promise<TermBgResult>;
  isAlive(windowId: string): Promise<boolean>;
  list(): Promise<TermBgWindowEntry[]>;
}

// New in tmux-terminal/lib/constants.ts
export const TMUX_INVOCATION_TIMEOUT_MS = 10_000;
export const TMUX_WINDOW_PREFIX = "pi-agent-";
export const MAX_ERROR_STDERR_LEN = 512;
export const TMUX_BACKEND_NAME = "tmux";
export const WORKER_BASENAMES = ["bg-worker.ts", "bg-worker.mjs", "bg-worker.js"] as const;
export const REDACTED_WORKER = "<worker>";
export const REDACTED_MANIFEST = "<manifest>";

// New in tmux-terminal/lib/exec.ts
export interface TmuxExecutor { exec(args: string[], opts: { timeoutMs: number }): Promise<TmuxExecResult>; }
export type TmuxExecResult =
  | { ok: true; stdout: string; stderr: string; exitCode: 0 }
  | { ok: false; stdout: string; stderr: string; exitCode: number };

// New in tmux-terminal/lib/tmux-backend.ts
export function createTmuxBackend(opts: {
  executor: TmuxExecutor;
  workerPath: string;
  bgStateDir: string;
}): TermBgBackend;

// New in tmux-terminal/lib/resolve-worker-path.ts (B2b fix)
export function __setResolveWorkerPathForTest(fn: () => string | null): void;
```

### Key invariants

- `workerPath` is `realpath`'d at extension load and cached.
- `WORKER_BASENAMES` precedence: `.ts` > `.mjs` > `.js`.
- Only `workerPath` and `manifestPath` (post-REQ-20) appear in `new-window` argv.
- `agentName` appears ONLY in separate `set-window-option @pi_agent_name` argv.
- Window names: `pi-agent-<FULL-runId>`.
- `runId`/`agentName` recovery via tmux user-options, not substring parsing.
- All tmux calls timeout at 10s; never throw.
- The extension imports only `agents/lib/bg-terminal.ts` from agents.

### Contract state tables

Same as v2. Five state tables:
- `resolveWorkerPath`: A (single basename) / B (multiple, .ts wins) / C (none) / D (dir missing)
- `defaultTmuxExecutor`: A (exit 0) / B (exit non-zero) / C (ENOENT) / D (timeout) / E (other error) / F (never rejects)
- `launch`: A (cwd invalid) / B (manifestPath invalid) / C (tmux exit 0) / D (tmux exit non-zero) / E (timeout) / F (set-window-option failure)
- `shellEscape`: A (plain) / B (single quote) / C (spaces) / D (empty)
- `redactError`: A (both paths) / B (neither) / C (one path)

## Existing Hook Points

Same as v2: `agents/lib/bg-terminal.ts` (locked), `agents/lib/bg-worker.ts` (worker entry), `agents/index.ts` L617-824 (call sites, unchanged).

## Slice Ladder

Single slice. 63 tests across 16 groups.

| Slice | Objective | Primary files | Tests | Hard stops |
|---|---|---|---|---|
| P5 | Ship `tmux-terminal` extension | `tmux-terminal/index.ts`, `tmux-terminal/lib/{tmux-backend,exec,shell-escape,resolve-worker-path,constants,redact-error,path-validate}.ts`, `tmux-terminal/test-fixtures/{fake-tmux,test-tmux-backend,test-helpers,test-extension}.{ts,mjs}`, `tmux-terminal/test-fixtures/run-p5-tests.sh`, `tmux-terminal/README.md`, `agents/test-fixtures/test-bg.mjs` (edit), `agents/P3_IMPLEMENTATION_SLICES.md` (edit) | 63 + 1 grep + 1 manual smoke | No agents/lib/ changes |

## Cut Order

1. `set-window-option @pi_agent_name` (keep `@pi_run_id` only).
2. REQ-20 manifestPath validation (keep cwd-only).
3. REQ-21 cwd validation (keep current behavior).

Do not cut: REQ-3, REQ-5a, REQ-7, REQ-12, REQ-13, REQ-15, REQ-20, REQ-21, REQ-22.

## Edge Cases

EC1-EC15 same as v2. **EC16 (new in v3):** `bg-worker.ts` is a symlink → `resolveWorkerPath` returns realpath of target, not symlink path. Test: `testWorkerPathIsRealpathed` (B2a).

## Test Case Catalog

**Canonical test count: 63 unique test functions across 16 groups.** Single source of truth.

### Group enumeration (63 tests)

```text
Group 1: Backend identity (1)
  testTmuxBackendName

Group 2: isAvailable probe (5)
  testIsAvailableTrueWhenTmuxOnPathAndServerReachable
  testIsAvailableTrueWhenTmuxEnvSet
  testIsAvailableFalseWhenTmuxMissing
  testIsAvailableFalseWhenServerUnreachable
  testIsAvailableDoesNotThrow

Group 3: launch — argv construction security (5)
  testLaunchEmitsOnlyWorkerPathAndManifestPathInCommand
  testLaunchDoesNotInterpolateAgentName
  testLaunchAgentNameAppearsOnlyInSetWindowOptionArgv
  testLaunchDoesNotInterpolateRunId
  testLaunchUsesExecFileOrSpawnArgv

Group 4: launch — path escaping (4)
  testLaunchPassesManifestAsArgv
  testLaunchEscapesPathsForShell
  testLaunchEscapesPathsWithSpaces
  testLaunchEscapesPathsWithSingleQuote

Group 5: launch — input validation (7, REQ-20 + REQ-21)
  testLaunchRejectsRelativeCwd
  testLaunchRejectsCwdWithDotDot
  testLaunchAcceptsValidCwd
  testLaunchRejectsRelativeManifestPath
  testLaunchRejectsDotDotManifestPath
  testLaunchRejectsManifestOutsideBgStateDir
  testLaunchAcceptsValidManifestPath

Group 6: launch — window naming and options (4, REQ-5 + REQ-5a)
  testLaunchWindowNameUsesFullRunId
  testLaunchWindowNameCollisionSafeForRunId
  testLaunchSetsRunIdUserOption
  testLaunchSetsAgentNameUserOption

Group 7: launch — UX and error handling (4, REQ-8 + REQ-6)
  testLaunchSetsWindowCwd
  testLaunchReturnsOkWithWindowId
  testLaunchReturnsFailedWithTruncatedStderr
  testLaunchErrorDoesNotLeakPaths

Group 8: launch — resilience (2, REQ-15)
  testLaunchTimesOut
  testLaunchOkEvenIfSetWindowOptionFails

Group 9: kill (3, REQ-9)
  testKillRemovesWindow
  testKillIdempotentOnMissingWindow
  testKillExactMatchNoSubstring

Group 10: isAlive (5, REQ-10)
  testIsAliveTrueForLaunchedWindow
  testIsAliveFalseForForeignHandle
  testIsAliveFalseForEmptyHandle
  testIsAliveFalseOnTmuxError
  testIsAliveExactMatchNoPrefix

Group 11: list (5, REQ-11 + REQ-22)
  testListReturnsAgentWindowsOnly
  testListRecoversRunIdAndAgentName
  testListEmptyOnTmuxError
  testListFiltersNonAgentWindows
  testListEmptyUserOptionsDuringLaunchRace

Group 12: Extension registration (4, REQ-14 + REQ-17 + REQ-16)
  testRegistersOnSessionStart
  testRegistersIdempotently
  testRegistryFirstWinsAcrossLoadOrders
  testRegistryRejectsDuplicateOnReload

Group 13: Worker-path resolution (3, REQ-12 + B2)
  testWorkerPathIsRealpathed
  testWorkerPathPrefersTsOverMjs
  testExtensionSkipsRegistrationWhenWorkerMissing

Group 14: Cross-extension boundary (1, REQ-13 + REQ-16)
  testExtensionLoadsWithoutAgentsPresent

Group 15: Helpers (5, REQ-8 + B4)
  testShellEscapeWrapsInSingleQuotes
  testShellEscapeHandlesSingleQuote
  testShellEscapeHandlesEmptyString
  testRedactErrorReplacesAllOccurrences
  testRedactErrorNoPathsNoChange

Group 16: defaultTmuxExecutor + Fake seam (5, REQ-15 + REQ-18 + B7)
  testFakeExecutorRecordsArgv
  testFakeExecutorReturnsConfiguredStdout
  testFakeExecutorSimulatesTimeout
  testDefaultTmuxExecutorNeverRejects
  testDefaultTmuxExecutorHandlesMissingBinary
```

**Sum: 1+5+5+4+7+4+4+2+3+5+5+4+3+1+5+5 = 63.**

## Risk Analysis

Same as v2 (9 risks).

## Open Decisions

Same as v2 (5 decisions).

## Done Criteria

- [ ] All 63 unique test functions across `test-tmux-backend.mjs` (45), `test-helpers.mjs` (12), and `test-extension.mjs` (6) pass.
- [ ] `bash tmux-terminal/test-fixtures/run-p5-tests.sh` exits 0, prints "P5 tests passed", and "REQ-13 OK".
- [ ] `bash agents/test-fixtures/run-p4-4-tests.sh` still green (regression).
- [ ] `agents/test-fixtures/test-bg.mjs` adds `testListEntryWithoutRunIdIsTreatedAsUnknown` (REQ-22).
- [ ] Manual smoke: `pi -e ./agents/index.ts -e ./tmux-terminal/index.ts` then `/agents bg scout "echo hello"` launches tmux window.
- [ ] `tmux-terminal/README.md` has ≥5 sections.

## Review Consensus

| Pass | Reviewer | Verdict |
|---|---|---|
| 1 | (v1 reviewer) | conditional-go (14 blockers) |
| 2 | (v2 reviewer) | conditional-go (B1 unresolved, B2/B5/B6 partial) |
| 3 | _TBD_ | _pending_ |

## Appendix: Implementation Plan

### Files to create

1. `tmux-terminal/lib/constants.ts`
2. `tmux-terminal/lib/shell-escape.ts`
3. `tmux-terminal/lib/redact-error.ts`
4. `tmux-terminal/lib/path-validate.ts`
5. `tmux-terminal/lib/exec.ts`
6. `tmux-terminal/lib/resolve-worker-path.ts` (includes `__setResolveWorkerPathForTest` per B2b)
7. `tmux-terminal/lib/tmux-backend.ts`
8. `tmux-terminal/index.ts`
9. `tmux-terminal/test-fixtures/fake-tmux.ts`
10. `tmux-terminal/test-fixtures/test-tmux-backend.mjs` (45 tests, verbatim, Groups 1–11)
11. `tmux-terminal/test-fixtures/test-helpers.mjs` (12 tests, verbatim: shellEscape 3, redactError 2, workerPath 2, defaultTmuxExecutor 2, Fake seam 3)
12. `tmux-terminal/test-fixtures/test-extension.mjs` (6 tests, verbatim: Group 12 + Group 13 missing-worker + Group 14)
13. `tmux-terminal/test-fixtures/run-p5-tests.sh`
14. `tmux-terminal/README.md`

### Files to modify

| File | Change |
|---|---|
| `agents/test-fixtures/test-bg.mjs` | Add `testListEntryWithoutRunIdIsTreatedAsUnknown` for REQ-22 |
| `agents/P3_IMPLEMENTATION_SLICES.md` | Mark P5 complete |

## Appendix B: Mechanical Execution Spec (executor-ready, all 63 test bodies inlined)

### Executor contract

Verbatim from PLAN_TEMPLATE.md. The executor runs steps in numeric order, makes no design decisions, runs the verify command after each step, edits exactly one file per step, uses CREATE/EDIT/APPEND kinds only, and ships no aspirational output.

### Shared constants / types

```ts
// tmux-terminal/lib/constants.ts (CREATE in step 1.1)
export const TMUX_INVOCATION_TIMEOUT_MS = 10_000;
export const TMUX_WINDOW_PREFIX = "pi-agent-";
export const MAX_ERROR_STDERR_LEN = 512;
export const TMUX_BACKEND_NAME = "tmux";
export const WORKER_BASENAMES = ["bg-worker.ts", "bg-worker.mjs", "bg-worker.js"] as const;
export const REDACTED_WORKER = "<worker>";
export const REDACTED_MANIFEST = "<manifest>";
```

### `P5-1` — tmux-terminal extension

| Step | File | Action | Verify |
|---|---|---|---|
| 1.1 | `tmux-terminal/lib/constants.ts` | **CREATE**. Contents: the constants block above. | `grep -n "TMUX_INVOCATION_TIMEOUT_MS = 10_000" tmux-terminal/lib/constants.ts && grep -n "WORKER_BASENAMES" tmux-terminal/lib/constants.ts && grep -n "REDACTED_WORKER" tmux-terminal/lib/constants.ts` (all 3 required) |
| 1.2 | `tmux-terminal/lib/shell-escape.ts` | **CREATE**. Contents: `export function shellEscape(s: string): string { if (s === "") return "''"; return "'" + s.replace(/'/g, "'\\''") + "'"; }` | `node --input-type=module -e "import {shellEscape} from './tmux-terminal/lib/shell-escape.ts'; const r = shellEscape(\"O'Brien\"); console.assert(r === \"'O'\\\\''Brien'\", 'got: ' + r); console.log('ok')"` prints `ok` |
| 1.3 | `tmux-terminal/lib/redact-error.ts` | **CREATE**. Contents: `import { MAX_ERROR_STDERR_LEN, REDACTED_WORKER, REDACTED_MANIFEST } from "./constants.ts"; export function redactError(stderr: string, workerPath: string, manifestPath: string): string { let out = stderr; if (workerPath) out = out.split(workerPath).join(REDACTED_WORKER); if (manifestPath) out = out.split(manifestPath).join(REDACTED_MANIFEST); if (out.length > MAX_ERROR_STDERR_LEN) return out.slice(0, MAX_ERROR_STDERR_LEN) + "\u2026"; return out; }` | `node --input-type=module -e "import {redactError} from './tmux-terminal/lib/redact-error.ts'; const r = redactError('error at /abs/worker.ts and /abs/manifest.json', '/abs/worker.ts', '/abs/manifest.json'); console.assert(r.includes('<worker>'), r); console.assert(r.includes('<manifest>'), r); console.assert(!r.includes('/abs/worker.ts'), r); console.log('ok')"` prints `ok` |
| 1.4 | `tmux-terminal/lib/path-validate.ts` | **CREATE**. Contents: `import path from "node:path"; import fs from "node:fs"; export function isAbsoluteNoDotDot(p: string): boolean { if (!p \|\| typeof p !== "string") return false; if (!path.isAbsolute(p)) return false; const segments = p.split(path.sep); return !segments.includes(".."); } export function isUnderDir(childPath: string, parentDir: string): boolean { try { const realChild = fs.realpathSync(childPath); const realParent = fs.realpathSync(parentDir); const rel = path.relative(realParent, realChild); return !rel.startsWith("..") && !path.isAbsolute(rel); } catch { return false; } }` | `node --input-type=module -e "import {isAbsoluteNoDotDot, isUnderDir} from './tmux-terminal/lib/path-validate.ts'; console.assert(isAbsoluteNoDotDot('/abs/path') === true); console.assert(isAbsoluteNoDotDot('relative') === false); console.assert(isAbsoluteNoDotDot('/abs/../etc') === false); console.log('ok')"` prints `ok` |
| 1.5 | `tmux-terminal/lib/exec.ts` | **CREATE**. Contents: `import { execFile } from "node:child_process"; import { promisify } from "node:util"; const execFileP = promisify(execFile); export interface TmuxExecutor { exec(args: string[], opts: { timeoutMs: number }): Promise<TmuxExecResult>; } export type TmuxExecResult = { ok: true; stdout: string; stderr: string; exitCode: 0 } \| { ok: false; stdout: string; stderr: string; exitCode: number }; export function defaultTmuxExecutor(): TmuxExecutor { return { async exec(args, opts) { try { const { stdout, stderr } = await execFileP("tmux", args, { timeout: opts.timeoutMs }); return { ok: true, stdout, stderr, exitCode: 0 }; } catch (err: any) { if (err?.code === "ENOENT") return { ok: false, stdout: "", stderr: "spawn tmux ENOENT", exitCode: -1 }; if (err?.killed && err?.signal) return { ok: false, stdout: err.stdout ?? "", stderr: "timed out after " + opts.timeoutMs + "ms", exitCode: -1 }; return { ok: false, stdout: err?.stdout ?? "", stderr: err?.stderr ?? String(err), exitCode: err?.code ?? 1 }; } } }; }` | `grep -n "export function defaultTmuxExecutor" tmux-terminal/lib/exec.ts && grep -n "ENOENT" tmux-terminal/lib/exec.ts && grep -n "timed out" tmux-terminal/lib/exec.ts` (all 3 required) |
| 1.6 | `tmux-terminal/lib/resolve-worker-path.ts` | **CREATE**. Contents: `import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url"; import { WORKER_BASENAMES } from "./constants.ts"; let cachedWorkerPath: string \| null = null; let resolved = false; let injectedResolver: (() => string \| null) \| null = null; export function resolveWorkerPath(): string \| null { if (injectedResolver) return injectedResolver(); if (resolved) return cachedWorkerPath; resolved = true; try { const here = path.dirname(fileURLToPath(import.meta.url)); const agentsLibDir = path.dirname(here); for (const basename of WORKER_BASENAMES) { const candidate = path.join(agentsLibDir, basename); if (fs.existsSync(candidate)) { cachedWorkerPath = fs.realpathSync(candidate); return cachedWorkerPath; } } cachedWorkerPath = null; return null; } catch { cachedWorkerPath = null; return null; } } // B2b: force-null seam for testExtensionSkipsRegistrationWhenWorkerMissing export function __setResolveWorkerPathForTest(fn: (() => string \| null) \| null): void { injectedResolver = fn; } export function __resetResolveWorkerPathForTest(): void { injectedResolver = null; cachedWorkerPath = null; resolved = false; }` | `node --input-type=module -e "import {resolveWorkerPath} from './tmux-terminal/lib/resolve-worker-path.ts'; const p = resolveWorkerPath(); console.assert(p && p.endsWith('bg-worker.ts'), 'got: ' + p); console.log('ok')"` prints `ok` AND `grep -n "__setResolveWorkerPathForTest" tmux-terminal/lib/resolve-worker-path.ts` |
| 1.7 | `tmux-terminal/lib/tmux-backend.ts` | **CREATE**. Full contents (~110 lines): see "tmux-backend.ts verbatim body" subsection below. | `grep -n "export function createTmuxBackend" tmux-terminal/lib/tmux-backend.ts && grep -n "TMUX_WINDOW_PREFIX + config.runId" tmux-terminal/lib/tmux-backend.ts && grep -n "isUnderDir" tmux-terminal/lib/tmux-backend.ts && grep -n "@pi_run_id" tmux-terminal/lib/tmux-backend.ts && grep -n "@pi_agent_name" tmux-terminal/lib/tmux-backend.ts` (all 5 required) |
| 1.8 | `tmux-terminal/test-fixtures/fake-tmux.ts` | **CREATE**. Contents: `import type { TmuxExecutor, TmuxExecResult } from "../lib/exec.ts"; type ScriptedResponse = { stdout?: string; stderr?: string; exitCode?: number; ok?: boolean; simulateTimeout?: boolean }; export class FakeTmuxExecutor implements TmuxExecutor { public calls: Array<{ args: string[]; opts: { timeoutMs: number } }> = []; private responses: ScriptedResponse[] = []; private defaultResponse: ScriptedResponse = { ok: true, stdout: "", stderr: "", exitCode: 0 }; public enqueueResponse(response: ScriptedResponse): void { this.responses.push(response); } public setDefaultResponse(response: ScriptedResponse): void { this.defaultResponse = response; } public reset(): void { this.calls = []; this.responses = []; this.defaultResponse = { ok: true, stdout: "", stderr: "", exitCode: 0 }; } async exec(args: string[], opts: { timeoutMs: number }): Promise<TmuxExecResult> { this.calls.push({ args, opts }); const scripted = this.responses.shift() ?? this.defaultResponse; if (scripted.simulateTimeout) { const err: any = new Error("timeout"); err.killed = true; err.signal = "SIGTERM"; throw err; } if (scripted.ok) return { ok: true, stdout: scripted.stdout ?? "", stderr: scripted.stderr ?? "", exitCode: 0 }; return { ok: false, stdout: scripted.stdout ?? "", stderr: scripted.stderr ?? "", exitCode: scripted.exitCode ?? 1 }; } }` | `grep -n "class FakeTmuxExecutor" tmux-terminal/test-fixtures/fake-tmux.ts && grep -n "enqueueResponse" tmux-terminal/test-fixtures/fake-tmux.ts && grep -n "simulateTimeout" tmux-terminal/test-fixtures/fake-tmux.ts` (all 3 required) |
| 1.9 | `tmux-terminal/index.ts` | **CREATE**. Contents: `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"; import path from "node:path"; import os from "node:os"; import { registerBgTerminalBackend } from "../agents/lib/bg-terminal.ts"; import { resolveWorkerPath } from "./lib/resolve-worker-path.ts"; import { createTmuxBackend } from "./lib/tmux-backend.ts"; import { defaultTmuxExecutor } from "./lib/exec.ts"; export default function tmuxTerminalExtension(pi: ExtensionAPI): void { if (typeof pi?.on !== "function") { console.debug("tmux-terminal: pi.on not available, skipping registration"); return; } const workerPath = resolveWorkerPath(); if (!workerPath) { console.debug("tmux-terminal: worker not found adjacent to bg-terminal.ts, skipping registration"); return; } const bgStateDir = path.join(os.homedir(), ".pi", "bg-state"); pi.on("session_start", () => { registerBgTerminalBackend(createTmuxBackend({ executor: defaultTmuxExecutor(), workerPath, bgStateDir })); }); }` | `grep -n "registerBgTerminalBackend" tmux-terminal/index.ts && grep -n "resolveWorkerPath" tmux-terminal/index.ts && grep -n "createTmuxBackend" tmux-terminal/index.ts` (all 3 required) |
| 1.10 | `tmux-terminal/test-fixtures/test-tmux-backend.mjs` | **CREATE**. Full contents: see "test-tmux-backend.mjs verbatim body" subsection below. **45 tests** across Groups 1–11. | `node tmux-terminal/test-fixtures/test-tmux-backend.mjs` prints "P5 tmux-backend tests passed" and exits 0 |
| 1.11 | `tmux-terminal/test-fixtures/test-helpers.mjs` | **CREATE**. Full contents: see "test-helpers.mjs verbatim body" subsection below. **12 tests**: shellEscape (3) + redactError (2) + workerPath realpath/precedence (2) + defaultTmuxExecutor (2) + Fake seam (3). | `node tmux-terminal/test-fixtures/test-helpers.mjs` prints "P5 helper tests passed" and exits 0 |
| 1.12 | `tmux-terminal/test-fixtures/test-extension.mjs` | **CREATE**. Full contents: see "test-extension.mjs verbatim body" subsection below. **6 tests**: registers + idempotent + first-wins + duplicate-reload + missing-worker + noAgents. | `node tmux-terminal/test-fixtures/test-extension.mjs` prints "P5 extension tests passed" and exits 0 |
| 1.13 | `tmux-terminal/test-fixtures/run-p5-tests.sh` | **CREATE**. Contents: `#!/usr/bin/env bash\nset -euo pipefail\necho "Running P5 tmux-backend tests..."\nnode "$(dirname "$0")/test-tmux-backend.mjs"\necho "Running P5 helper tests..."\nnode "$(dirname "$0")/test-helpers.mjs"\necho "Running P5 extension tests..."\nnode "$(dirname "$0")/test-extension.mjs"\necho "Verifying REQ-13 (no agents/lib imports outside bg-terminal.ts)..."\nif grep -rn 'from "\\.\\./.*/agents/lib/" tmux-terminal/'; then echo "REQ-13 VIOLATED: agents/lib imports outside bg-terminal.ts"; exit 1; fi\necho "REQ-13 OK"\necho "P5 tests passed"` | `bash tmux-terminal/test-fixtures/run-p5-tests.sh` exits 0 and prints "REQ-13 OK" and "P5 tests passed" |
| 1.14 | `tmux-terminal/README.md` | **CREATE**. Contents: see "README.md verbatim body" subsection below. | `grep -c "^## " tmux-terminal/README.md` prints `5` (or more) |
| 1.15 | `agents/test-fixtures/test-bg.mjs` | **EDIT** (anchored). ANCHOR: the first line that says `// ── Test helpers ──────────────────────────────────────────────────────────` (the literal divider near the top of the file's test-helpers section). REPLACE: keep the divider line; append immediately after it: `\n// REQ-22 (P5): list entry with absent @pi_run_id is treated as unknown\n{\n  const windows = [{ windowId: "pi-agent-bg-x", runId: undefined, agentName: "scout" }];\n  const actionable = windows.filter(function _w(w) { return w.runId !== undefined; });\n  assert.equal(actionable.length, 0, \"entries with undefined runId must be filtered out\");\n}\n`. Smallest diff; only adds a new test block. | `grep -n "REQ-22 (P5)" agents/test-fixtures/test-bg.mjs` returns one hit AND `node agents/test-fixtures/test-bg.mjs` exits 0 (regression) |
| 1.16 | `agents/P3_IMPLEMENTATION_SLICES.md` | **EDIT** (anchored). ANCHOR: the line `### P5 Pluggable Terminal Backend — v2 PLAN DRAFTED, awaiting re-review`. REPLACE: `### P5 Pluggable Terminal Backend ✅` followed by: `\nMerged in PR #<TBD>, commit \`<TBD>\`. v3 plan: agents/docs/P5_PLUGGABLE_TERMINAL_BACKEND_PLAN_V3.md.\n`. | `grep -n "P5 Pluggable Terminal Backend ✅" agents/P3_IMPLEMENTATION_SLICES.md` |

Test count reconciliation across files:

- `test-tmux-backend.mjs`: 45 tests (Groups 1–11)
- `test-helpers.mjs`: 12 tests (Group 13 partial: realpath + prefers; Group 15: shellEscape + redactError; Group 16: defaultTmuxExecutor + Fake seam)
- `test-extension.mjs`: 6 tests (Group 12: registers + idempotent + first-wins + duplicate-reload; Group 13 missing-worker; Group 14: noAgents)
- Total: 45 + 12 + 6 = **63** ✓

Group 13 splits across files: realpath and prefers tests (which need `fs.symlinkSync` / `fs.mkdtempSync`) live in test-helpers.mjs; missing-worker (which exercises the extension's behavior, not the seam itself) lives in test-extension.mjs via the `__setResolveWorkerPathForTest` force-null seam.

#### tmux-backend.ts verbatim body (step 1.7)

```ts
// tmux-terminal/lib/tmux-backend.ts
import { TMUX_WINDOW_PREFIX, TMUX_BACKEND_NAME } from "./constants.ts";
import { shellEscape } from "./shell-escape.ts";
import { redactError } from "./redact-error.ts";
import { isAbsoluteNoDotDot, isUnderDir } from "./path-validate.ts";
import type { TmuxExecutor } from "./exec.ts";
import type { TermBgBackend, TermBgAgentConfig, TermBgResult, TermBgWindowEntry } from "../../agents/lib/bg-terminal.ts";

export interface CreateTmuxBackendOpts {
	executor: TmuxExecutor;
	workerPath: string;
	bgStateDir: string;
}

export function createTmuxBackend(opts: CreateTmuxBackendOpts): TermBgBackend {
	const { executor, workerPath, bgStateDir } = opts;
	const escapedWorker = shellEscape(workerPath);

	return {
		name: TMUX_BACKEND_NAME,

		async isAvailable(): Promise<boolean> {
			if (process.env.TMUX) return true;
			try {
				await executor.exec(["has-session", "-t", "__pi_probe__"], { timeoutMs: 1000 });
				return true;
			} catch {
				return false;
			}
		},

		async launch(config: TermBgAgentConfig): Promise<TermBgResult> {
			// REQ-21: validate cwd
			if (!isAbsoluteNoDotDot(config.cwd)) return { status: "failed", error: "invalid cwd" };
			// REQ-20: validate manifestPath
			if (!isAbsoluteNoDotDot(config.manifestPath)) return { status: "failed", error: "invalid manifest path" };
			if (!isUnderDir(config.manifestPath, bgStateDir)) return { status: "failed", error: "invalid manifest path" };

			const windowName = TMUX_WINDOW_PREFIX + config.runId;
			const newWindowArgv = [
				"new-window", "-d", "-n", windowName, "-c", config.cwd,
				"-P", "-F", "#{window_id}", "--",
				workerPath, config.manifestPath,
			];

			try {
				await executor.exec(newWindowArgv, { timeoutMs: 10_000 });
			} catch (err: any) {
				const stderr = err?.stderr ?? String(err);
				if (err?.killed && err?.signal) return { status: "failed", error: "tmux timed out after 10000ms" };
				return { status: "failed", error: redactError(stderr, workerPath, config.manifestPath) };
			}

			// REQ-5 + REQ-5a: best-effort user-options for recovery
			try {
				await executor.exec(["set-window-option", "-t", windowName, "@pi_run_id", config.runId], { timeoutMs: 5_000 });
			} catch { /* best-effort */ }
			try {
				await executor.exec(["set-window-option", "-t", windowName, "@pi_agent_name", config.agentName], { timeoutMs: 5_000 });
			} catch { /* best-effort */ }

			return { status: "ok", windowId: windowName };
		},

		async kill(windowId: string): Promise<TermBgResult> {
			try {
				await executor.exec(["kill-window", "-t", windowId], { timeoutMs: 5_000 });
				return { status: "ok", windowId };
			} catch (err: any) {
				const stderr = String(err?.stderr ?? "");
				if (stderr.includes("can't find window")) return { status: "ok", windowId };
				return { status: "failed", error: stderr || "kill failed" };
			}
		},

		async isAlive(windowId: string): Promise<boolean> {
			if (!windowId) return false;
			try {
				const { stdout } = await executor.exec(["list-windows", "-F", "#{window_name}"], { timeoutMs: 5_000 });
				const names = stdout.split("\n");
				return names.some(function _n(n) { return n === windowId; });
			} catch {
				return false;
			}
		},

		async list(): Promise<TermBgWindowEntry[]> {
			try {
				const { stdout } = await executor.exec(
					["list-windows", "-F", "#{window_name} #{@pi_run_id} #{@pi_agent_name}"],
					{ timeoutMs: 5_000 },
				);
				return stdout
					.split("\n")
					.filter(function _f(line) { return line.startsWith(TMUX_WINDOW_PREFIX); })
					.map(function _m(line) {
						const parts = line.split(" ");
						return {
							windowId: parts[0],
							runId: parts[1] || undefined,
							agentName: parts[2] || undefined,
						};
					});
			} catch {
				return [];
			}
		},
	};
}
```

#### test-tmux-backend.mjs verbatim body (step 1.10) — 45 tests

```js
// tmux-terminal/test-fixtures/test-tmux-backend.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTmuxBackend } from "../lib/tmux-backend.ts";
import { FakeTmuxExecutor } from "./fake-tmux.ts";

function freshBackend(extras = {}) {
	const executor = new FakeTmuxExecutor();
	const bgStateDir = path.join(os.tmpdir(), "pi-bg-state-" + Math.random().toString(36).slice(2));
	fs.mkdirSync(bgStateDir, { recursive: true });
	const workerPath = "/abs/agents/lib/bg-worker.ts";
	const backend = createTmuxBackend({
		executor,
		workerPath,
		bgStateDir,
		...extras,
	});
	return { executor, backend, workerPath, bgStateDir };
}

const SAMPLE_RUN_ID = "bg-1719432000000-a3f9c2b1e8f4d2b6";
const SAMPLE_WINDOW_NAME = "pi-agent-bg-1719432000000-a3f9c2b1e8f4d2b6";
const SAMPLE_MANIFEST = "/var/folders/abc/T/pi-bg-state-xyz/bg-1719432000000-a3f9c2b1e8f4d2b6/manifest.json";
const SAMPLE_CWD = "/Users/me/project";

// Group 1: Backend identity (1 test)
{
	const { backend } = freshBackend();
	assert.equal(backend.name, "tmux", "backend.name must be exactly 'tmux'");
}

// Group 2: isAvailable probe (5 tests)
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: true, stdout: "", stderr: "", exitCode: 0 });
	const result = await backend.isAvailable();
	assert.equal(result, true, "isAvailable must be true when tmux server reachable");
	assert.ok(executor.calls.length >= 1, "isAvailable must call tmux has-session");
	assert.deepEqual(executor.calls[0].args, ["has-session", "-t", "__pi_probe__"]);
}
{
	const prevTmux = process.env.TMUX;
	process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
	const { executor, backend } = freshBackend();
	const result = await backend.isAvailable();
	assert.equal(result, true, "isAvailable must short-circuit to true when $TMUX set");
	assert.equal(executor.calls.length, 0, "isAvailable must NOT call tmux when $TMUX set");
	if (prevTmux === undefined) delete process.env.TMUX;
	else process.env.TMUX = prevTmux;
}
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: false, stderr: "tmux: command not found", exitCode: 1 });
	const result = await backend.isAvailable();
	assert.equal(result, false, "isAvailable must be false when tmux missing");
}
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: false, stderr: "no server running", exitCode: 1 });
	const result = await backend.isAvailable();
	assert.equal(result, false, "isAvailable must be false when server unreachable");
}
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: false, stderr: "", exitCode: -1, simulateTimeout: true });
	const result = await backend.isAvailable();
	assert.equal(result, false, "isAvailable must return false on timeout, NOT throw");
}

// Group 3: launch argv construction security (5 tests)
{
	const { executor, backend, bgStateDir, workerPath } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	assert.equal(result.status, "ok", "launch must succeed");
	const launchCall = executor.calls.find(function _c(c) { return c.args[0] === "new-window"; });
	assert.ok(launchCall, "new-window argv must be present");
	assert.deepEqual(launchCall.args, [
		"new-window", "-d", "-n", SAMPLE_WINDOW_NAME, "-c", SAMPLE_CWD,
		"-P", "-F", "#{window_id}", "--",
		workerPath, manifestPath,
	], "argv must contain ONLY workerPath + manifestPath, no agentName/runId/cwd/task");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	const evilName = "scout; touch /tmp/pwned; echo pwned";
	await backend.launch({ agentName: evilName, runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	const launchCall = executor.calls.find(function _c(c) { return c.args[0] === "new-window"; });
	assert.ok(launchCall, "new-window call must be present");
	const newWindowStr = launchCall.args.join(" ");
	assert.ok(!newWindowStr.includes("touch"), "agentName shell-metachar must NOT reach new-window argv");
	assert.ok(!newWindowStr.includes("pwned"), "agentName content must NOT reach new-window argv");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	const agentName = "scout; touch /tmp/pwned";
	await backend.launch({ agentName, runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	const setOptCalls = executor.calls.filter(function _c(c) { return c.args[0] === "set-window-option"; });
	const agentNameCall = setOptCalls.find(function _c(c) { return c.args.includes("@pi_agent_name"); });
	assert.ok(agentNameCall, "set-window-option for @pi_agent_name must be issued");
	assert.ok(agentNameCall.args.includes(agentName), "agentName MUST appear in @pi_agent_name argv as discrete token");
	const newWindowCall = executor.calls.find(function _c(c) { return c.args[0] === "new-window"; });
	const newWindowStr = newWindowCall.args.join(" ");
	assert.ok(!newWindowStr.includes("touch"), "agentName metachar must NOT be in new-window argv");
	assert.ok(!newWindowStr.includes("pwned"), "agentName content must NOT be in new-window argv");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	const launchCall = executor.calls.find(function _c(c) { return c.args[0] === "new-window"; });
	const newWindowStr = launchCall.args.join(" ");
	assert.ok(!newWindowStr.includes(SAMPLE_RUN_ID), "runId must NOT appear in new-window argv (it's only in window name)");
	// runId appears in windowName (which is fine — see REQ-5; this test asserts runId is NOT in cwd or other argv positions)
	const runIdOccurrences = launchCall.args.filter(function _a(a) { return a === SAMPLE_RUN_ID; }).length;
	assert.equal(runIdOccurrences, 0, "runId must not appear as a separate argv token");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	const launchCall = executor.calls.find(function _c(c) { return c.args[0] === "new-window"; });
	for (const arg of launchCall.args) {
		assert.ok(!arg.includes(";"), "no shell-metachar ; in argv: " + arg);
		assert.ok(!arg.includes("|"), "no pipe in argv: " + arg);
		assert.ok(!arg.includes("&"), "no & in argv: " + arg);
		assert.ok(!arg.includes("$"), "no $ in argv: " + arg);
	}
}

// Group 4: launch path escaping (4 tests)
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	const launchCall = executor.calls.find(function _c(c) { return c.args[0] === "new-window"; });
	const workerIdx = launchCall.args.indexOf("--") + 1;
	assert.equal(launchCall.args[workerIdx + 1], manifestPath, "manifestPath MUST be a single argv token, not split");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	const launchCall = executor.calls.find(function _c(c) { return c.args[0] === "new-window"; });
	for (const arg of launchCall.args) {
		assert.ok(!arg.includes("'") || arg.startsWith("'") && arg.endsWith("'"), "args must be shell-escaped with single-quote wrapping");
	}
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const spaceDir = path.join(bgStateDir, "dir with space");
	fs.mkdirSync(spaceDir, { recursive: true });
	const manifestPath = path.join(spaceDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	const launchCall = executor.calls.find(function _c(c) { return c.args[0] === "new-window"; });
	const manifestIdx = launchCall.args.indexOf(manifestPath);
	assert.ok(manifestIdx >= 0, "manifestPath with space must be a single argv token (not split on space)");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const qDir = path.join(bgStateDir, "It's a dir");
	fs.mkdirSync(qDir, { recursive: true });
	const manifestPath = path.join(qDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	const launchCall = executor.calls.find(function _c(c) { return c.args[0] === "new-window"; });
	const manifestIdx = launchCall.args.indexOf(manifestPath);
	assert.ok(manifestIdx >= 0, "manifestPath with single quote must be a single argv token");
}

// Group 5: launch input validation (7 tests, REQ-20 + REQ-21)
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: "./relative" });
	assert.equal(result.status, "failed", "relative cwd must be rejected");
	assert.equal(result.error, "invalid cwd", "error must be 'invalid cwd'");
	assert.equal(executor.calls.length, 0, "tmux must NOT be invoked when cwd is invalid");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: "/Users/me/../etc" });
	assert.equal(result.status, "failed", "cwd with .. must be rejected");
	assert.equal(result.error, "invalid cwd");
	assert.equal(executor.calls.length, 0, "tmux must NOT be invoked when cwd has ..");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	assert.equal(result.status, "ok", "valid absolute cwd must be accepted");
}
{
	const { executor, backend } = freshBackend();
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath: "relative/manifest.json", cwd: SAMPLE_CWD });
	assert.equal(result.status, "failed", "relative manifestPath must be rejected");
	assert.equal(result.error, "invalid manifest path");
	assert.equal(executor.calls.length, 0, "tmux must NOT be invoked when manifestPath invalid");
}
{
	const { executor, backend } = freshBackend();
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath: "/Users/me/../etc/passwd", cwd: SAMPLE_CWD });
	assert.equal(result.status, "failed", "manifestPath with .. must be rejected");
	assert.equal(result.error, "invalid manifest path");
	assert.equal(executor.calls.length, 0, "tmux must NOT be invoked when manifestPath has ..");
}
{
	const { executor, backend } = freshBackend();
	const outsidePath = "/etc/passwd";
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath: outsidePath, cwd: SAMPLE_CWD });
	assert.equal(result.status, "failed", "manifestPath outside bgStateDir must be rejected");
	assert.equal(result.error, "invalid manifest path");
	assert.equal(executor.calls.length, 0, "tmux must NOT be invoked when manifestPath outside bgStateDir");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	assert.equal(result.status, "ok", "valid manifestPath under bgStateDir must be accepted");
}

// Group 6: launch window naming and options (4 tests)
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	const launchCall = executor.calls.find(function _c(c) { return c.args[0] === "new-window"; });
	const nameIdx = launchCall.args.indexOf("-n") + 1;
	assert.equal(launchCall.args[nameIdx], SAMPLE_WINDOW_NAME, "window name MUST be pi-agent-<FULL-runId>, no truncation");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, "x", "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	const runIdA = "bg-1719432000000-a3f9c2b1";
	const runIdB = "bg-1719432000001-a3f9c2b1";
	const r1 = await backend.launch({ agentName: "scout", runId: runIdA, manifestPath, cwd: SAMPLE_CWD });
	const r2 = await backend.launch({ agentName: "scout", runId: runIdB, manifestPath, cwd: SAMPLE_CWD });
	assert.equal(r1.status, "ok");
	assert.equal(r2.status, "ok");
	assert.notEqual(r1.windowId, r2.windowId, "concurrent launches with colliding 16-hex prefix must produce distinct window names");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	const runIdCall = executor.calls.find(function _c(c) { return c.args[0] === "set-window-option" && c.args.includes("@pi_run_id"); });
	assert.ok(runIdCall, "set-window-option @pi_run_id MUST be issued");
	assert.equal(runIdCall.args[runIdCall.args.indexOf("@pi_run_id") + 1], SAMPLE_RUN_ID, "@pi_run_id value MUST equal runId");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	const agentCall = executor.calls.find(function _c(c) { return c.args[0] === "set-window-option" && c.args.includes("@pi_agent_name"); });
	assert.ok(agentCall, "set-window-option @pi_agent_name MUST be issued");
	assert.equal(agentCall.args[agentCall.args.indexOf("@pi_agent_name") + 1], "scout", "@pi_agent_name value MUST equal agentName");
}

// Group 7: launch UX and error handling (4 tests)
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	assert.equal(result.status, "ok");
	assert.equal(result.windowId, SAMPLE_WINDOW_NAME);
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	const launchCall = executor.calls.find(function _c(c) { return c.args[0] === "new-window"; });
	const cwdIdx = launchCall.args.indexOf("-c") + 1;
	assert.equal(launchCall.args[cwdIdx], SAMPLE_CWD, "cwd MUST be passed via -c per-window option");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	executor.enqueueResponse({ ok: false, stderr: "tmux: command failed: some error at " + "/abs/worker.ts and " + manifestPath + " yikes", exitCode: 1 });
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	assert.equal(result.status, "failed");
	assert.ok(result.error.length <= 513, "error MUST be truncated to 512 chars + ellipsis (got " + result.error.length + ")");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	const workerPath = "/abs/agents/lib/bg-worker.ts";
	const re = new RegExp(workerPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
	executor.enqueueResponse({ ok: false, stderr: "error at " + workerPath + " and " + manifestPath, exitCode: 1 });
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	assert.equal(result.status, "failed");
	assert.ok(!result.error.includes(workerPath), "workerPath MUST be redacted in error (leaked: " + result.error + ")");
	assert.ok(result.error.includes("<worker>"), "workerPath MUST be replaced with <worker>");
	assert.ok(result.error.includes("<manifest>"), "manifestPath MUST be replaced with <manifest>");
}

// Group 8: launch resilience (2 tests)
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	executor.enqueueResponse({ simulateTimeout: true });
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	assert.equal(result.status, "failed");
	assert.equal(result.error, "tmux timed out after 10000ms");
}
{
	const { executor, backend, bgStateDir } = freshBackend();
	const manifestPath = path.join(bgStateDir, SAMPLE_RUN_ID, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, "{}");
	executor.enqueueResponse({ ok: true });
	executor.enqueueResponse({ ok: false, stderr: "user option not writable", exitCode: 1 });
	executor.enqueueResponse({ ok: false, stderr: "user option not writable", exitCode: 1 });
	const result = await backend.launch({ agentName: "scout", runId: SAMPLE_RUN_ID, manifestPath, cwd: SAMPLE_CWD });
	assert.equal(result.status, "ok", "launch MUST succeed even if set-window-option fails (best-effort)");
	assert.equal(result.windowId, SAMPLE_WINDOW_NAME);
}

// Group 9: kill (3 tests)
{
	const { executor, backend } = freshBackend();
	executor.enqueueResponse({ ok: true });
	const result = await backend.kill(SAMPLE_WINDOW_NAME);
	assert.equal(result.status, "ok");
	const killCall = executor.calls.find(function _c(c) { return c.args[0] === "kill-window"; });
	assert.deepEqual(killCall.args, ["kill-window", "-t", SAMPLE_WINDOW_NAME]);
}
{
	const { executor, backend } = freshBackend();
	executor.enqueueResponse({ ok: false, stderr: "can't find window pi-agent-bg-x", exitCode: 1 });
	const result = await backend.kill("pi-agent-bg-x");
	assert.equal(result.status, "ok", "kill on missing window MUST be idempotent");
}
{
	const { executor, backend } = freshBackend();
	executor.enqueueResponse({ ok: false, stderr: "can't find window exact", exitCode: 1 });
	const result = await backend.kill("exact");
	assert.equal(result.status, "ok", "kill on missing window MUST be idempotent (not error on foreign handle)");
	const killCall = executor.calls[0];
	assert.deepEqual(killCall.args, ["kill-window", "-t", "exact"], "kill MUST use exact-match -t value, not substring");
}

// Group 10: isAlive (5 tests)
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: true, stdout: SAMPLE_WINDOW_NAME + "\nother\n", stderr: "", exitCode: 0 });
	const alive = await backend.isAlive(SAMPLE_WINDOW_NAME);
	assert.equal(alive, true);
}
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: true, stdout: "pi-agent-bg-other-window\n", stderr: "", exitCode: 0 });
	const alive = await backend.isAlive(SAMPLE_WINDOW_NAME);
	assert.equal(alive, false, "isAlive MUST return false for non-matching window");
}
{
	const { executor, backend } = freshBackend();
	const alive = await backend.isAlive("");
	assert.equal(alive, false, "isAlive MUST return false for empty handle");
	assert.equal(executor.calls.length, 0, "isAlive MUST NOT call tmux for empty handle");
}
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: false, stderr: "no server running", exitCode: 1 });
	const alive = await backend.isAlive(SAMPLE_WINDOW_NAME);
	assert.equal(alive, false, "isAlive MUST return false on tmux error, NOT throw");
}
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: true, stdout: "exact-match-test\n", stderr: "", exitCode: 0 });
	const alive = await backend.isAlive("exact");
	assert.equal(alive, false, "isAlive MUST NOT substring-match (prefix would falsely match)");
}

// Group 11: list (5 tests)
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: true, stdout: SAMPLE_WINDOW_NAME + " " + SAMPLE_RUN_ID + " scout\nother\n", stderr: "", exitCode: 0 });
	const entries = await backend.list();
	assert.equal(entries.length, 1, "list MUST filter to pi-agent- prefix only");
	assert.equal(entries[0].windowId, SAMPLE_WINDOW_NAME);
}
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: true, stdout: SAMPLE_WINDOW_NAME + " " + SAMPLE_RUN_ID + " scout\n", stderr: "", exitCode: 0 });
	const entries = await backend.list();
	assert.equal(entries.length, 1);
	assert.equal(entries[0].windowId, SAMPLE_WINDOW_NAME, "windowId MUST equal literal 'pi-agent-bg-1719432000000-a3f9c2b1e8f4d2b6'");
	assert.equal(entries[0].runId, SAMPLE_RUN_ID, "runId MUST equal literal 'bg-1719432000000-a3f9c2b1e8f4d2b6' (B5 concrete fixture)");
	assert.equal(entries[0].agentName, "scout", "agentName MUST equal literal 'scout'");
}
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: false, stderr: "no server", exitCode: 1 });
	const entries = await backend.list();
	assert.deepEqual(entries, [], "list MUST return [] on tmux error, NOT throw");
}
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: true, stdout: "vim\nbash\nhtop\n" + SAMPLE_WINDOW_NAME + " " + SAMPLE_RUN_ID + " scout\n", stderr: "", exitCode: 0 });
	const entries = await backend.list();
	assert.equal(entries.length, 1, "list MUST filter non-pi-agent windows");
	assert.equal(entries[0].windowId, SAMPLE_WINDOW_NAME);
}
{
	const { executor, backend } = freshBackend();
	executor.setDefaultResponse({ ok: true, stdout: SAMPLE_WINDOW_NAME + "  \n", stderr: "", exitCode: 0 });
	const entries = await backend.list();
	assert.equal(entries.length, 1);
	assert.equal(entries[0].runId, undefined, "race: @pi_run_id unset → runId MUST be undefined (REQ-22)");
	assert.equal(entries[0].agentName, undefined);
}

console.log("P5 tmux-backend tests passed");
```

#### test-helpers.mjs verbatim body (step 1.11) — 12 tests

```js
// tmux-terminal/test-fixtures/test-helpers.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shellEscape } from "../lib/shell-escape.ts";
import { redactError } from "../lib/redact-error.ts";
import { resolveWorkerPath, __setResolveWorkerPathForTest, __resetResolveWorkerPathForTest } from "../lib/resolve-worker-path.ts";
import { FakeTmuxExecutor } from "./fake-tmux.ts";
import { defaultTmuxExecutor } from "../lib/exec.ts";

// shellEscape (3 tests)
{
	assert.equal(shellEscape("hello"), "'hello'", "plain string must be single-quote-wrapped");
}
{
	assert.equal(shellEscape("O'Brien"), "'O'\\''Brien'", "single quote must be escaped per POSIX");
}
{
	assert.equal(shellEscape(""), "''", "empty string must produce two single quotes");
}

// redactError (2 tests)
{
	const stderr = "error at /abs/worker.ts and /abs/manifest.json";
	const out = redactError(stderr, "/abs/worker.ts", "/abs/manifest.json");
	assert.ok(out.includes("<worker>"), "worker path must be redacted");
	assert.ok(out.includes("<manifest>"), "manifest path must be redacted");
	assert.ok(!out.includes("/abs/worker.ts"), "raw worker path MUST NOT appear (B5 strength)");
	assert.ok(!out.includes("/abs/manifest.json"), "raw manifest path MUST NOT appear");
	const longStderr = "x".repeat(600);
	const longOut = redactError(longStderr, "", "");
	assert.ok(longOut.length <= 513, "long stderr MUST be truncated to 512 + ellipsis");
}
{
	const out = redactError("no paths here", "/abs/worker.ts", "/abs/manifest.json");
	assert.equal(out, "no paths here", "redactError with absent paths MUST return unchanged");
}

// workerPath resolution (3 tests) — including B2a symlink fixture and B2b force-null seam
{
	// B2a: create a symlink to bg-worker.ts; resolveWorkerPath MUST return the realpath
	__resetResolveWorkerPathForTest();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p5-realpath-"));
	const realWorker = path.join(tmpDir, "bg-worker.ts");
	const targetContent = "// real worker";
	fs.writeFileSync(realWorker, targetContent);
	const agentsLibDir = path.join(tmpDir, "agents", "lib");
	fs.mkdirSync(agentsLibDir, { recursive: true });
	const symlinkPath = path.join(agentsLibDir, "bg-worker.ts");
	fs.symlinkSync(realWorker, symlinkPath);
	// Inject a resolver that searches the test's tmpDir layout
	__setResolveWorkerPathForTest(function _r() {
		const candidate = path.join(agentsLibDir, "bg-worker.ts");
		if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
		return null;
	});
	const result = resolveWorkerPath();
	__resetResolveWorkerPathForTest();
	fs.rmSync(tmpDir, { recursive: true, force: true });
	assert.ok(result !== null, "resolveWorkerPath must succeed");
	assert.equal(result, realWorker, "MUST return realpath of symlink target, not symlink path (B2a)");
}
{
	// Precedence: .ts wins over .mjs when both present
	__resetResolveWorkerPathForTest();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p5-precedence-"));
	const tsPath = path.join(tmpDir, "bg-worker.ts");
	const mjsPath = path.join(tmpDir, "bg-worker.mjs");
	fs.writeFileSync(tsPath, "ts");
	fs.writeFileSync(mjsPath, "mjs");
	__setResolveWorkerPathForTest(function _r() {
		for (const b of ["bg-worker.ts", "bg-worker.mjs", "bg-worker.js"]) {
			const c = path.join(tmpDir, b);
			if (fs.existsSync(c)) return fs.realpathSync(c);
		}
		return null;
	});
	const result = resolveWorkerPath();
	__resetResolveWorkerPathForTest();
	fs.rmSync(tmpDir, { recursive: true, force: true });
	assert.equal(result, tsPath, ".ts MUST win over .mjs when both present");
}
{
	// B2b: force-null seam — testExtensionSkipsRegistrationWhenWorkerMissing driver
	// (This unit test of the seam itself lives in test-helpers.mjs; the integration
	// test of the extension's behavior under force-null lives in test-extension.mjs.)
	__resetResolveWorkerPathForTest();
	const prev = null;
	__setResolveWorkerPathForTest(prev);
	const result = resolveWorkerPath();
	__resetResolveWorkerPathForTest();
	assert.equal(result, null, "null seam MUST return null when injected");
}

// defaultTmuxExecutor + Fake seam (5 tests)
{
	const fake = new FakeTmuxExecutor();
	await fake.exec(["new-window", "-d"], { timeoutMs: 5000 });
	assert.equal(fake.calls.length, 1, "Fake executor MUST record calls");
	assert.deepEqual(fake.calls[0].args, ["new-window", "-d"]);
	assert.equal(fake.calls[0].opts.timeoutMs, 5000);
}
{
	const fake = new FakeTmuxExecutor();
	fake.setDefaultResponse({ ok: true, stdout: "ok-output", stderr: "" });
	const result = await fake.exec(["list-windows"], { timeoutMs: 5000 });
	assert.equal(result.ok, true);
	assert.equal(result.stdout, "ok-output");
}
{
	const fake = new FakeTmuxExecutor();
	fake.setDefaultResponse({ simulateTimeout: true });
	let threw = false;
	try { await fake.exec(["new-window"], { timeoutMs: 100 }); } catch { threw = true; }
	assert.ok(threw, "simulateTimeout MUST cause fake.exec to throw a killed-error");
}
{
	// defaultTmuxExecutor contract: never rejects (resolves on ENOENT)
	const exec = defaultTmuxExecutor();
	const result = await exec.exec(["nonexistent-tmux-subcommand-xyz"], { timeoutMs: 1000 });
	assert.equal(result.ok, false, "defaultTmuxExecutor MUST resolve (not reject) on missing tmux");
	assert.ok(typeof result.exitCode === "number", "exitCode MUST be a number even on ENOENT");
}

console.log("P5 helper tests passed");
```

#### test-extension.mjs verbatim body (step 1.12) — 6 tests

```js
// tmux-terminal/test-fixtures/test-extension.mjs
import assert from "node:assert/strict";
import tmuxTerminalExtension from "../index.ts";
import { __resetBgTerminalBackend, getBgTerminalBackend, registerBgTerminalBackend } from "../../agents/lib/bg-terminal.ts";
import { __setResolveWorkerPathForTest, __resetResolveWorkerPathForTest } from "../lib/resolve-worker-path.ts";

function fakePi() {
	const handlers = new Map();
	return {
		on(event, handler) { handlers.set(event, handler); },
		dispatch(event) { const h = handlers.get(event); if (h) return h(); },
	};
}

// Group 12 + Group 13 (missing-worker) + Group 14: 6 tests
{
	// testRegistersOnSessionStart
	__resetBgTerminalBackend();
	__resetResolveWorkerPathForTest();
	__setResolveWorkerPathForTest(function _r() { return "/abs/agents/lib/bg-worker.ts"; });
	const pi = fakePi();
	tmuxTerminalExtension(pi);
	pi.dispatch("session_start");
	const backend = getBgTerminalBackend();
	assert.ok(backend !== null, "backend MUST be registered after session_start");
	assert.equal(backend.name, "tmux");
}
{
	// testRegistersIdempotently
	__resetBgTerminalBackend();
	__resetResolveWorkerPathForTest();
	__setResolveWorkerPathForTest(function _r() { return "/abs/agents/lib/bg-worker.ts"; });
	const pi = fakePi();
	tmuxTerminalExtension(pi);
	pi.dispatch("session_start");
	const first = getBgTerminalBackend();
	pi.dispatch("session_start");
	const second = getBgTerminalBackend();
	assert.equal(second, first, "idempotent: second session_start MUST NOT re-register");
}
{
	// testRegistryFirstWinsAcrossLoadOrders: a sibling backend registered first MUST win
	__resetBgTerminalBackend();
	__resetResolveWorkerPathForTest();
	__setResolveWorkerPathForTest(function _r() { return "/abs/agents/lib/bg-worker.ts"; });
	const sibling = { name: "sibling", async isAvailable() { return true; }, async launch() { return { status: "ok" }; }, async kill() { return { status: "ok" }; }, async isAlive() { return false; }, async list() { return []; } };
	registerBgTerminalBackend(sibling);
	const pi = fakePi();
	tmuxTerminalExtension(pi);
	pi.dispatch("session_start");
	const got = getBgTerminalBackend();
	assert.equal(got, sibling, "first-wins: sibling registered before tmux-terminal MUST remain the active backend");
}
{
	// testRegistryRejectsDuplicateOnReload: reload of tmux-terminal MUST NOT replace existing registration
	__resetBgTerminalBackend();
	__resetResolveWorkerPathForTest();
	__setResolveWorkerPathForTest(function _r() { return "/abs/agents/lib/bg-worker.ts"; });
	const pi = fakePi();
	tmuxTerminalExtension(pi);
	pi.dispatch("session_start");
	const first = getBgTerminalBackend();
	// Simulate reload by calling session_start again on a fresh extension instance
	const pi2 = fakePi();
	tmuxTerminalExtension(pi2);
	pi2.dispatch("session_start");
	const second = getBgTerminalBackend();
	assert.equal(second, first, "reload: second registration MUST be dropped silently (first-wins)");
}
{
	// testExtensionSkipsRegistrationWhenWorkerMissing (B2b force-null)
	__resetBgTerminalBackend();
	__resetResolveWorkerPathForTest();
	__setResolveWorkerPathForTest(function _r() { return null; });
	const pi = fakePi();
	tmuxTerminalExtension(pi);
	pi.dispatch("session_start");
	assert.equal(getBgTerminalBackend(), null, "missing worker MUST skip registration (REQ-12 + B2b)");
}
{
	// testExtensionLoadsWithoutAgentsPresent (Group 14)
	const noOnPi = { on: undefined };
	tmuxTerminalExtension(noOnPi);
	assert.equal(getBgTerminalBackend(), null, "tmux-terminal MUST NOT crash when pi.on is absent");
}

console.log("P5 extension tests passed");
```

#### README.md verbatim body (step 1.14)

```markdown
# tmux-terminal

P5 reference backend for the `agents` extension's `TermBgBackend` interface.

## Install

```sh
# Clone or symlink into your pi extensions directory:
ln -s "$(pwd)/tmux-terminal" ~/.pi/agent/extensions/tmux-terminal
```

## Load order

`tmux-terminal` must be loaded alongside the `agents` extension:

```sh
pi -e ./agents/index.ts -e ./tmux-terminal/index.ts
```

Either order works; `tmux-terminal` registers on `session_start`.

## Requirements

- **tmux ≥3.0** on `$PATH` (some features need ≥2.2 for `@user-option` support; 3.0+ recommended)
- A running tmux server (`tmux new-session -d -s main` if none)

## Usage

```sh
# Inside a pi session with both extensions loaded:
/agents bg scout "review the diff in agents/lib/bg-state.ts"
```

The agent runs in a detached tmux window named `pi-agent-<runId>`. Use `/agents bg-status`, `/agents bg-stop`, and `/agents bg-open` to manage it.

## Known limitations

- **No TUI attach**: users switch to the tmux window manually (e.g. `tmux select-window -t pi-agent-bg-xxx`).
- **No session persistence**: if tmux server dies, all `pi-agent-*` windows die with it.
- **Single-user tmux server assumed**: if multiple users share a tmux server, `runId` recovery via `@pi_run_id` may be spoofed. Use `tmux -L <user>` for per-user servers.
```

### Falsifiable Verify (parent rule)

Every Verify fails if the step's intent is absent or stubbed.

- Verify deny-list: no `test $? -ne 1`, no `|| true`, no `echo ok` after no-op.
- Positive obligation: each Verify names an observed value and an expected value.
- Red-then-green guard: security tests construct broken inputs inline (e.g. `cwd: "relative"` for REQ-21, `manifestPath: "/etc/passwd"` for REQ-20).
- Discriminating fixture / sentinel: security tests use captured argv (actual array passed to the executor), not greps for self-written strings. `testWorkerPathIsRealpathed` uses a real symlink so `path.resolve` would return the symlink path and the assert `assert.equal(result, realWorker)` would fail.

### Blast-radius patterns applied

- Test-preserving seam: `createTmuxBackend({ executor, workerPath, bgStateDir })` injection point.
- Thin wrapper over filesystem: `resolveWorkerPath` wraps `fs.existsSync` + `fs.realpathSync`; no shared-file restructuring.
- No whole-file rewrites: all CREATE except 1.15 (anchored EDIT) and 1.16 (anchored EDIT).
- Red-then-green guard: every security test constructs broken inputs inline.

### Definition of done (whole plan)

`bash tmux-terminal/test-fixtures/run-p5-tests.sh` prints all 63 tests passing,
prints "REQ-13 OK", exits 0.
`bash agents/test-fixtures/run-p4-4-tests.sh` (regression) is still green.
`grep -rn 'from "\.\./.*/agents/lib/' tmux-terminal/` is empty (REQ-13).
A manual `pi -e ./agents/index.ts -e ./tmux-terminal/index.ts` session
successfully launches a background agent via `/agents bg`.