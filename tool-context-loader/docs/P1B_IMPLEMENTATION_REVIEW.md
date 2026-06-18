# Tool Context Loader P1b Implementation Review

## Review Scope

Reviewed the P1b implementation changes in:

- `tool-context-loader/index.ts`
- `tool-context-loader/test-fixtures/test-preload.ts`
- `tool-context-loader/test-fixtures/run-p1a-tests.sh`
- `tool-context-loader/README.md`
- `tool-context-loader/VALIDATION_MATRIX.md`
- `.github/workflows/ci.yml`
- root `README.md`
- `WORKPLAN.md`

## Verdict

**Pass. Ready for deployment/PR review.**

P1b remains within the intended scope: `before_agent_start` appends a bounded metadata-only preload index for active tools. It does not read Markdown bodies, mutate tool calls, modify tool results, or duplicate built-in tool documentation.

## Findings

### Fixed During Review: diagnostics helper purity

Initial implementation tracked last-preload metadata in module state and displayed it from `formatDiagnostics`. That made `formatDiagnostics` less pure and could have introduced order-dependent tests.

Resolution: removed last-preload module state and kept diagnostics focused on discovery metadata. P1b preload helpers remain pure/testable.

### Fixed During Review: omitted preload records were count-only

`VC-018` expects omitted preload records to be listed by id/path when space allows. The first implementation only emitted a count-only omission notice.

Resolution: `buildPreloadIndex` now tries a detailed omitted-record list first, falls back to count-only if detailed output does not fit, and omits the notice entirely if neither fits. Added coverage in `testBudgetCapAndOmissions`.

### No Blocking Findings

No blocking issues found after the fixes above.

## Review Checklist

- [x] `before_agent_start` returns nothing when disabled or no selected-tool matches exist.
- [x] Missing/empty `selectedTools` produces no preload output.
- [x] Only records with `status: "eligible"` and `injection: "preload"` are selected.
- [x] Preload matching uses active tool intersection only.
- [x] Preload output is metadata-only: id, tools, source path, summary, priority.
- [x] `preload: body` does not trigger body injection in P1b.
- [x] No `fs.readFile` or body reads occur in preload helpers or `before_agent_start`.
- [x] Budgeting uses UTF-8 byte length and never exceeds the supplied max bytes.
- [x] Omitted preload records are listed by id/path when space allows, with count-only fallback.
- [x] Sorting is deterministic: priority desc, source precedence asc, path asc, id asc.
- [x] Built-in tool snippets/descriptions are not read or emitted.
- [x] Existing P1a discovery behavior remains covered.
- [x] CI now runs tool-context-loader tests.

## Validation Run

```bash
tool-context-loader/test-fixtures/run-p1a-tests.sh
# P1a discovery tests passed: 11/11
# P1b preload tests passed: 9/9

pi --no-extensions -e ./tool-context-loader/index.ts --list-models
# exit 0

scripts/verify-shared-sync.sh
scripts/test-security-scan.mjs
web-search/test-fixtures/run-redirect-fetch-tests.sh
npx --yes tsx permission-policy/test-fixtures/test-classification.ts
# all passed

git diff --check
# no whitespace errors
```

`pi -e ./tool-context-loader/index.ts -p "noop" --mode json` was documented for manual smoke, but not run here to avoid an unnecessary model/API call.

## Remaining Deferred Work

- P1c: `tool_call`/`tool_result` matching and advisory-wrapped body injection.
- P1d: per-turn dedupe and parallel result race-safety.
- P3: subagent child-process extension inheritance proof.
