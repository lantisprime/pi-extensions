# Pi Extensions Canonical Workplan

## Purpose

This is the canonical planning document for this repo. Use it to decide what to implement next, keep extension work sequenced, and define validation gates before marking work complete.

## TL;DR Current Plan

- **Current priority:** implement `tool-context-loader` in small staged milestones.
- **Next milestone:** P1a discovery + diagnostics only; do not inject context yet.
- **Next 3 tasks:**
  1. Implement `tool-context-loader/index.ts` skeleton and `/tool-context-loader` diagnostics.
  2. Add frontmatter/discovery fixtures and pure helper tests.
  3. Add a validation matrix mapping `VC-001` through `VC-024` to automated, smoke, or deferred coverage.
- **Do not start full agent workflows yet.** A minimal agent scaffold may wait until loader discovery is observable.
- **Key risk to prove:** child Pi subprocesses used by subagents actually load global extensions in `--mode json -p --no-session`.
- **Safety default:** no body injection until discovery, diagnostics, budgets, advisory wrappers, and kill switch are working.
- **Rollback:** `/tool-context-loader off`, config `enabled: false`, and documented uninstall path are required before broader rollout.

## Current Repo Tracks

- **Permission Policy**
  - Path: `permission-policy/`
  - Status: Existing
  - Goal: Gate sensitive Pi tool usage with project/session decisions.

- **Prompt Shield**
  - Path: `prompt-shield/`
  - Status: Existing
  - Goal: Scan Pi resources for prompt-injection/agent-security risk.

- **Secure Web Search**
  - Path: `web-search/`
  - Status: Existing
  - Goal: Provide safer web research with DNS/TLS/content checks.

- **Shared Security Scanner**
  - Path: `shared/`
  - Status: Existing
  - Goal: Shared deterministic agent-risk scanner vendored into extensions.

- **Tool Context Loader**
  - Path: `tool-context-loader/`
  - Status: Design
  - Goal: Dynamically load local runbooks/lessons/episodes based on active/executed tools.

- **Agent/Subagent Extensions**
  - Path: TBD
  - Status: Planned
  - Goal: Add specialized isolated agents that benefit from tool-context-loader.

## Canonical Design References

Use these design documents when planning or implementing tasks:

- `WORKPLAN.md`
  - Repo-wide sequencing, validation gates, and task template.

- `tool-context-loader/DESIGN.md`
  - Authoritative design for the tool-context-loader MVP.
  - Includes validation contracts `VC-001` through `VC-024`.

- `tool-context-loader/PLAN_REVIEW.md`
  - Exhaustive review notes and rationale behind the folded design changes.
  - Use when questioning trade-offs or revisiting risks.

- `tool-context-loader/AGENT_EXTENSION_SEQUENCING.md`
  - Decision record for when to build agent/subagent extensions relative to tool-context-loader.

- `WORKPLAN_ADVERSARIAL_REVIEW.md`
  - Adversarial review of this workplan.
  - Use before starting implementation milestones to check scope, sequencing, validation, and security assumptions.

- `AGENTIC_WORKPLAN_FORMAT.md`
  - Source-harmonized format for agentic AI workplans.
  - Use when restructuring this plan or adding new agentic development tracks.

When a task touches tool-context-loader or agent/subagent behavior, include the relevant documents in that task's **Design References** section.

## Strategic Direction

Build a safer, more context-aware Pi extension suite:

1. **Protect execution** with permission-policy.
2. **Protect prompts/resources** with prompt-shield.
3. **Protect external research** with secure web search.
4. **Improve local context recall** with tool-context-loader.
5. **Scale workflows** with specialized agents/subagents that receive JIT local guidance.

## Near-Term Priority Order

### P0 — Keep existing extensions healthy

Before adding major new features, existing extension tests and shared scanner sync must remain green.

Tasks:

- Run permission-policy tests after permission changes.
- Run shared scanner tests after scanner changes.
- Run prompt-shield/web-search smoke tests after shared scanner sync.
- Keep README install instructions accurate.

Validation:

```bash
permission-policy/test-fixtures/run-all-tests.sh
scripts/verify-shared-sync.sh
scripts/test-security-scan.mjs
```

### P1 — Implement `tool-context-loader` in staged milestones

This is the next major feature because it improves token efficiency and will support future agents. Build it in smaller increments rather than one large MVP.

Design docs:

- `tool-context-loader/DESIGN.md`
- `tool-context-loader/PLAN_REVIEW.md`
- `tool-context-loader/AGENT_EXTENSION_SEQUENCING.md`
- `WORKPLAN_ADVERSARIAL_REVIEW.md`
- `AGENTIC_WORKPLAN_FORMAT.md`

#### P1a — Discovery + diagnostics only

Scope:

- Metadata-only discovery.
- Project trust gate.
- Small frontmatter parser.
- Episode eligibility rules.
- Source precedence and duplicate identity.
- `/tool-context-loader` diagnostics command.
- No context injection yet.

#### P1b — Preload index only

Scope:

- Index-only preload by default.
- Preload byte/line budgets.
- No runbook body injection yet.

#### P1c — JIT tool-result injection

Scope:

- Match actual tool calls.
- Lazily read matching runbook bodies.
- Inject advisory-wrapped body excerpts after matching tool results.
- Preserve original tool result content/details/error state.

#### P1d — Hardening + validation matrix

Scope:

- Per-turn dedupe using `turn_start`.
- Parallel result race-safety by claiming before async reads.
- Symlink/path escape tests.
- Kill switch: `/tool-context-loader off` and config `enabled: false`.
- Validation matrix for contracts `VC-001` through `VC-024` from `tool-context-loader/DESIGN.md`.

Validation source:

- Every validation contract must map to automated test, live smoke test, or explicitly deferred status.

### P2 — Minimal agent/subagent scaffold

Start only a minimal scaffold after P1a discovery + diagnostics is observable. Defer broad agent workflows until P1d hardening is available.

Initial agents:

- `scout`: read-only repo reconnaissance.
- `planner`: implementation planning.
- `reviewer`: design/code review.

Rules:

- Keep prompts short and role-focused.
- Do not embed long runbooks or lessons in agent prompts.
- User-level agents only by default.
- Project-local agents require trust/confirmation.
- Use conservative tool allowlists.

### P3 — Agent + loader integration

After P1c JIT injection exists and before relying on integration:

- Prove whether child Pi subprocesses load global extensions in `--mode json -p --no-session`.
- If they do not, update the subagent extension to explicitly pass the loader extension path.
- Install loader globally so child Pi subprocesses inherit it, if inheritance is verified.
- Add one-line loader-aware instruction to agent prompts.
- Add smoke tests confirming child agents receive JIT runbook context when they call matching tools.
- Add workflow prompts only after integration is proven.

### P4 — Full workflow expansion

Only after P1-P3:

- Add `scout-and-plan` workflow.
- Add `implement-and-review` workflow.
- Add specialized agents as needed.
- Keep specialized knowledge in runbooks/lessons, not long agent prompts.

## Task Template

Use this template for each implementation task.

```markdown
## Task: <short name>

### Objective

<What this task accomplishes.>

### Scope

In:
- ...

Out:
- ...

### Files

Expected files touched:
- `path/to/file`

### Design References

- `WORKPLAN.md`
- `tool-context-loader/DESIGN.md` if touching tool-context-loader behavior
- `tool-context-loader/PLAN_REVIEW.md` if revisiting design risks/trade-offs
- `tool-context-loader/AGENT_EXTENSION_SEQUENCING.md` if touching agent/subagent sequencing or integration
- `WORKPLAN_ADVERSARIAL_REVIEW.md` before starting a new milestone or changing priority/scope
- `AGENTIC_WORKPLAN_FORMAT.md` if restructuring plan format or adding agentic workflow tracks
- extension README if relevant

### Implementation Steps

1. ...
2. ...
3. ...

### Validation Contracts

- VC-...

### Commands

```bash
<test command>
```

### Done Criteria

- [ ] Code implemented.
- [ ] Tests/fixtures added or updated.
- [ ] Validation commands pass.
- [ ] README/design docs updated if behavior changed.
- [ ] No generated/vendor drift unless intentional.
```

## Design Principles

### Token efficiency

- Prefer indexes and summaries over full bodies.
- Load large local guidance only just-in-time.
- Apply deterministic byte/line budgets.
- Do not duplicate tool docs already present in Pi's prompt.

### Security

- Treat local guidance as advisory, not higher-priority instruction.
- Preserve permission-policy and prompt-shield authority.
- Respect project trust before reading project-local resources.
- Do not execute runbook content.
- Avoid project-local agents unless trusted and confirmed.

### Extension compatibility

- Prefer passive event hooks before overriding built-in tools.
- Avoid mutating `event.input` unless explicitly required.
- Account for parallel tool execution.
- Guard UI calls with `ctx.hasUI` where appropriate.

### Maintainability

- Keep small extensions single-file until complexity justifies `lib/` modules.
- Keep shared scanner changes in `shared/security-scan.ts`, then sync vendored copies.
- Document new commands and storage paths in README files.

## Validation Gates

### Gate A: Existing extension safety

Required before merging changes to existing extensions:

```bash
permission-policy/test-fixtures/run-all-tests.sh
scripts/verify-shared-sync.sh
scripts/test-security-scan.mjs
```

### Gate B: Tool context loader staged rollout

Required before moving across P1 stages:

- **P1a:** discovery is deterministic; missing roots do not fail startup; untrusted projects do not load project-local context.
- **P1b:** preload stays under configured budget and contains index entries only by default.
- **P1c:** JIT injection includes advisory wrapper and preserves original tool result shape.
- **P1d:** all VC-001 through VC-024 are mapped in a validation matrix as automated, smoke, or deferred with reason; parallel matching does not duplicate per-turn injections.

### Gate C: Agent scaffold

Required before enabling agent workflows:

- User-level agents load.
- Project-level agents are disabled or confirmed by default.
- Agent output is truncated/bounded.
- Agent prompts do not embed large runbooks.
- Loader-aware prompts are one-line and advisory.

## Suggested Next Tasks

1. Implement `tool-context-loader/index.ts` skeleton and diagnostics command.
2. Add pure helper tests for frontmatter parsing and discovery.
3. Add a validation matrix for `VC-001` through `VC-024`.
4. Implement metadata matching and preload budgets.
5. Implement preload index injection.
6. Implement JIT tool-result injection with advisory wrapper.
7. Add fixture runbooks and contract tests.
8. Prove subagent child-process extension inheritance.
9. Create minimal `agents/` scaffold after loader discovery is observable.
