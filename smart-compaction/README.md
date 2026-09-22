# smart-compaction

Self-aware, cost-aware compaction timing for pi. Per-model profiles decide
**when** compacting pays (tiered pricing boundaries, prompt-cache hot/cold
economics) and **what** the summary should focus on (relevance gate vs the
current session tasks, via Jev with a heuristic fallback).

- Spec: `.plans/COMPACT/spec.md` · Design: `.plans/COMPACT/design.md` · Research: `.plans/COMPACT/research.md`
- Status line: `sc <pct>% <mode>` standalone, or published to context-manager's consolidated `ctx-suite` segment when present (see `shared/status-line-protocol.md`) · Commands: `/compact:smart`, `/compact:why`, `/compact:config`
- Telemetry: JSONL at `~/.pi/agent/cache/smart-compaction/`

## Policy (v2)

- **Never cancels** pi's own compaction; pi stays the overflow backstop.
- Economy compaction fires **only at `agent_settled` + idle** and only when
  estimated savings exceed cost × 1.25. Hot caches (recent LLM call, same
  model) are protected: carrying context while cached costs ~10% of input,
  while compaction pays a write premium (1.25× on Anthropic).
- pi's cache warmer is respected: its `continuationProbability` gates savings.
- Quality mode (free local models): compact at a fixed window line at settled
  time; cache math skipped.
- Focus instructions attach only to compactions this extension initiates;
  gate mapping: p<0.35 aggressive · 0.35–0.70 focused · >0.70 defer.

## Config

`~/.pi/agent/smart-compaction.json` and/or `<project>/.pi/smart-compaction.json`:

```json
{
  "enabled": true,
  "reserveTokens": 16384,
  "continuationProbability": 0.7,
  "tierSafety": 1.5,
  "defaultPrices": { "input": 1.0, "output": 3.0, "cacheRead": 0.1, "cacheWrite": 0 },
  "profiles": [
    {
      "match": "litellm/minimax",
      "mode": "cost",
      "prices": { "input": 0.3, "output": 1.2, "cacheRead": 0, "cacheWrite": 0 },
      "tiers": [{ "upTo": 200000, "inputMult": 1, "outputMult": 1 }, { "upTo": 1e9, "inputMult": 2, "outputMult": 1.5 }],
      "cache": { "readRatio": 0.1, "writePremium": 0, "ttlShort": 300, "ttlLong": 3600 },
      "compaction": { "tokenFloor": 40000, "minIntervalTurns": 4 },
      "gate": { "enabled": true, "aggressiveBelow": 0.35, "deferAbove": 0.7 }
    }
  ]
}
```

Built-in families: `gemini-*-pro*` (200K ×2 tier, cost), `gpt-5.6-sol*` (272K
×2/×1.5, cost), `claude-*` (flat price, 1.25× cache writes, balanced),
`*local_mlx`/`*inferx` (quality). Resolution: config exact → config globs in
order → built-in → generic (AC-12).
