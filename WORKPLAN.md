# Retired: Canonical Workplan Moved To Episodic Memory

`WORKPLAN.md` is no longer the source of truth. Do not use this file for planning or status.

The canonical `pi-extensions` workplan now lives in episodic memory.

**To recall it:** episodic memory search for project `pi-extensions`, tag
`canonical-workplan`, and take the single `active` episode (the chain head). Do
NOT hardcode an episode ID here — it drifts on every revision. The active head is
the source of truth; older entries in the chain are `superseded`.

## Active implementation (P4 + P5 fully shipped with real-tmux fixes)

P4 Background Agents (P4R + P4-2..P4-7) and P5 Pluggable Terminal Backend are merged.

- Current episode ID: `20260627-085754-p5-fully-shipped-post-merge-fixes-d5-d6--2ee6`
- Tags include: `canonical-workplan`, `workplan`, `p4r-complete`, `p5-merged`, `p5-pr-98`, `p5-pr-100`, `p5-d5-d6-fix`
- Summary: P5 fully shipped with post-merge fixes (D5 isAvailable probe + D6 node prefix) via PR #100 commit 4f4339b. Real-tmux smoke test now in CI. Next natural: P5b (zellij/wezterm/headless) or P4R-PROJ deferred.

### Completed tracks
- P6 Intent Routing (7 slices, PRs #50, #58, #59, #60, #61)
- P7 Prompt-Intent Gate (3 slices, PRs #64, #67, #69, #70)
- P8 Responsive Agent UX (PRs #65, #66)
- P4R Background Agents Remediation (6 slices, PRs #72, #73, #75, #76, #77, #78)
- P4-2 Preflight: signed identity manifest (PR #81)
- P4-3 Worker: background-agent worker process (PR #82)
- P4-4 Terminal backend interface (bg-terminal.ts, PR #88, commit 8e2f596)
- P4-5 Command wiring (/agents bg commands, PR #91)
- P4-6 Status line (PR #96)
- P4-7 Integration tests (PR #97, commit bea9eb0)
- P5 Pluggable Terminal Backend (tmux-terminal extension, PR #98, commit f3b247c)

### Next
(none currently open)

### Deferred
- P4R-PROJ Project Background Agents (requires disk-backed trust reader)
- Alternative terminal backends: zellij-terminal, wezterm-terminal, headless-backend
- Multiple-backend selection via --backend flag (deferred until 2+ backends ship)

### Active design docs

- `agents/docs/P4_REMEDIATION_PLAN.md` — v3 GO consensus. 6 remediation slices + deferred project-agents slice. All edit `agents/lib/bg-state.ts`.
- `agents/docs/P4_BACKGROUND_AGENTS_PLAN.md` — parent plan (to be corrected in P4R-6).
- `agents/docs/P5_PLUGGABLE_TERMINAL_BACKEND.md` — parallel track.

To update it, revise/supersede the episodic memory entry instead of editing this file.
