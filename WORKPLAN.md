# Retired: Canonical Workplan Moved To Episodic Memory

`WORKPLAN.md` is no longer the source of truth. Do not use this file for planning or status.

The canonical `pi-extensions` workplan now lives in episodic memory.

**To recall it:** episodic memory search for project `pi-extensions`, tag
`canonical-workplan`, and take the single `active` episode (the chain head). Do
NOT hardcode an episode ID here — it drifts on every revision. The active head is
the source of truth; older entries in the chain are `superseded`.

## Current state

**P5d cmux-control COMPLETE** (PRs #126, #128, #130, #131, #132) + **P5+ orphan reaper** bug fix merged (#134, codex v4 READY-TO-MERGE). **P5d closed; no next slice decided.**

- Chain head: `20260704-054011-post-merge-sync-p5d-cmux-control-complet-7ea6`
- Status: active
- Revises: `20260703-153507-p5d-s3-merged-130-s4-pending-131-next-s5-a257`
- Tags include: `canonical-workplan`, `workplan`, `p5d-s1-s2-s3-s4-s5-merged`, `p5d-complete`, `p5-plus-orphan-reaper-merged`, `cmux-control`, `post-merge-sync`
- Summary: **Post-merge sync — P5d cmux-control COMPLETE.** S1 (#126) + S2 (#128) + S3 (#130) + S4 (#131) + S5 (#132) merged. P5+ orphan reaper bug fix (#134) merged. P5d closed.

### Open follow-ups (none decided; details in canonical episode)
- **P5b alternative terminal backends** — zellij/wezterm/headless. Next natural after P5d.
- **`--backend` selector** — now timely (2+ backends ship: tmux-terminal, cmux-terminal).
- **NL → `/agents bg` intent-gate workflow** — needs `background` workflow kind in `intent-gate.ts`.
- **P4R-PROJ Project Background Agents** — deferred (needs disk-backed trust reader).
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
