# Retired: Canonical Workplan Moved To Episodic Memory

`WORKPLAN.md` is no longer the source of truth. Do not use this file for planning or status.

The canonical `pi-extensions` workplan now lives in episodic memory.

**To recall it:** episodic memory search for project `pi-extensions`, tag
`canonical-workplan`, and take the single `active` episode (the chain head). Do
NOT hardcode an episode ID here — it drifts on every revision. The active head is
the source of truth; older entries in the chain are `superseded`.

## Current state

**P5 NL → /agents bg intent-gate workflow COMPLETE** (PR #141, commit `6d61802`). **P5b-2 zellij-terminal COMPLETE** (PR #139, commit `3c6e6b8`). **P5E1 backend selector COMPLETE** (PR #137, commit `8e41670`). **P5d cmux-control COMPLETE** (PRs #126, #128, #130, #131, #132) + **P5+ orphan reaper** bug fix merged (#134). **P5d + P5E1 + P5b-2 + P5-nl-bg closed; no next slice decided.**

- Chain head: `20260704-122521-post-merge-sync-p5-nl-agents-bg-intent-g-d94b`
- Status: active
- Revises: `20260704-104711-post-merge-sync-p5b-2-zellij-terminal-ba-edce`
- Tags include: `canonical-workplan`, `workplan`, `p5-nl-bg`, `p5-nl-bg-complete`, `background-agents`, `intent-gate`, `profile-pathway`, `post-merge-sync`, `roadmap`, `p5b-next`
- Summary: **Post-merge sync — P5 NL → /agents bg intent-gate workflow COMPLETE (#141, commit 6d61802).** Multi-layer profile pathway threaded end-to-end; codex 4-round approve. WORKPLAN.md/P3-slices drift (still at P5E1) corrected.

### Open follow-ups (none decided; details in canonical episode)
- **P5b alternative terminal backends** — zellij/wezterm/headless. Next natural; now cleanly testable from the CLI via the `--backend <name>` seam P5E1 shipped.
- **Combined `--backend` + `--profile` in `parseBgArgs`** — still first-token-only for both flags, so a single bg launch can't pick BOTH a named backend and a named profile. Acceptable for v0.1; add when a real use case appears.
- **P4R-PROJ Project Background Agents** — deferred (needs disk-backed trust reader).
- **Persistent per-project default backend** — still deferred (needs trust reader); P5E1 is per-launch only.
- **P5+ orphan reaper follow-ups**:
  - 15s poll now also calls the reaper (orphans caught in the currently-open session within 15s, not just at next restart).
  - `isAlive` seam is now `(reservation: BgReservation) => boolean | Promise<boolean>` — internal API change. Production callers use `buildReaperIsAlive` from `agents/index.ts`.
  - Post-launch `updateBgReservationOwner` failure leaves the slot active; reaper falls back to age-only. Best-effort, not user-facing.

### Pointer files
- `WORKPLAN.md` — this file.
- `agents/P3_IMPLEMENTATION_SLICES.md` — slice ladder; needs update to mark P5d complete.
- `agents/docs/P5B1_CMUX_TERMINAL_PLAN.md` — P5b-1 plan, 5-slice ladder.
- `agents/docs/P5C2_TMUX_CONTROL_TUI_AUTOMATION_PLAN.md` — P5c-2 plan (shipped).
- `agents/docs/P4_REMEDIATION_PLAN.md` — P4R v3 GO consensus.
- `TMUX_TUI_AUTOMATION.md` — research grounding (repo root).

To update it, revise/supersede the episodic memory entry instead of editing this file.
