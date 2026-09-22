# Agent instructions

## Working rules (learned, 2026-09-21 — smart-compaction build)

These are binding for agent work in this repo; rationale in
`.plans/COMPACT/RETRO.md`.

1. **Delegated work isn't done until it's read back.** Verify a delegate's
   actual model (launch command / self-report) before submitting the task;
   never report a delegated result without reading its full output; keep
   delegate scope small enough to finish (an 8-file review timed out at 300s).
2. **Spot-check review claims before acting** — at least one file:line claim
   against the real code per review.
3. **Review the implementation, not just the design draft.** Any amended
   design + new code gets a fresh review pass against the code itself.
4. **Wiring bugs get wiring tests.** Pure-function unit tests can't catch
   handler state-lifecycle bugs; review-found state bugs in extension wiring
   require a mock-API harness regression test (`smart-compaction/test/
   wiring.test.ts` is the pattern).
5. **Amend the design doc when the API proves it wrong** — never let a header
   comment silently redefine the design (append under `## Amendments`).

## TypeSafe skill

This repo ships the `typesafe-ai` skill at `.agents/skills/typesafe-ai/`.

**Consult it when working on this project.** It is third-party vendor guidance
(MIT, © TypeSafe) for building with TypeSafe's *System One* models, including
**Jev** — small units of AI intelligence that return typed answers and
probabilities instead of generated text, so ordinary code can consume them.

It is most relevant when a task involves:

- a feature that needs programmable common sense or semantic understanding
- an LLM prompt-and-parse step that could become a structured decision
- routing, ranking, extraction, verification, or grading
- choosing or composing typed judgments: `Choice`, `Noul`, `Score`

### Docs are the source of truth

The skill gives direction only. The live docs carry current concepts, API
contracts, SDK usage, models, and limits — read them as part of the task, starting
from `https://docs.typesafe.ai/llms.txt`. Mintlify serves Markdown by appending
`.md` to a page path. Do not invent version-dependent API details; if live access
is unavailable, say so and prefer installed SDK types over guesses.

Keep API credentials server-side in any web app.

### Scope

This is vendor guidance, not a repo utility. Apply it where semantic judgments
genuinely help the task at hand — it does not override this repo's own
conventions, and it is not a reason to introduce TypeSafe into work that does not
call for it.

## Skills layout

- `.agents/skills/` — project skills loaded by pi and Codex (`episodic-memory`,
  `typesafe-ai`). Tracked in git.
- `skills/` — this repo's own agent discipline packs, symlinked into
  `~/.pi/agent/skills/` (e.g. `skills/tasks/`).
- `.pi/skills/` — gitignored; local-only installs.

See `README.md` for the full extension catalogue.
