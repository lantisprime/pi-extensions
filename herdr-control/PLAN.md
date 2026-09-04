# herdr-control — pi extension plan (rev 2, post-review)

> **Status: implemented.** All rev-2 review findings are in `index.ts` +
> `lib/`. Tests: `bash test-fixtures/run-tests.sh` (10 suites, fake
> executor). Live E2E verified via `test-fixtures/smoke-live.mjs` (spawn →
> prompt → settle → read → registry close) against herdr 0.8.0.

## Goal

Launch and coordinate subagents (pi, claude, codex, …) through [herdr](https://herdr.dev),
from inside pi, as a pi extension following this repo's established
`cmux-control` / `tmux-control` patterns.

## Environment facts (verified)

- herdr 0.8.0 stable, server running, socket `~/.config/herdr/herdr.sock`.
- pi runs INSIDE a herdr pane here: `HERDR_ENV=1`, `HERDR_WORKSPACE_ID=w9`,
  `HERDR_TAB_ID=w9:t1`, `HERDR_PANE_ID=w9:p1`.
- CLI supports: `workspace|tab create`, `pane split`, `agent start|prompt|wait|
  read|get|list|send-keys|rename|explain`, all JSON on stdout, errors JSON on
  stderr (exit 1 server / exit 2 syntax).
- Official best practices: docs/agent-automation + skills/herdr/SKILL.md.

## Entry gate (review finding #1)

All tools/commands check `HERDR_ENV === "1"` and a reachable server
(`herdr status client`, cheap, cached ~30s) at execute time. Outside herdr:
refuse with actionable message ("not running inside a herdr pane; start herdr
or launch pi inside it") instead of letting the LLM flail at CLI errors.

## Extension surface

Directory: `herdr-control/` with `index.ts` + `lib/` modules (match repo style:
`exec.ts`, `launch.ts`, `list.ts`, `read.ts`, `safety.ts`, `registry.ts`,
`constants.ts`). Explicit JSON parse helpers (`parsePaneIdFromSplit`,
`parseRootPaneFromCreate`, `parseAgentFromResult`) in `lib/` — never regex
IDs out of ad-hoc strings at call sites.

Enums via `StringEnum` from `@earendil-works/pi-ai` (Google-API compatible),
per extensions.md; not raw `Type.String({ enum })`.

### LLM tools (registerTool)

1. `herdr_agents` — list live agents (name, kind, status, pane, cwd); with
   optional `agent` param returns `agent get` detail for that one
   (consolidates old separate status tool).
2. `herdr_spawn` — launch a subagent and submit its task.
   Params:
   - `name` (string, required) — `[a-z][a-z0-9_-]{0,31}`, prefix-gated
     (`pi-herdr-` default, `/herdr-config prefix` to override, like cmux).
   - `task` (string, required)
   - `kind` (StringEnum, default `pi`) — pi | claude | codex | gemini | opencode
   - `cwd` (optional, default caller cwd)
   - `direction` (StringEnum right|down, optional; auto: wide→right else down)
   - `timeout_ms` (optional, default 300000)
   - `new_workspace` (optional bool, default false)
   Pipeline with named failure points:
   1. name-collision pre-check via `herdr agent list`
   2. `pane split --current --direction D --cwd CWD --no-focus`
      (or `workspace create --cwd CWD --label NAME --no-focus`);
      parse pane id from `.result.pane.pane_id` / `.result.root_pane.pane_id`
   3. `agent start NAME --kind K --pane ID` (30s detection); on
      `agent_not_ready`: do NOT give up — `agent wait NAME --until idle
      --timeout 30000` once; record outcome either way
   4. `agent prompt NAME TASK --wait --timeout T`
   5. on success: `agent read NAME --source recent-unwrapped --lines 200`
   Failure semantics (replaces vague "single retry" from rev 1):
   - distinguish error classes from stderr JSON: `agent_blocked` (surface
     transcript, stop, never auto-answer), `agent_prompt_stalled` (report,
     no blind retry — state likely unchanged; one `agent get` + read for
     diagnosis), timeout (report state; LLM decides whether to `herdr_agents`
     + re-prompt deliberately), `agent_not_running` (agent died; report).
   - partial-failure rollback: if step 3/4 fails after a pane was created,
     record the pane as orphaned in the registry; surface "pane wN:pX left
     running (empty shell)" in the tool result with a hint to /herdr-close.
3. `herdr_read` — `agent read` with `source` (StringEnum: visible | recent |
   recent-unwrapped) and `lines` (1..1000) params.
4. `herdr_send_keys` — keys-only (`esc`, `enter`, `ctrl+c`, …) for
   deliberate UI response; ALWAYS `ctx.ui.confirm` even when called as a tool
   (review finding #8); description scoped to blocked-state rescue.
5. `herdr_close` — close a spawned pane/tab/workspace. Targets validated
   against the registry (below); refuse everything else.

### Slash commands

- `/herdr-list` — notify agent list.
- `/herdr-spawn <name> [--kind k] [--cwd p] [--dir right|down] <task...>`
- `/herdr-config prefix <value>` — session-only prefix override.

### Spawn registry (review finding #3)

In-memory Map (name → {paneId, workspaceId, createdAt}) **plus** persisted
via `pi.appendEntry()` (custom entry type `herdr-control/spawn`) so
`herdr_close` still knows its targets after `/new`, `/resume`, `/fork`,
`/reload`. On session_start, hydrate registry from session entries and prune
targets that no longer appear in `herdr agent list` (dead panes drop out;
still-closed IDs never reused by herdr, so no false hits).
Fallback rule: a target whose name carries the current prefix but is absent
from the registry requires explicit `ctx.ui.confirm`.

### session_shutdown (review finding #2)

Register idempotent `session_shutdown` handler: list still-alive spawned
agents via `herdr agent list` filtered to registry names and notify the user
("subagents still running: reviewer (w9:p3) …"). Never auto-kill — herdr panes
are user-visible; killing is `/herdr-close` or manual.

### NLP input hook (review finding #12, parity)

Small `pi.on("input")` hook, cmux-style: `list herdr agents` → herdr-list;
`herdr spawn <name> ...` routes to the same spawn pipeline. Confidence ≥ 0.8
only; everything else passes through.

## Error handling & result shape

- `exec.ts`: child_process execFile (argv array, no shell), capture stdout +
  stderr JSON, exit-code aware (1 = server error w/ JSON stderr, 2 = usage),
  per-call timeout = pipeline timeout + 10s.
- Tool results: hard failures **throw** (docs: throwing sets `isError: true`
  and reports failure to the LLM); expected/policy outcomes (blocked, stalled,
  orphan notice) return normal results with status in text + `details` so the
  LLM can branch without treating them as tool crashes.
- Transcript truncation: keep tail, ≤ 8k chars.

## Out of scope (v1)

- Socket API direct client (CLI is sufficient; protocol churn risk; rev 2
  review accepted this).
- wait/subscribe streaming, worktree helpers, notifications, remote,
  alternate-screen page-collection (recent-unwrapped after settle covers us).

## Test plan

- `test-fixtures/` with canned JSON outputs (workspace create, pane split,
  agent start, prompt result, agent get, agent list, read output) mirroring
  cmux-control's fixture style.
- Runner: same approach as cmux-control (`run-tests.sh`,
  `node --experimental-strip-types`) with a `FakeHerdrExecutor` capturing
  argv; unit-test parse helpers, arg builders, registry persistence/pruning,
  and safety gates (prefix, close targets, confirm-required send_keys,
  HERDR_ENV gate, name collisions).
