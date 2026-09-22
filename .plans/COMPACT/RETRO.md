# COMPACT retro — lessons from building smart-compaction (2026-09-21)

Durable lessons from this task set. Cross-session copies: episodic-memory ids
`20260921-223512` (delegation verification), `20260921-223548` (wiring tests),
`20260921-223549` (pi compaction API facts). Working rules also in AGENTS.md.

## 1. Reviews find what green tests cannot (the defer-wedge)

14/14 unit tests passed while `index.ts` carried a **blocker**: `rt.compacting`
was set before the relevance gate and a `defer` early-return never reset it —
one deferred compaction permanently disabled the trigger. The GLM review found
it in minutes. Root cause of the miss: unit tests covered the pure engine
(`lib/engine.ts`), not the handler state machine in `index.ts`.

**Permanent countermeasures:**
- `test/wiring.test.ts` — mock-ExtensionAPI harness driving the real handler
  map; regression tests for the wedge and for counter resets. Any future
  wiring/state bug gets a test here, not only a code fix.
- Guard-flag mutations must sit immediately adjacent to the async handoff they
  guard (`rt.compacting = true` only immediately before `ctx.compact()`).

## 2. Review the implementation, not the draft — and verify the reviewer

- Reviewing only the v1 design let v2 amendments + code drift unreviewed. The
  re-review (against the actual code) found a **major** cost-math inflation
  (`tierAvoided` charged the whole shrink at tier-2 rates, ~5.6×) plus a cold-path
  double-count — both confirmed by hand before fixing.
- Delegation discipline (earned the hard way): a delegate once ran on the wrong
  model, a later review run timed out silently. Rules: verify the delegate's
  model (launch cmd / self-report) **before** submitting; never report a
  delegated result without reading its output; keep delegate scope small enough
  to finish (8 files timed out at 300s; 2 files took 150s); spot-check at least
  one file:line claim before acting.

## 3. Design docs must bend when the API says no

`SessionBeforeCompactResult` has no `customInstructions` — the planned
"inject instructions into pi-initiated compactions" was impossible. The
implementation silently redefined A1 in a header comment instead of amending
the design. Fixed: design.md v2.1 correction (append-only), header comment now
matches the amendment. Rule: when implementation proves a design line wrong,
amend the design doc in the same change set.

## 4. Domain facts worth keeping

- `SessionBeforeCompactResult` = `{cancel?, compaction?}` only.
- `ctx.getContextUsage().tokens` is null right after compaction.
- pi emits `cache_warming_decision` with `continuationProbability` — respect it
  or you'll fight pi's cache warmer.
- pi-ai model catalogs carry flat `cost` fields only; long-context tiers are
  extension-config territory.
- Homelab models.json entries mostly lack `cost` — profile/config fallbacks are
  mandatory (generic profile disables economy when prices are unknown).

## Verdict

Shipped: trigger engine + profiles + gate + telemetry, 22/22 tests, tsc clean,
E2E compaction fired and verified. Cost-math is now second-review-verified.
