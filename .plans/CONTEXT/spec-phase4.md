---
name: context-manager-phase4
version: 1.0
author: primary session (draft v0.9 from Phase-3 shipped state + live TypeSafe docs via searxng)
status: ready-for-implementation
reviewed-by: glm-5.3-zai (lead architect, 2026-09-22: VERDICT REVISE — 10 findings, all resolved in this revision; "AC-22/B5/AC-34 preserved by design; majors are wiring/semantics text, not shaping-core flaws")
fact-checked-by: kimi-k3 (2026-09-22: C1–C4 VERIFIED with file:line cites; C5 refuted = Basis citation framing, wording fixed pre-review)
adjudicated-by: jev-1.13.0 (2026-09-22: all 10 fixes adopted — f9 0.82, f2 0.79, f7 0.67, f1 0.66, f6 0.66, f3 0.58, f5 0.51, f10 0.48, f8 0.49, f4 0.41 — latter four CARRIED at lower confidence, validated by GLM post-review; readiness 2.17/3 "OK after fixes, minors may surface in post-review", conf 0.77)
basis: spec-phase3.md v1.2 (pin d36bfbf0, 45/45 x3, merged 79fc775); context-manager/index.ts @ 79fc775 (Kimi K3 cites: shapeKind :790–813, writeSideCar :841 raw text, flush trio :1026–1037, turn_end :1218–1221, jev client :263–359); TypeSafe live docs api.md / confidence.md / llm_guardrails.md (fetched 2026-09-22)
---

# CONTEXT Phase-4 spec — Poison-Defense Deepening

version: 1.1 (extends spec-phase3.md v1.2 + PLAN.md locked decisions B1–B6; supersedes v0.9 draft f6e258c0; v1.1 = GLM 5.3 post-implementation review amendments below)

Basis (verified this session): Phase-3 shaping shipped (per-call view, frozen burst plan, dirty-prefix flush cap>ttl>floor>hard, forced-prompt bypass, fail-open). Existing Jev client pattern: raw `fetch` to `JEV_ENDPOINT` (default litellm `…/typesafe/v1/systemone`), model `jev-latest`, batched typed questions in ONE call, ~15s timeout, heuristic-degraded fallback (context-manager/index.ts:263–359, Kimi-verified). Live API contract (docs.typesafe.ai/api.md, fetched 2026-09-22): `POST /v1/systemone {state, model, questions}`; **noul answers carry no confidence**; choice/score answers carry `probabilities` + `confidence`; 429/529 require backoff. (Kimi K3 C5: this Basis cites api.md directly; spec-phase3.md itself carries no API-semantics notes.) Guardrails pattern (cookbook): one call = hazard-noul battery + severity Score; code routes on thresholds with precedence.

## Summary
Four additions to the context-manager, all inside the existing `context`-event shaping pipeline:
- **M7 Poison battery** — async ONE-CALL Jev battery (contradiction nouls + staleness Scores) over shape-eligible spans, evaluated INSIDE `turn_end` BEFORE burst teardown (M1); act verdicts enqueue through the SINGLE authoritative dirty-op path at that boundary; unconsumed review-band metadata is consumed read-only at the NEXT burst's plan freeze (preserves AC-22: zero Jev at plan/apply time). Confidence gates the Score path only; the noul path routes on raw probability under a documented no-confidence policy.
- **M8 Secret redaction** — deterministic (zero Jev) pattern battery applied at `tool_execution_end` CAPTURE time: span text, side-car records, and span shas are all computed on redacted text (ONE consistent identity). View redaction = substituting the already-redacted span text (sha-stable). Jev battery state and telemetry are redacted by construction. toolCall args are redacted in side-car/state only — never in the view (preserves the B1 re-run contract).
- **M9 Error-loop collapse** — deterministic 4th shape class: ≥ `errorLoopMin` identical error toolResults (same toolName + argsKey + normalized error signature) collapse to one stub keeping the newest; the only mechanism ever permitted to shape error spans (amends AC-16 scope, not its M3/M4 exemptions). Intra-turn loops collapse at the NEXT burst open (warm exemption is honest); sent-span ops respect the E6 split via M5.
- **M10 Incident fixtures** — JSONL poison-transcript fixtures under `context-manager/test/incidents/` with expected battery/shape outcomes; wiring tests replay every fixture in mocked-jev and degraded modes (AGENTS.md rule 4: wiring bugs get wiring tests).

Non-goals: no view rewriting of already-sent content beyond the existing M5 queued-op path; no blocking/refusal semantics (this is context hygiene, not moderation of the user); no new pi events; no persistent transcript mutation (raw secrets remain only in pi's own session transcript, which is pi's domain).

## M7 — Poison battery (Jev contradiction/staleness)
- Trigger: `turn_end`, INSIDE the existing handler, ordered after pendingScores settle and BEFORE burst teardown and M5 flush evaluation — so battery ops ride the same boundary and a single flush carries them (XOR rule unchanged). A battery call happens only if the turn HAD an open burst and `st.compacting === false` (AC-1).
- Candidates: spans that pass Phase-3-style pre-eligibility (dump floor, B1 read-tool exemption, warm/current-burst exclusion, not already baseline/applied) AND pass re-ask suppression: a sha with live unconsumed poison metadata, a pending dirty op, or an applied op is NEVER re-candidated. Among eligible, selection biases OLDEST-unverdicted-first (deep-prefix poison is not starved by the newest-8 cap); cap `poison.spansPerCall` (default 8) (AC-23).
- Request: ONE `POST /v1/systemone` call, state = bounded excerpts (`excerptCap` 1200 chars/span, M8-redacted by construction) + the newest same-tool outputs inventory; questions per candidate sha8: `contra_<sha8>` (noul: "does this content contradict any newer retained content or the current task state?") and `stale_<sha8>` (Score 0–3: fresh → aged-but-valid → superseded → wrong). 429/529 → exactly one backoff retry, then degrade; 401/422/timeout degrade immediately. No key / any error ⇒ degraded heuristics (same-tool newer-exists ⇒ contra 0.6; span age ≥ 3× `cacheTtlMin` ⇒ stale 2), `source:"poison-degraded"` (AC-8).
- Routing (code-owned thresholds; scale-clean per AC-5): **ACT** iff `contra ≥ poison.contradictionAct (0.80)` OR (`stale ≥ poison.stalenessAct (2)` AND `scoreConf ≥ 0.5`); **REVIEW** iff (`contra ≥ poison.reviewFloor (0.35)` OR `stale ≥ poison.stalenessReview (1)`) and not ACT; **PASS** otherwise. Confidence applies ONLY to the Score path (api.md: nouls carry none); the noul path routes on raw probability — the no-confidence policy is documented here and in telemetry (`shape.poison.noulPolicy:"raw-probability"`). Degraded signals route identically but are capped at REVIEW (never act) — a heuristic must not delete context on its own (AC-6).
- Single authoritative act path (AC-7): an ACT verdict enqueues the `poison-stub` op IMMEDIATELY at this `turn_end` (full M3 contract: side-car before first application, P1 stub format, M5 queueing for sent spans, E4 validation) and stamps `poison.consumedAt` on the span metadata. Plan freeze consumes only PRE-EXISTING, unconsumed REVIEW/act-eligible metadata read-only. `appliedShas` idempotence guards both paths against double-enqueue (AC-7, AC-23).
- Span metadata: `poison?: {contra: number, stale: number, scoreConf?: number, source: "jev"|"poison-degraded", at: number, consumedAt?: number}` — `scoreConf` present only when a Score answer exists; never on noul-only spans.
- Guards: battery NEVER runs on forced-prompt/ambient turns (`st.compacting || no burst` ⇒ skip); never on read-tool spans (B1); at most ONE battery call per turn; the `context` hot path gains ZERO network I/O (AC-22).

## M8 — Secret redaction (deterministic)
- Battery (ordered, all matches applied per span): OpenAI-style `sk-…`, GitHub `gh[pousr]_…`, AWS `AKIA…`, Slack `xox[baprs]-…`, JWT (three dot-separated base64url segments), PEM private-key blocks, `bearer …`, generic secret-assignment `(api[_-]?key|token|secret|password)\s*[=:]\s*("…"|'…'|[^\s]{20,})` — the generic pattern requires length ≥ 20 or quoting (entropy guard against false-positive code corruption).
- Capture-time redaction (AC-9/AC-12): at `tool_execution_end`, span text is redacted BEFORE hashing — `contentHash`, span metadata, side-car records, and every downstream consumer share ONE identity computed on redacted text. The raw text persists only in pi's own session transcript (out of scope). Redaction is idempotent (already-redacted text never re-matches).
- View redaction = substitute the already-redacted span text into the view (sha-stable, byte-identical to what all bookkeeping saw); toolCall ARGS are redacted ONLY in side-car/state, never in the view (B1 re-run contract intact). Sent-span view redaction beyond capture-time substitution is not performed (subsumed by capture-time); `redactSent` is therefore REMOVED from config (v1.0 change, GLM minor 6 / Jev f6).
- Applied ALWAYS to: side-car `text`/`args` (fixes today's raw write at :841), Jev battery state, telemetry strings — regardless of `poison.enabled` (AC-10/AC-11: secrets must not persist because a feature is off).
- Config: `poison.redaction.patterns?: string[]` (extra user patterns, merged after defaults).

## M9 — Error-loop collapse (deterministic)
- Selection: ≥ `errorLoopMin` (default 3) error toolResult spans sharing toolName + argsKey + normalized error signature (first line, digits→`N`), oldest-first; keeps the newest, replaces each older span's view content with `[error-loop: <toolName> ×N identical failures @turn T; sha=<sha8 newest>; /ctx:restore <sha8>]` — NO "rerun" affordance: an identical signature ×N is persistent, and re-running it invites the loop M9 exists to suppress (AC-15).
- E6 split (AC-13): unsent error spans collapse immediately at plan build; SENT error spans enqueue through M5 like any dirty op (one prefix-dirtying at flush). Warm/current-burst exemption holds: an intra-turn retry loop collapses at the NEXT burst open — the one-burst delay is deliberate and documented (the fixture models the turn boundary).
- Amends AC-16 scope: M3/M4 classes still never select error spans (unchanged); M9 is the sole exception, with its own guards (B1 exempt, warm exempt, appliedShas respected, E4 self-validation, side-car BEFORE first application storing the newest raw-but-redacted error for re-hydration).

## M10 — Incident fixtures
- Location: `context-manager/test/incidents/*.jsonl`; each line = one recorded span `{toolName, args?, text, isError?, capturedAtDelta?}`; fixture header names the scenario (contradiction, stale-dump, secrets, error-loop-4x-across-turn-boundary, mixed-clean).
- Each fixture ships expected outcomes: which shas act/review/pass (M7 thresholds, mocked-jev and degraded variants), which spans redact (M8 kinds), which collapse (M9 count kept, one-burst delay modeled).
- Wiring tests replay fixtures through the real handler (mock-API harness, `wiring.test.ts` pattern).

## Config additions (CMConfig v4)
- `poison: { enabled: true, contradictionAct: 0.80, reviewFloor: 0.35, stalenessAct: 2, stalenessReview: 1, spansPerCall: 8, excerptCap: 1200, redact: true, errorLoopMin: 3 }`
- Sanitization follows AC-43: malformed values warn + default; `poison.enabled=false` disables battery calls and M9 view ops but NEVER side-car/state redaction (AC-10/AC-11).
- Reused unchanged: classification.dumpTokens, elision.readToolNames, elision.sideCarPath, shaping.*, dirtyQueue.*. (v0.9's `redactSent` removed — see Amendments.)

## Telemetry & status additions
- `shape.poison{turn, candidates, acted, review, degraded, inputTokens, noulPolicy:"raw-probability"}` (≤1 per turn)
- `shape.redact{target: "span"|"sidecar"|"state", kinds: {…}}` (aggregate counts)
- `shape.errorloop{collapsed, kept}` (per collapse event)
- `/ctx:health` += `poison {acted, review, degraded}` and `errorLoop {collapsed}`; review-band spans listed (sha8 + signals) for operator inspection.

## Hook map (extends Phase-3)
- `turn_end`: pendingScores → **M7 battery (inside handler, before burst teardown)** → probes → purity → M5 flush XOR M3 compact (battery ops enqueue BEFORE flush evaluation so one flush carries them; XOR rule unchanged).
- `tool_execution_end`: M8 capture-time redaction (before hashing/side-car).
- `context` handler: M9 selection joins `buildPlan` (still frozen per burst, still zero network); M8 view substitution is sha-stable by construction.
- No new events; no changes to M6 bypass semantics.

## Acceptance criteria
- AC-1 (Battery placement): the battery runs only inside `turn_end`, only when the turn had an open burst and `st.compacting === false`, ordered after pendingScores and before burst teardown/M5 evaluation; at most once per turn.
- AC-2 (Candidate filter): candidates pass dump-floor, B1 exemption, warm/current-burst exclusion, not-already-baseline checks; forced-prompt/ambient turns never produce battery calls.
- AC-3 (Single call + bounded state): one turn's battery over ≤ `spansPerCall` candidates is exactly ONE HTTP call with ≤ 2 questions per candidate, excerpts ≤ `excerptCap`, state text redacted by construction.
- AC-4 (Zero-Jev plan/apply preserved): `buildPlan`/`applyPlan` perform zero network I/O; battery results enter the plan only as pre-existing span metadata (Phase-3 AC-22 holds verbatim).
- AC-5 (Routing truth table, scale-clean): ACT iff `contra ≥ contradictionAct` OR (`stale ≥ stalenessAct` AND `scoreConf ≥ 0.5`); REVIEW iff (`contra ≥ reviewFloor` OR `stale ≥ stalenessReview`) and not ACT; PASS otherwise; every row verified by a fixture with both scales exercised.
- AC-6 (Degraded ceiling): `source:"poison-degraded"` routing is capped at REVIEW; degradation visible in `shape.poison.degraded`.
- AC-7 (Single act path + idempotence): ACT enqueues exactly once at turn_end, stamps `poison.consumedAt`; freeze consumes only pre-existing unconsumed metadata; `appliedShas` blocks double-enqueue across both paths; act ops satisfy the full M3 contract (side-car first, AC-19 format, E4, M5 queueing for sent spans).
- AC-8 (Backoff within budget): 429/529 → exactly one backoff retry then degrade; 401/422/timeout degrade immediately.
- AC-9 (Redaction battery): every pattern class matched by a unit fixture; replacements `[REDACTED:<kind>]`; idempotent (no re-match).
- AC-10 (Side-car redaction): side-car `text` and `args` redacted on every write, including B1-exempt and error spans, regardless of `poison.enabled`.
- AC-11 (State redaction, independent audit): battery state and telemetry contain zero matches under an INDEPENDENT auditor pattern set (not the redaction battery itself).
- AC-12 (Capture-time identity): span shas, side-car records, and view substitutions are all computed from the same redacted text; raw text never reaches span metadata, side-car, battery state, or telemetry; args never redacted in view.
- AC-13 (Error-loop selection + E6 split): M9 fires only on ≥ `errorLoopMin` same-toolName + same-argsKey + same-signature error spans; keeps newest; unsent spans collapse at plan build, sent spans enqueue via M5; intra-turn loops collapse at next burst open (fixture models the boundary).
- AC-14 (M3/M4 error exemption intact): stale-dedupe, superseded-collapse, task-evict never select error spans.
- AC-15 (Error-loop stub format): stub matches `[error-loop: <toolName> ×N identical failures @turn T; sha=<sha8 newest>; /ctx:restore <sha8>]` — no rerun affordance; idempotent under AC-35 prefix skipping.
- AC-16 (Re-hydration): error-loop side-car record stores the newest redacted error text; `/ctx:restore <sha8>` returns it.
- AC-17 (Fixtures replay): every incident fixture replays through the real handler in mocked-jev and degraded modes with expected act/review/pass + shape ops asserted.
- AC-18 (Mixed-clean false-positive guard): the mixed-clean fixture produces zero ACT decisions and zero M9 collapses.
- AC-19 (Config v4): absent `poison` config yields documented defaults; malformed values warn + default; `poison.enabled=false` skips battery + M9 view ops; side-car/state redaction still runs (AC-10/AC-11 hold).
- AC-20 (Telemetry): `shape.poison` ≤1/turn incl. `noulPolicy`; `shape.redact` aggregates by target; `shape.errorloop` per collapse; all visible in `/ctx:health` with review-band listing.
- AC-21 (Fail-open): any M7/M8/M9 throw self-caught inside existing handler guards; no partial state; extension never blocks a call (Phase-3 AC-34 parity).
- AC-22 (Latency bound): the battery path makes at most TWO HTTP calls per turn (initial + one backoff retry), total wall-clock ≤ 35s; the `context` hot path gains zero network I/O.
- AC-23 (Re-ask suppression): shas with live unconsumed poison metadata, pending dirty ops, or applied ops are never re-candidated; selection biases oldest-unverdicted-first within the `spansPerCall` cap.
- AC-24 (Score-confidence gate): the `stale ≥ stalenessAct` ACT arm requires `scoreConf ≥ 0.5`; noul-only spans carry no confidence field and route on raw probability; `noulPolicy` recorded in telemetry.

## Design decisions (resolved)
- D1: act truth table — OR-shape with review-floor interlock; scale-clean bands per AC-5 (GLM conditional approval satisfied by stalenessReview).
- D2: M9 as sole error-shaping class (GLM approved: keeps AC-16 perimeter auditable).
- D3: side-car redact-always (GLM approved; `/ctx:restore` returns redacted text — documented).
- D4: 8×2 one-call battery (GLM approved contingent on re-ask suppression → AC-23).
- D5: `redactSent` REMOVED in v1.0 — capture-time redaction subsumes it (GLM minor 6, Jev f6 0.66).
- D6 (new, GLM major 1): battery ordering — inside turn_end, after pendingScores, before burst teardown; AC-1 restated (Jev f1 0.66).
- D7 (new, GLM major 2): single authoritative act path with `consumedAt` + `appliedShas` idempotence (Jev f2 0.79 — strongest adopted fix).

## Amendments
- **2026-09-22 v1.1 (GLM 5.3 post-implementation review — 2 slices, both REVISE; all findings fixed, 63/63 ×3 post-fix):**
  (M8/AC-12 REFINED — two pinned identities) contentHash stays sha1(RAW transcript text) for index/sentPrefix bookkeeping; a NEW restoreHash = sha1(REDACTED text) is what stubs advertise and side-car records key on — secret-derived hashes no longer appear in user-visible artifacts. (M8/CONFIG) `poison.redact` REMOVED — capture redaction + view substitution are unconditional (a `redact:false` toggle let raw secrets ship to the model; GLM S2-2 HIGH). (M8/AC-9 REFINED) assignment pattern preserves the `key=` prefix in the view and accepts quoted values of any length. (M8/S2-7) tool_execution_end capture wrapped fail-open; custom user patterns scan a bounded 64 KB head. (M9/AC-13 REFINED) groups are occurrence-aware (hashCount — identical errors share ONE sha) and split by sentPrefix membership: unsent members apply this burst, sent members queue one op via M5; side-car written per member (skipping enqueueOp's duplicate). (M9/S2-4) hashCount prune keeps the newer half instead of clear() (a loop straddling a clear could never reach errorLoopMin). (M9/S2-6) error signatures derive from textRedacted. (M7/S1-1) battery excerpts + newest-outputs are redacted at SEND time (defense-in-depth for legacy spans). (M7/S1-2) effect-time revalidation after the await: compacting/evicted candidates are dropped before stamping/enqueueing. (M7/S1-6) newest-outputs inventory is tool-filtered per candidates. (M7/S1-7) partial-malformed answers degrade only the malformed candidates — valid jev verdicts survive. (M7/S1-8) `noulPolicy: "raw-probability"` recorded in the turn record. GLM verified clean: AC-2/AC-3/AC-5/AC-6/AC-23/AC-24 routing + candidate logic, AC-14/AC-15 exemptions + stub format. 4 CARRIED spec fixes (f4/f5/f8/f10) validated: AC-22 restatement, AC-23 suppression, stalenessReview band, AC-11 independent auditor — all present and wired.
- **2026-09-22 v1.0 (dual-architect + Jev adjudication from v0.9 f6e258c0):** applied all 10 GLM findings as fixes — (1) battery inside turn_end before burst teardown, AC-1 restated (f1 0.66); (2) single authoritative act path + consumedAt + appliedShas idempotence, AC-7 rewritten (f2 0.79); (3) confidence gates Score path only, noul raw-probability policy documented, `conf`→`scoreConf`, AC-24 added (f3 0.58); (4) AC-22 restated ≤2 calls/≤35s (f4 0.41 CARRIED — post-review validates); (5) re-ask suppression + oldest-bias, AC-23 added (f5 0.51 CARRIED); (6) M8 moved to capture-time redaction w/ one sha identity, generic pattern tightened (len ≥ 20 or quoted), view redaction text-only args-never, `redactSent` removed, AC-12 rewritten (f6 0.66); (7) M9 one-burst delay documented + E6 split in AC-13 + fixture models turn boundary (f7 0.67); (8) `stalenessReview: 1` band added, truth table scale-clean (f8 0.49 CARRIED); (9) M9 stub drops "rerun" affordance (f9 0.82); (10) AC-11 verified by independent auditor pattern set (f10 0.48 CARRIED). Provenance: GLM run via `pi --model glm-5.3-zai --no-tools --no-session` (resolution verified via `--mode json` probe `"model":"glm-5.3-zai"`); Kimi K3 via `pi --model kimi-k3` (`"model":"kimi-k3"` in JSON stream). Frontmatter version of spec-phase3.md still reads 1.0 while its header/Amendments are v1.2 — reconcile in the docs pass (cosmetic, pinned content unaffected).
