# context-manager/eval — golden corpus + L2 eval runner

See `.plans/CTXEVAL/eval-plan.md` (L2 spec, adopted floors, A1–D architect
amendments). This directory is the anchor corpus for measuring judgment
quality of the relevance and drift decisions in `../index.ts`.

## Files

- `corpus.jsonl` — one JSON object per line, two kinds:
  - `kind:"relevance"` — fields `id`, `candidate{path,excerpt}`,
    `existing[{path,excerpt}]`, `tasks[]`, `expected`
    (`duplicate|relevant|unrelated`), `rationale`, optional `tier:"hard"`
    (see Findings below).
  - `kind:"drift"` — fields `id`, `pinnedPrompt`, `firstUser` (pin turn),
    `nextUser` (probe turn), optional `nextPrompt` + `taskListChanged:true`
    for cascade-sanity rows, `expected` (`true` = drift/stage), `rationale`.
- `run.test.ts` — the L2 runner (node:test), skipped unless `JEV_EVALS=1`.
- `scores/latest.json` — written by each run; committed as the regression
  summary (everything else in `scores/` is gitignored).

## Running

```sh
# hermetic heuristic-pass only (no network, no key needed):
JEV_EVALS=1 node --test eval/run.test.ts

# full: heuristic pass + live Jev pass (uses JEV_API_KEY or the
# ~/.pi/agent/models.json litellm key — the extension's own resolution order):
JEV_EVALS=1 JEV_API_KEY=... node --test eval/run.test.ts
```

The default suite (`node --test test/*.test.ts`) never runs the runner.

## What is measured

- **Relevance** rows replay through the production decision function
  (`__eval.ingestRelevance`). Two passes: degraded (dead endpoint ⇒
  token-overlap heuristic) and live (real System One endpoint). Metrics:
  aggregate accuracy (over `tasks:[]`-capable rows only — see A3 below),
  per-class precision/recall, majority-class baseline margin (floors must
  beat majority by ≥0.10).
- **Drift** rows replay the *production cascade* through the wiring harness
  (session_start → pin turn → probe turn → `taskSwitch` telemetry row), not
  isolated `jevDriftCall` calls (amendment A2). `taskListChanged:true` rows
  must stage with source `task-diff` in both passes (cascade sanity).

## Adopted floors (plan v2, amendment B)

| Judge | Metric | Floor |
|---|---|---|
| heuristic (relevance) | aggregate | ≥ 0.60 |
| heuristic (relevance) | relevant-recall | ≥ 0.70 |
| heuristic (relevance) | duplicate-recall | ≥ 0.50 |
| heuristic (relevance) | unrelated-precision | ≥ 0.60 |
| Jev (relevance) | aggregate | ≥ 0.75 |
| Jev (relevance) | relevant-recall | ≥ 0.85 |
| Jev (drift) | precision / recall | ≥ 0.75 / ≥ 0.65 |
| heuristic (drift) | precision / recall | ≥ 0.50 / ≥ 0.50 |

Drift floors are precision-led (amendment B: false drift compounds via
rescore churn; missed drift self-corrects next turn).

## Grading policy (anchor status)

Labels are **construction-derived**: duplicates are verbatim/near-verbatim
repeats, relevant rows add information provably absent from `existing`,
unrelated rows are disjoint-domain content, stay-probes keep ≥0.15 lexical
overlap with the pin vocabulary while drift-probes have ~0 — so the expected
label follows from construction for both the heuristic and the semantic
judge. Every row carries a `rationale`. **Operator human review completed
2026-09-23 — the A1 gate is satisfied and this anchor is ratified.** Any
automated (Jev-proposed) labeling of future rows must reproduce this anchor
at ≥90% agreement before its labels count.

## Findings from the first live baseline (2026-09-23)

The first full run (degraded + live) found a real production defect and one
judge limitation:

1. **Inventory starvation bug (FIXED).** `ingestRelevance` sliced each
   `existingInventory` excerpt to 120 chars (candidate gets 2000), so the
   judge could not see enough existing text to recognize duplication:
   byte-identical spans scored `new_info≈0.63` (⇒ verdict `relevant`) at
   slice=120 but `new_info≈0.03` (⇒ correct `duplicate`) at slice=600.
   Fixed in `../index.ts` (both the ingest call and the M4 rescore batch,
   same mechanism) — slice raised 120 → 600.
2. **Indirect-relevance is judge-hard (OPEN, quantified).** Two genuinely on-task rows
   score `on_task<0.35` live: progress metrics after a fix (rel-rel-004)
   and a CVE in a dependency of the component under repair (rel-rel-007).
   They are labeled `tier:"hard"`: still run and reported in scores
   (`hardTier` diagnostic), excluded from anchor floors per the plan rule
   that hard cases stay out of the anchor.
   Calibration study (2026-09-23, ~34 probes): robust across 4 phrasings,
   topic enrichment, and operational reframing — hard rows 0.10–0.24 vs
   guards relevant ≥0.86 / unrelated ≤0.03. The on_task instruction was
   upgraded to the best variant (V1, includes progress/verification/
   dependencies/constraints); the 0.35 threshold was deliberately NOT
   moved: a threshold in (0.03, 0.20] would reclassify the hard rows but
   also weaken M2 elision — an operator decision with M2 impact in view.

## A3 edge rows

Rows with `tasks:[]` (`rel-unrel-006`, `rel-unrel-007`) exercise the known
incapability that the degraded heuristic cannot emit `unrelated` without a
task list (`index.ts`, degraded branch: `tasks.length > 0 && p < 0.15`).
They are excluded from the heuristic's unrelated-recall and from aggregate
accuracy, and reported as diagnostics; the live Jev pass scores them
normally.

## Extending the corpus

Append rows with a `rationale`; keep classes balanced (floors assume a
balanced corpus — composition changes silently change what floors mean,
amendment A3). Hard cases (low-overlap stays, paraphrase dups, boundary
relevance) belong in later additions, not the anchor: anchor rows must stay
label-unambiguous.
