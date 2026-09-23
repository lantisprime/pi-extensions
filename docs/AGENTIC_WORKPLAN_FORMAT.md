# Agentic AI Workplan Format

## TL;DR Format

Use this shape for agentic AI development workplans:

1. **TL;DR current plan** — 5-10 bullets with priority order and next action.
2. **Source-backed design references** — local design docs plus external guidance.
3. **Milestone ladder** — small staged milestones, not one huge MVP.
4. **Agent/workflow map** — deterministic workflow vs autonomous agent boundaries.
5. **Context plan** — what is loaded by default, what is lazy/JIT, and token budgets.
6. **Tool/permission plan** — tools allowed, guardrails, human approval, sandboxing.
7. **Evaluation matrix** — every validation contract maps to automated, smoke, or deferred status.
8. **Observability/rollback** — tracing/logs, diagnostics command, kill switch, uninstall path.
9. **Task template** — each task has objective, scope, files, references, steps, contracts, commands, and done criteria.

## Harmonized Guidance From Sources

### 1. Prefer simple, staged workflows before autonomous agents

Anthropic recommends starting with the simplest solution possible and increasing complexity only when needed. It distinguishes predictable **workflows** from more autonomous **agents**, and calls out patterns like prompt chaining, routing, parallelization, orchestrator-workers, and evaluator-optimizer.

Implication for workplans:

- Break work into staged milestones.
- Use deterministic workflows where possible.
- Reserve autonomous agents for open-ended tasks where the number of steps cannot be known ahead of time.

Source: https://www.anthropic.com/engineering/building-effective-agents

### 2. Explicitly model context, tools, handoffs, guardrails, and tracing

OpenAI's Agents SDK documentation organizes agent systems around agents, tools, handoffs, guardrails, sessions, context management, and tracing.

Implication for workplans:

- Every agentic task should define context inputs, allowed tools, guardrail expectations, handoff behavior, and observability.
- Workplans should not only describe implementation tasks; they should describe runtime control boundaries.

Sources:

- https://openai.github.io/openai-agents-python/
- https://openai.github.io/openai-agents-python/guardrails/
- https://openai.github.io/openai-agents-python/context/
- https://openai.github.io/openai-agents-python/tracing/

### 3. Evaluate both final output and trajectory/tool use

Google ADK evaluation guidance emphasizes defining success criteria, critical tasks, metrics, and evaluating not only final responses but also the agent's trajectory and tool use. Google ADK workflow docs also emphasize deterministic workflow agents, including sequential, loop, and parallel control structures.

Implication for workplans:

- Add a validation matrix that maps each contract to a test or smoke check.
- Validate tool-call trajectories, not just final output text.
- Prefer predictable workflow structures for known sequences.

Sources:

- https://google.github.io/adk-docs/evaluate/
- https://google.github.io/adk-docs/agents/workflow-agents/

### 4. Production agent work needs observability, evaluation, and cost controls

Microsoft's AI Agents for Beginners course includes design patterns, planning, multi-agent patterns, context engineering, memory, production observability, and evaluation. Its production lesson emphasizes transforming black-box agents into transparent, manageable, dependable systems.

Implication for workplans:

- Include observability and cost/token controls as first-class milestones.
- Treat diagnostics and evaluation as product requirements, not afterthoughts.

Sources:

- https://microsoft.github.io/ai-agents-for-beginners/
- https://microsoft.github.io/ai-agents-for-beginners/10-ai-agents-production/

### 5. Own prompts, context, tools, and control flow

The 12-Factor Agents project emphasizes owning prompts, owning the context window, treating tools as structured outputs, owning control flow, compacting errors into context, and keeping agents small/focused.

Implication for workplans:

- Keep prompts versioned and short.
- Define what enters context and when.
- Treat tool calls as structured contracts.
- Keep agents small and specialized.

Source: https://github.com/humanlayer/12-factor-agents

## Recommended Workplan Sections

### 1. TL;DR Current Plan

A compact, always-current summary at the top of the workplan.

Recommended contents:

- current priority
- current milestone
- next 3 tasks
- blocked/deferred items
- validation command(s)
- rollback/kill switch

### 2. Design References

List internal and external references.

Required fields:

- document/path or URL
- why it matters
- when to consult it

### 3. Milestone Ladder

Use small milestones with gates.

Recommended pattern:

```text
P0: Keep existing system healthy
P1a: Discovery/diagnostics only
P1b: Preload index only
P1c: JIT injection
P1d: Hardening and validation matrix
P2: Minimal agent scaffold
P3: Agent-loader integration
P4: Full workflows
```

### 4. Agent/Workflow Boundary

For each planned agent or workflow, define:

- deterministic workflow or autonomous agent?
- allowed tools
- context inputs
- output contract
- handoff rules
- human approval points
- evaluation trajectory

### 5. Context and Token Plan

For each feature, define:

- what enters model context by default
- what is lazy/JIT loaded
- byte/line/token budgets
- dedupe behavior
- compaction or truncation behavior

### 6. Tool and Guardrail Plan

For each tool-using component, define:

- allowed tools
- denied tools
- permission gates
- prompt-shield/resource safety requirements
- sandboxing assumptions
- human approval conditions

### 7. Validation Matrix

Every validation contract should map to one of:

- automated test
- live smoke test
- deferred with reason

Recommended columns:

```text
Contract | Risk | Test Type | File/Command | Status | Notes
```

Avoid relying only on final output. Include trajectory/tool-call expectations where applicable.

### 8. Observability and Rollback

Define:

- diagnostics commands
- status output
- audit/tracing data
- config kill switch
- uninstall path
- safe default when config is invalid

### 9. Task Template

Each task should include:

- objective
- in/out scope
- expected files
- design references
- implementation steps
- validation contracts
- commands
- done criteria

## Recommended Change For This Repo

Update `WORKPLAN.md` to follow the above format more closely by adding:

1. A top-level **TL;DR Current Plan**.
2. P1 submilestones: `P1a` through `P1d`.
3. A validation matrix requirement.
4. A subagent inheritance proof before agent-loader integration.
5. Explicit rollback/kill-switch requirements.
