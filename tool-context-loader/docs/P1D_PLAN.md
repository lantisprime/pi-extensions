# Tool Context Loader P1d Plan: Hardening + Validation Matrix Closure

## Objective

Harden the P1c JIT injection path so it is safe under turn lifecycle resets, kill switches, and concurrent tool results. Close the remaining `tool-context-loader/DESIGN.md` validation contracts by making `VC-019` and `VC-020` automated and re-auditing `VC-001` through `VC-024`.

P1d should not broaden matching or injection semantics. It should make the existing explicit-opt-in P1c behavior more deterministic and race-safe.

## Source of Truth

The canonical repo workplan lives in episodic memory, not `WORKPLAN.md`.

- Project: `pi-extensions`
- Tag: `canonical-workplan`
- Current milestone: P1d hardening
- Current canonical revision: `20260614-091340-canonical-workplan-updated-after-p1c-p1d-1621`

## Design References

- Episodic memory canonical workplan (`canonical-workplan` tag)
- `tool-context-loader/DESIGN.md`
- `tool-context-loader/VALIDATION_MATRIX.md`
- `tool-context-loader/P1C_IMPLEMENTATION_REVIEW.md`
- Pi extension docs for `turn_start`, `tool_call`, `tool_result`, command handlers, and result patching

## Current P1c Baseline

P1c currently has:

- metadata-only `tool_call` matching
- explicit frontmatter `injection: tool_result` required for JIT body injection
- no implicit broad bash fallback
- lazy body reads with root containment revalidation
- advisory-wrapped bounded result patches
- ordinary sequential per-turn dedupe via `injectedThisTurn`
- ordinary sequential per-turn byte accounting via `injectedBytesThisTurn`

Known P1c deferrals:

- `VC-019` dedupe reset across turns lacks direct lifecycle tests.
- `VC-020` parallel result race safety is deferred.
- Concurrent different-runbook injections can observe the same byte budget before either async body read completes.
- Pending tool-call maps are only reset on `session_start`/`turn_start`; P1d should make cleanup explicit around rescan/off paths.

## Scope

### In

- Implement claim-before-await race safety for `tool_result`.
- Keep claims synchronous and deterministic before any async body read.
- Add budget reservation before async body reads so concurrent result handlers cannot exceed `maxInjectedBytesPerTurn`.
- Clear pending/claim/budget state on:
  - `session_start`
  - `turn_start`
  - `resources_discover` reload rescans
  - `/tool-context-loader on|off|rescan`
- Add testable helper functions for turn lifecycle and race safety without needing a live Pi event bus.
- Add deterministic tests for:
  - same runbook matched by two parallel results injects once
  - dedupe resets on next turn
  - per-turn budget resets on next turn
  - no stale pending matches after turn reset/rescan/off
  - JIT disabled when config `enabled: false`
  - JIT disabled after `/tool-context-loader off` equivalent state reset
  - parallel different-runbook result handlers do not exceed per-turn budget
- Update `VALIDATION_MATRIX.md` so `VC-019` and `VC-020` are automated.
- Re-audit all `VC-001` through `VC-024` statuses.
- Update README if user-visible lifecycle or diagnostics behavior changes.

### Out

- No new matching surfaces beyond P1c's direct `bash.command` and direct `read`/`write`/`edit.path` rules.
- No implicit bash fallback.
- No body injection for records without explicit frontmatter `injection: tool_result`.
- No LLM-based relevance classification.
- No Prompt Shield risk-state integration for body suppression.
- No agent/subagent implementation.
- No session-persistent dedupe unless it is a tiny internal refactor required for turn tests; `dedupePerSession` can remain deferred/inactive.

## Proposed Implementation

### 1. Rename and split state by purpose

Replace the ambiguous P1c use of `injectedThisTurn` as both future claim target and injected output record with an explicit runtime state object:

```ts
export type ToolContextRuntimeState = {
	pendingToolCallMatches: Map<string, ToolCallMatch[]>;
	claimedThisTurn: Set<string>;
	injectedThisTurn: Set<string>;
	injectedBytesThisTurn: number;
	reservedBytesThisTurn: number;
};
```

The extension can keep a singleton `runtimeState`, but tests should exercise pure helpers against fresh `ToolContextRuntimeState` objects to avoid global singleton test coupling.

Definitions:

- `pendingToolCallMatches`: metadata-only matches keyed by `toolCallId`.
- `claimedThisTurn`: runbook claim keys synchronously claimed before body reads.
- `injectedThisTurn`: claim keys that actually produced injected output.
- `injectedBytesThisTurn`: actual bytes appended to tool results.
- `reservedBytesThisTurn`: conservative bytes reserved by in-flight result handlers.

`toolContextClaimKey(record)` remains:

```ts
`${record.id}:${record.injection}`
```

### 2. Add deterministic reservation helpers

Add pure helpers:

```ts
export function createRuntimeState(): ToolContextRuntimeState;
export function estimateBodyInjectionReservation(match: ToolCallMatch, loaderConfig: LoaderConfig): number;
export function remainingInjectionBudget(state: ToolContextRuntimeState, loaderConfig: LoaderConfig): number;
export function claimMatchesForTurn(matches, state, loaderConfig): ClaimedToolCallMatch[];
export function finalizeClaimedInjection(state, claimed, injection): void;
export function releaseClaimedInjection(state, claimed): void;
```

Reservation policy:

- Estimate each claimed record's upper-bound block bytes by formatting a synthetic worst-case block with the same record/reason and an excerpt budget of `min(record.bodyBytes, record.maxBytes, config.maxRunbookBytes)` plus the truncation notice. Do not hand-wave the wrapper overhead.
- Claim records in the same ordering used for injection.
- Duplicate claim-key suppression is conditional on `config.dedupePerTurn`; budget reservation applies regardless because budget is an independent safety limit.
- Only claim while `injectedBytesThisTurn + reservedBytesThisTurn + nextReservation <= maxInjectedBytesPerTurn`.
- If a single matching record's reservation is larger than remaining budget, allow reserving the remaining budget only when the remaining budget can fit a minimal advisory block plus a non-empty excerpt; otherwise omit it for this result. This prevents pathological under-injection when actual bodies are small or can be truncated to fit.
- Reservations may be conservative; P1d prefers under-injection over exceeding the configured per-turn budget.
- If final formatted output would exceed the handler's reserved budget anyway, truncate/assemble within that reserved budget where possible; otherwise omit it rather than borrowing unreserved global budget.
- On successful injection finalization:
  - decrement `reservedBytesThisTurn` by the reservation amount
  - increment `injectedBytesThisTurn` by actual injected byte length
  - add actually injected keys to `injectedThisTurn`
- On no injection/read failure/error path:
  - release reservation
  - leave `claimedThisTurn` claimed until next turn when `dedupePerTurn` is enabled, preventing a same-turn retry race

### 3. Claim before async reads in `tool_result`

Current P1c flow filters already-injected records and awaits body reads before marking records. P1d should change this to:

1. Synchronously get and delete `pendingToolCallMatches[event.toolCallId]`.
2. Return immediately if disabled or no matches.
3. Synchronously claim eligible matches and reserve budget.
4. Await `readRunbookBody` only for claimed matches.
5. Build injection with the claimed handler's reserved byte budget, not the pre-race global remaining budget.
6. Finalize actual injected bytes and metadata.
7. Release reservations on all return/error paths.

Important: no `await` may occur between the dedupe/budget claim and the state mutation that records the claim.

### 4. State reset helpers

Add one public/testable reset helper:

```ts
export function resetTurnInjectionState(state?: ToolContextRuntimeState): void;
export function resetLoaderRuntimeState(state?: ToolContextRuntimeState): void;
```

Expected behavior:

- `resetTurnInjectionState`: clears pending tool-call matches, claimed keys, injected keys, injected bytes, and reserved bytes.
- `resetLoaderRuntimeState`: calls turn reset and is used on `session_start`, rescan, and command toggles.
- Reset should happen before rescans/toggles perform async work so stale pending matches are cleared even if a rescan later fails.

If future session dedupe is added, it should not be cleared by `turn_start`, but P1d can leave that out.

### 5. JIT kill-switch coverage

P1c's `discover` returns no records when disabled and `tool_call`/`tool_result` check `discoveryState.enabled`. P1d should add direct tests proving:

- config `enabled: false` yields no discovery records and no JIT patch
- a simulated `/tool-context-loader off` flow clears pending matches and prevents a previously matched pending call from injecting
- `before_agent_start` remains disabled because `selectPreloadRecords` returns empty when `state.enabled` is false

Implementation can expose small helpers rather than driving actual slash command handlers.

### 6. Tests

Add `tool-context-loader/test-fixtures/test-p1d-hardening.ts` and include it in `run-p1a-tests.sh`.

Proposed test cases:

1. **claim before await same runbook:** two matches for the same record are claimed sequentially before either body read; second claim returns empty.
2. **parallel same-runbook e2e:** two simulated tool results share a runbook and delayed body reads; only one patch contains the body.
3. **parallel budget reservation:** two different high-priority records run concurrently with a small budget; combined actual injected bytes never exceed `maxInjectedBytesPerTurn`.
4. **dedupe reset on next turn:** same record claims once, second same-turn claim omitted, after reset it can claim again.
5. **budget reset on next turn:** exhausted budget allows no claim until reset; after reset claim succeeds.
6. **pending cleanup on reset:** pending matches are cleared by reset before result handling.
7. **config disabled no JIT:** disabled discovery/config path produces no result patch.
8. **off-toggle no stale injection:** matched pending call followed by runtime reset/off cannot inject.
9. **dedupe disabled helper behavior:** when `dedupePerTurn` is false, duplicate claim keys are not suppressed, while budget reservation still applies.
10. **P1a/P1b/P1c regression:** existing runner still passes all earlier tests.

### 7. Validation matrix update

Update:

- `VC-019 dedupe resets on next turn` -> Automated in P1d
- `VC-020 parallel result race safety` -> Automated in P1d

Add a P1d-specific section:

| Contract | Status | Coverage |
| --- | --- | --- |
| P1D-001 claim-before-await same runbook | Automated | `test-p1d-hardening.ts` |
| P1D-002 parallel same-runbook e2e | Automated | `test-p1d-hardening.ts` |
| P1D-003 parallel budget reservation | Automated | `test-p1d-hardening.ts` |
| P1D-004 dedupe reset on next turn | Automated | `test-p1d-hardening.ts` |
| P1D-005 budget reset on next turn | Automated | `test-p1d-hardening.ts` |
| P1D-006 pending cleanup on reset | Automated | `test-p1d-hardening.ts` |
| P1D-007 config disabled no JIT | Automated | `test-p1d-hardening.ts` |
| P1D-008 off-toggle no stale injection | Automated | `test-p1d-hardening.ts` |
| P1D-009 full validation matrix audit | Automated/docs | `VALIDATION_MATRIX.md` |

## Done Criteria

- P1d plan/review/adversarial review are committed before or with implementation.
- Race-safety state changes are covered by pure deterministic tests.
- `tool_result` performs claims and budget reservations before any async body reads.
- Same-runbook concurrent tool results inject once per turn when `dedupePerTurn` is true.
- Concurrent JIT injections do not exceed `maxInjectedBytesPerTurn`; conservative under-injection is acceptable.
- Turn reset restores eligibility for per-turn dedupe and budget.
- Runtime reset/off clears stale pending matches.
- `VALIDATION_MATRIX.md` maps every `VC-001` through `VC-024` to automated, smoke, or deferred status; P1d should leave no P1-specific deferred VC unless explicitly justified.
- README updated if behavior visible to users changes.
- Validation passes:

```bash
tool-context-loader/test-fixtures/run-p1a-tests.sh
pi --no-extensions -e ./tool-context-loader/index.ts --list-models
git diff --check
```

Optional broad regression before PR:

```bash
permission-policy/test-fixtures/run-all-tests.sh
scripts/verify-shared-sync.sh
scripts/test-security-scan.mjs
web-search/test-fixtures/run-redirect-fetch-tests.sh
```

## Rollback

- `/tool-context-loader off` disables discovery/injection for the current session.
- Project config `enabled: false` disables scan/preload/JIT for that project.
- Remove or replace `~/.pi/agent/extensions/tool-context-loader/index.ts` to revert the deployed extension.
