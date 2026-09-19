---
name: tasks
description: >
  Task list discipline for autonomous multi-step coding work. Use when planning
  or executing work with 3+ distinct steps, when the user provides multiple
  tasks, or before/while using the task_create / task_update / task_list /
  task_get / task_clear tools. Covers the lifecycle, evidence rules, retry
  budget, and autonomy contract.
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

## Evidence rules (anti-hallucination)

Settlement without evidence is rejected by the harness:

- **completed** requires `evidence`: concrete proof — commands you ran, test
  results with numbers, files changed, commit sha. Vague claims ("it should work
  now") are rejected. You must also have actually done tool work since marking
  the task in_progress; the harness observes this and rejects invented results.
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
