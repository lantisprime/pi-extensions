# Tool Context Loader P1c Adversarial Plan Review

## Review Stance

Assume P1c will accidentally over-inject local Markdown, violate token budgets, or subtly alter tool semantics unless the plan is made stricter. This review focuses on failure modes introduced by moving from metadata-only preload to model-visible body injection.

Reviewed:

- `tool-context-loader/P1C_PLAN.md`
- `tool-context-loader/P1C_PLAN_REVIEW.md`
- `tool-context-loader/DESIGN.md`
- `tool-context-loader/VALIDATION_MATRIX.md`
- `tool-context-loader/P1B_IMPLEMENTATION_REVIEW.md`
- Pi extension docs for `tool_call`, `tool_result`, and parallel tool execution

## Executive Verdict

**Conditional go, but not as written.**

P1c is the first milestone that injects local file bodies into model-visible context. That is the highest-risk behavioral change in `tool-context-loader` so far. The plan is directionally correct, but it under-specifies several safety-critical details:

1. The configured `maxInjectedBytesPerTurn` cannot be honestly enforced if P1c defers all per-turn state to P1d.
2. `dedupePerTurn: true` exists in default config, but P1c says dedupe is deferred.
3. Broad `bash` tool-only fallback can cause frequent prompt-injection surface area with no user intent signal beyond any bash call.
4. Body injection should have a separate safety gate/opt-in story because Prompt Shield integration is explicitly out of scope.
5. Result patching and body-read failures need stricter contracts so guidance failures never affect tool semantics.

## Blocking Issues Before Implementation

### B-001: P1c claims per-turn budget but defers per-turn state

**Severity:** High

The plan says P1c enforces:

```text
per-turn aggregate: config.maxInjectedBytesPerTurn
```

But it also says P1d will add per-turn/session dedupe and race-safety, and P1c state is only `pendingToolCallMatches`.

That means two matching `tool_result` handlers in the same turn can each inject up to `maxInjectedBytesPerTurn`, exceeding the configured per-turn budget. This is especially likely in Pi's parallel tool mode.

**Required fix:** P1c must either:

1. implement minimal `injectedBytesThisTurn` accounting cleared on `turn_start`, or
2. rename/enforce the budget as per-result only and leave true per-turn enforcement deferred.

Recommendation: implement minimal per-turn byte accounting in P1c. Race-perfect accounting can wait for P1d, but a single-threaded deterministic helper should enforce the budget in normal cases.

### B-002: Default `dedupePerTurn: true` conflicts with deferring dedupe

**Severity:** High

`DEFAULT_CONFIG` already has:

```ts
dedupePerTurn: true
```

If P1c injects the same runbook multiple times in one turn while the config says dedupe is enabled, behavior violates the config contract and user expectation.

**Required fix:** choose one:

- P1c honors `dedupePerTurn` minimally with `injectedThisTurn` cleared on `turn_start`, leaving only parallel race-safety to P1d; or
- P1c explicitly ignores `dedupePerTurn` and documentation/config must say dedupe is not active until P1d.

Recommendation: implement minimal `injectedThisTurn` in P1c. It is small, testable, and prevents obvious duplicate injection. Keep claim-before-await parallel hardening for P1d.

### B-003: Broad `bash` tool-only fallback is too risky for body injection

**Severity:** High

The design allows tool-only fallback when no matchers are specified. For `read` or `edit`, this may be acceptable. For `bash`, it can inject a broad bash runbook after every shell command. That increases token usage and prompt-injection exposure.

**Required fix:** make broad-tool fallback stricter in P1c:

- For `bash`, require `match.commandIncludes` unless the runbook explicitly opts into broad matching with a new metadata field or an explicit empty matcher convention documented and tested.
- Alternatively, allow bash fallback but cap it to one very small excerpt and add an explicit warning in docs.

Recommendation: do **not** allow implicit bash tool-only body injection in P1c. Keep tool-only fallback for narrower tools and revisit bash fallback after P1d hardening.

### B-004: Body injection safety gate is weaker than the threat model

**Severity:** High

The plan excludes Prompt Shield integration and relies on trust roots, budgets, and advisory wrappers. Advisory wrappers are helpful but not sufficient: the model may still follow malicious local Markdown.

**Required fix:** P1c needs one additional safety gate before body injection:

- body injection only for records with explicit `injection: tool_result` in frontmatter, not merely default config; or
- project config must explicitly enable JIT bodies; or
- body injection disabled when Prompt Shield reports active dangerous/unapproved resources.

Current discovery defaults set `defaultInjection: "tool_result"`, so a runbook with `tools: [bash]` and no explicit injection mode can become body-injectable. That is too permissive for the first body-injection milestone.

Recommendation: P1c should require explicit `injection: tool_result` metadata for body injection. Default `tool_result` can remain for future compatibility only after P1d or Prompt Shield integration.

## Major Non-Blocking Risks

### R-001: Details patching can silently omit audit metadata

**Severity:** Medium

The conservative details rule avoids breaking renderers, but when `details` is undefined or primitive, injection occurs with no machine-readable audit metadata. That makes debugging harder.

**Recommendation:** keep content wrapper as the primary audit trail, but also consider a custom trailing text line with injected IDs. Do not force details into non-object details in P1c.

### R-002: Path revalidation must handle root disappearance

**Severity:** Medium

The plan says `realpath(record.root)`. If the root no longer exists, body read should skip safely, not warn noisily or throw.

**Recommendation:** add tests for:

- deleted body file
- deleted root directory
- file replaced by symlink escape after discovery

The symlink replacement test can be marked P1d if hard to implement, but deleted file/root should be P1c.

### R-003: Content type assumptions need explicit tests

**Severity:** Medium

Tool result content is `(TextContent | ImageContent)[]`. Appending text is valid, but tests should include an existing image content item to prove original non-text content is preserved first.

**Recommendation:** add result preservation test with mixed content, not only text content.

### R-004: Truncation can break Markdown fences

**Severity:** Medium

Naive byte/line truncation may cut inside a fenced code block. This is not fatal, but can confuse the model.

**Recommendation:** truncation notice should be unambiguous and outside the excerpt, e.g.:

```text

[tool-context-loader: excerpt truncated by byte/line budget]
```

Do not attempt smart Markdown repair in P1c.

### R-005: `tool_result` read failures can hide important operator feedback

**Severity:** Low/Medium

Skipping silently is safe but opaque.

**Recommendation:** accumulate skipped/omitted reasons in details when details is patchable, and include count-only omission text when any selected runbooks fail to load.

## Required Plan Changes Before Coding

Update `P1C_PLAN.md` before implementation with these decisions:

1. **Per-turn budget/dedupe decision**
   - Either implement minimal `injectedBytesThisTurn` and `injectedThisTurn`, or explicitly document that P1c budgets are per-result and `dedupePerTurn` is inactive until P1d.
   - Recommended: implement minimal per-turn byte accounting and dedupe; leave parallel race-safety to P1d.

2. **Explicit body-injection opt-in**
   - Require explicit frontmatter `injection: tool_result` for P1c body injection.
   - Do not body-inject records using only default injection mode.

3. **Bash fallback policy**
   - Require `match.commandIncludes` for `bash` P1c body injection unless an explicit broad-match opt-in is added.

4. **Failure-mode tests**
   - Add deleted body file/root tests.
   - Add mixed content preservation test.
   - Add explicit no-patch-on-no-injection test.

5. **Validation matrix accuracy**
   - If minimal dedupe remains deferred, do not mark VC-011/VC-019/VC-020 as covered.
   - If minimal dedupe is implemented, mark VC-011 as partial and still defer VC-020 parallel race safety.

## Revised Minimal P1c Slice Recommended

A safer P1c can be:

- Match explicit `injection: tool_result` records only.
- For `bash`, require `commandIncludes`.
- For `read/write/edit`, allow `pathIncludes` or narrow tool-only fallback.
- Implement simple `injectedThisTurn` and `injectedBytesThisTurn` cleared on `turn_start`.
- Claim/dedupe before async reads is still P1d; document race limitation.
- Append one text content item with one or more wrapped excerpts.
- Preserve original content/details/isError.

This preserves value while materially reducing prompt-injection and token-budget risk.

## Resolution Status

The blocking issues have been folded back into `tool-context-loader/P1C_PLAN.md`:

- P1c now requires minimal `injectedThisTurn` and `injectedBytesThisTurn` state cleared on `session_start`/`turn_start`; parallel claim-before-await race safety remains P1d.
- P1c now requires explicit frontmatter `injection: tool_result` via an `explicitInjection` record field; default-inherited `tool_result` does not body-inject.
- P1c now disallows implicit broad `bash` tool-only body injection; bash injection requires `match.commandIncludes`.
- P1c tests now include no implicit bash fallback, explicit injection required, per-turn budget accounting, minimal per-turn dedupe, missing body/root, mixed content preservation, and no-patch-on-no-injection cases.
- Validation matrix expectations now mark VC-011 as partial in P1c and keep VC-020 deferred to P1d.

## Final Recommendation

After the resolution updates above, P1c is acceptable to implement. Keep implementation aligned with the revised minimal slice: explicit body-injection opt-in, no implicit bash fallback, ordinary per-turn budget/dedupe, bounded advisory wrapper, no argument mutation, and conservative result patching.
