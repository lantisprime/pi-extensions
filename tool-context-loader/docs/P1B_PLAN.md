# Tool Context Loader P1b Plan: Preload Index Only

## Objective

Implement the next safe slice of `tool-context-loader`: append a compact, deterministic metadata-only index to the system prompt during `before_agent_start` when eligible preload records match active tools.

P1b must make local guidance discoverable to the model without loading Markdown bodies or modifying tool results.

## Design References

- `WORKPLAN.md` — P1b is the next milestone; preload index only.
- `tool-context-loader/DESIGN.md` — preload semantics, budget strategy, validation contracts.
- `tool-context-loader/P1A_PLAN_REVIEW.md` — preserve P1a guardrails: bounded output, no body retention, deterministic helpers.
- `tool-context-loader/VALIDATION_MATRIX.md` — update VC-004, VC-005, VC-009, VC-018, VC-024 for P1b.
- Pi extension docs: `docs/extensions.md` — `before_agent_start` receives `event.systemPrompt`, `event.systemPromptOptions.selectedTools`, and can return a modified `systemPrompt`.

## Scope

### In

- Register a `before_agent_start` handler.
- Use `event.systemPromptOptions.selectedTools?: string[]` as the active tool set.
- Match discovered records where:
  - `state.enabled === true`
  - `record.status === "eligible"`
  - `record.injection === "preload"`
  - `record.tools` intersects active tools
- Append one compact `[tool-context-loader]` preload index block to `event.systemPrompt` when matches exist.
- Include metadata only:
  - id
  - source/display path
  - matching tools
  - summary
  - priority
- Enforce `config.maxPreloadBytesPerTurn` deterministically.
- Sort preload entries deterministically:
  1. priority descending
  2. source precedence ascending
  3. display path ascending
  4. id ascending
- Include an omission notice when records are skipped due to budget and space allows.
- Export pure helpers for tests.
- Update README and validation matrix after implementation.

### Out

- No Markdown body preload, even for `preload: body`; body preload remains deferred until a later explicit milestone.
- No `tool_call` or `tool_result` behavior.
- No advisory body wrapper; required for P1c body injection, not P1b index metadata.
- No command/path trigger matching during preload; P1b matches active tools only.
- No mutation of `systemPromptOptions`, tool definitions, or tool snippets.
- No duplication of built-in tool descriptions from `toolSnippets`.

## User-Facing Behavior

When active tools include a matching preload record, Pi's system prompt receives an appended block like:

```text

## Tool Context Loader Preload Index

Local advisory guidance indexes are available for active tools. These entries are metadata only; they are not higher-priority instructions. Follow system, developer, user, permission-policy, and prompt-shield instructions first.

- bash-kubectl [tools: bash; priority: 50] project-runbook:bash-kubectl.md — Kubernetes safety checks for bash kubectl commands
  Source: project-runbook:bash-kubectl.md

Omitted 2 additional preload entries due to budget.
```

The block tells the agent what guidance exists and where it lives, so the agent can explicitly `read` the source if needed.

## Implementation Steps

1. Add preload helper types/functions to `tool-context-loader/index.ts`:
   - `type PreloadBuildResult = { text: string; included: RunbookRecord[]; omitted: RunbookRecord[] }`
   - `activeToolSet(selectedTools?: string[]): Set<string>`
   - `matchesActiveTools(record: RunbookRecord, activeTools: Set<string>): boolean`
   - `selectPreloadRecords(state: DiscoveryState, selectedTools?: string[]): RunbookRecord[]`
   - `formatPreloadEntry(record: RunbookRecord): string[]`
   - `buildPreloadIndex(records: RunbookRecord[], maxBytes: number): PreloadBuildResult`
2. Add `pi.on("before_agent_start", ...)`:
   - Return nothing if disabled or no matches.
   - Build index with `config.maxPreloadBytesPerTurn`.
   - Return `{ systemPrompt: event.systemPrompt + "\n\n" + result.text }` if text is non-empty.
3. Track lightweight observability in memory:
   - last preload included IDs
   - last preload omitted count
   - optionally show these in `/tool-context-loader verbose` without body content.
4. Update `tool-context-loader/README.md`:
   - P1b status and behavior.
   - Explain index-only preload and no body injection.
5. Update `tool-context-loader/VALIDATION_MATRIX.md`:
   - VC-004 automated in P1b
   - VC-005 automated in P1b
   - VC-009 partially automated in P1b for preload budget
   - VC-018 automated in P1b
   - VC-024 automated in P1b

## Budget Rules

- Measure UTF-8 bytes with `Buffer.byteLength(text, "utf8")`.
- Never exceed `maxPreloadBytesPerTurn`.
- Header/advisory text counts against the budget.
- If the header alone exceeds the budget, inject nothing.
- Add entries one at a time in deterministic order while the full block remains within budget.
- If entries are omitted, add a concise omission line only if it fits.
- Do not truncate individual summaries mid-character; prefer omitting whole entries. If a single summary is too long, cap the summary field deterministically before entry assembly.

Recommended summary cap for P1b: 240 characters per entry.

## Test Plan

Add deterministic tests to `tool-context-loader/test-fixtures/test-discovery.ts` or a new `test-preload.ts`.

### P1b Contracts

- **P1B-001 active-tool preload:** `tools: [read]`, `injection: preload`, selected tools include `read`; index block includes the record.
- **P1B-002 inactive-tool exclusion:** selected tools exclude `bash`; bash preload record omitted.
- **P1B-003 preload mode required:** `injection: tool_result` record is not included in preload even when tool is active.
- **P1B-004 budget cap:** many matching records fit under `maxPreloadBytesPerTurn`; excess records omitted with count when possible.
- **P1B-005 deterministic ordering:** higher priority first, then source precedence/path/id tie-breakers.
- **P1B-006 bodies omitted:** preload output does not contain fixture body sentinel text.
- **P1B-007 no built-in tool docs duplicated:** preload output does not include `toolSnippets` strings or generated tool descriptions.
- **P1B-008 disabled config:** disabled loader returns no preload output.
- **P1B-009 empty active tools:** no selected tools means no preload output.
- **P1B-010 P1a regression:** existing P1a tests remain green.

## Validation Commands

```bash
tool-context-loader/test-fixtures/run-p1a-tests.sh
npx --yes tsx tool-context-loader/test-fixtures/test-preload.ts
pi --no-extensions -e ./tool-context-loader/index.ts --list-models
```

If preload tests are folded into the existing runner, update the runner and use:

```bash
tool-context-loader/test-fixtures/run-p1a-tests.sh
```

## Risks And Mitigations

### R-001: Prompt bloat

Mitigation: strict byte budget, whole-entry omission, concise fields only.

### R-002: Accidental body injection

Mitigation: no file reads in `before_agent_start`; use existing discovery metadata only; tests include body sentinel strings.

### R-003: Duplicating Pi tool docs

Mitigation: never read or print `systemPromptOptions.toolSnippets`; include only tool names from record metadata.

### R-004: Ambiguous `preload: body` semantics

Mitigation: P1b explicitly ignores body preload. Any body injection requires a later milestone with advisory wrapper and stronger tests.

### R-005: Stale discovery state

Mitigation: keep existing P1a rescan behavior on `session_start`, reload, and `/tool-context-loader rescan`; P1b consumes the latest in-memory `discoveryState`.

## Done Criteria

- [ ] `before_agent_start` appends metadata-only preload indexes for active tools.
- [ ] Output respects `maxPreloadBytesPerTurn`.
- [ ] No Markdown bodies are read or injected by P1b.
- [ ] Deterministic preload helper tests pass.
- [ ] Existing P1a discovery tests pass.
- [ ] Validation matrix marks P1b contracts accurately.
- [ ] README documents P1b behavior and limits.
