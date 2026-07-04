# Retired: Canonical Workplan Moved To Episodic Memory

`WORKPLAN.md` is no longer the source of truth. Do not use this file for planning or status.

The canonical `pi-extensions` workplan now lives in episodic memory.

**To recall it:** episodic memory search for project `pi-extensions`, tag
`canonical-workplan`, and take the single `active` episode (the chain head). Do
NOT hardcode an episode ID here — it drifts on every revision. The active head is
the source of truth; older entries in the chain are `superseded`.

## Current state

**P5b-2 zellij-terminal backend COMPLETE** (PR #139, commit `3c6e6b8`). **P5E1 backend selector COMPLETE** (PR #137, `8e41670`). **P5d cmux-control COMPLETE** (PRs #126, #128, #130, #131, #132) + **P5+ orphan reaper** bug fix merged (#134). **P5d + P5E1 + P5b-2 closed; no next slice decided.**

- Chain head: `20260704-104711-post-merge-sync-p5b-2-zellij-terminal-ba-edce`
- Status: active
- Revises: `20260704-083722-post-merge-sync-p5e1-backend-selector-co-64a1`
- Tags include: `canonical-workplan`, `workplan`, `p5b`, `p5b-2`, `p5b-2-complete`, `zellij`, `zellij-terminal`, `terminal-backend`, `post-merge-sync`, `roadmap`, `p5b-3-next`
- Summary: **Post-merge sync — P5b-2 zellij-terminal backend COMPLETE (#139).** P5d + P5E1 + P5b-2 closed; next natural: wezterm/headless backends or NL→`/agents bg` intent-gate.

### Open follow-ups (none decided; details in canonical episode)
- **P5b-3 wezterm-terminal** / **P5b-4 headless** — same pattern as zellij; the spike/plan/implement/review workflow is now proven for a third backend. Wezterm is the next analog (GUI terminal with a CLI).
- **`zellij-control` extension** — feasible (the spike confirmed `action send-keys`/`dump-screen` cover the tmux-control surface); separate slice.
- **NL → `/agents bg` intent-gate workflow** — needs `background` workflow kind in `intent-gate.ts`; can emit `--backend <name>`.
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
