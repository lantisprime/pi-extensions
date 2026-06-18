# Tool Context Loader P1d Plan Review

## Review Scope

Reviewed `tool-context-loader/P1D_PLAN.md` against:

- `tool-context-loader/DESIGN.md`
- `tool-context-loader/VALIDATION_MATRIX.md`
- `tool-context-loader/P1C_IMPLEMENTATION_REVIEW.md`
- current `tool-context-loader/index.ts` P1c implementation

## Verdict

**Proceed after adversarial review.**

The P1d plan targets the right remaining risk: synchronous claim-before-await state mutation for JIT tool-result injection, plus turn lifecycle and kill-switch validation. It intentionally does not broaden P1c matching or injection semantics, which is the correct safety boundary.

## Strengths

- Keeps P1c's explicit body-injection policy intact:
  - explicit frontmatter `injection: tool_result` remains required
  - no implicit bash fallback
  - no new tool/path matcher expansion
- Addresses the exact P1c deferral called out in the implementation review: parallel claim-before-await race safety.
- Separates `claimedThisTurn` from `injectedThisTurn`, avoiding ambiguous state semantics.
- Adds `reservedBytesThisTurn` so P1d addresses not just duplicate same-runbook races but also concurrent per-turn budget overshoot.
- Makes lifecycle behavior testable instead of relying only on Pi event hooks.
- Covers kill switches on the JIT path, not just discovery/preload.
- Keeps conservative under-injection acceptable when reservation estimates are intentionally high.

## Required Clarifications Folded Into Plan

### 1. Budget reservation must be conservative enough

A naive `record.maxBytes + constant` estimate could undercount wrapper text, reasons, display paths, and truncation notices. The plan now requires estimating by formatting a synthetic worst-case block using the same record/reason and excerpt budget, then omitting final output if it somehow exceeds the reserved budget.

### 2. Claims and reservations must occur before any await

The plan explicitly states no `await` may occur between match selection and claim/reservation state mutation.

### 3. Reset/off must clear pending matches

P1c already clears on `session_start` and `turn_start`; P1d extends cleanup to rescan and command toggles so stale pending matches cannot survive a kill switch.

## Non-Blocking Considerations

### Reservation may under-inject

Conservative reservations can cause lower-priority or concurrent matches to be omitted even when actual body excerpts would have fit. This is acceptable for P1d because correctness and configured budget enforcement are more important than maximizing injection volume.

### Testing live Pi concurrency remains hard

P1d should use deterministic helper-level tests for concurrency. A live Pi smoke test is optional; the validation contract can be automated at helper/event-simulation level.

### `dedupePerSession` remains inactive

The config includes `dedupePerSession`, but P1d can leave it deferred because the canonical next work is per-turn hardening. Do not implement session dedupe opportunistically unless it becomes trivial after refactor.

## Recommended Implementation Order

1. Add exported state/reset/claim helper types and tests first.
2. Refactor `tool_result` to use helpers without changing output formatting.
3. Add race and lifecycle tests.
4. Add kill-switch tests.
5. Update validation matrix and README if behavior changes.
6. Run full staged validation.

## Review Checklist

Before implementation PR:

- [ ] `tool_result` claims keys before first async body read.
- [ ] Duplicate same-runbook result handlers cannot both read/inject.
- [ ] Different parallel result handlers cannot exceed `maxInjectedBytesPerTurn`.
- [ ] Claims reset on `turn_start`.
- [ ] Pending matches reset on `turn_start`, rescan, and off.
- [ ] `VC-019` and `VC-020` are automated.
- [ ] Existing P1a/P1b/P1c tests still pass.
