# Tool Context Loader P1b Plan Review

## Review Scope

Reviewed `tool-context-loader/P1B_PLAN.md` against:

- `WORKPLAN.md`
- `tool-context-loader/DESIGN.md`
- `tool-context-loader/P1A_PLAN_REVIEW.md`
- `tool-context-loader/VALIDATION_MATRIX.md`
- Pi extension docs for `before_agent_start` and `systemPromptOptions.selectedTools`
- Relevant adversarial review risks around prompt injection, smoke validation, rollback, and coverage mapping

## Executive Verdict

**Go for implementation, with small clarifications before coding.**

The P1b plan is appropriately narrow and preserves the safety posture established in P1a. It adds only metadata/index context during `before_agent_start`, avoids Markdown body injection, avoids tool-result mutation, and has clear deterministic budget and test requirements.

The main adjustments needed are:

1. Define exact behavior when `selectedTools` is missing.
2. Make the budget helper's edge cases testable and explicit.
3. Ensure `preload: body` is not silently treated as body preload in P1b.
4. Add a live Pi smoke command closer to the adversarial review recommendation.
5. Update test runner/CI expectations explicitly.

## What The Plan Gets Right

### 1. Correct P1b scope

The plan keeps P1b to `before_agent_start` and metadata-only preload. This matches the workplan's next milestone: compact active-tool indexes, not bodies.

### 2. Preserves P1a security guardrails

The plan does not add new project file reads during `before_agent_start`; it consumes the existing discovery state. It also keeps project trust, source precedence, unmapped episode behavior, diagnostics caps, and no body retention intact.

### 3. Avoids tool/result interference

P1b explicitly excludes `tool_call` and `tool_result`. That means no argument mutation, no result patching, and no parallel tool race surface yet.

### 4. Good deterministic ordering

Priority descending, source precedence ascending, display path, then id is appropriate and testable.

### 5. Good validation mapping

The selected P1b validation contracts are the right ones:

- VC-004 active-tool preload
- VC-005 no inactive-tool preload
- VC-009 preload-side budget enforcement
- VC-018 preload token/byte budget
- VC-024 no duplicated tool docs

## Required Clarifications Before Implementation

### C-001: Define missing `selectedTools` behavior

`systemPromptOptions.selectedTools` is optional in the Pi type, although docs say default tools are usually present.

Recommended P1b behavior:

- If `selectedTools` is `undefined` or empty, inject nothing.
- Do not infer default tools inside the extension.

Rationale: P1b should only preload for tools Pi explicitly reports as active. Conservative no-op behavior is safer than over-injecting.

Add/keep test: `P1B-009 empty active tools`.

### C-002: Treat `preload: body` as index-only in P1b

The plan says no Markdown body preload even for `preload: body`. Implementation should make this mechanically obvious:

- P1b output should not branch on `record.preload` except possibly displaying the metadata value for diagnostics.
- `buildPreloadIndex` should never read `record.absolutePath`.
- Tests should include a record with `preload: body` and sentinel body text, proving the output remains index-only.

This avoids a future accidental interpretation that `preload: body` is active in P1b.

### C-003: Budget edge cases need exact expected behavior

The plan gives good rules. Encode them as helper tests:

- Header alone over budget => `text === ""`, included `[]`, omitted all records.
- Header fits but no entry fits => either empty text or header + omission line, but choose one explicitly.
- Omission line included only if final text remains <= budget.
- All UTF-8 byte assertions use `Buffer.byteLength`.

Recommended behavior: if no entry fits, inject nothing unless a useful omission-only block fits under budget. Simpler implementation: inject nothing when no entries fit.

### C-004: Summary capping should be specified exactly

Recommended helper:

```ts
truncateSummary(summary: string, maxChars = 240): string
```

Rules:

- Trim whitespace and collapse internal newlines to spaces.
- If length <= cap, return unchanged.
- If longer, return first `cap - 1` characters plus `…`.

This prevents huge frontmatter summaries from consuming the entire preload budget.

### C-005: Last preload diagnostics should not block P1b

The plan says lightweight observability is optional. Keep it optional. If added, expose only:

- included ids
- omitted count
- byte count

Do not print full prompt blocks or body content in diagnostics.

## Risks And Mitigations

### R-001: Prompt bloat

**Risk:** Even metadata indexes can grow across many runbooks.

**Mitigation:** Keep `maxPreloadBytesPerTurn` strict, count header bytes, omit whole entries, and test byte ceilings.

### R-002: Accidental body/context injection

**Risk:** `preload: body` metadata could tempt implementation to read files.

**Mitigation:** P1b helper takes `RunbookRecord[]` only and never calls `fs.readFile`. Add sentinel tests.

### R-003: Tool documentation duplication

**Risk:** Preload output could restate built-in tool docs or `toolSnippets`.

**Mitigation:** Do not pass `toolSnippets` into preload assembly. Match only on `selectedTools`; output only local runbook metadata.

### R-004: Untrusted project leakage

**Risk:** Preload could reveal project-local metadata when project is untrusted.

**Mitigation:** Existing P1a discovery state already excludes project roots when untrusted. Add one preload test using a state with only global records or project-trust-gated discovery if practical.

### R-005: Runtime loads but tests pass

**Risk:** Pure tests pass while the extension fails under Pi/jiti.

**Mitigation:** Add smoke validation:

```bash
pi --no-extensions -e ./tool-context-loader/index.ts --list-models
pi -e ./tool-context-loader/index.ts -p "noop" --mode json
```

If the second command is too slow/flaky for CI, document it as manual smoke.

## Recommended P1b Implementation Shape

Keep helpers pure and exported:

```ts
export type PreloadBuildResult = {
  text: string;
  included: RunbookRecord[];
  omitted: RunbookRecord[];
  byteLength: number;
};

export function activeToolSet(selectedTools?: string[]): Set<string>;
export function selectPreloadRecords(state: DiscoveryState, selectedTools?: string[]): RunbookRecord[];
export function buildPreloadIndex(records: RunbookRecord[], maxBytes: number): PreloadBuildResult;
```

Handler shape:

```ts
pi.on("before_agent_start", async (event) => {
  if (!discoveryState.enabled) return;
  const records = selectPreloadRecords(discoveryState, event.systemPromptOptions.selectedTools);
  const preload = buildPreloadIndex(records, config.maxPreloadBytesPerTurn);
  if (!preload.text) return;
  return { systemPrompt: `${event.systemPrompt}\n\n${preload.text}` };
});
```

Implementation notes:

- Do not use `systemPromptOptions.toolSnippets`.
- Do not mutate `event.systemPromptOptions`.
- Do not read files.
- Do not include body bytes except as metadata if useful; prefer not including `bodyBytes` in prompt to avoid noise.
- Use existing `RunbookRecord.displayPath` for source references.

## Validation Review

Map P1b tests like this:

| Contract | Expected P1b Coverage |
| --- | --- |
| VC-004 active-tool preload | Automated in preload helper tests |
| VC-005 no inactive-tool preload | Automated in preload helper tests |
| VC-009 budget enforcement | Partially automated for preload index budget |
| VC-018 preload token/byte budget | Automated with byte ceiling assertions |
| VC-024 tool docs not duplicated | Automated by sentinel `toolSnippets`/tool-doc string absence |
| VC-017 lazy body loading | Regression assertion that preload helper does not output body sentinel |
| VC-023 body not retained | Existing P1a coverage remains |

P1a tests must stay green.

## Documentation Updates Required After Implementation

- `tool-context-loader/README.md`
  - Status becomes P1b or P1a+P1b.
  - Document that preload is index-only and metadata-only.
  - State that bodies are still deferred to P1c.
- `tool-context-loader/VALIDATION_MATRIX.md`
  - Move relevant contracts from deferred to automated/partial.
- Root `README.md`
  - Update `tool-context-loader` status if behavior is user-visible.

## Final Recommendation

Proceed to implementation after adding the clarifications above to the coding checklist. Keep P1b boring: active-tool match, deterministic metadata block, strict budget, no body reads, no tool-result behavior.
