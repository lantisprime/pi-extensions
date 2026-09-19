---
code: DELEG
title: Tasks-skill usage enforcement (advisory nudge)
status: active
created: 2026-09-19
version: 2
summary: >
  Advisory nudge in the tasks extension: when a session does consecutive work
  with zero tasks, inject a bounded reminder to follow the tasks skill. Never
  blocks. Pure helper in lib/store.ts + wiring in index.ts tool_result hook.
---

# Tasks-skill usage enforcement (advisory nudge)

## Goal

Models skip the tasks skill on multi-step work even when it is listed in the
system prompt (observed live 2026-09-19). Make usage unavoidable at the moment
of need: the tasks extension already sees every non-task tool result — use that
seam to detect untracked multi-step work and inject a directive advisory into
the tool result content. Advisory only; the harness's existing evidence gate
stays the only hard enforcement.

## Non-goals

- No blocking/gating of tools (permission-policy's job if ever needed).
- No LLM calls, no persistence across sessions (session-scoped streak).
- No changes to the session-tasks context block, evidence gate, UI, or
  durable-store behavior.

## Acceptance

| ID | Requirement |
|----|-------------|
| AC-1 | WHEN a session records ≥3 consecutive non-task tool results with zero tasks THEN the 3rd result carries a bounded advisory directing task_create per the tasks skill |
| AC-2 | WHEN a task set exists (tasks.length > 0) THEN no advisory is injected and the streak state resets |
| AC-3 | WHEN an advisory has fired THEN the next re-fire waits 10 further consecutive empty-set work results (anti-nag), never every result |
| AC-4 | WHEN the streak helper is called with tasksEmpty=false THEN it returns a reset state and a null nudge |
| AC-5 | WHEN the extension runs with the nudge wired THEN existing tool_result behavior (task-state re-anchoring, lastToolResultAt activity proof) is unchanged |
| AC-6 | WHEN task_update is called with a status equal to the task's current status THEN it succeeds as a benign no-op (state unchanged, warning names the next action) instead of an error — no retry-loop deadlock |
| AC-7 | WHEN the task_update tool schema is inspected THEN `status` carries a description naming the intended transitions (in_progress to start, completed/cancelled to settle with evidence) |

## Constraints

- ✅ Always: pure helper exported from lib/store.ts; wiring stays in index.ts;
  tests extended in test/run-store-test.mjs (node, no pi instance).
- ⚠️ Ask first: changing the session-tasks context block format; touching any
  other extension.
- 🚫 Never: tool blocking, LLM calls, cross-session persistence, unbounded or
  per-result nagging.

## Amendments

- 2026-09-19 | DELEG-7 | ADDED AC-6, AC-7 | Real-pi E2E (DELEG-6) found a deadlock: a child pi emitted `status:"pending"` 17 times (current status) and every call errored `Illegal transition pending → pending`, then gave up. Omitting status succeeded, so the inconsistency trapped weaker models. Same-status updates become benign no-ops with a directive warning; the status param gains transition guidance.
