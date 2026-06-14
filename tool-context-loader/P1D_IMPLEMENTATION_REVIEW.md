# Tool Context Loader P1d Implementation Review

## Review Scope

Reviewed the P1d hardening implementation in:

- `tool-context-loader/index.ts`
- `tool-context-loader/test-fixtures/test-p1d-hardening.ts`
- `tool-context-loader/test-fixtures/run-p1a-tests.sh`
- `tool-context-loader/VALIDATION_MATRIX.md`
- `tool-context-loader/README.md`
- root `README.md`

## Verdict

**Pass for local implementation. Ready for PR review after final validation.**

The implementation fixes the adversarial findings from P1d planning without broadening P1c JIT injection semantics.

## Confirmed Fixes

- Added explicit runtime state object via `ToolContextRuntimeState` and `createRuntimeState()` so tests can use fresh isolated state.
- Added claim-before-await helpers:
  - `claimMatchesForTurn`
  - `finalizeClaimedInjection`
  - `releaseClaimedInjection`
  - `remainingInjectionBudget`
  - `estimateBodyInjectionReservation`
- Added `reservedBytesThisTurn` to prevent concurrent tool-result handlers from each observing the same remaining per-turn budget.
- `tool_result` now claims and reserves synchronously before lazy body reads.
- Runtime state is reset and discovery is immediately suspended before rescans/toggles perform async work, preventing stale discovery state from matching while reload/off is in progress.
- Existing P1c matching constraints remain unchanged:
  - explicit `injection: tool_result` required
  - no implicit broad bash fallback
  - no new matcher surfaces
- Result patch semantics remain conservative:
  - original content first
  - `isError` untouched
  - plain-object details extended only under `toolContextLoader`
- Budget assembly can now truncate a body excerpt to fit the handler's reserved budget instead of borrowing unreserved global budget.

## Tests Added

`tool-context-loader/test-fixtures/test-p1d-hardening.ts` covers:

1. claim-before-await same-runbook suppression
2. parallel same-runbook e2e injection once
3. parallel different-runbook budget reservation
4. dedupe reset on next turn
5. budget reset on next turn
6. pending cleanup on reset
7. config disabled no JIT/preload
8. off-toggle stale pending injection prevention
9. rescan suspension disables stale state immediately
10. `dedupePerTurn: false` does not suppress duplicate claim keys while budget still applies
11. negative tiny budget returns no patch and leaks no reservation
12. negative body read failure returns no patch and holds same-turn claim
13. end-to-end discovered parallel same-runbook injection occurs once
14. end-to-end suspend between call and result returns no patch

## Validation Run

```bash
tool-context-loader/test-fixtures/run-p1a-tests.sh
# P1a discovery tests passed: 11/11
# P1b preload tests passed: 9/9
# P1c JIT tests passed: 11/11
# P1c JIT end-to-end tests passed: 5/5
# P1d hardening tests passed: 14/14

pi --no-extensions -e ./tool-context-loader/index.ts --list-models
# exit 0

git diff --check
# clean
```

## Remaining Deferred Work

- Direct Prompt Shield risk-state integration for body suppression remains future work.
- P3 child Pi subprocess/global extension inheritance proof remains after P1d is merged and deployed.
- Full agent/subagent workflows remain deferred until after P3 proof.
