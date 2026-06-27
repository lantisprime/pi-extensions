# tmux-terminal

P5 reference backend for the `agents` extension's `TermBgBackend` interface.

## Install

```sh
# Symlink into your pi extensions directory:
ln -s "$(pwd)/tmux-terminal" ~/.pi/agent/extensions/tmux-terminal
```

## Load order

`tmux-terminal` must be loaded alongside the `agents` extension:

```sh
pi -e ./agents/index.ts -e ./tmux-terminal/index.ts
```

Either order works; `tmux-terminal` registers on `session_start`.

## Requirements

- **tmux ≥3.0** on `$PATH` (some features need ≥2.2 for `@user-option` support; 3.0+ recommended)
- A running tmux server (`tmux new-session -d -s main` if none)

## Usage

```sh
# Inside a pi session with both extensions loaded:
/agents bg scout "review the diff in agents/lib/bg-state.ts"
```

The agent runs in a detached tmux window named `pi-agent-<runId>`. Use `/agents bg-status`, `/agents bg-stop`, and `/agents bg-open` to manage it.

## Security model

- **argv-only construction**: tmux is invoked via `execFile("tmux", argv)` — never a shell. User-controlled data (agentName, runId, task text) cannot reach a shell parser.
- **Path validation**: `manifestPath` must be absolute, free of `..` segments, and realpath-resolve inside `~/.pi/bg-state/`. `cwd` must be absolute and free of `..`. Both validated before any tmux invocation.
- **Window name sanitization**: window names are `pi-agent-<runId>` — collision-safe, deterministic, no user data.
- **Error redaction**: tmux stderr is redacted to replace worker/manifest paths with `<worker>`/`<manifest>`, then truncated to 512 chars + ellipsis.
- **Timeouts**: every tmux call has a 10s timeout (5s for set-window-option); launch never rejects.

## Known limitations

- **No TUI attach**: users switch to the tmux window manually (e.g. `tmux select-window -t pi-agent-bg-xxx`).
- **No session persistence**: if tmux server dies, all `pi-agent-*` windows die with it.
- **Single-user tmux server assumed**: if multiple users share a tmux server, `runId` recovery via `@pi_run_id` may be spoofed. Use `tmux -L <user>` for per-user servers.

## Tests

```sh
bash tmux-terminal/test-fixtures/run-p5-tests.sh
```

63 tests across `test-tmux-backend.mjs` (45), `test-helpers.mjs` (12), `test-extension.mjs` (6). All run via Node 22+ `--experimental-strip-types`.