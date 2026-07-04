# zellij-terminal

P5b-2 reference backend for the `agents` extension's `TermBgBackend` interface. Selectable per-launch via `--backend zellij` (P5E1).

## Install

```sh
# Symlink into your pi extensions directory:
ln -s "$(pwd)/zellij-terminal" ~/.pi/agent/extensions/zellij-terminal
```

## Load order

`zellij-terminal` must be loaded alongside the `agents` extension:

```sh
pi -e ./agents/index.ts -e ./zellij-terminal/index.ts
```

Either order works; `zellij-terminal` registers on `session_start`.

## Requirements

- **zellij >= 0.44.3** on `$PATH`. The two-step detached launch (`attach -b` + `run -- --close-on-exit`) is pinned to this version. Older versions may not have `attach -b`, `--close-on-exit`, or `delete-session -f`. The full spike-verified surface is captured in `zellij-terminal/docs/cli-spike-output.txt`.
- **Cross-platform**: zellij runs on macOS, Linux, and BSDs (no platform gate in `isAvailable`). Unlike `cmux-terminal`, no `CMUX_SOCKET_MODE=allowAll`-style opt-in is needed for external CLI control.
- **Short socket directory**: zellij's per-session IPC socket path is `<TMPDIR>/zellij-<uid>/...` (max 103 bytes). If your `$TMPDIR` is long (e.g. macOS's `/var/folders/.../T/`), set `ZELLIJ_SOCKET_DIR=/tmp/zellij-sockets` (or any short path) before launching. The bundled smoke test exports this for you.

## Usage

```sh
# Inside a pi session with both extensions loaded:
/agents bg --backend zellij scout "review the diff in agents/lib/bg-state.ts"
```

The agent runs in a detached zellij session named `pi-zellij-<runId>`. Use `/agents bg-status`, `/agents bg-stop`, and `/agents bg-open` to manage it. (The `--backend` flag is the P5E1 selector — without it, the automatic selector picks the highest-preference available backend, which on most setups is cmux on macOS and tmux elsewhere.)

## Design: two-step detached launch

Unlike tmux (one-shot `new-window`) and cmux (one-shot `workspace create`), zellij requires a two-step launch to spawn a detached session:

1. **Create the session** via `zellij attach -b <name>` (the `-b` flag means "create in background if missing"). This is a fire-and-forget `child_process.spawn({detached: true, stdio: "ignore"}).unref()` — we do NOT await its exit.
2. **Poll** `zellij list-sessions -s` every 250ms (up to 5s) until the session name appears. The `attach` client itself exits after ~2s once the session server is up.
3. **Run the worker** in the named session via `zellij -s <name> run --name <pane> --cwd <cwd> --close-on-exit -- node <worker> <manifest>`. This returns the pane id (`terminal_<n>`) on stdout, which is NOT persisted — `windowId` is the session name.

This split is required because zellij's `run` requires the session to already exist; the spec's `attach -b` is the documented way to create a detached session from outside an existing one. Full verification at `zellij-terminal/docs/cli-spike-output.txt`.

## Security model

- **argv-only construction**: every `zellij` call uses `execFile("zellij", argv)` — never a shell. The single `child_process.spawn` exception is `attach -b`, where `stdio: "ignore"` makes shell injection moot.
- **Path validation**: `manifestPath` must be absolute, free of `..` segments, and realpath-resolve inside `~/.pi/agent/bg/`. `cwd` must be absolute and free of `..`. Both validated before any zellij invocation.
- **Session name sanitization**: session names are `pi-zellij-<runId>` and pane names are `pi-zellij-pane-<runId.slice(0,8)>` — both derived, never user-controlled text.
- **No user-options analog**: zellij 0.44.3 has no `set-window-option @pi_*` equivalent. The session name carries only `runId`; `agentName` is not persisted (same gap as cmux). Documented in the plan.
- **Error redaction**: zellij stderr is redacted to replace worker/manifest paths with `<worker>`/`<manifest>`, then truncated to 512 chars + ellipsis.
- **Timeouts**: every zellij call has a timeout (10s for `run`, 5s for `list-sessions`/`kill-session`/`delete-session`/`isAlive`/`list`); launch never rejects.
- **Zombie cleanup**: if `kill-session` reports "not found" but the session is still listed (stale saved state), `delete-session -f` is called as a best-effort fallback. This is zellij-specific — tmux/cmux don't have this state.

## Known limitations

- **agentName not persisted**: zellij has no user-options surface; the runId is the only metadata recoverable from `list-sessions`. Same gap as cmux-terminal. (P5b-3+ may revisit if zellij adds a `set-session-option` analog.)
- **Two-step launch delay**: detached-session creation adds ~250-1000ms latency vs. tmux/cmux's one-shot launch. The poll window handles this gracefully.
- **No `run` pane id persistence**: only the session name is returned as `windowId`. If you need to manipulate a specific pane, you must re-discover it via `zellij action list-panes -s <session>`. Out of scope for v0.1.
- **Per-launch `--backend` only**: zellij registers with `preference: 0`, same as the tmux default. The auto-selector never picks zellij without an explicit `--backend zellij` flag (P5E1). Persistent per-project defaults require the trust reader (P4R-PROJ), still deferred.

## Tests

```sh
bash zellij-terminal/test-fixtures/run-zellij-tests.sh
```

Tests cover the 33 unit tests on the backend (Groups 1-9), 4 extension tests, REQ-9 no-shell guard, REQ-10 no-out-of-scope-changes guard, and the 3-test real-zellij smoke (UNGUARDED-IN-CI). The smoke auto-skips if zellij is not on `$PATH`.
