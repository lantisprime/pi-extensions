# CONTEXT manager — PLAN & STATUS

Single source of truth for where the CONTEXT manager stands. Update this file
at every milestone. Related: `proposal.md` (vision v0.3), `spec.md` (Phase-1
spec v1.1.1, pin 02634d37), `../COMPACT/` (predecessor + retro).

## Status: Phase 1 SHIPPED · Phase 2 SHIPPED · Phase 3 SHIPPED (spec 48c998a7; M1–M4 implemented 2026-09-22, 28/28 wire tests, GLM-5.3 integration review fixed + approved)

| Phase | Scope | Status | Artifacts |
|---|---|---|---|
| 1. Observe + health/purity metrics | fingerprinting, classification, cache-miss attribution (reuses pi `cache-stats.js`), Jev ingest-relevance (v1.1.0) w/ degraded mode, status line, `/ctx:health`, JSONL telemetry | **SHIPPED** 2026-09-22 — installed via `~/.pi/agent/extensions/context-manager`; 5/5 wire tests, tsc clean, E2E verified; GLM review FAIL→all 5 findings fixed (CH% computed+displayed, exit-code/stderr rows, superseded-dump, Map eviction, non-blocking scoring) | `context-manager/` (index.ts, test/wiring.test.ts), `spec.md` |
| 2. Ingest gate + stubbing + task-switch re-scoring | stub unrequested dump-class bulk under pressure (NEVER model-initiated reads — B1); task-switch re-scoring per pinned task model (B2); purity budget with hybrid two-threshold precedence (B4) | **SPEC'D** — `spec-phase2.md` (pin 48c998a7): M1 task-switch (deterministic diff → 1 Jev call → degraded; staged next-turn apply), M2 dump elision at message_end pre-inclusion (cache-free; read-tool+errors never; side-car archive fail-open), M3 purity budget soft/hard via ctx.compact, M4 batched re-score ≤30. AC-1..AC-12 | implemented 2026-09-22 — 28/28 wire tests, GLM-5.3 integration review fixed + approved (`context-manager/index.ts`) (`context-manager/index.ts`)
| 3. Shape via `context` event | stale-dedupe, superseded-output collapse, task-switch eviction; dirty-prefix batching; frozen-per-burst shaping (B5); toolCall/result adjacency preserved | **SHIPPED** (implemented + reviewed 2026-09-22) — `spec-phase3.md` (pin 56e0c00a): M1 burst lifecycle, M2 frozen plan (unsent-vs-dirty split), M3 stale-dedupe+superseded collapse, M4 task-switch eviction (P1-stub default), M5 dirty-prefix batching (trigger trio ttl/floor/hard + cap; XOR M3 per turn), M6 forced-prompt+ambient bypass; AC-1..44 | dual-architect spec'd 2026-09-22 — GLM 5.3 spec ×2 runs + Kimi K3 pi-fact check 5/5 + Jev adjudication; implemented 45/45 tests (14 new), GLM post-review 6 findings all fixed, Kimi 4/4 invariants; spec v1.2 pin d36bfbf0 |
| 4. Poison defense deepening | Jev contradiction/staleness scoring, secret redaction, error-loop collapse, incident fixtures | not started | — |

## Locked decisions (do not re-litigate without new evidence)

- **B1** (Jev 0.92): never stub model-initiated reads.
- **B2** (Jev 0.85): task model pinned per user turn + session task list.
- **B3** (GLM): cache orchestrator is ADVISORY — pi's `cache_warming_decision`
  is veto-only; no warm triggering, no breakpoint/TTL control.
- **B4** (my judgment; Jev split 0.41/0.37): hybrid burst precedence — soft
  purity excess queues; hard excess (≥2× budget) forces mid-burst flush.
- **B5** (Jev 0.89): shaping frozen per burst; adjacency always preserved.
- Jev availability is REAL-TIME (the call is the check; status file is
  write-through only) — implemented in `jev/index.ts` 2026-09-22.

## Verified pi facts (dual-architect: GLM 5.3 + Kimi K3)

- Footer `CH%` = LAST assistant message `cacheRead/(input+cacheRead+cacheWrite)` (footer.js:84-88,125-126) — per-call, not cumulative.
- `context` event: structuredClone per call (runner.js:832), returned messages affect that call only.
- `message_end` `{message}` replacement is PERSISTENT (agent-session.js:476-489, 409-423) — Phase 1 never uses it.
- Warmer: refresh min(ttl×0.9, ttl−10s) re-sending last request (maxTokens:1); `cache_warming_decision` veto `{action:"warm"|"stop"}`; modes off/streaming/idle, global-only, default streaming.
- `cache-stats.js` exists (deep import): detectCacheMiss/computeCacheWaste/collectCacheMisses; root package does NOT re-export → deep specifier fails at runtime → context-manager uses LOCKED usage-fallback (AC-10, `cacheSource` in telemetry).

## Open questions (carry into Phase 2 spec)

- Q4 resolved: CH% is per-last-call; recommend $-saved ledger as companion KPI.
- Q5: task-switch detection reliability → Phase 2 spec must define detection
  (new session-tasks vs topic drift) + cost of wrong switches.
- Q6: stub re-hydration contract → Phase 2 spec (only dump-class stubs, B1).

## Review loop (institutionalized)

GLM 5.3 = lead architect/reviewer · Kimi K3 = cross-validator · both models
verified in run output before accepting output. Review-after-implement is
mandatory; review-found wiring bugs get harness regression tests
(`*/test/wiring.test.ts` pattern). See `../COMPACT/RETRO.md` + AGENTS.md.
