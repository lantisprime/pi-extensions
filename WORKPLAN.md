# Retired: Canonical Workplan Moved To Episodic Memory

`WORKPLAN.md` is no longer the source of truth. Do not use this file for planning or status.

The canonical `pi-extensions` workplan now lives in episodic memory.

**To recall it:** episodic memory search for project `pi-extensions`, tag
`canonical-workplan`, and take the single `active` episode (the chain head). Do
NOT hardcode an episode ID here — it drifts on every revision. The active head is
the source of truth; older entries in the chain are `superseded`.

## Active implementation (P7 Prompt-Intent Gate)

P7 in progress — 2 of 3 slices complete.

- Current episode ID: `20260621-142943-p7-1-p7-2-merged-pr-64-67-p7-3-regex-mat-2875`
- Tags include: `canonical-workplan`, `workplan`, `p7`, `p7-3-next`, `p4r-deferred`
- Summary: P7-1 + P7-2 merged (PR #64, #67); P7-3 regex matching next

### Completed P7 slices
- P7-1: Config loader + phrase matcher + gate decision engine (PR #64, 8d06a9c)
- P7-2: Input hook wiring + confirm flow + disableContextFiles (PR #67, 4d61dcd)

### Next
- P7-3: Regex matching under timeout + metadata (4 tests planned)

### Completed tracks
- P6 Intent Routing (7 slices, PRs #50, #58, #59, #60, #61)
- P8 Responsive Agent UX (PR #65, #66)

## Active design docs (track 2)

- `agents/docs/P4_REMEDIATION_PLAN.md` — **GO** (cross-model consensus). Gates P4-2/P4-3. Awaiting build (Rule 18 step 4).
- `agents/docs/P4_BACKGROUND_AGENTS_PLAN.md` — parent plan (to be corrected in P4R-6).
- `agents/docs/P5_PLUGGABLE_TERMINAL_BACKEND.md` — parallel track.

To update it, revise/supersede the episodic memory entry instead of editing this file.
