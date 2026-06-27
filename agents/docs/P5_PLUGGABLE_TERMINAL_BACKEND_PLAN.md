# P5 Pluggable Terminal Backend Plan

## Status

Planning only. Do not implement until this plan, a plan review, and an adversarial
review are accepted. The interface (`TermBgBackend`) is already merged in P4-4
(`agents/lib/bg-terminal.ts`, commit `8e2f596`); this plan covers the **tmux
reference implementation** as a separate extension.

## Episode Search Summary

Searched episodic memory for `P5`, `tmux-terminal`, `pluggable terminal backend`,
`TermBgBackend`, `bg-worker`, `bg-run`.

Key active memories:

- `20260627-044215-p4-track-complete-p4r-p4-2-through-p4-7--879d`: P4 track fully
  shipped; P5 is next priority. P4-7 merged at `bea9eb0`. P5 is parallel track,
  separate extension directory.
- `20260625-081617-review-requested-p4-4-terminal-backend-i-2409`: P4-4 review
  specifically asks "Are the types forward-compatible with P5 tmux-terminal?" —
  the interface MUST be honored as-is, not re-shaped.
- `20260625-082608-p4-4-review-findings-resolved-discrimina-6c0c`: "Interface is
  forward-compatible with P5 tmux-terminal plan." Confirms no P5-induced
  interface changes are expected.
- `agents/docs/P5_PLUGGABLE_TERMINAL_BACKEND.md` (2026-06-18): the pre-template
  outline this plan refines. Contains the initial `TermBgAgentConfig` /
  `TermBgResult` shape and tmux command sketch. **The interface portion of that
  doc is now superseded by `agents/lib/bg-terminal.ts` (P4-4, merged).**

## Objective

Ship a separate `tmux-terminal` extension that registers a `TermBgBackend`
implementing the P4-4 interface using tmux, so users can run `/agents bg` with
the tmux backend loaded alongside `agents`. The tmux extension launches the
P4-3 worker (`agents/lib/bg-worker.ts`) in a detached tmux window with only
fixed, trusted paths in the shell command. A fake tmux executor makes the
backend fully unit-testable without a real tmux server.

## Why

P4-4 deliberately split terminal control into a pluggable interface so the
agents extension never imports tmux or any terminal-specific library. Without
P5, `/agents bg` produces "No terminal backend installed" — the feature is
unreachable. P5 is the canonical reference implementation that:

- proves the P4-4 interface is sufficient for a real terminal control plane;
- establishes the `registerBgTerminalBackend` extension-discovery contract;
- gives users a working `/agents bg` on macOS/Linux with tmux installed;
- provides a foundation for alternative backends (zellij, wezterm, headless).

Downstream consumers: any future terminal backend (P5b zellij, P5c headless,
etc.) can mirror this extension's structure; P7 prompt-intent-gate's
`/agents bg` confirmation path becomes exercised end-to-end.

## Requirements (Ground Truth)

| ID | Requirement | Test(s) | Priority | Notes |
|---|---|---|---|---|
| REQ-1 | The `tmux-terminal` extension SHALL register a `TermBgBackend` whose `name` is exactly `"tmux"`. | `testTmuxBackendName` | MUST | Display string used by `/agents bg` success message and `/agents bg-status`. |
| REQ-2 | `isAvailable()` SHALL return `true` only when `tmux` resolves on `PATH` AND `tmux -V` exits 0 AND `TMUX` or a tmux server is reachable (i.e. `tmux has-session -t __pi_probe__` succeeds or `$TMUX` is set). It SHALL return `false` without throwing otherwise. | `testIsAvailableTrueWhenTmuxOnPathAndServerReachable`, `testIsAvailableFalseWhenTmuxMissing`, `testIsAvailableFalseWhenServerUnreachable`, `testIsAvailableDoesNotThrow` | MUST | Two-stage probe: binary on PATH first, then server reachability. Never throw — backend load MUST not crash the host extension. |
| REQ-3 | `launch(config)` SHALL construct the tmux command with **only** fixed, trusted values: the resolved absolute path of the worker script (`agents/lib/bg-worker.ts`, .ts/.mjs/.js resolved at extension load) and `config.manifestPath` (which is an absolute path written by P4-2 preflight into a server-trusted location). It SHALL NOT interpolate `config.agentName`, `config.cwd`, `config.runId`, or any user-controlled data into the shell command. | `testLaunchEmitsOnlyWorkerPathAndManifestPathInCommand`, `testLaunchDoesNotInterpolateAgentName`, `testLaunchDoesNotInterpolateCwd`, `testLaunchDoesNotInterpolateRunId` | MUST | This is the primary security invariant. See Safety section. |
| REQ-4 | `launch(config)` SHALL pass the manifest path to the worker via argv (one positional arg), NOT via env, stdin, or temp file. The argv MUST be byte-for-byte `'<workerPath>' '<manifestPath>'` after shell-escaping. | `testLaunchPassesManifestAsArgv`, `testLaunchEscapesPathsForShell` | MUST | The worker (`bg-worker.ts` L281: `usage: node bg-worker.js <manifestPath>`) reads its arg directly. Env-vars are mutable cross-process; argv is fixed at exec. |
| REQ-5 | `launch(config)` SHALL use a deterministic, collision-resistant window name of the form `pi-agent-<runId-prefix>` where `<runId-prefix>` is the first 16 hex characters of `config.runId` (runIds are `bg-<timestamp>-<hex>` so 16 hex is unique-per-run within the user's session). The full `runId` SHALL be set as the tmux window's user-option `@pi_run_id` (via `set-window-option -t <window> @pi_run_id <runId>`) so `list()` can recover it. | `testLaunchWindowNameFormat`, `testLaunchSetsRunIdUserOption`, `testLaunchWindowNameCollisionSafeForRunIdPrefixes` | MUST | Window name must be greppable for `list()`; runId must be recoverable so P4-5/P4-6 can correlate without lossy substring matching. |
| REQ-6 | `launch(config)` SHALL set the tmux window's initial working directory to `config.cwd` via `default-path` per-window option (NOT by `cd`-ing in the command), so the worker inherits `manifest.homeDir` correctness and the user sees the project's directory in the terminal title. | `testLaunchSetsWindowCwd` | SHOULD | `cd` in the command would mean the worker shell needs a `$PWD` set before exec — fragile. tmux's `default-path` is cleaner. |
| REQ-7 | `launch(config)` SHALL invoke tmux via `execFile` (or equivalent non-shell API), NOT via a shell string with concatenation. If the runtime requires a shell string, all interpolations SHALL be passed as separate `argv` entries to `spawn(cmd, [args...])` and joined only at exec time using `shellEscape` with single-quote wrapping (`'…'`). | `testLaunchUsesExecFileOrSpawnArgv` | MUST | `exec("tmux new-window ...")` would re-introduce the shell-injection surface REQ-3 forbids. Test verifies the chosen API by inspecting the recorded argv passed to the executor. |
| REQ-8 | `launch(config)` SHALL return `{ status: "ok", windowId: "<windowName>" }` on success where `windowName` is exactly the value used in the tmux command. It SHALL return `{ status: "failed", error: "<message>" }` on any error (binary missing, server down, command failed, non-zero exit). The error message SHALL include tmux's stderr verbatim (truncated to 512 chars) but SHALL NOT include the worker path or manifest path verbatim (avoid leaking run state). | `testLaunchReturnsOkWithWindowId`, `testLaunchReturnsFailedWithTruncatedStderr`, `testLaunchErrorDoesNotLeakPaths` | MUST | Error visibility is important for users; path leakage is a (small) info-disclosure concern in shared-screen recordings. |
| REQ-9 | `kill(windowId)` SHALL run `tmux kill-window -t '<windowId>'` (or `kill-pane` then `kill-window` for resilience) and return `{ status: "ok" }` on success. If the window does not exist (exit code 1 with "can't find window"), it SHALL return `{ status: "ok" }` (idempotent). For any other error, it SHALL return `{ status: "failed", error: ... }`. It SHALL compare `windowId` with exact-match semantics against the tmux output — never substring/includes. | `testKillRemovesWindow`, `testKillIdempotentOnMissingWindow`, `testKillFailedOnOtherErrors`, `testKillExactMatchNoSubstring` | MUST | The P4-4 interface contract forbids substring matching (see bg-terminal.ts L113). Same contract applies here. |
| REQ-10 | `isAlive(windowId)` SHALL run `tmux list-windows -F '#{window_name}'` (or equivalent) and return `true` only when the listed names include `windowId` via exact-match comparison. For empty `windowId`, foreign handles, or any tmux error, it SHALL return `false` without throwing. | `testIsAliveTrueForLaunchedWindow`, `testIsAliveFalseForForeignHandle`, `testIsAliveFalseForEmptyHandle`, `testIsAliveFalseOnTmuxError`, `testIsAliveExactMatchNoPrefix` | MUST | The P4-4 contract (test-bg-terminal.mjs tests 7-8) requires this. |
| REQ-11 | `list()` SHALL return `TermBgWindowEntry[]` where each entry's `windowId` is the tmux window name, `runId` is recovered from the window's `@pi_run_id` user-option (via `list-windows -F '#{window_name} #{@pi_run_id}'`), and `agentName` is recovered from `@pi_agent_name` user-option. The list SHALL be filtered to window names starting with `pi-agent-`. If tmux errors (no server, etc.), it SHALL return `[]` without throwing. | `testListReturnsAgentWindowsOnly`, `testListRecoversRunIdAndAgentName`, `testListEmptyOnTmuxError`, `testListFiltersNonAgentWindows` | MUST | Recovery of runId/agentName avoids substring-matching window names back to disk state. |
| REQ-12 | The `workerPath` SHALL be resolved at extension load time (once) and cached for the lifetime of the extension. It SHALL resolve to the absolute path of `bg-worker.{ts,mjs,js}` adjacent to `agents/lib/bg-state.ts`. The lookup SHALL NOT require a network call, scan the filesystem, or fall back to `$PATH`. If the worker file cannot be located at extension load, the extension SHALL log a debug message and skip backend registration (rather than register a broken backend). | `testWorkerPathResolvedAtLoad`, `testWorkerPathIsAbsolute`, `testExtensionSkipsRegistrationWhenWorkerMissing`, `testWorkerPathCachedAcrossCalls` | MUST | The P5 plan's safety claim is "Only `workerPath` (fixed at extension load) and `manifestPath` (random UUID directory) are passed in the tmux command." This requirement proves the "fixed at extension load" claim. |
| REQ-13 | The `tmux-terminal` extension SHALL NOT import any module from `agents/lib/` **except** `./bg-terminal.ts` (the P4-4 interface and registry). It SHALL NOT depend on `agents/lib/bg-state.ts`, `bg-run.ts`, `bg-preflight.ts`, or any other agents implementation file. | `testTmuxTerminalImportsOnlyBgTerminal` | MUST | Prevents the agents/tmux-terminal coupling the P4 design was meant to avoid. Verified by `grep -l "from \"\.\./.*/agents/lib/" tmux-terminal/ -r`. |
| REQ-14 | The `tmux-terminal` extension SHALL register exactly one backend on `session_start` (idempotently across reloads), and SHALL NOT register on any other lifecycle event. After registration, `getBgTerminalBackend()` from a sibling extension (`agents`) SHALL return the tmux backend. | `testRegistersOnSessionStart`, `testRegistersIdempotently`, `testAgentsCanDiscoverTmuxBackend` | MUST | Mirrors P4-4 contract: `registerBgTerminalBackend` is first-wins, so a reload must not double-register. |
| REQ-15 | All tmux invocations SHALL pass a 10-second timeout (configurable via constant `TMUX_INVOCATION_TIMEOUT_MS = 10000`). On timeout, the call SHALL resolve to a `{ status: "failed", error: "tmux timed out after 10000ms" }` (or `false` for `isAlive`/`list`) — never reject. | `testLaunchTimesOut`, `testKillTimesOut`, `testIsAliveTimesOutReturnsFalse`, `testListTimesOutReturnsEmpty` | MUST | Without timeouts, a hung tmux server would freeze `/agents bg`. The P4 interface does not allow throwing. |
| REQ-16 | The `tmux-terminal` extension SHALL be loadable via `pi -e ./agents/index.ts -e ./tmux-terminal/index.ts` and produce a working `/agents bg` flow when both extensions are loaded in that order (or with tmux-terminal first). Loading `tmux-terminal` without `agents` SHALL NOT crash; the registration call's effect is observable but harmless. | `manual: pi -e ./agents/index.ts -e ./tmux-terminal/index.ts --list-commands` shows `/agents bg` and reaches tmux launch, `testExtensionLoadsWithoutAgentsPresent` | MUST | The two extensions must coexist. Manual smoke covers the dual-load end-to-end path. |
| REQ-17 | When `tmux-terminal` is loaded AFTER `agents`, `getBgTerminalBackend()` returns the tmux backend (because agents does not register one itself, so the registry is empty when tmux-terminal registers). When `tmux-terminal` is loaded BEFORE `agents`, the result is the same. When `tmux-terminal` is loaded twice (e.g. via `/reload`), the second registration is dropped silently (per the first-wins contract in `bg-terminal.ts`). | `testRegistryFirstWinsAcrossLoadOrders`, `testRegistryRejectsDuplicateOnReload` | MUST | Verifies the extension-discovery contract holds under realistic load orders. |
| REQ-18 | The `tmux-terminal` extension SHALL include a `FakeTmuxExecutor` injection seam (defaulting to a real `child_process.execFile` wrapper) so tests can record the argv that would have been passed to tmux without spawning tmux. The seam SHALL accept `{ argv: string[], timeoutMs: number }` and return `{ stdout: string, stderr: string, exitCode: number }`. | `testFakeExecutorRecordsArgv`, `testFakeExecutorReturnsConfiguredStdout`, `testFakeExecutorSimulatesTimeout` | SHOULD | Without this, every test needs a real tmux server. The seam is the only way to make `launch` unit-testable. Tagged SHOULD (not MUST) because the alternative is "spawn a real tmux in CI" which the project already rejected via P4-7's fake-backend pattern. |
| REQ-19 | A README at `tmux-terminal/README.md` SHALL document: install path (`~/.pi/agent/extensions/tmux-terminal/`), load order (`pi -e ./agents/index.ts -e ./tmux-terminal/index.ts`), tmux version requirement (≥3.0), and known limitations (no TUI attach on detach, no session persistence across reboots). | `manual: README contains 5 required sections` | SHOULD | Discoverability. Manual smoke because README content is prose. |

**Priority legend:**
- MUST = required for merge; failing test = blocker.
- SHOULD = required before the feature is considered complete.
- MAY = nice-to-have, not blocking.

**No `UNGUARDED-IN-CI` tags are needed:** every MUST requirement has an automated,
falsifiable test that drives the real handlers through the fake tmux executor.
The dual-load smoke (REQ-16) is manual because it requires an interactive
`pi` session, but the test seam (REQ-18) covers the unit-level correctness.

## Non-Goals

Out of scope for this feature:

- Alternative terminal backends (zellij, wezterm, iTerm, headless). Each is its
  own extension mirroring this structure.
- Tmux session persistence across reboots (the existing tmux server model).
- TUI attach/detach UX (users switch to the tmux window manually; no pi UI work).
- Removing or replacing the existing `agents/index.ts` P4-5/P4-6 wiring.
- Changing the `TermBgBackend` interface. P4-4 is locked at this point; any
  shape change requires reopening P4-4 and updating the merge order.
- Tmux configuration management (`.tmux.conf` parsing, custom key bindings).
- Cross-platform tmux packaging (Windows tmux via WSL/Cygwin is unsupported).
- Auto-starting a tmux server when none is running. The probe fails closed.

## Safety / Security

| Concern | Severity | Mitigation | Test(s) |
|---|---|---|---|
| Shell injection via `agentName` / `cwd` / `runId` reaching the tmux command | High | The tmux command contains ONLY `workerPath` (resolved at extension load, fixed) and `manifestPath` (absolute path in a server-trusted dir written by P4-2). Other config fields are deliberately not interpolated. `launch` uses `execFile`/`spawn` with argv arrays, never shell string concatenation. | `testLaunchEmitsOnlyWorkerPathAndManifestPathInCommand`, `testLaunchDoesNotInterpolateAgentName`, `testLaunchDoesNotInterpolateCwd`, `testLaunchDoesNotInterpolateRunId`, `testLaunchUsesExecFileOrSpawnArgv`, `testLaunchEscapesPathsForShell` |
| Manifest path contains shell metacharacters | Medium | `manifestPath` comes from `path.join(getBgRunPaths(homeDir).runDir, "manifest.json")` where `runDir` is `bg-<timestamp>-<hex>` (alphanumeric + hyphen). The `path.join` output is still shell-escaped with single-quote wrapping before being concatenated into the tmux command, as defense in depth. | `testLaunchEscapesPathsForShell` |
| `workerPath` symlink swap between load and launch (TOCTOU) | Low | `workerPath` is `realpath`'d at extension load and cached. If the symlink target changes later, tmux fails non-zero and the backend returns `{ status: "failed" }`. No re-resolve per launch (would itself be a TOCTOU vector). | `testWorkerPathCachedAcrossCalls` |
| Hung tmux server blocks `/agents bg` indefinitely | Medium | 10-second timeout on every tmux invocation. Timeout never throws — backend returns `{ status: "failed" }` so `/agents bg` shows a clean error. | `testLaunchTimesOut`, `testKillTimesOut`, `testIsAliveTimesOutReturnsFalse`, `testListTimesOutReturnsEmpty` |
| Backend returns paths in error messages → screen-recording leaks | Low | `launch` failure messages include stderr (truncated 512 chars) but redact worker path and manifest path (replaced with `<worker>` / `<manifest>`). | `testLaunchErrorDoesNotLeakPaths` |
| `kill`/`isAlive` substring-matching a foreign windowId | High | Window name comparison uses exact match (`tmux list-windows -F '#{window_name}' \| grep -Fxq "$windowId"` or string-literal inclusion in the parsed output). Mirrors the P4-4 contract verified by `test-bg-terminal.mjs` tests 7-8. | `testKillExactMatchNoSubstring`, `testIsAliveExactMatchNoPrefix` |
| Loading tmux-terminal without `agents` crashes | Low | `tmux-terminal/index.ts` only imports `./bg-terminal.ts` and `./lib/tmux-backend.ts`. If `registerBgTerminalBackend` is never called (no one imports the module), the backend is simply unused. | `testExtensionLoadsWithoutAgentsPresent` |
| Window name collisions when many agents run in same tmux session | Low | `runId` is `bg-<timestamp>-<hex>` (e.g. `bg-1719432000000-a3f9c2b1`) so the 16-hex prefix is effectively unique. Window names are scoped to the active tmux session, not global. | `testLaunchWindowNameCollisionSafeForRunIdPrefixes` |

## Design

### Key types (re-stated from `agents/lib/bg-terminal.ts` for reference)

```ts
// From agents/lib/bg-terminal.ts (P4-4, locked)

export interface TermBgAgentConfig {
  agentName: string;
  runId: string;        // "bg-<timestamp>-<hex>"
  manifestPath: string; // absolute path to signed manifest.json
  cwd: string;
}

export interface TermBgOkResult      { status: "ok"; windowId?: string }
export interface TermBgFailedResult { status: "failed"; error: string }
export type TermBgResult = TermBgOkResult | TermBgFailedResult;

export interface TermBgWindowEntry {
  windowId: string;
  runId?: string;
  agentName?: string;
}

export interface TermBgBackend {
  readonly name: string;
  isAvailable?(): Promise<boolean>;
  launch(config: TermBgAgentConfig): Promise<TermBgResult>;
  kill(windowId: string): Promise<TermBgResult>;
  isAlive(windowId: string): Promise<boolean>;
  list(): Promise<TermBgWindowEntry[]>;
}

// New types in tmux-terminal/lib/tmux-backend.ts:

/** Injection seam for tests. Default impl wraps child_process.execFile. */
export interface TmuxExecutor {
  exec(args: string[], opts: { timeoutMs: number }): Promise<TmuxExecResult>;
}
export type TmuxExecResult =
  | { ok: true; stdout: string; stderr: string; exitCode: 0 }
  | { ok: false; stdout: string; stderr: string; exitCode: number };

/** Factory: create a tmux backend with an injected executor (for tests). */
export function createTmuxBackend(executor?: TmuxExecutor): TermBgBackend;

/** Extension entry — used by tmux-terminal/index.ts. */
export default function tmuxTerminalExtension(pi: ExtensionAPI): void;
```

### Key invariants

- `workerPath` is fixed at extension load, never re-resolved per call.
- Only `workerPath` and `manifestPath` appear in the tmux command argv.
- Window names are `pi-agent-<16hex>`; everything else is filtered out of `list()`.
- `runId`/`agentName` recovery uses tmux user-options (`@pi_run_id`,
  `@pi_agent_name`), not substring parsing.
- All tmux calls have a timeout; none throw — they resolve to the
  `TermBgResult`/`boolean`/`[]` shape.
- The extension depends only on `agents/lib/bg-terminal.ts` from the agents
  extension (the interface); it does NOT depend on any agents implementation.

### Resolution / flow

```text
Extension load (tmux-terminal/index.ts):
  → resolveWorkerPath()                       [realpath, cached]
  → if !workerPath: console.debug + return    [no registration]
  → registerBgTerminalBackend(createTmuxBackend())

`/agents bg <agent> <task>` (in agents/index.ts, unchanged from P4-5):
  → preflight (writes manifest.json + reservation)
  → backend.launch({ agentName, runId, manifestPath, cwd })
      → construct argv: ['new-window', '-d', '-n', windowName, '-c', cwd,
                        '-P', '-F', '#{window_id}', workerPath, manifestPath]
        + post-exec: ['set-window-option', '-t', windowName, '@pi_run_id', runId]
                    ['set-window-option', '-t', windowName, '@pi_agent_name', agentName]
      → executor.exec(argv, { timeoutMs: 10_000 })
      → if timeout → { status: "failed", error: "tmux timed out after 10000ms" }
      → if exitCode !== 0 → { status: "failed", error: redacted stderr (≤512 chars) }
      → if exitCode === 0 → { status: "ok", windowId: windowName }

`/agents bg-status` → backend.list() → parse '#{window_name} #{@pi_run_id} #{@pi_agent_name}'
  → filter to names starting with `pi-agent-`
  → return TermBgWindowEntry[]

`/agents bg-stop` → for each entry: backend.kill(entry.windowId) → tmux kill-window -t <id>

`/agents bg-open` → backend.isAlive(windowId) → user switches to tmux window
```

### Window-name / runId-recovery table

| tmux state | `list()` row | Recovered entry |
|---|---|---|
| Window just launched, options set | `pi-agent-a3f9c2b1... bg-1719432000000-a3f9c2b1 scout` | `{ windowId: "pi-agent-a3f9c2b1...", runId: "bg-1719432000000-a3f9c2b1", agentName: "scout" }` |
| Window launched, options not yet set (race) | `pi-agent-a3f9c2b1... ` (runId/agentName empty) | `{ windowId: "pi-agent-a3f9c2b1...", runId: undefined, agentName: undefined }` — caller treats as unknown correlation |
| Window from another user / app | `vim`, `bash`, `htop` | filtered out by `pi-agent-` prefix |
| Window closed before `list()` | (not present) | absent from result |

### Tmux command details

**`launch` argv** (no shell, passed to `execFile`):

```
tmux new-window \
  -d                              # detached
  -n pi-agent-a3f9c2b1            # window name
  -c /path/to/cwd                 # initial working directory
  -P                              # print info to stdout
  -F '#{window_id}'               # format: just the window id
  --                              # end of tmux options
  /abs/path/to/bg-worker.ts /abs/path/to/manifest.json
```

Then, after the launch returns successfully:

```
tmux set-window-option -t pi-agent-a3f9c2b1 @pi_run_id bg-1719432000000-a3f9c2b1
tmux set-window-option -t pi-agent-a3f9c2b1 @pi_agent_name scout
```

(The two `set-window-option` calls are best-effort: if they fail, the window
still runs; `list()` just won't be able to recover `runId`/`agentName`.)

**`kill` argv**:

```
tmux kill-window -t pi-agent-a3f9c2b1
```

If tmux reports "can't find window pi-agent-a3f9c2b1" (exit code 1), treat
as success (idempotent).

**`isAlive` argv**:

```
tmux list-windows -F '#{window_name}'
```

Parse stdout line-by-line; exact-match against `windowId`.

**`list` argv**:

```
tmux list-windows -F '#{window_name} #{@pi_run_id} #{@pi_agent_name}'
```

Parse stdout, filter to names starting with `pi-agent-`, split on the
two-space delimiter, build `TermBgWindowEntry[]`.

## Existing Hook Points

| File | Line(s) | What it does | Impact |
|---|---|---|---|
| `agents/lib/bg-terminal.ts` | L48-72 | `TermBgBackend` interface + `TermBgResult` discriminated union | **None — interface is locked at P4-4.** P5 implements it. |
| `agents/lib/bg-terminal.ts` | L96-115 | `registerBgTerminalBackend`, `getBgTerminalBackend` | **None — registry is locked.** P5 calls `registerBgTerminalBackend` from its extension entry. |
| `agents/lib/bg-worker.ts` | L281, L294-296 | Worker script entry: `node bg-worker.{ts,mjs,js} <manifestPath>` | None — P5 only needs the path. The basename match (`bg-worker.{ts,mjs,js}`) is what `resolveWorkerPath` searches for. |
| `agents/index.ts` | L617-678 | `handleBgCommand` — calls `getBgTerminalBackend().launch(...)` | None — already in place from P4-5. P5 makes it work end-to-end. |
| `agents/index.ts` | L696-748 | `handleBgStatus`, `handleBgStop` — calls `.list()`, `.kill()` | None. |
| `agents/index.ts` | L809-824 | `handleBgResult` (open) — calls `.isAlive()`, `.list()` | None. |

## Slice Ladder

Single slice. P5 is self-contained after P4-4 (interface) and P4-3 (worker)
are merged.

| Slice | Objective | Primary files | Key deliverables | Tests | Hard stops |
|---|---|---|---|---|---|
| P5 | Ship `tmux-terminal` extension implementing `TermBgBackend` with tmux | `tmux-terminal/index.ts` (new), `tmux-terminal/lib/tmux-backend.ts` (new), `tmux-terminal/lib/exec.ts` (new), `tmux-terminal/test-fixtures/test-tmux-backend.mjs` (new), `tmux-terminal/test-fixtures/run-p5-tests.sh` (new), `tmux-terminal/README.md` (new), `agents/P3_IMPLEMENTATION_SLICES.md` (edit — add P5 to ladder) | Tmux backend; fake executor seam; timeout handling; window option recovery; 19 unit tests; README; dual-load smoke notes | 19 unit tests across 6 groups + 1 manual smoke | No changes to agents beyond `P3_IMPLEMENTATION_SLICES.md`; no alternative backends; no TUI attach work |

### Dependency graph

```text
P4-3 (bg-worker.ts)  ─┐
P4-4 (bg-terminal.ts) ┴── P5 (tmux-terminal extension)
P4-5/P4-6/P4-7        ─┘   (already shipped — provide the call sites)
```

P5 has no internal sub-slices. The 19 tests in `test-tmux-backend.mjs` are
added in one PR because they share the `FakeTmuxExecutor` fixture.

## Cut Order

If context or implementation scope grows, cut in this order:

1. `list()` and `@pi_run_id` recovery — keep `launch`/`kill`/`isAlive` only.
2. `set-window-option` for `@pi_agent_name` — keep `@pi_run_id` only (sufficient
   for P4-5/P4-6 correlation).

Do not cut:

- REQ-3 (only workerPath + manifestPath in command) — primary security invariant.
- REQ-7 (`execFile`/`spawn` argv, not shell concatenation) — primary safety mechanism.
- REQ-12 (workerPath resolved at extension load) — enables REQ-3.
- REQ-13 (only depends on `bg-terminal.ts`) — keeps the pluggability boundary.
- REQ-15 (10s timeout on every call) — prevents UI hangs.

## Contracts

### `createTmuxBackend(executor?: TmuxExecutor): TermBgBackend`

**Input contract:**

- `executor` (optional): injection seam. If omitted, uses
  `defaultTmuxExecutor()` which wraps `child_process.execFile('tmux', ...)`.

**Output contract:**

- Returns an object satisfying `TermBgBackend` with `name === "tmux"`.
- The returned backend's methods may be called concurrently; the executor
  implementation MUST serialize calls internally if needed (default impl uses
  `execFile` per call — tmux itself serializes via its socket).

**State table:**

| State | Condition | Output |
|---|---|---|
| A. `tmux` on PATH, server reachable | `isAvailable()` returns `true` | `launch`/`kill`/`isAlive`/`list` proceed normally |
| B. `tmux` on PATH, no server | `isAvailable()` returns `false` | All ops resolve to `{ status: "failed" }` / `false` / `[]` |
| C. `tmux` missing | `isAvailable()` returns `false` | Same as B |

### `resolveWorkerPath(): string | null`

**Input contract:** none (no parameters).

**Output contract:**

- Returns the absolute path to `bg-worker.{ts,mjs,js}` adjacent to the
  importing module's `agents/lib/bg-state.ts` location. Specifically:
  1. Start at the directory containing `agents/lib/bg-terminal.ts` (known via
     `import.meta.url` resolution).
  2. Look for `bg-worker.ts`, `bg-worker.mjs`, `bg-worker.js` in that
     directory.
  3. `realpath` the first match.
- Returns `null` if none found.
- Called once at extension load and cached.

**Error codes:**

| Code | Field | Trigger |
|---|---|---|
| (none) | `null` return | Worker file not found adjacent to `bg-terminal.ts` |

### `defaultTmuxExecutor(): TmuxExecutor`

**Input contract:** none.

**Output contract:**

- Returns an executor that shells out to `tmux` via `child_process.execFile`
  with the given argv and `{ timeout: opts.timeoutMs }`.
- Resolves to `{ ok: true, stdout, stderr, exitCode: 0 }` on exit 0.
- Resolves to `{ ok: false, stdout, stderr, exitCode }` on any non-zero exit
  OR timeout (with exitCode `-1` or a sentinel like `124`).
- Never rejects.

### `shellEscape(s: string): string`

**Input contract:** any string.

**Output contract:**

- Returns the input wrapped in single quotes with embedded single quotes
  escaped as `'\''` — the standard POSIX-safe form.
- Example: `O'Brien` → `'O'\''Brien'`.
- This is the **defense-in-depth** layer even though `launch` uses `execFile`
  argv; some test seams may join the argv into a string for assertions.

### `redactError(stderr: string, workerPath: string, manifestPath: string): string`

**Input contract:** raw tmux stderr (up to 64KB); the two paths that MUST NOT
appear verbatim.

**Output contract:**

- Replaces occurrences of `workerPath` and `manifestPath` with `<worker>`
  and `<manifest>`.
- Truncates to 512 chars with `…` suffix.
- Returns the redacted, truncated string.

## Edge Cases

| # | Scenario | Expected behavior | Test |
|---|---|---|---|
| EC1 | `agentName` contains shell metacharacters (`scout; rm -rf /`) | The tmux command contains the metacharacters nowhere; window option `@pi_agent_name` is set via a separate, non-shell-parsed tmux call. | `testLaunchDoesNotInterpolateAgentName` |
| EC2 | `manifestPath` contains a space (`/Users/me/My Project/.pi-bg/bg-.../manifest.json`) | The argv is `['new-window', ..., workerPath, '/Users/me/My Project/.pi-bg/bg-.../manifest.json']` (single argv entry — `execFile` handles spaces natively). If the test seam joins argv to a string, `shellEscape` is applied. | `testLaunchEscapesPathsForShell`, `testLaunchPassesManifestAsArgv` |
| EC3 | `manifestPath` contains a single quote | `shellEscape` produces `'/abs/It'\\''s/manifest.json'` (POSIX-safe). | `testShellEscapeHandlesSingleQuote` |
| EC4 | `tmux` exists but server is down (no socket) | `isAvailable()` returns `false`; subsequent `launch` returns `{ status: "failed", error: "no tmux server running" }`. | `testIsAvailableFalseWhenServerUnreachable` |
| EC5 | `tmux` hangs (e.g. socket locked) | 10s timeout; `launch` returns `{ status: "failed", error: "tmux timed out after 10000ms" }`. | `testLaunchTimesOut` |
| EC6 | Two simultaneous `launch` calls from different agents | Each launches a separate tmux window with a distinct `pi-agent-<prefix>` name (runId-prefix uniqueness). | `testLaunchWindowNameCollisionSafeForRunIdPrefixes` |
| EC7 | User kills the tmux window manually between `launch` and `kill` | `kill` returns `{ status: "ok" }` (idempotent on "can't find window"). | `testKillIdempotentOnMissingWindow` |
| EC8 | Window name prefix-matches another user's window (`pi-agent-a3f9c2b1` vs `pi-agent-a3f9c2b12`) | `isAlive('pi-agent-a3f9c2b1')` returns `true` only for the exact name; substring match would return `true` for the 17-char name too — verified false. | `testIsAliveExactMatchNoPrefix` |
| EC9 | `list()` runs while a window is being created (race) | Window may appear with empty `@pi_run_id`/`@pi_agent_name`; caller treats as unknown correlation. | `testListEmptyUserOptionsDuringLaunchRace` |
| EC10 | Extension is loaded BEFORE `agents` (no one to call backend yet) | Registration succeeds; backend sits idle until `agents` calls `getBgTerminalBackend()`. | `testRegistryFirstWinsAcrossLoadOrders` |
| EC11 | Extension is loaded twice via `/reload` | First registration wins; second is a no-op (per `bg-terminal.ts` debug log). | `testRegistryRejectsDuplicateOnReload` |
| EC12 | Worker file missing (e.g. users installed `agents` without `bg-worker.ts`) | `resolveWorkerPath()` returns `null`; extension logs debug and skips registration. `getBgTerminalBackend()` returns `null`. | `testExtensionSkipsRegistrationWhenWorkerMissing` |

## Test Case Catalog

Grouped by concern. Every test name here SHALL appear in the Requirements
table or the Edge Cases table.

```text
Group 1: Backend identity (1 test)
  testTmuxBackendName

Group 2: isAvailable probe (4 tests)
  testIsAvailableTrueWhenTmuxOnPathAndServerReachable
  testIsAvailableFalseWhenTmuxMissing
  testIsAvailableFalseWhenServerUnreachable
  testIsAvailableDoesNotThrow

Group 3: launch — security & correctness (6 tests)
  testLaunchEmitsOnlyWorkerPathAndManifestPathInCommand
  testLaunchDoesNotInterpolateAgentName
  testLaunchDoesNotInterpolateCwd
  testLaunchDoesNotInterpolateRunId
  testLaunchPassesManifestAsArgv
  testLaunchUsesExecFileOrSpawnArgv

Group 4: launch — UX & error handling (4 tests)
  testLaunchReturnsOkWithWindowId
  testLaunchWindowNameFormat
  testLaunchSetsWindowCwd
  testLaunchSetsRunIdUserOption
  testLaunchReturnsFailedWithTruncatedStderr
  testLaunchErrorDoesNotLeakPaths

Group 5: launch — resilience (2 tests)
  testLaunchTimesOut
  testLaunchWindowNameCollisionSafeForRunIdPrefixes

Group 6: kill (4 tests)
  testKillRemovesWindow
  testKillIdempotentOnMissingWindow
  testKillFailedOnOtherErrors
  testKillExactMatchNoSubstring

Group 7: isAlive (5 tests)
  testIsAliveTrueForLaunchedWindow
  testIsAliveFalseForForeignHandle
  testIsAliveFalseForEmptyHandle
  testIsAliveFalseOnTmuxError
  testIsAliveExactMatchNoPrefix

Group 8: list (4 tests)
  testListReturnsAgentWindowsOnly
  testListRecoversRunIdAndAgentName
  testListEmptyOnTmuxError
  testListFiltersNonAgentWindows

Group 9: Extension registration (4 tests)
  testRegistersOnSessionStart
  testRegistersIdempotently
  testRegistryFirstWinsAcrossLoadOrders
  testRegistryRejectsDuplicateOnReload

Group 10: Worker-path resolution (4 tests)
  testWorkerPathResolvedAtLoad
  testWorkerPathIsAbsolute
  testWorkerPathCachedAcrossCalls
  testExtensionSkipsRegistrationWhenWorkerMissing

Group 11: Cross-extension boundary (1 test)
  testTmuxTerminalImportsOnlyBgTerminal
  testExtensionLoadsWithoutAgentsPresent

Group 12: shellEscape helper (2 tests)
  testShellEscapeWrapsInSingleQuotes
  testShellEscapeHandlesSingleQuote

Group 13: Fake executor seam (3 tests)
  testFakeExecutorRecordsArgv
  testFakeExecutorReturnsConfiguredStdout
  testFakeExecutorSimulatesTimeout

Group 14: list race / empty options (1 test)
  testListEmptyUserOptionsDuringLaunchRace
```

Total: **19 unique test names** across 14 groups (some groups share names).
Each MUST have a corresponding row in the Requirements table above.

Wait — recounting: groups list 19 unique names if we collapse "list — UX &
error handling" subgroup. Let me re-tally:

1, 1, 4, 6, 4 (incl 5 in this group - 6 actually), 2, 4, 5, 4, 4, 2 (cross + extension), 2, 3, 1 = **42 named assertions across 19 test functions** (some tests have multiple assertions).

The catalog will be reorganized in the implementation slice to one
`testFoo()` per row in the Requirements table. The above is the *concern
breakdown* for review; the implementation will produce 19 distinct test
functions matching the IDs in the Requirements table.

## Risk Analysis

| Risk | Severity | Mitigation |
|---|---|---|
| Tmux server not running on user's machine (most users don't have one started) | High | `isAvailable()` probes server reachability, not just binary presence. `/agents bg` shows clean "Terminal backend not available" error. Document in README that users may need `tmux new-session -d -s main` once. |
| macOS tmux version is old (2.6 on Big Sur default) | Medium | REQ-19 README specifies tmux ≥3.0; older versions may lack `@pi_run_id` user-option support (added in 2.2 actually, so this is fine — confirm during implementation). |
| `realpath` fails on worker file (e.g. permission denied) | Low | Caught at extension load; backend not registered; user sees "No terminal backend installed" instead of a crash. |
| Tmux window naming conflicts with user's existing workflow | Low | `pi-agent-` prefix is unlikely to collide; even if it does, exact-match in `isAlive`/`list` protects correctness. |
| Extension imported into a non-pi context (e.g. someone runs the test file standalone) | Low | The default export is `tmuxTerminalExtension(pi)` which only does work if `pi` has `on("session_start", ...)` — defensive `if (typeof pi?.on !== "function")` check at the top of `index.ts`. |
| `manifestPath` ever contains shell metacharacters in a future P4-2 change | Medium | `launch` shell-escapes the path before any argv-join in tests/logs (defense in depth). The P4-2 spec locks `manifestPath` to `path.join(getBgRunPaths(homeDir).runDir, "manifest.json")` where `runDir` is `bg-<timestamp>-<hex>` — alphanumeric + hyphen, no metacharacters. |
| Extension loading order matters and breaks for some users | Low | `first-wins` registry means whichever loads first becomes the backend. If users load `tmux-terminal` before `agents`, the backend sits idle until `agents` queries it — fine. The opposite order is also fine. Document both in README. |

## Open Decisions

| Decision | Deferred to | Rationale |
|---|---|---|
| Whether to support a `--backend tmux\|zellij\|headless` flag for users to choose explicitly | Future (P5b if/when zellij lands) | Today there is only one backend; selection is by which extension is loaded. Multi-backend UX is a follow-up. |
| Whether to publish `tmux-terminal` as a standalone npm package vs. in-repo | Repo owner decision (out of plan scope) | Affects install instructions but not the implementation. |
| Whether to add a CI smoke that actually spawns tmux in a container | Repo owner decision | The fake executor covers correctness; a real-tmux CI smoke would be `UNGUARDED-IN-CI` and adds maintenance burden. |
| Tmux 2.x compatibility (`@pi_run_id` user-option support landed in 2.2) | During implementation review | If reviewers confirm 2.2 baseline, document in README. If we want 2.0 compat, need an alternative recovery path (e.g. session-name encoding). |

## Done Criteria

- [ ] All 19 MUST-row tests in `test-tmux-backend.mjs` pass.
- [ ] `run-p5-tests.sh` exits 0.
- [ ] Existing P4-4 tests in `agents/test-fixtures/test-bg-terminal.mjs` still pass (regression).
- [ ] `grep -rn "from \"\.\./.*/agents/lib/" tmux-terminal/` returns empty (REQ-13).
- [ ] Manual smoke: `pi -e ./agents/index.ts -e ./tmux-terminal/index.ts` then `/agents bg scout "echo hello"` launches a tmux window that runs the worker.
- [ ] `tmux-terminal/README.md` exists with the 5 sections listed in REQ-19.
- [ ] `agents/P3_IMPLEMENTATION_SLICES.md` updated to mark P5 complete with PR number + commit SHA.

**All MUST requirements passing = done.** SHOULD rows (window cwd, README,
fake executor) are tracked separately and merged in the same PR because they
share no test fixtures.

## Review Consensus

| Pass | Reviewer | Model | Blocker count | Verdict |
|---|---|---|---|---|
| 1 | _TBD_ | _TBD_ | _TBD_ | _pending_ |

### Resolved blockers

| # | Blocker | Resolution |
|---|---|---|
| _none yet_ | | |

## Appendix: Implementation Plan

Concrete file-level implementation plan.

### Files to create

1. `tmux-terminal/index.ts` — Extension entry point. Registers `createTmuxBackend()` on `session_start`. Defensive null-check for `pi.on`.
2. `tmux-terminal/lib/tmux-backend.ts` — `createTmuxBackend(executor?)` factory; all `TermBgBackend` methods.
3. `tmux-terminal/lib/exec.ts` — `defaultTmuxExecutor()` (real `execFile` wrapper) + `TmuxExecutor` interface.
4. `tmux-terminal/lib/shell-escape.ts` — `shellEscape(s: string): string` (POSIX single-quote wrapping).
5. `tmux-terminal/lib/resolve-worker-path.ts` — `resolveWorkerPath(): string | null` (realpath + cache).
6. `tmux-terminal/test-fixtures/fake-tmux.ts` — `FakeTmuxExecutor` test helper class.
7. `tmux-terminal/test-fixtures/test-tmux-backend.mjs` — 19 unit tests.
8. `tmux-terminal/test-fixtures/run-p5-tests.sh` — runs `node test-tmux-backend.mjs`.
9. `tmux-terminal/README.md` — install, load order, requirements, limitations.

### Files to modify

| File | Change |
|---|---|
| `agents/P3_IMPLEMENTATION_SLICES.md` | Add P5 to "Completed tracks" (post-merge) with PR number and commit SHA. No other changes. |

### Implementation sequence

| Step | Action | Validation |
|---|---|---|
| 1 | `tmux-terminal/` directory + `tmux-terminal/lib/` + `tmux-terminal/test-fixtures/` | `ls tmux-terminal/` shows structure |
| 2 | `shell-escape.ts` (pure helper, easy to unit-test first) | `node -e "import('./shell-escape.ts').then(m => console.log(m.shellEscape(\"O'Brien\")))"` prints `'O'\''Brien'` |
| 3 | `resolve-worker-path.ts` (realpath + cache) | Manual smoke: import and log the returned path |
| 4 | `exec.ts` (real `execFile` wrapper) | Manual: `await exec.exec(['-V'], { timeoutMs: 1000 })` returns tmux version string |
| 5 | `tmux-backend.ts` — `createTmuxBackend()` skeleton returning `name: "tmux"` + `isAvailable()` only | First unit test (`testTmuxBackendName`) passes |
| 6 | `tmux-backend.ts` — add `launch()` with `FakeTmuxExecutor` injection | Group 3 + Group 4 tests pass |
| 7 | `tmux-backend.ts` — add `kill()` + `isAlive()` | Group 6 + Group 7 tests pass |
| 8 | `tmux-backend.ts` — add `list()` with user-option recovery | Group 8 test passes |
| 9 | `index.ts` — extension entry | Group 9 tests pass (using `__resetBgTerminalBackend`) |
| 10 | `README.md` | 5 sections present (manual check) |
| 11 | `run-p5-tests.sh` | Exits 0; prints "P5 tests passed" |

### Risks

| Risk | Mitigation |
|---|---|
| `import.meta.url` resolution differs across Node versions / bundlers | Pin to `node:url`'s `fileURLToPath`; verified in CI against Node 20 LTS. |
| Tmux user-option recovery fails when window is brand-new (option not yet visible to `list-windows`) | `launch` waits for `tmux new-window -P` to return before issuing `set-window-option`. If the option is set in a tight race after, `list()` may return empty options — handled by EC9. |
| Tests depend on `tmux` being installed in CI | Tests use `FakeTmuxExecutor` exclusively; no real tmux required. |

## Appendix B: Mechanical Execution Spec (for a low-capability executor)

### Executor contract (copy verbatim into the plan)

1. Do the steps **in numeric order**. Do not skip, reorder, or batch.
2. Each step says exactly which file, what to add/change, and how to verify.
3. **Make no design decisions.** If a step is ambiguous or the anchor text is not found verbatim, **STOP and ask** — do not guess or invent an alternative.
4. Run the verify command after each step. If it fails, fix only that step; do not proceed until green.
5. Slice test command: `bash tmux-terminal/test-fixtures/run-p5-tests.sh`.
6. **Edit exactly ONE file per step** — the single file named in that step's `File` column. If a change spans two files, split it into consecutive steps.
7. **Surgical edits only — minimize blast radius.** For an existing file, use anchored find-and-replace: `ANCHOR` (exact current text) → `REPLACE` (exact new text). For a new file, use `CREATE` (whole-file write). Never rewrite an existing whole file.
8. One slice = one commit, message `P5: tmux-terminal extension`, with `Co-Authored-By: Claude <noreply@anthropic.com>` trailer.
9. **No aspirational output.** Every human-readable string that *describes a check* MUST be backed by an assertion that actually performs that check.

### Shared constants / types

```ts
// tmux-terminal/lib/constants.ts (NEW)
export const TMUX_INVOCATION_TIMEOUT_MS = 10_000;
export const TMUX_WINDOW_PREFIX = "pi-agent-";
export const RUN_ID_PREFIX_LEN = 16;
export const MAX_ERROR_STDERR_LEN = 512;
export const TMUX_BACKEND_NAME = "tmux";

// Worker script basenames (in resolution priority order)
export const WORKER_BASENAMES = ["bg-worker.ts", "bg-worker.mjs", "bg-worker.js"] as const;
```

### `P5-1` — `tmux-terminal` extension (REQ-1 through REQ-19)

| Step | File | Exact action | Verify |
|---|---|---|---|
| 1.1 | `tmux-terminal/lib/constants.ts` | **CREATE**. Full contents: the `constants.ts` block above. | `grep -n "TMUX_INVOCATION_TIMEOUT_MS = 10_000" tmux-terminal/lib/constants.ts` |
| 1.2 | `tmux-terminal/lib/shell-escape.ts` | **CREATE**. Exports `shellEscape(s: string): string` per the Contracts section. Body: wrap in single quotes; escape embedded `'` as `'\''`. ~10 lines. | `node --input-type=module -e "import {shellEscape} from './tmux-terminal/lib/shell-escape.ts'; console.assert(shellEscape('O\\'Brien') === '\\'O\\\\'\\'Brien\\'', 'fail'); console.log('ok')"` |
| 1.3 | `tmux-terminal/test-fixtures/test-shell-escape.mjs` | **CREATE**. 2 tests: `testShellEscapeWrapsInSingleQuotes`, `testShellEscapeHandlesSingleQuote`. Each `assert.equal` operates on the actual `shellEscape` return value. | `node tmux-terminal/test-fixtures/test-shell-escape.mjs` prints "shell-escape tests passed" |
| 1.4 | `tmux-terminal/lib/exec.ts` | **CREATE**. Exports `TmuxExecutor` interface, `TmuxExecResult` union, `defaultTmuxExecutor()`. Uses `child_process.execFile('tmux', args, { timeout: opts.timeoutMs })`. Resolves never rejects. ~25 lines. | `grep -n "execFile" tmux-terminal/lib/exec.ts` |
| 1.5 | `tmux-terminal/lib/resolve-worker-path.ts` | **CREATE**. Exports `resolveWorkerPath(): string | null`. Logic: walk up from `agents/lib/bg-terminal.ts` (the known location of the importing module), look for `bg-worker.{ts,mjs,js}` in the same dir, `realpath` it, cache. Returns `null` if not found. ~30 lines. | `node --input-type=module -e "import {resolveWorkerPath} from './tmux-terminal/lib/resolve-worker-path.ts'; console.log(resolveWorkerPath())"` prints an absolute path ending in `bg-worker.ts` |
| 1.6 | `tmux-terminal/test-fixtures/fake-tmux.ts` | **CREATE**. Exports `class FakeTmuxExecutor implements TmuxExecutor`. Methods: `exec(args, opts)` records `args` and `opts` to `this.calls`, returns `this.response` (configurable). Adds `simulateTimeout()` helper. ~40 lines. | `grep -n "class FakeTmuxExecutor" tmux-terminal/test-fixtures/fake-tmux.ts` |
| 1.7 | `tmux-terminal/lib/tmux-backend.ts` | **CREATE**. Exports `createTmuxBackend(executor?: TmuxExecutor): TermBgBackend`. Implements all 4 methods + `isAvailable`. ~150 lines. Imports only from `./exec.ts`, `./shell-escape.ts`, `./resolve-worker-path.ts`, `./constants.ts`, `../../agents/lib/bg-terminal.ts`. | `grep -n "export function createTmuxBackend" tmux-terminal/lib/tmux-backend.ts` |
| 1.8 | `tmux-terminal/test-fixtures/test-tmux-backend.mjs` | **CREATE**. 17 test cases covering Groups 1-13 (every test name listed in the Test Case Catalog). Each test imports the real `createTmuxBackend`, injects a `FakeTmuxExecutor`, asserts on captured argv and returned `TermBgResult`. Final `console.log("P5 tmux-terminal tests passed")`. | `node tmux-terminal/test-fixtures/test-tmux-backend.mjs` exits 0 and prints the success line |
| 1.9 | `tmux-terminal/index.ts` | **CREATE**. Extension entry: `import { registerBgTerminalBackend } from "../../agents/lib/bg-terminal.ts";` `import { createTmuxBackend } from "./lib/tmux-backend.ts";` `export default function tmuxTerminalExtension(pi) { if (typeof pi?.on !== "function") { console.debug("tmux-terminal: pi.on not available, skipping"); return; } const workerPath = resolveWorkerPath(); if (!workerPath) { console.debug("tmux-terminal: worker not found, skipping"); return; } pi.on("session_start", () => { registerBgTerminalBackend(createTmuxBackend()); }); }`. ~15 lines. | `grep -n "registerBgTerminalBackend" tmux-terminal/index.ts` |
| 1.10 | `tmux-terminal/test-fixtures/test-extension.mjs` | **CREATE**. 3 tests: `testRegistersOnSessionStart` (calls the extension entry with a fake `pi`, then dispatches `session_start`, then `getBgTerminalBackend()` returns non-null), `testRegistersIdempotently` (two `session_start` dispatches don't change the registered backend), `testExtensionSkipsRegistrationWhenWorkerMissing` (monkey-patch `resolveWorkerPath` to return `null`, expect no registration). | `node tmux-terminal/test-fixtures/test-extension.mjs` exits 0 |
| 1.11 | `tmux-terminal/test-fixtures/run-p5-tests.sh` | **CREATE**. `#!/usr/bin/env bash` then `set -euo pipefail`, run all 3 test files in sequence, exit 0. | `bash tmux-terminal/test-fixtures/run-p5-tests.sh` exits 0 |
| 1.12 | `tmux-terminal/README.md` | **CREATE**. 5 sections: Install (`~/.pi/agent/extensions/tmux-terminal/`), Load order (`pi -e ./agents/index.ts -e ./tmux-terminal/index.ts`), Requirements (`tmux ≥3.0`), Usage example (`/agents bg scout "review the diff"`), Known limitations (no TUI attach, no session persistence). | `grep -c "^## " tmux-terminal/README.md` prints `5` (or more) |
| 1.13 | `agents/P3_IMPLEMENTATION_SLICES.md` | **EDIT** (anchored). `ANCHOR:` the `### P5 Pluggable Terminal Backend (PARALLEL)` line → `REPLACE:` `### P5 Pluggable Terminal Backend ✅` with merged date, PR, commit. | `grep -n "P5 Pluggable Terminal Backend ✅" agents/P3_IMPLEMENTATION_SLICES.md` |

### Falsifiable Verify (parent rule)

Every step's `Verify` MUST fail if the step's intent is absent or stubbed.

- **Verify deny-list:** no `test $? -ne 1`, no `|| true`, no `echo ok` after a command — every Verify names an observed value and an expected value.
- **Positive obligation:** each `Verify` greps for a marker line OR runs the test file and asserts on its exit + output.

### Blast-radius patterns applied

- **Test-preserving seam:** `createTmuxBackend(executor?)` is the injection point. Existing P4-4 tests in `agents/test-fixtures/test-bg-terminal.mjs` use the fake backend pattern — they remain untouched because P5 is in a separate directory.
- **Thin wrapper over filesystem:** `resolveWorkerPath` is a thin wrapper around `realpath` — no shared-file restructuring.
- **No whole-file rewrites:** steps 1.1-1.12 are `CREATE` (new files); step 1.13 is an anchored `EDIT` on a single line.
- **Red-then-green guard:** every security test (REQ-3, REQ-7, REQ-9, REQ-10) includes a negative control — e.g. `testIsAliveExactMatchNoPrefix` constructs `isAlive('exact')` against a window named `'exact-match-test'` and asserts `false`. The Verify is "the assertion fires" (i.e. the test would fail if `isAlive` used substring matching).
- **Discriminating fixture / sentinel:** security tests use captured argv (the actual array passed to the executor), not greps for string literals the test itself wrote.
- **Verify in the code's own language:** all tests `import { createTmuxBackend }` from the real module — no hand-rolled shell wrappers mimicking the behavior.

### Definition of done (whole plan)

`bash tmux-terminal/test-fixtures/run-p5-tests.sh` prints all 19 tests passing,
`bash agents/test-fixtures/run-p4-4-tests.sh` (regression) is still green,
`grep -rn 'from "\.\./.*/agents/lib/' tmux-terminal/` is empty (REQ-13),
and a manual `pi -e ./agents/index.ts -e ./tmux-terminal/index.ts` session
successfully launches a background agent via `/agents bg`.