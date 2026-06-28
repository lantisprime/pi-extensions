# Retired: Canonical Workplan Moved To Episodic Memory

`WORKPLAN.md` is no longer the source of truth. Do not use this file for planning or status.

The canonical `pi-extensions` workplan now lives in episodic memory.

**To recall it:** episodic memory search for project `pi-extensions`, tag
`canonical-workplan`, and take the single `active` episode (the chain head). Do
NOT hardcode an episode ID here — it drifts on every revision. The active head is
the source of truth; older entries in the chain are `superseded`.

## Active implementation (P5c-2-S1 + S2 + S3 MERGED into main + P5b/P5d still OPEN)

**P5c-2-S1 through S5 are MERGED into main via PRs #109, #111, #112, and #113. P5c-2-S6 (tmux_drive_claude) is the last slice.**

- Current episode ID: `20260628-091618-p5c-2-s5-mode-literal-keys-merged-into-m-0ef5`
- Tags include: `canonical-workplan`, `workplan`, `p5c-2-s1-s2-s3-s4-merged`, `p5c-2-s5-next`, `p5c-2-s5-mode-keys`, `p5b-1-opened`, `p5d-opened`
- Summary: **Post-S4-merge chain head revision.** PR #112 (P5c-2-S4 checkExtendedKeys) MERGED into main at `2dbf93a`; S5 mode:literal|keys is NEXT.
- Tags include: `canonical-workplan`, `workplan`, `p5c-2-s1-s2-merged`, `p5c-2-s3-merged`, `p5c-2-pr-109-merged`, `p5c-2-pr-110-merged`, `p5c-2-pr-108-merged-user-manual`, `p5c-2-pr-111-merged-pressenter-count`, `p5c-2-merge-commit-ac59f5b`, `p5c-2-sync-commit-9d8986c`, `p5c-2-user-manual-commit-a030c5d`, `p5c-2-pressenter-commit-c4dbf61`, `p5c-2-s4-next`, `p5c-2-s4-checkextended-keys`, `p5b-1-opened`, `p5b-1-cmux-terminal`, `p5d-opened`, `p5d-cmux-control`, `behind-then-update-branch-pattern`, `plan-vs-actual-delta-15-to-126`, `codex-0.142.3-quirks`
- Summary: **Post-S3-merge chain head revision.** PR #111 (P5c-2-S3 pressEnterCount surface) MERGED into main at `c4dbf61` (2026-06-28T07:55:20Z), squash-commit from 2 branch commits (workplan sync + S3 implementation). S3 reality was **+126/-15 across 4 files + 7 new tests + 1 updated test**, NOT the headline "~15 LOC + 2 tests" estimate — the original plan only counted the public-surface work and missed the latent literal-mode Enter loop that needed wiring (`send.ts` had a `pressEnterCount?: number` seam since S1 but never used it). Codex review (3 rounds, READY-TO-MERGE) caught 2 MAJORs (display inconsistency with clamp + NaN propagation) and 1 NIT (comment accuracy), all fixed before commit. **Next: P5c-2-S4 (`checkExtendedKeys` warn-only at `session_start`)** — new file `lib/keyscheck.ts`, ~120 LOC + 6 unit tests, parses `tmux -V` + `tmux show-option -gv extended-keys-format`, fire-and-forget from session_start. Genuinely parallel-safe with S5 (different files). **P5b-1 cmux-terminal + P5d cmux-control still OPENED** (scaffold only, macOS-only). Process lessons captured for codex 0.142.3 TUI quirks (Enter ×2 to submit, backticks corrupt messages, capture depth for multi-round) and sizing reality check (use 2-3x headline estimate as working budget).

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
- P5c tmux-control v0.1 (PR #106, commit 4cc5232)
- **P5c-2-S1 pasteText (commit e32eadf on feat/p5c-2-foundations; originally 68c27d7 on feat/cmux-control-and-p5b-cmux-terminal)**
- **P5c-2-S2 waitForWindow (commit d8ee10b on feat/p5c-2-foundations; originally 5f2ffeb on feat/cmux-control-and-p5b-cmux-terminal, amended post-review)**
- **P5c-2-S5 mode literal|keys (PR #113, commit ea6ff83)**

### Next
- **P5c-2-S6 (TOP PRIORITY)** — `tmux_drive_claude` composite tool. New file `lib/drive.ts`. Composes S1+S2+S4+S5. Largest remaining P5c-2 slice. Must buffer across stdin reads per S6 design note in S1.
- P5c-2-S6 (after S5) — `tmux_drive_claude` composite tool (uses S1 + S2; must buffer across stdin reads per S6 design note in S1). Largest slice.

### Next (open)

#### P5c-2-S6 (TOP PRIORITY, last P5c-2 slice)
- `mode: "literal" | "keys"` for `tmux_send` (seam already in `send.ts` since S1).
- In keys mode: omits `-l`, splits tokens, defaults `pressEnter:false`.
- ~15 LOC + 4 tests in `lib/send.ts`, `index.ts`, `test-exec.mjs`.

#### P5c-2-S6 tmux_drive_claude composite
- New file `lib/drive.ts`. Composite of S1 + S2 + readiness detection.
- **MUST buffer across stdin reads** (S6 design note in S1 commit; Path A test verified >1KB paste fragments into 4 reads but markers appear once at true start/end).
- Target identification: claude/codex = raw-mode TUI with DECSET 2004; requires readiness-gating.

#### P5b-1 cmux-terminal (OPENED, scaffold only)
- 5-slice ladder. macOS-only. Still scaffold-only — not started.
- Wait for cmux installed on dev machine.

#### P5d cmux-control (OPENED, scaffold only)
- 5-slice ladder. macOS-only. Still scaffold-only — not started.
- Same prerequisite as P5b-1.

### Deferred
- P4R-PROJ Project Background Agents (requires disk-backed trust reader)
- P5b-2 zellij-terminal, P5b-3 wezterm-terminal, P5b-4 headless-backend
- Multiple-backend selection via `--backend` flag (until 2+ backends ship)
- **NEW from S1**: Buffer-name TOCTOU — PASTE_BUFFER_NAME is fixed constant; concurrent pasteText races. Per-call unique buffer name is the fix but >3 LOC, out of scope.
- **NEW from S1**: S6 must document buffer-across-reads requirement (already added to S1 commit body).

### Active design docs

- `agents/docs/P4_REMEDIATION_PLAN.md` — v3 GO consensus. 6 remediation slices + deferred project-agents slice. All edit `agents/lib/bg-state.ts`.
- `agents/docs/P4_BACKGROUND_AGENTS_PLAN.md` — parent plan (to be corrected in P4R-6).
- `agents/docs/P5_PLUGGABLE_TERMINAL_BACKEND.md` — parallel track.
- `agents/docs/P5C2_TMUX_CONTROL_TUI_AUTOMATION_PLAN.md` — 482 lines, 19 sections, 19 REQ rows, 29 unit tests + 3 smoke planned in the catalog (S1 + S2 actually shipped with 18 `waitForWindow` unit + 12 real-tmux smoke steps total + 2 Path A marker checks; S3-S6 OPEN).
- `agents/docs/P5C2_TMUX_CONTROL_TUI_AUTOMATION_ADVERSARIAL_REVIEW.md` — pass-2 review.
- `agents/docs/P5C2_TMUX_CONTROL_TUI_AUTOMATION_REVIEW.md` — pass-4 re-review (APPROVED after applying 4 fixes + OD-1).
- `TMUX_TUI_AUTOMATION.md` — research grounding (in repo root).

To update it, revise/supersede the episodic memory entry instead of editing this file.
