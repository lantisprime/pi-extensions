# P4 Background Agents — Planner Review

**Reviewer**: Built-in planner agent (`openai-codex/gpt-5.5`, thinking: high)
**Date**: 2026-06-18
**Verdict**: Plan needs revision — 3 critical architecture changes + 8 concrete recommendations

## Critical findings

### 1. In-memory tracker vs parent restart (contradiction)
Plan says "parent killed → agent windows continue" but also "in-memory session tracker".
These conflict. After parent restart, bg-status/bg-result are blind.
**Fix**: State dir on disk, tracker reconstructable from state dir + tmux windows.

### 2. Timeout/output limits bypassed
Background `pi` launched directly in tmux bypasses `runChildAgent` timeout, stdout limits,
JSONL reduction, force-kill, and result formatting.
**Fix**: Background worker must call `runChildAgent` (supervisor pattern), not raw `pi`.

### 3. Shell injection risk via tmux command strings
`tmux new-window -d -n "agent-<name>" 'pi ... < task.md > result.log 2>&1'`
interpolates task paths and agent names into a shell command string.
**Fix**: Tmux launches a fixed supervisor binary/script with only a manifest path.
No task text, agent names, or file paths in the tmux command string.

### 4. buildChildPiArgs transport mismatch
Plan says "piped with `<`" — but P3 already has `promptTransport: "private-temp-file"`
via `-p @file`. Use that, not shell redirection.

## Recommended changes (priority order)

1. **bg-state.ts first** — private state dir `~/.pi/agent/bg/`, 0700. Per-run dir with
   manifest.json, prompt.txt, result.json, events.jsonl, done sentinel. Random run IDs.

2. **bg-preflight.ts** — shared resolver for all agent types. Calls canRunAgent, verifies
   registered hash, enforces project trust, freezes approved spec into manifest.

3. **Background supervisor/worker** — input: manifest path only. Calls `runChildAgent`.
   Enforces timeout/output limits. Writes result atomically. Handles SIGTERM.

4. **Tmux as launcher only** — sanitized window name `pi-agent-<shortRunId>`. Fixed command
   with only trusted executable path + manifest path. No task/name/path in argv.

5. **Private prompt file transport** — use existing `buildChildPiArgs` with
   `promptTransport: "private-temp-file"`, not shell pipe redirection.

6. **Reconstructable tracker** — bg-status scans state dir + tmux windows.
   In-memory tracker is cache only.

7. **Concurrency + cleanup** — max active bg runs, prune old completed runs,
   handle orphaned/stale runs.

8. **Expanded tests** — untrusted project, hash mismatch, task absent from argv/window/status,
   tmux unavailable, shell quoting/path spaces, timeout/output limit, stop kills child,
   parent restart reconstruction, lost result, bg-chain failure stop, profile trust.

## Missing edge cases identified

- Not inside tmux ($TMUX absent, nested tmux, wrong socket, detached)
- Parent restart state reconstruction
- Background timeout/output limits enforcement
- Prompt temp-file lifecycle (cleanup timing, crash recovery)
- Result sentinel races (need atomic write pattern)
- Lost/stale state (tmux window gone, log exists, no sentinel, etc.)
- bg-stop process-group handling
- bg-open stdin interaction (user typing into child process)
- Multiple concurrent Pi sessions (run-id collisions)
- Disk/quota failures
- Chain per-agent preflight, handoff truncation, failure stop
- Status after manual tmux close (completed vs failed vs killed vs orphaned)
- Log growth beyond P3 limits

## Security concerns identified

- Shell injection via tmux command string interpolation
- Task privacy regression (persistent prompt/log files — P3 default is no persistence)
- Raw JSONL/log leakage (bg-result must redact like formatChildAgentRunResult)
- Window names leaking task/agent data
- State-file tampering (need 0700 dir, 0600 files)
- Preflight duplication (must use shared path for all run modes)
- Spec/profile TOCTOU (freeze approved spec into manifest or revalidate before each spawn)
- Resource DoS (max concurrent bg runs needed)
- ctx.agentsChildRunner bypass in production

## Implementation ordering (revised)

```
P4-1: bg-state.ts    — Run state format, dirs, permissions, cleanup
P4-2: bg-preflight.ts — Shared preflight for sync run, chain, bg, bg-chain
P4-3: bg-worker.ts   — Supervisor that reuses runChildAgent/chain runner
P4-4: bg-tmux.ts     — Tmux launcher abstraction + fake adapter for tests
P4-5: index.ts       — Command wiring (bg before bg-chain)
P4-6: bg-status/result/stop — After persisted state is stable
P4-7: Status line    — UI polish, last
P4-8: Tests          — Comprehensive test coverage
```
