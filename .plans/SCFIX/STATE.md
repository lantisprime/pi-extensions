# SCFIX — open state (2026-10-14, handoff before session reload)

> **RESOLVED 2026-10-14 (SCFIX-1 settled).** Claim 1 verified and fixed:
> catalog resolution traced (gateway `models.json` prices 1/75 models;
> `/model/info` prices 0), skip confirmed FAIL-CLOSED (`economy` declines
> `pricing-unknown`), live telemetry showed 133 such declines across
> glm-5.3-zai/-flash-zai/-opencode, cerebras, qwen3.8-flash-next. Fix:
> provenance-aware `resolvePricing` (catalog → config → new `BUILTIN_PRICES`
> family table sourced from OpenRouter's public list, 2026-10-06 → assumed
> generic), `refreshModel` wiring now honors config opt-ins, `/compact:why`
> prints the price source. Fleet pricingKnown 1/75 → 68/75. Tests 68/68
> (engine +6, wiring +2 LESSON-1 regressions). Design Amendment 6 in
> `.plans/COMPACT/design.md`. Claim 2 remains flagged for the PR #187 review
> (EMBJUDGE scope, not SCFIX) — see below.

## The report to verify (from operator, unverified when session ended)

> "pi's smart compaction still skips every decision because it finds no pricing
> for glm-5.3-zai. Your kev switch changed its judge."

Two claims, BOTH still unverified:

1. **Pricing skip**: `smart-compaction/lib/engine.ts:221` has a documented
   `why: "pricing-unknown (catalog has no positive price fields; set
   config.defaultPrices or a profile prices block to opt in)"` path, and
   `profiles.ts:275` notes LiteLLM proxies report `{0,0,0,0}` for unpriced
   models. NOT yet confirmed that glm-5.3-zai hits this (didn't get to check
   the catalog resolution or telemetry before reload). Check:
   - how the price catalog is resolved (config? bundled table? gateway?)
   - grep smart-compaction telemetry in the affected session's cwd for
     `pricing-unknown`
   - read engine.ts ~180-260 for what "skip" means (fail-open vs fail-closed)
2. **"Kev switch changed its judge"**: only true for sessions that loaded
   extensions while the working tree was on `feat/kev-judge-backend`. That
   branch (PR #187, unmerged at handoff) repoints
   `smart-compaction/lib/gate.ts` DEFAULT_ENDPOINT to the kev passthrough.
   Since the TypeSafe 402 outage the gate had been on its keyword-heuristic
   fallback anyway; kev switches it to noul-primary WITHOUT any
   judge.backends-style guardrail (context-manager got M12; smart-compaction
   did NOT — spec gap, flag in review of #187). Given the corpus evidence
   (kev nouls over-trigger; drift P 0.625), the gate should probably default
   heuristic + kev opt-in, same as context-manager.

## Repo state at handoff

- Working tree: branch `fix/seat-hard-deny-seat-only` @ a599393 (PR #188,
  seat hard-denies seat-only). Tree clean. EXTENSIONS SYMLINK FOLLOWS THIS
  TREE — reloading pi in this repo loads: permission fix ✓, kev switch ✗.
- PR #187 `feat/kev-judge-backend` (kev judge backend) — open, unmerged.
- Unmerged consequence of branch-jumping: extension behavior differs per
  checked-out branch. After merging both PRs: `git switch main && git pull`.
- Operator's unrelated unpushed branch untouched: `fix/prompt-shield-dialog-blocked-reporting`.

## Session task set

- EMBJUDGE 1–6: settled (kev backend, per-site guardrails, eval raw+sweep).
- PERMFIX-1: settled (PR #188).
- SCFIX-1: CREATED, NOT STARTED — "Fix glm-5.3-zai pricing miss breaking
  smart-compaction decisions". Evidence rules per tasks skill; this file is
  the durable anchor for it.
