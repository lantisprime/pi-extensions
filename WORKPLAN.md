# Retired: Canonical Workplan Moved To Episodic Memory

`WORKPLAN.md` is no longer the source of truth. Do not use this file for planning or status.

The canonical `pi-extensions` workplan now lives in episodic memory.

**To recall it:** episodic memory search for project `pi-extensions`, tag
`canonical-workplan`, and take the single `active` episode (the chain head). Do
NOT hardcode an episode ID here — it drifts on every revision. The active head is
the source of truth; older entries in the chain are `superseded`.

## Current state

**P5F disk-backed per-project trust reader PLAN ACCEPTED** via codex 5-pass consensus (PR #143, commit `0ca3ee6`) — planning-only merge, no implementation yet. **P5 NL → /agents bg intent-gate workflow COMPLETE** (PR #141, commit `6d61802`). **P5b-2 zellij-terminal COMPLETE** (PR #139, commit `3c6e6b8`). **P5E1 backend selector COMPLETE** (PR #137, commit `8e41670`). **P5d cmux-control COMPLETE** (PRs #126, #128, #130, #131, #132) + **P5+ orphan reaper** bug fix merged (#134). **Next: P5F-1 pure reader extraction (ready to slice).**

- Chain head: `20260704-141949-post-merge-sync-p5f-plan-accepted-via-co-a0b1`
- Status: active
- Revises: `20260704-122521-post-merge-sync-p5-nl-agents-bg-intent-g-d94b`
- Tags include: `canonical-workplan`, `workplan`, `p5f`, `p5f-plan-accepted`, `trust-reader`, `post-merge-sync`, `roadmap`, `p5f-1-next`
- Summary: **Post-merge sync — P5F plan ACCEPTED via codex 5-pass consensus (#143, commit 0ca3ee6).** Planning-only merge; P5F-1 pure reader extraction is next; milestone `20260704-141556-p5f-7968`.

### Open follow-ups (details in canonical episode)
- **P5F-1 (NEXT)** — pure reader extraction (zero production callers). Appendix B step 1.1 has full verbatim `bg-trust.ts` source; step 1.2 has 4 verbatim tests + an 8-test contract table (high-capability executor scope per PLAN_TEMPLATE). Branch: `feat/p5f-1-trust-reader`. P5F-2 (writer + resolver) + P5F-3 (read-side wiring) step-tables deferred to post-P5F-1-review.
- **P5b alternative terminal backends** — zellij shipped; wezterm/headless next natural; cleanly testable from the CLI via the `--backend <name>` seam P5E1 shipped.
- **Combined `--backend` + `--profile` in `parseBgArgs`** — still first-token-only for both flags; add when a real use case appears.
- **P4R-PROJ Project Background Agents** — deferred (needs disk-backed trust reader — NOW shipping via P5F; P4R-PROJ can consume `readProjectTrustStore` once P5F-2 writer lands).
- **Persistent per-project default backend** — deferred (needs trust reader — NOW shipping via P5F; resolves the non-deterministic `selectBgTerminalBackend()` preference-probe default when multiple backends installed).
- **P5+ orphan reaper follow-ups**:
  - 15s poll now also calls the reaper (orphans caught in the currently-open session within 15s, not just at next restart).
  - `isAlive` seam is now `(reservation: BgReservation) => boolean | Promise<boolean>` — internal API change. Production callers use `buildReaperIsAlive` from `agents/index.ts`.
  - Post-launch `updateBgReservationOwner` failure leaves the slot active; reaper falls back to age-only. Best-effort, not user-facing.

### Pointer files
- `WORKPLAN.md` — this file.
- `agents/P3_IMPLEMENTATION_SLICES.md` — slice ladder; needs update to add P5F section.
- `agents/docs/P5F_DISK_BACKED_TRUST_READER_PLAN.md` — P5F plan (ACCEPTED via codex 5-pass consensus, PR #143).
- `agents/docs/P5F_REVIEW.md` — P5F Pass-1 codex review artifact (cmux).
- `agents/docs/P5B1_CMUX_TERMINAL_PLAN.md` — P5b-1 plan, 5-slice ladder.
- `agents/docs/P5C2_TMUX_CONTROL_TUI_AUTOMATION_PLAN.md` — P5c-2 plan (shipped).
- `agents/docs/P4_REMEDIATION_PLAN.md` — P4R v3 GO consensus.
- `TMUX_TUI_AUTOMATION.md` — research grounding (repo root).

To update it, revise/supersede the episodic memory entry instead of editing this file.
