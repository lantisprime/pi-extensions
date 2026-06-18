# P3f-4 Adversarial Plan Review

Reviewer: gpt-5.5 (via `pi --no-tools`)
Plan: `agents/P3F4_PROFILE_OVERRIDE_STDOUT_SPILL_PLAN.md`

## Rounds

| Round | Blockers | Verdict |
|---|---|---|
| 1 | 3 | no-go |
| 2 | 0 | **go** |

## Round 1 blockers (3) — all resolved

### B1: Override name may reach child argv
- **Invariant violated:** override name must never reach child argv
- **Exploit path:** `effectiveSpec = {...spec, profile: override}` is passed to `buildChildPiArgs`. If it serializes `spec.profile`, the override becomes a child argument and can influence child Pi outside the parent trust gate.
- **Resolution:** Split into `resolutionSpec` (for lookup/trust) and `childArgSpec` (profile field explicitly deleted/omitted). Added assertion test that the override string is absent from both the argv-building object and the final argv.

### B2: Write-stream error → false success
- **Invariant violated:** write-stream errors must not produce a misleadingly-empty "completed" summary
- **Exploit path:** spill write fails early (ENOSPC/EIO); `reduceChildJsonl` reads an empty/partial file and returns empty summary; child exits 0 → result reported as `completed`.
- **Resolution:** `spillWriteError` forces non-success status `spill-error` (even with exit 0); temp file kept + `stdoutTmpPath` surfaced; summary may be empty/partial but must NOT be reported as successful completed run.

### B3: Stdout limits not validated/clamped
- **Invariant violated:** stdout spill must remain bounded
- **Exploit path:** huge/Infinity/NaN `stdoutLimit` or `stdoutSafetyBytes` disables the cap → fills disk/memory before timeout. Ignored backpressure can buffer in memory.
- **Resolution:** finite positive integer validation (reject before spawn), `stdoutSafetyBytes` clamped to global max (256 MB), write-stream backpressure respected.

## Non-blocking concerns (resolved)
- `fs.mkdtemp(os.tmpdir(), "pi-agent-")` is wrong Node API → use `path.join(stdoutTmpDir, "pi-agent-")` prefix
- Open `stdout.jsonl` with `wx` flag (exclusive create, mode 0600)
- Clean up the empty mkdtemp directory on success (not just the file)

## Missing negative tests (all added — 6 tests)
- `runAgentCommand_registered_denied_with_profileOverride_does_not_spawn`
- `runChildAgent_override_project_profile_stale_registration_denies`
- `runChildAgent_override_uses_override_trust_metadata_not_spec_metadata`
- `runChildAgent_override_not_passed_to_buildChildPiArgs_even_as_profile_field`
- `spawnAndCollect_spill_write_error_does_not_return_completed_empty_summary`
- `spawnAndCollect_rejects_invalid_or_huge_stdout_safety_limits`
- `spawnAndCollect_refuses_preexisting_stdout_symlink`

## Round 2 — go

Confirmed all 3 blockers resolved. No new blockers. One non-blocking editorial (flow diagram said `effectiveSpec` instead of `childArgSpec`) — fixed.

## Verdict

**go** — plan accepted. Proceed to implementation per the Appendix sequence.
