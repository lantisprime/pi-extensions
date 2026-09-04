# herdr-control

Launch and coordinate **subagents through [herdr](https://herdr.dev)** from inside pi.

herdr is an agent-aware terminal multiplexer: it knows whether the process in
each pane is `working`, `blocked`, `done`, or `idle`. This extension turns that
into a pi-native delegation primitive: the LLM (or you) spawns a subagent in a
sibling pane, submits a task, waits for the agent to *actually settle* (not
"fires keystrokes and hopes"), and reads the transcript back.

Requires pi to run **inside a herdr pane** (`HERDR_ENV=1`) and herdr ≥ 0.8.

## Tools (LLM-callable)

| Tool | Purpose |
|------|---------|
| `herdr_agents` | List live agents, or get one agent's detail (name, status, pane, cwd). |
| `herdr_spawn` | Full pipeline: sibling pane split → `agent start` → `agent prompt --wait` → read transcript. |
| `herdr_prompt` | Submit a follow-up prompt to a live agent (wait or fire-and-forget). |
| `herdr_read` | Read an agent's terminal output (`visible`, `recent`, `recent-unwrapped`). Pane ids and `herdr_terminal` panes route through `pane read`. |
| `herdr_send_keys` | Send logical keys (`esc`, `enter`, `ctrl+c`) to rescue a **blocked** agent. Always user-confirmed. |
| `herdr_close` | Close a pane **this session spawned** (registry-gated). |
| `herdr_terminal` | Open a separate plain terminal (shell pane — no agent): sibling split by default, tab/workspace on request, optional command + sidebar label. Registry-tracked → closeable via `herdr_close`, readable via `herdr_read`. |

## Commands

- `/herdr-list` — show live herdr agents
- `/herdr-spawn <name> [--kind pi|claude|codex|...] [--cwd p] [--dir right|down] [--timeout ms] [--workspace] <task...>`
- `/herdr-term [--cwd p] [--dir right|down] [--tab] [--workspace] [--label text] [command...]` — open a separate plain terminal (stop label capture with another flag; combine command + label via the `herdr_terminal` tool)
- `/herdr-config prefix <value>` — session-only spawn-name prefix gate (default `pi-herdr-`)

Natural language: `list herdr agents` and `herdr spawn <name> <task...>` are
handled by a conservative input hook; everything else passes through.

## Safety model

- **Entry gate** — refuses to act when pi isn't inside a herdr pane or the
  herdr server is unreachable (cached probe, 30s).
- **Sibling-pane default** — `pane split --current --no-focus` with the
  caller's cwd; direction auto (wide pane → right, tall → down). New
  workspaces only on explicit request.
- **Lifecycle over keystrokes** — `agent prompt --wait --timeout` waits for
  settled `idle|done|blocked`; `agent_prompt_stalled` and timeouts are
  surfaced with state + transcript, never blind-retried.
- **Blocked dialogs** — herdr refuses to deliver prompts to blocked agents;
  the extension surfaces the dialog and requires deliberate, user-confirmed
  `herdr_send_keys`.
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
