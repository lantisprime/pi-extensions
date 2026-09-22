# COMPACT research: context cost tiers, prompt caching, compaction timing

Researched 2026-09-20 via SearXNG + pi's bundled model catalogs.

## 1. The "cost doubles" claim — confirmed, but per-model

Tiered long-context pricing (input rate ~2x above a boundary):

| Model | Boundary | Input ≤ | Input > | Output ≤ | Output > | Source |
|---|---|---|---|---|---|---|
| Gemini 2.5 Pro | 200K | $1.25/M | $2.50/M | $10/M | $15/M | ai.google.dev, intuitionlabs.ai |
| Gemini 3 Pro | 200K | $2/M | $4/M | $12/M | $18/M | inventivehq, ArtificialAnlys |
| Gemini 3.1 Pro | 200K | $2/M | $4/M | $12/M | $18/M | spheron.network, geotoolbox.ai |
| GPT-5.6 Sol | 272K | $4/M | 2x | $20/M | 1.5x | developers.openai.com/api/docs/models/gpt-5.6-sol |
| Azure GPT-5.4 (<272k vs ≥) | 272K | $2.75/M | $5.50/M | $16.50/M | $33/M | azure.microsoft.com pricing |
| Claude Sonnet 4.x 1M (beta era) | 200K | $3/M | $6/M | $15/M | $22.50/M | zenmux.ai, starkinsider.com |
| Claude 1M GA (2026) | — | unified, no long-context premium | | | | claudefa.st |

Takeaways:
- The doubling is **per-model data, not a universal rule** → plugin needs a per-model tier table (config-driven, with the pi-ai catalog as base).
- Flat-rate assumptions understate long-context spend by ~50% (sitepoint.com tiered-pricing article; Gemini 300k workload overspends ~$125/day per 1k req/day).
- Claude (per pi-ai catalog in this install): Sonnet/Opus/Fable 1M-context models exist with **flat** cost fields — pi's `cost` record has no tiers; our plugin adds them as config.

## 2. Prompt caching economics (the decisive lever)

Rates from pi-ai catalog (`cost.cacheRead` / `cost.cacheWrite`, per MTok):

| Model | input | cacheRead | cacheWrite | read/write ratio |
|---|---|---|---|---|
| claude-sonnet-4-5 | $3 | $0.30 | $3.75 | 10% read, 125% write |
| claude-opus-4-5 | $5 | $0.50 | $6.25 | 10% / 125% |
| claude-sonnet-5 | $2 | $0.20 | $2.50 | 10% / 125% |
| gpt-5 | $1.25 | $0.125 | $0 (auto) | 10% read, no write premium |
| gemini-2.5-pro | $1.25 | $0.125 | $0 | 10% read |
| gemini-3.1-pro-preview | $2 | $0.20 | $0 | 10% read |

- Cache TTLs in pi-ai: Anthropic `promptCache: {short: 300s, long: 3600s}` (5 min / 1 h). OpenAI/Gemini similar order (~5 min typical).
- **Compaction destroys the cached prefix.** Every call after compaction re-pays cache-write (1.25x on Claude) on the kept prefix + summary, vs 0.1x cache reads it was enjoying. Sources: linkedin.com (Avi Chawla) "Compacting an agent's context can STILL raise costs due to prefix caching"; bhavishyapandit9.substack.com "reads bill at 10% of base input price"; hidekazu-konishi.com (Anthropic caching guide).
- Cache break-even hit ratio is tiny (1.4% for 200K ctx × 100 req on Anthropic — sitepoint) → caching is always worth keeping; **compacting a hot cache is the worst move**; compacting a **cold** cache (idle > TTL) costs almost nothing extra in cache terms.
- Marginal cost of one more turn ≈ cached-read of full context (cheap) + uncached delta + output. Cost explosion happens at: (a) tier boundary crossing (2x on everything, cache included), (b) cache expiry after idle (full-price re-read of whole context), (c) context-rot quality loss.

## 3. Compaction timing findings

- Anthropic: compact "nearing the context window limit"; Claude Code compacted ~200K mark pre-1M-GA (reddit r/ClaudeCode thread confirms compaction is the hidden cost driver).
- Morph (morphllm.com): argues to compact *before* every call rather than at the cliff — but this ignores cache-write amortization; valid only when cache is cold or tier-2 pricing dominates.
- Oracle (blogs.oracle.com): agent loop economics ride on prefix caching; don't break the prefix needlessly.
- Factory.ai: summarization span grows with each turn — earlier compaction = cheaper summaries but more of them (and more cache invalidations).
- pi's built-in trigger: `contextTokens > contextWindow - reserveTokens` (reserve default 16384), checked after tools finish / before next assistant response, before a new user prompt, and after a run ends. `keepRecentTokens` default 20000.
- Reddit/LinkedIn consensus: compaction trades a **one-time** summarization cost for a **permanently smaller carried context**; the win is real only past the break-even.

## 4. Break-even math for the plugin (derived)

Compact NOW (at turn end, agent settled) iff expected savings > compaction cost:

```
compactionCost ≈ tokensBefore × inputPrice(boundary-aware)        [summary generation input]
               + summaryOut × outputPrice
               + keptTokens × cacheWritePremium                    [prefix rebuild, if cache hot]
savings        ≈ Σ future turns [ (ctxBefore − ctxAfter) × effectiveInputPrice ]
                 + tierSaving (avoid 2x rates on everything above boundary)
                 + coldCacheBonus (idle > TTL: cacheWritePremium = 0 anyway → compact free)
```

Rules that fall out:
1. **Never compact mid-task with a hot cache unless a tier boundary is imminent** (savings must beat write premium).
2. **Best moment: after `agent_settled`** (task done, user likely idle → cache may go cold anyway → compaction is nearly free and next turn starts cheap + in tier 1).
3. **Before crossing a tier boundary**: if projected next-turn context > tier threshold, compact first — every token above the boundary costs 2x on every subsequent call.
4. **Before window exhaustion** (pi's own threshold): non-negotiable fallback (overflow risk).
5. Keep summaries task-relevant: pass focus instructions (pi supports `customInstructions` in `ctx.compact()` and in `session_before_compact`).

## 5. Data available at runtime (pi ExtensionAPI)

- `ctx.getContextUsage()` → `{tokens, contextWindow, percent}` (tokens null right after compaction)
- `ctx.model` → model record incl. `contextWindow`, `cost{input,output,cacheRead,cacheWrite}`, `promptCache{short,long}`
- `ctx.compact({customInstructions, onComplete, onError})` → programmatic compaction
- `session_before_compact` event → `preparation{messagesToSummarize, tokensBefore, firstKeptEntryId, previousSummary, settings}`, `reason: "manual"|"threshold"|"overflow"`; may return `{cancel:true}` or custom `compaction{summary,...}`
- `turn_start/turn_end`, `agent_start/agent_end/agent_settled`, `session_compact(_failed)`
- `pi.registerCommand(name, {...})` → e.g. `/compact:smart`, `/compact:why`
- User's `~/.pi/agent/models.json` (homelab LiteLLM): most models lack `cost` → plugin needs config fallbacks (default price table + per-model overrides).

## 6. Sources

- https://ai.google.dev/gemini-api/docs/pricing
- https://developers.openai.com/api/docs/models/gpt-5.6-sol (>272K → 2x input, 1.5x output)
- https://azure.microsoft.com/en-us/pricing/details/azure-openai/ (GPT-5.4 272k tier)
- https://www.sitepoint.com/modeling-llm-context-costs-tiered-pricing-beyond-200k-tokens/ (tier table, cache break-even 1.4%, $125/day overspend)
- https://www.spheron.network/blog/token-cost-scaling-context-window-2026/ (Gemini 3.1 Pro $2→$4)
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents (compaction practice)
- https://platform.claude.com/docs/en/about-claude/pricing
- https://claudefa.st/blog/guide/mechanics/1m-context-ga (Claude 1M GA unified pricing)
- https://www.linkedin.com/posts/avi-chawla_compacting-an-agents-context-can-still-raise-activity-7496903893767888896-aGBc (cache + compaction cost trap)
- https://www.morphllm.com/llm-cost-optimization (compact-before-cliff argument)
- https://blogs.oracle.com/developers/the-agent-loop-decoded-three-levels-every-agent-engineer-must-know (prefix caching in agent loop)
- https://www.reddit.com/r/ClaudeCode/comments/1rsva0y/ (compaction as hidden cost, 200K mark)
- pi docs: docs/compaction.md, docs/extensions.md; pi-ai catalogs: dist/providers/data/{anthropic,openai,google}.json
- Local: ~/.pi/agent/models.json (homelab LiteLLM gateway — cost data sparse)
