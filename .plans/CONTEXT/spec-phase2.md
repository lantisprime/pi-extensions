---
name: context-manager-phase2
version: 1.0
author: glm-design-reviewer (lead architect, litellm/glm-5.3-zai)
status: draft-for-implementation
---
# CONTEXT Phase-2 spec — Ingest Elision + Task-Switch + Purity Budget

version: 1.0 (extends spec.md v1.1.1 + PLAN.md B1–B6; resolves Q5, Q6)
basis: Phase-1 `context-manager/index.ts` (spans/verdicts/turn_end metrics unchanged); `message_end` `{message}` replacement is persistent (agent-session.js:476-489) and a toolResult replaced before its first LLM inclusion costs zero cache — Phase 2's only new mutation surface.

## Summary
Phase 2 adds mutation on exactly two hooks: `message_end` (user-turn task pinning M1/M4; toolResult dump elision M2) and `turn_end` (purity-budget flush M3 via `ctx.compact({customInstructions})`). Elision is dump-class-only, pressure-gated, fail-open, side-car-archived. Task switches apply next-user-turn (B2); wrong switches cost only re-scored verdicts (recoverable). No context-event shaping, no read stubbing, no warmer interference.

## M1 — Task-switch detection (`message_end`, role=user)
- Pin per user turn (B2): `taskModel = { tasks: taskSubjects(ctx), topic: excerpt(≤200 chars) of this user msg, turn }`. First user turn pins without scoring. M2/M3/M4 never mutate a pinned model (B2 circularity guard).
- Detection, ≤1 Jev call per user turn: (a) deterministic — session task-list diff (added/removed non-completed IDs) ⇒ drift, zero Jev calls; (b) else ONE call, noul "the newest user message shifts focus away from the pinned task model" → p > driftThreshold (0.65) ⇒ drift; (c) degraded — `overlapScore(userMsg, tasks+topic words) < 0.15` ⇒ drift (source recorded).
- Drift STAGES `{tasks, topic}` only; applied at the NEXT `message_end`(role=user) (B2). Wrong-switch cost: verdicts mislabeled until next re-score — recoverable (M4 re-runs every switch).

## M2 — Dump-class elision (`message_end`, role=toolResult)
- Eligibility (ALL required): tok ≥ `classification.dumpTokens`; cls ∈ {`unclassified`, `dup`}; NOT isError/error-class; toolName ∉ `elision.readToolNames` (B1); toolName recorded at `tool_execution_end` keyed by contentHash.
- Pressure tiers (p = purity from last `turn_end`): p < budget ⇒ NO elision; budget ≤ p < 2× ⇒ elide unrelated (verdict.v==="unrelated") only; p ≥ 2× ⇒ also dup-class.
- Action: append `{ts, sessionId, sha, path?, tok, text}` to `elision.sideCarPath` JSONL; on success return `{message}` with content `[elided N tok dump: sha=<sha>; archived: <sideCarPath>#<seq>]` (persistent; zero cache cost). Append failure ⇒ skip elision (fail-open) + telemetry `{elision:"skipped"}`.
- Never elide user/assistant messages, errors, read-tool results, spans < dumpTokens. Idempotent: content starting `[elided ` skipped. Re-hydration (Q6): model re-runs/re-reads original path (toolCall+args adjacent/visible) or reads side-car by sha.

## M3 — Purity budget (`turn_end`; flush via `ctx.compact`)
- purity = (unrelated[verdict] + dup[cls] + stale[cls]) token share, computed in existing `turn_end` after `await pendingScores` + probes.
- Soft (purity ≥ budget): status `p:NN%⚠(queued)`; queue; NO compact this turn. Queued flush executes NEXT `turn_end` only if purity still ≥ budget, then clears.
- Hard (purity ≥ hardMultiplier × budget): immediate `ctx.compact({customInstructions: "drop unrelated/dup/stale content"})` (B4).
- Guards: `compactCooldownMin` cooldown; never while in flight; B6 — compaction disables cache writes ⇒ next assistant `message_end` after triggered compact suppresses cache-loss attribution; telemetry `{flush:"hard"|"soft-exec", purity}`.

## M4 — Task-switch re-scoring (staged model applies at message_end(user))
- Re-score spans vs NEW model: candidates = verdict ≠ null OR tok ≥ `relevanceMinTokens`, most-recent `rescoreBatch` (30), ONE batched Jev call (per-span on_task noul).
- on_task < 0.35 ⇒ verdict.v = "unrelated" (eviction-candidate list in `/ctx:health` + telemetry; eviction is Phase 3); else "relevant". Degraded: overlapScore < 0.15 ⇒ unrelated. Add `rescoredAtTurn`.
- Non-blocking: join `st.pendingScores`, awaited at `turn_end` BEFORE M3 purity computation.

## Config additions (CMConfig v2)
- `taskSwitch: { enabled: true, driftThreshold: 0.65, rescoreBatch: 30 }`
- `elision: { enabled: true, sideCarPath: ".pi/context-elisions.jsonl", readToolNames: ["read"] }`
- `purityBudget: { budget: 0.15, hardMultiplier: 2, compactCooldownMin: 10 }`
- `compactInstructions: "drop unrelated/dup/stale content"`
- Unchanged: `classification.dumpTokens` = elision floor; `relevanceMinTokens` gates M4.

## Hook map
- `session_start`: reset stagedModel, flush queue, cooldown, B6 flag.
- `tool_execution_end`: + record toolName keyed by contentHash.
- `message_end`(user): M1 pin/detect/stage; M4 apply + re-score. (toolResult): M2 elide. (assistant): + B6 suppression.
- `turn_end`: await pendingScores → probes → purity → soft queue / hard compact → status/telemetry.

## Acceptance criteria
AC-1 ≤1 Jev drift fetch per user turn; no key ⇒ heuristic decides, ≤1 decision/turn.
AC-2 task-list diff yields drift with zero Jev fetches.
AC-3 drift p=0.70 stages new model; ingest scoring turn N uses OLD tasks, N+1 NEW (B2).
AC-4 dump toolResult (≥dumpTokens, non-read, non-error) under p≥2×budget persistently replaced with `[elided N tok dump: sha=…; archived: …]`.
AC-5 read-tool result never elided under hard pressure (B1).
AC-6 error results never elided.
AC-7 side-car written before stub applies; forced append failure leaves original intact (fail-open) + telemetry `{elision:"skipped"}`.
AC-8 soft tier elides unrelated dump, retains dup dump; hard tier elides both.
AC-9 telemetry purity matches harness share ±1 token.
AC-10 soft excess sets ⚠(queued), no compact that turn; exactly one compact next turn iff purity still ≥ budget.
AC-11 hard excess compacts same turn with locked customInstructions; cooldown suppresses repeats; next assistant message skips cache-loss attribution (B6).
AC-12 task-switch apply re-scores ≤30 spans via ONE fetch; degraded updates heuristically; pendingScores resolve before turn_end metrics.
