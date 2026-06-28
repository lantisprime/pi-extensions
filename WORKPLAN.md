# Retired: Canonical Workplan Moved To Episodic Memory

`WORKPLAN.md` is no longer the source of truth. Do not use this file for planning or status.

The canonical `pi-extensions` workplan now lives in episodic memory.

**To recall it:** episodic memory search for project `pi-extensions`, tag
`canonical-workplan`, and take the single `active` episode (the chain head). Do
NOT hardcode an episode ID here — it drifts on every revision. The active head is
the source of truth; older entries in the chain are `superseded`.

## Active implementation (P5c-2-S1 + S2 MERGED into main + P5b/P5d still OPEN)

**P5c-2-S1 (pasteText) and S2 (waitForWindow) are MERGED into main via PR #109. P5c-2-S3 (pressEnterCount surface) is the next slice.**

- Current episode ID: `20260628-064329-post-pr-108-pr-110-sweep-chain-head-now--2c32`
- Tags include: `canonical-workplan`, `workplan`, `p5c-2-s1-s2-merged`, `p5c-2-pr-109-merged`, `p5c-2-pr-110-merged`, `p5c-2-pr-108-merged-user-manual`, `p5c-2-merge-commit-ac59f5b`, `p5c-2-sync-commit-9d8986c`, `p5c-2-user-manual-commit-a030c5d`, `p5c-2-s3-next`, `p5c-2-s3-pressenter-count`, `p5c-2-s3-test-plan-expanded`, `p5b-1-opened`, `p5b-1-cmux-terminal`, `p5d-opened`, `p5d-cmux-control`, `behind-then-update-branch-pattern`
- Summary: **Chain head sweep after PR #110 (workplan sync) + PR #108 (USER_MANUAL background-agents section) both MERGED into main at `a030c5d`.** PR #109 (P5c-2 S1+S2) is the substantive implementation merge; PR #110 is the workplan-pointer sync to match; PR #108 is the user-manual docs gap closer (lateral addition, no new tracked track). All three merges preserve S3 readiness: the `pressEnterCount` seam is still at `lib/send.ts:43`, schema at `tmux-control/index.ts:263-267`, single-line + multi-line paths both testable. **Next: P5c-2-S3 (pressEnterCount surface)** — ~15 LOC + 4 unit tests (expanded from handoff's minimum-2 to cover single-line direct path + NaN fail-safe parity with pasteText's existing 4 pressEnterCount tests). Touches `lib/send.ts` (no-op, seam already there) + `lib/index.ts` (schema + execute thread) + `test-fixtures/test-exec.mjs` (4 tests). **P5b-1 cmux-terminal + P5d cmux-control still OPENED** (scaffold only, macOS-only). Resolution pattern from PR #108: docs-only PRs that go BEHIND main resolve cleanly via GitHub UI "Update branch" → squash merge.

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

### Next
- **P5c-2-S3 (TOP PRIORITY)** — `pressEnterCount` surface for `tmux_send` (seam already in `send.ts` since S1). ~15 LOC + 2 unit tests.
- P5c-2-S4 (parallel-safe) — `checkExtendedKeys` warn-only at `session_start`. New file `lib/keyscheck.ts`.
- P5c-2-S5 (after S3) — `mode: "literal" | "keys"` surface for `tmux_send` (seam already in `send.ts` since S1). ~15 LOC + 4 unit tests.
- P5c-2-S6 (last) — `tmux_drive_claude` composite tool (uses S1 + S2; must buffer across stdin reads per S6 design note in S1).

### Next (open)

#### P5c-2-S3 (TOP PRIORITY)
- Exposes the existing `pressEnterCount` param on `tmux_send` (seam already in `send.ts` since S1).
- Touches `lib/send.ts` and `lib/index.ts` only — no `lib/wait.ts` overlap. ~15 LOC + 2 unit tests.

#### P5c-2-S4 (parallel-safe)
- `checkExtendedKeys` warn-only at `session_start` (sync handler + fire-and-forget).
- New file `lib/keyscheck.ts`. ~120 LOC + 6 unit tests.
- Parses `tmux -V` + `tmux show-option -gv extended-keys-format`.
- `session_start` calls `checkExtendedKeys()` fire-and-forget; warn-only (no throw, no state mutation).
- Tests: csi-u, xterm, old tmux, parse-fail, session_start warn, no-socket noop.

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
