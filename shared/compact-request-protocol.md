# Compact-request protocol

Amended 2026-10-04, after the 7%-window incident: context-manager fired a
compaction at 71,869 prompt tokens (7% of the window) to reclaim ~870 duplicate
tokens — an ~86:1 cost-against trade, executed into a 96.9%-hot cache. Root
cause: CM's share-only purity trigger had no absolute-mass awareness, no
pricing, and no savings arithmetic; smart-compaction had declined the same
moment for `pricing-unknown`.

## Contract

**CM proposes; SC disposes.** Exactly one extension calls `ctx.compact()`.

- Channel: `pi.events`, channel name `pi-extensions:compact-request`.
- **context-manager (proposer)** — emits `compact-request`, never compacts:

```ts
{
	type: "compact-request",
	kind: "content" | "pressure",   // impurity mass vs window share
	sessionId: string | null,
	purity: number,                  // 0..1 over the span ledger
	reclaimableTokens: number,       // unrelated + dup + stale, in TOKENS
	breakdown: { unrelatedTok, dupTok, staleTok, totalTokens },
	view: { shapedTokens, baselineTokens },   // shaping pressure correction
	cache: { chPct: number | null, missCause: string | null },
	taskSwitch: { staged: boolean, driftSource: string | null },
	suggestedInstructions: string,   // the WHAT (CM's B4-locked default rides here)
	ts: string,
}
```

- **smart-compaction (executor)** — prices every request through its existing
  economy guards (pricing provenance, `savings > cost × margin`, hot-cache,
  window floor, min-interval) and either fires `ctx.compact()` or replies:

```ts
{ type: "compact-decision", decision: "accepted" | "declined", why: string }
```

CM records the decision in turn telemetry (`request` field).

## Guarantees

| Guarantee | Where |
|---|---|
| Sub-economy reclaimable never requests | CM `compactRequest.minReclaimableTokens` (default 8000) — content kind only; the 2026-10-04 incident class dies here |
| Window pressure still surfaces | CM pressure watch: `tokens ≥ pressureFraction × window` (default 0.5) emits `kind: "pressure"`; SC's fire-line economics still decide |
| One proposer, one executor | CM's `triggerCompact` (ctx.compact path) is deleted; pi overflow + manual `/compact` remain as backstops |
| Any-origin reset | CM listens to `session_before_compact` (arms shaping bypass for the summarizer's forced-prompt calls) and `session_compact` (ledger/shaping reset, cooldown anchor, B6 arm) — the coordination bug that kept stale purity alive across SC/user/overflow compactions |
| Spacing | `compactRequest.retryTurns` (default 4) between request emissions; cooldown anchored to the last observed compaction |
| Fail-open floor unchanged | Unknown prompt size still requests (AC-21); the executor's fail-safe usage guards arbitrate |

## Config (`context-manager`)

```jsonc
{
	"compactRequest": {
		"enabled": true,             // false = CM never requests (pure shaping)
		"pressureFraction": 0.5,     // window share that trips pressure requests
		"minReclaimableTokens": 8000,
		"retryTurns": 4
	}
}
```

`purityBudget` keeps its elision-tier semantics only; it no longer drives
compaction directly.
