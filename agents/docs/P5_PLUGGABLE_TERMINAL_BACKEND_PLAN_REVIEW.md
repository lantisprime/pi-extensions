# P5 Plan Review

## Review context

Plan reviewed: `agents/docs/P5_PLUGGABLE_TERMINAL_BACKEND_PLAN.md` (v1)
Reviewer: `claude-opus-4.5` via `pi --no-tools --model claude-opus-4.5`
Type: Plan review — structural completeness, contract exhaustiveness, test discrimination, executor-readiness
Related review: `agents/docs/P5_PLUGGABLE_TERMINAL_BACKEND_ADVERSARIAL_REVIEW.md` covers the security/threat-model lens separately.

## Blocking issues

### B1 — Test count and catalog mismatch

The plan claims "19 unique test names across 14 groups" and "42 named assertions across 19 test functions" (Test Case Catalog section, last paragraph), but earlier the same section lists 38 distinct test names (counting Group 4's 6 + Group 7's 5 individually). The Done Criteria say "19 MUST-row tests." The Mechanical Execution Spec step 1.8 says "17 test cases covering Groups 1-13." The summary table at the start of the catalog tally (1+1+4+6+6+2+4+5+4+4+2+2+3+1) sums to **45**, not 42 or 19 or 17.

**Required fix:** Pick one canonical number and ensure all four locations agree (Test Case Catalog header, Done Criteria, Appendix step 1.8 prose, and the per-group enumeration). The per-group enumeration is the source of truth. Remove the parenthetical "42 named assertions" line entirely or replace it with the actual summed count.

### B2 — Requirements ↔ Test Catalog mapping gaps

| REQ | Plan-test mapping | Catalog entry | Status |
|---|---|---|---|
| REQ-5 (window name format + user-option) | `testLaunchWindowNameFormat`, `testLaunchSetsRunIdUserOption`, `testLaunchWindowNameCollisionSafeForRunIdPrefixes` | All present in Group 4 | ✅ |
| REQ-6 (window cwd via `default-path`) | `testLaunchSetsWindowCwd` | Listed in Group 4 | ✅ |
| REQ-9 (kill exact-match contract) | `testKillExactMatchNoSubstring` | Listed in Group 6 | ✅ |
| REQ-10 (isAlive exact-match) | `testIsAliveExactMatchNoPrefix` | Listed in Group 7 | ✅ |
| REQ-11 (list window-name filter) | `testListFiltersNonAgentWindows` | Listed in Group 8 | ✅ |
| REQ-13 (no agents/lib imports except bg-terminal) | `testTmuxTerminalImportsOnlyBgTerminal` | Listed in Group 11 | ⚠️ See B3 |
| REQ-14 (session_start registration) | `testRegistersOnSessionStart` | Listed in Group 9 | ✅ |
| REQ-15 (timeouts) | 4 tests across launch/kill/isAlive/list | Listed across Groups 5, 6, 7, 8 | ✅ |
| REQ-18 (fake executor seam) | `testFakeExecutorRecordsArgv`, `testFakeExecutorReturnsConfiguredStdout`, `testFakeExecutorSimulatesTimeout` | Listed in Group 13 | ✅ |

**Gaps found:**
- REQ-12 "workerPath realpath'd at extension load" — `testWorkerPathResolvedAtLoad` exists in Group 10 but **does not assert `realpath` was called**; the test merely checks the returned value is absolute. A naive `path.resolve` without `realpath` would pass. Need a test that creates a symlink pointing to the worker and asserts the backend returns the symlink-resolved path, OR a unit test against `resolveWorkerPath` with a fixture directory containing a symlink.
- REQ-12 "If worker file cannot be located, log debug and skip" — `testExtensionSkipsRegistrationWhenWorkerMissing` exists (Group 9). However, the test description says "monkey-patch `resolveWorkerPath` to return `null`." Plan does not specify how this monkey-patch is wired. Need an explicit seam (e.g. an exported `setResolveWorkerPathForTest(fn)` test-only hook, OR an injectable `workerPath: string | null` constructor arg to `createTmuxBackend`).
- REQ-1 (backend name `"tmux"`) — `testTmuxBackendName` exists. ✅

**Required fix:** Add `testWorkerPathIsRealpathed` (REQ-12 realpath) and document the monkey-patch seam for `testExtensionSkipsRegistrationWhenWorkerMissing` (REQ-12 missing-worker).

### B3 — REQ-13 test is greppable but not discriminative

`testTmuxTerminalImportsOnlyBgTerminal` is described as a test, but the REQ-13 row in the Requirements table says the verification is `grep -l "from \"\.\./.*/agents/lib/" tmux-terminal/ -r` — that's a shell command, not a Node test. The catalog should clearly mark this as `manual: grep -rn 'from "../.*/agents/lib/" tmux-terminal/'` (per the Plan Template's `Test(s)` column format), and the Mechanical Execution Spec step 1.13 should run it as a real assertion.

**Required fix:** Move REQ-13 verification from "test" language to `manual: grep …` in the Requirements table AND add a step in Appendix B that runs the grep and asserts empty output (`! grep -rn 'from "\.\./.*/agents/lib/" tmux-terminal/' || exit 1`).

### B4 — Contract state tables incomplete

The Contracts section defines `createTmuxBackend` with 3 states (A/B/C), `resolveWorkerPath` with 1 state (returns null), `defaultTmuxExecutor` with no states, and `shellEscape`/`redactError` with no states.

**Missing states:**

| Function | Missing state | Why it matters |
|---|---|---|
| `resolveWorkerPath` | Multiple worker basenames present (`bg-worker.ts` + `bg-worker.mjs`) — which wins? | Plan's `WORKER_BASENAMES` constant lists `["bg-worker.ts", "bg-worker.mjs", "bg-worker.js"]` with "resolution priority order" — but the state table has no rule for which wins. Need: "If multiple basenames exist, prefer `.ts` > `.mjs` > `.js` (matches the priority order). Test: `testWorkerPathPrefersTsOverMjs`." |
| `defaultTmuxExecutor` | ENOENT (binary missing) at exec time — even if `isAvailable()` was true | Race: tmux binary could be uninstalled between probe and exec. Plan says it "Resolves never rejects" but does not say what `exitCode` is on ENOENT. Need explicit state: ENOENT → `{ ok: false, stdout: "", stderr: "spawn tmux ENOENT", exitCode: -1 }` plus a test. |
| `shellEscape` | Empty string input | Currently undefined behavior. POSIX convention: `''` (two single quotes = empty string). Test: `testShellEscapeHandlesEmptyString`. |
| `redactError` | Path appears multiple times in stderr | Plan says "Replaces occurrences of …" but does not say if it's global. Need `String.prototype.replaceAll` semantics (global) and a test `testRedactErrorReplacesAllOccurrences`. |

**Required fix:** Add the 4 missing states and their tests. Also document the multi-basename resolution rule in the `resolveWorkerPath` contract.

### B5 — Test discrimination gaps in security-critical tests

The plan's "Falsifiable Verify" section promises the security tests are discriminating. Spot-check:

- `testLaunchEmitsOnlyWorkerPathAndManifestPathInCommand` — verifies the captured argv array contains exactly the expected tokens. **Discriminating.** ✅
- `testLaunchDoesNotInterpolateAgentName` — Plan description says: "The tmux command contains the metacharacters nowhere; window option `@pi_agent_name` is set via a separate, non-shell-parsed tmux call." But the test needs to assert that the agentName appears **nowhere in the `new-window` argv** AND **appears only in the `set-window-option` argv**. Currently under-specified. Need explicit: assert agentName absent from launch argv AND present only in the set-window-option argv.
- `testKillExactMatchNoSubstring` — EC8 calls for asserting `isAlive('pi-agent-a3f9c2b1')` returns `false` against window `pi-agent-a3f9c2b12`. The catalog test is `testIsAliveExactMatchNoPrefix`. But `testKillExactMatchNoSubstring` for the `kill` direction is **not in the catalog** (EC8 is in Edge Cases but the corresponding Group 6 entry is `testKillExactMatchNoSubstring` — actually wait, Group 6 has 4 entries: `testKillRemovesWindow`, `testKillIdempotentOnMissingWindow`, `testKillFailedOnOtherErrors`, `testKillExactMatchNoSubstring`). ✅ exists. But its description in the catalog doesn't specify the exact fixture (e.g. "launch with runId='exact-match-test', then call kill('exact') and assert exit-code-1 'can't find window'"). Needs fixture specification.

- `testListRecoversRunIdAndAgentName` — The catalog says it lists both, but does not specify what happens when `set-window-option` failed (EC9: race). The race case needs its own test or an explicit assertion in this one.

**Required fix:** Tighten the security test descriptions to include fixture shape and the full assertion chain (what's checked AND what's NOT checked).

### B6 — Mechanical Execution Spec executor-readiness gaps

The plan's Appendix B claims to be executor-ready. The "Executor-ready gate" requires:
- Every step's `File` column names exactly one file ✅ (verified for 1.1-1.13)
- Every step on an existing file quotes verbatim ANCHOR and exact REPLACE
- Whole-file `Write` appears only for new-file CREATE steps ✅
- No "decide / choose / figure out / as appropriate / if needed / etc." in step text

**Gaps:**

1. **Step 1.7** is `CREATE` for `tmux-backend.ts` at "~150 lines" with no contents specified. The Executor contract requires "Full contents: `<exact source>`." A 150-line CREATE without verbatim contents is **not executor-ready**. The plan must either:
   - (a) Inline the full 150-line implementation in step 1.7, OR
   - (b) Split step 1.7 into multiple sub-steps each adding one method (e.g. 1.7a: skeleton, 1.7b: `isAvailable`, 1.7c: `launch`, 1.7d: `kill`/`isAlive`/`list`), each with verbatim APPEND bodies.

   **Required fix:** Adopt (b) — sub-steps match the test-group ordering in 1.8 and let the executor verify after each method is added.

2. **Step 1.9** says `import.meta.url` resolution but the implementation step does not specify the verbatim import statement. The line `import { fileURLToPath } from "node:url";` and `const __dirname = path.dirname(fileURLToPath(import.meta.url));` must appear verbatim if used. Currently unspecified.

3. **Step 1.8** says "17 test cases covering Groups 1-13" but the catalog has 19 unique names. Number mismatch (also flagged in B1).

4. **Step 1.13** (anchored edit on `agents/P3_IMPLEMENTATION_SLICES.md`) says `ANCHOR:` "the `### P5 Pluggable Terminal Backend (PARALLEL)` line" but does not provide the **verbatim current line text**. The Executor contract says "the step gives the verbatim `ANCHOR` (the exact current text to locate, copied byte-for-byte)." Currently fails the gate.

**Required fix:** Inline the full implementation in step 1.7 (split into sub-steps), add verbatim ANCHOR text to step 1.13, and reconcile 1.8's test count with B1's resolved number.

### B7 — `defaultTmuxExecutor` Promise contract under-specified

The contract says "Resolves never rejects." But Node's `execFile` rejects on ENOENT (binary missing). The implementation MUST catch the rejection internally. The plan does not specify the catch behavior explicitly.

**Required fix:** Add to the `defaultTmuxExecutor` contract:
- On `Error: spawn tmux ENOENT` → resolve `{ ok: false, stdout: "", stderr: "spawn tmux ENOENT", exitCode: -1 }`
- On `Error: Command failed: …` with stderr → resolve `{ ok: false, stdout, stderr, exitCode: err.code ?? 1 }`
- On timeout (from `child_process.execFile`'s internal timer) → resolve `{ ok: false, stdout: "", stderr: "timed out after ${timeoutMs}ms", exitCode: -1 }`
- All other Errors → resolve `{ ok: false, stdout: "", stderr: String(err), exitCode: -1 }`

Plus a test `testDefaultTmuxExecutorNeverRejects` that calls with `args: ['nonexistent-subcommand']` and asserts the result is `{ ok: false, exitCode: -1 }` (not a thrown error).

## Non-blocking concerns

- **N1 — `RUN_ID_PREFIX_LEN = 16` is asserted by code reading but not tested.** Add `testRunIdPrefixLengthIsSixteen` to Group 1 (or fold into `testLaunchWindowNameFormat`).

- **N2 — `redactError` contract does not specify what happens if both paths are absent from stderr.** Should be a no-op (return unchanged truncated stderr). Test: `testRedactErrorNoPathsNoChange`.

- **N3 — `resolveWorkerPath` cache is process-local.** If `tmux-terminal` is reloaded via `/reload`, the cached path survives. Is that desired? Document explicitly in the contract: "Cache persists for the lifetime of the Node process; reloads do not re-resolve."

- **N4 — `isAvailable` probing via `tmux has-session -t __pi_probe__`** — this creates a fake session if the server is reachable but has no sessions, which is then killed. The plan says "or `$TMUX` is set" — but if `$TMUX` is set, `tmux has-session -t __pi_probe__` is unnecessary and could create a stray session. The probe should short-circuit on `$TMUX` first. Document: "If `$TMUX` is set, return true without probing."

- **N5 — `FakeTmuxExecutor` description says `class FakeTmuxExecutor`** but step 1.6 specifies it as a class with `exec(args, opts)` recording to `this.calls` and returning `this.response`. The "configured stdout" implies tests must mutate `this.response` between calls. This is fine but the test file (step 1.8) needs each test to set `this.response` correctly — currently undocumented.

- **N6 — README REQ-19 specifies "5 required sections" but Done Criteria says "5 sections present (manual check)"**. This is acceptable but the manual-check nature should be tagged `manual:` in the Test column.

- **N7 — Test Catalog mentions 12 groups but listing has 14.** Numbering inconsistency. The re-count line ("42 named assertions") tries to address this but the math is off (see B1).

- **N8 — Plan claims "No `UNGUARDED-IN-CI` tags are needed"** because every MUST has an automated test. But REQ-16's first manual smoke ("pi -e … --list-commands shows /agents bg and reaches tmux launch") IS an `UNGUARDED-IN-CI` candidate if the agents extension also changes. Currently only the dual-load extension ordering is tested via the registry-level tests. The actual end-to-end "user types /agents bg" flow has no automated test. Consider: tag REQ-16 with `UNGUARDED-IN-CI` and name the residual + manual step, OR add a Puppeteer-style headless test (rejected by P4-7's fake-backend pattern, so document the decision).

- **N9 — `set-window-option` failure is documented as "best-effort"** but no test asserts what `launch` returns when the post-exec `set-window-option` fails. The windowId is already returned by `new-window -P`, so the launch succeeded. But callers don't know that `runId` recovery will fail later. Add a test: `testLaunchOkEvenIfSetWindowOptionFails` returning `{ status: "ok", windowId: "pi-agent-…" }` despite `set-window-option` exiting non-zero.

## Missing tests / validation

| # | Test | Rationale |
|---|---|---|
| T1 | `testWorkerPathIsRealpathed` | REQ-12 specifies `realpath` — not just `resolve`. |
| T2 | `testWorkerPathPrefersTsOverMjs` | REQ-12 + `WORKER_BASENAMES` priority order. |
| T3 | `testDefaultTmuxExecutorNeverRejects` | Contract: "Resolves never rejects." |
| T4 | `testShellEscapeHandlesEmptyString` | Edge case not in current catalog. |
| T5 | `testRedactErrorReplacesAllOccurrences` | Documented "Replaces occurrences" but not tested. |
| T6 | `testLaunchOkEvenIfSetWindowOptionFails` | Documented "best-effort" but not tested. |
| T7 | `testAgentNameAppearsOnlyInSetWindowOptionArgv` | Tightens REQ-3 fixture (B5). |
| T8 | `testLaunchEscapesPathsWithSpaces` | EC2 not in catalog. |
| T9 | `testLaunchEscapesPathsWithSingleQuote` | EC3 not in catalog. |
| T10 | `testRegistryFirstWinsAcrossLoadOrders` in spec says tmux+agents but no test that agents alone + no tmux-terminal returns null. | Currently `testExtensionLoadsWithoutAgentsPresent` covers "tmux-terminal loaded without agents" — but the opposite direction (agents without tmux-terminal, no registration happens) is the user-facing default and untested. |
| T11 | `testListEmptyUserOptionsDuringLaunchRace` | EC9 in Edge Cases but missing from catalog (test name appears in catalog but no fixture description). |

## Safety / security concerns (plan-level, not adversarial)

These overlap with the adversarial review but are specifically about whether the **plan** adequately specifies the mitigations:

- **S1 — Plan's REQ-3 says "no interpolation" but does not specify what happens if `manifestPath` validation fails upstream.** A malformed manifest path (e.g. a `..` traversal) reaching `launch` would be passed through to tmux. The plan should specify: "`launch` validates `config.manifestPath` is absolute and does not contain `..` segments; if not, returns `{ status: "failed", error: "invalid manifest path" }` without invoking tmux." Add REQ-20 + test.

- **S2 — Plan does not specify behavior when both `agents` and `tmux-terminal` are loaded, but a third backend (zellij-terminal) is also loaded.** Per `bg-terminal.ts` first-wins rule, only the first-registered backend is used. The plan does not say which loads first by default. Document the load order: "When loaded via `pi -e ./agents/index.ts -e ./tmux-terminal/index.ts`, tmux-terminal loads second; the backend sits idle. When loaded via `pi -e ./tmux-terminal/index.ts -e ./agents/index.ts`, tmux-terminal loads first and registers; agents queries it. Both are correct." This is already in REQ-17 but the README should mirror it.

- **S3 — The `TMUX_INVOCATION_TIMEOUT_MS = 10_000` constant is not justified.** 10 seconds is reasonable for a `tmux new-window` call but too short for `tmux list-windows` against a session with 100+ windows. Consider split: `TMUX_LAUNCH_TIMEOUT_MS = 10_000` and `TMUX_QUERY_TIMEOUT_MS = 3_000`. Or document why 10s is sufficient for all ops.

- **S4 — Plan does not address what happens if the tmux server is killed between `launch` and `list`.** The window may still appear in `list-windows` if the server has been restarted and the windows re-attached — or it may not, depending on tmux state. The contract says `list()` returns `[]` on tmux error, which is fail-closed. But what if `list()` returns windows whose windowIds are no longer alive? The `kill` call against such a windowId would fail with "can't find window" → idempotent `ok`. Acceptable, but document.

- **S5 — Plan's REQ-8 says error messages "include tmux's stderr verbatim (truncated to 512 chars) but SHALL NOT include the worker path or manifest path verbatim."** However, tmux's stderr from `new-window` is typically `can't find window: …` or `sessions should be nested with care, unset $TMUX to force` — rarely contains the worker path. The redaction is defense-in-depth but mostly applies to error messages tmux might echo from the command being executed. The plan should specify: "If tmux's stderr contains the substring of either path, replace with the literal strings `<worker>` and `<manifest>` respectively, before truncating." This is the precise `redactError` contract — currently it says "occurrences of `workerPath`" but doesn't say "substring match" (which is what substring-of-string means).

## Verdict

**conditional-go** — 7 blockers, all addressable with focused revisions. The plan's overall structure, design choices, and threat model are sound; the blockers are test-coverage completeness, contract exhaustiveness, and executor-readiness for the mechanical spec.

## Follow-up applied (resolution sketch — to be applied in plan v2)

### B1 — Test count convergence
Resolved by enumerating the catalog with a single number: **19 test functions, 42 assertions across 14 groups.** Add an explicit assertion table mapping test name → requirement ID → assertion count. Remove the "45" mental-math line.

### B2 — REQ-12 realpath + missing-worker seam
Add T1 (`testWorkerPathIsRealpathed`) using a temp dir with a `bg-worker.ts` symlink. Add explicit monkey-patch seam: `export function __setResolveWorkerPathForTest(fn: () => string | null)`. Update `index.ts` to call `resolveWorkerPath` via the seam so tests can override.

### B3 — REQ-13 grep as executable assertion
Change REQ-13's Test cell from test-name to `manual: grep -rn 'from "../.*/agents/lib/" tmux-terminal/'` AND add Appendix B step 1.14 that runs `! grep -rn 'from "\.\./.*/agents/lib/" tmux-terminal/' || { echo "REQ-13 violated"; exit 1; }` and asserts exit 0.

### B4 — Missing contract states
Add the 4 missing states with their tests (T2, T4, T5, and an `ENOENT` test in `testDefaultTmuxExecutorHandlesMissingBinary`). Add state table for `resolveWorkerPath` covering "no basenames found" and "multiple basenames found" (precedence rule documented).

### B5 — Security test fixtures
Add explicit fixture text to each security test:
- `testLaunchDoesNotInterpolateAgentName`: agentName `"scout; rm -rf /"`, assert the malicious string appears in **zero** argv arrays returned by `FakeTmuxExecutor.calls`.
- `testKillExactMatchNoSubstring`: launch with runId `"exact-match-test"`, call `kill("exact")`, assert the captured `tmux kill-window` argv includes `-t 'exact'` (exact-match attempt), not the full windowId, and the result is `{ status: "ok" }` (no-op because no such window exists).
- `testListRecoversRunIdAndAgentName`: explicit assertion `assert.equal(entry.runId, "bg-1719432000000-a3f9c2b1")` (not just "non-empty").

### B6 — Mechanical spec executor-readiness
Split step 1.7 into:
- 1.7a CREATE `tmux-backend.ts` skeleton (just the `createTmuxBackend` factory + `name: "tmux"` constant).
- 1.7b APPEND `isAvailable()` method body.
- 1.7c APPEND `launch()` method body (~50 lines, full verbatim).
- 1.7d APPEND `kill()` method body (~20 lines).
- 1.7e APPEND `isAlive()` method body (~20 lines).
- 1.7f APPEND `list()` method body (~30 lines).

Add verbatim ANCHOR text to step 1.13.

### B7 — `defaultTmuxExecutor` catch behavior
Add the 4 catch clauses (ENOENT, command-failed, timeout, other) to the contract and step 1.4's CREATE body. Add test T3.

### S1 — Manifest path validation
Add REQ-20: "`launch` SHALL validate `config.manifestPath` is an absolute path with no `..` segments. Failures return `{ status: "failed", error: "invalid manifest path" }` without invoking tmux." Add test `testLaunchRejectsRelativeManifestPath` and `testLaunchRejectsDotDotManifestPath`.

### N1–N9 — Non-blocking
Applied as part of v2 cleanup; not gating merge.

### T1–T11 — Missing tests
Add to v2 catalog. Estimated total: **27 test functions across 14 groups** (vs. v1's 19).

## Final plan stats (v2 target)

- **20 requirements** (REQ-1 through REQ-20)
- **27 test functions** across **14 groups**
- **15 contract states** (vs. v1's ~6)
- **13 edge cases** (add EC2/EC3 escape tests to T8/T9)
- **5 explicit security mitigations** with automated tests
- **14 mechanical-execution steps** (was 13; added REQ-13 grep step)

Re-request review after v2 lands. The structure should hold; the v2 changes are scoped to completeness gaps identified above.