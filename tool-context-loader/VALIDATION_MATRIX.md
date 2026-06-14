# Tool Context Loader Validation Matrix

Maps `tool-context-loader/DESIGN.md` validation contracts to P1a coverage and later milestones.

| Contract | Status | Coverage |
| --- | --- | --- |
| VC-001 trusted project gate | Automated in P1a | `test-discovery.ts`: untrusted project skips project roots while global roots may scan. |
| VC-002 deterministic discovery | Automated in P1a | `test-discovery.ts`: repeated discovery has stable record projection. |
| VC-003 invalid frontmatter isolation | Automated in P1a | `test-discovery.ts`: invalid file warning, valid records still load. |
| VC-004 active-tool preload | Automated in P1b | `test-preload.ts`: active selected tool includes matching `injection: preload` metadata index entry. |
| VC-005 no inactive-tool preload | Automated in P1b | `test-preload.ts`: inactive selected tools and empty/missing selected tools produce no preload output. |
| VC-006 bash command trigger | Automated in P1c | `test-jit.ts` and `test-jit-e2e.ts`: explicit `injection: tool_result` bash runbook matches `commandIncludes`. |
| VC-007 non-matching bash command | Automated in P1c | `test-jit.ts` and `test-jit-e2e.ts`: nonmatching bash command returns no match/patch. |
| VC-008 path trigger | Automated in P1c | `test-jit.ts`: `edit.path` matching `.github/workflows/`; P1c path support limited to read/write/edit direct path fields. |
| VC-009 budget enforcement | Automated in P1b/P1c | `test-preload.ts`: preload budget; `test-jit.ts`: body excerpt, aggregate, and per-turn remaining budget behavior. |
| VC-010 priority ordering | Automated in P1c | `test-jit.ts`: body injection ordering follows priority/source/path/id ordering. |
| VC-011 per-turn dedupe | Partially automated in P1c | `test-jit.ts`: ordinary sequential dedupe helper coverage; parallel race-safety deferred to P1d. |
| VC-012 tool result preservation | Automated in P1c | `test-jit.ts` and `test-jit-e2e.ts`: original text/image content stays first, details are preserved/extended only for plain objects, `isError` is not patched. |
| VC-013 no argument mutation | Automated in P1c | `test-jit.ts`: matching leaves input deep-equal to original. |
| VC-014 path escape rejection | Automated in P1a | `test-discovery.ts`: symlink escape skipped. |
| VC-015 missing roots are safe | Automated in P1a | `test-discovery.ts`: missing roots produce zero records and no throw. |
| VC-016 command diagnostics | Automated in P1a | `test-discovery.ts`: diagnostics include counts/metadata and omit bodies. Live command smoke remains manual. |
| VC-017 lazy body loading | Automated in P1a/P1c | `test-discovery.ts`: records do not retain body text; `test-jit.ts`: body is read lazily by helper and not stored on records. |
| VC-018 preload token budget | Automated in P1b | `test-preload.ts`: preload index stays under `maxPreloadBytesPerTurn`-style byte limits and reports omitted records when possible. |
| VC-019 dedupe resets on next turn | Deferred to P1d | Requires turn lifecycle. |
| VC-020 parallel result race safety | Deferred to P1d | Requires concurrent `tool_result` claim tests. |
| VC-021 advisory wrapper present | Automated in P1c | `test-jit.ts` and `test-jit-e2e.ts`: injected body output contains `[tool-context-loader]` and advisory higher-priority instruction notice. |
| VC-022 unmapped episodes skipped | Automated in P1a | `test-discovery.ts`: unmapped episodes are status `unmapped`, not `eligible`. |
| VC-023 body not retained with lazy loading | Automated in P1a | `test-discovery.ts`: records have no `body` property; diagnostics omit body text. |
| VC-024 tool docs are not duplicated | Automated in P1b | `test-preload.ts`: preload output includes local metadata only and omits built-in/tool-snippet documentation sentinels. |

## P1a-Specific Contracts

| Contract | Status | Coverage |
| --- | --- | --- |
| P1A-001 missing roots safe | Automated | `test-discovery.ts` |
| P1A-002 untrusted project gate | Automated | `test-discovery.ts` |
| P1A-003 deterministic discovery | Automated | `test-discovery.ts` |
| P1A-004 valid frontmatter parsed | Automated | `test-discovery.ts` |
| P1A-005 invalid frontmatter isolated | Automated | `test-discovery.ts` |
| P1A-006 oversized discovery file skipped | Automated | `test-discovery.ts` |
| P1A-006a disabled config scans nothing | Automated | `test-discovery.ts` |
| P1A-006b non-directory root skipped | Automated | `test-discovery.ts` |
| P1A-007 unmapped episodes diagnostics-only | Automated | `test-discovery.ts` |
| P1A-008 tag-mapped episodes eligible | Automated | `test-discovery.ts` |
| P1A-008a global tool-mapped episodes diagnostics-only by default | Automated | `test-discovery.ts` |
| P1A-009 source precedence dedupe | Automated | `test-discovery.ts` |
| P1A-010 symlink escape rejected | Automated | `test-discovery.ts` |
| P1A-011 diagnostics omit bodies | Automated | `test-discovery.ts` |
| P1A-012 diagnostics output capped | Automated | `test-discovery.ts` |

## P1b-Specific Contracts

| Contract | Status | Coverage |
| --- | --- | --- |
| P1B-001 active-tool preload | Automated | `test-preload.ts` |
| P1B-002 inactive-tool exclusion | Automated | `test-preload.ts` |
| P1B-003 preload mode required | Automated | `test-preload.ts` |
| P1B-004 budget cap | Automated | `test-preload.ts` |
| P1B-005 deterministic ordering | Automated | `test-preload.ts` |
| P1B-006 bodies omitted | Automated | `test-preload.ts` |
| P1B-007 no built-in tool docs duplicated | Automated | `test-preload.ts` |
| P1B-008 disabled config | Automated | `test-preload.ts` |
| P1B-009 empty active tools | Automated | `test-preload.ts` |

## P1c-Specific Contracts

| Contract | Status | Coverage |
| --- | --- | --- |
| P1C-001 bash command trigger | Automated | `test-jit.ts`, `test-jit-e2e.ts` |
| P1C-002 nonmatching bash command | Automated | `test-jit.ts`, `test-jit-e2e.ts` |
| P1C-003 path trigger | Automated | `test-jit.ts` |
| P1C-004 inactive tool excluded | Automated | `test-jit.ts` |
| P1C-005 tool-only fallback for read/write/edit | Automated | `test-jit.ts` |
| P1C-005a no implicit bash fallback | Automated | `test-jit.ts` |
| P1C-006 no argument mutation | Automated | `test-jit.ts` |
| P1C-007 result preservation | Automated | `test-jit.ts` |
| P1C-008 advisory wrapper | Automated | `test-jit.ts`, `test-jit-e2e.ts` |
| P1C-009 per-record budget | Automated | `test-jit.ts` |
| P1C-010 aggregate budget | Automated | `test-jit.ts` |
| P1C-010a per-turn budget accounting | Automated | `test-jit.ts` |
| P1C-010b minimal per-turn dedupe | Automated | `test-jit.ts` |
| P1C-011 body not retained | Automated | `test-jit.ts` |
| P1C-012 read errors safe | Automated | `test-jit.ts`, `test-jit-e2e.ts` |
| P1C-012a mixed content preservation | Automated | `test-jit.ts` |
| P1C-012b no patch on no injection | Automated | `test-jit.ts`, `test-jit-e2e.ts` |
| P1C-013 explicit injection required | Automated | `test-jit.ts`, `test-jit-e2e.ts` |
| P1C-014 P1a/P1b regression | Automated | `run-p1a-tests.sh` |
| P1C-E2E-001 matching bash end-to-end injection | Automated | `test-jit-e2e.ts` |
| P1C-E2E-002 negative end-to-end nonmatch/default-inherited/untrusted/deleted-body no patch | Automated | `test-jit-e2e.ts` |
