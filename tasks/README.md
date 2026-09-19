# Tasks

Harness-level task manager for pi with Claude Code TaskCreate/TaskUpdate semantics.
The task list is a **drift-correction anchor**: it is injected into the model's
context on every turn, enforces honest progress with evidence gates, and keeps
the LLM moving autonomously — no user prompts between tasks.

## Lifecycle

```
            task_create
                │
                ▼
          ┌───────────┐  cancel (evidence: reason)
          │  pending  ├──────────────────────────┐
          └─┬─────┬───┘                          │
     start  │     │ shelve (neutral, or with     ▼
   (single, │     │ evidence = recorded failure) ┌────────────┐
   blockers ┤     │                              │ cancelled  │
   settled) ▼     │                              │ (terminal) │
       ┌────────────┐  cancel (evidence)        └────────────┘
       │ in_progress ├──────────────────────────────▲
       │ (single)    │
       └─┬─────────┬─┘
         │ complete (evidence ≥20 chars +
         │ observed tool activity since start)
         ▼                                │
   ┌─────────────┐  (both terminal;       │
   │  completed  │   feed operator-       │
   │ (terminal)  │   consent cleanup) ────┘
   └─────────────┘
```

Guards enforced by the harness (not by prompting):

- **One in_progress** — starting B requires settling A first; this is what makes
  status updates happen automatically as a side effect of progress.
- **Evidence gate** — completing requires `evidence` (≥20 chars, concrete proof)
  AND observed tool activity since the task was marked in_progress. Invented
  results are rejected. Cancelling requires an evidence reason.
- **Retry budget** — re-starting a shelved task increments `attempts`
  (max 3). Shelving *with* evidence records a failure (`failures`, `lastError`).
  After the budget, the harness blocks auto-retry and instructs the agent to
  investigate, change approach, or escalate to the operator.
- **List bounds** — max 64 tasks; settled sets are compacted to id references.
- **Consent-gated cleanup** — `task_clear` only works when every task is settled,
  and only after the operator agrees (model asks; also offered via dialog at
  session start).

## Tools

| Tool | Purpose |
|---|---|
| `task_create` | Create a task: `code` (LLM-derived uppercase theme code → `CODE-1`, `CODE-2`…), `subject`, `description`, `activeForm?` |
| `task_update` | Transition status / edit fields. Settlement requires `evidence`. Returns the next task on settle. |
| `task_get` | Fetch one task (full record incl. evidence). |
| `task_list` | Full list with counts. |
| `task_clear` | Delete the settled set (all-settled precondition; operator consent required). |

## Context delivery (progressive disclosure)

- `before_agent_start` — bounded `<session-tasks>` block appended to the system prompt.
- `tool_result` — after every non-task tool result: full block when state changed,
  one-line status otherwise. The model never works from a stale list.
- **Empty-set nudge** — with no task set, 3+ consecutive tool results inject a
  bounded advisory directing `task_create` per the tasks skill; it re-fires at
  most every 10 further results (advisory only, never a block).
- **Same-status no-op** — a `task_update` whose status equals the current status
  succeeds as a benign no-op with a directive warning, so a model that re-emits
  the current status cannot deadlock on a transition error.
- Full detail stays behind `task_list`; behavioral discipline lives in the
  `tasks` skill (loaded on demand).

## Durable state

Project-keyed JSON at `~/.pi/agent/tasks/projects/<sha256(cwd)[0:16]>.json`,
containing `{ projectPath, cleanupState, tasks }`. Written through atomically
(tmp + rename) on every mutation, loaded on session start for the same
folder/repo. Corrupt files are quarantined (`.corrupt-<ts>`), never fatal.

## Commands

| Command | Effect |
|---|---|
| `/tasks` | Render the expanded widget |
| `/tasks expand` / `compact` | Widget density |
| `/tasks reload` | Re-read state from disk |
| `/tasks clear` | Wipe the list (operator-initiated) |

## Testing

```bash
npm exec -y --package=typescript@5.9.3 -- tsc --noEmit -p tsconfig.json
npm exec -y --package=tsx -- tsx test/run-store-test.mjs
```

### End-to-end (real child pi)

Pi exposes the current session to commands as `PI_PROVIDER` / `PI_MODEL`. Always
inherit them — never hardcode a model, so the child exercises exactly what the
parent runs:

```bash
mkdir -p /tmp/pi-e2e/proj && cd /tmp/pi-e2e/proj
pi --provider "$PI_PROVIDER" --model "$PI_MODEL" \
  --no-extensions -e "$PWD/../../tasks/index.ts" \
  --skill "$PWD/../../skills/tasks" \
  --session-dir /tmp/pi-e2e/sessions --no-approve \
  -p "Do this as a tracked multi-step job: create a.txt/b.txt/c.txt, then verify them."
```

Checks: a project-keyed store appears under `~/.pi/agent/tasks/projects/`, the
session transcript shows `task_create` → `in_progress` → `completed` with
evidence, and no `Illegal transition` loop. Drop `--skill` and use 3+ tool calls
to exercise the empty-set nudge (the advisory must appear exactly once in the
transcript).
