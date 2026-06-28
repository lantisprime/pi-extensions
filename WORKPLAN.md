# Retired: Canonical Workplan Moved To Episodic Memory

`WORKPLAN.md` is no longer the source of truth. Do not use this file for planning or status.

The canonical `pi-extensions` workplan now lives in episodic memory.

**To recall it:** episodic memory search for project `pi-extensions`, tag
`canonical-workplan`, and take the single `active` episode (the chain head). Do
NOT hardcode an episode ID here — it drifts on every revision. The active head is
the source of truth; older entries in the chain are `superseded`.

## Active implementation (P5c-2-S1 + S2 shipped + P5b/P5d still OPEN)

**P5c-2-S1 (pasteText) and S2 (waitForWindow) are shipped. P5c-2-S3 + S4 (batchable surface work) are the next slices.**

- Current episode ID: `20260628-012643-p5c-2-s2-waitforwindow-shipped-commit-21-eed9`
- Tags include: `canonical-workplan`, `workplan`, `p4r-complete`, `p5-merged`, `p5c-shipped`, `p5c-2-s1-shipped`, `p5c-2-s1-commit-68c27d7`, `p5c-2-s2-shipped`, `p5c-2-s2-commit-214f888`, `p5c-2-s3-s4-next`, `p5b-1-opened`, `p5b-1-cmux-terminal`, `p5d-opened`, `p5d-cmux-control`
- Summary: **P5c-2-S1 (pasteText) + P5c-2-S2 (waitForWindow) SHIPPED** via commits `68c27d7` and `214f888` on branch `feat/cmux-control-and-p5b-cmux-terminal`. S2: new `lib/wait.ts` (181 LOC) — bounded-polling primitive `waitForWindow({regex}|{stableMs}, timeoutMs, intervalMs)` with injectable clock for deterministic tests. Regex takes precedence over stable; capture-pane errors return immediately (no spin); every capture is a separate `capture-pane` exec (REQ-8 — polling, not long exec). 9 new unit tests (all REQs + edge cases) + 2 real-tmux smoke steps. All tests green (11/11 real-tmux smoke + 2/2 Path A + 9 S2 unit + 14 S1 unit). **Next: P5c-2-S3 (pressEnterCount surface) + S4 (mode:"keys" surface)** — both batchable, ~30 LOC total + ~6 unit tests, touch `lib/send.ts` + `lib/index.ts` only (no wait.ts overlap). **P5b-1 cmux-terminal + P5d cmux-control still OPENED** (scaffold only, macOS-only, waiting for cmux dev machine).

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
- **P5c-2-S1 pasteText (commit 68c27d7, 2026-06-28)**
- **P5c-2-S2 waitForWindow (commit 214f888, 2026-06-28)**

### Next
- **P5c-2-S3 + S4 (BATCHABLE — pressEnterCount + mode:"keys" surface)** — top priority, ~30 LOC + 6 tests, no wait.ts overlap
- P5c-2-S5 (extended-keys warn-only at session_start) — parallel-safe
- P5c-2-S6 (tmux_drive_claude composite; must buffer across stdin reads per S6 design note in S1) — composes S1 + S2

### Next (open)

#### P5c-2-S3 + S4 (TOP PRIORITY — BATCHABLE)
- S3 exposes the existing `pressEnterCount` param on `tmux_send` (seam already in `send.ts` since S1).
- S4 exposes the existing `mode: "literal" | "keys"` param on `tmux_send` (seam already in `send.ts` since S1).
- Both touch `lib/send.ts` and `lib/index.ts` only — no `lib/wait.ts` overlap. ~30 LOC total + ~6 unit tests.
- Can ship as a single PR.

#### P5c-2-S3 + S4 (BATCHABLE — small surface work)
- S3 exposes the existing `pressEnterCount` param on `tmux_send` (already in send.ts since S1).
- S4 exposes the existing `mode: "literal" | "keys"` param on `tmux_send` (seam already in send.ts since S1).
- Both touch `lib/send.ts` and `lib/index.ts`. ~30 LOC total + ~6 unit tests.

#### P5c-2-S5 extended-keys warn-only at session_start
- New file `lib/keyscheck.ts`.
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
- `agents/docs/P5C2_TMUX_CONTROL_TUI_AUTOMATION_PLAN.md` — 482 lines, 19 sections, 19 REQ rows, 29 unit tests + 3 smoke (S1 + S2 SHIPPED; S3-S6 OPEN).
- `agents/docs/P5C2_TMUX_CONTROL_TUI_AUTOMATION_ADVERSARIAL_REVIEW.md` — pass-2 review.
- `agents/docs/P5C2_TMUX_CONTROL_TUI_AUTOMATION_REVIEW.md` — pass-4 re-review (APPROVED after applying 4 fixes + OD-1).
- `TMUX_TUI_AUTOMATION.md` — research grounding (in repo root).

To update it, revise/supersede the episodic memory entry instead of editing this file.