# Retired: Canonical Workplan Moved To Episodic Memory

`WORKPLAN.md` is no longer the source of truth. Do not use this file for planning or status.

The canonical `pi-extensions` workplan now lives in episodic memory.

**To recall it:** episodic memory search for project `pi-extensions`, tag
`canonical-workplan`, and take the single `active` episode (the chain head). Do
NOT hardcode an episode ID here — it drifts on every revision. The active head is
the source of truth; older entries in the chain are `superseded`.

## Active implementation (P4R Background Agents Remediation)

P7 complete. P4R is next.

- Current episode ID: `20260623-022018-p7-complete-p4r-next-background-agents-r-32bf`
- Tags include: `canonical-workplan`, `workplan`, `p4r-next`, `p7-complete`
- Summary: P7 complete, P4R next: Background Agents Remediation

### Completed tracks
- P6 Intent Routing (7 slices, PRs #50, #58, #59, #60, #61)
- P7 Prompt-Intent Gate (3 slices, PRs #64, #67, #69, #70)
- P8 Responsive Agent UX (PRs #65, #66)

### Next
- P4R-3 (manifest integrity + keyGenId) — builds first
- P4R-0 (authority-root binding — os.userInfo().homedir, not $HOME)
- P4R-1 (reservation + no-kill reaping)
- P4R-2 (tolerant listing)
- P4R-5 (MAC key lifecycle)
- P4R-6 (hygiene + docs correction)

### Active design docs

- `agents/docs/P4_REMEDIATION_PLAN.md` — v3 GO consensus. 6 remediation slices + deferred project-agents slice. All edit `agents/lib/bg-state.ts`.
- `agents/docs/P4_BACKGROUND_AGENTS_PLAN.md` — parent plan (to be corrected in P4R-6).
- `agents/docs/P5_PLUGGABLE_TERMINAL_BACKEND.md` — parallel track.

To update it, revise/supersede the episodic memory entry instead of editing this file.
