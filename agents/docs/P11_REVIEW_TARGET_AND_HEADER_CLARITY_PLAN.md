# P11 Review-Target Flags & Header Clarity Plan

## Status

Planning only. Plan review (5 adversarial lenses) complete — verdict **CONDITIONAL-GO**, all
blockers folded below. Do not implement until this plan is accepted.

## Episode Search Summary

Searched episodic memory for: review-context, diff base, `--base`/`--range`, git arg injection,
header clarity, prepareAgentTask plumbing.

Key active context (this repo, recent merged work):

- P9 (`#87`): parent-side review-context provider layer — `assembleReviewBundle`, `resolveReviewBase`,
  the `git-runner` `isSafeGitRef` guard, temp-file bundle a sandboxed child reads.
- P10 (`#89`): externalized method prompts + contained referenced-doc reads; `meta.projectRoot`,
  `cwd:projectRoot` override in `executeChildRunResult`.
- Profile-precedence correction (parked on this branch): `built-in > user > project`.

## Objective

Let a reviewer be pointed at an explicit diff target instead of always reviewing "HEAD vs working
tree." Add two run-only flags — `--base <ref>` and `--range <a>..<b>` / `<a>...<b>` — threaded from
`/agents run` through to `assembleReviewBundle`, and make the bundle header state its scope
unambiguously (especially the confusing "on the default branch, base resolves to HEAD, so you're
only seeing uncommitted edits" case). This kills the reported bug where, on `main`, the reviewer
silently reviewed only uncommitted README edits instead of the committed branch under review.

## Why

Today `assembleReviewBundle` always targets the auto-resolved base (merge-base of HEAD with
`main`/`master`) or, when that can't resolve (e.g. *on* `main`), HEAD-vs-worktree. A user who wants
the agent to review a committed feature branch has no way to say so, and the header does not make
the actual scope obvious — so the reviewer confidently reviews the wrong change set. Explicit
targeting + an honest header is the smallest fix that removes the ambiguity at its source.

## Requirements (Ground Truth)

| ID | Requirement | Test(s) | Priority | Notes |
|---|---|---|---|---|
| REQ-1 | `/agents run <agent> --base <ref> <task>` targets `<ref>`: diff = `<ref>` vs working tree, commits = `<ref>..HEAD`, untracked included (mirrors auto). | `testBaseModeTarget`, `E1-weird-valid-refs` | MUST | base mode == auto mode with an explicit base. |
| REQ-2 | `/agents run <agent> --range <a>..<b> <task>` targets the committed range: three-dot diff `git diff a...b`, commits `git log a..b`, **no** untracked, **no** worktree. | `testRangeModeTarget`, `A2-twodot-positive`, `G3-range-no-untracked` | MUST | diff and log describe the same change set (B3). |
| REQ-3 | The `..` vs `...` operator is parsed operator-aware; `a...b` is honored as range mode, never silently downgraded to base/auto. | `A3-threedot-positive`, `B4`-regression `testRangeOperatorAware` | MUST | naive `split('..')` drops `a...b` (B4). |
| REQ-4 | Every revision token reaching a `git` argv is validated by `isSafeGitRef` **per side** (each of `left`/`right`/`base`), not on the joined string. | `C1`–`C7`, `testPerSideRefValidation` | MUST (Safety) | `isSafeGitRef("a..-O")===true` but `isSafeGitRef("-O")===false` (B1). |
| REQ-5 | When the resolved base is the same commit as HEAD (`--base main` on `main`, `--base HEAD`, short/full SHA, tag/branch at HEAD, `HEAD~0`), the header emits an "UNCOMMITTED changes only" note instead of "vs base" wording. | `B1`–`B9` (`testBaseEqualsHeadNote`) | MUST | compare *resolved* SHAs, not raw strings (B2). |
| REQ-6 | On the default branch with no base resolved, the header emits ONE actionable note ("pass `--base`/`--range`"), and does not also render the legacy `degraded` note for the same condition. | `B8-default-noorigin`, `testNoDoubleNote` | MUST | `onDefaultBranch` signal, precedence vs `degraded` (B7). |
| REQ-7 | In a non-repo / no-commits tree, the new actionable note is suppressed; only the existing `degraded` note renders. | `B10-nonrepo-suppressed` | MUST | "pass --base/--range" is wrong advice with no repo (B7). |
| REQ-8 | `--base`/`--range` are **run-only**: `/agents do` and the NL gate treat them as task text and thread no review target. | `D8-do-rejects-flags`, `D9-gate-no-flags` | MUST | shared `parseLeadingRunFlags` must not leak the flags into `parseDoArgs` (B6). |
| REQ-9 | `reviewTarget` is threaded `parseRunArgs → runAgentCommand → dispatchChildRun → executeChildRun(Result) → prepareAgentTask → assembleReviewBundle`; the 5 non-run `prepareAgentTask` callers and the gate dispatch are byte-unchanged. | `F1`–`F5`, `testFiveCallersUnchanged`, `testGateDispatchUnchanged` | MUST | gate at index.ts:310 passes 5 positionals (B5). |
| REQ-10 | Invalid `--range` (empty side, >1 operator, unsafe token) is ignored with a scope note and falls back to **auto** — never to a silent contextless raw task. When both flags are given, REQ-11 governs (range wins; an invalid range resolves to auto, the ignored `--base` is NOT substituted). | `A5`,`A6`,`A7`,`C2`,`D5-both-flags-invalid-range` | MUST | fail visible, not silent (B4). CR-3: the both-flags case resolves via REQ-11, not a base-fallback. |
| REQ-11 | `--base` + `--range` together → `--range` wins, with a warning naming the ignored `--base`. | `D4-both-flags`, `D5-both-flags-invalid-range` | SHOULD | silently dropping a typed flag is the confusion we are removing. Single source of truth for both-flags precedence. |
| REQ-12 | The child-facing directive (`buildDirective`) reflects the mode: range mode says "committed range, no uncommitted"; base/auto says "vs base, plus uncommitted". | `F3-directive-range-wording` | SHOULD | requires `mode`/`scopeNote` on `BundleMeta`. |
| REQ-13 | `meta.projectRoot` is set from `rev-parse --show-toplevel` in all three modes (auto/base/range), so `cwd:projectRoot` (REQ-B3 from P10) does not regress. | `F4-cwd-projectroot-range` | MUST | preserve P10-B behavior. |
| REQ-14 | Repeated `--base`/`--range`, or a flag with a missing/`--`-prefixed value, is a clean usage error — never a thrown git error. | `D1`,`D2`,`D3`,`D6` | SHOULD | mirrors existing `--profile`/`--timeout` repeat handling. |

**Priority legend:** MUST = blocks first-slice merge. SHOULD = before feature complete. MAY = nice-to-have.

## Non-Goals

- No new flags on `/agents do` or the NL gate (run-only by design — REQ-8).
- No persistent / per-agent default target (no frontmatter `base:` field — code-owned config stays code-owned).
- No remote fetching (`--base origin/main` works only if the ref already exists locally; we never `git fetch`).
- No diff *rendering* changes (caps, lockfile skipping, truncation markers unchanged from P9).
- No change to how untracked files are listed in base/auto mode.

## Safety / Security

The whole surface is "user-supplied strings reaching a `git` argv." `defaultGitRunner` already spawns
`git` with an argv **array** (never a shell), and pathspecs are always after `--`. The new risk is a
revision token being interpreted by `git diff`/`git log` as an **option** (`-O<file>` reads an
arbitrary order-file; `--output <file>` writes the diff to an arbitrary path; `-G`, `--no-index`,
`--ext-diff` change behavior). None of these contain `=`, so a whole-string regex that only blocks
`--x=y` would pass them.

| Concern | Severity | Mitigation | Test(s) |
|---|---|---|---|
| Right side of a range smuggles an option past a whole-string check (`--range a..-O`) | High | Split FIRST, then `isSafeGitRef(left)` **and** `isSafeGitRef(right)` separately; reject the whole range on either failure. | `C2-joined-vs-perside`, `testPerSideRefValidation` |
| `--base` value is a single/double-dash option (`-O/tmp/x`, `--output=…`, `--no-index`) | High | `isSafeGitRef(base)` (first char must be alnum) → reject + scope note; token never reaches argv. | `C3-base-single-dash`, `C4-base-double-dash` |
| Shell-ish / control-char tokens (`a;rm`, `$(x)`, `@{upstream}`, embedded `\r`) | Medium | `isSafeGitRef` rejects (only `[A-Za-z0-9._/@^~-]`, no `;`, `$`, `{`, space, control). | `C5`,`C6`,`C8` |
| A validated token still slips into `diffArgs`/`logRange` | Medium (defense-in-depth) | Call-site guard: `if (!diffArgs.every(isSafeGitRef)) { omit }` at numstat + per-file diff; assert `logRange` is `isSafeGitRef`-true before `git log`. | `C1-perfile-revalidate`, `C9`, `C10-logrange-safe` |
| A real filename `-O` parsed as an option | Low | Pathspecs stay after `--`: argv is exactly `[diff, ...diffArgs, "--", file]`. | `C9-pathspec-order` |
| `assembleReviewBundle` throwing out of best-effort dispatch | Medium | All new resolution is inside the existing never-throw wrapper; `resolveDiffTarget` returns a degraded target on any git failure, never throws. | `testResolveDiffTargetNeverThrows`, `G1`,`G2` |

Every mitigation above is asserted on **captured git argv** via the injected `GitRunner` sink (a
header-note assertion alone does not prove a token never reached `git`).

## Design

### Key types

```ts
// NEW — git-runner.ts (APPEND): operator-aware range split. Pure, no git.
export type ParsedRange =
  | { ok: true; left: string; right: string; op: ".." | "..." }
  | { ok: false; reason: string };

// NEW — review-context.ts: the validated, resolved diff target.
export type ReviewTargetInput =
  | { kind: "auto" }
  | { kind: "base"; ref: string }
  | { kind: "range"; spec: string };   // raw "a..b" / "a...b" — parsed+validated in resolveDiffTarget

export type DiffTarget = {
  mode: "auto" | "base" | "range";
  /** Revision tokens for `git diff ...diffArgs [-- file]` and `git diff --numstat ...diffArgs`.
   *  Always 0 or 1 element; every element is isSafeGitRef-true. [] ⇒ use "HEAD" (uncommitted-only). */
  diffArgs: string[];
  /** Range for `git log <logRange>`; null ⇒ omit the commits section. isSafeGitRef-true when set. */
  logRange: string | null;
  /** base/auto: true (append untracked); range: false (committed only). */
  includeUntracked: boolean;
  base: string | null;
  branch: string | null;
  /** true only when on a default branch (main/master) with no base resolved — drives the actionable note. */
  onDefaultBranch: boolean;
  /** legacy soft-degrade note (non-repo, merge-base failure). */
  degraded: string | null;
  /** human note appended to the header for this target (base==HEAD, invalid-range, both-flags…). null ⇒ none. */
  scopeNote: string | null;
};
```

### Key invariants

- **I1 — per-side validation.** A range is accepted only if `isSafeGitRef(left) && isSafeGitRef(right)`.
  The joined `left...right` token is built *after* both sides pass; it is itself isSafeGitRef-true.
- **I2 — single diffArg.** `diffArgs.length ∈ {0,1}`. Base mode → `[base]`; range mode → `["${left}...${right}"]`;
  auto with base → `[base]`; auto without base → `[]` (call site substitutes `"HEAD"`).
- **I3 — diff/log coherence.** Range mode diff is always three-dot (`a...b` = `merge-base(a,b)..b`),
  log is always `a..b`; both describe "what `b` added since it forked from `a`." Verified coherent on
  diverged branches (a fast-forward fixture hides the bug — pin with a diverged fixture, A1).
- **I4 — base==HEAD by resolved SHA.** Detection compares `git rev-parse <base>` to `git rev-parse HEAD`,
  never raw strings. `headSha==null` (no commits) ⇒ never claims base==HEAD.
- **I5 — run-only flags.** `parseLeadingRunFlags(..., {allowTargetFlags})`; `parseDoArgs` passes
  `false`. The gate path never parses these flags.
- **I6 — never-throw.** `resolveDiffTarget` and all providers degrade soft; `assembleReviewBundle`
  never throws (existing N3 wrapper preserved).

### Resolution / flow

```text
parseRunArgs(input)
  └─ parseLeadingRunFlags(tokens, 1, {allowTargetFlags:true})
       → { profileOverride?, timeoutMs?, reviewTarget?: ReviewTargetInput }   // syntactic only
runAgentCommand → dispatchChildRun → executeChildRun(Result)
  └─ prepareAgentTask(agent, task, { cwd, reviewTarget })
       └─ assembleReviewBundle(providers, { cwd, reviewTarget })
            ├─ resolveDiffTarget(git, root, defaultBranches, reviewTarget)  → DiffTarget  (validates, resolves SHAs)
            ├─ collectChangedFiles(git, root, diffArgs, includeUntracked)
            ├─ buildDiffSection(git, root, diffArgs, files, caps)
            ├─ buildCommitsSection(git, root, logRange, caps)
            └─ header: Branch • Base/scope, + scopeNote (mode-aware)
```

### `resolveDiffTarget` decision table

| Input | mode | diffArgs | logRange | includeUntracked | header scope / note |
|---|---|---|---|---|---|
| `{kind:auto}`, base resolves | auto | `[base]` | `${base}..HEAD` | true | "Base: `<base>`" |
| `{kind:auto}`, on default branch, no base | auto | `[]` | null | true | actionable note (REQ-6) |
| `{kind:auto}`, non-repo / no commits | auto | `[]` | null | true | legacy `degraded` only (REQ-7) |
| `{kind:base, ref}` valid, resolves ≠ HEAD | base | `[ref]` | `${ref}..HEAD` | true | "Base: `<ref>`" |
| `{kind:base, ref}` valid, resolves == HEAD | base | `[ref]` | `${ref}..HEAD` | true | base==HEAD note (REQ-5) |
| `{kind:base, ref}` unsafe | auto* | per auto | per auto | true | "ignored unsafe --base `<ref>`" + fall to auto |
| `{kind:base, ref}` valid but nonexistent (git 128) | base | `[ref]` | `${ref}..HEAD` | true | degraded "base may not exist" (G1) |
| `{kind:range, "a..b"}` both sides safe | range | `["a...b"]` | `a..b` | false | "committed range a..b (b since fork from a)" |
| `{kind:range, "a...b"}` both sides safe | range | `["a...b"]` | `a...b` | false | "committed range a...b (symmetric)" |
| `{kind:range, "a.."}` | range | `["a...HEAD"]` | `a..HEAD` | false | range, right=HEAD |
| `{kind:range, "..b"}` / `".."` / `"a..b..c"` / unsafe side | auto* | per auto | per auto | true | invalid-range note + fall to auto (REQ-10) |

\* "fall to auto" = run `resolveReviewBase` and use the auto row, but keep the scope note explaining the fallback.

## Existing Hook Points

| File | Line(s) | What it does | Impact |
|---|---|---|---|
| `lib/context-providers/git-runner.ts` | L21-25 | `SAFE_GIT_REF_RE`, `isSafeGitRef` | APPEND `parseRange` (pure). No change to the regex. |
| `lib/context-providers/review-context.ts` | L153-172 | `resolveReviewBase` (auto base) | Wrapped by new `resolveDiffTarget`; add `onDefaultBranch` return. |
| `lib/context-providers/review-context.ts` | L190-197 | `collectChangedFiles(git,cwd,base)` | Re-signature → `(git,cwd,diffArgs,includeUntracked)`; gate `ls-files` on `includeUntracked`. |
| `lib/context-providers/review-context.ts` | L215-245 | `buildDiffSection(...,base,...)` | Re-signature → `diffArgs`; per-file guard → `diffArgs.every(isSafeGitRef)`. |
| `lib/context-providers/review-context.ts` | L248-255 | `buildCommitsSection(...,base,...)` | Re-signature → `logRange`; assert `isSafeGitRef(logRange)`. |
| `lib/context-providers/review-context.ts` | L116-139 | `BundleDeps`, `BundleMeta` | Add `reviewTarget?` to deps; add `mode`,`scopeNote` to meta. |
| `lib/context-providers/review-context.ts` | L337-391 | `assembleReviewBundle` | Call `resolveDiffTarget`; header scopeNote; meta fields. |
| `lib/context-providers/prepare-task.ts` | L35-50 | `buildDirective(bundlePath,meta,rawTask)` | Use `meta.mode`/`meta.scopeNote` for wording. |
| `lib/context-providers/prepare-task.ts` | L52-82 | `PrepareTaskOptions`, `prepareAgentTask` | Add optional `reviewTarget?`; forward into `assemble(...)`. |
| `lib/run-resolver.ts` | L98-163 | `executeChildRunResult`/`executeChildRun`/`dispatchChildRun` | Thread `reviewTarget` (options object). |
| `lib/run-resolver.ts` | L186-230 | `parseRunArgs` / `parseLeadingRunFlags` | Parse `--base`/`--range` (run-only). |
| `lib/run-resolver.ts` | L276-286 | `parseDoArgs` | Pass `allowTargetFlags:false`. |
| `index.ts` | ~L310 | gate dispatch `__gateDispatch.fn(agent,text,ctx,"built-in",profile)` | MUST stay byte-unchanged (5 positionals). |

## Slice Ladder

| Slice | Objective | Primary files | Key deliverables | Tests | Hard stops |
|---|---|---|---|---|---|
| `P11-1` | Pure parse + validate + resolve (no wiring) | `git-runner.ts`, `review-context.ts` | `parseRange`, `resolveDiffTarget` (+ `onDefaultBranch` on `resolveReviewBase`) | `test-review-context.mjs` Groups A(parse)/C(validate)/B(SHA) | No call-site rewires yet; existing suite green. |
| `P11-2` | Wire `resolveDiffTarget` into `assembleReviewBundle`; refactor providers; header clarity; meta fields | `review-context.ts` | re-signed `collectChangedFiles`/`buildDiffSection`/`buildCommitsSection`; header note; `meta.mode`/`scopeNote` | `test-review-context.mjs` Groups A/B/C/G (sink-asserted) | **focused review before build** (high-blast: shared assembler). |
| `P11-3` | Thread `reviewTarget` through dispatch + flags (run-only) + directive wording | `run-resolver.ts`, `prepare-task.ts` | `--base`/`--range` parsing; options-object plumbing; `buildDirective` mode wording | `test-run-resolver-target.mjs` (Groups D/E/F), `test-prepare-task.mjs` additions | gate + 5 callers byte-unchanged (F2/F5). |
| `P11-4` | Runbooks + `reviewer.md` wording: review the committed branch / stated scope | `.pi/runbooks/*`, `lib/prompts/reviewer.md` | scope-aware wording | manual (docs) | parallel to P11-1..3. |

### Dependency graph

```text
P11-1 ── P11-2 ── P11-3
P11-4 (docs/runbooks) ── independent, parallelizable with all of the above
```

Only P11-4 parallelizes; P11-1→2→3 is a hard chain (parser feeds assembler feeds plumbing).

## Cut Order

If scope grows, cut in this order:

1. REQ-11 (`--base`+`--range` precedence niceties) — make "both given" a usage error instead.
2. REQ-12 (directive wording) — keep the generic P9 directive.
3. The `...` symmetric-log distinction — treat `...` as a synonym of `..` (still honored, never dropped).

Do not cut:

- Per-side `isSafeGitRef` validation (REQ-4 / Safety) — the security boundary.
- base==HEAD resolved-SHA detection (REQ-5) — the headline bug.
- Run-only gating of the flags (REQ-8) and gate/5-caller invariance (REQ-9).
- Never-throw (I6).

## Contracts

### `parseRange(spec: string): ParsedRange`

**Input:** a raw range string (the `--range` value).
**Output:** `{ok:true,left,right,op}` or `{ok:false,reason}`. Pure; no validation of ref safety (that
is the caller's per-side `isSafeGitRef`).

**State table (exhaustive):**

| State | Condition | Output |
|---|---|---|
| A. three-dot | `/^(.+?)(\.\.\.)(.+)$/` matches, both sides non-empty | `{ok,left,right,op:"..."}` |
| B. two-dot | `/^(.+?)(\.\.)(.+)$/` matches (after `...` tried first), both non-empty | `{ok,left,right,op:".."}` |
| C. open-right `a..` | left non-empty, right empty, op `..` | `{ok,left,right:"HEAD",op:".."}` |
| D. open-right `a...` | left non-empty, right empty, op `...` | `{ok,left,right:"HEAD",op:"..."}` |
| E. empty-left `..b` | left empty | `{ok:false,reason:"empty left side"}` |
| F. both-empty `..` | both empty | `{ok:false,reason:"empty range"}` |
| G. no operator | no `..` present | `{ok:false,reason:"missing .. or ... operator"}` |
| H. >1 operator `a..b..c` | more than one `..`/`...` group | `{ok:false,reason:"more than one range operator"}` |

**Operator order:** match `...` BEFORE `..` (longest-first) so `a...b` is op `...`, not `a` + `.b`.

### `resolveDiffTarget(git, cwd, defaultBranches, input): Promise<DiffTarget>`

**Input:** the never-throw `git` wrapper, repo-root cwd, default branch list, a `ReviewTargetInput`.
**Output:** a `DiffTarget` (above). **Never throws.** On any unsafe/invalid input it returns the
auto-resolved target with a `scopeNote` explaining the fallback.

**Error codes (carried in `scopeNote`, never thrown):**

| Code (note text contains) | Trigger |
|---|---|
| `ignored unsafe --base` | `kind:base` and `!isSafeGitRef(ref)` |
| `invalid --range` | `parseRange` fails OR either side unsafe |
| `base == HEAD` | resolved base SHA === resolved HEAD SHA |
| `using --range, ignoring --base` | both inputs present (resolved upstream to `kind:range` precedence) |
| `base may not exist` | base mode, `rev-parse <ref>` exits non-zero |

### `assembleReviewBundle(providers, deps)` — additions

**Input contract:** `deps.reviewTarget?: ReviewTargetInput` (absent ⇒ `{kind:"auto"}`).
**Output contract:** `meta` gains `mode: "auto"|"base"|"range"` and `scopeNote: string|null`;
`projectRoot` still set in all modes (REQ-13). Header gains the mode-aware note.

## Edge Cases

| # | Scenario | Expected behavior | Test |
|---|---|---|---|
| EC1 | `--range a..-O` | joined passes regex, right side `-O` fails per-side → range ignored + note, falls to auto | `C2-joined-vs-perside` |
| EC2 | `--range a...b` on diverged branches | three-dot diff file-set matches `log a..b` commit list | `A1-diverged-consistency` |
| EC3 | `--base main` while on `main` | base==HEAD note (resolved SHA), NOT "vs base" | `B1-base-name-on-main` |
| EC4 | `--base <short-sha-of-HEAD>` | base==HEAD note after rev-parse normalization | `B4-base-short-sha` |
| EC5 | On `main`, no origin, 1 uncommitted file (the reported repro) | one actionable note; legacy `degraded` not also shown | `B8-default-noorigin` |
| EC6 | Non-repo / no commits | legacy `degraded` only; actionable note suppressed | `B10-nonrepo-suppressed` |
| EC7 | Local `main` ahead of `origin/main` (committed, unpushed) | normal header showing unpushed commits, NO actionable note | `B11-local-ahead-of-origin` |
| EC8 | `/agents do --base main fix it` | `--base main` is task text; no reviewTarget threaded | `D8-do-rejects-flags` |
| EC9 | NL gate prompt containing `--base` | words land in task; AUTO bundle assembles; no target | `D9-gate-no-flags` |
| EC10 | `--base nonexist123` (git 128) | degraded note, no diff fence, dispatch still proceeds | `G1-nonexistent-base` |
| EC11 | Range mode | NO `ls-files --others` invocation (sink-asserted) | `G3-range-no-untracked` |
| EC12 | Range mode from a nested subdir / linked worktree | child cwd = `projectRoot` (show-toplevel) | `F4-cwd-projectroot-range` |
| EC13 | `--base main --range a..b` | range wins; scope note names ignored `--base` | `D4-both-flags` |
| EC14 | `--base --range x` (missing base value) | clean usage rejection, not a thrown git error | `D6-missing-value` |

## Test Case Catalog

Grouped by concern. Every name here also appears in the Requirements / Edge-Case tables.

```text
Group A — Range parsing & semantics (12)
  A1-diverged-consistency  A2-twodot-positive  A3-threedot-positive  A4-open-right
  A5-empty-left  A6-both-empty  A7-too-many-parts  A8-reverse-range  A9-empty-diff-range
  A10-commit-leak-guard  A11-spaced-range  A12-detached-open

Group B — base==HEAD detection (14)
  B1-base-name-on-main  B2-base-HEAD  B3-base-full-sha  B4-base-short-sha  B5-base-tag-at-head
  B6-base-branch-at-head  B7-base-headtilde0  B8-default-noorigin  B9-origin-ahead
  B10-nonrepo-suppressed  B11-local-ahead-of-origin  B12-normal-feature-clean
  B13-detached-with-base  B14-detached-no-base

Group C — Security / option-injection, sink-asserted (10)
  C1-perfile-revalidate  C2-joined-vs-perside  C3-base-single-dash  C4-base-double-dash
  C5-base-shellish  C6-reflog-upstream  C7-nonascii-overlong  C8-embedded-cr
  C9-pathspec-order  C10-logrange-safe

Group D — Flag parsing edge cases (9)
  D1-base-repeat  D2-range-repeat  D3-literal-dashdash  D4-both-flags  D5-invalid-range-valid-base
  D6-missing-value  D7-base-contains-dotdot  D8-do-rejects-flags  D9-gate-no-flags

Group E — Positive ref grammar (1)
  E1-weird-valid-refs

Group F — Plumbing & cwd (5)
  F1-target-reaches-runner  F2-five-callers-bytewise  F3-directive-range-wording
  F4-cwd-projectroot-range  F5-gate-no-edits

Group G — Degraded / empty-review UX (5)
  G1-nonexistent-base  G2-nonexistent-range  G3-range-no-untracked  G4-clean-tree-base  G5-range-on-main
```

Total: **56 tests** (plus the existing P9 suite must stay green).

## Risk Analysis

| Risk | Severity | Mitigation |
|---|---|---|
| Re-signing `collectChangedFiles`/`buildDiffSection`/`buildCommitsSection` breaks existing P9 tests | Medium | P11-2 is "focused review"; run the existing `run-p9-tests.sh` before/after; existing tests assert on markdown not signatures, so internal re-sign is invisible if `assembleReviewBundle` output is preserved for the auto path. |
| Threading `reviewTarget` reorders a positional and breaks the gate | High | Use an options object end-to-end; `F5-gate-no-edits` + `testGateDispatchUnchanged` pin the 5-positional gate call. |
| Per-side validation regresses to whole-string | High | `C2-joined-vs-perside` is the single canary: `a..-O` joined-true / right-false. |
| `...` operator silently dropped by `split('..')` | High | operator-aware regex, `...` tried first; `A3` + `testRangeOperatorAware`. |
| Diverged-branch incoherence (diff ≠ log) | Medium | three-dot diff + `a..b` log; pinned by diverged fixture `A1` (not a fast-forward fixture). |
| Double note on default branch | Low | `onDefaultBranch` precedence; `testNoDoubleNote`. |

## Open Decisions

- **`...` symmetric log vs synonym of `..`.** Plan keeps `...` first-class: range mode honors the
  operator, `logRange` = `a...b` for `...` input and `a..b` for `..` input; the diff is three-dot in
  both. If this proves confusing, Cut-Order #3 collapses `...`→`..` synonym. Resolved for now: keep
  distinct, pin both with `A2`/`A3`.
- **`--base HEAD~3..HEAD` (a range value passed to `--base`).** Decision: `--base` value must NOT
  contain a range operator → treated as a single ref; `git diff HEAD~3..HEAD` would be a range, so we
  reject a `--base` value containing `..` with an "use --range for ranges" note. Pinned by `D7`.

## Done Criteria

- [ ] All 56 new tests pass; existing `run-p9-tests.sh` + full suite green.
- [ ] `git grep -n "split(\"..\")"` in `lib/` returns nothing (operator-aware parser only).
- [ ] Every `git diff`/`git log` argv in the sink across Group C is free of `-O`/`--output`/`--upload-pack`/`@{`.
- [ ] Gate dispatch call in `index.ts` is byte-identical to pre-P11 (`git diff` of that line empty).
- [ ] Runbooks + `reviewer.md` state the committed-branch review scope.

## Review Consensus

| Pass | Reviewer | Model | Blocker count | Verdict |
|---|---|---|---|---|
| 1 (plan) | plan-review workflow: security / git-arg-injection lens | Opus 4.8 (1M) | 1 (B1) | conditional-go |
| 1 (plan) | range/base semantics lens | Opus 4.8 (1M) | 2 (B3,B4) | conditional-go |
| 1 (plan) | header-clarity lens | Opus 4.8 (1M) | 2 (B2,B7) | conditional-go |
| 1 (plan) | plumbing lens | Opus 4.8 (1M) | 1 (B5) | conditional-go |
| 1 (plan) | test-completeness lens | Opus 4.8 (1M) | 1 (B6 + missing scenarios) | conditional-go |
| 1 (plan) | synthesis | Opus 4.8 (1M) | 7 de-duped | **CONDITIONAL-GO** |
| 2 (code) | code-review workflow: 4 lenses (security/semantics/plumbing/tests) → verify → synthesis | Opus 4.8 (1M) | 7 confirmed, **all LOW** (3 rejected `not-a-bug`: gate/seam/warning clean) | **GO** (fixed pre-merge, not deferred) |

### Code-review findings (pass 2) — all folded before merge

| # | Finding | Resolution | Test |
|---|---|---|---|
| CR-1 | base==HEAD child directive said "vs base, plus uncommitted" while header said "uncommitted only" | `buildDirective` special-cases base==HEAD → uncommitted-only wording | `testBaseEqHeadDirective` |
| CR-2 | invalid flag on default branch swallowed BOTH the actionable note and `degraded` | `auto()` appends notes; keeps `degraded` when fallback occupies scopeNote | `p11_CR2_invalid_range_on_main_keeps_guidance` |
| CR-3 | D5 both-flags-invalid-range untested; plan REQ-10/11 divergence | REQ-11 governs both-flags (range wins → auto); plan reconciled | `D5_both_flags_invalid_range` |
| CR-4 | `deliverDegradedTarget` half-covered (mutation-proven) | added range-disjunct + clean-tree-noop tests | `testG2_range_degraded_delivered`, `testG4_explicit_clean_tree_noop` |
| CR-5 | spaced `--range a .. b` silently mangled task text | warn on a space-split range value | `A11_spaced_range_warns` |
| CR-6 | header two-dot vs diff-section three-dot notation | diff label now reads "(three-dot diff)" | `p11_A1_diff_log_coherent` (existing) |
| CR-7 | `.stdout.trim()` threw on a non-string stdout (test-only reachable) | never-throw wrapper coerces stdout/stderr to strings | `p11_CR7_nonstring_stdout_no_throw` |

### Resolved blockers

| # | Blocker | Resolution |
|---|---|---|
| B1 | Whole-string ref guard lets `-O`/`--output` leak via `a..-O` | Per-side `isSafeGitRef(left)`+`isSafeGitRef(right)`; call-site `diffArgs.every(isSafeGitRef)`; `logRange` asserted safe. REQ-4, Group C. |
| B2 | base==HEAD detection compared raw strings, missing `--base main`/short-sha/tag | Compare resolved `rev-parse` SHAs; handle null HEAD. REQ-5, Group B. |
| B3 | Two-dot diff + asymmetric log incoherent on diverged branches | Three-dot diff for `..`, log `a..b`; diverged fixture A1. REQ-2, I3. |
| B4 | `split('..')` silently downgrades `a...b` | Operator-aware regex, `...` first; A3 + regression. REQ-3. |
| B5 | Threading `reviewTarget` could break 6 callers + gate | Options object; 5 callers + gate byte-unchanged. REQ-9, F2/F5. |
| B6 | New flags leak into `/agents do` via shared parser | `allowTargetFlags` param; `parseDoArgs` passes false. REQ-8, D8/D9. |
| B7 | `base==null` overloaded; new note collides with `degraded`, wrong in non-repo | `onDefaultBranch` signal; precedence: non-repo→degraded wins. REQ-6/7, B8/B10. |

## Appendix: Implementation Plan

### Files to create

1. `test-fixtures/test-run-resolver-target.mjs` — Groups D/E/F (flag parsing + plumbing + gate invariance).
2. `test-fixtures/run-p11-tests.sh` — runs the new + touched suites.

### Files to modify

| File | Change |
|---|---|
| `lib/context-providers/git-runner.ts` | APPEND `parseRange`. |
| `lib/context-providers/review-context.ts` | `onDefaultBranch` on `resolveReviewBase`; `resolveDiffTarget`; re-sign 3 providers; header note; `BundleDeps.reviewTarget`; `BundleMeta.mode`/`scopeNote`. |
| `lib/context-providers/prepare-task.ts` | `PrepareTaskOptions.reviewTarget?`; forward into `assemble`; `buildDirective` mode wording. |
| `lib/run-resolver.ts` | `parseLeadingRunFlags(...,{allowTargetFlags})`; parse `--base`/`--range`; thread `reviewTarget` options object; `parseDoArgs` passes false. |
| `test-fixtures/test-review-context.mjs` | Groups A/B/C/G. |
| `test-fixtures/test-prepare-task.mjs` | `reviewTarget` forwarding + directive wording; add `projectRoot`/`mode` to fixtures. |

### Implementation sequence

| Step | Action | Validation |
|---|---|---|
| 1 | P11-1: `parseRange` + `resolveDiffTarget` + `onDefaultBranch` (pure) | Group A(parse)/B(SHA)/C(validate) green; P9 suite green |
| 2 | P11-2: wire into `assembleReviewBundle`, re-sign providers, header | Group A/B/C/G green; P9 markdown assertions green |
| 3 | P11-3: flags + plumbing + directive | Group D/E/F green; gate-diff empty |
| 4 | P11-4: runbooks + `reviewer.md` | manual review |

### Risks

| Risk | Mitigation |
|---|---|
| P11-2 high blast radius | focused review; existing suite as the regression net |
| Positional drift in plumbing | options object + gate-invariance test |

## Appendix B: Mechanical Execution Spec (for a low-capability executor)

### Executor contract

1. Do steps in numeric order. Do not skip, reorder, or batch.
2. Each step names exactly one file, the action kind, and a verify command.
3. **Make no design decisions.** If an `ANCHOR` is not found verbatim, STOP and ask.
4. Run the verify after each step; if red, fix only that step before proceeding.
5. Slice test command: `bash test-fixtures/run-p11-tests.sh`.
6. **Edit exactly ONE file per step.** Read-only references (look, never edit):
   `lib/specs.ts`, `index.ts`, `lib/child-runner.ts`.
7. **Surgical edits only.** EDIT = anchored `ANCHOR → REPLACE`; APPEND = add at end; CREATE = new file.
8. One slice = one commit `P11-<n>: <title>` with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.
9. No aspirational output: every "asserts X" line is backed by a real assertion on captured output.

### Shared constants / types (exact)

```ts
// git-runner.ts — APPEND
export type ParsedRange =
  | { ok: true; left: string; right: string; op: ".." | "..." }
  | { ok: false; reason: string };

export function parseRange(spec: string): ParsedRange {
  if (typeof spec !== "string" || spec.length === 0) return { ok: false, reason: "empty range" };
  // longest-operator-first; exactly one operator group
  const m = /^(.*?)(\.\.\.|\.\.)(.*)$/.exec(spec);
  if (!m) return { ok: false, reason: "missing .. or ... operator" };
  const left = m[1];
  const op = m[2] === "..." ? "..." : "..";
  let right = m[3];
  // reject a second operator anywhere in the remainder
  if (/\.\.\.?/.test(right)) return { ok: false, reason: "more than one range operator" };
  if (left.length === 0 && right.length === 0) return { ok: false, reason: "empty range" };
  if (left.length === 0) return { ok: false, reason: "empty left side" };
  if (right.length === 0) right = "HEAD";
  return { ok: true, left, right, op };
}
```

```ts
// review-context.ts — exact scope-note strings
const NOTE_BASE_EQ_HEAD =
  "⚠ --base resolves to HEAD — showing UNCOMMITTED changes only (base and HEAD are the same commit).";
const NOTE_ON_DEFAULT_BRANCH = (branch: string) =>
  `⚠ Reviewing UNCOMMITTED changes only — you are on ${branch} and no base was resolved. ` +
  `To review a committed branch, pass --base <ref> or --range <a>..<b>.`;
const NOTE_UNSAFE_BASE = (ref: string) => `ignored unsafe --base ${JSON.stringify(ref)}; using auto base.`;
const NOTE_INVALID_RANGE = (spec: string, reason: string) =>
  `invalid --range ${JSON.stringify(spec)} (${reason}); using auto base.`;
const NOTE_BOTH_FLAGS = "both --range and --base given; using --range, ignoring --base.";
const NOTE_BASE_MAYBE_MISSING = (ref: string) => `base ${JSON.stringify(ref)} may not exist; diff may be empty.`;
```

```ts
// run-resolver.ts — usage strings (exact, replace the existing ones)
const RUN_USAGE = "Usage: /agents run <agent> [--profile <name>] [--timeout <seconds>] [--base <ref> | --range <a>..<b>] <task>";
```

### `P11-1` — pure parse + validate + resolve (REQ-3/4/5/6)

| Step | File | Exact action | Verify |
|---|---|---|---|
| 1.1 | `lib/context-providers/git-runner.ts` | **APPEND** the `ParsedRange` type + `parseRange` (Shared-constants block, verbatim). | `node -e "import('./lib/context-providers/git-runner.ts').then(m=>{const r=m.parseRange('a...b');if(r.op!=='...'||r.right!=='b')process.exit(1);const u=m.parseRange('..b');if(u.ok)process.exit(1);console.log('ok')})"` prints `ok` |
| 1.2 | `lib/context-providers/review-context.ts` | **EDIT** (anchored). `ANCHOR:` `return { base: null, branch, degraded: branch ? ...` line(s) of `resolveReviewBase`; widen its return type to add `onDefaultBranch: boolean` and set it true only when `branch && defaultBranches.includes(branch)` and base unresolved. (Smallest diff: change the two `return` sites + the signature's return type.) | `node test-fixtures/test-review-context.mjs` — `testResolveBase` still green; new assert `onMain.onDefaultBranch===true`, `nonRepo.onDefaultBranch===false` |
| 1.3 | `lib/context-providers/review-context.ts` | **APPEND** `DiffTarget` type + `resolveDiffTarget(git,cwd,defaultBranches,input)` per the decision table; uses `parseRange`, per-side `isSafeGitRef`, `git rev-parse <base>`/`rev-parse HEAD` for base==HEAD. Never throws. | `node test-fixtures/test-review-context.mjs` green incl. new `testResolveDiffTarget*` |
| 1.4 | `test-fixtures/test-review-context.mjs` | **EDIT** (anchored, register in `main()`): add Group A(parse), B(SHA via `makeGit` routes for `rev-parse`), C(per-side validate, sink-asserted no `-O` in argv). Verbatim bodies; each asserts on captured `sink[].args` or returned `DiffTarget`. Include negative control: `--range a..-O` → `mode==='auto'` AND no sink arg includes `-O`. | `node test-fixtures/test-review-context.mjs` prints new total; `C2` fails if validation regresses to whole-string |

### `P11-2` — wire into assembler + header (REQ-1/2/6/7/12/13) — **focused review before build**

| Step | File | Exact action | Verify |
|---|---|---|---|
| 2.1 | `lib/context-providers/review-context.ts` | **EDIT** `collectChangedFiles` signature `(git,cwd,base)` → `(git,cwd,diffArgs,includeUntracked)`; `range`→`diffArgs[0] ?? "HEAD"`; gate `ls-files --others` behind `if (includeUntracked)`. | `node test-fixtures/test-review-context.mjs` green |
| 2.2 | `lib/context-providers/review-context.ts` | **EDIT** `buildDiffSection` param `base`→`diffArgs`; per-file guard → `if (!diffArgs.every(isSafeGitRef)) { omitted.push(f.path); continue; }`; argv `["diff", ...diffArgs, "--", f.path]`. | green; `C1` sink shows no unsafe token in `git diff` argv |
| 2.3 | `lib/context-providers/review-context.ts` | **EDIT** `buildCommitsSection` param `base`→`logRange`; `if (!logRange || !isSafeGitRef(logRange)) return null;` argv `["log", logRange, ...]`. | green; `C10` |
| 2.4 | `lib/context-providers/review-context.ts` | **EDIT** `BundleDeps` (+`reviewTarget?: ReviewTargetInput`) and `BundleMeta` (+`mode`, +`scopeNote`). | `tsc`/type-strip load OK |
| 2.5 | `lib/context-providers/review-context.ts` | **EDIT** `assembleReviewBundle`: replace the `resolveReviewBase`+`collectChangedFiles(base)` block with `resolveDiffTarget(...)` then `collectChangedFiles(diffArgs,includeUntracked)`/`buildDiffSection(diffArgs)`/`buildCommitsSection(logRange)`; header pushes `scopeNote`; meta returns `mode`,`scopeNote`,`projectRoot`. | `run-p9-tests.sh` green; Group B/G green |
| 2.6 | `test-fixtures/test-review-context.mjs` | **EDIT** add Groups B(header note, sink), G(range no `ls-files`, sink). Verbatim; `G3` asserts `sink.every(c=>c.args[0]!=='ls-files')`. | `node …` green; `B8` asserts exactly one note line |

### `P11-3` — flags + plumbing + directive (REQ-8/9/10/11/14)

| Step | File | Exact action | Verify |
|---|---|---|---|
| 3.1 | `lib/run-resolver.ts` | **EDIT** `parseLeadingRunFlags` add param `opts:{allowTargetFlags:boolean}`; inside the while-loop accept `--base`/`--range` only when `allowTargetFlags`; validate (no repeat, value present, not `--`-prefixed); return `reviewTarget?`. | `node test-fixtures/test-run-resolver-target.mjs` Group D green |
| 3.2 | `lib/run-resolver.ts` | **EDIT** `parseRunArgs` call site → `parseLeadingRunFlags(tokens,1,{allowTargetFlags:true})`; thread `reviewTarget`; update `RUN_USAGE`. | Group D/E green |
| 3.3 | `lib/run-resolver.ts` | **EDIT** `parseDoArgs` call site → `parseLeadingRunFlags(tokens,0,{allowTargetFlags:false})`. | `D8-do-rejects-flags` green |
| 3.4 | `lib/run-resolver.ts` | **EDIT** thread `reviewTarget` through `dispatchChildRun → executeChildRun → executeChildRunResult` as a single trailing options object; pass into `prepareAgentTask(agent,task,{cwd,reviewTarget})`. Gate call in `index.ts` untouched. | `F1`,`F5` green; `git diff index.ts` empty |
| 3.5 | `lib/context-providers/prepare-task.ts` | **EDIT** `PrepareTaskOptions` (+`reviewTarget?`); forward into `assemble(providers,{cwd:opts.cwd,reviewTarget:opts.reviewTarget})`; `buildDirective` uses `meta.mode`/`meta.scopeNote`. | `F3` directive-wording green; `test-prepare-task.mjs` green |
| 3.6 | `test-fixtures/test-run-resolver-target.mjs` | **CREATE** full verbatim Groups D/E/F (sink/seam-asserted; `F2` byte-compares the 5 non-target callers' `assemble` deps; `F5` asserts gate dispatch arity). | `node …` prints total; broken-input run exits non-zero |
| 3.7 | `test-fixtures/run-p11-tests.sh` | **CREATE** runs `test-review-context.mjs`, `test-prepare-task.mjs`, `test-run-resolver-target.mjs`, plus `run-p9-tests.sh`. | `bash test-fixtures/run-p11-tests.sh` exits 0 |

### `P11-4` — runbooks + reviewer wording (docs)

| Step | File | Exact action | Verify |
|---|---|---|---|
| 4.1 | `lib/prompts/reviewer.md` | **EDIT** add: "Review the scope stated in the bundle header (committed branch/range), not your own working tree." | `grep -n "scope stated in the bundle header" lib/prompts/reviewer.md` |
| 4.2 | `.pi/runbooks/code-review-agent.md` | **EDIT** add a "pass `--base`/`--range` to target the committed branch" note. | manual |
| 4.3 | `.pi/runbooks/adversarial-code-review-agent.md` | **EDIT** same note. | manual |

### Definition of done (whole plan)

`bash test-fixtures/run-p11-tests.sh` prints all suites passing, `git grep -n 'split("..")' lib/`
is empty, and a sink dump across Group C contains no `-O`/`--output`/`--upload-pack`/`@{` token in
any `git` argv.
</content>
</invoke>
