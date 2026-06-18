# P4: Background/Tmux Agent Execution Plan

**Status**: Planning (revised after planner review)
**Date**: 2026-06-18
**Review**: [P4_BACKGROUND_AGENTS_PLAN_REVIEW.md](./P4_BACKGROUND_AGENTS_PLAN_REVIEW.md) — planner `openai-codex/gpt-5.5`
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

Three existing Pi packages already demonstrate this pattern:

| Package | Approach |
|---|---|
| `pi-tmux-subagents` (npm, masta_g3) | Tmux windows + result files + built-in agents |
| `pi-side-agents` (GitHub, pasky) | Tmux windows + git worktrees + topic branches |
| `pi-crew` (pi.dev) | Coordinated teams + async orchestration |

## Non-goals

- No parallel fan-out beyond what the user explicitly spawns
- No autonomous agent delegation (parent must initiate)
- No cross-agent memory or shared state between background agents
- No persistent agent daemon or service
- No write/edit/bash in child agents (still read-only by default)
- No relaxation of any P3 security invariant

## Design (revised after planner review)

The planner review identified three critical architecture issues:

1. **In-memory tracker cannot survive parent restart** — plan claimed "agents
   continue" but tracker was in-memory only
2. **Timeout/output limits bypassed** — background `pi` launched raw would
   bypass `runChildAgent` protections
3. **Shell injection via tmux command strings** — task paths interpolated into
   shell commands

Revised approach:

### State on disk, not in memory

Each background run gets a private directory:

```text
~/.pi/agent/bg/<runId>/     (0700)
  manifest.json              (0600) — frozen approved spec + options
  prompt.txt                 (0600) — task text
  result.json                (0600) — ChildAgentRunResult
  events.jsonl               (0600) — raw JSONL events
  done                       (sentinel, empty file)
```

Random run IDs, not derived from agent names or tasks. Tracker is
reconstructable from disk state + tmux windows. In-memory cache only.

### Supervisor pattern

A background worker process calls `runChildAgent` (not raw `pi`).
This preserves:
- Timeout enforcement
- Stdout/output byte caps
- JSONL reduction and parsing
- Result formatting and redaction
- Force-kill on timeout
- `--no-approve`, `--no-session`, forbidden tool blocking

The tmux launcher only passes a manifest path to the supervisor:

```
tmux new-window -d -n "pi-agent-<shortId>" \
  '/path/to/supervisor /path/to/.pi/agent/bg/<runId>/manifest.json'
```

### Tmux as launcher only

- Window name: `pi-agent-<shortId>` (sanitized, no task/name/path data)
- Fixed shell-quoted command: trusted executable + manifest path only
- No task text, agent names, or file paths in the tmux command string

### Private-temp-file transport

Use existing `buildChildPiArgs` with `promptTransport: "private-temp-file"`
and `-p @file`. Not shell pipe redirection.

### Commands

```text
/agents bg <agent> <task>             Launch background agent
/agents bg-chain <a>,<b>[,<c>] <task>  Launch background chain
/agents bg-status                     Show running + recent agents
/agents bg-stop <id>                  Kill a background agent
/agents bg-result <id>                Show redacted result
/agents bg-open <id>                  Switch to tmux window
```

### Background chain mode

Same as sync chain but each step spawns via the supervisor. Chain handoff
uses `summary.summaryText` capped at 24,000 bytes. Mid-chain failure stops
subsequent spawns.

### Completion detection

1. **done sentinel**: Supervisor writes `done` after atomic result write.
   Parent polls every 2s with max timeout.
2. **Tmux window check**: `tmux list-windows -F "#{window_name}"` fallback.
3. **State dir scan**: bg-status checks all `~/.pi/agent/bg/*/done` files.

### Status line

```text
│ agents: 2 running │ permission: ask │ runbooks: 3
```

### Concurrency

- Max concurrent background runs (configurable, default 5)
- Prune old completed runs from state dir (default: keep last 20)
- Orphaned/stale run detection via tmux window check

## Security invariants (all preserved)

| Invariant | How it's preserved |
|---|---|
| canRunAgent before spawn | Shared preflight in `bg-preflight.ts` — same code path for sync + bg |
| Hash registration check | Verified during preflight, frozen into manifest |
| Project trust required | `ctx.isProjectTrusted()` check before project agent bg spawn |
| Task in stdin, not argv | `promptTransport: "private-temp-file"` via `buildChildPiArgs` |
| `--no-approve` by default | Same `buildChildPiArgs` output |
| Forbidden tools blocked | Same `buildChildPiArgs` output — no write/edit/bash/run_subagent |
| No model/tool/spec injection | Trusted loader path from `ctx.explicitToolContextLoaderPath` only |
| Result redaction | Supervisor uses `formatChildAgentRunResult` for result.json |
| Spec/profile TOCTOU | Freeze approved spec into manifest; revalidate hash before each spawn |
| Shell injection prevention | Tmux command contains only trusted paths, no interpolation |
| Tmux window isolation | Each agent in own window, no shared state |
| State-file protection | 0700 state dir, 0600 sensitive files |
| Resource DoS | Max concurrent run limit |
| Task privacy | `result.json` uses redacted format; prompt.txt deleted after read |

## Implementation slices

### P4-1: bg-state.ts — Run state format (~100 lines)

- State directory: `~/.pi/agent/bg/`
- Per-run directory: `<runId>/` with manifest, prompt, result, events, done
- Atomic result write: tmp → rename
- Cleanup: prune old runs, handle orphans
- Random run IDs, 0700/0600 permissions
- **New file only, zero existing-file changes**

### P4-2: bg-preflight.ts — Shared preflight (~80 lines)

- `preflightBgAgent(target, task, ctx)` shared path for sync run, sync chain, bg, bg-chain
- Calls `canRunAgent`, verifies registered hash, enforces project trust
- Freezes approved effective spec into manifest
- **Modifies run-resolver.ts** to use shared preflight
- **New file, plus refactor of existing preflight code**

### P4-3: bg-worker.ts — Supervisor (~120 lines)

- `runBgWorker(manifestPath)` — called by tmux
- Reads manifest, calls `runChildAgent` or chain runner
- Enforces timeout, output limits, JSONL reduction
- Writes result.json atomically, writes `done` sentinel
- Handles SIGTERM (kill) — writes stopped status
- **New file only**

### P4-4: bg-tmux.ts — Tmux integration (~80 lines)

- `spawnBgAgent(spec, task, opts)` → BgAgentRun
- `spawnBgChain(resolvedAgents, task, opts)` → BgAgentRun[]
- Tmux command construction (fixed, no interpolation)
- Fake tmux adapter for tests
- `killBgAgent(id)`, `getBgResult(id)`
- Completion polling
- **New file only**

### P4-5: index.ts — Command wiring (~80 lines)

- `/agents bg` handler
- `/agents bg-chain` handler
- `/agents bg-status` handler (reads state dir + tmux)
- `/agents bg-stop <id>` handler
- `/agents bg-result <id>` handler
- `/agents bg-open <id>` handler
- Usage text update
- Completion arguments

### P4-6: Status line (~30 lines)

- AppendEntry for running agent count
- Hover shows names and elapsed time
- **Minor index.ts change**

### P4-7: Tests (~25 tests)

- `agents/test-fixtures/test-bg.mjs`
- Fake tmux adapter, fake supervisor, temp state dir
- Tests for: preflight blocks, hash mismatch, project trust, task privacy,
  tmux unavailable, shell quoting, timeout, stop, parent restart reconstruction,
  lost result, bg-chain failure, profile trust, concurrency limit

### P4-8: Cleanup + cross-test verification

- Ensure all existing P3 test suites pass
- Verify no regression in sync `/agents run`
- Verify extension load smoke

## Hard stops

- Do not add write/edit/bash to child agents
- Do not add autonomous delegation or cross-agent memory
- Do not relax any P3 security gate
- Do not add persistence beyond agent state dir (no user-visible registry changes)
- Do not add parallel fan-out from a single command (user must spawn individually)
- Do not change synchronous `/agents run` behavior
- Do not add a daemon, service, or long-running agent process
- Do not ship a real supervisor binary — reuse `runChildAgent` in the same process

## Done criteria

- `/agents bg scout <task>` launches a scout in a tmux window, parent returns immediately
- `/agents bg-chain scout,planner <task>` runs chain in background
- `/agents bg-status` shows running agents with elapsed time
- `/agents bg-stop <id>` kills tmux window and marks agent stopped
- `/agents bg-result <id>` reads result with task content redacted
- Status line shows running agent count
- `tmux` not installed → clean error, no crash
- All P3 security invariants verified for the background path
- 25+ tests passing
- All existing P3 test suites still pass
- Extension load smoke unchanged

## Security review checklist

- [ ] Shared preflight used for sync run, chain, bg run, bg chain
- [ ] canRunAgent called before tmux spawn
- [ ] Hash registration check frozen into manifest
- [ ] Project trust required before project agent bg spawn
- [ ] Task in private temp file, not in argv or tmux command
- [ ] `--no-approve` present in child argv
- [ ] `--no-extensions --no-skills --no-prompt-templates --no-themes` present
- [ ] Forbidden tools (`write/edit/bash/run_subagent`) blocked
- [ ] `--no-session` on child (ephemeral)
- [ ] Tool-context-loader JIT forwarded if configured
- [ ] Model/tool/spec path injection exclusion (trusted source only)
- [ ] Result redacted via `formatChildAgentRunResult` before write
- [ ] Prompt file deleted after result read
- [ ] State dir 0700, sensitive files 0600
- [ ] Tmux command contains only trusted paths (no task/name/path interpolation)
- [ ] Tmux window name sanitized (`pi-agent-<shortId>`)
- [ ] No cross-agent state leakage
- [ ] Max concurrent runs enforced
- [ ] Old runs pruned
- [ ] `ctx.agentsChildRunner` not used in production bg path
