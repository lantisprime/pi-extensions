---
code: ENF
title: Prompt-level tasks-skill reminder (escalation of the empty-set nudge)
status: active
created: 2026-09-19
version: 2
summary: >
  Escalate the empty-set nudge from a tail line on a tool result (ignored —
  observed live) to a compact line appended to the system prompt every turn
  while work runs untracked. Zero cost while compliant.
---

# Prompt-level tasks-skill reminder

## Goal

The advisory added in DELEG-4 lands at the *tail of a tool result* and was
ignored in practice — including by the session that designed it. Move the
signal to the **top of context**: while a session has done untracked multi-step
work, append one compact line to the system prompt each turn until the model
creates a task set. This is the "the LLM must know" fix: it cannot be missed by
reading the tail of a tool result.

## Non-goals

- No blocking of read-only/exploration tools (`read`, `grep`, `find`, `ls`,
  `task_*`, MCP reads) — exploration must never be gated.
- No blocking while a task set exists, below the streak threshold, or when the
  operator disables enforcement.
- No new state, persistence, LLM calls, or UI surfaces beyond the toggle.

(A blanket "no gating" non-goal was removed by the v2 amendment below: advisory-

only enforcement was observed to be ignored in practice.)

## Acceptance

| ID | Requirement |
|----|-------------|
| AC-1 | WHEN tasks.length === 0 AND the empty-set work streak >= NUDGE_FIRST_AT THEN before_agent_start appends exactly one compact reminder line to the system prompt |
| AC-2 | WHEN a task set exists OR the streak is below NUDGE_FIRST_AT THEN no reminder line is appended (zero token cost) |
| AC-3 | WHEN the reminder is appended THEN it is a single bounded line (<200 chars) naming the tasks skill and task_create |
| AC-4 | WHEN both the tool-result advisory and the prompt reminder are enabled THEN they read the same streak state; the streak advances only on non-task tool results (no double counting) |
| AC-5 | WHEN tasks exist THEN existing behaviour is unchanged: session-tasks block injection, one-line status refresh, evidence gate, same-status no-op |
| AC-6 | WHEN the task set is empty AND the work streak >= NUDGE_FIRST_AT AND the model calls a mutating built-in tool (`write`, `edit`) THEN the call is BLOCKED with a directive reason instructing `task_create` per the tasks skill |
| AC-7 | WHEN a task set exists, or the streak is below the threshold, or enforcement is disabled THEN mutating calls are never blocked |
| AC-8 | WHEN the operator runs `/tasks enforce on\|off\|status` THEN gating changes for the session only, leaving the reminders unaffected |
| AC-9 | WHEN a session starts THEN the system prompt carries one constant standing rule line naming the tasks skill and `task_create` (bounded, no per-turn growth) |

## Constraints

- ✅ Always: pure helper in lib/store.ts; wiring in index.ts; tests in
  test/run-store-test.mjs; reminder bounded and constant (no per-turn prose).
- ⚠️ Ask first: any blocking/gating behaviour; changes to the session-tasks
  block format.
- 🚫 Never: suppress the reminder while work runs untracked; per-turn growth;
  LLM calls.

## Amendments

- 2026-09-19 | operator + ENF-1 | ADDED AC-6..AC-9; MODIFIED Non-goals (removed blanket no-gating) | Operator reported the advisory was ignored in practice — including by the session that designed it (tail-of-tool-result line skimmed past; extension edits not live until /reload). Advisory-only enforcement is insufficient: add a hard gate on mutating tools once untracked multi-step work crosses the threshold, an operator toggle, and a standing rule line.
