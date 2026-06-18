# P3d-2 Chain Mode Plan Review

## Review context

Plan reviewed:

- `agents/P3D2_CHAIN_MODE_PLAN.md`
- Compared against `agents/PLAN_TEMPLATE.md`

Review method:

- Built-in review agent: `/agents run reviewer` loaded via `pi -e ./agents/index.ts --model openrouter/anthropic/claude-opus-4-8`.
- The child reviewer process exceeded its output limit and returned no usable text, but the parent review agent produced a thorough review against the template.

## Blocking issues

1. **B1 — Test count mismatch.** Group 4 says (8 tests) but has 9. Grand total 21 but catalog lists 22. Slice ladder says 21.
2. **B2 — 3 catalog tests have no REQ mapping.** `testChainStopsOnMidChainHashMismatch`, `testChainStopsOnMidChainTimeout`, and `testChainMultilineTask` appear in the catalog but not in any Requirements row.
3. **B3 — Missing error codes.** `timeout`, `limit-exceeded`, and `hash-mismatch` are not in the error codes table but EC2/EC7 reference them.
4. **B4 — `ChainRunOutcome` failure variant has no `code` field.** Spawn-stage error codes cannot be carried by the type.
5. **B5 — Handoff source contradiction.** REQ-4 says `summary.summaryText` but Risk Analysis says "formatted result." No concrete accumulation cap.

## Non-blocking issues

- State D should specify whether prior successful agents' results are surfaced on chain abort.
- `testChainParsesBuiltInAndRegisteredNames` is in Group 4 (Execution) but is a parsing test.

## Missing tests/validation

None remaining beyond B1-B5 coverage.

## Safety/security concerns

None beyond those addressed in the plan.

## Verdict

request-changes

## Follow-up applied

All 5 blockers resolved:
- **B1**: Group 4 count fixed to 9, total to 22, slice ladder to 22.
- **B2**: Mapped EC2/EC7 tests to REQ-5, EC4 (`testChainMultilineTask`) to REQ-1.
- **B3**: Added `timeout`, `limit-exceeded`, `hash-mismatch` to error codes table.
- **B4**: Added `code: string` to `ChainRunOutcome` failure variant.
- **B5**: REQ-4 now specifies `summary.summaryText` vs `formatChildAgentRunResult`. Added `MAX_ACCUMULATED_HANDOFF_CHARS = 24000`. Risk Analysis updated.
