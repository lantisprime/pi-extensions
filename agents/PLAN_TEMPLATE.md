# PLAN_TEMPLATE.md

Copy this template when starting a new feature plan. Delete sections that don't apply.
The Requirements section is the ground truth — every requirement SHALL map to at least one
test or validation check. Do not mark a plan as complete until the Requirements table is
fully populated and every row has a test mapping.

---

# <FEATURE_ID> <Feature Name> Plan

## Status

Planning only. Do not implement until this plan, plan review, and adversarial review are accepted.

## Episode Search Summary

Searched episodic memory for <relevant terms>.

Key active memories:

- `<episode-id>`: <one-line summary>
- ...

## Objective

<2-4 sentence statement of what this feature proves or delivers.>

## Why

<Rationale: why this feature matters, what problems it solves, what it enables downstream.>

## Requirements (Ground Truth)

Every requirement SHALL be testable and SHALL map to at least one test or validation check.
Requirements are numbered REQ-1, REQ-2, ... and are the authoritative contract for the feature.
If a requirement cannot be tested, it is not a requirement — move it to Non-Goals or Design notes.

| ID | Requirement | Test(s) | Priority | Notes |
|---|---|---|---|---|
| REQ-1 | <Concrete, testable statement> | `<test-name-1>`, `<test-name-2>` | MUST / SHOULD | <Edge cases, rationale> |
| REQ-2 | ... | ... | ... | ... |

**Priority legend:**
- **MUST**: Required for the first slice merge. Failing test = blocker.
- **SHOULD**: Required before the feature is considered complete; one slice may defer.
- **MAY**: Nice-to-have, not blocking any merge.

The `Test(s)` column accepts named automated tests (e.g. `testFoo`), manual smoke
checks (e.g. `manual: pi --list-models`), or static analysis (e.g. `git diff --stat`).
List all verification methods that prove the requirement.

## Non-Goals

Out of scope for this feature:

- <item 1>
- <item 2>

## Safety / Security

<If the feature carries a meaningful security surface (trust boundaries, privilege
escalation vectors, new data flows, child-process isolation, prompt injection risk),
capture it here. Otherwise delete this section and fold safety requirements into the
Requirements table as MUST rows + Design invariants.>

| Concern | Severity | Mitigation | Test(s) |
|---|---|---|---|
| <concern> | Low/Medium/High | <mitigation> | `<test-name>` |

## Design

<Diagrams, type definitions, resolution rules, precedence, edge cases.>

### Key types

```ts
// Core types with JSDoc
```

### Key invariants

- <invariant 1>
- <invariant 2>

### Resolution / flow

```text
Input → Step 1 → Step 2 → Output
```

## Existing Hook Points

<Where this feature integrates with existing code. File paths, line numbers, function names.>

| File | Line(s) | What it does | Impact |
|---|---|---|---|
| `path/to/file.ts` | L42 | `functionName` does X | Add Y here |

## Slice Ladder

<If the feature is implemented in multiple slices. Otherwise remove this section.>

| Slice | Objective | Primary files | Key deliverables | Tests | Hard stops |
|---|---|---|---|---|---|
| `<ID>-1` | ... | ... | ... | ... | ... |
| `<ID>-2` | ... | ... | ... | ... | ... |

### Dependency graph

```text
Slice-1 ── Slice-2 ── Slice-3
```

## Cut Order

If context or implementation scope grows, cut in this order:

1. <first thing to cut>
2. <second thing to cut>

Do not cut:

- <non-negotiable 1>
- <non-negotiable 2>

## Contracts

### `<functionName>(input): output>`

**Input contract:** <What it accepts — types, structural requirements>

**Output contract:** <What it returns — discriminated union, invariants>

**State table (exhaustive):**

| State | Condition | Output |
|---|---|---|
| A. <Name> | ... | ... |
| B. <Name> | ... | ... |

**Error codes:**

| Code | Field | Trigger |
|---|---|---|
| `<code>` | `<field>` | `<condition>` |

## Edge Cases

| # | Scenario | Expected behavior | Test |
|---|---|---|---|
| EC1 | ... | ... | `<test-name>` |
| EC2 | ... | ... | `<test-name>` |

## Test Case Catalog

Grouped by concern. Every test name here SHALL appear in the Requirements table.

```text
Group 1: <concern> (<N> tests)
  <testName1>
  <testName2>

Group 2: <concern> (<N> tests)
  ...
```

Total: <N> tests.

## Risk Analysis

| Risk | Severity | Mitigation |
|---|---|---|
| <risk> | Low/Medium/High | <mitigation> |

## Open Decisions

<Decisions deferred to a later slice. Each entry: decision, deferral slice, rationale.>

## Done Criteria

<Optional. List concrete, verifiable completion conditions beyond the Requirements
table. If the Requirements table fully captures completion, delete this section and
state "All MUST requirements passing = done" there.>

- [ ] <condition 1>
- [ ] <condition 2>

## Review Consensus

| Pass | Reviewer | Model | Blocker count | Verdict |
|---|---|---|---|---|
| 1 | <human/agent> | <model> | <N> | <go / conditional-go> |
| 2 | ... | ... | ... | ... |

### Resolved blockers

| # | Blocker | Resolution |
|---|---|---|
| 1 | <description> | <resolution> |

## Appendix: Implementation Plan

Concrete file-level implementation plan.

### Files to create

1. `<path/to/file.ts>` — <purpose>
2. `<path/to/test.mjs>` — <purpose>
3. `<path/to/run-tests.sh>` — <purpose>

### Files to modify

| File | Change |
|---|---|
| `<path>` | <what changes and why> |

### Implementation sequence

| Step | Action | Validation |
|---|---|---|
| 1 | ... | ... |
| 2 | ... | ... |

### Risks

| Risk | Mitigation |
|---|---|
| ... | ... |

## Appendix B: Mechanical Execution Spec (for a low-capability executor)

Include this appendix when the plan may be implemented by a **lower-capability
model with limited reasoning** (e.g. a cheaper sub-agent). Its job is to remove
every design decision from the build path: exact signatures, exact edit anchors,
and a verify command per step. If the plan will only ever be implemented by a
high-capability model, you may delete this appendix — but prefer keeping it.

**Rule of thumb:** if any implementation step contains the words "decide",
"choose", "figure out", "as appropriate", or "if needed", it is NOT executor-ready
— resolve the decision in the plan body and restate the step as a concrete action.

### Executor contract (copy verbatim into the plan)

1. Do the steps **in numeric order**. Do not skip, reorder, or batch.
2. Each step says exactly which file, what to add/change, and how to verify.
3. **Make no design decisions.** If a step is ambiguous or the anchor text is not
   found verbatim, **STOP and ask** — do not guess or invent an alternative.
4. Run the verify command after each step. If it fails, fix only that step; do
   not proceed until green.
5. Slice test command: `<exact command>`.
6. Do not edit any file not named in the step. Read-only references: `<list>`.
7. One slice = one commit, message `<ID>-<n>: <slice title>`, with the required
   `Co-Authored-By` trailer.

### Shared constants / types (add once)

```ts
// Exact constants/types the steps below reference, with values — no placeholders.
```

### `<SLICE-ID>` — `<slice title>` (REQ-x/y)

| Step | File | Exact action (signature + anchor + literal change) | Verify |
|---|---|---|---|
| n.1 | `path/to/file.ts` | Add exported `fnName(args): RetType`. Body: `<exact behavior, including exact error strings>`. | `<grep/test command that proves it landed>` |
| n.2 | `path/to/test.mjs` | Add `testName`: `<exact arrange/act/assert, including the regex asserted>`. Register in `main()`. | `<test command>` green |

Repeat one sub-table per slice. Every step MUST have: (a) a named file, (b) an
exact signature or literal anchor text, (c) the exact change (error strings,
field names, numeric bounds spelled out), and (d) a runnable verify command.

### Definition of done (whole plan)

`<exact command(s)>` print all `<N>` tests passing, `<load/smoke command>`
succeeds, and `<an invariant grep that proves the security/contract boundary>`
shows the expected result.
