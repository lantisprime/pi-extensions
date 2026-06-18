# P3f-4 Profile Override + Stdout Spill Plan

## Status

Planning only. Do not implement until this plan, plan review, and adversarial review are accepted.

## Episode Search Summary

Searched episodic memory for profile override, stdout capture, model profiles.

Key active memories:

- `20260618-032316`: Canonical workplan — P3d-2 + P3f-3 merged; P3e next
- `20260613` (milestone): P3f-2 merged — model profiles wiring with intentional trust gap
- `20260613` (milestone): P3f-3 merged — profile discovery + hash-registration, trust gap closed

## Objective

Two coupled changes to the agents child-execution path: (1) allow runtime profile override so `/agents run <agent> --profile <name> <task>` replaces the spec-bound profile for one run; (2) stop killing the child Pi process on raw stdout overflow — instead spill full stdout to a temp file and extract the summary from it, so agents that use read tools (reviewer, planner) can finish their final response instead of being killed mid-stream.

## Why

- **Profile override**: built-in agents bind a profile at spec-definition time. To try a different model (e.g. reviewer with `reasoning-deep` instead of `code-review`) today requires editing the spec. A `--profile` flag lets the operator swap the profile per-run without code changes.
- **Stdout spill**: `spawnAndCollect` accumulates the first `maxStdoutBytes` (1MB default) of raw stdout and kills the child when exceeded. Agents with read tools emit voluminous JSONL tool traces *before* writing the final assistant message. The kill destroys the very text the operator wants. Reviews consistently come back empty (`status: output-limit-exceeded`, `summaryText: undefined`).

## Requirements (Ground Truth)

| ID | Requirement | Test(s) | Priority | Notes |
|---|---|---|---|---|
| REQ-1 | `parseRunArgs` extracts `--profile <name>` from `/agents run <agent> --profile <name> <task>` and omits it from the task body | `parseRunArgs_extracts_profile_override`, `parseRunArgs_no_override_omits_field`, `parseRunArgs_missing_task_fails` | MUST | Must not break existing two-arg form |
| REQ-2 | `parseRunArgs` supports profile override in both built-in and registered agent paths; override reaches `runChildAgent`/`runBuiltInChildAgent` | `executeChildRun_threads_profileOverride_builtIn`, `executeChildRun_threads_profileOverride_registered` | MUST | Threading through `executeChildRun` |
| REQ-3 | `runChildAgent` uses `profileOverride ?? spec.profile` for resolution | `runChildAgent_uses_override_when_provided`, `runChildAgent_uses_spec_profile_when_no_override` | MUST | Override is one-shot; does not mutate spec |
| REQ-4 | When `effectiveProfile` is set but no library is available, run fails closed (spawn-error, no child) | `runChildAgent_override_without_library_fails_closed`, `runChildAgent_spec_profile_without_library_fails_closed` | MUST | Regression safety: unknown profile must not silently fall back to spec model |
| REQ-5 | Profile override does not bypass `profileTrustCheck` — an unregistered project override profile still denies | `runChildAgent_override_unregistered_project_profile_denies` | MUST | Security: override is not a trust bypass |
| REQ-6 | Profile override does not bypass `canRunAgent` for registered agents | covered by existing P3c-3 path unchanged | MUST | Override is post-gate; gate runs first |
| REQ-7 | `resolveSpecProfile` returns `profileCanonicalPath` and `profileRawBytesSha256` from the resolved profile so the trust check can match | `resolveSpecProfile_carries_canonical_path_and_hash`, existing P3f-3 trust tests | MUST | Today these fields are read in child-runner but never populated → bug |
| REQ-8 | Full child stdout is written to a secure temp file created via `fs.mkdtemp(path.join(stdoutTmpDir, "pi-agent-"))` (dir mode 0700) containing a `stdout.jsonl` file opened with the `wx` flag (exclusive create, mode 0600). The resolved file path is surfaced on the result **only when the file is kept** (non-completed status); on completed status the file is unlinked and no path is surfaced | `spawnAndCollect_writes_stdout_to_secure_temp_file`, `spawnAndCollect_surfaces_path_only_when_kept` | MUST | Spill target; predictable names forbidden; operator can inspect raw JSONL on failure |
| REQ-9 | `spawnAndCollect` does NOT kill the child on stdout overflow; it continues until exit or timeout | `spawnAndCollect_does_not_kill_on_stdout_overflow`, existing P3c-1/P3c-2 limit tests updated | MUST | Core fix — preserves final response |
| REQ-10 | A high-watermark safety kill remains at `maxStdoutSafetyBytes` (default 50× `maxStdoutBytes`) to stop runaway processes that never terminate | `spawnAndCollect_kills_at_safety_watermark`, `spawnAndCollect_marks_output_limit_exceeded_on_safety_kill` | MUST | Runaway protection without killing normal reviews |
| REQ-11 | Summary is extracted from the spill file after process exit (spill stream flushed/closed) via `reduceChildJsonl`; final assistant message is captured even when tool JSONL is voluminous | `spawnAndCollect_summary_captures_final_message_after_large_tools` | MUST |
| REQ-11b | (SHOULD) End-to-end: reviewer returns non-empty `summaryText` on a task requiring file reads | `manual: reviewer returns non-empty summaryText on a file-reading task` | SHOULD | Network/model-dependent; not merge-blocking | The observable win |
| REQ-12 | Temp file AND its mkdtemp directory are removed after successful summary extraction (status completed); kept on error/timeout/safety-kill/spill-error for debugging and surfaced via `stdoutTmpPath`. MUST not leak prompt/task text on the success path | `spawnAndCollect_cleans_temp_file_on_success`, `spawnAndCollect_keeps_temp_file_on_timeout`, `spawnAndCollect_surfaces_path_on_safety_kill` | MUST | Cleanup is MUST (not SHOULD) because stdout may contain prompts/file contents |
| REQ-13 | All existing test suites (P3b-1, P3c-1, P3c-2, P3c-4, P3d-1, P3f-1, P3f-2, P3f-3) continue to pass; assertions that change semantics are listed in the assertion-change matrix (Group 7) | `bash agents/test-fixtures/run-p3*-tests.sh` | MUST | No regressions |
| REQ-14 | Smoke check passes: `pi --no-extensions -e ./agents/index.ts --list-models` | `manual: pi --no-extensions -e ./agents/index.ts --list-models` | MUST | Extension loads |

**Priority legend:** MUST = required for merge; SHOULD = required before feature complete; MAY = nice-to-have.

## Non-Goals

- **Automatic model fallback chain** (gpt-5.5 → opus-4.8 retry). Separate feature; not in scope.
- **Persisting the override** to the agent spec. Override is one-shot, runtime-only.
- **Streaming the summary** to the parent TUI live. Summary is still extracted after exit.
- **Changing `canRunAgent`, profileTrustCheck, buildChildPiArgs semantics.** They are reused as-is.
- **Modifying `ModelProfile` type** to carry `canonicalPath`/`rawBytesSha256` as declared fields. They remain dynamic on the object; only `ResolvedProfile` gains declared fields (see Design).

## Safety / Security

| Concern | Severity | Mitigation | Test(s) |
|---|---|---|---|
| Override bypasses profile trust check | High | Override flows through the same `resolveSpecProfile` → `profileTrustCheck` path; unregistered project override denies | `runChildAgent_override_unregistered_project_profile_denies` |
| Override bypasses canRunAgent | High | Override is applied AFTER `canRunAgent` in `runAgentCommand`; gate is unchanged | covered by P3c-3 path |
| Unknown override profile silently falls back to spec model | High | `effectiveProfile` set but no library → fail-closed spawn-error | `runChildAgent_override_without_library_fails_closed` |
| Removing stdout kill allows unbounded resource use | Medium | Keep high-watermark safety kill at 50× `maxStdoutBytes`; timeout unchanged | `spawnAndCollect_kills_at_safety_watermark` |
| Temp file leaks sensitive prompt/task text | Medium | mkdtemp dir (0700) + stdout.jsonl (0600 exclusive); unlinked on success; surfaced only on failure | `spawnAndCollect_surfaces_path_only_when_kept` |
| `--profile` value is an argv-injection vector into child argv | Low | Override is only used as a library lookup key; never placed in child argv | `runChildAgent_override_not_in_child_argv` |

## Design

### Key types

```ts
// run-resolver.ts — parseRunArgs return gains optional override
type ParseRunArgsResult =
  | { ok: true; name: string; task: string; profileOverride?: string }
  | { ok: false; message: string };

// profiles.ts — ResolvedProfile gains trust-check fields
type ResolvedProfile = {
  effectiveModel: string | undefined;
  effectiveThinking: ThinkingLevel | undefined;
  profileName: string | undefined;
  profileProvidedModel: boolean;
  profileProvidedThinking: boolean;
  profileSourceOrigin?: "built-in" | "user" | "project";
  profileCanonicalPath?: string;       // NEW
  profileRawBytesSha256?: string;      // NEW
};

// child-runner.ts — runner signatures gain optional override
function runBuiltInChildAgent(
  agentName: string, task: string,
  options: RunBuiltInChildAgentOptions = {},
  profiles?: ModelProfileLibrary,
  profileOverride?: string,            // NEW
): Promise<ChildAgentRunResult>;

function runChildAgent(
  spec: AgentSpec, task: string,
  options: RunChildAgentOptions = {},
  profiles?: ModelProfileLibrary,
  profileOverride?: string,            // NEW
): Promise<ChildAgentRunResult>;

// child-runner.ts — spawnAndCollect options gain safety watermark
type SpawnOptions = {
  // ...existing...
  stdoutLimit: number;                 // now = unused for kill (spill is unlimited up to safety watermark); kept for compatibility/back-compat
  stdoutSafetyBytes: number;           // NEW — hard kill at this total
  stdoutTmpDir: string;                // NEW — default os.tmpdir()
};
```

### Key invariants

- `profileOverride` is advisory-only: it changes which profile is resolved, never tools, never child argv flags.
- `effectiveProfile = profileOverride ?? spec.profile`. If neither is set, behavior is identical to today (passthrough).
- Override never mutates `spec`; it produces a local `effectiveSpec`.
- The trust check runs whenever `result.profileSourceOrigin === "project"`, regardless of whether the profile came from override or spec.
- Removing the stdout kill does NOT remove timeout protection. Timeout remains the primary runaway guard.
- The safety watermark is `50 × stdoutLimit` by default. It exists only to stop a process that ignores timeout (e.g. a model stuck emitting tokens forever). Normal reviews must not hit it.
- **All limits are validated and clamped.** `stdoutLimit` and `stdoutSafetyBytes` MUST be finite positive integers; non-finite (NaN/Infinity), non-positive, or non-integer values are rejected before spawn (spawn-error). `stdoutSafetyBytes` is clamped to a global maximum (e.g. 256 MB) regardless of spec, so a malicious/buggy huge `maxStdoutBytes` cannot disable runaway protection. Write-stream backpressure is respected: stdout is paused when the spill write cannot keep up, bounding in-memory buffering.
- **Spill file is the sole source of truth for summarization.** After child exit, the implementation MUST await the spill write stream's `finish`/`close` event before calling `reduceChildJsonl`. No in-memory tail is used for summary extraction.
- **Spill lifecycle is fail-closed.** If the spill dir/file cannot be opened (ENOSPC, EACCES, read-only fs), `spawnAndCollect` returns a spawn-error WITHOUT spawning the child. Write-stream errors during the run set `spillWriteError` (NOT `outputLimitExceeded`); the run continues best-effort, the summary may be partial, and the temp file is kept.
- `profileOverride` never mutates `spec`. The runner computes `resolutionSpec = { ...spec, profile: profileOverride ?? spec.profile }` for resolution ONLY (lookup + trust check). Override lookup failure (unknown name) is a spawn-error. The trust check uses metadata from the **actually resolved** profile (override or spec), never a mix.
- `buildChildPiArgs` receives a separate `childArgSpec = { ...spec, model: resolvedModel, thinking: resolvedThinking }` with the **`profile` field explicitly deleted/omitted**. The raw override name (and the profile name generally) NEVER reaches `buildChildPiArgs` or child argv. An assertion test verifies the override string is absent from both the argv-building object and the final argv.

### Resolution / flow

```text
/agents run <agent> [--profile <name>] <task>
  │
  ├─ parseAgentsArgs → action="run", rest="<agent> [--profile <name>] <task>"
  ├─ parseRunArgs → { name, task, profileOverride? }
  │
  ├─ [registered] canRunAgent gate (unchanged) — runs BEFORE override is applied
  │
  └─ executeChildRun(agent, task, ctx, source, profileOverride?)
       └─ runBuiltInChildAgent/runChildAgent(agent, task, opts, profiles, profileOverride)
            ├─ effectiveProfile = profileOverride ?? spec.profile
            ├─ if effectiveProfile && !profiles → spawn-error (fail-closed)
            ├─ resolveSpecProfile(effectiveSpec, profiles)  // effectiveSpec.profile = effectiveProfile
            │    └─ returns profileCanonicalPath, profileRawBytesSha256
            ├─ if profileSourceOrigin === "project" → profileTrustCheck (unchanged)
            └─ buildChildPiArgs(childArgSpec, task) — profile field omitted, override never in argv

spawnAndCollect(invocation, { stdoutLimit, stdoutSafetyBytes, stdoutTmpDir })
  ├─ fs.mkdtemp(path.join(stdoutTmpDir,"pi-agent-")) (dir 0700) → open stdout.jsonl with wx (mode 0600, exclusive)
  ├─ on stdout data:
  │    ├─ append to temp file
  │    ├─ track total stdout bytes (for safety watermark)
  │    └─ if total > stdoutSafetyBytes → killChild + outputLimitExceeded
  ├─ on exit/timeout:
  │    ├─ await spill stream finish/close → read spill file as source of truth
  │    ├─ reduceChildJsonl(stdoutText) → summary
  │    └─ if status === completed → unlink temp file; else keep
  └─ result { summary, stdoutTmpPath?, ... }
```

## Existing Hook Points

| File | Line(s) | What it does | Impact |
|---|---|---|---|
| `agents/lib/run-resolver.ts` | L81 `executeChildRun` | builds options, dispatches to runner | Add `profileOverride?` param, thread to runner calls |
| `agents/lib/run-resolver.ts` | L102 `runAgentCommand` | parses + dispatches `/agents run` | Pass `parsed.profileOverride` to both built-in and registered `executeChildRun` calls |
| `agents/lib/run-resolver.ts` | L144 `parseRunArgs` | splits name/task | Add `--profile <name>` extraction |
| `agents/lib/child-runner.ts` | L66 `runBuiltInChildAgent` | built-in entry | Add `profileOverride?` param |
| `agents/lib/child-runner.ts` | L73 `runChildAgent` | spec entry, profile resolution | Use `effectiveProfile = profileOverride ?? spec.profile`; add fail-closed when no library |
| `agents/lib/child-runner.ts` | L191 `spawnAndCollect` | spawns + collects stdout | Replace head-cap-and-kill with temp-file spill + safety watermark (no tail summarization) |
| `agents/lib/profiles.ts` | L70 `ResolvedProfile` | resolution result type | Add `profileCanonicalPath?`, `profileRawBytesSha256?` |
| `agents/lib/profiles.ts` | L248 `resolveSpecProfile` | resolves profile → effective model/thinking | Populate the two new fields from the matched profile object |
| `agents/lib/specs.ts` | reviewer/planner limits | `maxStdoutBytes` default 1MB | Now interpreted as summary budget, not kill threshold — no change needed unless we raise it |

## Slice Ladder

Single slice. The two changes are coupled (override + spill both touch `child-runner.ts` and both are needed to make `/agents run reviewer --profile ...` actually return a verdict). Splitting would ship a half-broken reviewer twice.

## Cut Order

If scope grows, cut in this order:

1. (nothing — all MUST requirements are non-negotiable for this slice)

Do not cut:

- Profile override fail-closed (REQ-4)
- profileTrustCheck still runs on override (REQ-5)
- Safety watermark (REQ-10)
- Existing test suites passing (REQ-13)

## Contracts

### `parseRunArgs(input): ParseRunArgsResult`

**Input contract:** the `rest` string after `/agents run ` (i.e. `<agent> [--profile <name>] <task>`).

**Output contract:** discriminated union; on success carries `name`, `task`, and optional `profileOverride`.

**State table:**

| State | Condition | Output |
|---|---|---|
| A. Override present | matches regex with a non-option value | `{ ok: true, name, profileOverride, task }` |
| B. No override | name + task, no `--profile` | `{ ok: true, name, task }` (profileOverride absent) |
| C. Missing task | only agent name given | `{ ok: false, message: usage }` |
| D. Empty | blank input | `{ ok: false, message: usage }` |
| E. `--profile` with no value | `<agent> --profile` (end of input) | `{ ok: false, message: usage }` |
| F. `--profile` value is option-looking | value starts with `--` | `{ ok: false, message: usage }` |
| G. Repeated `--profile` | `--profile` appears more than once | `{ ok: false, message: usage }` |

**Error codes:** none beyond the usage message.

### `spawnAndCollect(agentName, invocation, options): ChildAgentRunResult`

**Input contract:** invocation + limits (`stdoutLimit`, `stdoutSafetyBytes`, `stdoutTmpDir`, timeout, etc.)

**Output contract:** `ChildAgentRunResult` with `summary` extracted from the spill file (sole source of truth); `stdoutTmpPath?` present only when the temp file is kept (non-completed status). Flags are disjoint: `outputLimitExceeded` = true **only** on safety-watermark kill (total stdout > 50× limit); `spillWriteError` = true when the spill write stream errored mid-run. When `spillWriteError` is set, the result status is **NOT `completed`** even if exit code is 0 — it is `spill-error` (a non-success outcome); the temp file is kept and `stdoutTmpPath` surfaced, and `summary` may be empty/partial but must NOT be reported as a successful completed run. The two flags are never conflated.

**State table:**

| State | Condition | Output.status | Temp file |
|---|---|---|---|
| A. Completed | exit 0, no safety kill, no spillWriteError | `completed` | unlinked |
| A2. Spill error | exit 0 but spillWriteError set | `spill-error` (non-success) | kept + path surfaced |
| B. Timeout | timeout fires | `timed-out` | kept |
| C. Safety kill | total stdout > `stdoutSafetyBytes` | `output-limit-exceeded` | kept |
| D. Non-zero exit | exit ≠ 0 | `failed` | kept |
| E. Spawn error | spawn threw | `spawn-error` | n/a |

## Edge Cases

| # | Scenario | Expected behavior | Test |
|---|---|---|---|
| EC1 | `--profile` given but profiles library undefined | fail-closed spawn-error | `runChildAgent_override_without_library_fails_closed` |
| EC2 | `--profile unknown-name` | resolveSpecProfile returns unresolved → spawn-error | `runChildAgent_override_unknown_profile_fails` |
| EC3 | `--profile security-review` (project, unregistered) | trust check denies → spawn-error, no child | `runChildAgent_override_unregistered_project_profile_denies` |
| EC4 | `--profile` value contains shell metachars | only used as library key; never reaches child argv | `runChildAgent_override_not_in_child_argv` |
| EC5 | Reviewer reads 5MB of files, then writes 2KB verdict | process completes, summary has verdict, temp file has full 5MB | `spawnAndCollect_summary_captures_final_message_after_large_tools` |
| EC6 | Process emits > 50MB stdout (runaway) | safety kill at 50MB, status output-limit-exceeded, temp file kept | `spawnAndCollect_kills_at_safety_watermark` |
| EC7 | Temp file dir not writable or open fails | **fail before spawn** — return spawn-error, do not silently degrade | `spawnAndCollect_fails_closed_when_tmp_dir_unwritable` |
| EC8 | `--profile` appears mid-task (`<agent> <task> --profile x`) | NOT matched — `--profile` must come immediately after agent name; mid-task occurrence is part of the task | `parseRunArgs_mid_task_profile_is_part_of_task` |
| EC9 | `<agent> --profile` with no value | parse fails with usage | `parseRunArgs_profile_with_no_value_fails` |
| EC10 | `<agent> --profile --foo task` (option-looking value) | parse fails with usage | `parseRunArgs_profile_option_looking_value_fails` |
| EC11 | `<agent> --profile a --profile b task` (repeated) | parse fails with usage | `parseRunArgs_repeated_profile_fails` |

## Test Case Catalog

```text
Group 1: parseRunArgs profile override (8 tests)
  parseRunArgs_extracts_profile_override
  parseRunArgs_no_override_omits_field
  parseRunArgs_missing_task_fails
  parseRunArgs_mid_task_profile_is_part_of_task
  parseRunArgs_profile_with_no_value_fails
  parseRunArgs_profile_option_looking_value_fails
  parseRunArgs_repeated_profile_fails
  parseRunArgs_profile_with_value_but_no_task_fails

Group 2: profileOverride threading (3 tests)
  executeChildRun_threads_profileOverride_builtIn
  executeChildRun_threads_profileOverride_registered
  runChildAgent_uses_override_when_provided

Group 3: profileOverride fail-closed / trust (9 tests)
  runChildAgent_uses_spec_profile_when_no_override
  runChildAgent_override_without_library_fails_closed
  runChildAgent_spec_profile_without_library_fails_closed
  runChildAgent_override_unregistered_project_profile_denies
  runChildAgent_override_unknown_profile_fails
  runChildAgent_override_not_in_child_argv
  runAgentCommand_registered_denied_with_profileOverride_does_not_spawn
  runChildAgent_override_project_profile_stale_registration_denies
  runChildAgent_override_uses_override_trust_metadata_not_spec_metadata

Group 4: resolveSpecProfile carries trust fields (2 tests)
  resolveSpecProfile_carries_canonical_path_and_hash
  resolveSpecProfile_builtin_profile_has_no_path_hash

Group 5: stdout spill + safety watermark (8 tests)
  spawnAndCollect_writes_stdout_to_secure_temp_file
  spawnAndCollect_surfaces_path_only_when_kept
  spawnAndCollect_does_not_kill_on_stdout_overflow
  spawnAndCollect_kills_at_safety_watermark
  spawnAndCollect_marks_output_limit_exceeded_on_safety_kill
  spawnAndCollect_fails_closed_when_tmp_dir_unwritable
  spawnAndCollect_rejects_invalid_or_huge_stdout_safety_limits
  spawnAndCollect_refuses_preexisting_stdout_symlink

Group 6: summary extraction + cleanup (5 tests)
  spawnAndCollect_summary_captures_final_message_after_large_tools
  spawnAndCollect_cleans_temp_file_on_success
  spawnAndCollect_keeps_temp_file_on_timeout
  spawnAndCollect_surfaces_path_on_safety_kill
  spawnAndCollect_spill_write_error_does_not_return_completed_empty_summary

Group 7: regression (all existing suites + smoke)
  run-p3b-1-tests.sh   (spec model + built-ins — no model change expected)
  run-p3c-1-tests.sh   (child argv builder — unrelated to stdout capture)
  run-p3c-2-tests.sh   (built-in child execution — stdout-limit assertions UPDATED: kill at safety watermark, not maxStdoutBytes)
  run-p3c-4-tests.sh   (ephemeral — profile override not used here)
  run-p3d-1-tests.sh   (run_subagent tool)
  run-p3f-1-tests.sh   (profiles pure helpers — ResolvedProfile gains 2 fields; add 2 tests)
  run-p3f-2-tests.sh   (profiles wiring — assertion on reasoning-deep profileProvidedModel unchanged; fast-local passthrough unchanged)
  run-p3f-3-tests.sh   (profile discovery + trust — canonicalPath/rawBytesSha256 now populated by resolveSpecProfile; trust tests still pass)
  manual: pi --no-extensions -e ./agents/index.ts --list-models
  manual: reviewer returns non-empty summaryText on a file-reading task

Assertion-change matrix (which existing assertions change semantics):
  | Suite | Assertion | Old | New |
  |---|---|---|---|
  | p3c-1 | stdout cap kills child at maxStdoutBytes | yes | no — spill continues; kill only at safety watermark |
  | p3c-2 | status='output-limit-exceeded' when stdout > maxStdoutBytes | yes | only when stdout > 50x maxStdoutBytes |
  | p3f-1 | ResolvedProfile has 7 fields | yes | 9 fields (added profileCanonicalPath, profileRawBytesSha256) |
  | p3f-3 | resolveSpecProfile result has no canonicalPath | yes | now populated |
```

Total: 35 automated tests + 1 SHOULD manual check (reviewer end-to-end).

## Risk Analysis

| Risk | Severity | Mitigation |
|---|---|---|
| Removing stdout kill masks runaway processes | Medium | Safety watermark at 50×; timeout unchanged; both still kill |
| Temp file fills /tmp | Low | 50MB safety watermark cap per run; unlinked on success; mkdtemp dir cleaned up |
| Temp file leaks prompt/task text | Medium | mkdtemp dir 0700 + file 0600; unlinked on success |
| Override changes trust semantics by accident | High | Reuse resolveSpecProfile + profileTrustCheck verbatim; add explicit denial tests |
| Spill file truncated by write error mid-run | Medium | Spill stream error sets `spillWriteError`, run continues best-effort, temp file kept for inspection |
| Breaking change to parseRunArgs return type | Low | Additive optional field; existing callers ignore it |
| Test fixture for "large tools" is slow/flaky | Medium | Use a fake spawner that emits a fixed large JSONL stream, not a real child Pi |

## Open Decisions

1. **Summarization source — DECIDED.** The spill file is the sole source of truth. After child exit and spill-stream `finish`/`close`, read the spill file for `reduceChildJsonl`. No tail buffer exists; no in-memory summarization path.
2. **Default `stdoutLimit` interpretation change.** Today `maxStdoutBytes` is both summary budget and kill threshold. After this change it is only the summary budget. Should we rename to `maxSummaryBytes`? Recommend NO — avoid churn; document the new semantics in JSDoc.
3. **Safety watermark multiplier.** 50× feels right for reviews but arbitrary. Make it a named constant so it can be tuned. Default 50, overridable per-spec.

## Done Criteria

All MUST requirements passing = done. In addition:

- [ ] (SHOULD, non-blocking) Reviewer agent returns non-empty `summaryText` on a task that requires reading ≥3 source files
- [ ] `/agents run planner --profile reasoning-deep "task"` resolves to the override profile's model
- [ ] `/agents run reviewer --profile security-review "task"` with an unregistered `security-review` denies

## Review Consensus

| Pass | Reviewer | Model | Blocker count | Verdict |
|---|---|---|---|---|
| 1 | gpt-5.5 plan review | gpt-5.5 | 8 | no-go |
| 2 | gpt-5.5 plan review r2 | gpt-5.5 | 6 | no-go |
| 3 | gpt-5.5 plan review r3 | gpt-5.5 | 5 | no-go |
| 4 | gpt-5.5 plan review r4 | gpt-5.5 | 3 | no-go |
| 5 | gpt-5.5 plan review r5 | gpt-5.5 | 0 | **go** |
| 6 | gpt-5.5 adversarial r1 | gpt-5.5 | 3 | no-go |
| 7 | gpt-5.5 adversarial r2 | gpt-5.5 | 0 | **go** |

### Resolved blockers

| # | Blocker | Resolution |
|---|---|---|
| R1-1 | Temp-file contract contradictory (surfaced path vs unlinked) | Path surfaced only when kept; unlinked on success |
| R1-2 | Predictable temp path | fs.mkdtemp dir 0700 + stdout.jsonl 0600 exclusive |
| R1-3 | Spill lifecycle underspecified | Await stream finish before reduce; fail-closed on open error |
| R1-4 | Unwritable fallback conflicts with correctness | Fail before spawn (no silent degrade) |
| R1-5 | Summary-source decision open | Option A: spill file is sole source of truth |
| R1-6 | Effective-spec contract unclear | effectiveSpec = {...spec, profile: override ?? spec.profile}; lookup failure = spawn-error |
| R1-7 | Regression scope incomplete | Full matrix of all 8 P3 suites + assertion-change table |
| R1-8 | parseRunArgs error states incomplete | Added states E/F/G + EC9-11 |
| R2-6 | Stale tail/path references across flow/contracts/cut order/catalog | Comprehensive sweep; all "tail" now explicitly "no tail" |
| R3-5 | outputLimitExceeded vs spillWriteError conflation | Made disjoint: outputLimitExceeded = safety kill only; spillWriteError = write error |
| R4-3 | Test count 28 vs 29 | Reconciled to 29 everywhere |

## Appendix: Implementation Plan

### Files to create

1. `agents/test-fixtures/test-p3f-4.mjs` — 35 tests covering all groups above (fake spawner for stdout-spill tests; real `resolveSpecProfile`/`runChildAgent` for override tests)
2. `agents/test-fixtures/run-p3f-4-tests.sh` — runner

### Files to modify

| File | Change |
|---|---|
| `agents/lib/run-resolver.ts` | `parseRunArgs`: add `--profile` extraction + optional `profileOverride` on result; `executeChildRun`: add `profileOverride?` param, thread to both runner calls; `runAgentCommand`: pass `parsed.profileOverride` through |
| `agents/lib/child-runner.ts` | `runBuiltInChildAgent`/`runChildAgent`: add `profileOverride?` param; compute `effectiveProfile`; add fail-closed when no library; pass resolved path/hash through (now populated by resolveSpecProfile). `spawnAndCollect`: replace head-cap-and-kill with temp-file spill + safety watermark (no tail); add `stdoutTmpPath?` to result |
| `agents/lib/profiles.ts` | `ResolvedProfile`: add `profileCanonicalPath?`, `profileRawBytesSha256?`; `resolveSpecProfile`: populate both from matched profile object |
| `agents/test-fixtures/test-profiles.mjs` | Add 2 tests for new ResolvedProfile fields (Group 4) — or fold into test-p3f-4 |
| `agents/test-fixtures/test-p3f-2-wiring.mjs` | If any test asserted absence of the new fields, update (none expected) |

### Implementation sequence

| Step | Action | Validation |
|---|---|---|
| 1 | `profiles.ts`: add fields to `ResolvedProfile`, populate in `resolveSpecProfile` | `run-p3f-1-tests.sh` green; new Group 4 tests green |
| 2 | `run-resolver.ts`: extend `parseRunArgs` + thread `profileOverride` through `executeChildRun`/`runAgentCommand` | Group 1 + Group 2 tests green; existing suites green |
| 3 | `child-runner.ts`: add `profileOverride?` to runners, `effectiveProfile`, fail-closed no-library | Group 2 + Group 3 tests green |
| 4 | `child-runner.ts`: rewrite `spawnAndCollect` spill+safety (no tail) | Group 5 + Group 6 tests green; existing P3c-1/P3c-2 limit tests green (update if semantics changed) |
| 5 | `test-p3f-4.mjs` + `run-p3f-4-tests.sh` | all 35 pass |
| 6 | Full regression: all 8 suites (P3b-1, P3c-1, P3c-2, P3c-4, P3d-1, P3f-1, P3f-2, P3f-3) + smoke | green |
| 7 | Manual: reviewer returns non-empty summary on file-reading task | observed non-empty |

### Risks

| Risk | Mitigation |
|---|---|
| Step 4 breaks P3c-1/P3c-2 limit semantics | Those tests use a fake spawner; update expectations to match new "no kill on overflow" + safety watermark |
| Temp-file tests are flaky on CI | Use `stdoutTmpDir` option pointing at a test-owned dir; assert file existence/absence deterministically |
| Reviewer manual check needs network + model | Mark as SHOULD; gate merge on automated tests only |
