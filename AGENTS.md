# Agent instructions

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
