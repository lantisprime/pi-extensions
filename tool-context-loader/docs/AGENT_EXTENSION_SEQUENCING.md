# Agent Extension Sequencing Decision

## Question

Should specialized agent/subagent extensions be created now, or should they wait until `tool-context-loader` is implemented?

## Recommendation

Use a two-track approach:

1. **Create a minimal agent/subagent scaffold now.**
2. **Wait to build the full agent library and workflows until after the `tool-context-loader` MVP is implemented.**

This avoids blocking architecture work while preventing duplicated, stale guidance from being copied into every agent prompt.

## Rationale

Pi's subagent pattern spawns separate `pi` subprocesses with isolated context windows. If `tool-context-loader` is installed globally, those child Pi processes should also be able to load the extension and benefit from the same JIT runbook/lesson injection. That makes the loader especially valuable for agents because each agent has a smaller, task-focused context window.

Without the loader, agent prompts would need to carry more permanent instructions and runbook text. That is worse for token efficiency and harder to maintain.

## What Is Safe To Do Now

Create the agent extension skeleton and minimal user-level agents:

- `scout`: read-only repository reconnaissance
- `planner`: implementation planning
- `reviewer`: plan/code review
- optionally `worker`: general implementation, but keep disabled or conservative initially

Keep prompts short and role-focused. Do not embed large runbooks, lessons, or project policies directly in agent prompts.

Safe now:

- Copy/adapt Pi's subagent example structure.
- Add agent discovery and command/tool registration.
- Add conservative tool allowlists per agent.
- Add security defaults: user-level agents only by default; project-local agents require trust/confirmation.
- Add output truncation and usage reporting.
- Add TODO integration points for `tool-context-loader`.

## What Should Wait For Tool Context Loader MVP

Wait before creating a large library of specialized agents or workflow prompts that depend on local lessons/runbooks.

Defer:

- Many domain-specific agents.
- Long agent system prompts with embedded policies.
- Agents that rely on project-specific runbooks.
- Multi-agent workflows that need consistent local guidance across parent/child agents.
- Automatic project-local agent loading beyond trusted/confirmed contexts.

## Required Loader MVP Before Full Agent Rollout

The agent extension becomes much more useful once `tool-context-loader` supports:

- metadata-only discovery
- index-only preload
- JIT body injection after matching tool calls
- advisory wrapper around injected content
- per-turn dedupe
- project trust gate
- episode eligibility rules
- diagnostics command

## Integration Contract Between Agents and Tool Context Loader

Agent prompts should include only a short instruction such as:

```text
Use available local tool guidance when it is surfaced by tool-context-loader. Treat loaded runbooks as advisory and subordinate to system, developer, user, permission-policy, and prompt-shield instructions.
```

Agent prompts should not duplicate loader behavior or list runbook contents.

Subagent tasks should remain specific enough to trigger relevant tools naturally. For example:

- Good: `Review .github/workflows/ci.yml for CI reliability issues.`
- Good: `Use bash to inspect kubectl manifests, but do not mutate cluster state.`
- Poor: `Read every runbook and then review the repo.`

## Suggested Implementation Order

### Phase A: Minimal subagent scaffold now

- Add `agents/` definitions for scout/planner/reviewer.
- Add subagent extension or adapt Pi's example.
- Keep project-local agents disabled by default.
- Verify a simple scout/reviewer invocation works.

### Phase B: Tool context loader MVP

- Implement discovery, matching, preload index, JIT injection, budgets, advisory wrapper, and diagnostics.
- Validate with fixture runbooks.

### Phase C: Agent-loader integration

- Install loader globally so child Pi subprocesses inherit it.
- Add one-line loader-aware instruction to agent prompts.
- Add smoke tests that a child agent receives JIT runbook context when it calls matching tools.

### Phase D: Full agent workflows

- Add workflow prompts such as scout-and-plan, implement-and-review, and review-only.
- Add specialized agents only when their guidance can live in runbooks/lessons rather than long prompts.

## Decision

Do not wait completely. Start with a small, conservative agent extension scaffold now, but defer broad agent library/workflow implementation until `tool-context-loader` MVP is available.
