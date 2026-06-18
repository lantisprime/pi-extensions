# P5: Pluggable Terminal Backend

**Status**: Planning
**Date**: 2026-06-18
**Parent**: P4 background agents plan
**Depends on**: P4 `bg-terminal.ts` interface

## Objective

Split background agent execution into two independent extensions:

1. **agents** (P4): defines the `TermBgBackend` interface, manifest format,
   preflight, worker, and commands — but does **not** import tmux.
2. **tmux-terminal** (P5): implements `TermBgBackend` using tmux. Separate
   extension that agents discovers and calls at runtime.

This makes the terminal layer pluggable — users can swap tmux for zellij,
wezterm, or a custom backend without touching agents code.

## Interface (agents/lib/bg-terminal.ts)

```typescript
export interface TermBgAgentConfig {
  agentName: string;
  runId: string;
  manifestPath: string;
  cwd: string;
}

export interface TermBgResult {
  status: "launched" | "failed";
  error?: string;
  windowId?: string;  // opaque backend-specific handle
}

export interface TermBgBackend {
  /** Human-readable backend name for status display */
  readonly name: string;

  /** Launch a background agent in a terminal window */
  launch(config: TermBgAgentConfig): Promise<TermBgResult>;

  /** Kill a running background agent by window handle */
  kill(windowId: string): Promise<TermBgResult>;

  /** Check if a window handle is still alive */
  isAlive(windowId: string): Promise<boolean>;

  /** List all running agent windows from this backend */
  list(): Promise<string[]>;
}
```

Registration in agents:

```typescript
let termBackend: TermBgBackend | null = null;

export function registerBgTerminalBackend(backend: TermBgBackend): void {
  if (!termBackend) termBackend = backend;  // first to register wins
}

export function getBgTerminalBackend(): TermBgBackend | null {
  return termBackend;
}
```

## Tmux implementation (tmux-terminal/lib/tmux-backend.ts)

```typescript
export function createTmuxBackend(): TermBgBackend {
  const tmuxAvailable = checkTmuxOnPath();

  return {
    name: "tmux",

    async launch(config): Promise<TermBgResult> {
      if (!tmuxAvailable) return { status: "failed", error: "tmux not found on PATH" };

      const windowName = `pi-agent-${config.runId.slice(0, 8)}`;
      const workerPath = getWorkerPath();    // fixed, set at extension load
      const manifestPath = config.manifestPath;

      // Fixed command: only trusted paths, no task/name/path interpolation
      const cmd = `'${shellEscape(workerPath)}' '${shellEscape(manifestPath)}'`;

      try {
        await execAsync(
          `tmux new-window -d -n '${shellEscape(windowName)}' ${cmd}`
        );
        return { status: "launched", windowId: windowName };
      } catch (err) {
        return { status: "failed", error: String(err) };
      }
    },

    async kill(windowId) {
      try {
        await execAsync(`tmux kill-window -t '${shellEscape(windowId)}'`);
        return { status: "launched" };  // best-effort
      } catch (err) {
        return { status: "failed", error: String(err) };
      }
    },

    async isAlive(windowId) {
      try {
        const { stdout } = await execAsync(
          `tmux list-windows -F '#{window_name}'`
        );
        return stdout.includes(windowId);
      } catch {
        return false;
      }
    },

    async list() {
      try {
        const { stdout } = await execAsync(
          `tmux list-windows -F '#{window_name}'`
        );
        return stdout.trim().split('\n').filter(w => w.startsWith('pi-agent-'));
      } catch {
        return [];
      }
    },
  };
}
```

Safety: Only `workerPath` (fixed at extension load) and `manifestPath`
(random UUID directory) are passed in the tmux command. No task text,
agent names, model IDs, tool lists, or any user-controlled data.

## Extension entry point

```typescript
// tmux-terminal/index.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBgTerminalBackend } from "../../agents/lib/bg-terminal";
import { createTmuxBackend } from "./lib/tmux-backend";

export default function tmuxTerminalExtension(pi: ExtensionAPI) {
  registerBgTerminalBackend(createTmuxBackend());
}
```

## Usage

```bash
pi -e ./agents/index.ts -e ./tmux-terminal/index.ts
```

If tmux-terminal isn't loaded, `/agents bg` returns:
"No terminal backend installed. Load tmux-terminal or equivalent."

## Files

### New in agents/

```text
agents/lib/bg-terminal.ts        — TermBgBackend interface + registry (~30 lines)
```

### New extension

```text
tmux-terminal/
  index.ts                        — extension entry point (~15 lines)
  lib/tmux-backend.ts             — tmux implementation (~80 lines)
  README.md                       — install + usage docs
  test-fixtures/
    test-tmux-backend.mjs          — tests (~15 tests)
    run-tests.sh
```

### No changes to agents outside bg-terminal.ts

The agents extension already calls `getBgTerminalBackend()` in P4-5.
No further changes needed — tmux is entirely external.

## Hard stops

- Agents never imports tmux or any terminal-specific library
- `TermBgBackend` interface is the only connection between the two extensions
- Tmux command contains only fixed paths (workerPath, manifestPath)
- No shell interpolation of task text, agent names, file paths, or options
- Fake backend exists for agent testing
- Tmux terminal extension is independently installable

## Done criteria

- `/agents bg` works when tmux-terminal is loaded alongside agents
- `/agents bg` returns clean error when no terminal backend is loaded
- Tmux backend tests pass in isolation (fake tmux)
- Agents tests pass with fake `TermBgBackend`
- Both extensions load cleanly via `pi -e`
