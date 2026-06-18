# P3 Agent/Subagent Scaffold Plan Review

Review target: `agents/P3_AGENT_SCAFFOLD_PLAN.md`

## Verdict

**Conditional go for P3a planning.**

The revised plan incorporates the global episode `20260614-100617-best-b911` and is now closer to the intended Pi-agent design: user-level Markdown agents, child `pi --mode json -p --no-session`, safe prompt transport, read-only defaults, structured details, and hard output bounds.

Implementation should proceed only after adversarial review findings are addressed or explicitly accepted.

## What Looks Strong

1. **Scope is still bounded.** P3 excludes parallel/background execution, persistent child sessions, worker/write roles, unregistered project-local auto-run, and full autonomous workflows.
2. **Agent specs are explicit.** `agents/AGENT_SPEC.md` is the source of truth for runtime behavior, tools, model/thinking, prompt, input/output contracts, evals, monitoring, limits, and safety boundaries.
3. **Security model is explicit.** `agents/SECURITY_MODEL.md` defines trusted registration, raw-file-byte exact-hash approvals, prompt/spec/contract protection, and security eval cases.
4. **Ephemeral one-shot agents are supported safely.** Explicit user prompts can run once under read-only/default constraints without persistence, then guide users to save/register for reuse.
5. **User-level and project-level Markdown agents are included safely.** User specs require raw-file-byte exact-hash registration; project specs require project trust plus project-scoped raw-file-byte exact-hash registration.
6. **Ease/security balance is explicit.** Projects can ship essential `.pi/agents/*.md`, blocked project agents point to actionable registration, and proactive recommendations guide users without silently running repo-controlled prompts.
7. **Doctor diagnostics are included.** `/agents doctor` provides one consistency check for config, trust, registry, specs, scanner status, eval metadata, and child-run readiness.
8. **TUI registration guide is specified.** `agents/REGISTRATION_GUIDE.md` defines wizard-style flows for `/agents register`, `/agents register-project`, `/agents save-temp`, and `/agents doctor` so users can reach runnable status with clear confirmations.
9. **Prompt privacy improved.** Delegated task text must go through stdin or a private temp file, not argv.
7. **Read-only defaults remain.** `scout`, `planner`, and `reviewer` use `read,grep,find,ls` only in P3.
8. **Subprocess inheritance is used correctly.** Default global extension inheritance is supported, with explicit `-e` fallback retained.
9. **Recursion is explicitly blocked.** Child tool allowlists must exclude `run_subagent` unless a future milestone deliberately enables recursion.
10. **Project trust is conservative.** The plan does not auto-pass `--approve`; project specs only participate after trust and registration.
11. **Output bounds are first-class.** Timeout, stdout/stderr caps, JSON-line caps, result truncation, and chain length caps are included.
12. **Monitoring has native Pi support.** Parent extension events and child JSONL event streams expose agent/turn/message/tool lifecycles, stop reasons, usage/cost, and errors.
13. **Tests focus on deterministic behavior.** Command construction, discovery, parser behavior, truncation, timeout, monitoring reduction, role validation, and initial agent behavior eval fixtures can be tested without provider calls.
14. **Repo-developed agents have a pre-commit eval gate.** Built-in agents must ship with companion eval fixtures that can be invoked locally before commit/review; P3 should not require agent behavior evals in CI.

## Required Clarifications Before Implementation

### 1. Prove stdin-only `-p` behavior before depending on it

The plan prefers:

```bash
pi --mode json --no-session -p
```

with prompt text on stdin. The README says print mode reads piped stdin and merges it into the initial prompt, but implementation should include a small smoke or fake runner test before relying on it for live usage.

Fallback is acceptable:

- write prompt to a private temp file
- pass only `@/tmp/...` as argv
- clean up temp file in `finally`

### 2. Define Markdown parser limits

Agent files can become another prompt-injection surface. P3 should use a small bounded parser like `tool-context-loader`, not full unbounded YAML.

Recommended limits:

- max file size: 64 KiB
- max frontmatter bytes: 8 KiB
- accepted scalar/list fields only: `name`, `description`, `tools`, `model`, `thinking`
- safe name regex: `^[a-z][a-z0-9_-]{0,63}$`
- thinking value allowlist: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`
- reject or warn on unknown `tools` outside allowed P3 set

### 3. Keep `run_subagent` simple or defer if tests slip

The global episode recommends an extension tool, but a model-callable subprocess launcher is still a safety surface.

Recommendation:

- implement commands first
- add `run_subagent` only after helper tests and command construction tests pass
- keep P3 tool to single child run only
- no chain/parallel from the tool in P3

### 4. Define exact command grammar

Recommended minimal grammar:

```text
/agents
/agents config
/agents list
/agents run scout <task>
/agents run planner <task>
/agents run reviewer <task>
/agents chain scout,planner <task>
```

Everything after the role/chain should be treated as the raw task string.

### 5. Stderr must stay diagnostic-only

Pi extension errors, provider errors, and warnings may appear on stderr.

Recommendation:

- keep `stderrPreview` <= 4000 chars
- label it as child process diagnostics
- never merge stderr into `summaryText`

### 6. Avoid persistent logging in P3

The result includes task previews and child details. P3 should not persist these by default.

Recommendation:

- no audit file in P3
- no session persistence in children
- parent-visible task preview only, not full task, unless user explicitly requested display

### 7. Model and thinking selection should remain simple

Pi supports `--model <pattern>`, model thinking shorthand such as `sonnet:high`, and explicit `--thinking <level>`. Recommendation:

- if agent/model config is absent, omit `--model`
- if present, pass exactly `--model <pattern>`
- if agent `thinking` is present, pass exactly `--thinking <level>`
- reject invalid thinking values and conflicting `model: name:thinking` plus `thinking: other-level`
- no provider routing or per-workflow model policy in P3

## Suggested Implementation Order

Use `agents/P3_IMPLEMENTATION_SLICES.md` as the authoritative implementation sequence. The previous broad P3b/P3c/P3d grouping is too large for context-efficient implementation.

Recommended order:

1. P3b-1: core spec model and built-ins.
2. P3b-2: Markdown parser and deterministic scanner.
3. P3b-3: registry and shared `canRunAgent` runtime gate.
4. P3b-4: diagnostics commands and proactive guidance.
5. P3b-5: registration flows.
6. P3c-1: JSONL monitor/parser and child argv builder using fake outputs only.
7. P3c-2: command-only built-in child execution.
8. P3c-3: registered user/project execution.
9. P3c-4: ephemeral one-shot agents.
10. P3d-1: `run_subagent` single-run tool with no prompt override.
11. P3d-2: command-only chain mode with full preflight.
12. P3e: README, local eval command docs, smoke validation.

## Validation Expectations

Minimum local validation after implementation:

```bash
node agents/test-fixtures/test-agents.mjs
pi --no-extensions -e ./agents/index.ts --list-models
```

Optional live/manual validation:

```text
/agents run scout "List this repo's top-level Pi extensions and stop."
```

CI should run deterministic tests only.

## Conditional Go Criteria

Proceed to implementation only if the adversarial review does not identify a blocker requiring plan changes. If blockers are found, revise `P3_AGENT_SCAFFOLD_PLAN.md` before writing functional `agents/index.ts`.
