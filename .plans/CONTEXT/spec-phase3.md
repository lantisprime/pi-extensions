---
name: context-manager-phase3
version: 1.0
author: glm-design-reviewer (lead architect; run 1 via litellm/glm-5.3-zai — note: run 2 self-reported glm-4.6 (Z.ai) under the same alias; provenance flagged)
status: draft-for-implementation
transcribed-by: primary session (M1–M6, config, hook map from GLM run 1; AC-1..44 from GLM run 2, vocabulary normalized to PLAN.md B5 glossary — burst/stub/flush/unsent)
verified-by: kimi-k3-architect (independent replication of all 5 pi-source claims: 5/5 VERIFIED, runner.js:830–852, sdk.js:248–253, agent-loop.js:227–238, agent-session.js:821–824/477/541/550, agent-loop.js:24/26 no-repair)
adjudicated-by: jev-1.13.0 (D1 flush-trio 0.98; D2 ambient-bypass 0.90; D3 P1-stub 0.99; bypass-compactor 0.78; P1-first 0.82; defaults score 1.78 — "expect minor tuning")
note: transcript renders in this session exhibit a display-layer token/digit drift; all shared identifiers in this file were byte-verified against git-tracked spec-phase2.md (python byte-exact check) — the drift is a render artifact, not file corruption
basis: spec-phase2.md v1.0 (M1–M4 implemented, 31/31 tests); pi 0.86.1 facts below
---

# CONTEXT Phase-3 spec — Per-Call View Shaping via `context` Event

version: 1.0 (extends spec-phase2.md v1.0 + PLAN.md Phase-3 row, B1–B6)

Basis (pi 0.86.1, verified): E1 `context` event (runner.js:830–852) — `structuredClone(messages)` per LLM call, chained handlers, thrown handler's change dropped, result replaces messages FOR THAT CALL ONLY; types.d.ts:515–518/815–817. E2 wiring (sdk.js:248–253 → agent-loop.js:227–231: transformContext → convertToLlm → normalizeContext → stream). E3 forced-prompt projection WRAPS transformContext (agent-session.js:821–824) — our handler runs during compaction/summary too. E4 adjacency (agent-loop.js:24): last message must convert to `user`|`toolResult`; toolResults immediately follow their assistant toolCall; pi does NO validation/repair of transformContext output (agent-loop.js:26). E5 persistent mutation stays `message_end` replacement only (agent-session.js:477–489, 541–550) — Phase 3 is PER-CALL VIEW. E6 cache continuity = sent-sequence continuity; removing already-sent content dirties the prefix at the next call omitting it.

## Summary
Phase 3 registers one `context`-event handler (E1/E2) producing a PER-CALL VIEW (E5): the session transcript is never mutated; persistent mutation remains Phase-2 `message_end` only. Three transform classes — stale-dedupe, superseded-output collapse, task-switch eviction — are computed into a plan FROZEN at burst open (B5) and applied byte-identically to every LLM call in the burst. Ops on already-sent content (E6 dirty-prefix) are queued and flushed ONCE at a burst boundary (cache cold/expiring OR quality < floor OR hard excess). Adjacency (E4) is self-validated in-handler (pi repairs nothing); invalid ops are dropped, and any handler error fails open to no-change. Forced-prompt requests (E3) bypass shaping entirely (compactor sees the true transcript); shaping flush and Phase-2 M3 `ctx.compact` are same-turn exclusive. Evicted content re-hydrates via visible toolCall args (model re-run, B1) or side-car by sha.

## M1 — Burst lifecycle (B5 anchor)
- Trigger: `context` event (E1; fires per LLM call).
- Definition (operational): a **burst** = the maximal run of consecutive `context` events for one user turn. Opens at the first `context` event after `message_end`(role=user); closes at `turn_end`, at forced-prompt entry (E3), or `session_start`/session close. Identity `{sessionId, userTurn}`; `callNo` increments per event.
- Action: `st.burst = {id, callNo, plan, openedAt}`; `st.lastLlmAt` stamped on EVERY event (the handler doubles as the cache-temperature spy — no separate call tracking exists). `st.shaping.baseline` (last flushed view spec, by content sha) persists across bursts.
- Guards: events with no open burst or `st.compacting === true` never open/extend a burst (M6).
- Degraded: local state only; none.

## M2 — Frozen shaping plan (B5, E4, E6)
- Trigger: first `context` event of a burst.
- Eligibility: `shaping.enabled`; `st.burst.plan == null`.
- Action: build ordered plan from Phase-2 state (read-only): (a) **unsent ops** — target content absent from `st.shaping.sentPrefix` (never included in any prior payload) apply THIS burst at zero cache cost; (b) **dirtying ops** — content already sent (E6) enqueue to `st.dirty` (M5), never applied mid-burst. Freeze plan `{targetShas, ops, computedAt}`; every later event in the burst applies the identical transform to its input clone. `sentPrefix` updated append-only after each applied event.
- Adjacency self-validation (E4 — mandatory, pi validates nothing): after transform assert (1) every toolCall message still immediately followed by its toolResult(s); (2) no toolResult survives whose call was removed; (3) final message converts to `user`|`toolResult` (agent-loop.js:24). Violation ⇒ drop the offending op from the plan FOR THE WHOLE BURST (views stay identical) + telemetry `shape.apply{droppedAdjacency}`.
- Guards: B2 — plan reads but never writes taskModel/staged state; B1 exemptions (M3/M4); whole handler self-caught ⇒ return no-change (fail-open; never rely on pi's throw-drop).
- Degraded: plans use existing verdicts incl. `source:"heuristic"`; ZERO Jev calls at plan or apply time.

## M3 — Stale-dedupe + superseded-output collapse
- Trigger: plan input (M2 freeze).
- Eligibility (ALL): `role:"toolResult"` spans; non-error; tok ≥ `classification.dumpTokens`; not already `[elided `/`[shaped:`; toolName ∉ `elision.readToolNames` (B1); not produced in the current burst (warm, B1). Then either: **stale-dedupe** — cls ∈ {dup, stale} left unelided by Phase-2 M2 (below pressure tier); or **superseded-collapse** — older of ≥2 same-toolName runs with equal argsHash, newer retained in view.
- Action (view-only): P1 stub content `[shaped: <toolName> −N tok @turn T; sha=<sha8>; rerun call above or /ctx:restore <sha8>]`; P2 pair-drop only when a newer equivalent output remains in view. Side-car record `kind:"shape"` {sha, toolName, args (≤argsCap), tok, text} written BEFORE the op first applies (unsent: at freeze; deferred: at flush).
- Guards: idempotent (stub prefixes skipped); E4 validation; unsent/sent split per M2.
- Degraded: heuristic cls qualifies identically (source recorded).

## M4 — Task-switch eviction
- Trigger: plan input.
- Eligibility: spans with latest verdict.v === "unrelated" AND `rescoredAtTurn` set (Phase-2 M4 list); excluded: user/assistant text, errors, read-tool results (parity with Phase-2 AC-5 — never shaped), current-burst messages, any span with a "relevant" verdict.
- Action: P1 stub (default); P2 pair-drop only when the FULL call+result pair is listed and ≥1 user message remains in view. Per flush, evicted tokens ≤ `shaping.maxEvictShare` × baseline view tokens; excess stays queued.
- Guards: B2; E4 (P2 drops both sides together — never one); side-car-first (M3).
- Degraded: heuristic unrelated (overlapScore < 0.15) eligible; zero fetches.

## M5 — Dirty-prefix batching (E6)
- Queue: `st.dirty` FIFO {op, sha, tok, enqueuedAt}; caps `dirtyQueue.maxEntries`/`maxTok` ⇒ oldest-first forced flush (trigger `"cap"`).
- Evaluation: at every burst boundary (turn_end, and burst open). Flush ALL queued ops atomically into a new baseline iff ANY:
  (a) **cache cold/expiring**: `now − st.lastLlmAt ≥ shaping.cacheTtlMin` (prefix TTL presumed lapsed; removal ≈ free);
  (b) **quality < floor**: quality = 1 − purity (Phase-2 M3 purity on transcript), floor `shaping.qualityFloor`;
  (c) **hard excess**: purity ≥ `hardMultiplier × budget`.
- Action: side-car writes for all ops → apply → new baseline; exactly ONE prefix-dirtying per flush (E6), not per op/per call. Telemetry `shape.flush{trigger, ops, tokRemoved}`. B6 extension: suppress cache-loss attribution on the next assistant `message_end` after a flush (same flag as Phase-2 compact).
- Double-flush guard (Phase-2 M3 interplay): turn_end order = await `pendingScores` → probes → purity → **(flush eligible AND queue non-empty ? shaping flush : Phase-2 M3 soft/hard)** — never both in one turn. `ctx.compact` is skipped on flush turns and re-evaluates next turn; if transcript junk persists after view-level relief, M3 may still fire on a later turn (intentional: the view buys time cheaply; the compact still owns persistent shrinkage).
- Degraded: none (local arithmetic).

## M6 — Forced-prompt & ambient calls (E3)
- Reality: forced-prompt projection (agent-session.js:821–824) wraps transformContext ⇒ our handler sees compaction/summary payloads; plan sha-sets and prefix assumptions do not hold there.
- Action: **bypass — return no change** when `st.compacting === true` (set by Phase-2 M3 before `ctx.compact`; cleared at next `message_end`(user)) OR when no burst is open (ambient/auto-forced calls we did not initiate). Forced entry CLOSES the current burst: plan discarded; post-compact transcript becomes the new baseline (compact already dropped content persistently, E5). At next burst open, prune `st.dirty` of shas absent from the new baseline (telemetry `shape.prune{n}`).
- Guards: the compactor must see the TRUE transcript (summary faithfulness — Jev noul 0.78) — forced inputs are never shaped.
- Degraded: missed detection falls back to E4 validation + fail-open; worst case a compactor sees the shaped view (logged, `shape.bypass` absent).

## Re-hydration contract
- P1 (default): the toolCall+args remain in view adjacent to the stub (guaranteed by E4); the model re-runs the visible call verbatim — a fresh read, never a stub (B1). Side-car holds full text+args for offline restore.
- P2 (pair-drop): only with a retained newer equivalent output in view — re-hydration IS that output.
- Human path: `/ctx:restore <sha8>` prints the side-car entry; `/ctx:health` lists evictions (sha, toolName, turn, tok). Side-car: same file as Phase-2 (`elision.sideCarPath`), `kind:"shape"`.

## Config additions (CMConfig v3)
- `shaping: { enabled: true, qualityFloor: 0.85, cacheTtlMin: 5, maxEvictShare: 0.4, argsCap: 2048 }`
- `dirtyQueue: { maxEntries: 64, maxTok: 32768 }`
- Reused unchanged: `classification.dumpTokens` (floor), `elision.readToolNames` (B1), `elision.sideCarPath`, `purityBudget.*` (tiers), `relevanceMinTokens`.

## Telemetry & status additions
- `shape.plan{burstId, ops, tokUnsent, tokDeferred, sources}`
- `shape.apply{callNo, applied, droppedAdjacency, viewTokens}`
- `shape.flush{trigger: "ttl"|"floor"|"hard"|"cap", ops, tokRemoved}`; `shape.bypass{reason:"forced"|"ambient"}`; `shape.prune{n}`
- `/ctx:health` += burstId, callNo, viewTokens vs transcriptTokens, dirtyQueue {depth, tok}, lastFlush {trigger, turn}.

## Hook map
- `session_start`: + reset burst, baseline, dirty queue, compacting flag.
- `message_end`(user): + open burst (plan lazily frozen at first `context` event); clear `st.compacting`.
- `context` (NEW, via `transformContext`, E2): M1 spy/lifecycle → M6 bypass → M2 freeze/apply → E4 self-validate → fail-open no-change.
- `message_end`(assistant): B6 suppression extends to shaping-flush turns.
- `turn_end`: pendingScores → probes → purity → M5 flush XOR M3 compact → close burst → status/telemetry.

## Acceptance criteria
- AC-1 (Per-call view, immutable transcript): for every `context` event the handler returns a transformed per-call view while the stored transcript remains byte-identical before and after the call.
- AC-2 (Burst open): a burst opens only at the first `context` event after `message_end`(user), keyed by identity {sessionId, userTurn}, and never opens or extends when no such boundary occurred or when `st.compacting` is true.
- AC-3 (Burst close): an open burst closes at `turn_end`, forced-prompt entry, or `session_start`, and no further ops apply under that burstId after close.
- AC-4 (lastLlmAt spy): `st.lastLlmAt` is stamped on every `context` event, and flush condition (a) is evaluated against that stamp.
- AC-5 (Frozen plan): the plan {targetShas, ops, computedAt} is computed exactly once, at the burst's first `context` event from Phase-2 state, and is never recomputed mid-burst.
- AC-6 (Identical application): across all N calls of one burst, the frozen ops apply in the same order, producing byte-identical view deltas on every call.
- AC-7 (Mid-burst appended content): content first appearing after plan freeze appears unshaped in that burst's views and only becomes eligible at the next burst's plan computation.
- AC-8 (Unsent ops immediate): ops on content never sent in a prior payload (absent from the append-only sentPrefix) apply immediately within the burst at zero prefix-dirtying cost.
- AC-9 (Dirty ops deferred): ops on already-sent content are never applied mid-burst; they enqueue to `st.dirty` as FIFO {op, sha, tok, enqueuedAt} and apply only at a flush.
- AC-10 (Adjacency A1): if post-transform any toolCall message is not immediately followed by its toolResult(s), the offending op is dropped for the whole burst and `shape.apply.droppedAdjacency` increments.
- AC-11 (Adjacency A2): if any toolResult survives in the view whose toolCall was removed, the same whole-burst drop and telemetry fire.
- AC-12 (Adjacency A3): if the final view message cannot convert to `user`|`toolResult`, the same whole-burst drop and telemetry fire; each of AC-10/11/12 is verified by a fixture violating only that assertion.
- AC-13 (Self-validation timing): adjacency validation runs after transform application, inside the handler, before the per-call return — pi performs no validation or repair (E4).
- AC-14 (B1 read-tool exemption): no span with toolName ∈ `elision.readToolNames` is ever stubbed, pair-dropped, or evicted in any view.
- AC-15 (Warm/current-burst exemption): no message produced within the current burst is shaped by any transform class.
- AC-16 (Error exemption): error toolResult spans are never selected by stale-dedupe, superseded-collapse, or task-switch eviction.
- AC-17 (Stale-dedupe eligibility): stale-dedupe selects only toolResult spans that are non-error, tok ≥ `classification.dumpTokens`, not already stubbed, not B1-exempt, not warm, and left unelided by Phase-2 M2 with class ∈ {dup, stale}.
- AC-18 (Superseded-collapse selection): among ≥2 same-toolName runs with equal argsHash only older runs are eligible, and P2 pair-drop fires only when the newer equivalent output remains in the view.
- AC-19 (Stub format): P1 stub text exactly matches `[shaped: <toolName> −N tok @turn T; sha=<sha8>; rerun call above or /ctx:restore <sha8>]`, making it machine-parseable for re-hydration.
- AC-20 (Eviction eligibility): task-switch eviction selects only spans with verdict.v === "unrelated" AND `rescoredAtTurn` set; user/assistant text, errors, read-tool results, current-burst messages, and any other verdict are excluded.
- AC-21 (M4 P2 guard): M4 pair-drop applies only when the FULL pair is listed and ≥1 user message remains in the view; otherwise P1 stub is used.
- AC-22 (Zero-Jev and degraded mode): plan and apply perform zero Jev/network calls, using existing verdicts including heuristic source; with heuristic verdicts, unrelated heuristic spans remain evictable.
- AC-23 (Evict cap): per flush, evicted tokens ≤ `shaping.maxEvictShare` × baseline view tokens; excess ops stay queued in `st.dirty`.
- AC-24 (Cap-forced flush): when `st.dirty` exceeds `dirtyQueue.maxEntries` or `dirtyQueue.maxTok`, a forced flush with trigger "cap" fires, dequeuing oldest-first.
- AC-25 (Trigger a — TTL): at a burst boundary where now − lastLlmAt ≥ `shaping.cacheTtlMin` and the queue is non-empty, a flush with trigger "ttl" fires.
- AC-26 (Trigger b — quality floor): when quality = 1 − purity (Phase-2 purity on the true transcript) falls below `shaping.qualityFloor` and the queue is non-empty, a flush with trigger "floor" fires.
- AC-27 (Trigger c — hard excess): when purity ≥ `hardMultiplier × budget` and the queue is non-empty, a flush with trigger "hard" fires.
- AC-28 (Atomic flush): a flush applies all queued ops atomically with exactly ONE prefix-dirtying event per flush.
- AC-29 (Single-flush XOR): at `turn_end` (order: pendingScores → probes → purity), exactly one of shaping-flush or Phase-2 M3 soft/hard compact executes — never both in one turn — and B6 suppression extends to shaping-flush turns.
- AC-30 (Forced-prompt bypass): when `st.compacting === true` or no burst is open, the handler returns no change and emits `shape.bypass{reason}`, so the compactor's forced-prompt projection sees the true unshaped transcript.
- AC-31 (Burst close + new baseline): forced-prompt entry closes any open burst, and the post-compact transcript becomes the new baseline for subsequent plan computation.
- AC-32 (Dirty prune): on post-compact baseline swap, `st.dirty` entries whose shas are absent from the new baseline are pruned and counted in `shape.prune{n}`.
- AC-33 (Side-car ordering): for every stubbing op, the side-car record (kind:"shape") is durably written before the op first applies in any view.
- AC-34 (Fail-open): any handler throw is self-caught and yields a no-change return for that call, with the extension remaining loaded and no partial application left in burst/queue state.
- AC-35 (Idempotence): spans already carrying the `[shaped:` stub prefix are skipped by all transform classes (never re-stubbed or double-counted).
- AC-36 (Re-hydration): shaped content is restorable via the visible toolCall args path (B1) or `/ctx:restore <sha8>` side-car lookup by sha, with args truncated at `shaping.argsCap` (2048).
- AC-37 (B2 read-only): the handler performs no writes to the Phase-2 task model; it only reads existing verdicts and state.
- AC-38 (shape.plan telemetry): each burst emits exactly one `shape.plan{burstId, ops, tokUnsent, tokDeferred, sources}` at plan freeze.
- AC-39 (shape.apply telemetry): each shaped call emits `shape.apply{callNo, applied, droppedAdjacency, viewTokens}`.
- AC-40 (flush/prune/bypass telemetry): each flush emits `shape.flush{trigger ∈ {ttl, floor, hard, cap}, ops, tokRemoved}`; bypasses and prunes emit `shape.bypass{reason}` and `shape.prune{n}` respectively.
- AC-41 (/ctx:health): `/ctx:health` reports burstId, callNo, viewTokens vs transcriptTokens, dirtyQueue {depth, tok}, and lastFlush {trigger, turn}.
- AC-42 (Config defaults): with absent shaping/dirtyQueue config, the effective values are shaping {enabled, qualityFloor: 0.85, cacheTtlMin: 5, maxEvictShare: 0.4, argsCap: 2048} and dirtyQueue {maxEntries: 64, maxTok: 32768}, reusing classification.dumpTokens, elision.readToolNames, elision.sideCarPath, purityBudget.*, and relevanceMinTokens.
- AC-43 (Malformed config): malformed shaping/dirtyQueue values log a warning and fall back to defaults without throwing or disabling the extension.
- AC-44 (Disabled passthrough): with shaping.enabled = false, the handler returns no change on every `context` event and emits no shape.plan/apply/flush telemetry.

## Amendments
- 2026-09-22 v1.0 (at transcription): Jev adjudication recorded — flush trigger trio + cap (A, 0.98), ambient bypass (A, 0.90), P1-stub default (A, 0.99), forced-prompt bypass necessity (0.78), P1-first re-hydration (0.82). Default numeric set scored 1.78/3 ("reasonable, expect minor tuning") — carried note: revisit `shaping.*` after the first live week using shape.flush telemetry. Provenance flag: GLM run 2's self-reported model string rendered inconsistently with the requested alias in the transcript; display-layer drift suspected (same layer corrupts other tokens; byte-verified content unaffected), gateway routing drift not confirmed. AC substance unaffected (Kimi verified pi facts independently, 5/5; spec identifiers byte-verified against spec-phase2.md).

## Amendments

- **2026-09-22 v1.1 (implementation-driven, MODIFIED M2):** the sent-prefix stamp runs AFTER the per-call shaping decision, not before. Rationale: stamping before the decision marked the current call's input as sent history before eligibility was computed, defeating AC-8 — every op queued (dirty) and unsent ops could never apply at zero cost. Post-decision stamping: everything in the call's input graduates to sent history once the call goes out (over-conservative for stubbed content — safe; avoids cache breakage). Wiring tests proved the original reading unimplementable.
- **2026-09-22 v1.1 (CLARIFIED M3):** the warm/current-burst exclusion (AC-15) applies PER-SPAN, not per-sha: eligibility picks the newest span with a given sha whose capturedAt precedes the burst open. Rationale: dumps re-emitted every turn always produce a warm copy; a per-sha reading let that copy permanently shadow the sent, eligible original (AC-15 starved AC-9/AC-20). Verified by cap-flush and eviction wiring tests.
- **2026-09-22 v1.1 (NOTED M3/M4):** P2 pair-drop is implemented strictly guarded (superseded-collapse only, single-call assistant messages, newer equivalent in view); task-evict remains P1-stub-only in code (AC-21 guard satisfied vacuously; P1 default upheld by Jev D3 0.99). Wire tests cover the stub path for all three classes and the guarded pair-drop fallback.
- **2026-09-22 v1.2 (review-driven, GLM 5.3 post-implementation review):**
  (F3/M6 STRENGTHENED) triggerCompact now resets ALL shaping state — dirty queue, appliedShas, appliedTurns, argsKeyBySha, sentPrefix — because the compacted transcript is a new baseline; previously a turn with zero LLM calls after a compact could graduate dead shas from the dirty queue, burning the M5/M3 XOR on a no-op flush. (F2/AC-3 HARDENED) the turn_end status-render is exception-guarded so the burst close at turn_end is reached even if UI rendering throws (a stale open burst disabled the warm scan and froze the plan). (F1/E6) sentPrefix overflow retains only shas live in the current input instead of clear() — a blind clear re-classified still-live sent content as unsent, re-stubbing it mid-burst. (F5/E4 UPGRADED) adjacencyValid records call POSITIONS and enforces result-after-call ordering (A0) plus per-occurrence multiplicity (A1/A2) — duplicate or reversed call/result structures now reject the view instead of being blessed. Full suite 45/45 × 3 consecutive runs post-fix.
