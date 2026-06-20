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

**A MUST requirement maps to an automated, falsifiable test** — not a manual or
CI-skippable smoke. A smoke that can `command -v … || exit 2`-skip is **not coverage**:
it can be green on a machine that never ran the check. If the only possible verification
of a MUST is a manual/skippable smoke (e.g. an OS-level behavior CI can't reproduce),
tag the row **`UNGUARDED-IN-CI`** and name, in the Notes column, the specific manual step
that does cover it — so the gap is a tracked, visible residual risk, never a hollow green.

## Non-Goals

Out of scope for this feature:

- <item 1>
- <item 2>

## Safety / Security

<If the feature carries a meaningful security surface (trust boundaries, privilege
escalation vectors, new data flows, child-process isolation, prompt injection risk),
capture it here. Otherwise delete this section and fold safety requirements into the
Requirements table as MUST rows + Design invariants.>

Each mitigation's `Test(s)` MUST be an automated, falsifiable check (same bar as a MUST
requirement) — a mitigation guarded only by a skippable smoke is tagged `UNGUARDED-IN-CI`
with the covering manual step named. A mitigation whose only test is the happy path is not
proven: include the negative control (see "Red-then-green guard") so the guard is shown to
catch the very failure it mitigates.

| Concern | Severity | Mitigation | Test(s) |
|---|---|---|---|
| <concern> | Low/Medium/High | <mitigation> | `<falsifiable-test>` (or `UNGUARDED-IN-CI` + manual step) |

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
9. **No aspirational output.** Every human-readable string a step emits (an `echo`/`log`
   line, a comment, a heredoc banner) that *describes a check* MUST be backed by an
   assertion that actually performs that check. A descriptive line with no backing
   assertion is a bug — it makes a stub read as coverage. If you cannot assert it, do not
   announce it.

**Executor-ready gate (the plan author MUST pass this before handing off):** every
step's `File` column names exactly one file; **every step on an existing file quotes a
verbatim `ANCHOR` and an exact `REPLACE` (smallest diff that achieves the change);
whole-file `Write` appears only for new-file create steps**; no step text contains
"decide", "choose", "figure out", "as appropriate", "if needed", "etc.", "e.g.", or —
as a *description of intent* — "assert that", "verify that", "check that", or "ensure";
every constant, error string, regex, and signature appears verbatim (in this appendix
or the Shared constants block) — nothing is left for the executor to author.

**Test/smoke/shell-script steps get the same rigor as code steps.** A step that
`CREATE`s a test, smoke, or shell script MUST give its **full verbatim contents,
including every literal assertion** — exactly like a code `CREATE`. Prose such as
"assert (a)/(b)/(c)" is a hidden "how?" decision and fails the gate. Each assertion
must be a **literal expression whose operands include the actual observed output** of
the thing under test (captured stdout/stderr, exit code, the written file's contents, or
an imported function's return) — never a constant, and never a string the step author
themselves wrote into a comment/echo/heredoc (that is self-fulfilling). `assert(true)`
or `assert(role)` where `role` is a hardcoded literal does not satisfy this.

### Falsifiable Verify (parent rule — the gate that makes the others bite)

A low-capability executor reliably produces the **weakest artifact its Verify command
will accept.** So every step's `Verify` MUST **fail if the step's intent is absent or
stubbed** — and that property must be visible in the command itself, not asserted in
prose. The sub-rules below (#1 verbatim bodies, the negative-control and sentinel
patterns, the no-aspirational-output contract item, the MUST/Safety mapping) are all
instances of this one rule; satisfy the parent, not just the cheapest child.

**Verify deny-list (any of these in a `Verify` cell is a planning bug):**

- tests only the exit code with a tolerant comparison (`test $? -ne 1`, `|| true`,
  `; true`, `&& echo ok`) — a no-op passes it;
- greps for a literal string the step *itself writes* into a comment, `echo`, or heredoc
  (self-fulfilling — the test proves only that the author can type);
- runs the unit on the happy path **only**, with no negative control proving it can fail;
- for a **MUST** requirement or a **Safety/Security** mitigation, is a manual or
  `command -v …`-skippable smoke with no `UNGUARDED-IN-CI` tag (see those sections).

**Positive obligation:** every `Verify` MUST name (a) the **observed value** it inspects —
captured stdout/exit/written-file/imported-return — and (b) the **expected concrete
value** it compares against. "Exits 0" / "script runs" names no value and fails the gate.
This is greppable: if a CI lint over the plan tables cannot find a capture-and-compare in
a `Verify` cell, that row is not executor-ready.

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
| n.4 | `path/to/test.mjs` | **EDIT** (anchored). `ANCHOR:` `<verbatim line in main()>` → `REPLACE:` `<that line + new testName registration>`; add `testName` with the **verbatim body** — each `assert` operates on real captured output (return/stdout/exit/file), uses a sentinel where a value must flow through, and includes a negative control. No "assert that …" prose. | `<command>`: green run **and** broken-input run exits non-zero |

Repeat one sub-table per slice. Every step MUST have: (a) **exactly one** named
editable file (never two — split multi-file changes into consecutive steps); (b) the kind
(`CREATE`/`EDIT`/`APPEND`); for `EDIT`, a **verbatim `ANCHOR`** + exact `REPLACE` (smallest
diff, no reformatting of untouched lines); (c) the exact change (error strings, field names,
numeric bounds spelled out); (d) a runnable **falsifiable** verify command — one that names
the observed value and expected value, and fails on a stubbed/broken implementation (see
"Falsifiable Verify"; a bare `test $?`/"exits 0" fails the gate). A step that would touch a
second file, rewrite a whole function, `Write`-overwrite an existing file, or ship a verify a
no-op would pass is a planning bug — split, re-anchor, or strengthen it.

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
- **Red-then-green guard (negative control in the Verify).** A step that adds a
  guard/smoke/regression for behavior X MUST prove the guard goes **RED** when X is broken —
  *a guard never observed failing guards nothing.* Discharge this **inside the `Verify`
  command**, not as a separate step or a committed fixture (that would fight one-file /
  one-commit): construct the broken input inline via env/arg and require non-zero, e.g.
  `BREAK_ROLE=1 node test.mjs; test $? -ne 0` followed by the normal green run. The break
  must be reachable from the command — never a file you have to add and remove.
- **Verify in the code's own language.** If the behavior under test is a TS/runtime
  function, its test MUST `import` and call the **real entry through injected seams** (the
  same Test-preserving-seam mechanism above, applied to the *new* test — not opposed to it)
  — never hand-roll an equivalent command in a shell wrapper, which tests a *different*
  command than production builds. A shell smoke is permitted **only** when the unit under
  test genuinely *is* the process boundary (argv/exec/exit/signal/PATH/binary-resolution
  semantics), and even then it MUST invoke the real builder, not a hand-typed argv. Such
  rows are tagged per the MUST/Safety mapping (`UNGUARDED-IN-CI` if CI-skippable).
- **Discriminating fixture / sentinel.** A guard's **positive** input MUST differ
  *observably* from its **negative** control in the exact dimension under test, and the
  assertion MUST inspect that dimension. Inject a unique sentinel (e.g.
  `ROLE_SENTINEL_a1b2c3`) and assert the child/output received **that token** — not merely
  "non-empty" or "exit 0". Empty, `/dev/null`, or default fixtures *for the value under
  test* are a planning bug: they make the positive case indistinguishable from the negative
  one, so a perfect assertion still proves nothing. (This is the hole behind the real
  `--append-system-prompt /dev/null` miss — the assertion fired, but the input could not
  exercise the behavior.) The positive case must be both discriminating **and reliable** —
  see "Deterministic / portable signal" when the signal is non-deterministic.
- **Deterministic / portable signal (non-deterministic guards).** When a guard's
  observable signal depends on **non-deterministic behavior** (an LLM's output, a race,
  wall-clock, network ordering), a green run on the author's machine does **not** prove the
  guard — it may be red on another model/provider/OS. (Real case: a smoke asserting an LLM
  emits a sentinel passed for the author and failed 4/4 for the reviewer.) Such a guard MUST:
  1. **Assert at the most deterministic observable point that actually exists — and verify
     it exists, don't assume.** Before asserting on model behavior, look for a mechanical
     channel carrying the guarantee (a structured `--mode json` event, an exit code, a
     written file, a log line emitted by the *code*, not the model); assert there if present.
     (Verified example: pi's `--mode json` stream does **not** echo the resolved system
     prompt in any event, so "did the appended system prompt reach the child" has *no*
     mechanical channel and falls to clause 3 — confirm such absence by inspection, never
     presume a channel.)
  2. **No self-defeating fixture.** The task/input MUST NOT constrain output in a way that
     fights the asserted signal — a task saying "reply with *just* X / nothing else" cannot
     coexist with a role saying "always emit `<SENTINEL>`." Mechanically reviewable: flag any
     fixture whose input contains "just / only / nothing else / exactly" while a sentinel is
     asserted in the output.
  3. **If behavioral compliance is unavoidable, make it near-deterministic and prove
     stability** — using a minimal, unambiguous instruction (`Always begin every reply with
     the exact token <SENTINEL> on its own line`) and a neutral task that does not compete.
     How you gate then depends on **which role the non-determinism plays** — these are
     opposite, and conflating them is itself a planning bug:
     - **3a. Non-determinism is incidental observation machinery** (the property under test
       is *deterministic*; the flaky signal is only *how you observe it*). Example: proving
       an appended system prompt **reached** the child — the transport is deterministic; the
       model emitting `<SENTINEL>` is just the read-out. Here **retry-to-observe** is correct:
       run up to N attempts, **pass if the signal appears at least once, fail if it never
       does.** A broken property never produces the signal in *any* attempt, so retry cannot
       mask the failure — it only smooths the read-out noise. Do **not** require consecutive
       greens here: that would flake on the incidental noise, not on the property.
     - **3b. Non-determinism IS the property under test** (e.g. "the model refuses X" / "the
       classifier picks Y"). Here **retry-to-green is forbidden** — it manufactures a pass by
       re-rolling the very thing you are measuring. Run a fixed N, **assert a rate/threshold**
       (`≥k of N`), and report the observed rate; never stop at the first green.
     - Either way, if the outcome still varies by model/provider/env beyond your threshold,
       tag the row `UNGUARDED-IN-CI` and name the residual + the manual check that covers it.
     (Calibration note: a blanket "≥3× consecutive" is wrong for 3a — on a 90%/attempt
     read-out it self-flakes ~27% — which is why the P6-0b transport smoke correctly uses
     retry-to-observe, not consecutive greens.)

### Definition of done (whole plan)

`<exact command(s)>` print all `<N>` tests passing, `<load/smoke command>`
succeeds, and `<an invariant grep that proves the security/contract boundary>`
shows the expected result.
