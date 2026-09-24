# SCHEMA Bounded-Tool-Schema Remediation Workplan

## Status

Planning only. Per-tool feature plans (PLAN_TEMPLATE.md) are cut per slice before
implementation. Audit evidence: session 2026-09-24 — full artifact sweep +
reviewer cross-check + jev validation (2 calls, monitor_threads weakest @0.92,
input discipline 2.01/5).

## Rubric (operator-set, binding)

A tool **passes** only if BOTH input and output are schema-bounded. No schema
surface = NP, remediation = create schema. Runtime-only guards = WARN, lift
into schema. Output schemas are currently **impossible** (pi `ToolDefinition`
has no output-schema field — types.d.ts L1177+, `ToolInfo` picks
name/description/parameters/promptGuidelines only), so P5 is a harness
prerequisite for full compliance.

## Objective

Close every input-schema gap found in the audit (27 tools, 10 extensions),
create a schema-bounded surface for the agents extension's five schema-less
invocation paths, and unblock output schemas via a pi core feature.

## Why

The audit's failure modes are real: cron `schedule` can inject unmarked
crontab lines via newline (cron.ts L14, jev 0.97); the tasks status enum may
silently degrade on Google-family providers (Type.Union vs string-enum.ts
header, jev flagged 0.46); agents' five slash surfaces accept free strings
where a schema would reject early. Jev ranked monitor_threads weakest (0.92)
but the operator priority is agents.

## Requirements (ground truth)

| ID | Requirement | Tool(s) | Test(s) | Priority |
|---|---|---|---|---|
| REQ-A1 | `agents_run` tool: `agent` (enum from built-ins + registry), `task` (string, ≤8000 chars), `timeout_s` (integer 1..3600), `profile` (enum from profile library), optional `base`/`range` (pattern-safe git refs) — replaces free-string `/agents run\|do\|run-temp\|chain\|bg` for LLM dispatch | new tool in `agents/` | `agents/test/run-agents-run-tool-tests.sh` | MUST |
| REQ-A2 | `run_subagent` schema mirrors runtime: `agent` gains `pattern: "^[A-Za-z][A-Za-z0-9._-]{0,127}$"`, `task` gains `maxLength: 8000` | run_subagent | assert emitted JSON schema contains pattern+maxLength | MUST |
| REQ-M1 | `monitor_threads.schedule` gets `pattern` (5-field cron chars only, no newline) AND runtime `isValidCronSchedule()` check before `crontabAdd`; `buildCronLine` rejects newline-bearing name/script | monitor_threads | inject `schedule: "*/5 * * * *\n0 0 * * * x"` → denied; crontab unchanged | MUST |
| REQ-M2 | `monitor_threads.lines` gets `minimum: 1, maximum: 1000`; `supervisor.tail` clamps `Math.min(Math.max(Math.trunc(lines),1),1000)` | monitor_threads | `lines: 0` returns ≤1000 lines not all; schema rejects 0 | MUST |
| REQ-T1 | Resolve Type.Union/Google contradiction: test emitted schema for `status` on a Google-family provider; if degraded, migrate STATUS_PARAM to `stringEnum` helper | tasks ×5 | fixture: schema snapshot shows enum survives provider translation | MUST |
| REQ-T2 | `task_create.code` gets `pattern: "^[A-Z][A-Z0-9]{1,15}$"` | task_create | schema rejects `code: "banana"` | SHOULD |
| REQ-J1 | `jev_ask.criteria` shape: schema `anyOf` [record<string,string>, array<string> minItems 2 maxItems 10] if provider-safe; runtime shape check regardless (choice→object, score→array 2..10) | jev_ask | malformed criteria (array for choice) → throw pre-fetch | SHOULD |
| REQ-B1 | herdr `timeout_ms`/`lines` gain `minimum`/`maximum` keywords matching existing runtime clamps (5000..600000; 1..1000) | herdr 7 | emitted schema asserts minimum===5000/maximum===600000 (timeout_ms) and 1/1000 (lines) — exact values, not keyword presence | SHOULD |
| REQ-B2 | tmux/cmux `text`/`prompt` gain `maxLength` matching runtime caps (4KB/4096 chars resp.) | tmux 6, cmux 5 | emitted schema asserts maxLength===4000 (tmux) / 4096 (cmux) — exact value | SHOULD |
| REQ-B3 | web-search `sites`/`urls` items gain domain/URL patterns | secure_web_search | schema rejects `sites: ["not a domain"]` | MAY |
| REQ-O1 | pi core: `ToolDefinition.outputSchema` + result validation (MCP-style) | upstream | pi feature PR; then per-tool adoption | MUST (harness) |
| REQ-O2 | Per-tool output schemas once REQ-O1 lands, agents first | all 27 | per-tool result schema tests | SHOULD |
| REQ-S1 | Slash surfaces not converted by REQ-A1: document as accepted NP or convert case-by-case (config/status commands stay commands) | ~34 commands | docs/USER_MANUAL.md note | MAY |

## Non-Goals

- Rewriting slash commands wholesale — only LLM-reachable delegation paths get tools.
- mcp/mcp-gateway `arguments` pass-through: by design (server validates,
  security-scanned both directions, jev 0.90). Document as accepted risk, no change.
- Changing herdr/tmux/cmux runtime behavior — bounds already enforced; this plan
  only lifts them into schemas.

## Slice ladder

| Slice | Contents | Depends on |
|---|---|---|
| SCHEMA-1 | REQ-A1, REQ-A2 (agents — operator priority) | — |
| SCHEMA-2 | REQ-M1, REQ-M2 (monitor: kill injection + clamp) | — |
| SCHEMA-3 | REQ-T1, REQ-T2 (tasks enum contradiction + code pattern) | — |
| SCHEMA-4 | REQ-J1 (jev criteria shape) | — |
| SCHEMA-5 | REQ-B1..B3 (bounds lift: herdr, tmux/cmux, web-search) | — |
| SCHEMA-6 | REQ-O1 (pi core outputSchema upstream) | — |
| SCHEMA-7 | REQ-O2, REQ-S1 (adoption + slash decision) | SCHEMA-6 |

Slices 1–5 are independent, parallelizable. SCHEMA-1 first per operator.

## Key hook points (from audit)

| File | Line(s) | What | Change |
|---|---|---|---|
| agents/lib/subagent-tool.ts | L231-252 | run_subagent schema | REQ-A2 pattern/maxLength |
| agents/lib/run-resolver.ts | L285, L404 | parseRunArgs/parseDoArgs (timeout 1..3600, isSafeGitRef downstream) | reuse as REQ-A1 exec layer |
| agents/lib/bg-args.ts | L9 | parseBgArgs (--backend/--profile tokenizing) | reuse for REQ-A1 bg mode (full mode coverage) |
| agents/index.ts | L703-775 | handleBgCommand (backend enum, registry gate) | reuse for agents_run backend param |
| monitor-threads/lib/threads-tool.ts | L71-72 | schedule/lines schema | REQ-M1/M2 |
| monitor-threads/lib/cron.ts | L14 | buildCronLine raw interpolation | REQ-M1 validation gate |
| monitor-threads/lib/supervisor.ts | L281-289 | tail slice no clamp | REQ-M2 clamp |
| tasks/index.ts | L41-47, L249+ | STATUS_PARAM Type.Union; code field | REQ-T1/T2 |
| herdr-control/index.ts | L277, L314 | timeout_ms description-only bounds | REQ-B1 |
| tmux-control/lib/send.ts + constants.ts | send L58-59 (cap check), constants L7 (MAX_TEXT_BYTES=4096) | runtime text cap | REQ-B2 mirror exact value into schema |

## Cut order

1. REQ-B3 (web-search item patterns) — lowest risk reduction per effort.
2. REQ-S1 breadth (convert only high-traffic slash commands).
3. REQ-O2 tail (non-agents tools adopt output schemas last).

Do not cut: REQ-M1 (active injection vector), REQ-T1 (silent enum degradation),
REQ-A1 (operator priority).

## Open decisions

- REQ-A1 surface shape: single `agents_run` tool vs per-mode tools (`agents_bg`,
  `agents_chain`). Default: single tool with `mode` enum.
- REQ-J1: whether `anyOf` object/array unions survive Google translation —
  same class of risk as REQ-T1; runtime check lands regardless.
- REQ-O1 upstream venue: pi core PR vs local fork shim.

## Review consensus

| Pass | Reviewer | Verdict |
|---|---|---|
| 1 | reviewer subagent (artifact spot-check) | conditional-go — anchors verified (1 off-by-one fixed), all 11 gaps mapped, REQ-B1/B2 tests tightened to exact-value assertions, parseBgArgs added to REQ-A1 hook points |

### Resolved blockers

| # | Blocker | Resolution |
|---|---|---|
| 1 | tmux send.ts anchor L6 pointed at comment, not the cap check | Re-anchored to send L58-59 + constants.ts L7 |
| 2 | REQ-A1 omitted parseBgArgs (bg mode uncovered in doc) | Added bg-args.ts L9 row |
| 3 | REQ-B1/B2 tests passed on keyword presence (stub-passable) | Tightened to assert exact bound values |

## Amendments

- 2026-09-24 (SCHEMA1 landed, commits 16933b1/076735a): REQ-A1's "`agent`
  (enum from built-ins + registry)" and "`profile` (enum from profile
  library)" are refined to pattern-bounded strings + fail-closed runtime
  resolution with an available-list error. Schemas are static; the registered
  agent set and profile library are per-project and dynamic — an enum would go
  stale silently. Recorded in SCHEMA1_AGENTS_RUN_PLAN.md "Design decision
  resolved up front". Also landed with the slice: `chain` schema allows
  maxItems 8 but the relay runtime enforces its documented MAX_CHAIN_LENGTH
  cap of 3 (runtime strictly finer than schema is the invariant direction;
  `agents_run` denies with the cap named).
