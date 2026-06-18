# P5: Pluggable Terminal Backend for Background Agents

**Status**: Planning
**Date**: 2026-06-18
**Parent**: P4 background agents plan
**Depends on**: P4 manifest/worker design (v3)

## Objective

Split background agent execution into two independent extensions:

1. **P4 agents (updated)**: defines the background execution interface,
   manifest format, preflight, and worker — but does **not** import tmux.
2. **P5 tmux-terminal**: implements the interface using tmux. Ships as a
   separate extension that agents discovers and calls.

This makes the terminal layer pluggable. Users can install `tmux-terminal`,
`zellij-terminal`, or a custom backend without touching the agents code.

## Rationale

The adversarial review identified that the tmux command string is a new
injection surface and the worker boundary is a security boundary. Coupling
agents directly to tmux would bake terminal-specific shell escaping, window
naming, and process management into the security-critical agents code.

A pluggable interface:

- Keeps terminal-specific code out of the agents security boundary
- Allows testing with a fake terminal backend (no real tmux/spawn needed)
- Enables alternative backends (zellij, wezterm, screen, custom)
- Follows the same pattern as `ctx.agentsChildRunner` — a test-friendly
  injection point that defaults to the real implementation

## Design

### Interface (agents defines)

```typescript
// agents/lib/bg-terminal.ts

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

### Agents extension (modified)

`agents/index.ts` or `agents/lib/bg-runner.ts`:

```typescript
// Discovered from Pi's extension API or a registry
let termBackend: TermBgBackend | null = null;

export function registerBgTerminalBackend(backend: TermBgBackend): void {
  termBackend = backend;
}

export function getBgTerminalBackend(): TermBgBackend | null {
  return termBackend;
}
```

When `/agents bg <agent> <task>` is invoked:

1. Run preflight (P4 preflight — writes identity manifest)
2. Check `getBgTerminalBackend()` — if null, return "no terminal backend installed"
3. Call `termBackend.launch({ agentName, runId, manifestPath, cwd })`
4. Track the returned `windowId` in the bg tracker

### Tmux-terminal extension (new)

```text
tmux-terminal/
  index.ts        — extension entry point, registers TermBgBackend
  lib/
    tmux-backend.ts  — tmux implementation of TermBgBackend
  test-fixtures/
    test-tmux-backend.mjs
  README.md
```

`tmux-terminal/index.ts`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBgTerminalBackend } from "../../agents/lib/bg-terminal";
import { createTmuxBackend } from "./lib/tmux-backend";

export default function tmuxTerminalExtension(pi: ExtensionAPI) {
  registerBgTerminalBackend(createTmuxBackend());
}
```

### Tmux backend implementation

```typescript
// tmux-terminal/lib/tmux-backend.ts

export function createTmuxBackend(): TermBgBackend {
  const tmuxAvailable = checkTmuxOnPath();

  return {
    name: "tmux",

    async launch(config): Promise<TermBgResult> {
      if (!tmuxAvailable) return { status: "failed", error: "tmux not found on PATH" };

      const windowName = sanitizeWindowName(`pi-agent-${config.runId.slice(0, 8)}`);
      const workerPath = getWorkerPath(); // fixed path, set at extension load

      // Fixed command: only trusted paths, no interpolation
      const cmd = `'${workerPath}' '${config.manifestPath}'`;

      try {
        const { stdout } = await execAsync(
          `tmux new-window -d -n '${shellEscape(windowName)}' ${cmd}`
        );
        const windowId = extractWindowId(stdout);
        return { status: "launched", windowId };
      } catch (err) {
        return { status: "failed", error: String(err) };
      }
    },

    async kill(windowId) { /* tmux kill-window -t windowId */ },
    async isAlive(windowId) { /* tmux list-windows check */ },
    async list() { /* tmux list-windows -F "#{window_name}" | grep pi-agent- */ },
  };
}
```

### No hard dependency

Agents does **not** import from tmux-terminal. The connection is at the
Pi extension layer:

```bash
pi -e ./agents/index.ts -e ./tmux-terminal/index.ts
```

If tmux-terminal isn't loaded, `/agents bg` returns a clean error:
"No terminal backend installed. Install tmux-terminal or equivalent."

### Multiple backends

Only one backend can be registered. The first to register wins. A future
version could support named backends and selection:

```text
/agents bg --backend tmux scout <task>
/agents bg --backend zellij scout <task>
```

But for P4/P5, single-backend is sufficient.

## Migration from P4 plan

| P4 plan item | Moves to |
|---|---|
| `bg-tmux.ts` (tmux command construction) | `tmux-terminal/lib/tmux-backend.ts` |
| Tmux window naming | `tmux-terminal/lib/tmux-backend.ts` |
| Tmux availability check | `tmux-terminal/lib/tmux-backend.ts` |
| Tmux test adapter | `tmux-terminal/test-fixtures/` |
| `TermBgBackend` interface | `agents/lib/bg-terminal.ts` |
| Backend registry (`registerBgTerminalBackend`) | `agents/lib/bg-terminal.ts` or `agents/index.ts` |
| Everything else (manifest, preflight, worker, tracker, commands) | Stays in `agents/` |

## Files

### New in agents/

```text
agents/lib/bg-terminal.ts        — TermBgBackend interface + registry (~30 lines)
```

### Modified in agents/

```text
agents/lib/bg-runner.ts          — calls getBgTerminalBackend() instead of tmux directly
agents/index.ts                   — import bg-terminal, no tmux import
```

### New extension: tmux-terminal/

```text
tmux-terminal/index.ts            — extension entry point (~15 lines)
tmux-terminal/lib/tmux-backend.ts — tmux implementation of TermBgBackend (~100 lines)
tmux-terminal/README.md           — install + usage docs
tmux-terminal/test-fixtures/
  test-tmux-backend.mjs           — tmux backend tests (~15 tests)
  run-tmux-backend-tests.sh
```

### P4 slices updated

```
P4-1: bg-state.ts         — unchanged (state dir, manifest format, MAC)
P4-2: bg-preflight.ts     — unchanged (shared preflight)
P4-3: bg-worker.ts        — unchanged (worker process, per-spawn gate)
P4-4: agents/lib/bg-terminal.ts — NEW: interface + backend registry
P4-5: index.ts            — command wiring, calls backend via interface
P4-6: Status line         — unchanged
P4-7: Tests               — agents tests use fake TermBgBackend

P5-1: tmux-terminal/       — tmux backend implementation
P5-2: Tests                — tmux backend tests + integration
```

## Hard stops

- Agents never imports tmux or any terminal-specific library
- `TermBgBackend` interface is the only connection point
- Tmux command construction stays in tmux-terminal
- No shell interpolation of task text, agent names, or file paths in any backend
- Fake backend exists for agent testing
- Tmux terminal extension is independently installable

## Done criteria

- `/agents bg` works when tmux-terminal is loaded alongside agents
- `/agents bg` returns clean error when no terminal backend is loaded
- Tmux backend tests pass in isolation
- Agents tests pass with fake backend (no real tmux)
- Both extensions load cleanly via `pi -e`
- Backend interface is documented
- tmux-terminal has its own README
