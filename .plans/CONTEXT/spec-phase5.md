# spec-phase5 — Kev judge backend (self-hosted System One via LiteLLM passthrough)

pin: TBD-after-write · supersedes: none (Phase 4 M7–M10 unchanged) · related: `spec-phase2.md` M1/M4, `spec-phase4.md` M7, `../CTXEVAL/eval-plan.md`

## Summary

TypeSafe Jev died 2026-10-14 (HTTP 402: org out of API credits — billing, not
deprecation). All judgment consumers silently degraded to word-overlap
heuristics (fail-safe held). The replacement backend is **Kev**
(github.com/jaredpalmer/kev, Apache-2.0, Qwen-based System One recreation),
self-hosted on the homelab behind a LiteLLM **passthrough route**:

    POST https://litellm.lab.znp.pw/kev/v1/systemone
    Authorization: Bearer <litellm virtual key>   (pi-mini / pi-macbu / kev-operator)
    body: { state, questions }                    — `model` field OPTIONAL (tolerated+echoed)

API-compatible with Jev: `answers.<id>.{noul|choice|score, confidence,
probabilities, legend}`, `usage`, plus `latency_ms`. Two sibling routes
(`/permute`, `/separate`) are NOT proxied by LiteLLM — out of scope.

EmbeddingGemma-2 (local ollama, verified working @768d) is **deferred**: a
similarity judge was the plan until the kev route existed; it remains the
fallback option if kev cannot clear floors at any threshold (see D3).

## Evidence (2026-10-14, kev smoke + live corpus eval)

- Smoke (exact recipe): choice `auth` p=1.0, score 0.597, 256 ms.
- Smoke (+`model:"jev-latest"` in body): 200 OK — passthrough tolerates and
  echoes the field; no code change needed for existing bodies.
- Smoke (CM drift phrasing, true-drift row): noul 0.9999, 294 ms.
- Live eval vs corpus.jsonl (21 relevance + 12 drift rows):
  - relevance aggregate **0.706** on tasks-capable rows (all-rows 0.762),
    relevantRecall 1.0, hardTier 2/2 → misses are duplicate/unrelated
    precision-side. Jev floor 0.75 → FAIL by 0.044.
  - drift precision **0.625**, recall **1.0** → over-sensitive; Jev floor
    P 0.75 → FAIL; R 0.65 → PASS.
  - Heuristic pass on same corpus: 1.0 / 1.0-1.0 (tiny corpus, keyword-separable;
    treat as strong baseline, not as truth).
- Serving checkpoint is scheduled for replacement ("6-bit" retrain, same URL,
  same format) — quality numbers are per-checkpoint and MUST be re-validated
  after any swap (M14).

## Modules

- **M11 Kev route as default judge endpoint.** `JEV_ENDPOINT_DEFAULT` →
  kev passthrough in `jev/` extension, `context-manager`, and
  `smart-compaction/lib/gate.ts`. Resolution order unchanged (env → default;
  key: env `JEV_API_KEY` → models.json litellm key). TypeSafe stays reachable
  by env override only. Internal source labels stay `"jev"` (schema stability
  across consumers incl. `agents/` child-args + status files); telemetry gains
  one `judgeBackend` field per turn record. Availability probe (status file,
  TTL, fail-safe direction) unchanged — it probes whatever endpoint resolves.

- **M12 Per-site backend routing.** New config `judge` (deep-merged like
  `poison`): `backends: { relevance, drift, rescore, poison } ∈
  {"kev"|"heuristic"}`. Defaults are set by the corpus verdict at tuned
  thresholds (M13) — heuristic wins a site only if tuned-kev does not strictly
  beat it there. Degraded path per site is ALWAYS the existing heuristic
  (unchanged code); `"kev"` merely attempts the call first. This decouples
  "kev owns poison" (no heuristic competitor) from "kev vs heuristic" on the
  three similarity sites.

- **M13 Eval extension: raw capture + threshold sweep.**
  1. Live pass logs per-row RAW probabilities to `scores/raw-live.jsonl`
     (relevance: `new_info`, `on_task`; drift: `p`; poison rows n/a — corpus has
     none) so thresholds can be re-swept offline after a model swap without
     re-billing/ re-calling.
  2. `JEV_SWEEP=1` mode: replays raw values across relevance cutoffs 0.25–0.45
     (step 0.05) and drift cutoffs 0.50–0.90 (step 0.05); reports precision-led
     ranking (drift floors are precision-led, eval-plan amendment B).
  3. Tuned thresholds become config defaults ONLY via a committed
     `scores/latest.json` run that passes floors at those values; sweep output
     is marked tuning-upper-bound (in-corpus optimization caveat).
  4. Guardrail: a site whose kev path cannot satisfy floors at ANY swept
     threshold defaults to `"heuristic"` for that site (never ship a knowingly
     failing backend).

- **M14 Ops: model-swap re-validation.** Procedure documented in
  eval/README: after any homelab kev checkpoint change, run
  `JEV_EVALS=1 JEV_ENDPOINT=<kev> node --test eval/run.test.ts`, compare
  floors, re-sweep (`JEV_SWEEP=1`), adjust `judge` config or flip sites to
  heuristic if floors fail. `scores/latest.json` keeps `endpoint` +
  `generatedAt` as the provenance stamp.

## Acceptance criteria

- AC-1: default endpoint is the kev passthrough in all three consumers; env
  override + key resolution byte-identical to pre-change behavior; TypeSafe
  reachable only via explicit `JEV_ENDPOINT`.
- AC-2: 401/422/402/timeout on the kev route degrade through the existing
  paths — no new throw sites; existing wiring tests pass with the kev URL
  mocked (contract test updated to pin passthrough semantics incl. tolerated
  `model` field).
- AC-3: `judge.backends` config deep-merges; malformed values warn + default;
  defaults documented in README with the corpus numbers that chose them.
- AC-4: internal source labels and status-file schema unchanged (`"jev"`);
  turn telemetry adds `judgeBackend` (≤1/turn); `/ctx:health` renders it.
- AC-5: eval live pass writes `scores/raw-live.jsonl` (one line per judged
  row, raw floats); sweep mode runs offline from that file with zero network.
- AC-6: floors asserted against the committed threshold set; a failing site
  cannot be configured as `"kev"` default without an accompanying passing
  scores run (guardrail test).
- AC-7: poison battery defaults to kev; Phase-4 AC-1..24 behavior preserved
  (routing table, degraded ceiling, redaction, re-ask suppression).
- AC-8: kev-unreachable behavior is byte-parity with today's degraded mode
  (pinned by replaying the degraded suite against the new default endpoint
  with network mocked down).
- AC-9: docs updated: extension READMEs, eval README (swap procedure), this
  file's Amendments for the 6-bit re-validation result.

## Design decisions

- D1: passthrough, not LiteLLM provider model — System One is not a chat
  shape; `/kev/v1/systemone` passthrough keeps the exact contract (user
  direction 2026-10-14).
- D2: keep the `jev` name/labels everywhere — renames churn `agents/`
  child-args, status files, telemetry consumers, and the jev extension's tool
  surface for zero functional gain; Kev is documented as the engine beneath.
- D3: EmbeddingGemma deferred, not dead — ollama + embeddinggemma-2 verified
  locally (768d, related 0.700 vs unrelated 0.543 cosine separation); revive
  as per-site similarity backend only if kev fails M13's guardrail.
- D4: thresholds are model-calibration-relative — hence raw capture + sweep
  + guardrail instead of hand-tuned constants; the 6-bit swap is the first
  consumer of this loop.
- D5: per-site backends over global cutover — the corpus says heuristic
  currently wins similarity sites and kev uniquely enables poison; forcing
  one backend for all four sites loses either quality or capability.

## Amendments

- **2026-10-14 v1.1 (M13 sweep executed — kev checkpoint@pre-6-bit CANNOT serve the similarity sites; M12 defaults adopted):**
  Live capture (scores/raw-live.jsonl, 21 relevance + drift rows) + offline sweep (scores/sweep.json):
  relevance metrics are IDENTICAL at every cutoff 0.25–0.45 (aggregate 0.706, relRec 1.000, dupRec 0.857, unrelPrec 1.000) — kev's nouls are SATURATED (near-0/1), so threshold placement is inert; the misses (kev over-calling duplicate on relevant rows; one saturated wrong dup answer) are unfixable by tuning. Drift: P 0.625 flat through 0.80, 0.714 at 0.85–0.90 (false-positive drift rows sit at p≈0.99), R 1.000 — never reaches the 0.75 floor. Guardrail AC-6 fired for both sites ⇒ DEFAULTS.judge.backends = {relevance: heuristic, drift: heuristic, rescore: heuristic, poison: kev} (heuristic scores 1.0/1.0 on this corpus; poison has no heuristic competitor). IMPLEMENTED: M12 config (deep-merge + sanitizeJudge + applyJudgeEnvHatch CM_JUDGE_BACKENDS test hatch), four site gates (ingestRelevance cfg param, handleUserTurn drift, rescoreAgainstModel, poisonBattery), telemetry judge.backends (AC-4) + /ctx:health judge line; __eval gains fetchIngestNouls/pinnedModelFromPrompt/parseTaskRows/DEFAULTS. AMENDED M13.3: live floor assertions are coupled to the SHIPPED default (floors guard what ships — sites defaulting heuristic record live kev metrics diagnostic-only with floorsNotAsserted); flip a site to kev only alongside a passing committed run. Phase2 wiring suites opt into kev via CM_JUDGE_BACKENDS (6 files); new wiring-phase5-judge.test.ts (6/6). 82/82 suite green. PENDING: M14 re-validation after the announced 6-bit checkpoint swap (same URL) — rerun live + sweep; flip sites only on passing floors.
