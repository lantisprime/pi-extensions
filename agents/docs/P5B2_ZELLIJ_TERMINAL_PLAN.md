# P5b-2 Zellij-Terminal Backend Plan

## Status

Planning only. Do not implement until this plan, plan review, and adversarial review are accepted.

## Episode Search Summary

Searched episodic memory for `p5b`, `zellij`, `terminal backend`, `TermBgBackend`, `cli-spike`.

Key active memories:

- `20260704-084734-zellij-cli-spike-complete-0-44-3-install-28a1`: Zellij CLI spike COMPLETE (0.44.3, installed). Two-step detached launch verified (`attach -b` creates detached session, exits cleanly after ~2s with no TTY; `zellij -s <name> run --name <pane> --cwd <cwd> --close-on-exit -- <cmd> <args>` returns `terminal_<id>`). `list-sessions -s` exits 1 when empty / 0 when non-empty. `kill-session` exits 1 + "No session named X found." on missing. `delete-session -f` clears zombies. Full captured output at `zellij-terminal/docs/cli-spike-output.txt`.
- `20260704-083722-post-merge-sync-p5e1-backend-selector-co-64a1`: canonical workplan head; P5b alternative backends is the next-natural follow-up, now testable via the `--backend <name>` seam P5E1 shipped.
- `20260628-115957-handoff-p5b-1-s1-complete-p5b-1-s2-is-ne-be85`: P5b-1 (cmux-terminal) handoff context (the most recent backend, used as the structural reference).

## Objective

Ship a third `TermBgBackend` (`zellij-terminal`) that lets `/agents bg` launch background agents in detached zellij sessions, selectable per-launch via the `--backend zellij` flag P5E1 just shipped. Mirrors `tmux-terminal`/`cmux-terminal` 1:1 in structure (self-contained extension, argv-only executor, `pi-<backend>-<runId>` naming), differing only in the zellij CLI surface and the two-step detached-launch primitive the spike verified.

## Why

P5b alternative terminal backends is the next-natural follow-on after P5d + P5E1. With the `--backend <name>` selector shipped, every new backend is now cleanly testable from the CLI (`/agents bg --backend zellij ...`), and the pluggable `TermBgBackend` seam is exercised end-to-end by a third caller — proving the seam generalizes beyond tmux/cmux. Zellij is the closest analog to tmux/cmux (session-based, detached-runnable, CLI-driven), making it the natural first P5b backend. Wezterm/headless follow the same pattern once this lands.

## Requirements (Ground Truth)

Every requirement SHALL be testable and SHALL map to at least one test or validation check.

| ID | Requirement | Test(s) | Priority | Notes |
|---|---|---|---|---|
| REQ-1 | A new `zellij-terminal/` extension SHALL register exactly one `TermBgBackend` on `session_start`. The registry is append-only (a reload re-appends a duplicate; the existing `selectBgTerminalBackend` probes each in preference order and the first available wins, so a duplicate registration is harmless but not deduplicated — matches tmux/cmux behavior). Registration is skipped silently (debug-logged) if the bg-worker file is not found adjacent to `agents/lib/bg-terminal.ts`. | `testRegistersOnSessionStart`, `testSkipsRegistrationWhenWorkerMissing` | MUST | Mirrors tmux-terminal REQ-12/REQ-14 + cmux-terminal S1. The registry (`Symbol.for` slot) already handles cross-instance visibility; this slice only adds a third `registerBgTerminalBackend` caller. |
| REQ-2 | The backend's `name` SHALL be exactly `"zellij"` (from `ZELLIJ_BACKEND_NAME` in `zellij-terminal/lib/constants.ts`). It SHALL register with `preference: ZELLIJ_BACKEND_PREFERENCE` where the constant value is `0` (same as tmux default; cmux's `10` still wins the automatic selector). The user selects zellij explicitly via `--backend zellij` (P5E1). | `testBackendNameIsZellij`, `testPreferenceIsZero` | MUST | `preference: 0` means zellij never auto-wins over cmux — the user must ask for it. This is the conservative default for a third backend. |
| REQ-3 | `isAvailable()` SHALL return true iff `zellij` is on `PATH` AND `zellij list-sessions -s` exits 0 OR exits 1 with "No active zellij sessions found." (both prove the binary works + the socket layer is reachable). ENOENT (binary missing) → false. A thrown probe → false (caught, not propagated — matches the selector's `console.debug` + continue convention). | `testIsAvailableTrueWhenListSessionsExits0`, `testIsAvailableTrueWhenNoSessionsMessage`, `testIsAvailableFalseOnENOENT`, `testIsAvailableFalseOnThrow` | MUST | Exit 1 + "No active zellij sessions found." is zellij's "healthy but empty" state (verified in the spike); must NOT be treated as unavailable. |
| REQ-4 | `launch(config)` SHALL: (a) validate `config.cwd` (absolute, no `..`) and `config.manifestPath` (absolute, no `..`, realpath under `bgStateDir`) BEFORE any zellij call — failure returns `{ status: "failed", error: "invalid ..." }` with NO zellij invocation; (b) create a detached session named `pi-zellij-<runId>` via `zellij attach -b <session-name>` (stdio ignored, no TTY — the spike verified it exits cleanly after ~2s leaving the session alive in ActiveDetached state); (c) poll `zellij list-sessions -s` until the session name appears (timeout `ZELLIJ_LAUNCH_POLL_TIMEOUT_MS = 5000`, 250ms interval); (d) run `zellij -s <session-name> run --name <pane-name> --cwd <config.cwd> --close-on-exit -- node <workerPath> <config.manifestPath>` which returns `terminal_<id>` on stdout; (e) return `{ status: "ok", windowId: <session-name> }`. The pane id is NOT persisted (windowId = session name, per the design decision). | `testLaunchCreatesSessionAndPane`, `testLaunchValidatesCwdBeforeCall`, `testLaunchValidatesManifestPathBeforeCall`, `testLaunchReturnsSessionNameAsWindowId`, `testLaunchPollsUntilSessionAppears`, `testLaunchDoesNotSpawnAttachOnInvalidInput` | MUST | The two-step launch is the load-bearing discovery from the spike. `attach -b` is spawned via the INJECTED `attachSpawner` (production: `child_process.spawn({ detached: true, stdio: "ignore" }).unref()`; tests: a capturing stub) — we do NOT await its exit; we poll `list-sessions` instead (the spike showed it exits ~2s, but polling is more robust than a fixed sleep). `attachSpawner` is NOT called on invalid cwd/manifest (validation short-circuits before any side effect). |
| REQ-5 | `launch`'s `run` argv SHALL contain ONLY `node`, `<workerPath>`, `<config.manifestPath>` after the `--` terminator. No `agentName`, no `runId` (except encoded in the session name), no `cwd` as a positional arg. `agentName` is NOT passed to zellij at all (zellij has no `set-window-option`-equivalent user-option for arbitrary metadata; `--name <pane-name>` uses a derived name, NOT the agentName, to avoid leaking user-controlled text into the pane title). | `testLaunchArgvContainsNoAgentName`, `testLaunchArgvContainsNoRunId`, `testLaunchPaneNameIsNotAgentName` | MUST | Mirrors tmux/cmux security invariants. The pane name is `pi-zellij-pane-<runId.slice(0,8)>` (derived, not user-controlled). |
| REQ-6 | `kill(windowId)` SHALL call `zellij kill-session <windowId>` (the session name). If it exits 1 with stderr matching `/No session named .* found/`, return `{ status: "ok", windowId }` (idempotent — mirroring tmux's `can't find window` tolerance). If the session STILL appears in `list-sessions -s` after `kill-session` reports "not found" (the zombie-state the spike documented), call `zellij delete-session -f <windowId>` as a best-effort fallback, then return ok. All other failures → `{ status: "failed", error }`. | `testKillExistingSession`, `testKillMissingSessionIsOk`, `testKillZombieFallsBackToDeleteSession`, `testKillFailureReturnsFailed` | MUST | The zombie fallback is zellij-specific (tmux doesn't have it); the spike verified `delete-session -f` clears stale saved state. |
| REQ-7 | `isAlive(windowId)` SHALL return true iff `<windowId>` appears as a line in `zellij list-sessions -s` output (exact string match — no substring/`includes`, mirroring the reaper's exact-match rule). Empty `windowId` → false. **Any error (ENOENT, timeout, thrown by `executor.exec`) → the backend SHALL catch and return false** (NOT re-throw). This matches the tmux-backend (`tmux-terminal/lib/tmux-backend.ts` isAlive) and cmux-backend conventions exactly: both `catch { return false }`. The reaper at `agents/index.ts` `buildReaperIsAlive` wraps `backend.isAlive` in its own try/catch that treats a THROWN error as "unknown/alive"; because the backend catches internally and returns false, the reaper sees `false` = DEAD. This is the accepted existing behavior for tmux/cmux (a transient CLI error may cause a stale reap; the reaper's age-only fallback for runs without `ownerHandle` is the conservative backstop). | `testIsAliveTrueWhenSessionListed`, `testIsAliveFalseWhenSessionNotListed`, `testIsAliveFalseOnEmptyWindowId`, `testIsAliveFalseOnError` | MUST | Exact-match is the same contract tmux/cmux backends enforce. The catch-and-return-false (not re-throw) is verified against the live tmux/cmux source. | `testIsAliveTrueWhenSessionListed`, `testIsAliveFalseWhenSessionNotListed`, `testIsAliveFalseOnEmptyWindowId`, `testIsAliveFalseOnError` | MUST | Exact-match is the same contract tmux/cmux backends enforce. |
| REQ-8 | `list()` SHALL parse `zellij list-sessions -s` output (one session name per line), filter lines starting with `ZELLIJ_SESSION_PREFIX` (`pi-zellij-`), and return each as a `TermBgWindowEntry` with `windowId = <session name>`, `runId = <the suffix after the prefix>`, `agentName = undefined` (zellij has no metadata channel; same gap as cmux). Returns `[]` on any error (never throws, never returns undefined). | `testListFiltersPrefixedSessions`, `testListRecoversRunIdFromName`, `testListReturnsEmptyOnNoSessions`, `testListReturnsEmptyOnError` | MUST | `agentName` unrecoverable — same accepted limitation as cmux (P5b-1 REQ-R1(c) documents the gap). |
| REQ-9 | `zellij-terminal/lib/exec.ts` SHALL use `child_process.execFile` (argv-only, NO shell) for all `zellij` invocations EXCEPT `launch`'s step (b) `attach -b`, which uses `child_process.spawn({ detached: true, stdio: "ignore" }).unref()` (fire-and-forget — we do not await its exit, we poll `list-sessions` instead). Every `execFile` call SHALL have a timeout (`ZELLIJ_INVOCATION_TIMEOUT_MS = 10_000` for `run`, `5_000` for `list-sessions`/`kill-session`/`list-panes`). | `static: grep -rnE 'shell:\s*true\|\bexecSync\b\|child_process\.exec\b' zellij-terminal/lib/ \| wc -l` returns `0` (matches only the prohibited shell-spawning APIs: `shell: true`, `execSync`, and `child_process.exec` — NOT the executor's own `.exec(...)` method calls or the `async exec(args, opts)` interface definition) | MUST | The `spawn`+`unref` for `attach -b` is the one exception to the `execFile` rule, justified by the spike finding that `attach -b` is a fire-and-forget session-server starter. The guard is narrowed to the actual prohibited APIs (verified: returns 0 against tmux-terminal/lib/ and cmux-terminal/lib/). |
| REQ-10 | The slice SHALL NOT change `agents/lib/bg-terminal.ts`, `agents/index.ts`, or any file outside `zellij-terminal/` (except the plan doc + the already-committed `zellij-terminal/docs/cli-spike-output.txt`). | Done Criteria: `git diff --stat agents/ \| wc -l` returns `0`; `git diff --stat tmux-terminal/ cmux-terminal/ \| wc -l` returns `0` | MUST | The seam is already correct (P5 + P5E1); this slice only adds a new `registerBgTerminalBackend` caller in a new extension. |
| REQ-11 | `zellij-terminal/lib/{path-validate,redact-error,shell-escape,resolve-worker-path}.ts` SHALL be byte-identical copies of the same-named files in `tmux-terminal/lib/` and `cmux-terminal/lib/` (the established cross-extension copy pattern — they are already byte-identical between tmux and cmux). | `testHelpersByteIdenticalToTmux` (`diff -q` returns 0 for all 4 files) | SHOULD | Establishes the 3-way copy invariant. A future refactor could extract these to a shared lib, but that is out of scope (would touch tmux-terminal + cmux-terminal, violating REQ-10). |
| REQ-12 | `zellij-terminal/README.md` SHALL document: (a) zellij version requirement (≥0.44.3, the version the spike verified — `attach -b`, `run -- --close-on-exit`, `list-sessions -s`, `delete-session -f` are all 0.44.x surfaces); (b) the two-step detached-launch design and why (the `attach -b` + `run` split, with a pointer to `docs/cli-spike-output.txt`); (c) the known `agentName` not-persisted gap (same as cmux); (d) the zombie-session `delete-session -f` fallback; (e) macOS/Linux support note (zellij is cross-platform, unlike cmux — no platform gate in `isAvailable`). | `grep` guards for each of the 5 items in `zellij-terminal/README.md` | SHOULD | Mirrors cmux-terminal REQ-R1 doc discipline. |
| REQ-13 | **`UNGUARDED-IN-CI`.** The end-to-end `/agents bg --backend zellij scout test` flow on a machine with zellij ≥0.44.3 installed SHALL create a `pi-zellij-<runId>` session running `node <workerPath> <manifestPath>`, visible in `zellij list-sessions -s`, and `kill-session` SHALL clean it up. | `test-real-zellij-smoke.mjs:LaunchCreatesSession`, `test-real-zellij-smoke.mjs:StatusListsRun`, `test-real-zellij-smoke.mjs:StopClosesSession` (real zellij required, skipped in CI via `command -v zellij \|\| exit 2`). Manual step: on a dev box with zellij installed, run `node zellij-terminal/test-fixtures/test-real-zellij-smoke.mjs` and capture all 3 tests' stdout. | MUST | UNGUARDED-IN-CI per the template rule (the smoke is the only proof of the real zellij round-trip; unit tests use a fake executor). |

**Priority legend:** MUST = first-slice merge blocker; SHOULD = required before feature complete; MAY = nice-to-have.

## Non-Goals

Out of scope for this feature:

- A `zellij-control` extension (analogous to tmux-control/cmux-control). The spike confirmed zellij's `action send-keys`/`dump-screen`/`list-panes` surface makes one feasible, but it is a separate slice. This plan ships the backend only.
- Pane-level `windowId` (option b from the design discussion). The backend uses the session name as `windowId`; `isAlive` checks session liveness, not pane liveness. The reaper's age-only fallback handles the "session lingers, pane dead" edge.
- Preference override (zellij stays at `0`; cmux's `10` still auto-wins). The user selects zellij explicitly via `--backend zellij`.
- Extracting the shared helpers (`path-validate`/`redact-error`/`shell-escape`/`resolve-worker-path`) into a shared lib. Would touch tmux-terminal + cmux-terminal (violates REQ-10); defer to a future refactor slice.
- Wezterm/headless backends. Same pattern; separate slices.
- Changing `agents/lib/bg-terminal.ts`, `agents/index.ts`, or the `TermBgBackend` interface.
- A `ZELLIJ_SESSION_NAME` env-var targeting mechanism. The spike showed `zellij -s <name> run/action` targets the named session directly; no env var needed.

## Safety / Security

The `zellij-terminal` backend spawns `zellij` subprocesses with user-controlled inputs (`config.cwd`, `config.manifestPath`, `config.runId`, `config.agentName`). The threat surface mirrors tmux/cmux: argv injection, path traversal, and metadata leakage into the worker's spawn boundary.

| Concern | Severity | Mitigation | Test(s) |
|---|---|---|---|
| `config.cwd` or `config.manifestPath` contains `..` / is non-absolute → path traversal | High | Validate `isAbsoluteNoDotDot` for both BEFORE any zellij call; `manifestPath` must also be `isUnderDir(bgStateDir)`. Failure returns `failed` with NO zellij invocation. (Same guards as tmux/cmux — byte-identical helper.) | `testLaunchValidatesCwdBeforeCall` (negative: `../` cwd → failed, no executor call), `testLaunchValidatesManifestPathBeforeCall` (negative: outside `bgStateDir` → failed, no executor call) |
| `agentName` (user-controlled) leaks into the worker's pane title / argv | Medium | Do NOT pass `agentName` to any zellij flag. The `--name` flag uses a derived `pi-zellij-pane-<runId.slice(0,8)>`, NOT `config.agentName`. `agentName` is unrecoverable after launch (accepted gap, same as cmux). | `testLaunchPaneNameIsNotAgentName` (assert `--name` arg ≠ `config.agentName`; assert `--name` arg matches `pi-zellij-pane-` prefix), `testLaunchArgvContainsNoAgentName` |
| `attach -b` spawns a long-lived server process that leaks if `kill` fails | Medium | `kill()` calls `kill-session` then `delete-session -f` (zombie fallback). The reaper's age-only expiry catches any residual. `launch` polls `list-sessions` (timeout 5s) so a failed `attach -b` (session never appears) returns `failed` — no orphan session. | `testLaunchReturnsFailedOnPollTimeout` (fake `list-sessions` never shows the name → `failed`), `testKillZombieFallsBackToDeleteSession` |
| `run -- <cmd> <args>` argv injection via manifestPath | Low | `manifestPath` is validated absolute + under `bgStateDir` before the `run` call; it appears AFTER the `--` terminator (zellij treats it as a positional, not a flag). `node` is the literal binary. | `testLaunchArgvHasDoubleDashTerminator` (assert `--` present before `node <worker> <manifest>`), `testLaunchArgvContainsNoAgentName` |

## Design

### Key types

```ts
// zellij-terminal/lib/constants.ts (NEW)
export const ZELLIJ_BACKEND_NAME = "zellij";
export const ZELLIJ_SESSION_PREFIX = "pi-zellij-";
export const ZELLIJ_BACKEND_PREFERENCE = 0;
export const ZELLIJ_INVOCATION_TIMEOUT_MS = 10_000;   // for `run`
export const ZELLIJ_LIST_TIMEOUT_MS = 5_000;          // for `list-sessions`/`kill-session`/`list-panes`
export const ZELLIJ_LAUNCH_POLL_TIMEOUT_MS = 5_000;   // poll for session appearance after `attach -b`
export const ZELLIJ_LAUNCH_POLL_INTERVAL_MS = 250;
export const ZELLIJ_AVAILABLE_PROBE_TIMEOUT_MS = 1_000;
export const WORKER_BASENAMES = ["bg-worker.ts", "bg-worker.mjs", "bg-worker.js"] as const;
export const REDACTED_WORKER = "<worker>";
export const REDACTED_MANIFEST = "<manifest>";
export const MAX_ERROR_STDERR_LEN = 512;
```

```ts
// zellij-terminal/lib/exec.ts (NEW — mirrors tmux-terminal/lib/exec.ts with "zellij" binary)
export interface ZellijExecutor {
	exec(args: string[], opts: { timeoutMs: number }): Promise<ZellijExecResult>;
}
export type ZellijExecResult =
	| { ok: true; stdout: string; stderr: string; exitCode: 0 }
	| { ok: false; stdout: string; stderr: string; exitCode: number };
export function defaultZellijExecutor(): ZellijExecutor;
// + a spawnAttachSession(name: string): void  (production: child_process.spawn detached+stdio:ignore+unref; INJECTED into the backend via CreateZellijBackendOpts.attachSpawner so unit tests stub it)
```

```ts
// zellij-terminal/lib/zellij-backend.ts (NEW)
export interface CreateZellijBackendOpts {
	executor: ZellijExecutor;
	/** Fire-and-forget spawn of `zellij attach -b <name>` (detached, stdio:ignore, unref). INJECTED so unit tests can pass a fake recorder/no-op instead of a real child_process.spawn. Production: defaultZellijExecutor.spawnAttachSession; tests: a capturing stub. */
	attachSpawner: (name: string) => void;
	workerPath: string;
	bgStateDir: string;
	preference?: number;
}
export function createZellijBackend(opts: CreateZellijBackendOpts): TermBgBackend;
```

### Key invariants

- `windowId = session name = ZELLIJ_SESSION_PREFIX + runId` (e.g. `pi-zellij-bg-1234567-abcdef`). Encodes runId for `list()` recovery; pane id is discarded.
- `attach -b` is spawned fire-and-forget (`spawn({ detached: true, stdio: "ignore" }).unref()`) — NEVER awaited. Session appearance is confirmed by polling `list-sessions -s`.
- `zellij -s <session-name> run ...` (note the `-s` flag) targets the named session; without it, zellij refuses when >1 session is active (spike-verified).
- `agentName` is NEVER passed to zellij. The `--name` flag is a derived `pi-zellij-pane-<runId.slice(0,8)>`.
- All `execFile` calls are argv-only (no shell), with timeouts. `attach -b` is the single `spawn` exception.
- `kill-session` exit 1 + `/No session named .* found/` = idempotent ok. Zombie fallback via `delete-session -f`.
- `list-sessions -s` exit 1 + "No active zellij sessions found." = healthy-but-empty (NOT unavailable).

### Resolution / flow

```text
launch(config):
  ├─ validate config.cwd (isAbsoluteNoDotDot) — fail → { failed, "invalid cwd" }
  ├─ validate config.manifestPath (isAbsoluteNoDotDot + isUnderDir(bgStateDir)) — fail → { failed, "invalid manifest path" }
  ├─ sessionName = ZELLIJ_SESSION_PREFIX + config.runId
  ├─ opts.attachSpawner(sessionName)  ← INJECTED: production spawns `zellij attach -b <sessionName>` (detached, stdio:ignore, unref); tests stub it. NOT called on invalid cwd/manifest.
  ├─ poll: every 250ms for up to 5000ms, run `zellij list-sessions -s`; if sessionName appears → break
  │    └─ timeout → { failed, "zellij session did not appear within 5000ms" }
  ├─ runArgv = ["-s", sessionName, "run", "--name", "pi-zellij-pane-"+runId.slice(0,8),
  │             "--cwd", config.cwd, "--close-on-exit", "--", "node", workerPath, config.manifestPath]
  ├─ result = await executor.exec(runArgv, { timeoutMs: 10_000 })
  │    └─ !ok → { failed, redactError(stderr, workerPath, manifestPath) }
  │    └─ stdout not matching /terminal_\d+/ → { failed, "unexpected run output: <stdout>" }
  └─ return { ok, windowId: sessionName }

kill(windowId):
  ├─ result = await executor.exec(["kill-session", windowId], { timeoutMs: 5_000 })
  ├─ if ok → { ok, windowId }
  ├─ if stderr matches /No session named .* found/:
  │    ├─ check list-sessions -s for windowId (zombie?)
  │    │    └─ if still listed → executor.exec(["delete-session", "-f", windowId]) (best-effort, ignore result)
  │    └─ return { ok, windowId }  (idempotent)
  └─ else → { failed, stderr || "kill failed" }

isAlive(windowId):
  ├─ if !windowId → false
  ├─ try { result = await executor.exec(["list-sessions", "-s"], { timeoutMs: 5_000 }) } catch → false
  ├─ if !result.ok → false
  └─ return result.stdout.split("\n").some(line => line === windowId)  (EXACT match)
  (catch-and-return-false on any error — matches tmux/cmux isAlive convention; the reaper's own wrapper handles the "thrown → alive" case at the agents/index.ts layer)

list():
  ├─ result = await executor.exec(["list-sessions", "-s"], { timeoutMs: 5_000 })
  ├─ if !ok → []
  └─ return result.stdout.split("\n")
            .filter(line => line.startsWith(ZELLIJ_SESSION_PREFIX))
            .map(line => ({ windowId: line, runId: line.slice(ZELLIJ_SESSION_PREFIX.length) || undefined, agentName: undefined }))

isAvailable():
  ├─ try { result = await executor.exec(["list-sessions", "-s"], { timeoutMs: 1_000 }) }
  ├─ catch → false
  └─ return result.ok === true || (result.ok === false && result.stderr includes "No active zellij sessions found.")
```

## Existing Hook Points

| File | Function / section | What it does | Impact |
|---|---|---|---|
| `agents/lib/bg-terminal.ts` | `registerBgTerminalBackend`, `selectBgTerminalBackend`, `listBgTerminalBackends` | the registry + selector | UNCHANGED (REQ-10). zellij-terminal becomes a third caller of `registerBgTerminalBackend`. |
| `agents/index.ts` | `buildReaperIsAlive` (reaper) | routes `isAlive` by persisted `ownerBackendName` via `getBgTerminalBackendByName` | UNCHANGED. A zellij-launched run persists `ownerBackendName: "zellij"`; the reaper recovers the zellij backend across restarts. |
| `tmux-terminal/lib/{path-validate,redact-error,shell-escape,resolve-worker-path}.ts` | (whole files) | byte-identical helpers | COPY verbatim into `zellij-terminal/lib/` (REQ-11). |
| `tmux-terminal/lib/exec.ts` | `TmuxExecutor` + `defaultTmuxExecutor` | the executor abstraction | COPY + swap `"tmux"` → `"zellij"`, rename types to `ZellijExecutor` (REQ-9). Add `spawnAttachSession` (production default; passed to the backend via `CreateZellijBackendOpts.attachSpawner`). |
| `tmux-terminal/lib/tmux-backend.ts` | `createTmuxBackend` | the backend factory | STRUCTURAL TEMPLATE for `zellij-backend.ts` (different CLI surface, different launch flow). |
| `tmux-terminal/index.ts` | `tmuxTerminalExtension` (default export) | extension entry: `session_start` registration + `bgStateDir` derivation | COPY + swap factory + constants (REQ-1). |
| `zellij-terminal/docs/cli-spike-output.txt` | (whole file) | already committed | The contract this plan's REQs reference. |

## Slice Ladder

Single slice. The backend is ~400 LOC + tests; splitting would create artificial seams (the helpers, exec, backend, and entry are mutually dependent and ship together). Listed for traceability.

| Slice | Objective | Primary files | Key deliverables | Tests | Hard stops |
|---|---|---|---|---|---|
| `P5b-2` | zellij-terminal backend: register on session_start, implement `launch`/`kill`/`isAlive`/`list`/`isAvailable` | `zellij-terminal/{index.ts, lib/{constants,exec,zellij-backend,resolve-worker-path,path-validate,redact-error,shell-escape}.ts, README.md}`, `zellij-terminal/test-fixtures/{test-zellij-backend.mjs, test-extension.mjs, run-zellij-tests.sh, test-real-zellij-smoke.mjs}` | New backend; 4 byte-identical helper copies; argv-only executor + `spawn` for `attach -b`; README. | See Test Case Catalog. | REQ-10 (no `agents/`/`tmux-terminal/`/`cmux-terminal/` changes), REQ-9 (no shell), REQ-13 (real smoke UNGUARDED-IN-CI). |

### Dependency graph

```text
P5b-2 (single slice; no internal sub-slice deps)
   ↑ (depends on P5 + P5b-1 for the TermBgBackend seam + helper pattern)
   ↑ (depends on P5E1 for the --backend selector to test from the CLI)
```

No parallel slices. Wezterm/headless backends (P5b-3+) can start independently after this lands.

## Cut Order

If context or implementation scope grows, cut in this order:

1. REQ-12 (README) — ship the backend without the doc; add README in a fast-follow.
2. REQ-13 (real smoke) — ship with unit tests only; mark the smoke as a follow-up task.
3. REQ-11 (byte-identical helper invariant test) — keep the helpers but drop the `diff -q` test.
4. The zombie-session `delete-session -f` fallback (REQ-6) — keep `kill-session` only; the reaper catches residuals.

Do not cut:

- REQ-1..10 (the backend contract + security invariants) — these ARE the feature.
- REQ-9 (no shell) — security boundary.
- REQ-10 (no `agents/` changes) — the guard that keeps the seam correct.

## Contracts

### `launch(config: TermBgAgentConfig): Promise<TermBgResult>`

**Input contract:** `config = { agentName, runId, manifestPath, cwd }` (from `agents/index.ts` handleBgCommand). All fields non-empty strings; `manifestPath` is absolute under `bgStateDir`; `cwd` is absolute.

**Output contract:** `{ status: "ok", windowId: <session name> }` on success; `{ status: "failed", error: <string> }` on any failure. `windowId` is `pi-zellij-<runId>`.

**State table (exhaustive):**

| State | Condition | Output |
|---|---|---|
| A. Invalid cwd | `!isAbsoluteNoDotDot(config.cwd)` | `{ failed, "invalid cwd" }` — NO zellij call |
| B. Invalid manifestPath | `!isAbsoluteNoDotDot(config.manifestPath)` OR `!isUnderDir(config.manifestPath, bgStateDir)` | `{ failed, "invalid manifest path" }` — NO zellij call |
| C. Session never appears | `attach -b` spawned + polled 5000ms; session name not in `list-sessions -s` | `{ failed, "zellij session did not appear within 5000ms" }` |
| D. `run` fails | `executor.exec` returns `!ok` OR throws | `{ failed, redactError(stderr, workerPath, manifestPath) }` |
| E. `run` output malformed | stdout does not match `/terminal_\d+/` | `{ failed, "unexpected run output: <stdout>" }` |
| F. Success | session appeared + `run` returned `terminal_<id>` | `{ ok, windowId: "pi-zellij-<runId>" }` |

### `kill(windowId: string): Promise<TermBgResult>`

| State | Condition | Output |
|---|---|---|
| A. Session killed | `kill-session <windowId>` exit 0 | `{ ok, windowId }` |
| B. Session already gone | `kill-session` exit 1 + `/No session named .* found/` AND not in `list-sessions` | `{ ok, windowId }` (idempotent) |
| C. Zombie | `kill-session` "not found" BUT still in `list-sessions` | call `delete-session -f <windowId>` (best-effort), then `{ ok, windowId }` |
| D. Other failure | `kill-session` exit 1 with other stderr | `{ failed, stderr \|\| "kill failed" }` |

## Edge Cases

| # | Scenario | Expected behavior | Test |
|---|---|---|---|
| EC1 | `launch` with `config.cwd = "/tmp/../etc"` | State A → `{ failed, "invalid cwd" }`, NO executor call | `testLaunchValidatesCwdBeforeCall` |
| EC2 | `launch` with `manifestPath` outside `bgStateDir` | State B → `{ failed, "invalid manifest path" }`, NO executor call | `testLaunchValidatesManifestPathBeforeCall` |
| EC3 | `attach -b` spawned but session never appears (poll timeout) | State C → `{ failed, "zellij session did not appear within 5000ms" }` | `testLaunchReturnsFailedOnPollTimeout` |
| EC4 | `run` returns `terminal_1` on stdout | State F → `{ ok, windowId: "pi-zellij-<runId>" }` | `testLaunchCreatesSessionAndPane` |
| EC5 | `run` returns empty/garbage stdout | State E → `{ failed, "unexpected run output: ..." }` | `testLaunchRejectsMalformedRunOutput` |
| EC6 | `kill` on a session that doesn't exist | State B → `{ ok, windowId }` (idempotent) | `testKillMissingSessionIsOk` |
| EC7 | `kill` on a zombie (kill-session says not-found but list-sessions shows it) | State C → `delete-session -f` called, then `{ ok }` | `testKillZombieFallsBackToDeleteSession` |
| EC8 | `isAlive` with empty `windowId` | false | `testIsAliveFalseOnEmptyWindowId` |
| EC9 | `list` when no sessions active (`list-sessions -s` exit 1) | `[]` | `testListReturnsEmptyOnNoSessions` |
| EC10 | `isAvailable` when zellij not installed (ENOENT) | false | `testIsAvailableFalseOnENOENT` |
| EC11 | `isAvailable` when zellij installed but zero sessions | true (exit 1 + "No active zellij sessions found." = healthy) | `testIsAvailableTrueWhenNoSessionsMessage` |
| EC12 | Multiple zellij sessions exist; `run` WITHOUT `-s` | N/A — the backend ALWAYS uses `-s <sessionName>`, so this never happens | (covered by `testLaunchUsesSessionFlagOnRun`) |

## Test Case Catalog

Grouped by concern. Every test name here SHALL appear in the Requirements table OR be an Edge-Case-only test.

```text
Group 1: registration (2 tests)
  testRegistersOnSessionStart                          (REQ-1)
  testSkipsRegistrationWhenWorkerMissing               (REQ-1)

Group 2: name + preference (2 tests)
  testBackendNameIsZellij                              (REQ-2)
  testPreferenceIsZero                                 (REQ-2)

Group 3: isAvailable (4 tests)
  testIsAvailableTrueWhenListSessionsExits0            (REQ-3, EC — normal)
  testIsAvailableTrueWhenNoSessionsMessage             (REQ-3, EC11)
  testIsAvailableFalseOnENOENT                         (REQ-3, EC10)
  testIsAvailableFalseOnThrow                          (REQ-3)

Group 4: launch (7 tests)
  testLaunchCreatesSessionAndPane                  (REQ-4, EC4)
  testLaunchValidatesCwdBeforeCall                     (REQ-4, REQ-5, EC1)
  testLaunchValidatesManifestPathBeforeCall            (REQ-4, REQ-5, EC2)
  testLaunchReturnsSessionNameAsWindowId               (REQ-4)
  testLaunchPollsUntilSessionAppears                   (REQ-4)
  testLaunchReturnsFailedOnPollTimeout                 (REQ-4, EC3)
  testLaunchRejectsMalformedRunOutput                  (REQ-4, EC5)

Group 5: launch security (5 tests)
  testLaunchArgvContainsNoAgentName                    (REQ-5)
  testLaunchArgvContainsNoRunId                        (REQ-5)
  testLaunchPaneNameIsNotAgentName                     (REQ-5)
  testLaunchUsesSessionFlagOnRun                       (REQ-4, EC12)
  testLaunchArgvHasDoubleDashTerminator                (Safety)

Group 6: kill (4 tests)
  testKillExistingSession                              (REQ-6)
  testKillMissingSessionIsOk                           (REQ-6, EC6)
  testKillZombieFallsBackToDeleteSession               (REQ-6, EC7)
  testKillFailureReturnsFailed                         (REQ-6)

Group 7: isAlive (4 tests)
  testIsAliveTrueWhenSessionListed                     (REQ-7)
  testIsAliveFalseWhenSessionNotListed                 (REQ-7)
  testIsAliveFalseOnEmptyWindowId                      (REQ-7, EC8)
  testIsAliveFalseOnError                              (REQ-7)

Group 8: list (4 tests)
  testListFiltersPrefixedSessions                      (REQ-8)
  testListRecoversRunIdFromName                        (REQ-8)
  testListReturnsEmptyOnNoSessions                     (REQ-8, EC9)
  testListReturnsEmptyOnError                          (REQ-8)

Group 9: helpers (1 test)
  testHelpersByteIdenticalToTmux                       (REQ-11)

Group 10: real-zellij smoke (UNGUARDED-IN-CI) (3 tests)
  test-real-zellij-smoke.mjs:LaunchCreatesSession      (REQ-13)
  test-real-zellij-smoke.mjs:StatusListsRun            (REQ-13)
  test-real-zellij-smoke.mjs:StopClosesSession         (REQ-13)
```

Total: 36 tests (33 unit + 3 UNGUARDED-IN-CI smoke). Unit tests use a fake `ZellijExecutor` + a fake `attachSpawner` (captures the session name, no real subprocess) + canned `ZellijExecResult` (same pattern as tmux/cmux `test-tmux-backend.mjs`).

## Risk Analysis

| Risk | Severity | Mitigation |
|---|---|---|
| `attach -b` behavior changes in a future zellij version (the fire-and-forget + poll is pinned to 0.44.3) | Medium | README REQ-12(a) pins the version. The smoke REQ-13 is the canary — a zellij upgrade that breaks `attach -b` fails the smoke on the dev box before any user hits it. |
| `attach -b` spawns a process that leaks if `launch` fails after step (b) but before `kill` | Medium | `launch` polls for session appearance (5s timeout); if it times out (State C), the session-creation may have partially succeeded. The reaper's age-only fallback + `kill-session` on the reservation handles it. A `launch` failure cleanup path (call `kill-session` on the session name if `run` fails) is included in the implementation. |
| Pane-level liveness is NOT checked (session-level only) — a dead worker pane in a live session reads as "alive" | Low | Accepted design tradeoff (option a). The reaper's age-only fallback catches truly-dead sessions. Pane-level precision is a future-control-slice concern. |
| `list-sessions -s` output format changes across zellij versions | Low | `-s`/`--short` is a stable documented flag. The smoke catches format drift. |
| Helper drift (the 4 byte-identical copies diverge from tmux/cmux) | Low | REQ-11 `diff -q` test guards the invariant. A future refactor extracts them to a shared lib. |
| `--name` flag value collides with another pane in the same session | Low | The pane name is `pi-zellij-pane-<runId.slice(0,8)>` — runId is unique per launch; collision requires a runId-prefix collision, which is cryptographically improbable (8 hex chars). |

## Open Decisions

- **Pane-level windowId (option b)**: explicitly rejected for this slice (Non-Goals). If pane-level precision becomes important for a future `zellij-control`, a follow-up slice can switch `windowId` to a composite `<session>/<pane-id>` and update the reaper's exact-match semantics.
- **Preference value**: `0` (same as tmux). Could be `-1` (lower than tmux) or `5` (between tmux and cmux). `0` is the conservative default — zellij is available as an explicit `--backend zellij` choice, never auto-selected over cmux. Revisit if users report wanting zellij as the automatic default.
- **Shared-helper extraction**: deferred (would touch tmux-terminal + cmux-terminal, violating REQ-10).
- **`zellij-control` extension**: deferred to a separate slice. The spike confirmed `action send-keys`/`dump-screen` make it feasible.

## Done Criteria

All MUST requirements passing = done. Concretely:

- [ ] `bash zellij-terminal/test-fixtures/run-zellij-tests.sh` prints all 33 unit tests passing (fake executor + fake attachSpawner).
- [ ] `git diff --stat agents/ tmux-terminal/ cmux-terminal/ | wc -l` returns `0` (REQ-10).
- [ ] `grep -rnE 'shell:\s*true\|\bexecSync\b\|child_process\.exec\b' zellij-terminal/lib/ | wc -l` returns `0` (REQ-9 — matches only prohibited shell APIs, not the executor's `.exec()` method calls; the one `child_process.spawn` for `attach -b` is permitted).
- [ ] Manual smoke (UNGUARDED-IN-CI): on a dev box with zellij ≥0.44.3, `node zellij-terminal/test-fixtures/test-real-zellij-smoke.mjs` prints 3 ✓; `/agents bg --backend zellij scout test` creates a `pi-zellij-*` session visible in `zellij list-sessions -s`.

## Review Consensus

| Pass | Reviewer | Model | Blocker count | Verdict |
|---|---|---|---|---|
| 1 | codex (via cmux) | gpt-5.5 high | 3 | changes-requested — see "Resolved blockers (R1 → R2)" below |
| 2 | codex (via cmux) | gpt-5.5 high | 2 | changes-requested — R1 6/8 resolved; 2 carry-overs re-fixed (R1-B2 grep guard, R1-N2 isAlive error semantics) + 2 nits — see "Resolved blockers (R2 → R3)" below |
| 3 | codex (via cmux) | gpt-5.5 high | 0 | approve-with-nits — R2 4/4 resolved; 0 blockers; verified the grep guard returns 0 against tmux/cmux + negative control, REQ-7 catch+return-false matches live tmux/cmux isAlive, flow uses opts.attachSpawner |

### Resolved blockers (R1 → R2 revisions)

| # | R1 blocker/nit | Resolution in this revision |
|---|---|---|
| R1-B1 (HIGH) | `spawnAttachSession()` is a real subprocess side effect but the backend factory only injects `executor`; unit tests would call real `child_process.spawn`. | Added `attachSpawner: (name: string) => void` to `CreateZellijBackendOpts` (INJECTED). Production passes `defaultZellijExecutor.spawnAttachSession` from `index.ts`; unit tests pass a fake recorder/no-op. Updated REQ-4, the `CreateZellijBackendOpts` type, the exec.ts step (1.6), the backend step (1.7), the index step (1.8), the test step (1.9). Added `testLaunchDoesNotSpawnAttachOnInvalidInput` to assert the spawner is NOT called on invalid cwd/manifest. |
| R1-B2 (MED) | The static grep guard ` exec(` matches the executor's own `async exec(args, opts)` method definition AND the `executor.exec(...)` call sites (verified: returns 8 against tmux-terminal/lib/, 15 against cmux-terminal/lib/). | Rewrote the guard to `grep -rnE 'shell:\s*true\|\bexecSync\b\|child_process\.exec\b'` — matches ONLY the prohibited shell-spawning APIs (`shell: true`, `execSync`, `child_process.exec`), not the executor's `.exec()` method calls or the `async exec(args, opts)` interface definition. Verified returns 0 against tmux/cmux lib. Updated REQ-9, Done Criteria, Definition-of-done. (R2 had to re-fix this after the first attempt's `grep -v 'async exec('` still matched call sites.) |
| R1-B3 (MED) | Group 5 labeled "3 tests" but lists 5 names; totals said 31 unit but the catalog lists 33. | Corrected Group 5 header to "5 tests". Recounted: 33 unit + 3 smoke = 36 total. Updated the Total line, Done Criteria, Appendix file list (7.), implementation sequence step 5, Appendix B step 1.9, and Definition-of-done. |
| R1-N1 (nit) | REQ-1 claimed "idempotent across reloads" + "selector de-duplicates by probing" — false (registry is append-only, no dedup). | REQ-1 rewritten: reload re-appends a duplicate; the selector probes each in preference order and the first available wins (a duplicate is harmless but not deduplicated). Matches tmux/cmux behavior. |
| R1-N2 (nit) | REQ-7 said the backend returns false on error + "lets the caller decide" — ambiguous about re-throw vs return-false, and the flow/test were inconsistent. | REQ-7 rewritten: the backend SHALL catch errors and return false (NOT re-throw) — this matches the verified tmux-backend and cmux-backend `isAlive` convention (both `catch { return false }`). The reaper's own wrapper at `agents/index.ts` `buildReaperIsAlive` handles the thrown → alive case at its layer. Updated REQ-7, the isAlive flow pseudocode, and confirmed `testIsAliveFalseOnError` is consistent. (R1's first fix attempt wrongly claimed a re-throw convention; R2 caught that tmux/cmux both return false — corrected.) |
| R1-N3 (nit) | Step 1.8 referenced `TMUX_BACKEND_NAME` in tmux's index (not imported there); zellij index should explicitly import `ZELLIJ_BACKEND_PREFERENCE`. | Step 1.8 rewritten: explicit `import { ZELLIJ_BACKEND_PREFERENCE } from "./lib/constants.ts"` + `import { spawnAttachSession } from "./lib/exec.ts"`, pass both in the `createZellijBackend` opts. Dropped the stale `TMUX_BACKEND_NAME` reference. |
| R1-N4 (nit) | Typo `testLaunchCreatesSessionAndRunspane`. | Renamed to `testLaunchCreatesSessionAndPane` (fixed in REQ-4, EC4, Test Catalog Group 4). |
| R1-N5 (nit) | Existing-hook line refs at :172-177 are stale against current files. | The hook-point table describes conceptually-correct locations (the `registerBgTerminalBackend`/`selectBgTerminalBackend`/reaper callsite); exact line numbers drift with each merge, so the table now references the function/section names rather than brittle line numbers. |

### Resolved blockers (R2 → R3 revisions)

| # | R2 blocker/nit | Resolution in this revision |
|---|---|---|
| R2-B1 (MED, was R1-B2) | The narrowed grep guard `grep -v 'async exec('` still matched `executor.exec(...)` CALL SITES (returns 8 against tmux, 15 against cmux). | Rewrote the guard to `grep -rnE 'shell:\s*true\|\bexecSync\b\|child_process\.exec\b'` — matches ONLY the prohibited shell-spawning APIs (`shell: true`, `execSync`, `child_process.exec`), not the executor's `.exec()` method calls or the `async exec(args, opts)` interface definition. Verified returns 0 against tmux-terminal/lib/ and cmux-terminal/lib/. Updated REQ-9, Done Criteria, Definition-of-done. |
| R2-B2 (MED, was R1-N2) | REQ-7 said "re-throw" but the flow still said `if !ok → false`, the catalog still had `testIsAliveFalseOnError`, AND the live tmux/cmux source both `catch { return false }` (not re-throw). | REQ-7 rewritten: the backend SHALL catch errors and return false (NOT re-throw) — matches the verified tmux-backend + cmux-backend convention. The reaper's own wrapper at `agents/index.ts` `buildReaperIsAlive` handles the thrown → alive case at its layer. Updated the isAlive flow pseudocode to `try { ... } catch → false`. Confirmed `testIsAliveFalseOnError` is consistent. Corrected the false "re-throw convention" claim from R1. |
| R2-N1 (nit) | Launch flow pseudocode at :132 said bare `spawn zellij attach -b`; step 1.7 correctly said `opts.attachSpawner(sessionName)`. | Flow pseudocode updated to `opts.attachSpawner(sessionName)` with a note that production spawns `zellij attach -b` (detached, stdio:ignore, unref) and tests stub it; NOT called on invalid cwd/manifest. |
| R2-N2 (nit) | R1-B1 resolution text at :362 said `defaultZellijExecutor.spawnAttachSession`; step 1.8 correctly imports standalone `spawnAttachSession`. | R1-B1 resolution text left as-is (the `spawnAttachSession` export from `exec.ts` IS the production default; `index.ts` imports and passes it as `attachSpawner`). The naming is consistent: `spawnAttachSession` is the function; `attachSpawner` is the opts field that receives it. |

## Appendix: Implementation Plan

### Files to create

1. `zellij-terminal/lib/constants.ts` — constants (source above).
2. `zellij-terminal/lib/exec.ts` — `ZellijExecutor` + `defaultZellijExecutor` + `spawnAttachSession` (production; INJECTED into the backend via `attachSpawner` so unit tests can stub it — B1 fix).
3. `zellij-terminal/lib/zellij-backend.ts` — `createZellijBackend` factory (the core implementation).
4. `zellij-terminal/lib/{path-validate,redact-error,shell-escape,resolve-worker-path}.ts` — byte-identical copies from `tmux-terminal/lib/`.
5. `zellij-terminal/index.ts` — extension entry (copy of tmux `index.ts` + factory/constants swap).
6. `zellij-terminal/README.md` — docs (REQ-12).
7. `zellij-terminal/test-fixtures/test-zellij-backend.mjs` — 33 unit tests (fake executor + fake attachSpawner).
8. `zellij-terminal/test-fixtures/test-extension.mjs` — registration test.
9. `zellij-terminal/test-fixtures/test-real-zellij-smoke.mjs` — 3 UNGUARDED-IN-CI smoke tests.
10. `zellij-terminal/test-fixtures/run-zellij-tests.sh` — runner.

### Files to modify

| File | Change |
|---|---|
| (none outside `zellij-terminal/`) | REQ-10: no `agents/`, `tmux-terminal/`, or `cmux-terminal/` changes. |

### Implementation sequence

| Step | Action | Validation |
|---|---|---|
| 1 | Copy the 4 byte-identical helpers from `tmux-terminal/lib/`. | `diff -q tmux-terminal/lib/<f> zellij-terminal/lib/<f>` returns 0 for all 4. |
| 2 | Author `constants.ts` + `exec.ts` (copy tmux `exec.ts`, swap binary, add `spawnAttachSession`). | `npx --yes tsx -e "import('./zellij-terminal/lib/exec.ts').then(m=>typeof m.defaultZellijExecutor==='function'&&console.log('OK'))"` prints `OK`. |
| 3 | Author `zellij-backend.ts` (the core). | `npx --yes tsx -e "import('./zellij-terminal/lib/zellij-backend.ts').then(m=>typeof m.createZellijBackend==='function'&&console.log('OK'))"` prints `OK`. |
| 4 | Author `index.ts` (extension entry). | `npx --yes tsx -e "import('./zellij-terminal/index.ts').then(m=>typeof m.default==='function'&&console.log('OK'))"` prints `OK`. |
| 5 | Author the test files (33 unit + 3 smoke) + `run-zellij-tests.sh`. | `bash zellij-terminal/test-fixtures/run-zellij-tests.sh` green (unit tests; smoke skips if `command -v zellij` fails). |
| 6 | Author `README.md` (REQ-12). | `grep` guards for the 5 items. |
| 7 | Run red-then-green controls: (a) break `isAvailable` to always-return-true → `testIsAvailableFalseOnENOENT` fails RED, revert, GREEN; (b) break `launch` to skip the `--` terminator → `testLaunchArgvHasDoubleDashTerminator` fails RED, revert, GREEN; (c) break `kill` to return `failed` on "not found" → `testKillMissingSessionIsOk` fails RED, revert, GREEN. | Each control RED on broken, GREEN after revert. |

### Risks

(Mirrors the Risk Analysis table; see above.)

## Appendix B: Mechanical Execution Spec (for a low-capability executor)

### Executor contract (copy verbatim into the plan)

1. Do the steps **in numeric order**. Do not skip, reorder, or batch.
2. Each step says exactly which file, what to add/change, and how to verify.
3. **Make no design decisions.** If a step is ambiguous or the anchor text is not found verbatim, **STOP and ask**.
4. Run the verify command after each step; do not proceed until green.
5. Slice test command: `bash zellij-terminal/test-fixtures/run-zellij-tests.sh`.
6. **Edit exactly ONE file per step.** Read-only references (look but never edit): `agents/lib/bg-terminal.ts`, `tmux-terminal/lib/*.ts`, `cmux-terminal/lib/*.ts`.
7. **Surgical edits only.** Three action kinds: **CREATE** (whole-file write), **COPY** (verbatim byte-copy from `tmux-terminal/lib/<same-name>.ts`), **EDIT** (anchored, only if a copied file needs a swap).
8. One slice = one commit, message `P5b-2: zellij-terminal backend`, with the required `Co-Authored-By` trailer.
9. **No aspirational output.** Every check line backed by a real assertion.

**Executor-ready gate:** every step names exactly one file; COPY steps name the source verbatim; CREATE steps give full contents (or a verbatim reference to a source block in this plan); no step text contains "decide", "choose", "figure out", "as appropriate", "if needed", "etc.", "e.g.", or "assert that/verify that/check that/ensure".

### Shared constants / types

See the "Key types" block in the Design section above — all constants and type signatures appear verbatim there. The `zellij-backend.ts` factory body follows the "Resolution / flow" pseudocode verbatim, with these exact error strings:

```ts
const ERR_INVALID_CWD = "invalid cwd";
const ERR_INVALID_MANIFEST = "invalid manifest path";
const ERR_SESSION_TIMEOUT = "zellij session did not appear within 5000ms";
const ERR_UNEXPECTED_RUN_OUTPUT = (stdout: string) => `unexpected run output: ${stdout}`;
const ERR_KILL_FAILED = "kill failed";
```

### `P5b-2` — zellij-terminal backend (REQ-1..13)

| Step | File | Exact action (CREATE / COPY / EDIT) | Verify |
|---|---|---|---|
| 1.1 | `zellij-terminal/lib/path-validate.ts` | **COPY** verbatim from `tmux-terminal/lib/path-validate.ts`. | `diff -q tmux-terminal/lib/path-validate.ts zellij-terminal/lib/path-validate.ts` exits 0. |
| 1.2 | `zellij-terminal/lib/redact-error.ts` | **COPY** verbatim from `tmux-terminal/lib/redact-error.ts`. | `diff -q` exits 0. |
| 1.3 | `zellij-terminal/lib/shell-escape.ts` | **COPY** verbatim from `tmux-terminal/lib/shell-escape.ts`. | `diff -q` exits 0. |
| 1.4 | `zellij-terminal/lib/resolve-worker-path.ts` | **COPY** verbatim from `tmux-terminal/lib/resolve-worker-path.ts`. | `diff -q` exits 0. |
| 1.5 | `zellij-terminal/lib/constants.ts` | **CREATE** (Write). Full contents: the `constants.ts` source block from "Key types" above. | `grep -n 'ZELLIJ_BACKEND_NAME = "zellij"' zellij-terminal/lib/constants.ts` matches once. |
| 1.6 | `zellij-terminal/lib/exec.ts` | **CREATE** (Write). Copy `tmux-terminal/lib/exec.ts` verbatim, then: swap `"tmux"` → `"zellij"` in the `execFileP` call and the ENOENT message; rename `TmuxExecutor`→`ZellijExecutor`, `TmuxExecResult`→`ZellijExecResult`, `defaultTmuxExecutor`→`defaultZellijExecutor`; add `spawnAttachSession(name: string): void` that calls `child_process.spawn("zellij", ["attach", "-b", name], { detached: true, stdio: "ignore" }).unref()` (import `spawn` from `node:child_process`). | `grep -n 'spawnAttachSession\|defaultZellijExecutor' zellij-terminal/lib/exec.ts` matches each once; `grep -c 'tmux' zellij-terminal/lib/exec.ts` returns 0 (case-sensitive, no leftover "tmux"). |
| 1.7 | `zellij-terminal/lib/zellij-backend.ts` | **CREATE** (Write). Full body follows the "Resolution / flow" pseudocode + the Shared error-string constants. Import `ZELLIJ_SESSION_PREFIX, ZELLIJ_BACKEND_NAME, ZELLIJ_BACKEND_PREFERENCE, ZELLIJ_INVOCATION_TIMEOUT_MS, ZELLIJ_LIST_TIMEOUT_MS, ZELLIJ_LAUNCH_POLL_TIMEOUT_MS, ZELLIJ_LAUNCH_POLL_INTERVAL_MS, ZELLIJ_AVAILABLE_PROBE_TIMEOUT_MS, REDACTED_WORKER, REDACTED_MANIFEST` from `./constants.ts`; `shellEscape` from `./shell-escape.ts`; `redactError` from `./redact-error.ts`; `isAbsoluteNoDotDot, isUnderDir` from `./path-validate.ts`; `ZellijExecutor` type from `./exec.ts`; `TermBgBackend, TermBgAgentConfig, TermBgResult, TermBgWindowEntry` from `../../agents/lib/bg-terminal.ts`. The `launch` flow: validate cwd+manifest → `opts.attachSpawner(sessionName)` (INJECTED — production spawns `zellij attach -b`, tests stub it; NOT called on invalid input) → poll `list-sessions -s` for `sessionName` (250ms interval, 5000ms timeout, `executor.exec` with `ZELLIJ_LIST_TIMEOUT_MS`) → `executor.exec(["-s", sessionName, "run", "--name", "pi-zellij-pane-"+config.runId.slice(0,8), "--cwd", config.cwd, "--close-on-exit", "--", "node", workerPath, config.manifestPath], { timeoutMs: ZELLIJ_INVOCATION_TIMEOUT_MS })` → parse stdout `/terminal_\d+/` → return `{ ok, windowId: sessionName }`. On `run` failure, best-effort `kill-session` cleanup via `executor.exec`. | `npx --yes tsx -e "import('./zellij-terminal/lib/zellij-backend.ts').then(m=>typeof m.createZellijBackend==='function'&&console.log('OK'))"` prints `OK`. |
| 1.8 | `zellij-terminal/index.ts` | **CREATE** (Write). Copy `tmux-terminal/index.ts` verbatim, then: swap `createTmuxBackend`→`createZellijBackend`, `defaultTmuxExecutor`→`defaultZellijExecutor`, add `import { spawnAttachSession } from "./lib/exec.ts"` and pass `attachSpawner: spawnAttachSession` in the `createZellijBackend` opts, `import { ZELLIJ_BACKEND_PREFERENCE } from "./lib/constants.ts"` and pass `preference: ZELLIJ_BACKEND_PREFERENCE`, the `bgStateDir` derivation stays identical. Comment header: "P5b-2: zellij-terminal extension entry. Mirrors tmux-terminal/index.ts 1:1." | `grep -n 'createZellijBackend\|ZELLIJ_BACKEND_PREFERENCE\|attachSpawner: spawnAttachSession' zellij-terminal/index.ts` matches each once; `grep -c 'tmux' zellij-terminal/index.ts` returns 0. |
| 1.9 | `zellij-terminal/test-fixtures/test-zellij-backend.mjs` | **CREATE** (Write). 33 unit tests using a fake `ZellijExecutor` (captures argv, returns canned `ZellijExecResult`) AND a fake `attachSpawner` (captures the session name, no real subprocess — the B1 seam). Each test asserts on captured argv / captured attach-name / returned `TermBgResult` against concrete expected values. Negative controls: `testLaunchValidatesCwdBeforeCall` asserts the executor AND attachSpawner were NEVER called (capture counts 0). `testLaunchDoesNotSpawnAttachOnInvalidInput` asserts the same for invalid manifest. `testLaunchReturnsFailedOnPollTimeout` makes the fake `list-sessions` never return the session name. See Test Case Catalog for all 33 names + their REQ/EC mappings. | `npx --yes tsx zellij-terminal/test-fixtures/test-zellij-backend.mjs` exits 0 with 33 `✓` lines. |
| 1.10 | `zellij-terminal/test-fixtures/test-extension.mjs` | **CREATE** (Write). Mirrors `tmux-terminal/test-fixtures/test-extension.mjs`: loads `../index.ts`, asserts `registerBgTerminalBackend` was called with a backend whose `name === "zellij"`, tests the worker-missing skip path. | `npx --yes tsx zellij-terminal/test-fixtures/test-extension.mjs` exits 0. |
| 1.11 | `zellij-terminal/test-fixtures/test-real-zellij-smoke.mjs` | **CREATE** (Write). 3 UNGUARDED-IN-CI tests: `LaunchCreatesSession` (calls `createZellijBackend` with the default executor + a real worker, `launch`, asserts session in `zellij list-sessions -s`), `StatusListsRun` (the session appears in `list()`), `StopClosesSession` (`kill`, session gone). Skips with `exit 2` if `command -v zellij` fails. | `command -v zellij >/dev/null && node zellij-terminal/test-fixtures/test-real-zellij-smoke.mjs` prints 3 `✓` (or skips if zellij absent). |
| 1.12 | `zellij-terminal/test-fixtures/run-zellij-tests.sh` | **CREATE** (Write). `#!/usr/bin/env bash` + `set -euo pipefail` + `cd "$(dirname "$0")/../.."` + `npx --yes tsx zellij-terminal/test-fixtures/test-zellij-backend.mjs` + `npx --yes tsx zellij-terminal/test-fixtures/test-extension.mjs` + `if command -v zellij >/dev/null; then node zellij-terminal/test-fixtures/test-real-zellij-smoke.mjs; else echo "zellij not installed, skipping smoke"; fi`. `chmod +x`. | `bash zellij-terminal/test-fixtures/run-zellij-tests.sh` exits 0 (smoke runs if zellij present, skips otherwise). |
| 1.13 | `zellij-terminal/README.md` | **CREATE** (Write). Document the 5 REQ-12 items: (a) zellij ≥0.44.3 requirement; (b) two-step detached-launch design + pointer to `docs/cli-spike-output.txt`; (c) `agentName` not-persisted gap; (d) zombie `delete-session -f` fallback; (e) cross-platform (no platform gate). | `grep` for each of the 5 items returns a match. |
| 1.14 | (whole slice) | Red-then-green controls (run inline; nothing committed in between). (a) Break `isAvailable` to `return true` unconditionally → `testIsAvailableFalseOnENOENT` fails RED; revert; GREEN. (b) Break `launch` to omit the `--` terminator in the `run` argv → `testLaunchArgvHasDoubleDashTerminator` fails RED; revert; GREEN. (c) Break `kill` to return `{ failed }` on the "not found" path → `testKillMissingSessionIsOk` fails RED; revert; GREEN. | After all controls reverted: `bash zellij-terminal/test-fixtures/run-zellij-tests.sh` exits 0 AND `git diff --stat agents/ tmux-terminal/ cmux-terminal/ | wc -l` returns `0`. |

### Definition of done (whole plan)

`bash zellij-terminal/test-fixtures/run-zellij-tests.sh` prints all 33 unit tests passing (fake executor + fake attachSpawner) + the smoke runs (3 ✓ if zellij present, skip otherwise), `git diff --stat agents/ tmux-terminal/ cmux-terminal/ | wc -l` returns `0`, `grep -rnE 'shell:\s*true\|\bexecSync\b\|child_process\.exec\b' zellij-terminal/lib/ | wc -l` returns `0` (only `child_process.spawn` for `attach -b` permitted), and the README `grep` guards pass.
