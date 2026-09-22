---
name: context-manager-phase1
version: 1.0.0
status: draft-for-implementation
author: glm-design-reviewer (lead architect, litellm/glm-5.3-zai)
transcribed-by: primary session, verbatim
verified-by: kimi-k3-architect (research cross-validation, all claims CONFIRMED)
predecessor: .plans/CONTEXT/proposal.md v0.3
---

# CONTEXT Phase-1 spec — Observe + Health Metrics

## 1. Goal
- Build the Observe layer (proposal §Architecture L1) as a passive instrument: fingerprint tool
  results at ingest, classify them, attribute cache miss/waste per turn, emit health metrics.
- Zero mutation of session, context, warmer, or files (only append: telemetry JSONL). Non-goals: §7.

## 2. Mechanisms
### 2.1 Fingerprinting — `tool_execution_end` (+ text spans at `message_end`)
- Read-class tools: from toolCall args capture `path` (+offset/limit); from toolResult TEXT compute
  `contentHash = sha1(resultText)`, `tokenEst = ceil(chars/4)`, `capturedAt = now`. Hash the
  RESULT, never the file — zero extra IO; the text is already in memory in the event payload.
- Assistant text spans fingerprinted identically at `message_end` so shares cover all content.
- mtime is NOT in tool results (OPEN: confirm pi read-result schema). Freshness probe instead:
  `fs.stat(path).mtimeMs > capturedAt` ⇒ stale (edited after read). `stat` is metadata-only —
  never a content re-read. Gated by `probeFreshness` (default true).
### 2.2 Tool-result classification (heuristics, table-driven; no Jev)
- `error`: result.isError || level==="error" || /exit (code )?[1-9]\d*/ || non-empty stderr.
- `dump`: tokenEst ≥ dumpTokens (default 800) and not conclusion.
- `conclusion`: tokenEst ≤ conclusionTokens (default 64), OR last non-error result in a turn that
  also contains a dump (superseded-dump heuristic).
### 2.3 Cache miss/waste attribution — `message_end` (REUSE pi cache-stats)
- Import: `import { detectCacheMiss, computeCacheWaste, collectCacheMisses, CACHE_TTL_MS }
  from "@earendil-works/pi-coding-agent/dist/core/cache-stats.js"`.
  OPEN: package.json `exports` may block deep subpaths — verify first. Fallback A: vendor the
  module + contract-test against the installed d.ts. Fallback B: per-call usage math (§3 CH%
  formula) off the assistant message. `NOISE_FLOOR_TOKENS` is NOT exported in cache-stats.d.ts
  (docs reference only) — treat as internal; do not import. OPEN.
- Call `detectCacheMiss(entries, message, models)` at `message_end` BEFORE persistence — the
  event fires pre-persist, satisfying the d.ts precondition "entries must not yet contain message".
- `ModelPriceSource`: OPEN whether extension API exposes a models/pricing runtime; if not, pass a
  stub returning undefined ⇒ `missedCost = 0` (missedTokens/idleMs still counted).
- Cause: idleMs > CACHE_TTL_MS ⇒ "ttl"; modelChanged ⇒ "model"; else "prefix-break".

## 3. Metrics definitions (at `turn_end`; Σtok = Σ tokenEst over recorded spans S)
- `freshShare  = Σtok(fresh)/Σtok(S)`; fresh = not stale, not dup, not error.
- `staleShare  = Σtok(stale)/Σtok(S)`; stale = mtime > capturedAt.
- `dupShare    = Σtok(dup)/Σtok(S)`; dup = 2nd+ span with an already-seen contentHash.
- `errorShare  = Σtok(error)/Σtok(S)`; `unclassifiedShare = Σtok(unc)/Σtok(S)`; shares sum ≤ 1.
- `unrelatedShare = null` — placeholder; Jev relevance is later phases (no heuristic invented now).
- `cacheWastePerTurn = {missedTokens, missedCost}` from detectCacheMiss; session totals via
  computeCacheWaste. `CH%` = usage.cacheRead/(usage.input+usage.cacheRead+usage.cacheWrite) of
  the last assistant message — per-call, never cumulative (verified research fact).

## 4. Status line + /ctx:health + telemetry
- Status line (turn_end): `ctx f:91 s:2 d:1 e:0 | CH:87` (percent shares; CH%).
- Colors: fresh green ≥90 / yellow 75–89 / red <75; s,d yellow ≥4 / red ≥8; e red ≥5; CH dim.
- `/ctx:health`: table of every share + Σtok(S) + unclassified; waste totals; top-5 stale paths
  (age since read); dup contentHash groups; error runs (consecutive error spans). Per-miss detail
  via `collectCacheMisses(entries, models)`.
- JSONL (one line per turn_end) → `telemetryPath`: `{v:1, ts, sessionId, turn,
  metrics:{freshShare,staleShare,dupShare,errorShare,unclassifiedShare,unrelatedShare:null,
  totalTokens}, cache:{chPct,missedTokens,missedCost,idleMs,modelChanged,cause},
  spans:[{id,path,contentHash,tok,class,fresh}]}`.

## 5. Acceptance criteria
AC-1 Subscribes only to {tool_execution_end, message_end, turn_end, command}; no `context`
    subscription, no message replacement, no cache_warming_decision (assert handler registry).
AC-2 Read tool at tool_execution_end yields {path, contentHash, tokenEst, capturedAt}; zero
    fs.readFile/fs.writeFile calls across the suite (mock-fs assertion).
AC-3 Fixture file touched after capture ⇒ staleShare > 0 at next turn_end.
AC-4 Same result text twice ⇒ dupShare counts only the 2nd copy; 1st stays fresh.
AC-5 Table-driven tests cover error (isError/exit-code/stderr), dump (≥dumpTokens),
    conclusion (≤conclusionTokens; superseded-after-dump).
AC-6 Per message_end: detectCacheMiss (or locked fallback) recorded; idleMs > CACHE_TTL_MS ⇒
    "ttl"; modelChanged ⇒ "model".
AC-7 Recomputed CH% matches pi footer within ±1pp on 3 canned sessions.
AC-8 Status line + /ctx:health render all §3 metrics with §4 thresholds/colors.
AC-9 Exactly one valid JSONL record per turn_end, validating against §4 schema.
AC-10 Import resolution locked by test: primary or Fallback A or B; no silent 4th path.
AC-11 Zero Jev invocations across the full suite (mock client counter stays 0).
AC-12 Absent config ⇒ defaults; malformed config ⇒ warn + defaults; extension stays loaded.

## 6. Config — `.pi/context-manager.json` (per project; merged over defaults)
```json
{
  "enabled": true,
  "probeFreshness": true,
  "classification": { "dumpTokens": 800, "conclusionTokens": 64 },
  "statusLine": { "enabled": true, "warnSharePct": 4, "highSharePct": 8, "lowFreshPct": 75 },
  "telemetryPath": ".pi/context-telemetry.jsonl",
  "keepSpans": 500
}
```

## 9. Amendment v1.1.1 — implementation clarifications (review-driven)

- Fingerprinting applies to ALL non-empty tool results (bash errors/dumps are
  primary poison candidates per §Threat model); `path` is captured when the
  tool provides one. Supersedes the read-class-only reading of §2.1.
- AC-1 event set includes `session_start` (config/session init) and
  `registerCommand("ctx:health")`; "no mutation" is the binding constraint,
  checked by absence of `context`/`cache_warming_decision`/replacement paths.

## 8. Amendment v1.1.0 — Jev ingest-relevance check (operator directive)

New mechanism §2.4, implemented in Phase 1 as an OBSERVE-ONLY verdict layer
(recorded in telemetry/status; no eviction/stubbing until later phases — B1
never-stub rule stands):

### 2.4 Ingest-relevance classification (Jev; degraded heuristic fallback)
- Trigger: read-class spans with tokenEst ≥ relevanceMinTokens (default 2000).
  Small spans skip (budget discipline).
- Jev question (single noul, batched state): "Does this artifact add information
  NOT already present in the current context, given the existing span
  inventory?" plus task-relevance noul. Verdicts: `duplicate` (covered),
  `relevant` (new + on-task), `unrelated` (off-task), scored into shares.
- Against-context comparison: state includes existing span inventory (paths,
  contentHashes, tokenEst, classes) + pinned task subjects (B2).
- **Degraded mode**: Jev failure/timeout → keyword-overlap heuristic vs
  existing span texts; exact-hash dedupe (AC-4) always applies regardless.
  Verdict records source: jev | heuristic-degraded.
- Budget: ≥ relevanceMinTokens only; verdict memoized by contentHash; max one
  call per ingest; 15s timeout; never throws (AC-10 pattern).

New/changed ACs:
- AC-13 spans ≥ relevanceMinTokens get a relevance verdict {duplicate|
  relevant|unrelated} with source jev|heuristic-degraded; verdict memoized by
  contentHash (second identical span → no second Jev call).
- AC-14 Jev unreachable ⇒ verdict source=heuristic-degraded, telemetry records
  degradation, span still counted (no behavior hole).
- AC-15 unrelatedShare is REAL when verdicts exist (share of unrelated tok),
  null only when no verdict-eligible spans; unrelated spans are reported in
  /ctx:health as eviction candidates (observe-only note).
- AC-11 amended: zero Jev invocations applies to spans < relevanceMinTokens
  and to the degraded-mode suite (mock dead endpoint); ingest-relevance tests
  mock the Jev endpoint and assert exactly one call per distinct contentHash.

## 7. Phase-1 non-goals (explicit)
- No mutation: no `context`-event views, no `message_end` {message} replacement (transcript-
  persistent — observe only), no stubbing, eviction, shaping, or compaction hooks.
- No warmer interference: cadence min(ttl×0.9, ttl−10s) untouched; no cache_warming_decision;
  no breakpoint/TTL control.
- No Jev/Score layer: heuristics only; unrelatedShare stays null; no per-span relevance calls.
- No file content re-reads (stat metadata only); no cross-session aggregation; no UI beyond the
  status line and /ctx:health.
