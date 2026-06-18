# P4: Background/Tmux Agent Execution Plan

**Status**: Planning (v3 — all blocker fixes folded)
**Date**: 2026-06-18
**Reviews**:
- [P4_BACKGROUND_AGENTS_PLAN_REVIEW.md](./P4_BACKGROUND_AGENTS_PLAN_REVIEW.md) — planner `openai-codex/gpt-5.5`
- [P4_BACKGROUND_AGENTS_ADVERSARIAL_REVIEW.md](./P4_BACKGROUND_AGENTS_ADVERSARIAL_REVIEW.md) — adversarial `openrouter/anthropic/claude-opus-4-8`
**Depends on**: P3 agent scaffold (complete)

## Objective

Extend P3 agents to support non-blocking background agent execution in tmux
windows. The main Pi terminal stays responsive while child agents run in
separate tmux windows. All P3 security invariants must be preserved — no
relaxation of canRunAgent, hash registration, project trust, or forbidden tools.

## Rationale

P3 child agents run synchronously via `child_process.exec` and block the
parent Pi session. For longer tasks (deep codebase scout, multi-file planner,
adversarial review), the parent becomes unresponsive for minutes. Users
naturally want to:

1. Fire off a chain (`/agents chain scout,planner <task>`) and keep working
2. Run multiple independent agents in parallel (scout module A, scout module B)
3. Monitor agent progress from a status line
4. Switch into agent tmux windows to inspect live output

## Non-goals

- No parallel fan-out beyond what the user explicitly spawns
- No autonomous agent delegation (parent must initiate)
- No cross-agent memory or shared state between background agents
- No persistent agent daemon or service
- No write/edit/bash in child agents (still read-only by default)
- No relaxation of any P3 security invariant

## Design (v3 — adversarial review fixes folded)

### Core insight: manifest is identity, not authority

The manifest carries only identity — agent name, canonical path, expected
hash — plus the task text. It does **not** carry execution authority.
A separate worker process re-derives all authority decisions from disk
and trusted runtime sources, identical to the sync P3 path.

### Manifest format

```json
// ~/.pi/agent/bg/<runId>/manifest.json (0600, signed with per-session MAC)
{
  "identity": {
    "agentName": "scout",
    "canonicalPath": "/Users/x/.pi/agent/agents/scout.md",
    "expectedHash": "abc123..."
  },
  "task": "<task text>",
  "options": {
    "maxDurationSec": 120,
    "cwd": "/Users/x/projects/my-app",
    "homeDir": "/Users/x",
    "toolContextLoaderSource": "__pi_session_env__"
  },
  "mac": "hmac-sha256(...)"
}
```

Key safety properties:
- `explicitToolContextLoaderPath` is **never** in the manifest. Worker reads
  it from env `PI_AGENTS_TOOL_CONTEXT_LOADER_PATH` (same trusted source as P3).
  The field `toolContextLoaderSource: "__pi_session_env__"` is informational only.
- `disableResourceDiscovery` is **never** in the manifest. Worker hard-pins it
  to the safe value (`true`), enforcing `--no-approve`, `--no-extensions`,
  `--no-skills`, `--no-prompt-templates`, `--no-themes`.
- `spec.tools` is **never** in the manifest. Worker re-reads the spec file,
  runs `canRunAgent`, and passes the live spec to `buildChildPiArgs` — where
  forbidden-tool blocking (`write/edit/bash/run_subagent`) is enforced by the
  same code path as sync mode.
- MAC protects integrity: if manifest is tampered with, the worker rejects it.
- Task text stays local to the manifest file (within the 0700 state dir).

### Process boundary (explicit)

The worker is a **separate process** launched via tmux. It has no live `ctx`
(Pi ExtensionContext). It re-derives all authority from:

| Concern | Source |
|---|---|
| Agent spec + hash | Re-reads file bytes from `canonicalPath`, recomputes `rawBytesSha256` |
| Registration gate | Re-reads registry from disk, calls `canRunAgent` |
| Project trust | Re-reads `.pi/agent/trust-state` from disk |
| Forbidden tools | `buildChildPiArgs` normalizes tools from live spec (forbidden check built-in) |
| Hardening flags | Hard-pinned: `disableResourceDiscovery: true` |
| Loader path | Env `PI_AGENTS_TOOL_CONTEXT_LOADER_PATH` (trusted runtime source) |
| Chain handoff | Reads prior agent's `result.json` from disk |

The "same process / no supervisor binary" hard stop from the pre-review plan
is **removed** — it was contradictory with the tmux design.

### Per-spawn gate (not per-chain preflight)

The worker re-runs the full P3 gate **before each individual agent spawn** —
including each chain step. This closes the TOCTOU windows identified in B3 and B4:

1. Worker reads identity from manifest (name, path, expected hash)
2. Re-reads current file bytes from `canonicalPath`
3. Computes `rawBytesSha256`
4. Re-reads registry from disk
5. Re-reads project trust state from disk
6. Calls `canRunAgent` with current hash, registry, trust
7. If denied → no spawn, writes `failed` to result, closes tmux window
8. If approved → calls `buildChildPiArgs` with live spec, calls `runChildAgent`

For **bg-chain**, steps 2-8 repeat for each agent in the chain. If any step
denies, the chain stops (subsequent agents are not spawned) but prior results
are preserved and readable.

### Commands

```text
/agents bg <agent> <task>             Launch background agent
/agents bg-chain <a>,<b>[,<c>] <task>  Launch background chain
/agents bg-status                     Show running + recent agents
/agents bg-stop <id>                  Kill a background agent
/agents bg-result <id>                Show redacted result
/agents bg-open <id>                  Switch to tmux window
```

### Tmux integration

The parent constructs a tmux command with **only** trusted paths — the worker
executable path and the manifest path. No task text, agent names, file paths,
or argv options in the tmux command string:

```
tmux new-window -d -n "pi-agent-<shortId>" '<worker> <manifestPath>'
```

- `<worker>`: fixed path to the worker script, set at extension load time
- `<manifestPath>`: absolute path to manifest (random run ID, no injected data)
- `<shortId>`: first 8 chars of random run ID, derived from UUID, not agent name

### State directory

```text
~/.pi/agent/bg/<runId>/     (0700)
  manifest.json              (0600) — identity + task, signed with session MAC
  result.json                (0600) — redacted ChildAgentRunResult
  events.jsonl               (0600) — raw JSONL (never surfaced by bg-* commands)
  done                       (sentinel, empty file)

~/.pi/agent/bg/.session.mac  (0600) — per-session HMAC key
```

Per-run directories created with atomic `mkdir` (not `-p`), `O_EXCL`/flag
`"wx"`. EEXIST → regenerate run ID. Symlinks refused (`lstat` check before
`mkdir`). `realpath`-check manifest before worker reads it.

`prompt.txt` is **not persisted separately** — the task is part of
`manifest.json` within the 0700 dir. Prompt temp file from `buildChildPiArgs`
(`promptTransport: "private-temp-file"`) is cleaned up by `runChildAgent`'s
existing `finally` block (child-runner.ts:154).

`events.jsonl` is raw, never surfaced by `bg-result`, `bg-status`, or
status-line hover. Only `result.json` (via `formatChildAgentRunResult`) is
shown. Prune `events.jsonl` when the run is deleted.

### Completion detection

1. **done sentinel**: Worker writes `done` after atomic result write.
   Parent polls every 2s with max timeout.
2. **Tmux window check**: `tmux list-windows -F "#{window_name}"` fallback.
3. **State dir scan**: bg-status checks all `~/.pi/agent/bg/*/done` files.

### Status line

```text
│ agents: 2 running │ permission: ask │ runbooks: 3
```

### Concurrency and cleanup

- Max concurrent bg runs: 5 (configurable). Atomic reservation via creation
  of a `.reserved` file in the run dir with `flag:"wx"`. Two simultaneous
  spawns → exactly one wins.
- Old runs pruned: keep last 20. Prune also deletes `prompt.txt` and
  `events.jsonl` for any orphaned runs older than session start.
- `.session.mac` key created at session start, deleted on session end.
  Worker uses it to verify manifest integrity.

### Edge cases (expanded)

| Edge case | Behavior |
|---|---|
| Tmux not installed | Clean error, no crash |
| Not inside tmux (`$TMUX` absent) | Agent still runs in new tmux session (`new-session -d`) or fails gracefully if session creation fails |
| Nested/detached tmux | Handled by tmux's own process model |
| Parent session killed | Agent continues (owned by tmux server); on next Pi start, `bg-status` reconstructs from disk state + tmux |
| Agent unregistered between preflight and spawn | Worker re-runs `canRunAgent` at spawn → blocked, no child pi |
| Hash changed between preflight and spawn | Worker recomputes hash at spawn → mismatch → blocked |
| Project trust revoked between preflight and spawn | Worker re-reads trust state → blocked (B4 fix) |
| Manifest tampered | MAC validation fails → worker rejects, no spawn |
| `disableResourceDiscovery` tampered | Not in manifest → worker hard-pins to `true` (B2 fix) |
| `explicitToolContextLoaderPath` tampered | Not in manifest → worker reads from env only (B1 fix) |
| Result file lost | After timeout, mark as `unknown` |
| Multiple agents with same name | Run IDs are random UUIDs, no naming collision |
| Agent times out | `runChildAgent` enforces timeout → worker writes `timed-out` |
| bg-stop | Sends SIGTERM to worker; worker handles it and writes `stopped` status. `tmux kill-window` as fallback |
| Chain handoff to dead agent | Mid-chain failure stops subsequent spawns (same as sync chain) |
| Prompt-shield blocks task | Fail-closed — do not write manifest, do not spawn (same as sync gate) |
| Disk full / partial write | Atomic write pattern: tmp → rename. Incomplete manifest = no done sentinel = never executed |
| `runId` collision | `O_EXCL`/`wx` creation → EEXIST → regenerate |
| Symlinked run dir | Refused (`lstat` check) |
| Two concurrent `bg` commands at limit | One wins reservation (`.reserved`), other returns error |

## Implementation slices

### P4-1: bg-state.ts — Run state format (~100 lines)

- State directory: `~/.pi/agent/bg/` (0700)
- Per-run directory: `<runId>/` with manifest.json, result.json, events.jsonl, done
- `.session.mac` key generation and cleanup
- Atomic write pattern: tmp → rename
- Atomic dir creation: `mkdir` with exclusivity, EEXIST handling
- Symlink refusal: `lstat` before `mkdir`
- Concurrency reservation via `.reserved` file
- Pruning: keep last N runs, delete orphaned
- `prompt.txt` cleanup sweep on session start
- **New file only**

### P4-2: bg-preflight.ts — Shared preflight (~80 lines)

- `preflightBgAgent(target, task, ctx)` → writes identity manifest + returns run ID
- Calls `canRunAgent`, verifies registered hash, enforces project trust
- Writes manifest with identity only (name, path, expected hash), task text, options
- Signs manifest with session MAC
- Returns run ID for tmux spawning
- **Refactors existing preflight in run-resolver.ts** to use shared path
- **New file + refactor**

### P4-3: bg-worker.ts — Worker process (~150 lines)

- `runBgWorker(manifestPath)` — entry point for tmux-launched process
- Verifies MAC on manifest, rejects on tamper
- Reads identity from manifest (name, path, expected hash)
- Re-reads file bytes from `canonicalPath`, recomputes `rawBytesSha256`
- Re-reads registry from disk
- Re-reads project trust state from disk
- Calls `canRunAgent` with live hash, registry, trust
- If denied → writes `failed` result, writes `done`, exits
- If approved → reads `explicitToolContextLoaderPath` from env
- Hard-pins `disableResourceDiscovery: true`
- Calls `buildChildPiArgs` with live spec
- Calls `runChildAgent` or chain runner (preserving timeout/output/JSONL/redaction)
- Handles SIGTERM → writes `stopped`, writes `done`, exits
- Writes redacted `result.json` atomically, writes `done` sentinel
- **New file only**

### P4-4: bg-tmux.ts — Tmux integration (~80 lines)

- `spawnBgAgent(runId, manifestPath)` → launches tmux window
- `spawnBgChain(runIds[], manifestPaths[])` → sequential bg chain coordinator
- Tmux command construction: fixed paths only, no interpolation
- Fake tmux adapter for tests
- `killBgAgent(id)` — SIGTERM + `tmux kill-window` fallback
- `getBgResult(id)` — reads result.json from state dir
- Completion polling via done sentinel
- **New file only**

### P4-5: index.ts — Command wiring (~80 lines)

- `/agents bg` handler
- `/agents bg-chain` handler
- `/agents bg-status` handler (reads state dir + tmux)
- `/agents bg-stop <id>` handler
- `/agents bg-result <id>` handler (redacted via `formatChildAgentRunResult`)
- `/agents bg-open <id>` handler
- Usage text update
- Completion arguments

### P4-6: Status line (~30 lines)

- AppendEntry for running agent count
- Hover shows names and elapsed time
- **Minor index.ts change**

### P4-7: Tests (~30 tests)

- `agents/test-fixtures/test-bg.mjs`
- Fake tmux adapter, fake supervisor, temp state dir
- Tests for: preflight blocks, hash mismatch, project trust, task privacy,
  tmux unavailable, shell quoting, timeout, stop, parent restart reconstruction,
  lost result, bg-chain failure, profile trust, concurrency limit
- **Expanded from planner review (25→30+) + adversarial review negative tests:**
  - Worker re-reads bytes + re-runs canRunAgent at spawn; agent unregistered after preflight → no child pi
  - bg-chain step 2 authority revoked → step 2 fails closed, step 1 result readable
  - Manifest tamper: inject forbidden tools → buildChildPiArgs rejects, no spawn
  - Manifest tamper: disableResourceDiscovery → child argv still has hardening flags
  - Manifest tamper: malicious loader path → -e ignored, worker reads env only
  - Manifest tamper: MAC re-sign failure or missing MAC → rejected
  - Project trust revoked between preflight and spawn → bg run denied
  - prompt.txt deleted even when parent never reads result (crash path)
  - events.jsonl never surfaced raw by bg-result/bg-status
  - $TMUX absent / nested tmux / detached → clean deny, no orphan
  - Worker denied at spawn → tmux window closes, no grandchild pi
  - runId collision (EEXIST) → regenerate, no overwrite
  - Disk-full / partial atomic write → no incomplete manifest executed
  - Concurrency limit hit by two simultaneous spawns → one wins reservation
  - Symlinked run dir / manifest → refused

### P4-8: Cleanup + cross-test verification

- Ensure all existing P3 test suites pass
- Verify no regression in sync `/agents run`
- Verify extension load smoke

## Hard stops

- Do not add write/edit/bash to child agents
- Do not add autonomous delegation or cross-agent memory
- Do not relax any P3 security gate
- Do not change synchronous `/agents run` behavior
- Do not add a daemon or service
- `explicitToolContextLoaderPath` NEVER written to or read from manifest
- `disableResourceDiscovery` NEVER written to or read from manifest
- Spec tools NEVER written to manifest (re-read from file at spawn)
- Manifest integrity always verified via per-session MAC before use
- `events.jsonl` NEVER surfaced by any `bg-*` command or status display

## Done criteria

- `/agents bg scout <task>` launches a scout in a tmux window, parent returns immediately
- `/agents bg-chain scout,planner <task>` runs chain in background
- `/agents bg-status` shows running agents with elapsed time
- `/agents bg-stop <id>` kills tmux window and marks agent stopped
- `/agents bg-result <id>` reads result with task content redacted
- Status line shows running agent count
- `tmux` not installed → clean error, no crash
- Worker re-runs full P3 gate at each spawn (canRunAgent, hash, trust)
- Manifest tamper → blocked (MAC + hard-pinned options)
- Agent unregistered / hash changed / trust revoked between preflight and spawn → blocked at worker
- 30+ tests passing
- All existing P3 test suites still pass
- Extension load smoke unchanged

## Security review checklist

- [ ] Manifest carries identity only (name, path, expected hash), not authority
- [ ] `explicitToolContextLoaderPath` never in manifest; worker reads from env only
- [ ] `disableResourceDiscovery` never in manifest; worker hard-pins to `true`
- [ ] Spec tools never in manifest; worker re-reads file at spawn
- [ ] Manifest signed with per-session MAC; worker verifies before use
- [ ] Worker re-reads file bytes + recomputes hash before each spawn
- [ ] Worker re-reads registry from disk before each spawn
- [ ] Worker re-reads project trust from disk before each spawn
- [ ] Worker calls `canRunAgent` with live hash, registry, trust before each spawn
- [ ] Chain steps each re-run the full gate independently
- [ ] Task in private temp file, not in argv or tmux command
- [ ] `--no-approve`, `--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-themes` hard-pinned
- [ ] Forbidden tools (`write/edit/bash/run_subagent`) blocked by `buildChildPiArgs`
- [ ] `--no-session` on child (ephemeral)
- [ ] Tool-context-loader JIT forwarded via env (not manifest)
- [ ] Result redacted via `formatChildAgentRunResult` before write
- [ ] `events.jsonl` never surfaced raw by any command
- [ ] State dir 0700, sensitive files 0600
- [ ] Tmux command contains only trusted paths (no task/name/path interpolation)
- [ ] Tmux window name sanitized (`pi-agent-<shortId>`, from UUID)
- [ ] No cross-agent state leakage
- [ ] Max concurrent runs enforced with atomic reservation
- [ ] Old runs pruned
- [ ] `runId` collision handled (EEXIST → regenerate)
- [ ] Symlinks refused (`lstat` check)
- [ ] `ctx.agentsChildRunner` not used in production bg path
