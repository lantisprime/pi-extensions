# P3c-4 Ephemeral One-Shot Agents Plan

## Status

Planning only. Do not implement until this plan, plan review, and adversarial review are accepted.

## Episode Search Summary

Searched episodic memory for `ephemeral agent`, `run-temp`, `save-temp`, `P3c4`, `canRunAgent`, `child-runner`, `security-scan`.

Key active memories:

- `20260617-102715-canonical-workplan-p3c4-next-p3f-model-p-35e8`: P3c4 is the canonical next slice after P3c3 merge
- `20260617-095605-pr-68ae`: P3c3 (PR #28) merged at commit `b72d531`, deployed on `main`
- `20260615-143159-pr-27-merged-and-p3c-2-deployed-locally--a3c3`: P3c2 built-in child runner merged
- `20260615-092202-canonical-workplan-updated-after-pr-23-s-f01e`: Original scoping of ephemeral and chain to separate slices

## Objective

Add two user-facing commands for ephemeral one-shot agents: `/agents run-temp <base-role> <task>` (run without persistence) and `/agents save-temp <name>` (save spec without registering). Prove that the shared `canRunAgent` gate, `runChildAgent` execution path, and security scanner compose cleanly for zero-setup agent runs that never write files to disk.

## Why

Users need quick, no-setup agent runs for one-off tasks (planning, scouting, reviewing) without the ceremony of creating a Markdown spec, scanning it, and registering it. `run-temp` provides this while staying within P3 hard stops: no persistence, no registration, same `canRunAgent` gate, same `runChildAgent` execution. `save-temp` captures a successful ephemeral run's spec for later registration, bridging the gap between ad-hoc and formal use.

## Requirements (Ground Truth)

Every requirement SHALL be testable and SHALL map to at least one test or validation check.
Requirements are numbered REQ-1, REQ-2, ... and are the authoritative contract for the feature.

| ID | Requirement | Test(s) | Priority | Notes |
|---|---|---|---|---|
| REQ-1 | `/agents run-temp <base-role> <task>` parses correctly: rejects empty input, single token, unknown role, empty task; accepts valid `scout/planner/reviewer <task>` | `parseEphemeralRunArgs_rejects_empty_input`, `parseEphemeralRunArgs_rejects_missing_task`, `parseEphemeralRunArgs_rejects_unknown_base_role`, `parseEphemeralRunArgs_accepts_valid_input`, `runTemp_safe_task_spawns_after_gate_ok` | MUST | Scout/planner/reviewer reuse built-in role prompts; parse validated before spec construction |
| REQ-2 | `buildEphemeralSpec(role)` produces a valid `AgentSpec` with `source:"ephemeral"`, `name:"temp"`, read-only tools, built-in role prompt, default contracts | `runTemp_safe_task_spawns_after_gate_ok`, `ephemeralSpec_passes_validateAgentSpec` | MUST | Task text is NOT embedded in spec.prompt |
| REQ-3 | Task prompt text is scanned via `scanTextForAgentRisk(task, {source:"prompt"})` before `canRunAgent` is called | `runTemp_dangerous_task_blocks_no_spawn`, `runTemp_suspicious_task_tui_confirm_spawns`, `runTemp_suspicious_task_non_tui_blocks_no_spawn` | MUST | Scanner determines `scannerRisk` fed into gate |
| REQ-4 | `canRunAgent` is the single gate — no spawn occurs unless `canRunAgent` returns `ok:true` with code `allowed-ephemeral` | `runTemp_dangerous_task_blocks_no_spawn`, `runTemp_suspicious_task_tui_cancel_no_spawn`, `runTemp_suspicious_task_non_tui_blocks_no_spawn` | MUST | Gate call is on critical path; no bypass branch |
| REQ-5 | Dangerous task (scannerRisk === "dangerous") is blocked; no spawn occurs | `runTemp_dangerous_task_blocks_no_spawn` | MUST | Gate code: `ephemeral-dangerous` |
| REQ-6 | Suspicious task with TUI confirmation (`ctx.hasUI === true`, confirm returned true) proceeds to spawn | `runTemp_suspicious_task_tui_confirm_spawns` | MUST | `suspiciousConfirmed: true` passed to gate |
| REQ-7 | Suspicious task without TUI (`ctx.hasUI === false`) or with TUI cancel fails closed; no spawn occurs | `runTemp_suspicious_task_tui_cancel_no_spawn`, `runTemp_suspicious_task_non_tui_blocks_no_spawn` | MUST | Gate code: `ephemeral-suspicious-unconfirmed` |
| REQ-8 | Child argv excludes the task/prompt text entirely | `runTemp_child_argv_excludes_task_text` | MUST | Task passed via stdin; the private temp file used by `runChildAgent` as a stdin transport is ephemeral (created and cleaned within the function) and does not constitute persistent file I/O |
| REQ-9 | Child argv includes `--no-approve`, `--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-themes` (all discovery-disabling flags) | `runTemp_child_argv_includes_no_approve`, `runTemp_child_argv_discovery_disabled` | MUST | Reuses `buildChildPiArgs` defaults; explicit assertion for each flag |
| REQ-10 | Ephemeral spec tools are only `P3_READONLY_TOOLS` (`read,grep,find,ls`) | `runTemp_safe_task_spawns_after_gate_ok` | MUST | Enforced by spec construction + `canRunAgent` + `runChildAgent` |
| REQ-11 | No persistent file is written to disk during `run-temp` | `runTemp_writes_no_file` | MUST | In-memory only; the ephemeral stdin transport temp file created/cleaned by `runChildAgent` is not persistent I/O. Test asserts no files remain in user/project agents dirs after run. |
| REQ-12 | No registry entry is created during `run-temp` | `runTemp_writes_no_file` (same test asserts registry unchanged) | MUST | `userRegistry`/`projectRegistry` untouched |
| REQ-13 | `/agents save-temp <name>` parses correctly: rejects empty, multi-token, invalid name chars, reserved built-in names; accepts valid names | `parseSaveTempArgs_rejects_reserved_names`, `parseSaveTempArgs_rejects_invalid_name`, `parseSaveTempArgs_accepts_valid_name`, `saveTemp_rejects_reserved_name`, `saveTemp_rejects_invalid_name` | MUST | `isValidAgentName` + `isReservedBuiltInAgentName` checks |
| REQ-14 | `/agents save-temp <name>` writes a user Markdown spec file to the user agents directory | `saveTemp_writes_markdown_file_no_registry` | MUST | Frontmatter + prompt body |
| REQ-15 | `save-temp` does NOT call `registerAgent` or write to any registry | `saveTemp_writes_markdown_file_no_registry` | MUST | Registry JSON unchanged after save |
| REQ-16 | Saved spec is not runnable until `/agents register <name>` (blocked by `user-unregistered` gate) | `saveTemp_saved_spec_blocked_until_registered` | MUST | Test: try run before registration → blocked |
| REQ-17 | `save-temp` requires interactive confirmation; non-TUI fails closed (no file written) | `saveTemp_non_tui_fails_closed`, `saveTemp_tui_confirm_writes`, `saveTemp_tui_cancel_no_write` | MUST | Mirrors registration confirm pattern |
| REQ-18 | `save-temp` rejects existing file (no clobber) | `saveTemp_rejects_existing_file_no_clobber` | MUST | File existence check before write |
| REQ-19 | `agentsLastEphemeralSpec` is tracked in-memory on the context after a successful gate pass and cleared on overwrite | `runTemp_stashes_last_ephemeral_spec`, `saveTemp_no_prior_run_fails` | MUST | Stashed after gate, before child execution. Previous spec replaced on next `run-temp`; undefined → save fails. A failed/crashed run still leaves a stashed spec (saveable) — this is intentional: the spec is valid even if the child Pi failed. |
| REQ-20 | All P3c-2 and P3c-3 tests pass (regression) | `run-p3c-3-tests.sh`, `run-p3c-2-tests.sh`, `test-security-scan.mjs` | MUST | 3 existing test scripts pass |
| REQ-21 | Saved spec Markdown round-trips cleanly through `parseAgentMarkdownFile` | `saveTemp_rendered_markdown_round_trips_through_parser` | SHOULD | Validates renderer correctness |

**Priority legend:**
- **MUST**: Required for the first slice merge. Failing test = blocker.
- **SHOULD**: Required before the feature is considered complete; one slice may defer.

## Non-Goals

Out of scope for P3c-4:

- `run_subagent` tool (LLM-callable path) — P3d-1
- Chain mode or parallel execution — P3d-2
- Persisting or auto-registering saved temps
- Allowing non-read-only tools for ephemeral agents
- Prompt override of `run_subagent`
- Modifying `canRunAgent` semantics or adding new gate codes
- Model profiles — P3f
- README/eval command updates — P3e

## Safety / Security

| Concern | Severity | Mitigation | Test(s) |
|---|---|---|---|
| Ephemeral spec bypasses `canRunAgent` gate | High | `runEphemeralCommand` calls `canRunAgent` before any spawn; no alternate path exists | `runTemp_dangerous_task_blocks_no_spawn`, `runTemp_suspicious_task_non_tui_blocks_no_spawn` |
| Task text leaks into child process argv | High | `runChildAgent` passes task via stdin/JSON private temp file; `buildChildPiArgs` excludes task from argv | `runTemp_child_argv_excludes_task_text` |
| `save-temp` silently registers creating a runnable agent | Medium | `saveTempCommand` calls `fs.writeFile` only, never `registerAgent`; saved spec blocked by `user-unregistered` gate | `saveTemp_writes_markdown_file_no_registry`, `saveTemp_saved_spec_blocked_until_registered` |
| Suspicious task runs without confirmation in non-TUI | Medium | `ctx.hasUI` check before confirm; non-TUI sets `suspiciousConfirmed:false` → gate denies | `runTemp_suspicious_task_non_tui_blocks_no_spawn` |
| `save-temp` overwrites existing registered spec file | Medium | File existence check before write; fails on collision | `saveTemp_rejects_existing_file_no_clobber` |
| Ephemeral child Pi can write/edit files | Low | Child argv: `--no-extensions --no-skills --no-prompt-templates --no-themes` and tools=`read,grep,find,ls` — no write/bash/edit | `runTemp_child_argv_includes_no_approve`, `runTemp_child_argv_discovery_disabled` |
| Double execution via `runAgentCommand` dispatch path | Low | `runEphemeralCommand` is separate from `runAgentCommand`; no file re-read logic fires on ephemeral (no `filePath`) | Regressed by `run-p3c-3-tests.sh` |

## Design

### Key invariants

- `canRunAgent` is the single, unbypassed gate before any child spawn
- Task text never appears in child process argv
- `run-temp` produces zero persistent file I/O and zero registry mutations (the ephemeral stdin transport temp file inside `runChildAgent` is created and cleaned within the function call)
- `save-temp` writes a Markdown file but does NOT register it
- Suspicious tasks require explicit interactive confirmation; non-TUI fails closed
- Dangerous tasks are always blocked with no spawn and no confirm prompt
- Ephemeral specs are in-memory only; no on-disk representation exists for them

### Key types

```ts
// Context extension (in index.ts)
type AgentsContext = {
  // ... existing fields ...
  /** Set after successful ephemeral gate pass, before child execution. In-memory only. */
  agentsLastEphemeralSpec?: { spec: AgentSpec; task: string };
  /** User agents directory for save-temp writes. */
  agentsUserAgentsDir?: string;
};

// Ephemeral lib exports (in ephemeral.ts)
/** Base roles reusing built-in scout/planner/reviewer prompts. */
type EphemeralBaseRole = "scout" | "planner" | "reviewer";

/** Build an in-memory ephemeral AgentSpec from a built-in base role. */
function buildEphemeralSpec(baseRole: EphemeralBaseRole): AgentSpec;

/** Parse /agents run-temp <role> <task> argv. */
function parseEphemeralRunArgs(input: string):
  | { ok: true; baseRole: EphemeralBaseRole; task: string }
  | { ok: false; message: string };

/** Parse /agents save-temp <name> argv. */
function parseSaveTempArgs(input: string):
  | { ok: true; name: string }
  | { ok: false; message: string };

/** Render an ephemeral AgentSpec to Markdown with YAML frontmatter. */
function renderEphemeralSpecToMarkdown(spec: AgentSpec, name: string): string;
```

### Resolution / flow

#### run-temp flow

```text
User: /agents run-temp <base-role> <task>
  │
  ├─ parseEphemeralRunArgs(rest) → { ok, baseRole, task }
  │     ├─ validate baseRole ∈ {scout, planner, reviewer}
  │     └─ validate task non-empty
  │
  ├─ buildEphemeralSpec(baseRole) → AgentSpec
  │     └─ name:"temp", source:"ephemeral", tools:P3_READONLY_TOOLS
  │     └─ prompt: built-in role prompt, contracts/limits/safety: defaults
  │
  ├─ scannerRisk = scanTextForAgentRisk(task, {source:"prompt"}).risk
  │
  ├─ suspiciousConfirmed =
  │     scannerRisk !== "suspicious" → undefined
  │     scannerRisk === "suspicious" AND hasUI AND confirm → true
  │     scannerRisk === "suspicious" AND (!hasUI OR !confirm) → false (fail closed)
  │
  ├─ gate = canRunAgent({ spec, scannerRisk, explicitUserRequest:true, suspiciousConfirmed }, ctx)
  │     └─ if !gate.ok → notify deny code, return (NO SPAWN)
  │
  ├─ ctx.agentsLastEphemeralSpec = { spec, task }
  │
  └─ runChildAgent(spec, task, { cwd, piCommand })
        └─ buildChildPiArgs(spec, task, ...) → spawn child Pi (task in stdin, NOT argv)
```

#### save-temp flow

```text
User: /agents save-temp <name>
  │
  ├─ parseSaveTempArgs(rest) → { ok, name }
  │     ├─ validate name: isValidAgentName, not reserved built-in
  │     └─ validate single token
  │
  ├─ require ctx.agentsLastEphemeralSpec
  │     └─ if undefined → notify, return
  │
  ├─ require hasUI + interactive confirm
  │     └─ if !hasUI → notify "requires interactive confirmation", return
  │     └─ if !confirmed → notify "cancelled", return
  │
  ├─ userAgentsDir = diagnostics.userAgentsDir
  ├─ filePath = path.join(userAgentsDir, "<name>.md")
  │     └─ if file exists → notify "already exists", return
  │
  ├─ markdown = renderEphemeralSpecToMarkdown(spec, name)
  │
  └─ fs.writeFile(filePath, markdown)
        └─ notify "Saved <name>.md. Not registered — run /agents register <name>."
```

## Existing Hook Points

Where this feature integrates with existing code.

| File | Line(s) | What it does | Impact |
|---|---|---|---|
| `can-run-agent.ts` | L70, L124-130 | `canRunAgent` branches on `source === "ephemeral"` → `canRunEphemeral()` with deny codes `not-explicit-ephemeral`, `tools-not-readonly`, `ephemeral-dangerous`, `ephemeral-suspicious-unconfirmed` | **Used** — gate call before spawn; `explicitUserRequest: true`, `suspiciousConfirmed` |
| `child-runner.ts` | L58-118 | `runBuiltInChildAgent` forwards to `runChildAgent`; `runChildAgent` validates task, rejects forbidden tools, builds child argv, spawns child Pi | **Used** — direct call from `runEphemeralCommand`; no file re-read needed |
| `child-runner.ts` | L99-167 | `formatChildAgentRunResult` renders run result for TUI display | **Used** — display after ephemeral run |
| `security-scan.ts` | L50-107 | `scanTextForAgentRisk(text, options): AgentRiskScanResult` with `.risk` | **Used** — scan task text to determine `scannerRisk` |
| `specs.ts` | L3-6 | `P3_READONLY_TOOLS`, `P3_FORBIDDEN_TOOLS`, `RESERVED_BUILT_IN_AGENT_NAMES` | **Used** — build ephemeral spec, validate base roles |
| `specs.ts` | L100-108 | `isValidAgentName`, `isReservedBuiltInAgentName` | **Used** — validate save-temp name, parse |
| `specs.ts` | L325 | `getBuiltInAgentSpec(name)` returns built-in scout/planner/reviewer specs | **Used** — base for ephemeral spec construction |
| `specs.ts` | L92-116 | `DEFAULT_INPUT_CONTRACT`, `DEFAULT_LIMITS`, `DEFAULT_OBSERVABILITY`, `DEFAULT_SAFETY` | **Used** — ephemeral spec defaults |
| `index.ts` | L46-120 | `AgentsContext` type, command handler with `parseAgentsArgs` dispatch, `registrationOptions` | **Modified** — add dispatch branches, extend context |
| `index.ts` | L119-213 | `runAgentCommand`, `executeChildRun`, `resolveRegisteredRunTarget`, `parseRunArgs` | **Not used** — ephemeral has separate command handlers (no file, no hash, no registry) |
| `registration.ts` | full | `registerAgent`, `registerProjectAgents` | **Not used** — save-temp writes file only, no registration |
| `agent-markdown.ts` | full | `parseAgentMarkdownFile`, `AGENT_MARKDOWN_ACCEPTED_KEYS` | **Used only for round-trip test** — verifies save-temp output is valid Markdown |
| `diagnostics.ts` | L67-72 | `AgentDiagnostics.userAgentsDir`, `AgentDiagnostics.projectAgentsDir` | **Used** — save-temp writes to `userAgentsDir` |

## Slice Ladder

| Slice | Objective | Primary files | Key deliverables | Tests | Hard stops |
|---|---|---|---|---|---|
| **P3c-4** | Ephemeral one-shot agents: `run-temp` + `save-temp` | `agents/lib/ephemeral.ts` (new), `agents/index.ts` (modify), `agents/test-fixtures/test-ephemeral.mjs` (new), `agents/test-fixtures/run-p3c-4-tests.sh` (new) | `/agents run-temp <role> <task>`; `/agents save-temp <name>`; 28 automated tests; regression pass | No `run_subagent`, no chain, no parallel, no persistent file I/O on run, no auto-registration on save |

### Dependency graph

```text
P3c-1 (child args) → P3c-2 (built-in runner) → P3c-3 (registered exec) → P3c-4 (ephemeral)
                                                                              ↓
                                                                         P3d-1 (run_subagent)
```

P3c-4 depends on P3c-3 for `canRunAgent` (ephemeral branch already in gate), `runChildAgent`, `scanTextForAgentRisk`, and `formatChildAgentRunResult`. P3c-4 does NOT depend on P3c-3's `runAgentCommand`, `resolveRegisteredRunTarget`, or file re-read logic.

## Cut Order

If context or implementation scope grows, cut in this order:

1. `save-temp` (keep `run-temp` only — ephemeral run without save)
2. Suspicious confirmation detail display (fail closed more aggressively — suspicious always blocked)

Do not cut:

- `canRunAgent` as the single gate for ephemeral execution
- Prompt scanning before `canRunAgent`
- Non-TUI fail-closed for suspicious/dangerous
- Child argv task exclusion
- Read-only tools enforcement

## Contracts

### `parseEphemeralRunArgs(input: string): { ok: true; baseRole: EphemeralBaseRole; task: string } | { ok: false; message: string }`

**Input contract:** Raw argv string after `run-temp` subcommand.

**Output contract:** Discriminated union. `ok: true` returns `baseRole` ∈ `{"scout","planner","reviewer"}` and non-empty `task`.

**State table (exhaustive):**

| State | Condition | Output |
|---|---|---|
| A. Empty | `input.trim()` is empty | `ok: false`, message includes usage hint |
| B. Single token | Only one non-whitespace token | `ok: false`, message includes usage hint |
| C. Unknown role | First token not in `{"scout","planner","reviewer"}` | `ok: false`, message: `"base-role must be one of: scout, planner, reviewer"` |
| D. Empty task | Two+ tokens, second token (or rest) trims to empty | `ok: false`, message: `"task must not be empty"` |
| E. Valid | First token ∈ valid roles, rest trims to non-empty | `ok: true`, `baseRole` = first token, `task` = rest.trim() |

**Error codes:**

| Code | Field | Trigger |
|---|---|---|
| `ephemeral-args-empty` | `input` | Empty input |
| `ephemeral-args-missing-task` | `input` | Only one token |
| `ephemeral-base-role-unknown` | `baseRole` | First token not a valid role |
| `ephemeral-task-empty` | `task` | Task trims to empty |

**Invariants:**
- `task` is trimmed of leading/trailing whitespace
- `baseRole` is case-sensitive and must match exactly `"scout"`, `"planner"`, or `"reviewer"`
- Returned `task` is never embedded in any `AgentSpec.prompt`

### `parseSaveTempArgs(input: string): { ok: true; name: string } | { ok: false; message: string }`

**Input contract:** Raw argv string after `save-temp` subcommand.

**Output contract:** Discriminated union. `ok: true` returns a validated `name`.

**State table (exhaustive):**

| State | Condition | Output |
|---|---|---|
| A. Empty | `input.trim()` is empty | `ok: false`, message: `"Usage: /agents save-temp <name>"` |
| B. Multiple tokens | More than one non-whitespace token | `ok: false`, message: `"Usage: /agents save-temp <name>"` |
| C. Invalid name chars | Single token, fails `isValidAgentName` | `ok: false`, message: `"name must match ^[a-z][a-z0-9_-]{0,63}$"` |
| D. Reserved name | Single token, passes `isValidAgentName` but is reserved built-in | `ok: false`, message: `"'<name>' is a reserved built-in agent name"` |
| E. Valid | Single token, passes all checks | `ok: true`, `name` |

**Error codes:**

| Code | Field | Trigger |
|---|---|---|
| `save-args-empty` | `input` | Empty input |
| `save-args-multiple-tokens` | `input` | Multiple tokens |
| `save-name-invalid` | `name` | Fails `isValidAgentName` |
| `save-name-reserved` | `name` | Reserved built-in name |

**Invariants:**
- `isReservedBuiltInAgentName` check runs AFTER `isValidAgentName` (valid name required first)
- Name is trimmed before validation

### `buildEphemeralSpec(baseRole: EphemeralBaseRole): AgentSpec`

**Input contract:** `baseRole` ∈ `{"scout","planner","reviewer"}`.

**Output contract:** `AgentSpec` with `source: "ephemeral"`, `name: "temp"`, all other fields cloned from the built-in spec.

**State table (exhaustive):**

| State | Condition | Output |
|---|---|---|
| A. Valid role | `baseRole` is `"scout"`, `"planner"`, or `"reviewer"` | Shallow clone of `getBuiltInAgentSpec(role)` with `source` and `name` overwritten |
| B. Unknown role | `baseRole` is anything else (including at runtime if called with invalid input) | `undefined` (type-narrowed by caller validation; runtime safety net) |

**Invariants:**
- Returned spec passes `validateAgentSpec` (verified by built-in spec validation at load time plus test)
- `source` is `"ephemeral"` (required by `canRunAgent` to enter ephemeral branch)
- `name` is `"temp"` (passes `isValidAgentName`, not reserved, not persisted)
- `tools` are `P3_READONLY_TOOLS` (inherited from built-in, already validated)
- `safety.forbiddenTools` includes all `P3_FORBIDDEN_TOOLS` (inherited)
- `inputContract`, `outputContract`, `limits`, `observability`, `safety` match the built-in defaults
- The returned object is a new shallow clone — mutation does not affect the built-in spec
- Task text is NOT embedded in `spec.prompt`

### `scanPromptForEphemeralRun(task: string): RiskLevel`

**Input contract:** Non-empty task string (validated by caller).

**Output contract:** `RiskLevel` (`"safe" | "suspicious" | "dangerous"`).

**State table (exhaustive):**

| State | Condition | Output |
|---|---|---|
| A. Clean | No patterns matched | `"safe"`, `score: 0`, `findings: []` |
| B. Suspicious | Low/mid-severity matches | `"suspicious"`, `score > 0` but below dangerous threshold |
| C. Dangerous | High-severity matches (exfiltration, remote-code, destructive) | `"dangerous"`, `score >= threshold` |

**Invariants:**
- Wraps `scanTextForAgentRisk(task, { source: "prompt" }).risk`
- Called fresh for each ephemeral run (no caching)
- Does not modify the task text

### `renderEphemeralSpecToMarkdown(spec: AgentSpec, name: string): string`

**Input contract:** Valid `AgentSpec` (ephemeral) and a non-empty, non-reserved `name`.

**Output contract:** A Markdown string starting with `---\n`, YAML frontmatter, `\n---\n\n`, prompt body.

**Frontmatter keys rendered:** `name` (save-temp name, NOT `spec.name`), `description`, `tools` (as YAML list `[read, grep, find, ls]`).

**Omitted keys (intentional):** `source` (disk defaults to user by location), `model`/`thinking` (ephemeral has none), `profile` (not in scope).

**Invariants:**
- Output starts with `---` on its own line, ends with `---` on its own line
- Prompt body follows frontmatter, separated by exactly one blank line
- Output is valid input for `parseAgentMarkdownFile` (round-trip safe)
- Uses single-tool-name-per-line format compatible with `parseFrontmatterValue` (`[read, grep, find, ls]`)

## Edge Cases

| # | Scenario | Expected behavior | Test |
|---|---|---|---|
| EC1 | `run-temp` with unknown base role | Parse rejects: "base-role must be one of: scout, planner, reviewer" | `parseEphemeralRunArgs_rejects_unknown_base_role` |
| EC2 | `run-temp` with empty task | Parse rejects: "task must not be empty" | `parseEphemeralRunArgs_rejects_missing_task` |
| EC3 | `run-temp` with dangerous task prompt | `canRunAgent` returns `ephemeral-dangerous` → notify, no spawn | `runTemp_dangerous_task_blocks_no_spawn` |
| EC4 | `run-temp` with suspicious task, TUI confirm | Confirm → `suspiciousConfirmed:true` → gate returns `allowed-ephemeral` → spawn | `runTemp_suspicious_task_tui_confirm_spawns` |
| EC5 | `run-temp` with suspicious task, TUI cancel | Cancel → `suspiciousConfirmed:false` → `ephemeral-suspicious-unconfirmed` → no spawn | `runTemp_suspicious_task_tui_cancel_no_spawn` |
| EC6 | `run-temp` with suspicious task, non-TUI | `!hasUI` → `suspiciousConfirmed:false` → `ephemeral-suspicious-unconfirmed` → no spawn | `runTemp_suspicious_task_non_tui_blocks_no_spawn` |
| EC7 | `save-temp` without prior `run-temp` | `agentsLastEphemeralSpec` undefined → notify, no write | `saveTemp_no_prior_run_fails` |
| EC8 | `save-temp` with reserved name (`scout`) | Parse rejects: "'scout' is a reserved built-in agent name" | `saveTemp_rejects_reserved_name` |
| EC9 | `save-temp` with invalid name chars (`My Agent`) | Parse rejects: "name must match ..." | `saveTemp_rejects_invalid_name` |
| EC10 | `save-temp` with existing file | `fs.writeFile` → EEXIST → notify, no overwrite | `saveTemp_rejects_existing_file_no_clobber` |
| EC11 | `save-temp` non-TUI | `!hasUI` → notify: "Save requires interactive confirmation." → no write | `saveTemp_non_tui_fails_closed` |
| EC12 | `save-temp` TUI cancel | Cancel → no file written | `saveTemp_tui_cancel_no_write` |
| EC13 | Two consecutive `run-temp` calls | Second overwrites `agentsLastEphemeralSpec`; `save-temp` saves the second | `runTemp_stashes_last_ephemeral_spec` |
| EC14 | `run-temp` with oversize task | `runChildAgent` validates `maxTaskChars` → rejects before spawn | `runTemp_oversize_task_rejected` |
| EC15 | `run-temp` child Pi crashes or times out | `runChildAgent` returns `spawn-error`/`timed-out` status; displayed via `formatChildAgentRunResult` | `runTemp_child_pi_error_handled` (regressed by child-runner tests) |
| EC16 | `save-temp` renders spec with special characters | `renderEphemeralSpecToMarkdown` produces valid YAML; round-trip parse passes | `saveTemp_rendered_markdown_round_trips_through_parser` |

## Test Case Catalog

Grouped by concern. Every test name here SHALL appear in the Requirements table.

```
Group 1: Argument parsing (7 tests)
  parseEphemeralRunArgs_rejects_empty_input
  parseEphemeralRunArgs_rejects_missing_task
  parseEphemeralRunArgs_rejects_unknown_base_role
  parseEphemeralRunArgs_accepts_valid_input
  parseSaveTempArgs_rejects_reserved_names
  parseSaveTempArgs_rejects_invalid_name
  parseSaveTempArgs_accepts_valid_name

Group 2: Ephemeral run — gate and spawn (10 tests)
  runTemp_safe_task_spawns_after_gate_ok
  runTemp_dangerous_task_blocks_no_spawn
  runTemp_suspicious_task_tui_confirm_spawns
  runTemp_suspicious_task_tui_cancel_no_spawn
  runTemp_suspicious_task_non_tui_blocks_no_spawn
  runTemp_stashes_last_ephemeral_spec
  runTemp_child_argv_excludes_task_text
  runTemp_child_argv_includes_no_approve
  runTemp_child_argv_discovery_disabled
  runTemp_writes_no_file

Group 3: Ephemeral spec construction (1 test)
  ephemeralSpec_passes_validateAgentSpec

Group 4: Save-temp (9 tests)
  saveTemp_no_prior_run_fails
  saveTemp_writes_markdown_file_no_registry
  saveTemp_saved_spec_blocked_until_registered
  saveTemp_rejects_existing_file_no_clobber
  saveTemp_non_tui_fails_closed
  saveTemp_tui_confirm_writes
  saveTemp_tui_cancel_no_write
  saveTemp_rejects_reserved_name
  saveTemp_rejects_invalid_name

Group 5: Round-trip (1 test)
  saveTemp_rendered_markdown_round_trips_through_parser
```

Total: 28 tests (17 positive, 11 negative with runner/write-not-called assertions).

**Negative tests (assert runner/spawn/write NOT called):**
- `parseEphemeralRunArgs_rejects_empty_input` — returns error, doesn't reach runner
- `parseEphemeralRunArgs_rejects_missing_task` — returns error, doesn't reach runner
- `parseEphemeralRunArgs_rejects_unknown_base_role` — returns error, doesn't reach runner
- `runTemp_dangerous_task_blocks_no_spawn` — spawner not invoked
- `runTemp_suspicious_task_tui_cancel_no_spawn` — spawner not invoked
- `runTemp_suspicious_task_non_tui_blocks_no_spawn` — spawner not invoked
- `parseSaveTempArgs_rejects_reserved_names` — returns error, doesn't reach writer
- `parseSaveTempArgs_rejects_invalid_name` — returns error, doesn't reach writer
- `saveTemp_no_prior_run_fails` — no file write
- `saveTemp_non_tui_fails_closed` — no file write
- `saveTemp_tui_cancel_no_write` — no file write
- `saveTemp_rejects_reserved_name` — no file write
- `saveTemp_rejects_invalid_name` — no file write
- `saveTemp_rejects_existing_file_no_clobber` — no file write

## Risk Analysis

| Risk | Severity | Mitigation |
|---|---|---|
| Ephemeral spec bypasses `canRunAgent` gate | High | `runEphemeralCommand` calls `canRunAgent` before ANY spawn. No alternate code path. Test asserts no spawn when gate denies. |
| Task text leaks into child process argv | High | `runChildAgent` passes task via stdin/JSON (private temp file), NOT argv. `buildChildPiArgs` excludes task. Test asserts argv does not contain task text. |
| `save-temp` silently registers agent | Medium | `saveTempCommand` calls `fs.writeFile` only, never `registerAgent`. Test asserts registry JSON unchanged after save. |
| Suspicious task runs without confirmation in non-TUI | Medium | `ctx.hasUI` check before confirm; non-TUI sets `suspiciousConfirmed:false` → gate denies. Test asserts no spawn. |
| `save-temp` overwrites existing spec | Medium | File existence check before write; fails on collision (no clobber). |
| `save-temp` creates unsigned runnable spec | Low | Saved spec unregistered → blocked by `user-unregistered` gate. Same as hand-written spec. |
| Ephemeral child Pi can write files | Low | Child argv: `--no-extensions`, tools=`read,grep,find,ls` — no write/bash/edit. |
| `buildEphemeralSpec` returns invalid spec | Low | Built-in specs validated at load. Test validates ephemeral clone passes `validateAgentSpec`. |
| `runEphemeralCommand` accidentally enters `runAgentCommand` path | Low | Separate dispatch branch; no shared handler; no file re-read. Regressed by P3c-3 tests. |
| `scanTextForAgentRisk` not exported for standalone text | Low | Confirmed exported at `security-scan.ts` L50: `export function scanTextForAgentRisk(text, options)`. |
| Double stashing overwrites intended save target | Low | Design choice: most recent wins. Documented behavior. Test confirms. |

## Open Decisions

1. **Built-in ephemeral spec caching** — Should `buildEphemeralSpec` memoize the ephemeral clones, or build fresh each call? Fresh each call is simpler and negligible cost (< 1ms). Decision: fresh each call. Defer caching to P3e if profiling shows need.

2. **Save-temp file format validation** — Should `save-temp` re-parse the written file with `parseAgentMarkdownFile` to validate correctness before notifying success? Adds I/O + scanner overhead. Decision: defer to round-trip test; runtime validation is the `/agents register` step. Defer to P3e.

3. **`run-temp` result display** — Should ephemeral run results include the task or base-role in the notification? Decision: show agent name "temp" + base-role; do not echo full task. Minimal disclosure.

## Done Criteria

All MUST requirements passing = done. Specific completion conditions:

- [ ] All 28 automated tests pass (`bash agents/test-fixtures/run-p3c-4-tests.sh`)
- [ ] P3c-3 regression passes (`bash agents/test-fixtures/run-p3c-3-tests.sh`)
- [ ] P3c-2 regression passes (`bash agents/test-fixtures/run-p3c-2-tests.sh`)
- [ ] Security scan tests pass (`node scripts/test-security-scan.mjs`)
- [ ] `git diff --check` passes
- [ ] `npx --yes tsc --noEmit --strict agents/index.ts agents/lib/ephemeral.ts` passes
- [ ] Plan review accepted (no open blockers)
- [ ] Adversarial review accepted (verdict: go or conditional-go with no open MUST failures)

## Review Consensus

| Pass | Reviewer | Model | Blocker count | Verdict |
|---|---|---|---|---|
| 1 | Subagent | anthropic/claude-opus-4.8 | 3 | conditional-go |
| 2 | — | — | — | Pending |

### Resolved blockers

| # | Blocker | Resolution |
|---|---|---|
| 1 | stdin-vs-temp-file contradiction: REQ-11 says no file I/O but `runChildAgent` uses private temp file for prompt transport | Clarified REQ-8/REQ-11: temp file is ephemeral transport inside `runChildAgent` (created and cleaned within the function), not persistent file I/O. Invariant tightened to "zero persistent file I/O". |
| 2 | Discovery-disabled invariant under-specified and untested: no test asserting skills/templates/themes flags in child argv | Added `runTemp_child_argv_discovery_disabled` test (28th test). REQ-9 now explicitly lists `--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-themes`. Safety table updated. |
| 3 | Test count mismatch: 20 (Slice Ladder/Done Criteria) vs 27 (Catalog) vs 6 (Group 4 header) | Unified to 28 throughout. All 5 count references updated. |

## Appendix: Implementation Plan

### Files to create

1. `agents/lib/ephemeral.ts` — spec builder (`buildEphemeralSpec`), arg parsers (`parseEphemeralRunArgs`, `parseSaveTempArgs`), run/save orchestrators (`runEphemeralCommand`, `saveTempCommand`), markdown renderer (`renderEphemeralSpecToMarkdown`)
2. `agents/test-fixtures/test-ephemeral.mjs` — 28 automated tests using `makeHarness()` convention
3. `agents/test-fixtures/run-p3c-4-tests.sh` — test runner script

### Files to modify

| File | Change |
|---|---|
| `agents/index.ts` | Add `"run-temp"`, `"save-temp"` to completions; add two dispatch branches in handler; add `agentsLastEphemeralSpec?` and `agentsUserAgentsDir?` to `AgentsContext`; update usage message; export `runEphemeralCommand`, `saveTempCommand` for test wiring |

### Implementation sequence

| Step | Action | Validation |
|---|---|---|
| 1 | Create branch `p3c-4-ephemeral-agents` from `main` | `git branch --show-current` |
| 2 | Write `ephemeral.ts`: types, arg parsers, spec builder, renderer, run/save orchestrators | `npx --yes tsc --noEmit --strict agents/lib/ephemeral.ts` |
| 3 | Modify `index.ts`: command dispatch, context extension, exports | `npx --yes tsc --noEmit --strict agents/index.ts` |
| 4 | Write `test-ephemeral.mjs`: all 28 tests | `npx --yes tsx agents/test-fixtures/test-ephemeral.mjs` |
| 5 | Write `run-p3c-4-tests.sh` | `bash agents/test-fixtures/run-p3c-4-tests.sh` |
| 6 | Full regression: P3c-2, P3c-3, security scan | All 3 scripts pass |
| 7 | `git diff --check` | No whitespace errors |
| 8 | Plan review + adversarial review | No open blockers against MUST requirements |
| 9 | Commit + PR | |

### Implementation risks

| Risk | Mitigation |
|---|---|
| `save-temp` writes to wrong directory | Use `diagnostics.userAgentsDir` (already canonicalized by diagnostics) |
| `renderEphemeralSpecToMarkdown` produces invalid YAML | Round-trip test validates via `parseAgentMarkdownFile` |
| Test harness for `test-ephemeral.mjs` diverges from `test-extension-scaffold.mjs` | Import `makeHarness` and helpers from test-extension-scaffold or replicate minimal fake context inline |
| `scanTextForAgentRisk` produces false positives on benign tasks | Scanner thresholds are existing; ephemeral inherits same behavior. Suspicious path has TUI override |
