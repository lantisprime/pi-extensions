# tmux-control

Send and capture commands to tmux windows from inside pi. Designed to complement `/agents bg` by letting you (and the LLM) interact with already-running agent windows.

## What it does

- List windows matching a configurable prefix (default `pi-agent-*`, the same prefix used by `tmux-terminal`)
- Capture the last N lines of any window (tail-style)
- Send literal text (+ Enter) into a window
- Resolve a `runId` to its window via the `bg-terminal` registry, falling back to prefix-match
- Spawn general-purpose tmux sessions (distinct from `/agents bg`)
- Activate all of the above via **natural language** (e.g. "tail bg-abc123", "send 'continue' to bg-abc123")

## What it does NOT do

- **Not** an agent spawner. For launching agents in tmux, use `/agents bg <name> <task>`.
- **Not** an alternative to `tmux-terminal`. That extension owns the bg-launch backend.
- **Not** a cleanup path. For killing bg agents cleanly, use `/agents bg-stop <runId>`.

## Installation

```sh
# From the pi-extensions repo:
ln -s "$(pwd)/tmux-control" ~/.pi/agent/extensions/tmux-control

# Or project-local:
ln -s "$(pwd)/tmux-control" .pi/extensions/tmux-control
```

Requires `tmux` on `$PATH` and a running tmux server. If you don't have one:

```sh
tmux new-session -d -s main
```

## Dependencies

tmux-control has **no runtime dependencies that you need to install yourself**. Pi's extension loader (`jiti` with `virtualModules`) resolves `typebox` from pi's own bundled copy at runtime, so end users do not need to `npm install` anything.

For **running the test suite**, typebox needs to be resolvable from this directory. The test runner (`test-fixtures/run-control-tests.sh`) installs typebox automatically on first run via `npm install --no-save typebox`. You only need network access on the first invocation.

If you'd rather pre-install manually:

```sh
npm install --no-save typebox
```

## User manual

### Slash commands

| Command | Args | Behavior |
|---|---|---|
| `/tmux-list` | — | List all `pi-agent-*` windows. |
| `/tmux-capture` | `<id> [N]` | Capture last N lines (default 200, max 5000). Confirms whether to inject into context or show as popup. |
| `/tmux-send` | `<id> <text>` | Send literal text + Enter. Refuses non-prefixed windows. |
| `/tmux-tail` | `<runId> [N]` | Like `/tmux-capture`, but resolves `runId` via the `bg-terminal` backend if available. |
| `/tmux-launch` | `<name> [command]` | Spawn a detached tmux session. |
| `/tmux-config` | `prefix <value>` | Override the safety prefix (session-only). Empty value disables the gate. |

`<id>` may be either:
- An exact window name (e.g. `pi-agent-bg-abc123def`)
- A bare `runId` (e.g. `bg-abc123def`), which is resolved to `pi-agent-bg-abc123def`

### Natural language

tmux-control also accepts these patterns as plain input. When matched, the LLM is bypassed and the result is shown directly.

**Capture / tail:**
- `tail bg-abc123`
- `show me bg-abc123`
- `tail bg-abc123 last 50`
- `what is bg-abc123 doing`
- `capture bg-abc123`

**List:**
- `tmux list`
- `list agents`
- `list tmux windows`

**Send:**
- `send "continue" to bg-abc123`
- `send 'try again' to bg-abc123`
- `tell bg-abc123 'hello'`

**Launch:**
- `launch a tmux session named dev`
- `start a tmux session running npm run dev`
- `spawn tmux for tailing logs`

### LLM-callable tools

The agent can also use tmux-control directly:

- `tmux_list()` — list matching windows
- `tmux_capture({ window, lines? })` — capture pane output
- `tmux_send({ window, text, pressEnter? })` — send literal text
- `tmux_launch({ name, command? })` — spawn a session

These are exposed to the LLM as tools, so the agent can autonomously tail bg runs, steer them with messages, or check progress.

## Safety model

- **Prefix gate.** `/tmux-send` and `tmux_send` reject any window not matching the configured prefix (default `pi-agent-`). Override with `/tmux-config prefix ''` to disable (session-only).
- **argv-only.** All tmux calls go through `child_process.execFile("tmux", argv)` — no shell.
- **Hard timeouts.** Every tmux call has a 5s timeout. None can block longer.
- **Bounded inputs.** Send-text is capped at 4000 bytes. Capture is capped at 5000 lines.
- **Window-name validation.** Names with shell metacharacters are rejected.
- **No new tmux server by default.** tmux-control connects to your existing server (via `$TMUX` env var or `/tmp/tmux-<uid>/default`).

## Bridge to `bg-terminal`

`/tmux-tail` and the NL variants prefer the agents extension's `bg-terminal` registry:
1. Dynamic-import `agents/lib/bg-terminal.ts` (only loaded if the agents extension is present)
2. Call `getBgTerminalBackend().list()` for authoritative `runId → windowId` mapping
3. Fall back to prefix-match if the backend isn't loaded

This means tmux-control works **standalone** (without the agents extension) but gets smarter when both are present.

## Out of scope (v0.1)

- NL routing of `/agents bg` (the "via tmux" intent-gate addition). Owned by the `agents` extension.
- Persisting prefix overrides across sessions.
- Multi-line send / paste-buffer mode.
- Window splitting / layout.

## Tests

```sh
bash tmux-control/test-fixtures/run-control-tests.sh
```

First run installs `typebox` automatically (`npm install --no-save typebox`); subsequent runs use the cached `node_modules/typebox`. Everything is gitignored, so the install is local-only.

Includes:
- Unit tests for `safety`, `nlp`, `exec` (using fake executor)
- Headless extension-integration test (mocks pi's `ExtensionAPI`, verifies 6 commands + 4 tools register)
- Real-tmux smoke test against an isolated `tmux -L pi-ctrl-smoke-<pid>` socket (does NOT touch the user's default server)

## Security notes

- tmux-control runs with your full user permissions (any extension does).
- It can type into any window that matches the prefix. Mis-set prefix → misdirected input.
- It does NOT need root; tmux itself runs as your user.
- It does NOT install anything globally; the symlink install is reversible with `rm`.