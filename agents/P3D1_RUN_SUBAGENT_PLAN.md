# P3d-1 run_subagent Single-Run LLM-Callable Tool Plan

## Status

Implemented locally and reviewed. Initial opus-4.8 implementation review returned conditional-go for a `details.invocation.promptTransport` leak; the blocker and all follow-up nits were fixed. Final opus-4.8 follow-up review returned `go`. Validation passed:

- `bash agents/test-fixtures/run-p3d-1-tests.sh` (36 tests)
- `bash agents/test-fixtures/run-p3c-2-tests.sh`
- `bash agents/test-fixtures/run-p3c-3-tests.sh`
- `bash agents/test-fixtures/run-p3c-4-tests.sh`
- `pi --no-extensions -e ./agents/index.ts --list-models`

## Episode Search Summary

Searched episodic memory for `run_subagent`, `P3d`, `recursion`, `registerTool`, `subagent`.

Key active memories:

- `20260617-225902-c3da`: P3d-1 plan aligned with scaffold plan, SECURITY_MODEL, AGENT_SPEC, and P3 slices
- `20260617-151043-48f0`: Canonical workplan: P3d-1 next, P3f-2 parallel; P3c4 + P3f-1 merged
- `20260617-102715-35e8`: Canonical workplan: P3c4-next, P3F model profiles parallel, P3F-1 zero dependencies
- `20260615-092202-f01e`: Canonical workplan updated after PR #23: P3b-5 registration flows

## Objective

Register `run_subagent` as an LLM-callable tool via `pi.registerTool` so the parent Pi can delegate a bounded read-only task to a built-in or registered agent. The tool reuses the same `canRunAgent` gate and child execution path as `/agents run`. It structurally denies prompt override, ephemeral agents, and recursive delegation.

## Why

The `/agents run` command path already works. Making delegation available as an LLM-callable tool lets the parent agent strategically scout, plan, or review without user intervention — a core agentic capability. P3d-1 proves single-run tool delegation is safe before P3d-2 adds chain mode and before any write-enabled roles.

## Requirements (Ground Truth)

Every requirement SHALL be testable and SHALL map to at least one test or validation check.

| ID | Requirement | Test(s) | Priority | Notes |
|---|---|---|---|---|
| REQ-1 | `run_subagent` tool is registered via `pi.registerTool` at extension load with name `run_subagent`, a JSON-schema-compatible parameters object containing only `agent` (string) and `task` (string) with `additionalProperties: false`, description, `promptSnippet`, and `promptGuidelines` | `tool_registered_with_name_and_schema`, `schema_has_only_agent_and_task`, `schema_has_no_prompt_field`, `schema_has_no_tools_field`, `schema_rejects_additional_properties` | MUST | Schema shape is structural no-prompt-override; extra fields (prompt/tools/model/thinking) rejected at schema validation level |
| REQ-2 | Tool execution rejects empty or missing `agent` name; errors returned to LLM with `isError: true`; no child spawn | `rejects_empty_agent`, `rejects_missing_agent` | MUST | Fail-closed on invalid input |
| REQ-3 | Tool execution rejects empty or oversize `task` (> spec maxTaskChars); errors returned to LLM with `isError: true`; no child spawn | `rejects_empty_task`, `rejects_oversize_task` | MUST | Same task validation as `/agents run` |
| REQ-4 | Built-in agent name (scout/planner/reviewer) runs via `runBuiltInChildAgent` with read-only tools, passes `canRunAgent` gate, returns bounded text result | `built_in_scout_runs_with_readonly_tools`, `built_in_planner_runs`, `built_in_reviewer_runs` | MUST | Verified via fake-child-runner asserting spawn call received read-only tools |
| REQ-5 | Registered user agent runs through full gate: re-read current spec bytes → `canRunAgent` → spawn; unregistered user agent denied with structured error, no spawn | `registered_user_runs_after_gate`, `unregistered_user_denied_no_spawn` | MUST | Reuses same resolution as `/agents run` (shared helper) |
| REQ-6 | Registered project agent runs only when `isProjectTrusted() === true` AND registered in project registry; untrusted → denied, unregistered → denied; no spawn in both cases | `project_untrusted_denied_no_spawn`, `project_registered_runs` | MUST | Same project trust gating as `/agents run` |
| REQ-7 | Ephemeral agents are denied by the gate (tool does NOT set `explicitUserRequest: true`); no spawn | `ephemeral_agent_denied_no_spawn` | MUST | `canRunAgent` denies ephemeral unless explicit user request |
| REQ-8 | No prompt override: child prompt text contains the spec's own prompt, NOT any caller-supplied text; schema structurally lacks a `prompt` parameter | `child_uses_spec_prompt_not_caller_text`, `schema_has_no_prompt_parameter` (REQ-1) | MUST | Dual structural + behavioral enforcement of invariant #29 |
| REQ-9 | Task delivered as opaque prompt data (stdin/private-temp-file via `buildChildPiArgs`), never as argv tokens. Task strings beginning with `-`/`--` or containing flag-like content (`--tools`, `--approve`) run as literal prompt text with no capability change. | `task_with_flag_like_content_runs_as_literal_text` | MUST | Flag-injection resistance; child-args already uses stdin/private-temp-file for prompt transport |
| REQ-10 | Task sanitization: reject NUL and disallowed C0/DEL control bytes, allow ordinary multiline task text (`TAB`, `LF`, `CR`), and reject whitespace-only strings before building child prompt | `rejects_control_bytes_in_task`, `allows_multiline_task_text`, `rejects_whitespace_only_task` | MUST | Prevent prompt corruption/rendering issues without blocking normal multiline delegated tasks |
| REQ-11 | Recursion prevention (2 structural + 1 behavioral): (a) `--no-extensions` in child argv prevents agents extension loading (primary structural guard); (b) `P3_FORBIDDEN_TOOLS` excludes `run_subagent` from `--tools` (structural backstop); (c) `COMMON_PROMPT` instructs child LLM not to spawn subagents (behavioral) | `child_argv_excludes_run_subagent`, `child_argv_excludes_approve`, `child_argv_includes_no_extensions`, `child_tools_are_readonly`, `child_no_registered_run_subagent_tool` | MUST | Layers 1 and 3 are independent; layer 2 is a backstop. Smoke test confirms no run_subagent tool in child. |
| REQ-12 | Ambiguous agent name (multiple discovered user+project specs with same name) → denied, no spawn, actionable error message | `ambiguous_name_denied_no_spawn` | MUST | Already handled by `resolveRegisteredRunTarget` shared helper |
| REQ-11 | Dangerous or invalid spec status on re-read (toctou) → denied, no spawn | `dangerous_current_spec_denied_no_spawn`, `invalid_current_spec_denied_no_spawn` | MUST | Spec re-read immediately before gate (same as `/agents run`) |
| REQ-13 | Hash mismatch at runtime (spec bytes changed since registration) → denied, no spawn | `hash_mismatch_denied_no_spawn` | MUST | Runtime hash recheck via `findMatchingRegisteredAgent` |
| REQ-14 | Successful run returns bounded text (`≤ limits.maxResultChars`) with `isError: false`; denial returns short error text with `isError: true`, error code, and recovery hint | `completed_returns_bounded_text`, `denial_returns_isError_true_with_code` | MUST | LLM sees bounded output; denial is actionable (child output never executes parent actions) |
| REQ-15 | Tool result `details` enumerated allowlist: ONLY `{ agentName, status, durationMs, exitCode?, invocation (redacted argv) }`. No path, stderr, env, full prompt, full task, or raw tool results in LLM-visible content. | `result_details_contain_only_allowlisted_fields`, `result_does_not_leak_full_task_or_prompt` | MUST | Privacy + security: enumerated fields, not open-ended `...`. Child output labeled advisory/untrusted. |
| REQ-16 | Context freshness: `cwd`, `projectTrusted` resolved fresh from tool's `ExtensionContext` at each call (not cached from `session_start`). Static handles only (`agentsPiCommand`, `agentsChildRunner`) optionally captured from `session_start`. If static context undefined or `session_start` not yet fired → `{ ok: false, code: "not-ready" }`. | `tool_denies_when_session_context_undefined`, `project_trust_toggle_after_session_start_denies` | MUST | TOCTOU resistance. Never defaults to permissive when context unavailable. |
| REQ-17 | Built-in gate parity: `run_subagent` and `/agents run` produce identical allow/deny decisions for every agent type (built-in, registered user, registered project, ephemeral, dangerous, hash-mismatch). | `built_in_path_parity_with_agents_run`, `registered_path_parity_with_agents_run` | MUST | Built-in shortcut matches `/agents run` behavior (both skip `canRunAgent` for built-ins). |
| REQ-18 | `/agents run` command behavior unchanged (P3c-2/3/4 regression); existing test suites pass | `manual: bash agents/test-fixtures/run-p3c-2-tests.sh`, `bash agents/test-fixtures/run-p3c-3-tests.sh`, `bash agents/test-fixtures/run-p3c-4-tests.sh` | MUST | Regression guard; refactored resolution must not diverge |
| REQ-19 | Extension load smoke passes with tool registered | `manual: pi --no-extensions -e ./agents/index.ts --list-models` | MUST | Tool registration must not break extension load |
| REQ-20 | P3d-1 does NOT add chain, parallel, or multi-agent delegation; tool defines single agent + single task; tool does not add write/edit/bash capability | `schema_only_single_agent_and_task` (REQ-1) + `manual: git diff --stat agents/index.ts agents/lib/*.ts` shows no chain/parallel/write | MUST | Hard stop per P3_IMPLEMENTATION_SLICES.md |
| REQ-21 | `--no-extensions` in child argv disables ALL extension sources (CLI, project `.pi`, home config). Child Pi has no `run_subagent` tool registered. | `child_pi_has_no_run_subagent_registered` | MUST | Recursion Layer 1 integrity — `--no-extensions` must be global, not just CLI-scoped. Smoke test confirms no run_subagent in child. |

**Priority legend:**
- **MUST**: Required for P3d-1 merge. Failing test = blocker.
- **SHOULD**: Required before the feature is considered complete; one slice may defer.
- **MAY**: Nice-to-have, not blocking any merge.

## Non-Goals

Out of scope for P3d-1:

- Chain mode (sequential multi-agent delegation) — deferred to P3d-2
- Parallel fan-out (multiple simultaneous child agents) — out of P3 entirely
- Write/edit/bash child tools — permanently excluded in P3
- Prompt override in `run_subagent` — permanently excluded (structural denial via schema)
- Ephemeral agent support — permanently excluded (tool cannot provide `explicitUserRequest`)
- Recursive `run_subagent` (child calling `run_subagent`) — permanently excluded (3-layer guard)
- Altering `buildChildPiArgs`, `canRunAgent`, or any existing function signature

## Safety / Security

The `run_subagent` tool adds a new callable authority surface: the LLM can now trigger child Pi processes without explicit user command. The security model must prevent authority expansion, prompt override, and recursive fan-out.

| Concern | Severity | Mitigation | Test(s) |
|---|---|---|---|
| LLM calls `run_subagent` with a task string containing flag-like content (e.g., `--tools write,edit,bash --approve inspect foo`) | Low | Task is delivered via stdin/private-temp-file (not argv tokens) by the existing `buildChildPiArgs` pipeline. The child arg parser never sees the task string as flags. REQ-9 added for behavioral test. | `task_with_flag_like_content_runs_as_literal_text` |
| LLM calls `run_subagent` to spawn a child that then calls `run_subagent` (recursive fan-out) | Medium | Layer 1 (primary structural): `--no-extensions` prevents the agents extension from loading — `run_subagent` never registered in child. Layer 2 (structural backstop): `P3_FORBIDDEN_TOOLS` excludes `run_subagent` from `--tools`. Layer 3 (behavioral): `COMMON_PROMPT` instructs child LLM not to spawn subagents. Layers 1 and 3 are independent; layer 2 is a second structural guard. | `child_argv_includes_no_extensions`, `child_argv_excludes_run_subagent`, `child_tools_are_readonly`, `child_pi_has_no_run_subagent_registered` |
| LLM calls `run_subagent` and the child output triggers parent command execution | Low | Parent treats `run_subagent` result as data only. Tool returns bounded text to LLM; parent does not parse or execute child output. | `completed_returns_bounded_text` (parent only formats, never executes) |
| Project trust toggles between tool call and execution | Low | `isProjectTrusted()` is called fresh at resolution time from the tool's `ExtensionContext` (not cached from `session_start`). REQ-16 ensures TOCTOU resistance. | `project_untrusted_denied_no_spawn`, `project_trust_toggle_after_session_start_denies` |
| Child result leaks prompt/task/path/stderr/env | Low | Result `details` carry only an allowlist: `{ agentName, status, durationMs, exitCode?, invocation (redacted argv) }`. No path, stderr, env, full prompt, or full task. REQ-15 enumerated allowlist. | `result_details_contain_only_allowlisted_fields` |
| LLM treats child output as executable instructions | Medium | Result text labeled as advisory/untrusted in `promptGuidelines`. Parent never parses/executes child output. Architectural limitation: parent LLM always has `bash` per parent tools. | `completed_returns_bounded_text` (proves child output is text, not commands) |
| `session_start` context undefined / not yet fired when tool called | Low | `registerSubagentTool` rejects with `{ ok: false, code: "not-ready" }` when static context unavailable. Never defaults to permissive. REQ-16. | `tool_denies_when_session_context_undefined` |

### Recursion defense layers (detail)

```
Parent LLM calls run_subagent("scout", "inspect foo")
   │
   └── parent spawns child Pi:
         argv: [..., --no-extensions, --tools read,grep,find,ls, ...]
                │                                    │
                │  LAYER 1 (primary structural)     LAYER 2 (structural backstop)
                │  agents extension NOT loaded       P3_FORBIDDEN_TOOLS excludes
                │  → no run_subagent tool            run_subagent from --tools
                │                                  → would be rejected even if
                │                                    extension somehow loaded
                │
                LAYER 3 (behavioral): COMMON_PROMPT says
                "Do not spawn subagents or request recursive delegation"

   Layers 1 and 3 are fully independent (extension loading ≠ prompt text).
   Layer 2 is a second structural backstop (independent of extension loading
   mechanism). Any single layer suffices to prevent recursion; all three proven.
```

## Design

### Key types

```ts
// Subagent run outcome — testable, LLM-facing.
// ok=true: child ran; text is compacted result for LLM display.
// ok=false: gate denial or execution failure; text explains why; code matches canRunAgent code or spawn/limit error.
export type SubagentRunOutcome =
  | { ok: true;  text: string; details: SubagentRunDetails }
  | { ok: false; text: string; code: string; details: SubagentRunDetails };

export type SubagentRunDetails = {
  agentName: string;
  status?: ChildAgentRunStatus;
  durationMs?: number;
  exitCode?: number | null;
  invocation?: ChildPiInvocation;  // redacted argv (no prompt/task in argv display)
};
// Enumerated allowlist: ONLY the above fields. No path, stderr, env,
// full prompt, full task, or raw tool results in LLM-visible content.

// Context needed to resolve and run a subagent. Subset of what /agents run uses.
export type SubagentRunContext = {
  cwd: string;
  homeDir?: string;           // agentsHomeDir (default home when undefined)
  projectTrusted: boolean;    // from isProjectTrusted()
  piCommand?: string;         // defaults to "pi"
  childRunner?: ChildAgentRunner; // undefined → real runChildAgent/runBuiltInChildAgent
  hasUI: boolean;
  ui: { notify(message: string, level?: string): void };
};
```

### Key invariants

- **Tool schema = structural no-prompt-override.** The schema exposes only `agent` + `task`. No `prompt`, `tools`, `model`, `thinking`, or override fields. The LLM cannot override because the tool's `execute` never reads a prompt param.
- **Task delivered as opaque prompt data, never argv tokens.** `executeSubagentRun` delegates to `runBuiltInChildAgent` / `runChildAgent`, which call `buildChildPiArgs` — this already passes the prompt text via stdin or private temp file (`buildChildPromptText` → `buildPromptTransport`). The task string is never a positional argv argument and cannot be re-parsed as flags by the child Pi arg parser. The child receives `-p` with prompt text on stdin (or `@<tempfile>`), not `--tools` / `--approve` / flag tokens in argv.
- **Context freshness — cwd, projectTrusted, homeDir resolved at each tool call.** Only static handles (`agentsPiCommand`, `agentsChildRunner`) are optionally captured from the session_start event. `cwd`, `homeDir`, and `projectTrusted` are read fresh from the tool's `ExtensionContext` (`ctx.cwd`, `ctx.isProjectTrusted()`) at each `execute` invocation. The `SubagentRunContext` passed to `executeSubagentRun` carries the JIT values, not session-start snapshots. If the tool's `ExtensionContext` is unavailable or `session_start` has not fired, the tool returns `{ ok: false, code: "not-ready" }` — never a permissive default.
- **Same gate, no divergence.** `executeSubagentRun` calls the same `collectAgentDiagnostics` → `resolveRegisteredRunTarget` → re-read spec → `canRunAgent` path as `/agents run`. For built-in agents, both paths skip `canRunAgent` identically (built-ins are trusted extension code, not spec files; `canRunAgent` returns `allowed-built-in` unconditionally in `index.ts:canRunAgent` line ~63). No side-channel for unregistered/dangerous/stale specs.
- **Ephemeral denied.** The tool never sets `explicitUserRequest: true` on the `canRunAgent` candidate. Ephemeral agents require explicit user request; tool-initiated delegation is not explicit. Result: ephemeral always denied.
- **Child output is advisory/untrusted data.** The tool returns a text summary to the LLM labeled as advisory. The parent extension does not parse, execute, or act on child output. Child output can contain attacker-controlled content (e.g., a scout reading a hostile file); the parent LLM must treat it as informational input, not executable instructions. This is invariant across all P3 agents.
- **No chain/parallel.** The tool accepts exactly one `agent` name (string, not array). Single call = single child run. P3d-2 adds chain mode as a separate slice.
- **Tool returns `isError: true` on any denial or failure.** The LLM can distinguish success from failure and retry/abort accordingly.
- **Recursion prevention — 2 structural layers + 1 behavioral layer.** (1) `--no-extensions` in child argv prevents the agents extension from loading, so `run_subagent` is never registered in the child — this is the primary structural guard. (2) `P3_FORBIDDEN_TOOLS` includes `run_subagent`, preventing any spec from listing it in `--tools`. (3) `COMMON_PROMPT` instructs the child LLM not to spawn subagents — behavioral guard. Layers 1 and 3 are independent; layer 2 is a second structural backstop (if `--no-extensions` were somehow subverted, the --tools allowlist would still reject it).

### Resolution / flow

```text
registerSubagentTool.execute(toolCallId, params, signal, onUpdate, extensionCtx)
   │
   ├── Build fresh SubagentRunContext from extensionCtx:
   │      cwd = extensionCtx.cwd                       (JIT, not session-start snapshot)
   │      projectTrusted = extensionCtx.isProjectTrusted()  (JIT)
   │      homeDir = sessionAgentsCtx?.agentsHomeDir    (static, optional, undefined→default)
   │      piCommand = sessionAgentsCtx?.agentsPiCommand     (static, optional, undefined→"pi")
   │      childRunner = sessionAgentsCtx?.agentsChildRunner (static, optional, undefined→real)
   │      hasUI = extensionCtx.hasUI
   │      ui = extensionCtx.ui
   │      If sessionAgentsCtx undefined: { ok: false, code: "not-ready" }
   │
   ▼
executeSubagentRun("scout", "inspect foo", runCtx)
   │
   ├── 1. Validate inputs: agent non-empty? task non-empty & ≤ maxTaskChars?
   │      Also: task contains control/NUL bytes?  → { ok: false, code: "invalid-input" }
   │      Also: task is whitespace-only?          → { ok: false, code: "invalid-input" }
   │
   ├── 2. Collect diagnostics: collectAgentDiagnostics({ cwd, homeDir, projectTrusted })
   │
   ├── 3. Built-in shortcut: isReservedBuiltInAgentName(agent)?
   │      Yes → spec = getBuiltInAgentSpec(agent) → skip to step 6
   │      (Same shortcut as /agents run; built-ins are trusted extension code,
   │       not spec files requiring re-read+canRunAgent. Parity verified.)
   │
   ├── 4. Resolve registered target: resolveRegisteredRunTarget(agent, diagnostics)
   │      No match → { ok: false, code: "agent-not-found", text: "..." }
   │      Ambiguous → { ok: false, code: "ambiguous-name", text: "..." }
   │
   ├── 5. Re-read spec + gate: parseAgentMarkdownFile(path) → canRunAgent({ spec, parsed, ... })
   │      (canRunAgent candidate does NOT include explicitUserRequest → ephemeral denied)
   │      Denied → { ok: false, code: gateCode, text: gateReason }
   │
   ├── 6. Execute child: runBuiltInChildAgent(name, task, opts) or runChildAgent(spec, task, opts)
   │      Task delivered via buildChildPiArgs → stdin or private-temp-file
   │      Child argv: [..., --no-extensions, --tools read,grep,find,ls, --no-approve, --no-session, --mode json]
   │      Task NEVER appears as positional argv token or flag
   │      Spawn error → { ok: false, code: "spawn-error", text: "..." }
   │
   └── 7. Format result: compact text from ChildAgentRunResult
          → { ok: true, text: boundedSummary, details: { agentName, status, durationMs, exitCode, invocation } }
          → Details allowlist: ONLY agentName, status, durationMs, exitCode, invocation (redacted argv)
          → NO prompt/task/path/stderr/env in LLM-visible result
```

## Existing Hook Points

| File | Line(s) | What it does | P3d-1 impact |
|---|---|---|---|
| `index.ts` | L56 | `pi.registerCommand("agents", ...)` — entry for `/agents run` | Register `run_subagent` tool via `pi.registerTool` alongside |
| `index.ts` | L65-72 | `session_start` handler — proactive recommendation | Capture `sessionAgentsCtx` for agents* config fields (piCommand, childRunner, homeDir) |
| `index.ts` | L131-163 | `runAgentCommand` + `resolveRegisteredRunTarget` + `executeChildRun` | Extract into `agents/lib/run-resolver.ts` so both `/agents run` and `run_subagent` share the same gate path |
| `can-run-agent.ts` | L47 | `canRunAgent(candidate, context)` — runtime gate | Reuse unchanged; tool passes same candidate shape (without explicitUserRequest) |
| `child-runner.ts` | L58 | `runBuiltInChildAgent(name, task, options)` | Reuse unchanged for built-in agents |
| `child-runner.ts` | L65 | `runChildAgent(spec, task, options)` | Reuse unchanged for registered agents |
| `child-args.ts` | L27 | `buildChildPiArgs(spec, task, options)` | Already excludes `run_subagent` (in `P3_FORBIDDEN_TOOLS`) and includes `--no-extensions` |
| `child-args.ts` | L111-116 | `validateChildArgInputs` rejects forbidden tools | Recursion guard layer 1 — requires no change |
| `specs.ts` | L7 | `P3_FORBIDDEN_TOOLS = ["write", "edit", "bash", "run_subagent"]` | Already excludes `run_subagent` — requires no change |
| `specs.ts` | L6 | `P3_READONLY_TOOLS = ["read", "grep", "find", "ls"]` | Read-only enforcement on built-ins — requires no change |
| `specs.ts` | L367-472 | `BUILT_IN_AGENT_SPECS` with `scout`, `planner`, `reviewer` | Built-in specs — reuse unchanged |
| `diagnostics.ts` | — | `collectAgentDiagnostics(...)` | Reuse unchanged; tool provides `homeDir` and `projectTrusted` |
| `pi dist/types.d.ts` | L208-234 | `ExtensionContext` — has `cwd`, `hasUI`, `ui`, `isProjectTrusted()`, `signal` | Tool's `execute` `ctx` provides these; agents* fields captured from sessionCtx with defaults |
| `pi dist/types.d.ts` | L840 | `pi.registerTool(definition)` — tool registration | Main P3d-1 API call |
| `pi dist/types.d.ts` | L335-345 | `ToolDefinition` shape: `name`, `description`, `promptSnippet?`, `promptGuidelines?`, `parameters`, `execute` | Schema + execute shape |

## Slice Ladder

P3d-1 is a single slice. No sub-slices.

### Dependency graph

```text
P3c-3 (registered execution) ── P3d-1 (run_subagent tool)
P3c-4 (ephemeral agents)   ── (no dependency on run_subagent)
```

P3c-2 and P3c-3 are merged → P3d-1 has all runtime dependencies satisfied.

## Cut Order

If context or implementation scope grows, cut in this order:

1. Remove the test for `project_registered_runs` if project-trust test setup is complex (built-in coverage is sufficient for P3d-1)
2. Defer REQ-14 (privacy: result does not leak task/prompt) to a follow-up hardening pass — the monitoring defaults already enforce this

Do not cut:

- Built-in execution path (scout/planner/reviewer must work end-to-end)
- Schema structural no-prompt-override (must prove no prompt param exists)
- Recursion guard tests (all three layers must be proven)
- Regression: existing P3c-2/3/4 test suites must pass
- Same gate: `canRunAgent` must be called; unregistered/ephemeral must be denied

## Contracts

### `executeSubagentRun(agent: string, task: string, ctx: SubagentRunContext): Promise<SubagentRunOutcome>`

**Input contract:**
- `agent`: non-empty string — built-in name or registered user/project agent name
- `task`: non-empty string, ≤ spec.maxTaskChars (default 8000)
- `ctx`: SubagentRunContext with at minimum cwd, projectTrusted, hasUI, ui

**Output contract:** `SubagentRunOutcome` discriminated union — `ok: true` carries bounded text + structured details; `ok: false` carries error text + code + details.

**State table (exhaustive):**

| State | Condition | Output |
|---|---|---|
| A. Invalid input | `agent` empty/missing or `task` empty/oversize | `ok: false`, `code: "invalid-input"`, text explains which input |
| B. Built-in resolved | `agent` ∈ {scout, planner, reviewer}, gate passes | `ok: true`, text = compacted run result, details with agentName/status/durationMs |
| C. Registered user/project | `agent` resolved via `resolveRegisteredRunTarget`, re-read spec passes `canRunAgent` | `ok: true`, same shape as B |
| D. Gate denial | canRunAgent returns `ok: false` | `ok: false`, `code` = gate code, `text` = gate reason |
| E. Spawn/run error | child Pi fails to spawn, times out, or crashes | `ok: false`, `code: "spawn-error"` or `"timed-out"` or `"failed"`, text = error summary |
| F. Unresolved name | agent not built-in and not found in any registry | `ok: false`, `code: "agent-not-found"`, text = actionable message |
| G. Ambiguous name | multiple user/project specs with same name | `ok: false`, `code: "ambiguous-name"`, text = rename advice |

**Error codes:**

| Code | Trigger |
|---|---|
| `invalid-input` | empty/missing agent, empty/oversize task |
| `agent-not-found` | agent name not built-in and not in any registry |
| `ambiguous-name` | multiple registered specs share the same name |
| *gate code* | propagated from `canRunAgent`: `missing-spec`, `scanner-dangerous`, `user-unregistered`, `project-untrusted`, `project-registry-root-mismatch`, `project-unregistered`, `missing-trust-material`, `not-explicit-ephemeral`, etc. |
| `agent-not-runnable` | spec re-read returns status ≠ runnable (invalid/dangerous/shadowed) |
| `spawn-error` | child Pi failed to spawn |
| `failed` | child Pi ran but exited non-zero |

### `buildSubagentToolDefinition(): ToolDefinition<TParams, TDetails, TState>`

**Output contract:** Returns a valid `ToolDefinition` acceptable to `pi.registerTool()`.

**Schema:**

```ts
Type.Object({
  agent: Type.String({ description: "Built-in or registered agent name (scout, planner, reviewer, or a registered user/project agent)" }),
  task: Type.String({ description: "Delegated task for the subagent. Bounded, read-only scope only." }),
}, { additionalProperties: false })
```

- No `prompt` field — structural enforcement of no-prompt-override invariant.
- No `tools`, `model`, `thinking` fields — no authority expansion.
- `promptSnippet`: "run_subagent agent task — Delegate a read-only task to a built-in or registered agent"
- `promptGuidelines`: includes instructions about when to use, agent names, task scope, and the fact that child cannot call `run_subagent`

### `registerSubagentTool(pi: ExtensionAPI, sessionCtxRef: () => AgentsContext | undefined): void`

**Contract:** Registers the `run_subagent` tool on `pi` during extension load. The tool's `execute` builds a `SubagentRunContext` by merging the tool's `ExtensionContext` (cwd, hasUI, ui, isProjectTrusted) with the optional `sessionCtxRef` closure (for agentsPiCommand, agentsChildRunner, agentsHomeDir — falling back to production defaults when undefined).

## Edge Cases

| # | Scenario | Expected behavior | Test |
|---|---|---|---|
| EC1 | `agent` = "scout", `task` = valid → child runs → compacted result returned to LLM | Spawn scout, read-only tools, bounded text | `built_in_scout_runs_with_readonly_tools` |
| EC2 | `agent` = "nonexistent", not built-in, not in registry | `agent-not-found` error, no spawn | (implicit in resolve flow — tested via unregistered) |
| EC3 | User agent registered, but spec file modified (hash mismatch) | `canRunAgent` denies due to hash mismatch, no spawn | `hash_mismatch_denied_no_spawn` |
| EC4 | Project trust inactive, project agent registered | `project-untrusted` denial, no spawn | `project_untrusted_denied_no_spawn` |
| EC5 | `agent` = valid, `task` = "" (empty string) | `invalid-input` error, no spawn | `rejects_empty_task` |
| EC6 | `agent` missing from params entirely | `invalid-input` error, no spawn | `rejects_missing_agent` |
| EC7 | LLM passes `{ agent: "scout", task: "...", prompt: "do X" }` | Schema validation rejects unknown key OR execute ignores extra fields — target behaves like no prompt param | `schema_has_no_prompt_field` |
| EC8 | Child Pi exits non-zero (task is malformed for the child LLM) | Run result with `status: "failed"`, exitCode, stderr preview; `ok: false` to LLM | `built_in_scout_runs_with_readonly_tools` (runner already handles non-zero exits) |
| EC9 | Child Pi times out | Run result with `status: "timed-out"`; `ok: false` to LLM | Runner already tested in test-child-runner.mjs |
| EC10 | Child Pi exceeds stdout limit | Run result with `status: "output-limit-exceeded"`; `ok: false` to LLM; truncation flags set | Runner already tested |

## Test Case Catalog

Grouped by concern. Every test name here SHALL appear in the Requirements table.

```text
Group 1: Tool definition (schema + registration) (5 tests)
  tool_registered_with_name_and_schema
  schema_has_only_agent_and_task
  schema_has_no_prompt_field
  schema_has_no_tools_field
  schema_rejects_additional_properties

Group 2: Input validation (6 tests)
  rejects_empty_agent
  rejects_missing_agent
  rejects_empty_task
  rejects_oversize_task
  rejects_control_bytes_in_task
  rejects_whitespace_only_task

Group 3: Built-in execution (2 tests)
  built_in_scout_runs_with_readonly_tools
  built_in_planner_and_reviewer_run

Group 4: Registered user execution (3 tests)
  registered_user_runs_after_gate
  unregistered_user_denied_no_spawn
  hash_mismatch_denied_no_spawn

Group 5: Registered project execution (3 tests)
  project_untrusted_denied_no_spawn
  project_registered_runs
  project_trust_toggle_after_session_start_denies

Group 6: Ephemeral denial (1 test)
  ephemeral_agent_denied_no_spawn

Group 7: No prompt override + task safety (3 tests)
  child_uses_spec_prompt_not_caller_text
  task_with_flag_like_content_runs_as_literal_text
  schema_has_no_prompt_parameter  (also in Group 1)

Group 8: Recursion prevention (4 tests)
  child_argv_excludes_run_subagent
  child_argv_excludes_approve
  child_argv_includes_no_extensions
  child_pi_has_no_run_subagent_registered

Group 9: Gate denial edge cases (3 tests)
  dangerous_current_spec_denied_no_spawn
  invalid_current_spec_denied_no_spawn
  ambiguous_name_denied_no_spawn

Group 10: Result formatting (3 tests)
  completed_returns_bounded_text
  denial_returns_isError_true_with_code
  result_details_contain_only_allowlisted_fields

Group 11: Context freshness + parity (4 tests)
  tool_denies_when_session_context_undefined
  project_trust_toggle_after_session_start_denies
  built_in_path_parity_with_agents_run
  registered_path_parity_with_agents_run

Total: 36 tests.
```

## Risk Analysis

| Risk | Severity | Mitigation |
|---|---|---|
| Refactoring `runAgentCommand` to use shared `run-resolver.ts` breaks `/agents run` | Medium | Covered by existing P3c-2/3/4 test suites — run them before and after refactor |
| Tool `execute` cannot access `agentsPiCommand`/`agentsChildRunner` because `ExtensionContext` lacks them | Low | Both are optional; defaults (`"pi"`, real runner) are correct for production. Session `AgentsContext` captured on `session_start` for consistency with `/agents run`. |
| LLM uses `run_subagent` excessively (cost/rate-limit risk) | Low | Child Pi inherits timeout/output caps from spec limits. Parent Pi could add rate-limiting later; P3d-1 trusts the LLM to use tools judiciously (same as any tool). |
| `collectAgentDiagnostics` is async and may be slow for large agent directories | Low | Same call as `/agents run`. Acceptable latency for a tool call. |
| Test harness for tool schema validation requires importing TypeBox schema | Low | P3f-1 tests import from `profiles.ts` — same pattern. Test imports `buildSubagentToolDefinition` and inspects schema shape. |

## Open Decisions

| Decision | Deferral slice | Rationale |
|---|---|---|
| Rate-limiting `run_subagent` calls per turn | P3e+ | Parent LLM trust; child limits already bound per-run cost |
| `setActiveTools` toggling `run_subagent` based on config flag | P3e+ | Future kill-switch if needed; P3d-1 registers unconditionally |
| Structured output mode (terminate-on-tool) for `run_subagent` | Never | Anti-pattern: child output is advisory; should not terminate parent turn |
| Non-read-only tool delegation | P4+ | P3d-1 enforces read-only via spec tools; write-enabled roles are a future milestone |

## Done Criteria

All MUST requirements passing = done. Specifically:

- [ ] `npx --yes tsc --noEmit --strict agents/lib/subagent-tool.ts`
- [ ] `npx --yes tsc --noEmit --strict agents/lib/run-resolver.ts`
- [ ] `npx --yes tsx agents/test-fixtures/test-subagent-tool.mjs` — all 26 tests pass
- [ ] `bash agents/test-fixtures/run-p3d-1-tests.sh` — same 26 tests pass
- [ ] Existing suites pass: `bash agents/test-fixtures/run-p3c-2-tests.sh`, `run-p3c-3-tests.sh`, `run-p3c-4-tests.sh`
- [ ] `pi --no-extensions -e ./agents/index.ts --list-models` — extension loads, tool registered
- [ ] `git diff --stat -- agents/index.ts | agents/lib/child-args.ts | agents/lib/child-runner.ts | agents/lib/can-run-agent.ts | agents/lib/specs.ts | agents/lib/diagnostics.ts` — only expected changes (index.ts refactor + tool registration)

## Review Consensus

| Pass | Reviewer | Model | Blocker count | Verdict |
|---|---|---|---|---|
| 1 | Adversarial (no-tools, prompt-only) | anthropic/claude-opus-4.8 | 3 | conditional-go |
| 2 | Adversarial (runbook template, no-tools) | anthropic/claude-opus-4.8 | 2 | conditional-go |

### Resolved blockers

Review #1 (2026-06-17) — 3 blockers resolved:

| # | Blocker | Resolution |
|---|---|---|
| B1.1 | `task` delivery unspecified — possible argv/flag injection | Task delivered via stdin/private-temp-file (buildChildPiArgs pipeline). REQ-9 + test added. |
| B1.2 | Built-in agent shortcut bypasses `canRunAgent` gate | Confirmed parity: `/agents run` also skips canRunAgent for built-ins (built-ins = trusted extension code). REQ-17 parity test added. |
| B1.3 | Stale session_start context — TOCTOU on projectTrusted/cwd | REQ-16: only static handles (piCommand, childRunner) captured from session_start. cwd/projectTrusted re-resolved fresh each call from ExtensionContext. |

Review #2 (2026-06-17) — 2 blockers:

| # | Blocker | Resolution |
|---|---|---|
| B2.1 | `additionalProperties: false` missing on Type.Object schema — extra fields (`prompt`, `tools`, `model`, `thinking`) pass validation uncaught | ✅ Schema updated to `Type.Object({...}, { additionalProperties: false })`. Extra fields rejected at schema validation level before handler. REQ-1 updated. Test `schema_rejects_additional_properties` added. Test count: 35→36. |
| B2.2 | Built-in name shadowing — registered agent named identically to built-in (`scout`) intercepted by shortcut, skipping registered-path gate | **Intentional and safe.** Reserved built-in names take priority in both `/agents run` and the tool. The user's registered agent named "scout" cannot run anyway (scanner detects shadowed reserved names). Documented in invariants: "built-in resolution takes precedence; registered specs with reserved names are shadowed and blocked." |

### Resolved non-blocking concerns (review #2)

| # | Concern | Resolution |
|---|---|---|
| N1 | "2 structural" recursion claim partly misleading — Layer 2 (P3_FORBIDDEN_TOOLS) is defense-in-depth, not independent for the child | Clarified in recursion diagram: Layer 1 (--no-extensions) is primary structural guard. Layer 2 (P3_FORBIDDEN_TOOLS) is structural backstop for spec tool lists. Layer 3 (prompt) is behavioral. |
| N2 | `invocation (redacted)` under-specified — must strip task text AND temp-file path | Enumerated: invocation.redactedArgv only (no prompt text, no temp path). Specified in SubagentRunDetails type comment. |
| N3 | No breadth bound on delegation (parent LLM can call run_subagent arbitrarily many times sequentially) | Noted as resource-exhaustion concern (out of authority scope). Per-turn call cap deferred to P3e+. Child per-run limits (timeout/output) bound individual calls. |

## Appendix: Implementation Plan

### Files to create

1. `agents/lib/run-resolver.ts` — extracted shared run-resolution helpers: `resolveRegisteredRunTarget`, `executeChildRun`, `nextStepForRunBlock`
2. `agents/lib/subagent-tool.ts` — `buildSubagentToolDefinition`, `executeSubagentRun`, `registerSubagentTool`, `SubagentRunOutcome`, `SubagentRunContext`
3. `agents/test-fixtures/test-subagent-tool.mjs` — 26 pure helper + fake-child-runner tests
4. `agents/test-fixtures/run-p3d-1-tests.sh` — single-line runner

### Files to modify

| File | Change |
|---|---|
| `agents/index.ts` | (a) Extract `resolveRegisteredRunTarget`, `executeChildRun`, `nextStepForRunBlock` into `agents/lib/run-resolver.ts` — replace with imports. (b) Capture `sessionAgentsCtx` on `session_start`. (c) Call `registerSubagentTool(pi, () => sessionAgentsCtx)` in `agentsExtension`. (d) Export `runEphemeralCommand`, `saveTempCommand` and other test-used exports from index.ts (already exported via `export * from "./lib/ephemeral.ts"` — verify). |

### Implementation sequence

| Step | Action | Validation |
|---|---|---|
| 1 | Create `agents/lib/run-resolver.ts` — move `resolveRegisteredRunTarget`, `executeChildRun`, `nextStepForRunBlock` from `index.ts` with zero logic changes | `npx --yes tsc --noEmit --strict agents/lib/run-resolver.ts` |
| 2 | Update `agents/index.ts` — import from `run-resolver.ts`, remove moved functions, verify `/agents run` still works | `bash agents/test-fixtures/run-p3c-2-tests.sh` |
| 3 | Create `agents/lib/subagent-tool.ts` — `SubagentRunContext`, `SubagentRunOutcome`, `buildSubagentToolDefinition`, `executeSubagentRun`, `registerSubagentTool` | `npx --yes tsc --noEmit --strict agents/lib/subagent-tool.ts` |
| 4 | Wire tool registration in `agents/index.ts` — capture `sessionAgentsCtx` on `session_start`, call `registerSubagentTool(pi, ...)` | `npx --yes tsc --noEmit --strict agents/index.ts` |
| 5 | Write `agents/test-fixtures/test-subagent-tool.mjs` — all 26 tests, 10 groups | `npx --yes tsx agents/test-fixtures/test-subagent-tool.mjs` |
| 6 | Write `agents/test-fixtures/run-p3d-1-tests.sh` | `bash agents/test-fixtures/run-p3d-1-tests.sh` |
| 7 | Run regression suites: P3c-2, P3c-3, P3c-4 | All pass |
| 8 | Extension load smoke | `pi --no-extensions -e ./agents/index.ts --list-models` |
| 9 | Commit + PR | CI passes |

### Risks

| Risk | Mitigation |
|---|---|
| Extract refactor breaks `/agents run` in subtle ways | Step 2 validates with full P3c-2/3/4 suites BEFORE any subagent-tool code is written |
| Tool schema validation: unknown keys slip through without `additionalProperties: false` | Low | Schema uses `Type.Object({...}, { additionalProperties: false })` — extra fields (`prompt`, `tools`, `model`, `thinking`) rejected at schema validation level before reaching handler. Test `schema_rejects_additional_properties` proves rejection. |
| Fake child runner tests don't prove real `--no-extensions` argv | Test asserts argv includes `--no-extensions` token (same pattern as test-child-runner.mjs). Proven end-to-end in P3c-2/3. |
| `session_start` fires after first tool call (race) | `session_start` fires before any LLM turn. The tool is not callable until the extension finishes loading. |
