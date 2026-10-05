# COMPACT design — smart-compaction extension for pi

version: 2 (v1 draft + GLM design review amendments)
spec: see spec.md · research: see research.md

## Amendments

- **2026-09-21 v2 (ADDED/MODIFIED after glm-design-reviewer review):**
  A1 executor policy split (mid-run triggers never call ctx.compact; they
  enrich pi's own compaction via session_before_compact instructions).
  A2 savings formula fixed (no output term; hot-cache marginal = cacheRead
  price; N = regrowth horizon; continuation probability).
  A3 cache-state tracking via message_end + ttlLong + cache_warming_decision
  respect + reset on model switch.
  A4 reserve semantics: extension never mutates settings; pi threshold is the
  backstop; extension acts at safe points and suggests modelOverrides via
  /compact:config.
  A5 explicit price-source precedence + match precedence (exact > config glob
  order > built-in family > generic); null-token no-op; counter resets on
  session_compact/_failed; gate timeout → focused; growth-rate estimator for
  tier prediction.
- **2026-09-21 v2.1 CORRECTION (ADDED after second glm-design-reviewer pass):**
  A1's "enrich pi's own compaction via session_before_compact instructions"
  is NOT implementable in v1: `SessionBeforeCompactResult` is only
  `{cancel?, compaction?}` — it carries no customInstructions override (that
  field exists only on `SessionBeforeTreeResult`). Therefore focus
  instructions attach ONLY to extension-initiated compactions
  (ctx.compact({customInstructions})); pi-initiated compactions are observed
  + logged, never modified. The TriggerEngine (v2) paragraph above
  overstates; this amendment supersedes it. Also: session_compact_failed
  resets min-interval counters (allows prompt retry); the compacting guard
  flag is set only at the point of ctx.compact() so a gate defer cannot wedge
  the trigger (blocker found in review of index.ts).
- **2026-10-04 v2.2 (ADDED after live needle-in-haystack verification on
  litellm/minimax, 1M window):** resolvePrices treats a catalog
  `cacheRead: 0` alongside a positive input price as "no cache pricing data"
  — the same signal an all-zero catalog gives — and falls through to
  `input × profile.cache.readRatio`; an explicit `cacheRead: 0` in
  `defaultPrices`/profile `prices` still pins genuinely free cache reads.
  Rationale: LiteLLM reports priced models with cache fields 0 when it has no
  cache-tier data; honouring that 0 made the hot-cache marginal
  (horizon × shrink × cacheRead) identically $0, so the economy path was
  unreachable in EVERY cache state — live telemetry: `savings $0.0000 <=
  cost $0.0527 × 1.25 (tokens=167828, hot=true, H=50)` at 16% context, past
  the 157,286 floor. The v2-era reading "catalog 0 is real free" is
  superseded for cacheRead specifically; cacheWrite 0 still means "no write
  premium" (cheapens compaction, never a blocker). Cold-path refusals for
  such models remain structural (savings = cont × shrink × input < cost ≥
  tokens × input whenever margin ≥ 1); hot firing via the derived readRatio
  is the intended economy case. Regression tests: engine.test.ts AC-10
  live-minimax regression; wiring.test.ts cread-fire/cread-hold.

## Goal

A pi extension that decides **when** (and with what focus) to compact context,
using a per-model cost model (tiered pricing + prompt-cache economics) and a
relevance gate against the current session tasks.

## Non-goals (v1)

- No custom summary generation (pi's default summarizer stays; we pass focus
  instructions). Custom summarizer = future amendment behind config flag.
- No cross-provider price fetching from the web at runtime.

## Model profiles (per-model strategy)

Every model resolves to one **profile** — tiers, cache economics, and
compaction strategy differ per model, so the strategy itself is data.

Resolution order: explicit config entry (`provider/model` exact, then family
pattern) → built-in family profile → generic default.

```ts
interface ModelProfile {
  match: string;              // "provider/id" exact or family glob ("gemini-3*-pro*", "*-local_mlx")
  prices?: Prices;            // fallback when catalog cost missing (per MTok)
  tiers: Tier[];              // [{ upTo, inputMult, outputMult }] e.g. 200K/×2
  cache: {
    readRatio: number;        // cacheRead ÷ input  (0.1 typical)
    writePremium: number;     // 1.25 anthropic · 0 openai/gemini · 0 local
    ttlShort: number;         // seconds; hot = now − lastLLMCall < ttlShort
  };
  compaction: {
    mode: "cost" | "quality" | "balanced";
    reserveTokens?: number;   // feeds pi settings.modelOverrides
    keepRecentTokens?: number;
    tokenFloor: number;       // never compact below this context size
    minIntervalTurns: number; // min turns between compactions
  };
  gate: { enabled: boolean; aggressiveBelow: number; deferAbove: number };
}
```

Built-in families:

| family | tiers | cache | mode |
|---|---|---|---|
| `gemini-*-pro*` | 200K → ×2/×1.5 | read 0.1, write 0 | cost |
| `gpt-5.6-sol*` | 272K → ×2 in/×1.5 out | read 0.1, write 0 | cost |
| `claude-*` (anthropic-messages) | none (flat) | read 0.1, **write 1.25**, ttl 300/3600 | balanced |
| `*local_mlx`, `*inferx`, price-free | none | read 0, write 0 | **quality** (compact earlier; context-rot dominates) |
| generic API (unknown cost) | none | read 0.1, write 0 (assumed) | balanced, economy trigger disabled (AC-10) |

Profile `mode` selects active triggers:
- **cost**: tier-crossing + economy + overflow; hot-cache suppression on.
- **quality**: overflow + relevance-driven compaction at lower floor; cache
  math skipped (prices ≈ 0); tier/economy inert.
- **balanced**: overflow + economy; tier if configured; hot-cache suppression
  scaled by writePremium.

### Runtime model detection (binding)

At EVERY event handler invocation the extension re-reads `ctx.model` (id +
provider) and resolves the profile fresh — never cached from session start,
because pi allows mid-session model switching (Ctrl+P / `--models` cycling).
Resolution: `${ctx.model.provider}/${ctx.model.id}` → exact config entry →
built-in family glob → generic default. The resolved profile id + mode is
recorded in every telemetry line and in `/compact:why` output, so the applied
strategy is always auditable against the model that was actually active.
Also on `session_before_compact`, re-check `ctx.model` matches the profile
used for the decision (settings captured per-operation mirror pi's own
behavior).

## Architecture

Single extension TS module (repo: `extensions/smart-compaction/`), loaded via
pi extension loader. Config: `~/.pi/agent/smart-compaction.json` +
project `.pi/smart-compaction.json` override.

```
┌────────────────────────────────────────────────────────┐
│ smart-compaction.ts                                    │
│                                                        │
│  events: turn_end / agent_settled / session_before_compact │
│      │                                                 │
│      ▼                                                 │
│  CostModel ── ctx.model.cost + tier config + cache     │
│      │        ratios (cRead/cWrite from catalog or     │
│      │        config fallback)                         │
│      ▼                                                 │
│  TriggerEngine                                         │
│   1. overflow  : projected > window − reserve          │
│   2. tier      : projected crosses tier boundary       │
│   3. economy   : at agent_settled, savings > cost      │
│      │           (cache hot/cold via idle vs TTL)      │
│      ▼                                                 │
│  RelevanceGate (Jev noul; heuristic fallback)          │
│      │  → aggressive / focused / defer                 │
│      ▼                                                 │
│  Executor: ctx.compact({customInstructions})           │
│   guards: isIdle, !hasPendingMessages, minInterval,    │
│   tokenFloor                                           │
│                                                        │
│  commands: /compact:smart  /compact:why  /compact:config │
│  telemetry: JSONL decision log + setStatus line        │
└────────────────────────────────────────────────────────┘
```

## Decision records

- **D1 — hybrid predictive timing** [uncalibrated judgment; Jev stale].
  Evaluate at `turn_end` + `agent_settled`; compact when break-even model says
  so. Arithmetic basis: tier-2 pricing doubles *every* subsequent call, so a
  predicted boundary crossing must fire even mid-task; settled-time compaction
  is cheapest (cache likely cold → write premium ≈ 0).
- **D2 — relevance gate mapping** [uncalibrated]. P(task-relevant):
  `<0.35` aggressive · `0.35–0.70` focused (pass customInstructions preserving
  task-related content) · `>0.70` defer unless overflow. Thresholds in config.
  Fallback when Jev unavailable: keyword-overlap heuristic vs active task
  subjects + recent user messages → default "focused".
- **D3 — v1 scope: timing + instructions only** [risk control]. No summary
  interception beyond focus instructions.
- **D4 — tier-crossing is the highest-value rule** [arithmetic from research].
- **D5 — prefer cold-cache compaction** [TTL arithmetic]. Suppress economy
  trigger while cache is hot (< TTL since last LLM call) unless tier/overflow.

## Cost model

```
inputPrice(tokens)      = tierMultiplier(tokens) × (cost.input or config fallback)
effectiveTurnCost(tokens, cacheState) =
    cachedShare × cacheReadPrice + (1−cachedShare) × inputPrice + outputCost
compactionCost ≈ tokensBefore × inputPrice + summaryOut × outputPrice
               + keptTokens × cacheWritePremium   (0 if cache cold / no premium)
savings ≈ Σ_next N turns (ctxNow − ctxAfter) × effectiveTurnCost + tierAvoided
compact when savings > compactionCost, subject to D5 + guards
```

Unknown `cost` fields (e.g. homelab LiteLLM models): config
`defaultPrices` + per-model `overrides`; if absent entirely → conservative
disabled economy trigger (overflow + tier still active).

## TriggerEngine (v2)

Two planes:

**Observation plane** (always on): `turn_end`, `message_end` (cache-state
timestamps), `agent_settled`, `model_select` (reset cache state, mark token
count stale until next assistant usage), `cache_warming_decision` (record pi's
warm spend + continuationProbability; suppress economy trigger if warmed
recently and continuation likely), `session_compact`/`session_compact_failed`
(reset minInterval counters + lastCompactionAt regardless of who triggered).

**Action plane**:
- **economy** (extension-initiated `ctx.compact()`): ONLY at `agent_settled`
  AND `ctx.isIdle()` AND no pending messages AND savings > cost per the v2
  formula AND pi has not just warmed the cache with high continuation.
- **overflow/tier early-warning** (no direct action): track projected
  crossing using a rolling growth-rate estimator (token delta over trailing
  turns, worst-case + pending tool results); when projected to cross before
  the next natural safe point, arm `session_before_compact` to inject focus
  `customInstructions` for the compaction pi itself will run, and surface a
  status-line warning. NEVER return `{cancel:true}` in v1.

Hard no-ops: `getContextUsage().tokens === null` (right after compaction);
any trigger within minIntervalTurns of a prior compaction (any origin);
below profile tokenFloor; while streaming.

## Savings formula (v2)

```
perTurnSaving(ctxNow, ctxAfter, cacheHot) =
    (ctxNow − ctxAfter) × (cacheHot ? cacheReadPrice : inputPrice)
oneTimeColdAvoidance = cacheHot ? 0 : (ctxAfter × inputPrice)  // avoided at next cold rebuild
savings = continuationProbability × ( H × perTurnSaving + oneTimeColdAvoidance )
        + tierAvoided (if boundary crossed: Σ above-boundary tokens × (tier2In − tier1In) × H')
H = expected turns to regrow to the next trigger line (regrowth horizon,
    from the growth-rate estimator) — self-consistent, not a free parameter
compact when savings > compactionCost (unchanged: summary gen + rebuild premium if hot)
```

No output term in savings. `continuationProbability` mirrors pi's own
`cache_warming_decision` semantics.

## Acceptance criteria

| id | criterion |
|---|---|
| AC-1 | Extension loads in pi (tui + rpc) without errors |
| AC-2 | Cost model: tier pricing correct for configured models (e.g. gemini-3.1-pro 200K boundary ×2; GPT-5.6 Sol 272K ×2 in/×1.5 out) |
| AC-3 | Overflow trigger compacts before window−reserve exhaustion |
| AC-4 | Tier trigger fires when projected context crosses boundary, including mid-task |
| AC-5 | Economy trigger suppressed while cache hot (< TTL idle) unless tier/overflow |
| AC-6 | Relevance gate maps to aggressive/focused/defer; focused path passes customInstructions referencing current session tasks; heuristic fallback works |
| AC-7 | /compact:smart and /compact:why work |
| AC-8 | Guards: no compaction while streaming / with pending messages / < minInterval / < tokenFloor |
| AC-9 | JSONL telemetry per decision (reason, estimates, gate output) |
| AC-10 | Safe degradation: missing cost data, missing Jev, missing config |
| AC-11 | Profile re-resolved from live ctx.model at every event; mid-session model switch changes strategy; resolved profile visible in telemetry + /compact:why |

## Test plan

Unit-test CostModel + TriggerEngine with synthetic usage snapshots; then run
`pi --extension … --mode json` scripted session with a tiny fake window
(config override) to exercise triggers end-to-end.

- **2026-10-04 v3 (ADDED after live telemetry audit + third glm-design-reviewer
  pass; supersedes parts of v2.2):** Post-#178 live sessions still fired economy
  compaction at 158k-212k tokens = 15-20% of 1M windows (fire at floor+1,446 on
  the first settled tick), because the savings arithmetic structurally cannot
  gate: for a flat-priced hot model savings/cost ≈ cont × H × (shrink/tokens) ×
  (cacheRead/input) ≈ 3 at ANY size past the floor. Live compaction-call usage
  (pi session records, 15 compactions) showed the summarizer call itself burned
  17-54% of the context it compacted (403k full-price input, cacheRead ≈
  370/call — the summarizer never hits the conversation cache) while summaries
  grew 2,010→10,464 tokens; and the needle evals (unanchored prose 0/10, hybrid
  confabulation) show summarization is lossy. Policy changes:
  (1) FIRE LINE — the economy path now fires only at the context-quality line
  `(qualityLine ?? 0.5) × window` (or once a finite tier boundary is crossed —
  regime-active, D4). qualityLine was quality-mode-only; it is now the shared
  compaction point for every mode: compaction runs while the summarizer still
  sees coherent work, the session returns to the fast low-context regime
  (performance), and retention-focused instructions ride along (quality). pi's
  uninstructed ~98% compaction remains the backstop (A4/v2.1: observed, never
  modified). floorFraction reverts to a pure permission floor. This SUPERSEDES
  v2.2's intent that "hot firing via the derived readRatio is the economy
  case" — derived readRatio pricing alone no longer triggers anywhere below
  the line.
  (2) PRICING PROVENANCE — a catalog with no positive price field disables the
  economy path entirely ("pricing-unknown"), matching the original "Model
  profiles" table (economy trigger disabled, AC-10) that the implementation
  had drifted from; explicit config defaultPrices / profile prices opt back
  in. Replaces the reviewer-rejected "×2 margin under assumed pricing".
  (3) HONEST COSTS — hot rebuild priced at resolved prices.cacheWrite
  (resolvePrices now honors explicit config/profile cacheWrite; GENERIC
  writePremium 0→1.25; gpt-5.6 profile pins 0 — OpenAI prompt caching has no
  write premium); summarizer input stays full-price (live: always cold);
  summaryTokens estimate scales ~5% of context clamped to the live-observed
  2k-10k instead of a flat 2,000.
  (4) GATE-BLIND WIRING FIX — the relevance gate now parses the task board
  from a before_agent_start capture of the per-run system prompt (which
  carries injected <session-tasks>) instead of ctx.getSystemPrompt() at
  agent_settled (which never did — the gate always recorded default-0.5 "no
  active tasks"). Task subjects now actually reach the focused/aggressive
  focus instructions.
  (5) TELEMETRY — compact_complete logs the compaction call's real usage
  (input/output/cacheRead/total from CompactionResult.usage) and
  estimatedTokensAfter, so future audits can compare claimed savings against
  real summarizer spend.

### 2026-10-04 (Option A): SC becomes the sole executor of compact-requests

Field trigger (see ../../shared/compact-request-protocol.md): at 71,869 tokens
(7% of a 1M window) context-manager's purity trigger compacted to reclaim ~870
dup tokens — ~86:1 cost-against, into a 96.9%-hot cache, milliseconds after SC
declined the same moment for `pricing-unknown`. Decision (operator, Option A):
CM is the sole PROPOSER (content purity + window-share pressure); SC is the
sole EXECUTOR and **no longer self-triggers**.

- `agent_settled` evaluates ONLY a pending `compact-request` (bus
  `pi-extensions:compact-request`); with no request it records
  `no-request (proposer contract: execute, never self-trigger)`. pi's overflow
  backstop and manual `/compact:smart` are the remaining non-request sources.
- `EvalInput.request { kind, reclaimableTokens }`: `kind: "content"` yields the
  fire/quality line to the content signal BUT keeps the floor, post-compaction
  gap, min-interval, pricing-provenance and margin guards, and bounds the
  savings `shrink` (and the tier `aboveShrink`) to the proposer's measured
  reclaimable mass — savings are only claimed for tokens the span ledger marks
  unrelated/dup/stale. `kind: "pressure"` runs the standard size-driven path.
- The fire is answered on the bus with
  `{type:"compact-decision", decision, why}`; accepted fires append the
  proposer's guidance to the focus instructions; `session_compact` clears any
  pending request (the compacted context answered it).
- Telemetry: request evaluations record under event `compact-request` with
  `request.kind` / `request.reclaimableTokens` / `request.purity`.

Tests: engine 42/42 (+4 contract), wiring 60/60 total (+2 Option A regressions:
no-request never fires; the 870-token incident declines on savings with a
`declined` ack).
