# Tool Context Loader Validation Matrix

Maps `tool-context-loader/DESIGN.md` validation contracts to P1a coverage and later milestones.

| Contract | Status | Coverage |
| --- | --- | --- |
| VC-001 trusted project gate | Automated in P1a | `test-discovery.ts`: untrusted project skips project roots while global roots may scan. |
| VC-002 deterministic discovery | Automated in P1a | `test-discovery.ts`: repeated discovery has stable record projection. |
| VC-003 invalid frontmatter isolation | Automated in P1a | `test-discovery.ts`: invalid file warning, valid records still load. |
| VC-004 active-tool preload | Automated in P1b | `test-preload.ts`: active selected tool includes matching `injection: preload` metadata index entry. |
| VC-005 no inactive-tool preload | Automated in P1b | `test-preload.ts`: inactive selected tools and empty/missing selected tools produce no preload output. |
| VC-006 bash command trigger | Deferred to P1c | Requires `tool_call`/`tool_result` matching and injection. |
| VC-007 non-matching bash command | Deferred to P1c | Requires command matcher. |
| VC-008 path trigger | Deferred to P1c | Requires path matcher. |
| VC-009 budget enforcement | Partially automated in P1b | `test-preload.ts`: preload index byte budget caps output and omits excess records; JIT body budget deferred to P1c. |
| VC-010 priority ordering | Partially automated in P1a | Source/dedupe ordering covered; injection budget ordering deferred. |
| VC-011 per-turn dedupe | Deferred to P1d | Requires `turn_start` and injection claim state. |
| VC-012 tool result preservation | Deferred to P1c | Requires tool result patching. |
| VC-013 no argument mutation | Deferred to P1c | P1a has no `tool_call` handler. |
| VC-014 path escape rejection | Automated in P1a | `test-discovery.ts`: symlink escape skipped. |
| VC-015 missing roots are safe | Automated in P1a | `test-discovery.ts`: missing roots produce zero records and no throw. |
| VC-016 command diagnostics | Automated in P1a | `test-discovery.ts`: diagnostics include counts/metadata and omit bodies. Live command smoke remains manual. |
| VC-017 lazy body loading | Partially automated in P1a | Records do not retain body text. Actual JIT body read deferred to P1c. |
| VC-018 preload token budget | Automated in P1b | `test-preload.ts`: preload index stays under `maxPreloadBytesPerTurn`-style byte limits and reports omitted records when possible. |
| VC-019 dedupe resets on next turn | Deferred to P1d | Requires turn lifecycle. |
| VC-020 parallel result race safety | Deferred to P1d | Requires concurrent `tool_result` claim tests. |
| VC-021 advisory wrapper present | Deferred to P1c | Requires injected body wrapper. |
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
