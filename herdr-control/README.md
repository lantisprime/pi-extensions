# herdr-control

Launch and coordinate **subagents through [herdr](https://herdr.dev)** from inside pi.

herdr is an agent-aware terminal multiplexer: it knows whether the process in
each pane is `working`, `blocked`, `done`, or `idle`. This extension turns that
into a pi-native delegation primitive: the LLM (or you) spawns a subagent in a
sibling pane, submits a task, waits for the agent to *actually settle* (not
"fires keystrokes and hopes"), and reads the transcript back.

Requires pi to run **inside a herdr pane** (`HERDR_ENV=1`) and herdr ≥ 0.9
(the live binary is version-probed via `herdr status --json`; older servers
fail the entry gate with an update hint).

## Tools (LLM-callable)

| Tool | Purpose |
|------|---------|
| `herdr_agents` | List live agents, or get one agent's detail (name, status, pane, cwd). |
| `herdr_spawn` | Full pipeline: sibling pane split → `agent start` → `agent prompt --wait` → read transcript. Optional `agent_args` passthrough (0.9 `--`), `close_when_done` disposal. |
| `herdr_prompt` | Submit a follow-up prompt to a live agent (wait or fire-and-forget). Optional `close_when_done` disposal (registry-recorded agents only). |
| `herdr_read` | Read an agent's terminal output (`visible`, `recent`, `recent-unwrapped`). Pane ids and `herdr_terminal` panes route through `pane read`. |
| `herdr_send_keys` | Send logical keys (`esc`, `enter`, `ctrl+c`) to rescue a **blocked** agent. Always user-confirmed. |
| `herdr_close` | Close a pane **this session spawned** (registry-gated). |
| `herdr_terminal` | Open a separate plain terminal (shell pane — no agent): sibling split by default, tab/workspace on request, optional command + sidebar label. Registry-tracked → closeable via `herdr_close`, readable via `herdr_read`. |
| `herdr_watch` | Manage the proactive pane watchdog: polls pane states through the classifier and surfaces transitions — blocked dialogs (wake the session), finished tasks (close candidates), unknown/gone agents. Auto-arms on first `herdr_spawn`. |

## Commands

- `/herdr-list` — show live herdr agents
- `/herdr-spawn <name> [--kind pi|claude|codex|...] [--cwd p] [--dir right|down] [--timeout ms] [--workspace] <task...>`
- `/herdr-term [--cwd p] [--dir right|down] [--tab] [--workspace] [--label text] [command...]` — open a separate plain terminal (stop label capture with another flag; combine command + label via the `herdr_terminal` tool)
- `/herdr-config prefix <value>` — session-only spawn-name prefix gate (default `pi-herdr-`)

Natural language: `list herdr agents` and `herdr spawn <name> <task...>` are
handled by a conservative input hook; everything else passes through.

## Safety model

- **Entry gate** — refuses to act when pi isn't inside a herdr pane or the
  herdr server is unreachable; version-probed (`herdr status --json`),
  servers older than 0.9.0 fail closed with an update hint.
- **Sibling-pane default** — `pane split --current --no-focus` with the
  caller's cwd; direction auto (wide pane → right, tall → down). New
  workspaces only on explicit request.
- **Lifecycle over keystrokes** — `agent prompt --wait --timeout` waits for
  settled `idle|done|blocked`; `agent_prompt_stalled` and timeouts are
  surfaced with state + transcript, never blind-retried.
- **Own pane classifier** — herdr cannot reliably classify pi panes
  (`screen_detection_skipped: true`, reports `working` even at dialogs —
  live-verified). The classifier fuses herdr's integration lifecycle with
  pattern analysis of the 0.9 `detection` buffer, grounded in pi's real UI
  strings; dialog evidence outranks herdr in both directions, and for
  dialog-blind pi rows herdr's lifecycle status stays trusted.
- **Event-based watchdog** — `herdr_watch` subscribes to herdr's socket
  events (`pane.agent_status_changed` / `pane.exited` / `pane.closed`) and
  re-classifies immediately on transitions; a slow reconcile tick is the
  safety net. Blocked dialogs wake the session (steer); finished tasks
  surface as close candidates. Auto-arms on the first `herdr_spawn`.
- **Mechanical pane lifecycle** — code, not instructions:
  `session_shutdown` closes every pane this session spawned;
  `session_start` reaps stale settled panes from crashed sessions; the
  watchdog reaps panes settled beyond their 10-minute lease. Working and
  blocked panes are never reaped. `keep_on_exit` opts out per spawn.
- **Blocked dialogs** — herdr refuses to deliver prompts to blocked agents;
  the extension surfaces the dialog and requires deliberate, user-confirmed
  `herdr_send_keys`.
- **Cleanup discipline** — every submitted brief carries a mandatory footer: dispose git worktrees (`git worktree remove`), delete temp files, stop started processes, report what was cleaned. Opt out per-call with `cleanup_guidance: false`. With `close_when_done: true`, herdr_spawn/herdr_prompt close the pane once the task settles (blocked/timeout/stalled keep it open for inspection).
- **Registry-gated cleanup** — `herdr_close` only closes panes recorded by
  `herdr_spawn`. The registry is event-sourced into the session
  (`pi.appendEntry`) so it survives `/new`, `/resume`, `/fork`, `/reload`;
  dead panes are pruned on session start. Unregistered prefix-named agents
  need interactive confirmation; everything else is refused.
- **Exit hygiene** — `session_shutdown` reports (never kills) still-running
  subagents. Failed spawns record their shell pane as an orphan so it can be
  closed instead of leaked.

## Layout

```
herdr-control/
├── index.ts          # entry: tools, commands, input hook, lifecycle
├── lib/
│   ├── constants.ts  # prefixes, timeouts, kinds
│   ├── exec.ts       # argv-only herdr executor (execFile, no shell)
│   ├── json.ts       # envelope parsing + herdr error classification
│   ├── safety.ts     # name/ref/key validation, HERDR_ENV gate
│   ├── string-enum.ts# Google-compatible StringEnum (local, test-friendly)
│   ├── gate.ts       # cached server-reachability check
│   ├── list.ts       # agent list/get
│   ├── launch.ts     # spawn pipeline (layout → start, orphan detection)
│   ├── prompt.ts     # agent prompt --wait with error taxonomy
│   ├── read.ts       # agent read + transcript tail-keeping
│   ├── close.ts      # pane close
│   ├── registry.ts   # event-sourced spawn registry
│   └── nlp.ts        # conservative input-hook matcher
└── test-fixtures/    # node --experimental-strip-types unit tests
```

## Tests

```bash
npm test          # or: bash test-fixtures/run-tests.sh
```

Runs against a scripted fake executor — no herdr server needed.

For a live end-to-end check (requires pi inside a running herdr session):

```bash
node --experimental-strip-types test-fixtures/smoke-live.mjs
```

It spawns a real `pi` subagent in a sibling pane, verifies it settles and
answers, then closes the pane via the registry.

## Design notes

See [PLAN.md](./PLAN.md) (rev 2, post-review) for the design rationale and the
review findings folded in. Best practices follow herdr's official
[agent automation guide](https://herdr.dev/docs/agent-automation/) and the
bundled [herdr skill](https://github.com/herdrdev/herdr/blob/master/skills/herdr/SKILL.md).
