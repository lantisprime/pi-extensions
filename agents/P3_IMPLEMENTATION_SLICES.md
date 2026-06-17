# P3 Implementation Slices

This file turns the P3 agent scaffold plan into smaller implementation slices for better token/context efficiency and safer review.

## Why Slice Further

The current P3 scope includes specs, scanner, registry, TUI guidance, doctor diagnostics, child Pi execution, ephemeral agents, `run_subagent`, and chain mode. Implementing this in one pass would create too much context pressure and too many interacting failure modes.

Implementation should proceed in small PRs where each slice has a narrow objective, focused tests, and a clear stop point.

## Current Status

Completed and merged:

- P3b-1: core spec model and built-ins, PR #18, commit `9f213f7`
- P3b-2: Markdown parser and deterministic scanner, PR #19, commit `c5bb433`
- P3b-3: registry and runtime gate, PR #20, commit `44e2b43`
- P3b-4: diagnostics commands and proactive guidance, PR #21, commit `21a8ed0`
- P3b-5: registration flows, PR #22, commit `691f001`
- P3c-1: JSONL monitor/parser and child argv builder, PR #26, commit `dddb726`
- P3c-2: command-only built-in child execution, PR #27, commit `6c7d885`

Current slice:

- P3c-3: registered user/project execution.

Current hard stop: P3c-3 is limited to `/agents run <registered-user-agent> <task>` and `/agents run <registered-project-agent> <task>` after the shared `canRunAgent` runtime gate passes. It must not add unregistered spec execution, ephemeral agents, `run_subagent`, chain mode, parallel execution, or broad workflow behavior.

## Slice Rules

- One primary concern per slice.
- Prefer pure helper tests before Pi runtime integration.
- Do not add child execution until the shared runtime gate exists.
- Do not add `run_subagent` until command execution is validated.
- Do not add chain mode until single-run behavior is validated.
- Keep each slice reviewable without reloading all prior docs; include a short slice summary in PR body.

## Implementation Strategy Table

| Slice | Objective | Primary files | Key deliverables | Tests / validation | Hard stop / do not include |
|---|---|---|---|---|---|
| P3b-0 | Planning docs only | `agents/*.md` | Plan, spec, security model, registration guide, reviews, blocker resolution | `git diff --check` | No runtime code |
| P3b-1 | Core spec model and built-ins | `agents/index.ts` or `agents/lib/specs.ts`, `agents/test-fixtures/test-specs.mjs` | `AgentSpec` types/constants; built-in `scout`, `planner`, `reviewer`; name/tool/model/thinking validation; output contracts | Pure helper tests for built-ins and validators | No Markdown discovery, registry, child process, or broad TUI |
| P3b-2 | Markdown parser and deterministic scanner | `agents/lib/agent-markdown.ts`, `agents/lib/security-scan.ts`, parser tests, shared sync scripts | Bounded frontmatter/body parser; raw-file-byte SHA-256; vendored shared scanner from `shared/security-scan.ts`; safe/suspicious/dangerous classification; reserved-name shadow detection | Parser cap tests; invalid fields; raw hash changes; dangerous scanner blocks eligibility; shared scanner sync/verify passes | No registry writes or child execution |
| P3b-3 | Registry and runtime gate | `agents/lib/registry.ts`, `agents/lib/can-run-agent.ts`, registry tests | User/project registries; project-root hash; `canRunAgent`; root mismatch detection | Unregistered/hash-mismatch/trust-inactive/project-root isolation tests | No child argv construction before gate passes |
| P3b-4 | Diagnostics and proactive guidance | `agents/index.ts`, diagnostics helpers/tests | `/agents`, `/agents list`, `/agents config`, `/agents inspect`, `/agents registry`, `/agents verify`, `/agents doctor`; proactive recommendation dedupe | Doctor bounded/deterministic tests; next-step output tests | No registration writes unless slice stays small; no child execution |
| P3b-5 | Registration flows | registration command handlers/tests | `/agents register`, `/agents register-project`, `/agents unregister`; TUI confirmation; non-TUI fail-closed; `--all-safe` safe-only behavior | TUI/non-TUI branch tests; suspicious per-spec confirmation; dangerous blocked | No child execution |
| P3c-1 | JSONL monitor/parser and child argv builder | `agents/lib/child-args.ts`, `agents/lib/jsonl-monitor.ts`, fake JSONL fixtures | Safe child argv; stdin/temp prompt transport; JSONL reducer; usage/cost/stopReason/tool trajectory; truncation flags | Fake JSONL tests; no prompt/task in argv | No live child Pi execution |
| P3c-2 | Command-only built-in child execution | child runner + command handler | `/agents run scout|planner|reviewer <task>`; timeout/output caps; compact result rendering | Extension load smoke; optional live built-in smoke | Built-ins only; no user/project specs, ephemeral, `run_subagent`, or chain |
| P3c-3 | Registered user/project execution | run command + registry integration tests | `/agents run <registered-user-agent>` and `<registered-project-agent>` through `canRunAgent` | Runtime hash recheck; project trust check; registered spec smoke where possible | No unregistered specs; no chain/tool exposure expansion |
| P3c-4 | Ephemeral one-shot agents | temp-agent handlers/tests | `/agents run-temp`; `/agents save-temp`; scan prompt; save does not register | Dangerous/suspicious prompt tests; no persistence on run; saved spec blocked until registered | No `run_subagent` prompt override |
| P3d-1 | `run_subagent` single-run tool | tool registration/tests | Model-callable single read-only run; same gate; child excludes `run_subagent`; no prompt override | Tool schema tests; recursion exclusion tests | No chain/parallel/write/bash |
| P3d-2 | Command-only chain mode | chain handler/tests | `/agents chain`; max length 3; preflight all agents; bounded prior-summary handoff | Chain preflight failure tests; handoff bounds tests | No chain via `run_subagent` |
| P3e | Docs, local eval command, smoke | `agents/README.md`, eval docs/tests | README; local eval command docs; smoke commands; validation notes | `pi --no-extensions -e ./agents/index.ts --list-models`; local eval command | No new runtime capabilities |

## Recommended Slice Ladder

### P3b-0: Planning docs only

Status: current planning work.

Includes:

- `P3_AGENT_SCAFFOLD_PLAN.md`
- `AGENT_SPEC.md`
- `SECURITY_MODEL.md`
- `REGISTRATION_GUIDE.md`
- plan/adversarial/security reviews

No runtime code.

### P3b-1: Core spec model and built-ins

Goal: establish pure data model and built-in specs.

Files:

- `agents/index.ts` or `agents/lib/specs.ts`
- `agents/test-fixtures/test-specs.mjs`

Implement:

- `AgentSpec` types/constants
- built-in `scout`, `planner`, `reviewer`
- name validation
- tool allowlist validation
- model/thinking validation
- output-contract metadata

Do not implement:

- Markdown discovery
- registry
- child process execution
- TUI commands beyond maybe `/agents list` stub

### P3b-2: Markdown parser and deterministic scanner

Goal: parse and risk-score specs without running them.

Implement:

- bounded Markdown/frontmatter parser
- accepted keys only
- raw-file-byte SHA-256 helper
- vendored copy of the repo shared deterministic scanner: `shared/security-scan.ts -> agents/lib/security-scan.ts`
- safe/suspicious/dangerous classification
- reserved-name shadow detection

Tests:

- file/frontmatter/body caps
- invalid names/tools/thinking
- raw bytes hash changes on any file change
- dangerous scanner findings block registration eligibility
- shared scanner sync/verify includes `agents/lib/security-scan.ts` once added

### P3b-3: Registry and `canRunAgent` gate

Goal: make trust enforceable before any child execution exists.

Implement:

- user registry path
- project registry path from canonical project root SHA-256
- registry read/write helpers
- `canRunAgent(spec, context)`
- project trust input abstraction for tests
- root mismatch detection

Tests:

- unregistered user/project blocked
- hash mismatch blocked
- project trust inactive blocked even with registry entry
- project approvals do not apply across roots
- built-ins pass
- saved ephemeral specs are treated as user specs and blocked until registered

### P3b-4: Diagnostics commands and proactive guidance

Goal: user can understand state before any child execution.

Implement commands:

- `/agents`
- `/agents list`
- `/agents config`
- `/agents inspect <name>`
- `/agents registry`
- `/agents verify`
- `/agents doctor`

Implement:

- bounded, deterministic doctor checks
- proactive project-agent recommendation dedupe
- next-step messages

Do not implement:

- registration writes, unless this slice remains small
- child execution

### P3b-5: Registration flows

Status: completed and merged in PR #22 at commit `691f001`.

Goal: get user/project specs from discovered to runnable.

Implement commands:

- `/agents register <path-or-name>`
- `/agents register-project [--all-safe]`
- `/agents unregister <name>`

Implement:

- TUI confirmation path using `ctx.hasUI`
- non-TUI fail-closed path
- suspicious per-spec confirmation
- `--all-safe` safe-only behavior
- dangerous never registers

Tests:

- TUI confirmation required
- non-TUI writes no registry entry
- suspicious excluded from `--all-safe`
- dangerous blocked

### P3c-1: JSONL monitor/parser and child argv builder

Status: completed and merged in PR #26 at commit `dddb726`.

Goal: prepare child execution without executing Pi.

Implement:

- `buildChildPiArgs`
- prompt transport abstraction: stdin/private temp file
- no prompt/task in argv tests
- JSONL parser/reducer
- tool trajectory extraction
- usage/cost/stopReason extraction when present
- truncation flags

Tests use fake JSONL only.

### P3c-2: Command-only built-in child execution

Status: completed and merged in PR #27 at commit `6c7d885`.

Goal: first live child Pi runner for built-ins only.

Implement:

- `/agents run scout|planner|reviewer <task>`
- timeout/output caps
- process kill on timeout/excess output
- compact result rendering

Scope limit:

- built-ins only
- no user/project spec execution yet
- no ephemeral agents
- no `run_subagent`
- no chain

### P3c-3: Registered user/project execution

Status: current implementation slice.

Goal: allow registered Markdown specs to run through the same gate.

Implement:

- `/agents run <registered-user-agent> <task>`
- `/agents run <registered-project-agent> <task>`

Required:

- shared `canRunAgent` gate before argv construction
- project trust check at runtime
- hash recheck at runtime

### P3c-4: Ephemeral one-shot agents

Goal: support temporary user-prompted agents without persistence.

Implement:

- `/agents run-temp <base-role> <task>`
- `/agents save-temp <name>`

Constraints:

- slash/direct user request only
- read-only base role
- scan prompt
- no persistence on run
- save does not register
- suspicious non-TUI fails closed

### P3d-1: `run_subagent` single-run tool

Goal: expose safe LLM-callable delegation after command path is proven.

Implement:

- single read-only run only
- no prompt override
- no chain/parallel
- same `canRunAgent` gate
- child tool list excludes `run_subagent`

### P3d-2: Command-only chain mode

Goal: bounded sequential chain after single-run is stable.

Implement:

- `/agents chain scout,planner <task>`
- max length 3
- preflight all agents before first child starts
- bounded prior-summary handoff

No chain through `run_subagent` in P3.

### P3e: README, eval command, smoke

Goal: documentation and operational validation.

Implement:

- `agents/README.md`
- local eval command docs
- final smoke commands
- validation matrix update if needed

## Recommended Cut Order

If context or implementation scope grows, cut in this order:

1. chain mode
2. ephemeral save flow, keeping run-temp only
3. user/project Markdown execution, keeping built-ins only
4. `run_subagent` tool

Do not cut:

- shared `canRunAgent` gate
- raw-file-byte hash trust
- prompt/task not in argv
- no `--approve` by default
- timeout/output caps
- non-TUI fail-closed registration
