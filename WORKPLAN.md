# Retired: Canonical Workplan Moved To Episodic Memory

`WORKPLAN.md` is no longer the source of truth. Do not use this file for planning or status.

The canonical `pi-extensions` workplan now lives in episodic memory.

**To recall it:** episodic memory search for project `pi-extensions`, tag
`canonical-workplan`, and take the single `active` episode (the chain head). Do
NOT hardcode an episode ID here — it drifts on every revision. The active head is
the source of truth; older entries in the chain are `superseded`.

## Active implementation (P6 Intent Routing)

- **PR #50 merged.** P6-1 (intent router core), P6-0a (getPiInvocation), P6-0b (role→system-prompt transport) on main.
- **P6-2 merged (cc5ca7c).** LLM classifier spawn + heuristic fallback on main. Next: P6-3a (pure runResolvedTarget extraction).
- **P6 plan:** `agents/docs/P6_INTENT_ROUTING_PLAN.md` — executor-ready, 5 review passes.

## Active design docs (track 2)

- `agents/docs/P4_REMEDIATION_PLAN.md` — **GO** (cross-model consensus). Gates P4-2/P4-3. Awaiting build (Rule 18 step 4).
- `agents/docs/P4_BACKGROUND_AGENTS_PLAN.md` — parent plan (to be corrected in P4R-6).
- `agents/docs/P5_PLUGGABLE_TERMINAL_BACKEND.md` — parallel track.

To update it, revise/supersede the episodic memory entry instead of editing this file.
