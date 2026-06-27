# Retired: Canonical Workplan Moved To Episodic Memory

`WORKPLAN.md` is no longer the source of truth. Do not use this file for planning or status.

The canonical `pi-extensions` workplan now lives in episodic memory.

**To recall it:** episodic memory search for project `pi-extensions`, tag
`canonical-workplan`, and take the single `active` episode (the chain head). Do
NOT hardcode an episode ID here — it drifts on every revision. The active head is
the source of truth; older entries in the chain are `superseded`.

## Active implementation (P4R + P4-2 + P4-3 complete; P4-4 next)

P4R Background Agents Remediation and P4-2/P4-3 (preflight + worker) are merged.

- Current episode ID: `20260627-074606-p5-plan-v5-cleared-for-implementation-un-7031`
- Tags include: `canonical-workplan`, `workplan`, `p4r-complete`, `p5-cleared-for-impl`, `p5-unconditional-go`, `p5-v5-drafted`, `p5-b2a-fix`, `p5-macos-realpath-fix`
- Summary: P5 plan v5 CLEARED for implementation (UNCONDITIONAL-GO); 5 rounds of review complete; 22 reqs, 63 tests, 16 mechanical steps ready. P4R/P4-2..P4-7 all merged.

### Completed tracks
- P6 Intent Routing (7 slices, PRs #50, #58, #59, #60, #61)
- P7 Prompt-Intent Gate (3 slices, PRs #64, #67, #69, #70)
- P8 Responsive Agent UX (PRs #65, #66)
- P4R Background Agents Remediation (6 slices, PRs #72, #73, #75, #76, #77, #78)
- P4-2 Preflight: signed identity manifest (PR #81)
- P4-3 Worker: background-agent worker process (PR #82)

### Next
- P4-4 Terminal backend interface (bg-terminal.ts — TermBgBackend interface + registry)
- P4-5 Command wiring (index.ts — /agents bg, bg-status, bg-stop, bg-result, bg-open)
- P4-6 Status line (running agent count)
- P4-7 Integration tests (fake backend, 30 tests)

### Parallel
- P5 Pluggable Terminal Backend (independent track, separate extension)

### Active design docs

- `agents/docs/P4_REMEDIATION_PLAN.md` — v3 GO consensus. 6 remediation slices + deferred project-agents slice. All edit `agents/lib/bg-state.ts`.
- `agents/docs/P4_BACKGROUND_AGENTS_PLAN.md` — parent plan (to be corrected in P4R-6).
- `agents/docs/P5_PLUGGABLE_TERMINAL_BACKEND.md` — parallel track.

To update it, revise/supersede the episodic memory entry instead of editing this file.
