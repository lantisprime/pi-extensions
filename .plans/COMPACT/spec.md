# COMPACT spec — smart-compaction extension

version: 2
hash-anchor: design.md@<see task pins> · research.md@<see task pins>

## Goal

pi extension that decides when/where compaction adds value (per-model cost
model: tiered pricing + prompt-cache economics) and with what summary focus
(relevance gate vs current session tasks). Never degrades availability:
pi's own compaction remains the backstop.

## Non-goals (v1)

- No custom summary generation (instructions only).
- Never returns `{cancel:true}` to pi compaction.
- No runtime settings mutation (modelOverrides are suggested, not applied).
- No web price fetching at runtime.

## Acceptance criteria

| id | criterion |
|---|---|
| AC-1 | Extension loads in pi (tui + rpc) without errors |
| AC-2 | Cost model tier pricing correct for configured models (gemini-3.1-pro 200K ×2; gpt-5.6-sol 272K ×2/×1.5) |
| AC-3 | Economy trigger compacts only at agent_settled + idle + no pending + savings>cost |
| AC-4 | Tier/overflow early-warning arms focus instructions injected via session_before_compact; never cancels pi |
| AC-5 | Economy suppressed while cache hot (< ttlShort since last LLM call) or recently warmed by pi with high continuation |
| AC-6 | Relevance gate maps to aggressive/focused/defer; focused passes customInstructions referencing active session tasks; fallback (no Jev/timeout/no tasks) → focused |
| AC-7 | /compact:smart, /compact:why, /compact:config work |
| AC-8 | Guards: null-token no-op; minInterval + tokenFloor enforced; counters reset on session_compact/_failed regardless of origin |
| AC-9 | JSONL telemetry per decision: profile id, mode, reason, estimates, gate output |
| AC-10 | Safe degradation: missing cost data, missing Jev, missing config |
| AC-11 | Profile re-resolved from live ctx.model every event; model switch resets cache state + marks token counts stale |
| AC-12 | Price-source precedence: per-model config > profile built-in > pi-ai catalog > generic default; match precedence: exact > config glob order > built-in family > generic |

## Boundaries

- Compaction quality remains pi's summarizer; this extension only times,
  focuses, and observes.
- All monetary estimates are estimates; telemetry marks them as such.

## Amendments

- 2026-09-21 v2: AC-3/4/5 reworked per GLM review (executor policy split,
  cache-warner respect, model-switch handling); AC-12 added (precedence).
