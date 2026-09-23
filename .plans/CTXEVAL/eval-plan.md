# context-manager eval plan — draft v1 (2026-02-14)

status: DRAFT v2 — architect-reviewed (GLM-5.3), findings incorporated below
scope: `context-manager/` (spec@6540546f, phase2@48c998a7, phase3@56e0c00a)

## Goal

Answer "how do we know the context-manager works?" beyond the existing
deterministic wiring tests, using evals — with Jev (TypeSafe System One)
powering both the labeling and the judging.

## Current state (verified 2026-02-14)

- `node --test test/*.test.ts` → **45/45 pass in ~1.6s**.
- Existing tests are a mock-API wiring harness (mockPi/mockCtx, dead
  `JEV_ENDPOINT=http://127.0.0.1:9` ⇒ deterministic degraded mode). They cover:
  - Phase 1: observe-only subscription, fingerprint/dup/stale, classification,
    malformed config, degraded relevance verdicts, status-line, /ctx:health.
  - Phase 2 M1: drift staging, ONE-Jev-fetch-per-turn, task-list diff,
    strict > threshold, degraded sources. M2: elision tiers, B1 read guard,
    error guard, side-car fail-open. M3: purity budget queued/hard flush,
    XOR shaping, cooldown, config deep-merge, ledger reset. M4: rescore batch.
  - Phase 3: frozen burst plans, adjacency, side-car, forced-prompt bypass,
    config fallback, disabled flag.

### Gaps (what wiring tests structurally cannot tell us)

1. **Judgment quality is unmeasured.** `ingestRelevance` (Jev noul pair,
   thresholds 0.35/0.35) and the degraded `overlapScore` (0.7 dup / 0.15
   unrelated) have no labeled-corpus accuracy numbers. Same for
   `jevDriftCall` (p > 0.65).
2. **Semantic safety of shaping is unmeasured.** Wiring tests assert shape
   mechanics (stub counts, adjacency, plan freezing) but not "the shaped view
   still contains what the model needs for the pinned task."
3. **No real-pi e2e** (mock harness ≠ real ExtensionAPI contract).
4. **No long-session soak** (net effect: does the suite actually reduce
   dirty-prefix cost / improve cache hits without harming task progress?).

## Eval design (4 layers)

### L1 — keep: deterministic wiring tests (existing 45)

Fast, free, hermetic. Gate every PR. No change.

### L2 — golden-corpus accuracy evals (new, gated)

`context-manager/eval/corpus.jsonl` (versioned fixtures), two sets:

- **relevance set**: `{candidate excerpt, existingInventory[], tasks[],
  expected: duplicate|relevant|unrelated}` (~60–100 rows)
- **drift set**: `{pinnedTaskModel, newestUserMessage, expected: drift|stay}`
  (~40–60 rows, incl. same-task follow-ups as hard negatives)

Runner `context-manager/eval/run.ts` (node:test file, skipped unless
`JEV_EVALS=1` and a key is present — network + cost):

- replays rows through the real `ingestRelevance` / `jevDriftCall`
- runs BOTH paths: Jev (key present) and degraded heuristic (dead endpoint)
- reports accuracy + per-class precision/recall + Jev-vs-heuristic delta
- asserts **floors**, not exact numbers (e.g. heuristic accuracy ≥ 0.75,
  Jev ≥ 0.85, drift recall ≥ 0.8 @ precision ≥ 0.7) — floors live in the
  eval file, tuned once baseline numbers exist.

**Jev-powered labeling:** bootstrap the corpus with `jev_ask` (the same
System One model the extension calls) proposing labels for candidate rows;
human spot-checks ≥ 20% before rows enter the golden set. Labels are stored,
so CI never re-labels (deterministic replays).

### L3 — Jev-as-judge behavioral evals (new, gated) — "power up the evals"

Properties unit tests can't assert, graded by Jev as an independent judge
(NOT the same prompt as production paths, to avoid self-grading bias where
possible; judge sees only artifacts, not the extension's own noul scores):

- **shaping sufficiency**: for scripted sessions, ask judge
  `noul: the shaped view preserves the information needed for tasks T`
  comparing original vs shaped messages; floor on mean score.
- **stub honesty**: side-car text + stub ⇒ judge confirms no information
  loss beyond the declared stub.
- **drift sanity**: sample of staged drifts ⇒ judge grades stage correctness.

Output: JSON score files under `context-manager/eval/scores/` (gitignored
except a committed summary), tracked run-over-run as regression signal.

### L4 — soak / net-benefit eval (later)

Scripted 100+ turn session in the mock harness (cheap) + one real-pi smoke
session: measure dirty-prefix tokens avoided, cache-hit delta, compact count
vs a shaping-disabled control. Success = net token savings ≥ 0 with no task
failure and purity budget respected.

## Guardrails

- L2/L3 skip silently (with a printed reason) when `JEV_EVALS≠1` or no key —
  CI stays hermetic/free.
- Golden corpus is append-only; changes to it are a spec-level event
  (Amendment), since floors are calibrated against it.
- Jev judge outputs are probabilities — thresholds chosen once, recorded here.

## Architect review (GLM-5.3 via herdr, 2026-02-14) — adopted

Full review in pi session `2026-09-23T05-27-21-...jsonl` (pane w9:p12,
`pi --provider litellm --model glm-5.3-zai`). Spot-checked file:line claims
verified. Adopted changes to this draft:

- **A1 (adopted)**: Jev-labeled corpus is circular without a human anchor.
  L2 labeling now requires a committed ~20-row human-graded anchor set;
  Jev-proposed labels only count after the labeler reproduces the anchor
  (≥90% agreement). Human spot-check ≥20% stays.
- **A2 (adopted)**: drift eval must replay the production cascade
  (task-diff short-circuit → Jev → heuristic → stage-apply-next-turn with
  M4 rescore side-effects), not `jevDriftCall` in isolation; rows where the
  task list also differs never reach Jev in production and are excluded
  from Jev-path accuracy.
- **A3 (adopted)**: floors are per-class regression guards, each required
  to beat the per-run majority-class baseline by ≥0.10; corpus must be
  class-balanced; jev-latest alias pinned per eval run (record model id in
  scores); floors activate only after first human-verified baseline.
- **B (adopted starting floors)**: relevance heuristic aggregate ≥0.60,
  relevant-recall ≥0.70, dup-recall ≥0.50, unrelated-precision ≥0.60;
  Jev aggregate ≥0.75, relevant-recall ≥0.85. Drift Jev precision ≥0.75 /
  recall ≥0.65 (precision-led — false drift compounds via rescore churn,
  missed drift self-corrects next turn); heuristic 0.50/0.50.
- **C (adopted, added L2.5)**: regret/re-read eval — extend the runTurn
  harness so scripted sessions continue past shaping; count re-reads of
  stubbed content / reruns of superseded commands (deterministic, judgeless
  proxy for "shaped view still sufficient"). Also added L1 contract test:
  canned local HTTP server for the live Jev happy path (res.ok parsing,
  noul extraction, timeout) — currently zero coverage.
- **D (adopted)**: L3 judge = same System One family as production decider
  ⇒ correlated-blindness risk. Mitigation: the ~20-case human anchor set
  doubles as judge calibration — every L3 run reproduces it (≥90%) before
  judge scores count.

## Amendments

### 2026-09-23 — first live baseline; inventory fix; hard tier (v3)

- **RECORDED (evidence)**: first full eval run (33 rows, live endpoint).
  Degraded pass: relevance aggregate 1.0, drift P/R 1.0/1.0 (construction-
  consistent anchor). Live pass: drift P/R 1.0/1.0; relevance aggregate
  0.737 < 0.75 floor → investigated before any floor change.
- **MODIFIED (production, evidence-backed)**: `context-manager/index.ts`
  existingInventory excerpt slice 120 → 600 chars in BOTH `ingestRelevance`
  (eval-verified: identical-text dup new_info 0.63@120 → 0.03@600) and the
  M4 rescore batch (same starvation mechanism, same fix). Discovered by L2;
  this is the eval system working as intended.
- **ADDED**: `tier:"hard"` for rel-rel-004 / rel-rel-007 (indirect task
  relevance: progress metrics, dependency CVE). Live judge scores them
  `on_task<0.35` ⇒ `unrelated` even with untruncated inventory (on_task
  0.12 for the CVE row). Still run + reported (`hardTier` diagnostic);
  excluded from anchor floors per the anchor-purity rule. OPEN follow-up:
  improve on_task judgment for indirect relevance.
- **RECORDED (floors now active)**: with the fix + hard tier, anchor live
  floors (aggregate ≥0.75, relevant-recall ≥0.85, drift P≥0.75/R≥0.65) are
  the regression guards from this baseline onward. Composition: relevance
  19 rows (7 dup / 5 relevant / 5 unrelated + 2 A3) + 2 hard; drift 12.

### 2026-09-23 — on_task calibration study (v4)

- **EXPERIMENT (evidence)**: 3 rounds / ~34 live probes on the on_task
  judgment (hard rows rel-rel-004/007 stuck at 0.10–0.24 vs 0.35 threshold):
  4 instruction phrasings (V0–V3), topic state enrichment (taskModel.topic
  at index.ts:515), operational reframe ("agent would need this in
  context"). Guards never degraded (relevant ≥0.86, unrelated ≤0.03).
- **MODIFIED (production, no behavior change)**: on_task noul instruction
  adopted V1 — "…including progress, verification, dependencies, or
  constraints that affect completing them." Strictly better-or-equal on
  every measured row (007: 0.13→0.23; relevant guard 0.75→0.82–0.85).
- **NOT CHANGED (deliberate)**: the 0.35 on_task verdict threshold. A
  threshold in (0.03, 0.20] would reclassify the two hard rows but also
  weakens M2 elision (tiers key off `unrelated` verdicts) — operator
  decision with M2 impact in view, not an eval-pass side effect.
- **OPEN (unchanged)**: indirect task relevance remains judge-hard;
  `tier:"hard"` stays as the standing diagnostic (hardTier in scores).

### 2026-09-23 — A1 anchor ratified (operator)

- **RATIFIED**: operator human review of all 33 corpus labels completed —
  the A1 gate is satisfied. The anchor is no longer a candidate: L2 floors
  are binding regression guards from this point. Any future corpus change
  still requires a plan amendment (composition changes change what floors
  mean, A3).

## Non-goals

- Not benchmarking pi itself; not tuning production thresholds in this pass
  (that follows once L2 baselines exist).
