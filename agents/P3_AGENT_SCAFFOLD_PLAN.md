# P3 Agent/Subagent Scaffold Plan

## Status

Planning only. Do not implement until this plan, plan review, and adversarial review are accepted.

## Episode Search Summary

Searched episodic memory for `pi agent design`, `subagent`, `agents`, and the canonical workplan.

Key active memories:

- `20260614-100617-best-b911` (global): best practices for creating agents in Pi. Use child `pi --mode json -p --no-session`, prefer user-level Markdown agents, treat project-local agents as untrusted unless explicitly enabled, use narrow tool allowlists, cap child output/concurrency, avoid recursive fan-out, avoid leaking delegated prompts via process arguments, preserve structured details while truncating parent-visible content. P3 refines this by supporting project-level agents through project trust plus project-scoped raw-file-byte exact-hash registration.
- `20260614-095210-canonical-workplan-updated-after-p3-proo-60c0`: P3 inheritance proof is complete; next priority is minimal agent/subagent scaffold planning. Do not build full workflows yet.
- `20260614-095159-child-pi-json-subprocesses-inherit-globa-1860`: child `pi --mode json --no-session -p` subprocesses inherit globally installed extensions; keep explicit `-e ~/.pi/agent/extensions/tool-context-loader/index.ts` fallback.
- `20260614-003638-pi-ae25`: Pi extension best practices: use commands/tools conservatively, respect `ctx.hasUI`, keep diagnostics bounded, preserve extension independence.
- `GITHUB_PI_EXTENSION_RESEARCH.md`: ecosystem patterns favor short prompts, read-only subagents by default, explicit tool lists, output bounds, state/history only when needed, and isolated supervisor/subagent contexts.
- `AGENTIC_WORKPLAN_FORMAT.md`: staged workflows first; define context, tool, guardrail, evaluation, and observability boundaries.

Several older agent-related memories were truncated by the known episodic-memory wrapper bug and are not reliable as source material.

## Objective

Build the smallest useful Pi extension scaffold for launching bounded child Pi subprocesses as role-specialized subagents.

This milestone proves:

1. Ephemeral one-shot agents can be run safely from explicit user prompts without persistence.
2. User-level and project-level Markdown agent definitions can be discovered safely.
3. Project-level agents can be registered with project-scoped raw-file-byte exact-hash trust so projects can ship essential agents without silent auto-execution.
4. An extension can construct safe child Pi invocations.
5. Child prompts are passed privately by stdin or temp file, not exposed as process arguments.
6. Child JSONL output can be parsed and bounded.
7. Roles apply conservative prompts and tool allowlists.
8. The parent Pi receives a compact, auditable result with structured details.
9. `tool-context-loader` global inheritance works in real subagent calls, with explicit fallback available.

## Non-Goals

Out of scope for P3 scaffold:

- broad autonomous workflow expansion
- parallel/background subagents
- persistent child sessions
- unregistered project-local agents auto-running by default
- child access to `run_subagent` unless explicitly allowed in a later milestone
- write/edit tools in children
- bash in children by default
- cross-agent memory
- automatic project trust escalation
- long embedded runbooks or copied tool-context-loader bodies

## Extension Shape

Initial extension path:

```text
agents/index.ts
```

Rationale:

- Keeps agent/subagent functionality independent from `tool-context-loader`.
- Matches existing repo extension layout.
- Avoids hiding subprocess behavior inside the loader.
- Leaves room for package-level README/tests under `agents/`.

Initial user-facing interface:

```text
/agents
/agents config
/agents list
/agents inspect <name>
/agents run-temp <base-role> <task>
/agents save-temp <name>
/agents register <path-or-name>
/agents register-project [--all-safe]
/agents unregister <name>
/agents registry
/agents verify
/agents doctor
/agents run <agent-or-role> <task>
/agents chain <agent-or-role>[,<agent-or-role>...] <task>
```

Initial LLM-callable interface:

```text
run_subagent
```

Safety constraints for `run_subagent`:

- enabled only after command path/helper tests pass
- only single child run in P3; chain mode remains command-only unless separately reviewed
- no arbitrary prompt override in P3
- child tool allowlist remains read-only
- child prompt must instruct that spawning subagents is unavailable
- parent command builder must exclude `run_subagent` from child tool lists unless a future config explicitly allows recursion

## Agent Specification Contract

Detailed agent specs live in:

```text
agents/AGENT_SPEC.md
```

That document is the source of truth for each agent's runtime behavior, safety boundaries, monitoring expectations, and eval requirements. Every built-in/repo-developed agent must have an explicit spec before implementation.

P3 implementation must follow `AGENT_SPEC.md` for:

- built-in reserved specs: `scout`, `planner`, `reviewer`
- ephemeral one-shot specs from explicit user prompts
- user-level Markdown specs from `~/.pi/agent/agents/*.md`
- project-level Markdown specs from `.pi/agents/*.md`, discoverable only when project trust is active and runnable only after project-scoped raw-file-byte exact-hash registration
- spec fields: name, description, source, tools, model, thinking, prompt, input/output contracts, evals, limits, observability, safety
- prompt/task transport: stdin or private temp file, not argv
- model/thinking handling
- monitoring/privacy rules
- local pre-commit/review eval requirements

Security model and trusted registration are defined in:

```text
agents/SECURITY_MODEL.md
```

TUI/user registration guidance is defined in:

```text
agents/REGISTRATION_GUIDE.md
```

P3 security decision: built-in agents are trusted as part of the installed extension; ephemeral agents can run once from explicit slash/direct user prompts without persistence under strict read-only/default safety constraints; user-level Markdown specs are discoverable but not runnable until registered by exact path + raw-file-byte SHA-256 hash; project-level Markdown specs are discoverable only after project trust and not runnable until registered in the current project's exact raw-file-byte hash registry.

All execution paths must use a shared runtime gate before child argv construction:

```text
resolve spec -> validate -> scan -> check trust/registry -> canRunAgent -> build child argv
```

This gate applies to `/agents run`, `/agents chain`, `run_subagent`, saved ephemeral specs, project-level specs, and future workflow commands.

## Ephemeral One-Shot Agents

P3 supports temporary agents for explicit user requests such as:

```text
Create a reviewer agent with this prompt "..." and run it once.
```

Default behavior:

- ask/confirm whether to run as an ephemeral one-shot or save for reuse when the request is ambiguous
- run once with `source=ephemeral`, `registered=no`, `persisted=no`
- base role must be `scout`, `planner`, or `reviewer`
- use read-only P3 tool allowlist
- scan the temporary prompt before execution
- fail closed for suspicious prompts in non-TUI mode
- reject dangerous prompts
- require user confirmation for suspicious prompts when UI is available
- do not save or register automatically
- do not expose arbitrary ephemeral prompt overrides through `run_subagent` in P3
- after the run, guide the user:
  ```text
  To reuse this agent, run /agents save-temp <name>, then /agents register <name>.
  ```

Saving flow:

1. `/agents save-temp <name>` validates name and writes `~/.pi/agent/agents/<name>.md` after confirmation.
2. Saving does not make the agent runnable.
3. User reviews and registers it with `/agents inspect <name>` and `/agents register <name>`.

Ephemeral agents do not need eval fixtures for one-shot use. Once saved as a user-level agent, they show `evals: missing` unless a companion eval exists.

## Initial Roles

### `scout`

Purpose: read-only reconnaissance.

Allowed child tools:

```text
read,grep,find,ls
```

Output contract:

- files/paths inspected
- concise findings
- unknowns and follow-up questions
- no long implementation plan

### `planner`

Purpose: implementation or validation planning.

Allowed child tools:

```text
read,grep,find,ls
```

Output contract:

- proposed files to change
- staged steps
- risks and validation commands
- explicit out-of-scope items

### `reviewer`

Purpose: adversarial review of a plan, diff, or design.

Allowed child tools for P3:

```text
read,grep,find,ls
```

Later optional reviewer bash may be considered only for tightly scoped commands such as `git diff` or validation logs. It is not included in P3.

Output contract:

- blocking issues
- non-blocking issues
- missing tests/validation
- safety/security concerns
- verdict: `go`, `conditional-go`, or `no-go`

## Child Pi Invocation

Use argument arrays with `spawn`, never shell string concatenation.

Default argv shape:

```bash
pi --mode json --no-session \
  --tools read,grep,find,ls \
  -p
```

The role prompt and task are supplied via child stdin. If stdin-only `-p` behavior is unreliable in Pi, use a private temp prompt file and pass only the temp path as an `@file` argument, then clean it up.

Do **not** put the delegated task text directly in process arguments.

Configurable options:

- `model`: optional explicit child model pattern
- `thinking`: optional explicit child thinking level (`off|minimal|low|medium|high|xhigh`)
- `timeoutMs`: default 120000
- `maxStdoutBytes`: default 1048576
- `maxStderrChars`: default 4000
- `maxResultChars`: default 12000
- `maxJsonLineBytes`: default 262144
- `maxChildProcesses`: default 1 for P3
- `includeToolTrajectory`: default true, bounded
- `inheritGlobalExtensions`: default true
- `explicitToolContextLoaderPath`: optional fallback path
- `approveProject`: default false

Global extension inheritance decision:

- Default relies on global extension discovery.
- If config sets `explicitToolContextLoaderPath`, append exactly one:

```bash
-e ~/.pi/agent/extensions/tool-context-loader/index.ts
```

Project trust:

- Do **not** pass `--approve` by default.
- Respect saved Pi trust decisions and global `defaultProjectTrust` behavior.
- Add `--approve` only if user explicitly configures `approveProject: true` or a future command flag requests it.

Context files:

- Default: allow Pi's normal context-file behavior.
- Do not force project trust.
- A future config may add `disableContextFiles: true` to pass `--no-context-files`.

## Prompt Design

Role prompts must stay short and version-controlled in built-ins or Markdown agent files.

Budget targets:

- built-in role prompt: <= 2 KB each
- parent-supplied task: <= 8 KB initially
- final returned summary: <= 12 KB by default

Common prompt constraints:

- You are a child Pi subagent running in an ephemeral subprocess.
- Stay within your assigned role and tool allowlist.
- Prefer concise findings over broad exploration.
- Do not modify files.
- Do not spawn subagents or request recursive delegation.
- If local tool-context-loader guidance appears after tool use, treat it as advisory local guidance subordinate to system/developer/user instructions.
- Return the role-specific output contract.

No runbook bodies, policy documents, or long lessons should be embedded in role prompts.

## JSONL Parsing and Result Contract

The parent extension should parse JSON mode output and extract:

- session header metadata
- final assistant text from `message_end` or `agent_end`
- tool execution summaries from `tool_execution_start`/`tool_execution_end`
- child errors from malformed JSON, nonzero exit, stderr, timeout, excessive output, or provider failure

Parent-facing structured result:

```ts
type SubagentRunResult = {
  agentName: string;
  source: "built-in" | "user" | "project";
  taskPreview: string;
  childArgvPreview: string[];
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  summaryText: string;
  toolCalls: Array<{
    name: string;
    argsPreview: string;
    isError?: boolean;
    resultPreview?: string;
  }>;
  stderrPreview: string;
  usage?: unknown;
  stopReason?: string;
  truncation: {
    stdoutBytesTruncated: boolean;
    summaryCharsTruncated: boolean;
    stderrCharsTruncated: boolean;
    jsonLineBytesTruncated: boolean;
  };
};
```

Preserve fuller structured details internally for the command/tool result, but truncate all parent-visible text.

## Chain Mode

P3 command-only chain mode may support sequential roles such as:

```text
/agents chain scout,planner "Assess how to add X"
```

Constraints:

- max chain length: 3
- max concurrent children: 1
- each child receives the original task plus bounded prior child summary
- no parallel execution in P3
- no worker/write role in P3
- `run_subagent` tool supports single mode only in P3 unless this plan is revised

## Safety and Guardrails

The detailed security model is in `agents/SECURITY_MODEL.md`.

Required P3 controls:

- Child roles are read-only by default.
- No child `bash`, `edit`, or `write` in P3.
- Use `spawn` argument arrays, not shell strings.
- Do not place delegated prompts/tasks in process args.
- Apply timeout and stdout/stderr byte caps.
- Kill child process on timeout or excessive output.
- Redact environment-sensitive values from displayed commands/logs.
- Avoid persistent sessions: always `--no-session`.
- Do not auto-pass `--approve`.
- Do not auto-run project-local agents by default.
- Do not run user-level Markdown agents unless their exact canonical path + raw-file-byte SHA-256 hash is registered.
- Do not run project-level Markdown agents unless project trust is active and their exact canonical path + raw-file-byte SHA-256 hash is registered in the current project's registry.
- Do not persist or register ephemeral agents automatically.
- Proactively recommend `/agents doctor` or `/agents register-project` when trusted project agent specs exist but are not runnable.
- Treat changed registered specs as unregistered until reviewed again.
- Do not register dangerous specs.
- Do not expose recursive subagent spawning to children.
- If command args are empty or agent name invalid, show usage only.
- If child Pi exits nonzero, return a structured error summary, not raw unlimited output.

## Observability and Monitoring

Pi provides two useful observability surfaces for this extension:

1. Parent extension event hooks:
   - `agent_start` / `agent_end`
   - `turn_start` / `turn_end`
   - `message_start` / `message_update` / `message_end`
   - `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
   - `session_start` / `session_shutdown` / compaction and session events
   - `ctx.getContextUsage()` for context-window usage
   - assistant messages include model/provider, usage tokens, cost, stop reason, and errors when available
2. Child `pi --mode json` event stream:
   - session header
   - agent/turn/message lifecycle events
   - streaming message updates, including thinking deltas when emitted
   - tool execution start/update/end with args/results/error state
   - queue, compaction, and auto-retry events

P3 monitoring should be implemented by parsing the child JSONL stream incrementally and reducing it into a bounded trace.

Initial command/tool output should include:

- agent name and source
- duration
- child exit status and stop reason
- child model/provider when available
- usage/cost when available
- timeout/truncation flags
- compact tool trajectory
- final assistant summary

Optional non-model-visible monitoring state may use `pi.appendEntry(customType, data)` in the parent session. `appendEntry` persists extension state but does not enter LLM context. P3 default should keep this off unless a user command/config enables it.

Recommended future commands:

```text
/agents runs
/agents show <run-id>
```

P3 may include in-memory run history for the current parent process only:

- default max runs retained: 20
- no full prompt/task persistence by default
- retain task preview, agent name, status, duration, tool-call summaries, usage/cost, truncation flags, and error previews

`/agents config` should show effective config, including whether explicit tool-context-loader fallback is active, current `projectTrust: active|inactive` from `ctx.isProjectTrusted()`, whether project-level agent discovery/registration is available, registry paths, whether persistent monitoring is disabled, and recommended next steps for blocked project agents.

### `/agents doctor`

P3 should include a `doctor` command for consistency checks. It should be safe, read-only, bounded, deterministic, and not model-backed. It must scan only known spec directories with file-size/frontmatter caps and must not invoke child Pi or provider calls.

Checks:

1. extension config parse status
2. project trust status from `ctx.isProjectTrusted()`
3. user-level spec discovery status
4. project-level spec discovery status, when trust is active
5. spec parser validation errors/warnings
6. scanner risk status
7. registry entries present/missing/hash-mismatched/stale
8. reserved-name shadowing
9. tool allowlist violations
10. model/thinking validation conflicts
11. eval fixture present/missing status
12. prompt/task transport mode
13. child Pi argv readiness (`--mode json`, `--no-session`, no `--approve`, no prompt/task in argv)
14. explicit tool-context-loader fallback status

Output should include:

```text
Status: ok | action-needed | blocked
Issues:
  - ...
Recommended next steps:
  1. /trust ...
  2. /agents register-project
  3. /agents inspect <name>
```

`/agents doctor` should be the command other commands point to when there are multiple issues. In TUI mode, `/agents doctor`, `/agents register`, `/agents register-project`, and `/agents save-temp` should follow `agents/REGISTRATION_GUIDE.md` and guide the user until the agent is runnable or clearly blocked.

No persistent audit log in P3 unless explicitly enabled by a later review.

## Validation and Agent Evaluation Plan

The validation plan is also the initial agent eval plan, but split into two layers:

1. **Engineering contract validation**: deterministic tests for parser, command construction, safety caps, and JSONL reduction.
2. **Agent behavior evals**: scenario fixtures that check role adherence, tool trajectory, bounded output, and required output sections.

P3 should not depend on paid/provider-backed evals in CI. Use deterministic fixtures and fake child JSONL streams for the local eval command, but do not require agent behavior evals in CI. Keep live model evals as manual smoke until a fake provider or stable eval harness exists and is explicitly approved.

Source-backed eval practices to apply:

- Evaluate both final answer and trajectory/process. Google ADK's eval guidance frames agent eval as grading both the final response and the logic/tools used to get there, especially whether the right tool was called at the right time.
- Use trace-backed evals. OpenAI's agent workflow evals are organized around traces, graders, datasets, and eval runs; P3's JSONL monitor should provide the local trace substrate.
- Keep evals automated and lifecycle-oriented. Anthropic emphasizes automated evals that run during development and expose behavioral changes before production.
- Use multiple evaluation perspectives. Langfuse describes black-box/final-output, glass-box/trajectory, and white-box/component evaluation strategies; P3 should start with final-output contracts plus trajectory checks.
- Reuse agent-trajectory concepts. LangChain's `agentevals` package focuses on intermediate steps/trajectory as a useful conceptual starting point.

Reference URLs:

- https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- https://developers.openai.com/api/docs/guides/agent-evals
- https://codelabs.developers.google.com/adk-eval/instructions
- https://langfuse.com/guides/cookbook/example_pydantic_ai_mcp_agent_evaluation
- https://github.com/langchain-ai/agentevals

### Requiring Evals for Agents We Develop

Every built-in/repo-developed agent must ship with eval fixtures before it can be considered supported. New agents are not accepted as "done" unless they add or update their evals.

Recommended repo layout:

```text
agents/evals/
  scout.eval.json
  planner.eval.json
  reviewer.eval.json
agents/test-fixtures/
  test-agent-evals.mjs
  fixtures/
    child-jsonl/
```

Minimal eval fixture schema:

```json
{
  "agent": "planner",
  "evals": [
    {
      "id": "planner-basic-plan-contract",
      "scenario": "Plan a small extension documentation change",
      "input": "Assess how to document X without implementing it.",
      "fakeChildJsonl": "fixtures/child-jsonl/planner-basic.jsonl",
      "expectedTools": ["read", "grep"],
      "forbiddenTools": ["write", "edit", "bash", "run_subagent"],
      "requiredSections": ["proposed files", "staged steps", "risks", "validation", "out of scope"],
      "maxSummaryChars": 12000,
      "mustNotContain": ["FULL_DELEGATED_PROMPT", "THINKING_DELTA_SENTINEL"]
    }
  ]
}
```

Required gate for repo-developed agents:

1. Agent definition exists.
2. At least one eval fixture exists for the agent.
3. Eval covers final output contract.
4. Eval covers expected/forbidden tool trajectory.
5. Eval covers output bounds.
6. Eval covers privacy/non-persistence expectations.
7. Eval can be invoked locally before commit via `node agents/test-fixtures/test-agent-evals.mjs`.

Do **not** put agent behavior evals in CI for P3. Evals should be easy to run before commit and during review, but CI should stay limited to deterministic engineering tests unless we later add a stable fake-provider harness with explicit approval.

User-level and project-level agents should not be blocked solely for missing evals in P3, but `/agents list` should mark them as `evals: missing` unless a companion eval file exists. A later strict mode can require evals before non-built-in agents are runnable.

Automated tests under:

```text
agents/test-fixtures/
```

Required engineering contract tests:

1. Agent name validation accepts only safe names.
2. Built-in roles exist for `scout`, `planner`, `reviewer`.
3. User-level and project-level Markdown parser accepts valid frontmatter/body.
4. Project-level discovery requires active project trust and project-scoped registry before run.
5. Command parsing treats everything after role as raw task.
6. Command construction uses argument arrays and never shell-concatenates the task.
7. Delegated prompt is sent through stdin or private temp file, not argv.
8. Default role tool allowlists are read-only.
9. `--no-session` and `--mode json` are always included.
10. `--approve` is absent by default.
11. Agent-specific `model` adds `--model <pattern>`.
12. Agent-specific `thinking` adds `--thinking <level>` and rejects invalid/conflicting thinking values.
13. Explicit `tool-context-loader` fallback adds exactly one `-e <path>` pair.
14. Child tool list excludes `run_subagent` by default.
15. JSONL monitor reduces child events into run status, tool trajectory, final summary, stop reason, usage/cost, and truncation flags.
16. JSONL parser extracts final assistant text.
17. JSONL parser handles malformed lines gracefully.
18. Output truncation marks truncation flags.
19. Timeout path returns structured error.
20. Chain mode enforces max length and sequential handoff.
21. User-level agent cannot run unless exact canonical path + raw-file-byte SHA-256 hash is registered.
22. Registered agent raw-byte hash mismatch is treated as unregistered.
23. Dangerous scanner result cannot be registered.
24. Suspicious specs require per-spec explicit TUI confirmation and are excluded from `--all-safe`.
25. Non-TUI registration writes no registry entries and fails closed with next commands.
26. `/agents config`, `/agents list`, `/agents verify`, `/agents doctor`, and `/agents register-project` surface project trust status using `ctx.isProjectTrusted()`.
27. Project-level agent specs are discoverable only after project trust and cannot run until registered in the current project's registry.
28. Ephemeral one-shot agents run only from explicit slash/direct user prompts, are scanned, are not persisted by default, and offer save/register guidance afterward.
29. `run_subagent` does not accept arbitrary prompt override in P3.
30. Chain mode preflights every agent through `canRunAgent` before starting the first child.
31. Project registry path uses a canonical project root SHA-256 and approvals do not apply across different roots.
32. `/agents doctor` reports project registry root mismatch.
33. Proactive project-agent recommendations are shown once per status change and point to `/agents doctor` or `/agents register-project`.

Required agent behavior eval fixtures:

1. `scout` eval: given fake child events with read/grep/find/ls trajectory, reducer returns inspected paths, concise findings, and no implementation-heavy output.
2. `planner` eval: given a planning scenario, output contains proposed files, staged steps, risks, validation commands, and out-of-scope items.
3. `reviewer` eval: given a diff/review scenario, output contains blocking issues, non-blocking issues, missing tests, safety concerns, and one verdict.
4. Tool-trajectory eval: fail if a role attempts tools outside its allowlist.
5. Bounds eval: fail if parent-visible summary/tool previews exceed configured caps.
6. Privacy eval: fail if full delegated prompt/task or thinking text appears in persisted/in-memory monitoring records.
7. Error eval: malformed JSONL, child nonzero exit, timeout, and stderr-only failure all produce structured errors.
8. Security eval: unregistered user/project agent, hash-mismatched agent, dangerous spec, suspicious non-TUI prompt/spec, dangerous ephemeral prompt, saved-but-unregistered ephemeral spec, forbidden tool widening, recursive `run_subagent`, prompt override in `run_subagent`, chain preflight failure, and untrusted project-local spec attempts all fail closed.

Suggested eval matrix columns:

```text
Eval ID | Role | Scenario | Expected trajectory | Expected output contract | Fixture/Command | Status
```

Smoke/manual validation:

```bash
pi --no-extensions -e ./agents/index.ts --list-models
pi --no-extensions -e ./agents/index.ts --mode json --no-session -p "noop"
```

After implementation, live command smoke may be run only if provider credentials/model are available:

```text
/agents run scout "Inspect this repo and list top-level extensions only."
/agents chain scout,planner "Assess a minimal README-only change."
```

CI should run deterministic engineering tests only. Agent behavior evals should be locally invokable before commit/review, not required in CI for P3. Provider-backed child Pi runs should remain manual unless a test provider/fake mode is introduced and explicitly approved for CI.

## Milestones

### P3a: plan and review

- Create this plan.
- Create plan review.
- Create adversarial review.
- Decide whether command + single `run_subagent` P3 is accepted.

### Implementation Slicing

Detailed implementation slices and the implementation strategy table are in:

```text
agents/P3_IMPLEMENTATION_SLICES.md
```

Use that file as the implementation sequencing guide. The high-level milestone ladder below is intentionally coarse; actual PRs should follow the smaller P3b/P3c/P3d slice ladder.

### P3b: definitions, specs, registry, diagnostics

Implement in slices:

- P3b-1: core spec model and built-ins
- P3b-2: Markdown parser and deterministic scanner, using vendored shared scanner `shared/security-scan.ts -> agents/lib/security-scan.ts`
- P3b-3: registry and shared `canRunAgent` runtime gate
- P3b-4: diagnostics commands and proactive guidance
- P3b-5: registration flows

Do not add child process execution until P3b-3 is complete and tested.

### P3c: child runner, JSONL parser, command execution

Implement in slices:

- P3c-1: JSONL monitor/parser and child argv builder using fake outputs only
- P3c-2: command-only built-in child execution
- P3c-3: registered user/project execution
- P3c-4: ephemeral one-shot agents

### P3d: model-callable tool and chain mode

Implement in slices:

- P3d-1: `run_subagent` single-run tool with no prompt override
- P3d-2: command-only chain mode with full preflight

### P3e: docs, local eval command, smoke

- Add README docs.
- Add local eval command docs.
- Run extension load smoke.
- Re-review before considering parallel, background, worker, verifier, or write-enabled roles.

## Done Criteria for P3 Scaffold

- Built-in `scout`, `planner`, `reviewer` work.
- Ephemeral one-shot agents run safely, are not persisted by default, and guide users to save/register for reuse.
- User-level Markdown agent discovery works for safe names and raw-file-byte exact-hash registration.
- Project-level Markdown agent discovery works after project trust and requires project-scoped raw-file-byte exact-hash registration before run.
- `/agents doctor` reports configuration/trust/registry/spec/eval consistency and recommends next steps.
- TUI registration guide can take a user from discovered/saved spec to runnable registered agent without bypassing confirmation gates.
- Project-agent recommendations appear proactively without noisy repeated notifications.
- Command path works for single and bounded chain runs.
- `run_subagent` supports single read-only runs only.
- Deterministic tests pass.
- Extension load smoke passes.
- No write/edit/bash child tools by default.
- Delegated prompts/tasks are not exposed in process args.
- Output bounds are enforced and tested.
- Explicit `-e` fallback is supported but not required by default.
- README documents limitations and safety defaults.
- No parallel/background/full workflows are added.
