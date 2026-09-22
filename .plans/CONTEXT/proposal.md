# CONTEXT proposal — dynamic context manager for pi

version: 0.2 (draft for GLM review — pre-spec)
predecessor: .plans/COMPACT/ (smart-compaction becomes the `compact` module)

## Objective (multi-objective, quality-first)

```
1. maximize  taskSuccess     ← primary; proxied by context PURITY:
                                only information relevant to the CURRENT tasks
2. minimize  latency         ← prefill/attention scale with context SIZE,
                                even when cached (context rot is attention,
                                not just price)
3. minimize  cost            ← cache hit ratio (footer "cache %") as the
                                cost/latency constraint, not the goal
subject to freshness/no-poison floor
           tokens(ctx) ≤ window − reserve
```

**Poison definition**: content that is (a) unrelated to the current tasks,
(b) stale/contradicted, or (c) error-loop residue. Poisoning is PREVENTED at
ingest and EVICTED on task switch — compaction is the last resort, not the
strategy. Cache hits must never be bought with purity: a 95% hit ratio on a
polluted context is a failure mode, not success.

## Amendments

- **2026-09-21 v0.3 (ADDED/MODIFIED after GLM review + Jev-grounded decisions):**
  B1 STUBBING (Jev 0.92): model-initiated reads are NEVER stubbed; only
  unrequested dump-class bulk is stubbed, and only under context pressure.
  B2 TASK MODEL (Jev 0.85): pinned per user turn + session task list; shaping
  never mutates it (breaks purity circularity). Jev drift-watch may PROPOSE
  updates, applied only on the next user turn.
  B3 ORCHESTRATOR (GLM major): advisory only — cache_warming_decision is
  veto/observe ({action:"warm"|"stop"}); no warm triggering, no breakpoint/TTL
  control. Post-compaction cache re-seeds on the next real request.
  B4 BURST PRECEDENCE (my judgment; Jev split 0.41/0.37): two thresholds —
  soft purity excess queues a flush at the next natural break (cache-wins);
  hard excess (≥2× budget) forces an immediate mid-burst flush (quality-wins).
  B5 SHAPING (Jev 0.89): decisions frozen per burst, applied identically to
  every call in the burst; deterministic where possible; toolCall/toolResult
  adjacency always preserved (pi cut-point rule).
  B6 (GLM minor): compaction/summary requests disable cache writes — the
  ledger must not count them as cache losses.

## Threat model (what rots/poisons context)

- **Unrelated information**: artifacts from other tasks/projects accumulating
  in a session whose focus has moved on (the classic poisoning case)
- **Task-switch residue**: context relevant to task A is poison once the
  session moves to task B — relevance is DYNAMIC, so scoring must re-run on
  focus changes, not only on content changes
- **Ingestion of irrelevant bulk**: large reads/dumps appended full-text
  before anyone asked whether they matter
- Stale reads: file read at turn N, edited by turn N+k — old copy is wrong
- Superseded tool output: large dumps whose conclusion was already consumed
- Error/retry loops: failed command + output + retry pairs
- Contradictions: overturned decisions/claims coexisting with newer ones
- Dead exploratory branches: read-heavy paths that led nowhere

## Anti-poisoning mechanisms (prevention, not just cure)

- **Ingest-time relevance gate**: before a large artifact is appended full-
  text, score it against current tasks; irrelevant bulk → append a one-line
  stub + pointer ("read big.txt: 40k tokens, summary: …") instead of the body.
  Full text re-hydrates on demand (re-read) when relevance returns.
- **Task-switch re-scoring**: on detected focus change (new task set, topic
  shift in user messages), re-score existing spans; prior-task residue becomes
  eviction candidates even while the cache is hot (bounded by rot budget).
- **Purity budget**: unrelated-token share of context is a hard metric; above
  the budget → flush/evict regardless of cache state.

## Architecture — five layers + orchestrator

```
Observe ──▶ Score ──▶ Shape ──▶ Compact ──▶ Verify
    ▲                                          │
    └────────── Cache Orchestrator ◀───────────┘
```

1. **Observe** (`message_end`, `tool_execution_end`): fingerprint artifacts at
   ingest — file reads (path+mtime/hash), classify tool results (error/dump/
   conclusion), record spans. No mutation.
2. **Score** (budgeted, `turn_end`): Jev judgments over candidate spans —
   "still accurate?", "contradicted by newer content?", "needed for session
   tasks?" (generalizes the COMPACT relevance gate to continuous scoring).
   Heuristic fallback always available.
3. **Shape** (`context` event, fires before every LLM call with a modifiable
   deep copy): per-call view curation — drop stale dupes, collapse superseded
   outputs, redact secrets. Session transcript stays immutable.
4. **Compact**: existing smart-compaction trigger engine, unchanged.
5. **Verify** (`turn_end`): context-health metric — %fresh, %stale, %dup,
   error-ratio — status line next to pi's `cache %`.

**Cache Orchestrator**: owns the cache state machine
(COLD→WRITING→HOT→EXPIRING→COLD) per session×model. All layers submit
mutation requests; the orchestrator decides WHEN they flush, at the
cache-cheapest moment. Also: warm/let-expire/stop-warming via
`cache_warming_decision` override; checkpoint placement; TTL-tier choice;
cache ledger (hit rate, warm spend, wasted warm).

## The four levers (ranked by hit-ratio damage per quality gain)

1. **Ingest-time hygiene** (≈free): truncate/collapse before appending —
   prefix never notices.
2. **Append-only discipline** (free): during an active burst, mutate nothing —
   queue pruning decisions. Hit ratio stays ~95%+.
3. **Frontier flush** (cheap): flush queued mutations in ONE rebuild when
   (cache cold/expiring) OR (quality < floor) OR (tier/overflow). Pruning +
   compaction + re-warm merge into a single cache event.
4. **Full compaction** (expensive): existing economy/tier/overflow triggers.

## The safety rule

Break the prefix only when: quality < floor, or cache already broken, or
money says so. Never mutate mid-burst; never prune user messages or
task-critical spans; never flush for cost while quality ≥ floor.

## Quality floor — how "without degrading quality" is testable

- freshness: fingerprint vs disk (mtime/hash at read time)
- relevance: Jev/heuristic gate over spans (existing gate.ts pattern)
- duplication ratio, error-loop share: counters from Observe layer
- bounded rot budget: e.g. stale+dup > 8% of context forces a flush even on a
  hot cache (paying rebuild on purpose)

## Per-model cache strategies (lab-specific, lives in profiles)

| Lab | Cache semantics | Levers |
|---|---|---|
| Anthropic | explicit cache_control breakpoints (≤4), 5min/1.25× vs 1h/2× write, reads 0.1×, min block size | breakpoint placement = stable frontier; TTL tier by session rhythm |
| OpenAI / DeepSeek / GLM | automatic prefix caching, no write premium, ≥min tokens | keep prefix stable; rebuilds cheap → flush often |
| Gemini | implicit + explicit cachedContents API | stable blocks → explicit cache (phase 3?) |
| Local MLX/vLLM | free server KV, RAM-evicted | cache % barely matters → quality-first |
| Gateways (LiteLLM/OpenRouter) | routing can kill hits | pi sends session-affinity headers (OpenRouter); hit-rate collapse w/ unchanged prefix = routing churn → detectable |

pi source confirms compat knobs: `cacheControlFormat`,
`sendSessionAffinityHeaders`, `supportsLongCacheRetention`, per-provider
cacheRead/cacheWrite usage parsing.

## Jev — the judgment plane

Jev is not just the relevance gate; it is the System One judgment engine
wired into every layer, with typed probabilities code can threshold:

| Layer | Jev judgments | Budget |
|---|---|---|
| Observe | (none — pure fingerprinting) | — |
| Score | span staleness ("is this contradicted/superseded?"), task-relevance per span, poison classification | batched; ≤ N spans per turn_end |
| Ingest gate | bulk-artifact relevance classification (dump-class only) | per large artifact |
| Task model | drift watch — PROPOSES task-model updates on topic shift | per user turn |
| Shape/flush arbitration | "is flushing now worth the rebuild?" over the dirty queue | per flush decision |
| Compact | existing relevance gate (focused/aggressive/defer) | per compaction |

Rules: every Jev call has a heuristic fallback (proven: 54–61ms failover);
calls are batched (one request, many questions); availability is checked in
REAL TIME by the call itself — a failed call degrades this decision to the
fallback and refreshes the shared liveness file; no cached liveness gate may
refuse a call (lesson: a 10h-old status file blocked decisions while Jev was
up).

## Phases

1. Observe + health/purity metrics (no mutation; fingerprinting, unrelated-
   share, staleness — immediate value)
2. Ingest-time relevance gate + stubbing (prevents poisoning from entering)
3. Shape: stale-dedupe + superseded-output collapse + task-switch eviction
   via `context` event; dirty-prefix batching; budget enforcement
4. Poison defense deepening: Jev contradiction/staleness scoring, secret
   redaction, error-loop collapse; incident fixtures

## Open questions (for review)

- Q1: does mutating the `context` event copy actually change what's sent per
  call, and does the NEXT call revert to transcript (per-call view) — confirm
  cache implications of per-call-only shaping vs persistent shaping?
- Q2: can the orchestrator TRIGGER a warm after a compaction, or only
  veto/observe pi's warmer decisions?
- Q3: is the quality/purity floor measurable enough to gate flushes (false
  positive/negative costs)? Is Jev scoring per-span affordable at turn rate?
- Q4: does footer `cache %` aggregate per-call or cumulative — and is it the
  right KPI vs $ saved?
- Q5: how reliable is task-switch detection (new tasks vs topic drift), and
  what is the cost of a wrong switch event (mass eviction of still-relevant
  context)?
- Q6: ingest-time stubbing changes what the model sees FIRST — does stubbing
  large reads degrade task performance when the read WAS relevant (gate false
  negative)? Re-hydration latency acceptable?
