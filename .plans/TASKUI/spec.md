---
code: TASKUI
version: 1
summary: Titles-only default for both task displays (widget + injected block) with a /tasks expand toggle for full detail, mirroring monitor-threads' expandable panel. Design verified via jev_ask (surfaces=1.00 both, satisfies=0.91, model-safety=0.59 mitigated by task_get footer hint).
---

# TASKUI — Titles-only task display

## Goal

Default the operator-visible task surfaces to titles only; reveal details on
demand. Surfaces:

1. Widget above the editor (`renderWidgetLines`).
2. Injected `<session-tasks>` block (`renderContextBlock`, seen by model and operator).

Toggle: `/tasks expand` (full detail) / `/tasks compact` (titles). Analogy:
monitor-threads' tail widget + expandable `/monitors` panel.

## Non-goals

- No persistence of the expand state (session-scoped, like monitors).
- No change to `renderModelList` (task_list stays full detail).
- No change to tool schemas, gating, or the standing rule.

## Acceptance criteria

| AC | Requirement |
|----|-------------|
| AC-1 | Widget compact (session default) shows titles only: `ICON label: subject`, cap 3, never contains description text |
| AC-2 | Widget expanded shows `ICON label: subject — description`, cap 12 |
| AC-3 | Context block default is titles-only: `ICON id [status] subject` per open task; settled refs + discipline footer retained; constant `task_get <id> for details` hint in footer; description absent from task lines |
| AC-4 | Context block `detail: "full"` reproduces the current `id [status] subject — description` format |
| AC-5 | `/tasks expand` switches BOTH widget and injected block to full; `/tasks compact` returns both to titles; fresh session starts titles-only |
| AC-6 | `node tasks/test/run-store-test.mjs` passes with titles/full coverage for both renderers |
| AC-7 | README tasks section documents the default and the toggle |

## Boundaries

- 🚫 renderModelList stays full-detail (progressive disclosure).
- 🚫 No persistence of expanded state (session-scoped, like /monitors).
- 🚫 No changes to enforcement/gating or task tool schemas.

## Amendments

- 2025-09-20 v1: Initial spec. AC set verified against user request via jev_ask
  (satisfies 0.910; surfaces choice 1.000 both-surfaces; model-safety 0.590
  mitigated by constant task_get footer hint).
