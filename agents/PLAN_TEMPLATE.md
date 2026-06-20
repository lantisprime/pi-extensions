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
6. **Edit exactly ONE file per step** — the single file named in that step's `File`
   column. If a change spans two files (e.g. add a function *and* a test), split it
   into two numbered steps, one file each. Read-only references (look but never edit):
   `<list>`.
7. **Surgical edits only — minimize blast radius.** For an **existing** file, use an
   anchored find-and-replace: the step gives the **verbatim `ANCHOR`** (the exact
   current text to locate, copied byte-for-byte) and the **exact `REPLACE`** text. Change
   only that span; never rewrite a whole file or function, never reflow/reformat
   untouched lines, never `Write`-overwrite an existing file. If the `ANCHOR` is not
   found verbatim, **STOP and ask** (do not search for a "close enough" location).
   Three action kinds only: **CREATE** (whole-file write — brand-new file, its own step),
   **EDIT** (anchored `ANCHOR → REPLACE` on existing content), **APPEND** (add a new
   export/block at end of a file — surgical because it adds and changes nothing existing;
   use it for new functions/types, including additions to a file you created earlier in the
   same slice). Label every step with its kind.
8. One slice = one commit, message `<ID>-<n>: <slice title>`, with the required
   `Co-Authored-By` trailer. **Each slice is independently shippable and testable** — it
   has its own `run-<ID>-tests.sh` and leaves the build green on its own, so slices can land
   one at a time in dependency order.

**Executor-ready gate (the plan author MUST pass this before handing off):** every
step's `File` column names exactly one file; **every step on an existing file quotes a
verbatim `ANCHOR` and an exact `REPLACE` (smallest diff that achieves the change);
whole-file `Write` appears only for new-file create steps**; no step text contains
"decide", "choose", "figure out", "as appropriate", "if needed", "etc.", or "e.g.";
every constant, error string, regex, and signature appears verbatim (in this appendix
or the Shared constants block) — nothing is left for the executor to author.

### Shared constants / types (add once)

```ts
// Exact constants/types the steps below reference, with values — no placeholders.
```

### `<SLICE-ID>` — `<slice title>` (REQ-x/y)

| Step | File | Exact action (CREATE / EDIT anchored / APPEND) | Verify |
|---|---|---|---|
| n.1 | `path/to/new-file.ts` | **CREATE** (Write). Full contents: `<exact source>`. | `<grep proving a marker line landed>` |
| n.2 | `path/to/new-file.ts` | **APPEND** at end of file. Add `export function fnName(args): RetType` — body `<exact behavior + error strings>`. (Adds only; changes nothing existing.) | `grep -n 'export function fnName'` |
| n.3 | `path/to/existing.ts` | **EDIT** (anchored). `ANCHOR:` `<verbatim current line(s)>` → `REPLACE:` `<exact new line(s)>`. Smallest diff; touch nothing else. | `<grep/test proving it landed>` |
| n.4 | `path/to/test.mjs` | **EDIT** (anchored). `ANCHOR:` `<verbatim line in main()>` → `REPLACE:` `<that line + new testName registration>`; add `testName` body `<exact arrange/act/assert + regex>`. | `<test command>` green |

Repeat one sub-table per slice. Every step MUST have: (a) **exactly one** named
editable file (never two — split multi-file changes into consecutive steps); (b) the kind
(`CREATE`/`EDIT`/`APPEND`); for `EDIT`, a **verbatim `ANCHOR`** + exact `REPLACE` (smallest
diff, no reformatting of untouched lines); (c) the exact change (error strings, field names,
numeric bounds spelled out); (d) a runnable verify command. A step that would touch a second
file, rewrite a whole function, or `Write`-overwrite an existing file is a planning bug —
split or re-anchor it.

### Blast-radius patterns (apply when authoring the steps)

These keep the diff small and the existing suite green — derived from real slices:

- **Test-preserving seam.** Add behavior at a seam the existing tests don't traverse. If a
  change can land where injected stubs/mocks bypass it (e.g. a default spawner, a default
  branch), prefer that — existing tests keep passing untouched. Verify by running the existing
  suite *before* writing new tests.
- **Thin wrapper over refactor.** To reuse a private function, **APPEND a thin exported
  wrapper** that calls it — do not refactor/restructure the original. (Exporting `foo` as
  `export function fooPublic(x) { return foo(x); }` is zero-blast; extracting a shared core out
  of `foo` is not.)
- **Fixture-change ledger.** If a step *necessarily* changes behavior covered by existing
  tests, it MUST list the exact assertions it edits (file:line, before → after) as its own
  anchored steps. Never write "existing tests stay green" for a step that changes their
  contract — that claim is a planning bug; enumerate the edits instead.
- **Flag high-blast-radius slices.** A slice that changes shared/broad behavior (a transport,
  an argv builder, a gate used by many callers) is marked **"focused review before build"** in
  its heading even when fully specified — the spec removes ambiguity, not the need for a human
  look at the behavior change.
- **Pure-extraction slice first.** When new wiring needs a function carved out of a
  security/critical path, do the **pure extraction as its own slice** (zero behavior change,
  existing tests green) *before* the slice that adds new callers.

### Definition of done (whole plan)

`<exact command(s)>` print all `<N>` tests passing, `<load/smoke command>`
succeeds, and `<an invariant grep that proves the security/contract boundary>`
shows the expected result.
