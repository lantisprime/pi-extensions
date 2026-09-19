---
<!-- SCHEMA v1 — optional artifact. Use only when the HOW is non-trivial.
     If the design fits in three sentences, put them in spec.md ## Goal and
     skip this file. Machine contract: frontmatter + D-id decision table +
     append-only ## Amendments. Body is otherwise free-form. -->

code: AUTH                  # required — same code as the spec it belongs to
title: Design — <feature>   # required
status: draft               # required — draft | active | superseded
created: 2026-01-01         # required
version: 1                  # required — bump + log in ## Amendments when changed
summary: >                  # required — the chosen approach in one breath
  <Approach>. Key trade-off: <x over y because z>.
# Optional keys:
# spec: .plans/AUTH/spec.md
---

# Design — <Title>

## Decisions
<!-- Choice + rationale + what was rejected. Keeps future agents from
     re-litigating settled questions (anti-drift for the HOW). -->
| ID  | Decision | Rationale / rejected alternatives |
|-----|----------|----------------------------------|
| D-1 | <choice> | <why; what else was considered> |

## Architecture
Free-form: ASCII or mermaid diagrams, data flow, module layout, interfaces.
Keep prose tight — agents pay tokens for every line.

## Risks
- Risk: <what> → Mitigation: <how>

## Amendments
<!-- APPEND-ONLY. Same format as spec.md. -->
- (none)
