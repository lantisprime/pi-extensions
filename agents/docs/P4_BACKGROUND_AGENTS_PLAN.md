# P4: Background/Tmux Agent Execution Plan

**Status**: Planning (v3.1) — re-grounded to shipped P4R API after plan-review CHANGES-REQUESTED (20260624-054530). B1/B2/B3 fixed, B4/B5/B6 addressed.
**Date**: 2026-06-18 (revised 2026-06-24)
**Reviews**:
- Planner `openai-codex/gpt-5.5` (thinking: high) — conditional-go, architecture gaps fixed
- Adversarial `openrouter/anthropic/claude-opus-4-8` — conditional-go, 5 blockers all resolved
- Plan-review `glm-5.2` (20260624-054530) — CHANGES-REQUESTED, B1/B2/B3 re-grounded to shipped bg-state.ts API
**Split**: Tmux backend interface is [P5_PLUGGABLE_TERMINAL_BACKEND.md](./P5_PLUGGABLE_TERMINAL_BACKEND.md)
**Depends on**: P3 agent scaffold (complete), P4R remediation (complete)

> ⚠️ **Partially superseded re: authority roots.** A critical review found this
> plan's "manifest is identity, not authority" claim to be **false** as written —
> the manifest carries `cwd`/`homeDir`, which are authority roots (the registry
> and MAC key are located via `homeDir`), making the MAC circular. The corrected
> design (trusted-runtime roots via `os.userInfo().homedir`, no-kill reaper,
> user-agents-first scope) lives in
> [**P4_REMEDIATION_PLAN.md**](./P4_REMEDIATION_PLAN.md) (status: GO). Build P4-2/P4-3
> against the remediation plan, not the security claims below. This plan is
> formally corrected in remediation slice P4R-6.

## Objective

Extend P3 agents to support non-blocking background agent execution in tmux
windows (or other pluggable terminal backends). The main Pi terminal stays
responsive while child agents run in separate terminal windows. All P3
security invariants must be preserved.

## Design

### Manifest identity — verified, not trusted

> ⚠️ **Corrected by [P4_REMEDIATION_PLAN.md](./P4_REMEDIATION_PLAN.md).** This
> section is wrong: the manifest below carries `options.cwd`/`homeDir`, and the
> worker locates the registry and MAC key via `homeDir` — so a manifest-supplied
> `homeDir` makes the MAC circular (the verifying key sits in the attacker-pointed
> store). The remediation rebinds all roots to `os.userInfo().homedir` and treats
> manifest `homeDir` as identity verified against trusted runtime (reject on
> mismatch). Read the remediation plan for the authoritative design.

The manifest carries identity — agent name, canonical path, expected hash —
plus the task text and options (cwd, homeDir, maxDurationSec). **homeDir is
identity verified against `resolveTrustedHome()` (`os.userInfo().homedir`)
and rejected on mismatch.** All authority roots (bg dir, registry, MAC key,
results, events) are sourced from `resolveTrustedHome()`, never from `$HOME`,
`os.homedir()`, or a manifest field. A separate worker process re-derives
authority decisions from disk and trusted runtime sources, identical to the
sync P3 path. **First cut: user-registered agents only.**

```json
// ~/.pi/agent/bg/<runId>/manifest.json (0600, signed with per-session MAC)
// Schema MUST match shipped BgRunManifest (bg-state.ts) and readBgManifest exact-schema.
// Built by signBgManifest(Omit<BgRunManifest,"mac">, key) then mac+keyGenId attached.
{
  "version": 1,
  "runId": "bg-<timestamp>-<8hex>",
  "identity": {
    "agentName": "scout",
    "canonicalPath": "/Users/x/.pi/agent/agents/scout.md",
    "expectedHash": "<64-char lowercase sha256 hex>"
  },
  "task": "<task text>",
  "options": {
    "maxDurationSec": 120,   // optional advisory child timeout; <= BG_MAX_DURATION_SEC
    "cwd": "/Users/x/projects/my-app",
    "homeDir": "/Users/x"     // identity — verified against resolveTrustedHome(), NOT trusted
  },
  "mac": "<64-char hex hmac-sha256 over mac-excluded view>",
  "keyGenId": "<8-char hex from keyGenIdFromKey(key)>"
}
```

**Manifest construction (P4-2 preflight):** call `signBgManifest(Omit<BgRunManifest,"mac">, key)` (bg-state.ts) to get `mac`, then attach `mac` and `keyGenId = keyGenIdFromKey(key)` (bg-state.ts). Do NOT add option keys beyond `{maxDurationSec?, cwd, homeDir}` — `readBgManifest` rejects unknown keys via `ALLOWED_OPTIONS_KEYS`.

**Field disambiguation (B6):** `options.maxDurationSec` (advisory child-process timeout, optional) is DISTINCT from the reservation's `effectiveTimeoutSec` (slot-accounting, written into `.reserved`). The worker does NOT source one from the other.

Safety: `explicitToolContextLoaderPath`, `disableResourceDiscovery`, and
`spec.tools` are **never** in the manifest. Worker re-derives all three
from trusted sources (env, hard-pinned, file re-read).

### Per-spawn gate (not per-chain preflight)

The worker re-runs the full P3 gate **before each individual agent spawn** —
including each chain step. This closes TOCTOU windows:

1. Worker reads identity from manifest (name, path, expected hash)
2. `verifyBgManifest(manifest, readSessionMacKey(resolveTrustedHome()))` — rejects on tamper
3. `assertManifestIdentityMatchesRuntime(manifest, { homeDir: resolveTrustedHome() })` — rejects on homeDir mismatch (N1; `cwd` is advisory, NOT compared — N6)
4. Re-reads current file bytes from `canonicalPath`
5. Computes `rawBytesSha256`
6. Re-reads **user registry** from disk (user-agents-first; project trust is DEFERRED — see B3)
7. Calls `canRunAgent` with current hash, registry (no project-trust re-read in this cut)
8. If denied → no spawn, writes `failed` to result, writes `done` sentinel
9. If approved → calls `buildChildPiArgs` with live spec, calls `runChildAgent`

### Communication lifecycle — single background agent

Parent and worker never talk directly. The shared state directory
(`~/.pi/agent/bg/<runId>/`) is the only communication channel:

```
Parent Pi session                    Worker (in tmux window)
─────────────────                    ──────────────────────
1. /agents bg scout "find auth bugs"
2. Preflight: canRunAgent, hash,
   trust
3. Write manifest.json:
   {identity, task, options, MAC}
4. termBackend.launch(manifestPath)
5. Track runId in bg tracker         ──→ 6. Read manifest, verify MAC + identity mismatch
                                         7. Re-read spec bytes, user registry from disk
                                            (project trust DEFERRED)
                                         8. runChildAgent(scout, task)
                                            ├─ buildChildPiArgs(spec, task)
                                            │  task → private-temp-file
                                            │  → stdin, never argv
                                            └─ pi child runs, completes
                                         9. formatChildAgentRunResult(result)
                                        10. Write result.json (redacted)
                                        11. Write done sentinel
12. Poll: done sentinel exists? ←────
13. Read result.json from disk
14. Display redacted result to user
    (bg-status shows "completed")
```

**Task transport**: Parent writes task into `manifest.json` → worker reads it
from `manifest.json` → passes to `runChildAgent` → `buildChildPiArgs` writes
to private temp file → child pi receives via stdin. Task text is never in
argv, tmux command, window name, or process list.

**Result transport**: Worker calls `formatChildAgentRunResult` (same redaction
as sync mode) → writes `result.json` atomically (tmp → rename) → creates
`done` sentinel → parent polls for `done` → reads `result.json` from disk.
Raw `events.jsonl` is also written but never surfaced by any `bg-*` command.

**Crash-safe**: If parent Pi session dies, worker keeps running. `result.json`
and `done` remain on disk. Next Pi session → `/agents bg-status` reconstructs
from disk state + tmux windows.

### Communication lifecycle — background chain

Chain runs **inside a single worker process in one tmux window**. Each step
re-runs the full security gate. Handoff is in-memory within the worker.

```
Worker (single tmux window, single process)
───────────────────────────────────────────
1. Read manifest, verify MAC + identity mismatch
2. Re-read spec, user registry from disk (project trust DEFERRED)
3. runChildAgent(scout, task)
   └─→ result_scout
4. Extract summaryText from result_scout.summary
   (capped at 24,000 bytes — same as sync chain)
5. Re-read spec, user registry from disk
6. runChildAgent(planner, summaryText)    ← HANDOFF
   └─→ result_planner
7. Extract summaryText from result_planner.summary
8. Re-read spec, user registry from disk
9. runChildAgent(reviewer, summaryText)   ← HANDOFF
   └─→ result_reviewer
10. Write result.json (redacted chain result)
11. Write done sentinel
```

Parent sees a single result — the final chain output. Intermediate results
are stored in the worker's memory during execution and logged to `events.jsonl`.
If the chain fails mid-way, the worker writes `failed` with the last successful
step's result and the failure reason.

### State directory

```text
~/.pi/agent/bg/<runId>/     (0700)
  manifest.json              (0600) — identity + task, signed with session MAC
  result.json                (0600) — redacted ChildAgentRunResult
  events.jsonl               (0600) — raw JSONL (never surfaced by bg-* commands)
  done                       (sentinel, empty file)

~/.pi/agent/bg/.session.mac  (0600) — per-session HMAC key
```

- `manifest.json`: One-time write by parent, read by worker at start
- `result.json`: Written by worker at completion, read by parent after `done`
- `done`: Atomic sentinel created after `result.json` is fully written
- `events.jsonl`: Raw events for debugging, never shown in bg-status/bg-result

### Commands

```text
/agents bg <agent> <task>             Launch background agent
/agents bg-chain <a>,<b>[,<c>] <task>  Launch background chain
/agents bg-status                     Show running + recent agents
/agents bg-stop <id>                  Kill a background agent
/agents bg-result <id>                Show redacted result
/agents bg-open <id>                  Switch to tmux window
```

### Pluggable terminal backend (P5)

The agents extension defines a `TermBgBackend` interface in
`agents/lib/bg-terminal.ts`. Tmux integration is a separate extension
(`tmux-terminal/`) that implements this interface. See
[P5_PLUGGABLE_TERMINAL_BACKEND.md](./P5_PLUGGABLE_TERMINAL_BACKEND.md).

When `/agents bg` is invoked:

1. Run preflight (writes identity manifest)
2. Call `getBgTerminalBackend()` → if null, "no terminal backend installed"
3. Call `backend.launch({ agentName, runId, manifestPath, cwd })`
4. Track returned `windowId` in bg tracker

The terminal backend handles window naming, shell escaping, and launch
mechanics. Agents never imports tmux directly.

### Concurrency and cleanup

- Max concurrent bg runs: 5. Atomic reservation via `.reserved` file with `flag:"wx"`
- Old runs pruned: keep last 20. Also deletes orphaned `prompt.txt` and `events.jsonl`
- `.session.mac` key created at session start; retired at next session-start when fully idle (N5: `retireSessionMacKeyIfFullyIdle`). session_shutdown is reap-only (frees slots, never deletes the key) — avoids orphaning a live worker's key.
- `prompt.txt` cleaned by `runChildAgent`'s existing `finally` block
- `events.jsonl` pruned when run directory is deleted
- Orphan detection: tmux window check for stale runs

### Edge cases

| Edge case | Behavior |
|---|---|
| Tmux not installed | Clean error from backend, no crash |
| Not inside tmux (`$TMUX` absent) | Backend handles (new-session or fail gracefully) |
| Parent session killed | Worker continues; next Pi session reconstructs from disk + tmux |
| Agent unregistered between preflight and spawn | Worker re-runs `canRunAgent` at spawn → blocked |
| Hash changed between preflight and spawn | Worker recomputes hash at spawn → mismatch → blocked |
| Project trust revoked between preflight and spawn | DEFERRED (project-agent scope, REQ-P*) — not exercised in user-agents-first cut. User registry re-read IS the gate here. |
| Manifest tampered | MAC validation fails → worker rejects, no spawn |
| Manifest tries to set `-e` or `disableResourceDiscovery` | Fields not in manifest, worker uses trusted sources only |
| Result file lost | After timeout, mark as `unknown` |
| Agent times out | `runChildAgent` enforces timeout → worker writes `timed-out` |
| bg-stop | SIGTERM to worker + `tmux kill-window` fallback |
| Chain handoff to dead agent | Mid-chain failure stops subsequent spawns |
| `runId` collision | `O_EXCL`/`wx` → EEXIST → regenerate |
| Symlinked run dir | Refused (`lstat` check) |

## Security invariants (all preserved)

| Invariant | How it's preserved |
|---|---|
| canRunAgent before spawn | Worker re-runs gate at each spawn from disk |
| Current spec bytes re-read | Worker reads `canonicalPath`, recomputes hash |
| Hash mismatch fails closed | Worker compares against registry, blocks on mismatch |
| Project trust required | DEFERRED (project-agent scope). User-agents-first cut gates on user registry + canonical-path hash only. |
| Task in stdin, not argv | `promptTransport: "private-temp-file"` via `buildChildPiArgs` |
| `--no-approve` by default | Worker hard-pins `disableResourceDiscovery: true` |
| Forbidden tools blocked | Worker re-reads spec, `buildChildPiArgs` normalizes tools |
| No `-e` injection | Worker reads from env `PI_AGENTS_TOOL_CONTEXT_LOADER_PATH`, never manifest |
| Result redacted | `formatChildAgentRunResult` before `result.json` write |
| Shell injection prevention | Terminal backend uses fixed paths only |
| Manifest integrity | Per-session MAC, verified by worker before use |
| State-file protection | 0700 dir, 0600 sensitive files |
| Resource DoS | Max concurrent runs enforced |
| No cross-agent leakage | Separate run dirs, no shared state |

## Implementation slices

### P4-1: bg-state.ts — Run state format (~100 lines)

- State directory: `~/.pi/agent/bg/` (0700)
- Per-run directory: `<runId>/` with manifest.json, result.json, events.jsonl, done
- `.session.mac` key generation and cleanup
- Atomic write pattern: tmp → rename
- Atomic dir creation: `mkdir` with exclusivity, EEXIST handling
- Symlink refusal, concurrency reservation
- Pruning + orphan cleanup on session start
- **New file only**

### P4-2: bg-preflight.ts — Shared preflight (~80 lines)

- `preflightBgAgent(target, task, ctx)` → writes identity manifest + returns run ID
- Calls `canRunAgent` (can-run-agent.ts), verifies registered hash, enforces user-registry gate (project trust DEFERRED)
- Builds manifest via `signBgManifest(Omit<BgRunManifest,"mac">, key)` + attaches `mac` + `keyGenId = keyGenIdFromKey(key)` (bg-state.ts); top-level `version:1`, `runId`, `keyGenId` REQUIRED
- Options keys limited to `{maxDurationSec?, cwd, homeDir}` (readBgManifest rejects unknown)
- Writes manifest with identity only (name, path, expected hash), task, options
- Returns run ID for terminal backend launching
- **Refactors existing preflight in run-resolver.ts** to use shared path — MUST be behavior-preserving for sync `/agents run` (run-resolver.ts:233 already calls canRunAgent); add sync-path regression assertion
- Imports: `canRunAgent`→can-run-agent.ts; `signBgManifest`/`keyGenIdFromKey`/`readOrCreateSessionMacKey`/`createBgRunState`/`writeBgManifest`/`getBgRunPaths`→bg-state.ts; `buildChildPiArgs`→child-args.ts
- **New file + refactor**

### P4-3: bg-worker.ts — Worker process (~150 lines)

- `runBgWorker(manifestPath)` — entry point for terminal-launched process
- `readBgManifest(paths)` → `verifyBgManifest(manifest, readSessionMacKey(resolveTrustedHome()))` — rejects on tamper
- `assertManifestIdentityMatchesRuntime(manifest, { homeDir: resolveTrustedHome() })` — rejects on homeDir mismatch (N1; cwd NOT compared — N6)
- Reads identity from manifest (name, path, expected hash)
- For each agent spawn (including chain steps):
  - Re-reads file bytes from `canonicalPath`, recomputes `rawBytesSha256`
  - Re-reads **user registry** from disk (project trust DEFERRED — user-agents-first)
  - Calls `canRunAgent` with live hash, registry (no project-trust re-read in this cut)
  - If denied → writes `failed` (writeBgResult), writes `done` (markBgRunDone), exits
  - If approved → reads `-e` from env, hard-pins `disableResourceDiscovery: true`
  - Calls `buildChildPiArgs` (child-args.ts) with live spec
  - Calls `runChildAgent` (child-runner.ts; preserving timeout/output/JSONL/redaction)
- For chain: extracts `summary.summaryText` (24KB cap), passes as next task
- Handles SIGTERM → writes `stopped`, writes `done`, exits (killing is the backend's job via bg-stop; reaper never signals — N3)
- Writes redacted `result.json` atomically (writeBgResult), writes `done` sentinel (markBgRunDone)
- Imports: `readBgManifest`/`verifyBgManifest`/`assertManifestIdentityMatchesRuntime`/`resolveTrustedHome`/`readSessionMacKey`/`writeBgResult`/`markBgRunDone`/`appendBgEvent`/`getBgRunPaths`→bg-state.ts; `canRunAgent`→can-run-agent.ts; `buildChildPiArgs`→child-args.ts; `runChildAgent`→child-runner.ts
- **New file only**

### P4-4: agents/lib/bg-terminal.ts — Backend interface (~30 lines)

- `TermBgBackend` interface: `launch`, `kill`, `isAlive`, `list`
- `registerBgTerminalBackend(backend)` / `getBgTerminalBackend()` registry
- **New file only**

### P4-5: index.ts — Command wiring (~80 lines)

- `/agents bg` handler → preflight + `termBackend.launch()`
- `/agents bg-chain` handler → preflight chain + `termBackend.launch()`
- `/agents bg-status` handler (reads state dir + tmux from backend)
- `/agents bg-stop <id>` handler
- `/agents bg-result <id>` handler (redacted)
- `/agents bg-open <id>` handler → `termBackend` window selection
- Usage text + completion arguments

### P4-6: Status line (~30 lines)

- Running agent count via `appendEntry`

### P4-7: Tests (~30 tests)

- `agents/test-fixtures/test-bg.mjs`
- Fake `TermBgBackend`, fake worker, temp state dir
- Tests for: preflight blocks, hash mismatch, task privacy, manifest tamper, identity mismatch (project trust tests DEFERRED to project-agent scope)
  manifest integrity, per-spawn gate re-run, bg-chain handoff, timeout,
  stop, parent restart, lost result, concurrency limit, runId collision,
  symlink refusal, disk-full handling
- **Negative tests from adversarial review**: manifest tamper (forbidden tools,
  disableResourceDiscovery, loader path, MAC re-sign), project trust revoked (DEFERRED)
  mid-flight, agent unregistered mid-flight, events.jsonl never surfaced,
  prompt.txt deleted on crash path, worker denied → tmux closes

## Hard stops

- No write/edit/bash in child agents
- No autonomous delegation or cross-agent memory
- No relaxation of any P3 security gate
- No change to synchronous `/agents run`
- `explicitToolContextLoaderPath` NEVER in manifest (env only)
- `disableResourceDiscovery` NEVER in manifest (hard-pinned)
- Spec tools NEVER in manifest (re-read from file at spawn)
- Manifest integrity always verified via per-session MAC
- `events.jsonl` NEVER surfaced by any `bg-*` command

## Done criteria

- `/agents bg scout <task>` launches agent in terminal window, parent returns immediately
- `/agents bg-chain scout,planner <task>` runs chain with handoff in single worker
- `/agents bg-status` shows running agents with elapsed time
- `/agents bg-stop <id>` kills agent
- `/agents bg-result <id>` shows redacted result
- Worker re-runs full P3 gate at each spawn (canRunAgent, hash, trust)
- Manifest tamper → blocked (MAC + hard-pinned options)
- Agent unregistered / hash changed / trust revoked between preflight and spawn → blocked at worker
- All existing P3 test suites still pass
- Extension load smoke unchanged
