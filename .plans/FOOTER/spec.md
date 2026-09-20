---
name: FOOTER — context-used status item
version: 1.1.0
status: draft
updated: 2026-09-20
summary: >
  Add a pi extension `extensions/context-used-status.ts` that renders the ACTUAL
  context tokens used (from ctx.getContextUsage()) as a status item in the
  default footer via ctx.ui.setStatus. Never re-implements the footer; default
  footer info (cwd/branch/model/cache/cost/thinking) must remain intact.
---

# FOOTER — context-used status item

## Goal

Show the actual context-window tokens used by the current session as a colored
status item in pi's footer, via `ctx.ui.setStatus("context-used", ...)`.
Data source is `ctx.getContextUsage()` which returns
`{ tokens: number | null; contextWindow: number; percent: number | null } | undefined`.

## Non-goals

- Do **not** use `setFooter` — it replaces the built-in footer component and
  would regress cwd/branch/model/cost/thinking rendering.
- Do not re-derive token counts from `sessionManager.getEntries()`; use the
  provider's number (it already combines last assistant usage + trailing estimate).
- No cost, cache-rate, or session-total display (default footer / other tools cover it).
- No compaction trigger or threshold-based automation — display only.
- No widget, no dialogs — one footer status line, nothing else.

## Acceptance criteria

| ID | Criterion |
|----|-----------|
| AC-1 | Status item renders context usage in a compact format. Format chosen from candidates below (decision via FOOTER-2 jev run, pinned in design note): (a) `ctx 42.3k/200k (21%)`, (b) `ctx 21% (42.3k/200k)`, (c) `ctx 21%`, (d) `ctx 21% · 42.3k`. Uses real values from `ctx.getContextUsage()`. |
| AC-2 | Null/unknown fallback: when `getContextUsage()` is `undefined` or `tokens`/`percent` are `null` (e.g. right after compaction, before next LLM response), the item shows a graceful fallback text (`ctx –`) instead of crashing or rendering `null`/`NaN`. |
| AC-3 | Colorization by percent of context window: `<70%` → `dim`/`muted`, `70–89.99%` → `warning`, `≥90%` → `error` (theme colors via `ctx.ui.theme.fg`). Null tokens → `dim`. |
| AC-4 | Reactivity: value refreshes on `session_start`, `turn_end`, `session_compact`, and `model_select`; a registered `/context-used` command toggles the item on/off (default on) and clears the status when off. |
| AC-5 | No regression: extension loads via `pi -e extensions/context-used-status.ts` without errors; default footer content (cwd, branch, model, cost, thinking) still renders; status line appears alongside, not instead. |

## Boundaries

- Single file: `extensions/context-used-status.ts`, TypeScript, same style as
  bundled examples (`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"`).
- No new dependencies, no filesystem/network access, no background timers.
- Works in TUI mode; must be a silent no-op risk in print/RPC modes (setStatus is
  fire-and-forget in RPC, no-op in print — acceptable).

## Amendments

<!-- append-only; dated entries with reason; bump version above -->

- **2026-09-20 ADDED (design decisions, FOOTER-2 jev run jev-1.13.0 over spec@21a9cebc):**
  - AC-1 format resolved to candidate **(b)** `ctx 21% (42.3k/200k)` — percent first,
    tokens/window in parens (p=0.50; d=0.38 close second; c loses absolute scale).
  - AC-2 fallback resolved to **dim `ctx –`** placeholder (p=0.56; hide=0.31 rejected —
    slot stability preferred so the item doesn't pop in/out around compaction).
  - AC-3 colorization resolved to **whole-item coloring** by threshold (p=0.59):
    the entire status string is themed (dim <70, warning 70–89.99, error ≥90, dim when null).
  - Numbers formatting: tokens rendered as compact `42.3k` (1 decimal, k) or raw when
    < 1000; percent as integer `21%`.
- **2026-09-20 ADDED (delivery note, CTXTOT follow-up):** In the operator's live
  setup the footer is owned by `monitor-threads`' custom `setFooter` layout, so
  the context-window TOTAL (`ctx N%/1m`) was delivered there
  (monitor-threads/lib/telemetry.ts `FooterInput.contextWindow` + segment; index.ts
  passes the already-computed window). `extensions/context-used-status.ts` remains
  the opt-in status item for stock-footer setups (loaded via `-e`), unchanged.
