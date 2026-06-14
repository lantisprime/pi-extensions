# Tool Context Loader P1c Plan Review

## Review Scope

Reviewed `tool-context-loader/P1C_PLAN.md` against:

- episodic memory canonical workplan (`canonical-workplan`)
- `tool-context-loader/DESIGN.md`
- `tool-context-loader/P1B_IMPLEMENTATION_REVIEW.md`
- `tool-context-loader/VALIDATION_MATRIX.md`
- Pi extension docs for `tool_call`, `tool_result`, `turn_start`, and result patching

## Executive Verdict

**Go for implementation after tightening a few scope boundaries.**

The P1c plan correctly focuses on JIT body injection after actual tool activity. It preserves P1b's token discipline and adds the required advisory wrapper, budget enforcement, result preservation, and no-argument-mutation guarantees.

Required adjustments before coding:

1. Limit P1c path-trigger support to stable path fields for `read`, `write`, and `edit` first.
2. Make broad tool-only fallback explicit and test it carefully, especially for `bash`.
3. Define exact behavior for details patching when existing `details` is not a plain object.
4. Keep P1d dedupe/race-safety out of scope, but avoid making P1c state hard to extend.
5. Add a test proving project-local trust remains enforced indirectly through discovery state.

## What The Plan Gets Right

### 1. Correct event split

The plan uses `tool_call` for metadata-only matching and `tool_result` for lazy body reads and result patching. This matches Pi's extension model and keeps tool execution behavior unchanged.

### 2. No argument mutation

The plan explicitly returns `undefined` from `tool_call` and tests input deep equality. This directly addresses VC-013.

### 3. Result preservation

The plan requires original content first, no `isError` patch, and details extension only under `details.toolContextLoader`. This addresses VC-012 without risking tool renderer breakage.

### 4. Advisory wrapper included

The required wrapper subordinates local runbook content to system, developer, user, permission-policy, and prompt-shield instructions. This addresses VC-021.

### 5. Body text remains lazy

The plan rereads files in `tool_result` and does not add body text to `RunbookRecord`. This preserves the P1a/P1b no-body-retention invariant.

## Required Plan Adjustments

### A-001: Narrow path-trigger support for P1c

The plan mentions `grep`, `find`, and `ls` path-like tools. Their input shapes may differ and may be broader than direct file path tools.

Recommended P1c implementation:

- Required support: `read.path`, `write.path`, `edit.path`.
- Optional support: `grep`, `find`, `ls` only if their typed fields are inspected and tested explicitly.
- Do not use `pattern` as a path trigger in P1c.

This keeps P1c deterministic and avoids matching search patterns as file paths accidentally.

### A-002: Broad tool-only fallback needs guardrails

Design says that if no matcher is specified beyond `tools`, the record can match by tool name only. This can be noisy for broad tools like `bash`.

Recommended P1c behavior:

- Implement tool-only fallback to stay aligned with design.
- Keep deterministic budgets strict.
- Add a specific test for bash tool-only fallback so behavior is intentional.
- Document that broad `bash` runbooks should prefer `match.commandIncludes` to avoid frequent injection.

Do not silently disable tool-only fallback in code; that would diverge from `DESIGN.md`.

### A-003: Details patching must be conservative

Recommended exact behavior:

- If `event.details` is a plain object: return `{ details: { ...event.details, toolContextLoader } }`.
- If `event.details` is `undefined`, `null`, primitive, or array: omit `details` from the patch.
- Never replace non-object details with a new object in P1c.

This protects built-in/custom renderer expectations.

### A-004: Root revalidation helper should be pure/testable

Add a helper for body read safety:

```ts
isRecordPathStillInsideRoot(record: RunbookRecord): Promise<boolean>
```

or equivalent, and test with a deleted/missing file plus existing P1a symlink coverage. P1c does not need to recreate all symlink tests but should not trust stale paths blindly.

### A-005: Dedupe deferral must be explicit in code comments

P1c may inject the same runbook multiple times in a turn if multiple matching tool calls happen. That is acceptable because P1d owns per-turn dedupe/race-safety.

Add a code comment near `pendingToolCallMatches` stating:

- P1c tracks candidates by tool call only.
- Per-turn/session dedupe and parallel claim-before-await are P1d.

This prevents accidental partial dedupe implementations that are hard to test.

## Security Review

### Prompt injection risk

P1c starts injecting local Markdown bodies into model context. Advisory wrappers help, but they are not a sandbox.

Accepted mitigations for P1c:

- project-local roots only come from trusted projects through existing discovery behavior
- injected excerpts are bounded
- runbook text is clearly marked advisory
- no tool arguments are mutated
- permission-policy still gates tool execution

Deferred mitigation:

- Prompt Shield-aware body injection suppression remains future work unless it becomes easy to wire safely.

### Body reading risk

P1c must re-check path/root safety before body reads because files can change after discovery.

Required:

- realpath of record path and root
- skip on escape, missing file, parse/read error, or oversized file
- never throw from `tool_result` for local guidance read failures

## Validation Mapping

| Contract | P1c expectation |
| --- | --- |
| VC-006 bash command trigger | Automated in `test-jit.ts` |
| VC-007 non-matching bash command | Automated in `test-jit.ts` |
| VC-008 path trigger | Automated for `edit.path` in `test-jit.ts` |
| VC-009 budget enforcement | Extended to body injection in `test-jit.ts` |
| VC-010 priority ordering | Extended to body injection in `test-jit.ts` |
| VC-012 tool result preservation | Automated in `test-jit.ts` |
| VC-013 no argument mutation | Automated in `test-jit.ts` |
| VC-017 lazy body loading | Extended with body read only in injection helper |
| VC-021 advisory wrapper present | Automated in `test-jit.ts` |

Keep these deferred:

- VC-011 per-turn dedupe — P1d
- VC-019 dedupe resets on next turn — P1d
- VC-020 parallel result race safety — P1d

## Recommended Implementation Shape

Add pure helpers before event wiring:

```ts
export type ToolCallMatch = {
  record: RunbookRecord;
  reason: string;
};

export function matchRunbooksForToolCall(records, toolName, input): ToolCallMatch[];
export async function readRunbookBody(record): Promise<string | undefined>;
export function buildToolResultInjection(matches, bodies, config): BodyInjectionResult;
export function patchToolResult(event, injection): ToolResultEventResult | undefined;
```

Then wire events minimally:

```ts
pi.on("turn_start", () => pendingToolCallMatches.clear());
pi.on("tool_call", (event) => { ... });
pi.on("tool_result", async (event) => { ... });
```

## Final Recommendation

Proceed to implementation after applying the required adjustments above. Keep P1c focused: metadata match in `tool_call`, lazy bounded body append in `tool_result`, no mutation, no dedupe hardening yet, no agent work.
