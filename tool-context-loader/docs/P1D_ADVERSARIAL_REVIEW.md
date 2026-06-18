# Tool Context Loader P1d Adversarial Review

## Review Question

Does the P1d plan actually close the dangerous race/lifecycle gaps left after P1c without accidentally broadening body injection or weakening tool-result semantics?

## Verdict

**Proceed with implementation only if the findings below remain explicit implementation requirements.**

P1d is a hardening milestone, not a feature expansion. The plan is sound after the budget-reservation clarification, but the implementation must be disciplined: no await before claims, no hidden broad matching, no stale pending matches after disable, and no result shape mutation beyond the existing conservative content/details patch.

## Findings

### Finding 1 — Claiming after body reads would make P1d a no-op

**Risk:** If the implementation still awaits `readRunbookBody()` before recording a claim, two parallel `tool_result` handlers can both decide the same runbook is available and both inject it.

**Required control:** The claim function must synchronously mutate `claimedThisTurn` before any async body read. Tests should use delayed body reads or staged promises to prove the second handler loses the claim before the first resolves.

**Status in plan:** Covered.

### Finding 2 — Same-runbook dedupe is not enough if per-turn budget can race

**Risk:** Two parallel handlers for different runbooks can both observe the same remaining byte budget and each inject under that stale budget, exceeding `maxInjectedBytesPerTurn` in aggregate.

**Required control:** Add `reservedBytesThisTurn`, reserve budget synchronously with the claim, and build each handler's injection using only that handler's reservation.

**Status in plan:** Covered after clarification.

### Finding 3 — Reservation estimates can accidentally undercount formatted output

**Risk:** A fixed overhead constant can miss long source paths, reasons, priority text, delimiters, and truncation notices. If final output can borrow unreserved budget, concurrent budget safety is weakened.

**Required control:** Estimate by actually formatting a synthetic worst-case block for the same record/reason. If final formatted output exceeds the reserved budget, omit it. Conservative under-injection is acceptable.

**Status in plan:** Covered.

### Finding 4 — Kill switch can be bypassed by stale pending matches

**Risk:** A tool call can match while enabled; then the user turns the extension off before the tool result arrives. If pending matches are not cleared and `tool_result` does not recheck enabled state, JIT content could still inject after disable.

**Required control:** Clear pending matches and runtime claim/budget state on off/rescan. Keep the `discoveryState.enabled` check in `tool_result` before claim/body read. Add a test for matched-then-off-then-result.

**Status in plan:** Covered.

### Finding 5 — Rescan can invalidate records while pending results still reference old paths

**Risk:** `pendingToolCallMatches` stores record objects. A rescan/reload after a tool call can leave pending matches pointing at stale files or old trust/config state.

**Required control:** Runtime reset on rescan/reload must clear pending matches before new discovery state is used. A pending result after reload should not inject old records.

**Status in plan:** Covered.

### Finding 6 — `dedupePerTurn: false` must not be accidentally broken

**Risk:** If P1d always consults `claimedThisTurn`, it changes behavior for configurations that intentionally disable per-turn dedupe.

**Required control:** Claim-key duplicate suppression should be conditional on `config.dedupePerTurn`. Budget reservation still applies regardless of dedupe because budget is an independent safety limit.

**Implementation note:** Tests should include at least one direct helper assertion for `dedupePerTurn: false` if this logic is touched.

**Status in plan:** Add during implementation if claim helper semantics are not obvious from existing tests.

### Finding 7 — Do not broaden JIT matching while touching the matcher path

**Risk:** Race-safety refactors may tempt adding grep/find/ls path parsing or broad bash fallback. That would reopen P1c's safety review.

**Required control:** P1d must not modify `matchRecordForTool` semantics except as needed for tests/types. Existing P1c negative tests must continue to pass.

**Status in plan:** Covered.

### Finding 8 — Do not patch `isError` or replace original content

**Risk:** New patch helper or simulation helpers might accidentally return a full replacement result with altered error semantics.

**Required control:** Keep P1c's conservative `patchToolResultContent`: original content first, append advisory text, extend plain-object details only, never return `isError`.

**Status in plan:** Covered by regression tests.

## Required P1d Tests

Minimum adversarial tests before implementation is accepted:

1. Same record, two concurrent result handlers, delayed body reads: exactly one injection.
2. Different records, concurrent result handlers, constrained budget: total injected bytes <= configured budget.
3. Matched pending call, then reset/off, then result: no injection.
4. Same record same turn: second claim omitted when `dedupePerTurn` true.
5. Same record next turn after reset: claim/injection allowed again.
6. Existing P1c no implicit bash fallback and explicit-injection-required tests still pass.

## Supplemental Findings From Round 2 Review

### Finding 9 — Global singleton state will make race tests brittle

**Risk:** Exporting helpers that operate only on module-level singleton state will make tests order-dependent. A failed test could leave claims/reservations behind and mask or cause later failures.

**Required control:** Add a `ToolContextRuntimeState` object and `createRuntimeState()` helper. Event handlers can use a singleton, but tests should pass fresh state objects to claim/reset/finalize helpers.

**Status in plan:** Folded in.

### Finding 10 — Reservation based only on maxRunbookBytes can cause pathological under-injection

**Risk:** If reservation uses `min(record.maxBytes, config.maxRunbookBytes)` but ignores known `record.bodyBytes`, a small real body can be omitted whenever `maxInjectedBytesPerTurn` is less than the configured per-runbook cap. Users lowering per-turn budget would get zero injection instead of a bounded/truncated excerpt.

**Required control:** Estimate against `min(record.bodyBytes, record.maxBytes, config.maxRunbookBytes)` and permit reserving the remaining budget for a minimal advisory block plus non-empty excerpt when a full upper-bound reservation does not fit.

**Status in plan:** Folded in.

### Finding 11 — Reset after async rescan is too late

**Risk:** If `/tool-context-loader off` or `rescan` awaits discovery before clearing pending matches, a tool result could arrive during the await and inject stale context.

**Required control:** Reset runtime state before async rescan/toggle work begins, then continue to recheck `discoveryState.enabled` in `tool_result`.

**Status in plan:** Folded in.

### Finding 12 — Omission metadata can silently disappear

**Risk:** Records excluded during claim/reservation happen before `buildToolResultInjection`, so they may not appear in `details.toolContextLoader.omitted` unless explicitly passed through. This is mostly observability, not safety.

**Required control:** Prefer adding claim-stage omissions to the final `omitted` list when a patch is produced. If no patch is produced, no details patch is required.

**Status in plan:** Implementation note; not a blocker.

## Final Recommendation

Implement P1d in small helper-first commits or one carefully reviewed PR:

1. State/helper extraction and tests.
2. Event-handler integration.
3. Validation matrix/docs.

Do not start P3/subagent work until P1d is merged and deployed.
