---
<!-- SCHEMA v1 — optional artifact. Use when task descriptions alone can't
     carry the whole picture (many tasks, cross-task sequencing, multiple
     AC consumers). Small sets: skip this file; pin spec.md in each task
     description instead. Machine contract: frontmatter + task map table. -->

code: AUTH                  # required
title: Plan — <feature>     # required
status: active              # required — draft | active | implemented | superseded
created: 2026-01-01         # required
version: 1                  # required
# Pins — record at plan time; refresh after any spec/design amendment.
# Hash: shasum -a 256 <file> | cut -c1-8
spec: .plans/AUTH/spec.md@abcd1234      # required when spec.md exists
# design: .plans/AUTH/design.md@abcd1234
summary: >                  # required
  <N> tasks deliver AC-1..N for <feature>; sequencing in one line.
---

# Plan — <Title>

## Task map
<!-- Traceability: every task names the ACs it satisfies; every AC is
     covered by some task. This table is what a reviewer or auditor
     diffed against completion evidence. -->
| Task   | ACs         | Notes |
|--------|-------------|-------|
| AUTH-1 | AC-1, AC-2  | <one line> |
| AUTH-2 | AC-3        | depends on AUTH-1 |

## Sequencing
<!-- blockedBy relationships and what can run in parallel. Omit if obvious. -->

## Amendments
<!-- APPEND-ONLY. Same format as spec.md. -->
- (none)
