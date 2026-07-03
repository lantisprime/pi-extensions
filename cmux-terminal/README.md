# cmux-terminal

P5b reference backend for the `agents` extension's `TermBgBackend` interface.

## Install

```sh
# Symlink into your pi extensions directory:
ln -s "$(pwd)/cmux-terminal" ~/.pi/agent/extensions/cmux-terminal
```

## Load order

`cmux-terminal` must be loaded alongside the `agents` extension:

```sh
pi -e ./agents/index.ts -e ./cmux-terminal/index.ts
```

Either order works; `cmux-terminal` registers on `session_start`.

## Requirements

- **macOS-only**: cmux is Ghostty-based and darwin-only.
- **cmux >= 0.64.17** on `$PATH`
- `CMUX_SOCKET_MODE=allowAll` for external CLI control

## Usage

```sh
# Inside a pi session with both extensions loaded:
/agents bg scout "review the diff in agents/lib/bg-state.ts"
```

The agent runs in a detached cmux workspace named `pi-cmux-<runId>`. Use `/agents bg-status`, `/agents bg-stop`, and `/agents bg-open` to manage it.

## Security model

- **argv-only construction**: cmux is invoked via `execFile("cmux", argv)` — never a shell. User-controlled data (agentName, runId, task text) cannot reach a shell parser.
- **Path validation**: `manifestPath` must be absolute, free of `..` segments, and realpath-resolve inside `~/.pi/agent/bg/`. `cwd` must be absolute and free of `..`. Both validated before any cmux invocation.
- **Workspace name sanitization**: workspace names are `pi-cmux-<runId>` — collision-safe, deterministic, no user data.
- **Error redaction**: cmux stderr is redacted to replace worker/manifest paths with `<worker>`/`<manifest>`, then truncated to 512 chars + ellipsis.
- **Timeouts**: every cmux call has a timeout (10s for launch, 5s for stop/status/list calls, 1s for availability probing); launch never rejects.
- **Unix socket control**: cmux uses a Unix socket, unlike tmux's server. External process-tree CLI control requires `CMUX_SOCKET_MODE=allowAll`.

## Known limitations

- **macOS-only**: cmux is Ghostty-based and darwin-only.
- **Socket mode required**: `CMUX_SOCKET_MODE=allowAll` must be set for external CLI control because cmux 0.64.17+ ancestry-checks its Unix socket.
- **agentName not persisted**: cmux workspace titles carry only the runId prefix; the human-readable agent name is not stored in workspace metadata. This is a known gap documented in the plan.
- **Dispatch behavior**: `cmux-terminal` registers with preference=10, so on macOS cmux wins over tmux regardless of CLI load order. On non-macOS, cmux's `isAvailable()` returns false and tmux is selected. Fallback is best-effort: if the cmux daemon goes down, `/agents bg` falls through to tmux, but subsequent `/agents bg-status` or `/agents bg-stop` calls may select cmux when it comes back online and lose visibility into the tmux-launched run. This is an accepted v2.1 limitation; cross-backend aggregation is deferred to P5b-2.

## Tests

```sh
bash cmux-terminal/test-fixtures/run-cmux-tests.sh
```

Tests cover the cmux backend, cmux tool surface, extension export, README guard, REQ-13 import guard, helper-file drift guard, and the real-cmux e2e driver.
