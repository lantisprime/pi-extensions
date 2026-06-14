# Tool Context Loader P1c Implementation Review

## Review Scope

Reviewed the P1c implementation changes in:

- `tool-context-loader/index.ts`
- `tool-context-loader/test-fixtures/test-jit.ts`
- `tool-context-loader/test-fixtures/test-jit-e2e.ts`
- `tool-context-loader/test-fixtures/test-discovery.ts`
- `tool-context-loader/test-fixtures/test-preload.ts`
- `tool-context-loader/test-fixtures/run-p1a-tests.sh`
- `tool-context-loader/README.md`
- `tool-context-loader/VALIDATION_MATRIX.md`
- root `README.md`
- P1c planning/review docs

## Verdict

**Pass for local implementation. Ready for PR review after final validation.**

P1c implements the tightened plan: explicit opt-in JIT body injection only, no implicit broad bash fallback, metadata-only `tool_call` matching, lazy bounded `tool_result` body append, conservative result patching, ordinary per-turn dedupe/budget accounting, and deterministic negative/end-to-end tests.

## Findings

### No blocking findings

No blocking issues found in the implementation review.

### Confirmed adversarial-review fixes

- Explicit frontmatter `injection: tool_result` is required via `RunbookRecord.explicitInjection`.
- Records that only inherit `defaultInjection: "tool_result"` do not body-inject.
- Bash JIT body injection requires `match.commandIncludes`; no implicit bash tool-only fallback.
- P1c adds ordinary per-turn state:
  - `pendingToolCallMatches`
  - `injectedThisTurn`
  - `injectedBytesThisTurn`
- Parallel claim-before-await race-safety remains explicitly deferred to P1d.
- Tool arguments are not mutated.
- Original tool result content remains first; `isError` is not patched.
- Details are only extended when existing details are a plain object.
- Body text is lazily read and not retained on records.

## Test Coverage Added

### Unit/helper-style JIT tests

`tool-context-loader/test-fixtures/test-jit.ts` covers:

- bash command trigger
- nonmatching bash command
- edit path trigger
- inactive tool exclusion
- read tool-only fallback
- no implicit bash fallback
- explicit injection required
- no argument mutation
- lazy body read and no retention
- missing/deleted body/root safety
- advisory wrapper
- per-record and aggregate budget behavior
- ordinary per-turn dedupe helper behavior
- result preservation with mixed text/image content
- no patch when no injection exists

### Deterministic end-to-end tests

`tool-context-loader/test-fixtures/test-jit-e2e.ts` covers discovery -> matching -> lazy body read -> injection assembly -> result patch:

- positive kubectl bash injection
- negative nonmatching command
- negative default-inherited injection no patch
- negative untrusted project no patch
- negative deleted body no patch

## Validation Run

```bash
tool-context-loader/test-fixtures/run-p1a-tests.sh
# P1a discovery tests passed: 11/11
# P1b preload tests passed: 9/9
# P1c JIT tests passed: 11/11
# P1c JIT end-to-end tests passed: 5/5

pi --no-extensions -e ./tool-context-loader/index.ts --list-models
# exit 0

git diff --check
# no whitespace errors

scripts/verify-shared-sync.sh
scripts/test-security-scan.mjs
web-search/test-fixtures/run-redirect-fetch-tests.sh
npx --yes tsx permission-policy/test-fixtures/test-classification.ts
# all passed
```

## Deferred Work

- P1d: parallel claim-before-await race-safety.
- P1d: optional per-session dedupe behavior.
- P1d: fuller turn lifecycle and parallel result duplicate tests.
- Future: direct Prompt Shield risk-state integration for body suppression.
- P3: subagent child-process extension inheritance proof.
