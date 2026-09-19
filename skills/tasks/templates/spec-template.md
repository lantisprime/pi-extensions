---
<!-- SCHEMA v1 — the floor, not the ceiling.
     Machine contract: YAML frontmatter (required keys below) + the AC-id
     acceptance table + append-only ## Amendments. Everything else is
     free-form; delete optional sections that don't apply.
     Parses uniformly in any harness/model: plain YAML + Markdown tables. -->

code: AUTH                  # required — task code this spec anchors (AUTH-1, AUTH-2, ...)
title: One-line intent      # required
status: draft               # required — draft | active | implemented | superseded
created: 2026-01-01         # required — YYYY-MM-DD
version: 1                  # required — bump on every amendment; log it in ## Amendments
summary: >                  # required — 1–3 lines. What agents see when scanning;
  Say what this delivers and why, at a glance.  # keep self-sufficient; don't duplicate body.
# Optional keys:
# scope: paths or packages in play
# depends-on: other .plans/CODE specs
---

# <Title>

## Goal
What success looks like and why it matters. WHAT and WHY only — no HOW here.

## Non-goals
Explicitly out of scope. Agents treat expansion past these as scope-creep
(AI slop) unless an amendment is recorded first.

## Acceptance
<!-- One row per checkable requirement. IDs are STABLE: never renumber.
     Retire via Amendments (REMOVED), never by deleting silently.
     EARS-style preferred but not required:
     WHEN <condition> THE <system> SHALL <observable response>. -->
| ID   | Requirement |
|------|-------------|
| AC-1 | WHEN <trigger> THE system SHALL <response> |
| AC-2 | <plain imperative is fine if objectively checkable> |

## Constraints
<!-- Three-tier boundaries — the strongest anti-slop guard. Keep short. -->
- ✅ Always: <proceed without asking, e.g. run tests, edit files in scope>
- ⚠️ Ask first: <operator gate, e.g. schema migrations, new dependencies>
- 🚫 Never: <hard stops, e.g. touch prod config, delete failing tests>

## Open questions
<!-- Unresolved items + who resolves them. Remove (via amendment) once answered. -->
- (none)

## Amendments
<!-- APPEND-ONLY. Never change content above without an entry here.
     Format: YYYY-MM-DD | <task-id or "operator"> | ADDED|MODIFIED|REMOVED <target> | <reason> -->
- (none)
