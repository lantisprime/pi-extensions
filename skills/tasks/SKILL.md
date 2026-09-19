---
name: tasks
description: >
  Task list discipline for autonomous multi-step coding work. Use when planning
  or executing work with 3+ distinct steps, when the user provides multiple
  tasks, or before/while using the task_create / task_update / task_list /
  task_get / task_clear tools. Covers the lifecycle, evidence rules, retry
  budget, and autonomy contract, and plan artifacts (versioned spec/design
  anchors that stop plan drift and spec hallucination on long autonomous runs).
  How-to guide for humans and agents: read README.md in this skill directory.
---

# Task list discipline

The task list is your working memory and drift anchor. It is injected into your
context every turn; the full detail is available via `task_list`. Follow these
rules exactly.

## When to use tasks

Use `task_create` when:

- work has 3+ distinct steps or needs careful sequencing
- the user gives multiple tasks at once
- you receive new instructions mid-work that change the plan

Do NOT use tasks for single trivial actions or purely conversational asks.

## Deriving the code

`task_create` takes a `code` YOU derive: a short uppercase slug for the theme
(e.g. `AUTH`, `MIGRATE`, `ATTEST-V2`, `BRAIN-LAUNCH`). Ids become `CODE-1`,
`CODE-2`, … Reuse the same code for related slices; pick a new one for new themes.

## Lifecycle

```
pending → in_progress → completed   (terminal)
   │         │
   │         └──→ pending   (shelve: neutral, or with evidence = recorded failure)
   └──→ cancelled (terminal)
```

- Completed and cancelled are **terminal** — never re-open; create a new task.
- Exactly **one** task may be `in_progress`. The harness enforces this: starting
  B requires settling A. This is how statuses stay true without anyone asking.

## Autonomy contract

- Mark a task `in_progress` **before** starting it.
- When it is done, **immediately** `task_update` it `completed` with evidence —
  the result tells you the next task. Continue into it. **Never stop to ask the
  user between tasks.**
- Work in listed order (creation order). Respect `blockedBy`.
- Compliance is enforced by the harness, not optional: a standing rule rides
  the system prompt, an advisory escalates, and past ~3 untracked tool calls
  `write`/`edit` are blocked until a task set exists. Start the set yourself
  instead of being gated.

## Plan artifacts (anti-drift)

When a task set carries real design or specs (never for trivial sets), anchor
it to version-controlled artifacts in `.plans/<CODE>/` — commit them with the
work. Schema'd templates: `templates/` in this skill's dir; full walkthrough:
`README.md`.

- `spec.md` — WHAT/WHY: goal, non-goals, `AC-1…` acceptance table, boundaries.
- `design.md` (optional) — HOW: decision records. `plan.md` (optional) —
  task↔AC traceability. Single-file mode (spec.md only) is fine.
- The schema is a **floor, not a ceiling**: frontmatter + stable AC/D ids +
  append-only `## Amendments` are the only fixed parts.

Rules:

- **Pin**: task descriptions reference `.plans/CODE/spec.md@<hash8>`
  (`shasum -a 256 <file> | cut -c1-8`) plus the AC ids in scope — the pin
  survives context compaction.
- **Re-anchor**: at task start, re-hash and re-read the artifact's `summary`
  and in-scope sections **fresh from disk**. Memory of the spec is not the
  spec. Hash mismatch without an `## Amendments` entry = silent drift →
  restore from git before continuing.
- **Amend, don't rewrite**: mid-run changes append dated entries under
  `## Amendments` (ADDED/MODIFIED/REMOVED + reason), bump `version`, refresh
  pins in pending task descriptions. Never edit settled content silently.
- **Token budget**: never bulk-read a large artifact every turn. Read the
  frontmatter `summary` first, then only in-scope sections (grep AC ids).
  Delegate by passing path+pin — subagents read the artifact themselves.

## Delegation (parallel speed)

Classify before you execute: LLM-judgment work goes to subagents (read-only
via `run_subagent`; write-capable via `herdr_spawn`), mechanical/continuous
work goes to non-LLM threads (`monitor_threads`). The LLM does the

classification; every delegated result must return to your context.
Decision tree, executor matrix, and output contracts: `DELEGATION.md`.

## Evidence rules (anti-hallucination)

Settlement without evidence is rejected by the harness:

- **completed** requires `evidence`: concrete proof — commands you ran, test
  results with numbers, files changed, commit sha. Vague claims ("it should work
  now") are rejected. You must also have actually done tool work since marking
  the task in_progress; the harness observes this and rejects invented results.
  With an AC-bearing spec attached, evidence must also cite the **AC ids
  verified** and the command/output that verified them.
- **cancelled** requires `evidence`: why the task is being dropped.
- Shelving a failing task **with** evidence records a failure (`failures`,
  `lastError`); without evidence it is a neutral unstart.

## Retry budget

Every start consumes an attempt (max 3 per task). After the budget the harness
blocks auto-retry: investigate the root cause, change approach, or ask the
operator. Never re-create failed work under a fresh code to dodge the budget —
that warns and the evidence gate still applies.

## Cleanup

When every task is settled, ask the operator for permission, then call
`task_clear`. Settled sets are otherwise compacted to id references — they never
accumulate rows in context.
