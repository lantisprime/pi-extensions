# P4: Background/Tmux Agent Execution Plan

**Status**: Planning
**Date**: 2026-06-18
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

We can reuse their proven tmux patterns layered on P3's existing security
model.

## Non-goals

- No parallel fan-out beyond what the user explicitly spawns
- No autonomous agent delegation (parent must initiate)
- No cross-agent memory or shared state between background agents
- No persistent agent daemon or service
- No write/edit/bash in child agents (still read-only by default)
- No relaxation of any P3 security invariant

## Design

### New execution path

```
/agents run scout <task>         → synchronous (current, unchanged)
/agents bg scout <task>           → tmux background (new)
/agents chain scout,planner <task> → synchronous (current, unchanged)
/agents bg-chain scout,planner <task>  → tmux background chain (new)
```

### Tmux integration

The parent Pi session constructs the same safe child argv via
`buildChildPiArgs()`. Instead of `child_process.exec`, it:

1. Writes the task to a temp file (stdin transport)
2. Constructs the full `pi` command with all safety flags
3. Wraps it in `tmux new-window -d -n "agent-<name>" 'pi ... < task.md > <result.log> 2>&1'`
4. Records agent metadata in an in-memory session tracker
5. Returns immediately with an agent run ID

The child tmux window runs independently. The parent can:

- Poll `tmux list-windows` to check if the window still exists
- Read the result log file when complete
- Show progress in the status line: `│ agents: 2 running`
- Open the tmux window on demand: `tmux select-window -t "agent-scout"`

### Background agent tracker

```typescript
interface BgAgentRun {
  id: string;           // UUID
  agentName: string;
  spec: AgentSpec;
  task: string;
  tmuxWindow: string;   // tmux window name
  resultFile: string;   // /tmp/pi-agent-<id>.(jsonl|log)
  taskFile: string;     // /tmp/pi-agent-<id>.task.md
  startedAt: number;
  status: "running" | "completed" | "failed" | "timed-out" | "stopped";
}
```

In-memory only — session-scoped `Map<string, BgAgentRun>` on the
extension's `sessionState`. No persistence to disk. Cleaned on session end.

### Commands

```text
/agents bg <agent> <task>             Launch background agent
/agents bg-chain <a>,<b>[,<c>] <task>  Launch background chain
/agents bg-status                     Show running agents
/agents bg-stop <id>                  Kill a background agent
/agents bg-result <id>                Show result of a completed agent
/agents bg-open <id>                  Switch to agent's tmux window
```

### Security invariants (all preserved)

| Invariant | How it's preserved |
|---|---|
| canRunAgent before spawn | Same gate, same code path — `resolveRegisteredRunTarget` → `canRunAgent` |
| Hash registration check | Registry check identical to synchronous path |
| Project trust required | `ctx.isProjectTrusted()` check before project agent spawn |
| Task in stdin, not argv | Written to temp file, piped via `< task.md` in tmux command |
| `--no-approve` by default | Same `buildChildPiArgs` output |
| Forbidden tools blocked | Same `buildChildPiArgs` output — no write/edit/bash/run_subagent |
| No model/tool/spec injection | Trusted loader path from `ctx.explicitToolContextLoaderPath` only |
| Result redaction | Result log read by parent, redacted before display (no task content) |
| Prompt-shield scanning | Task file written to `/tmp` not project dir; parent's prompt-shield still active |
| Tmux window isolation | Each agent in own tmux window, no shared state |

### Background chain mode

`/agents bg-chain scout,planner <task>`:

1. Preflight all agents through `canRunAgent` (same as sync chain)
2. Spawn `scout` in background tmux window with task + result file path
3. Scout completes → parent reads result log → extracts summaryText
4. Spawn `planner` in background tmux window with summaryText as handoff
5. Repeat for subsequent agents
6. Status line updates at each transition

Chain handoff still uses `summary.summaryText` capped at 24,000 bytes.
Mid-chain failure stops subsequent spawns.

### Completion detection

Multiple mechanisms in order of preference:

1. **Result file with sentinel**: Parent writes a `.done` file after child exits.
   Tmux command: `pi ... < task.md > result.log 2>&1; touch result.log.done`
   Parent polls for `.done` file existence (every 2s, max timeout).
2. **Tmux window check**: `tmux list-windows -F "#{window_name}" | grep "agent-<id>"`
   Fallback: check if tmux window still exists.
3. **Process supervision**: Parent records tmux window PID via
   `tmux display -p -t "agent-<id>" "#{pane_pid}"`. Poll `kill -0 $PID`.

Preferred: result file sentinel (simple, works across sessions).

### Status line

```text
│ agents: 2 running │ permission: ask │ runbooks: 3
```

Hovering shows agent names and elapsed time:

```text
│ agents: scout (12s), planner (4s)
```

### Edge cases

| Edge case | Behavior |
|---|---|
| Tmux not installed | `/agents bg` returns error: "tmux not found on PATH" |
| Tmux session detached | Agent windows still run (detached mode `-d`) |
| Parent session killed | Agent windows continue (owned by tmux server) |
| Result file lost | After timeout, mark as `unknown`, log warning |
| Multiple agents with same name | Append `-1`, `-2` to tmux window names |
| Agent times out | `tmux kill-window -t "agent-<id>"` + mark as `timed-out` |
| Chain handoff to dead agent | Mid-chain failure stops subsequent spawns |
| Prompt-shield blocks task | Fail-closed — do not write task file, do not spawn |

### Implementation plan

**P4-1: Background runner core** (new file, ~150 lines)
- `agents/lib/bg-runner.ts`
- `spawnBgAgent(spec, task, options) → BgAgentRun`
- `spawnBgChain(resolvedAgents, task, options) → BgAgentRun[]`
- Tmux command construction with result file setup
- Completion polling loop
- `killBgAgent(id)`, `getBgResult(id)`
- Reuse `buildChildPiArgs` unchanged

**P4-2: Session tracker** (new file, ~80 lines)
- `agents/lib/bg-tracker.ts`
- In-memory `Map<string, BgAgentRun>`
- Status line integration via `appendEntry`
- Prune completed agents after result read
- Clean on session end

**P4-3: Command wiring** (modify index.ts, ~60 lines)
- `/agents bg` handler → parseRunArgs + spawnBgAgent
- `/agents bg-chain` handler → parseChainArgs + spawnBgChain
- `/agents bg-status` handler → format running agents
- `/agents bg-stop <id>` handler → killBgAgent + kill tmux window
- `/agents bg-result <id>` handler → read result file + redact
- `/agents bg-open <id>` handler → `tmux select-window`
- Completion argument: add `bg`, `bg-chain`, `bg-status`, `bg-stop`, `bg-result`, `bg-open`
- Usage text update

**P4-4: Tests** (~20 tests)
- `agents/test-fixtures/test-bg.mjs`
- Tmux not installed → graceful error
- Tmux command construction (no real spawn)
- Result file sentinel detection
- Completion polling works
- Chain handoff between background agents
- Status tracker add/remove/status
- Multiple agents with name collision
- Agent timeout/kill
- Result redaction

### Hard stops

- Do not add write/edit/bash to child agents
- Do not add autonomous delegation or cross-agent memory
- Do not relax any P3 security gate
- Do not add persistence beyond session memory
- Do not add parallel fan-out from a single command (user must spawn individually)
- Do not change synchronous `/agents run` behavior
- Do not add a daemon, service, or long-running agent process

### Done criteria

- `/agents bg scout <task>` launches a scout in a tmux window, parent returns immediately
- `/agents bg-chain scout,planner <task>` runs chain in background
- `/agents bg-status` shows running agents with elapsed time
- `/agents bg-stop <id>` kills tmux window and marks agent stopped
- `/agents bg-result <id>` reads result log with task content redacted
- Status line shows running agent count
- `tmux` not installed → clean error, no crash
- All P3 security invariants verified for the background path
- 20+ tests passing
- Extension load smoke unchanged

### Security review checklist

- [ ] canRunAgent called before tmux spawn (same code path as sync)
- [ ] Hash registration check identical to sync path
- [ ] Project trust required before project agent bg spawn
- [ ] Task in temp file, piped via `<` — never in argv or tmux command text
- [ ] `--no-approve` present in child argv
- [ ] `--no-extensions --no-skills --no-prompt-templates --no-themes` present
- [ ] Forbidden tools (`write/edit/bash/run_subagent`) blocked
- [ ] `--no-session` on child (ephemeral)
- [ ] Tool-context-loader JIT forwarded if configured
- [ ] Model/tool/spec path injection exclusion (trusted source only)
- [ ] Result log redacted before display (no task content leaked)
- [ ] Temp files cleaned up after result read
- [ ] No cross-agent state leakage
- [ ] Tmux window naming prevents injection (sanitize agent name)
