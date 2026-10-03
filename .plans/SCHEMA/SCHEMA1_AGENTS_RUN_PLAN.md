# SCHEMA1 agents_run Tool + run_subagent Schema Polish Plan

## Status

Planning only. Do not implement until this plan, plan review, and adversarial
review are accepted. Parent: `.plans/SCHEMA/WORKPLAN.md` slice SCHEMA-1
(REQ-A1, REQ-A2). Operator priority: agents first.

## Episode Search Summary

Searched episodic memory (`em-search.mjs "agents run tool schema bounded"`):
no episodes on tool-schema bounding for this repo. Closest active memories are
multi-agent orchestration playbooks (not schema work) and permission-policy
build history (unrelated surface). This plan is the first artifact in this
thread.

## Objective

Give the agents extension a single schema-bounded LLM tool (`agents_run`) that
covers the three delegation modes the LLM currently can only reach through
free-string slash commands (`/agents run`, `/agents bg`, `/agents chain`), and
mirror run_subagent's existing runtime input bounds into its declared schema.

## Why

The audit (session 2026-09-24, jev-validated) found five agents slash surfaces
with zero schema: out-of-contract input fails late with UI warnings instead of
schema rejection. `run_subagent` already proves the pattern (required fields +
runtime gate) but omits profile/timeout/review-target/bg/chain, and its schema
doesn't declare the bounds its own runtime enforces.

## Design decision resolved up front (amends WORKPLAN REQ-A1)

**`agent` and `profile` are NOT schema enums.** Schemas are static; the
registered-agent set and profile library are per-project and dynamic. An enum
would go stale silently. Instead: `pattern`-bounded strings (same regex family
as run_subagent) + fail-closed runtime resolution that errors with the
available list. This refines WORKPLAN REQ-A1's "enum from built-ins + registry"
— recorded here per AGENTS.md rule 5; WORKPLAN gets an Amendments note when
this slice lands.

## Requirements (Ground Truth)

| ID | Requirement | Test(s) | Priority | Notes |
|---|---|---|---|---|
| REQ-1 | `agents_run` tool registered with parameters: `mode` StringEnum(["run","bg","chain"]) default "run"; `agent` required string `pattern: "^[A-Za-z][A-Za-z0-9._-]{0,127}$"`; `task` required string `maxLength: 8000`; `timeout_s` optional Integer `minimum: 1, maximum: 3600`; `profile` optional string (same pattern); `backend` optional string (same pattern); `base` optional string `pattern: "^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$"`; `range` optional string `pattern: "^[A-Za-z0-9][A-Za-z0-9._/-]{2,}\\.{2}[A-Za-z0-9][A-Za-z0-9._/-]{2,}$"`; `chain` optional array of agent-pattern strings minItems 2 maxItems 8 | `schemaDeclaresAllBounds` | MUST | mirrors parseLeadingRunFlags 1..3600; base/range patterns are prefilters — isSafeGitRef stays the boundary |
| REQ-2 | `validateAgentsRunInput` rejects: empty/unsafe agent, empty/whitespace task, C0 control chars in task, task > 8000 chars, timeout outside 1..3600, chain < 2 or > 8 entries, base/range failing their patterns | `validateRejectsEachBadInput` (negative control per field) | MUST | pure function, no pi API |
| REQ-3 | Exec layer: mode "run" routes built-ins (`RESERVED_BUILT_IN_AGENT_NAMES`) to `dispatchChildRun` and registered names via `resolveRegisteredRunTarget` + `runResolvedTarget`; unknown agent → deny outcome listing available agents | `runRoutesBuiltInAndRegistered`, `unknownAgentDeniesWithList` | MUST | reuses exported run-resolver functions |
| REQ-4 | Exec layer: mode "bg" resolves `backend` via `getBgTerminalBackendByName` (unknown → deny listing registered backends) and routes REGISTERED agents only through the bg preflight path — built-in + bg → deny `invalid-input` "bg mode supports registered agents only" (parity: `resolveRegisteredRunTarget` L165 filters `source !== "built-in"`, so `/agents bg scout` denies today too); mode "chain" routes via chain-runner with ≥2 agents | `bgUnknownBackendDeniesWithList`, `bgBuiltInDenies`, `chainRoutesToRunner` | MUST | DI seams: injected executor fakes |
| REQ-5 | Fail-closed: no session context captured → deny outcome (pattern from subagent-tool.ts `notReadyOutcome`) | `noSessionContextDenies` | MUST | wiring test, mock ExtensionAPI |
| REQ-6 | `run_subagent` emitted schema declares `pattern` on `agent` and `maxLength: 8000` on `task` | `subagentSchemaDeclaresBounds` (asserts exact values) | MUST | REQ-A2 |
| REQ-7 | README.md tool catalogue + docs/USER_MANUAL.md mention `agents_run` | `manual: grep agents_run README.md docs/USER_MANUAL.md` | SHOULD | doc row |

**Priority legend:** MUST = blocker for slice merge; SHOULD = before complete.

## Non-Goals

- `/agents run-temp` conversion — ephemeral save/keep is an interactive human
  workflow; the LLM reaches the same child execution via mode "run" with a
  built-in name.
- Output schemas (parent REQ-O1/O2) — harness prerequisite, separate slice.
- Changing any runtime behavior of existing paths — this slice only adds a
  schema-bounded front door that reuses them.
- Slash commands remain for humans; `agents_run` is the LLM surface.

## Safety / Security

| Concern | Severity | Mitigation | Test(s) |
|---|---|---|---|
| bg mode launches persistent processes | Medium | Same gates as `/agents bg`: preflight manifest + reservation (`preflightBgAgent`), backend allowlist, trust checks — reused, not reimplemented | `bgRoutesThroughPreflight` (asserts preflight called with sentinel task) |
| git-ref injection via base/range | Medium | Schema pattern prefilter + existing `isSafeGitRef` boundary unchanged | `validateRejectsEachBadInput` ref rows |
| recursive delegation | Low | Child tools unchanged (run_subagent already non-recursive); agents_run adds no new child capability | existing child-args tests |
| schema-stale enum drift | Low | resolved: no dynamic enums (see Design decision) | `schemaDeclaresAllBounds` asserts pattern, not enum |

## Design

### Key types

```ts
export type AgentsRunMode = "run" | "bg" | "chain";

export type AgentsRunParams = {
  mode?: AgentsRunMode;
  agent: string;
  task: string;
  timeout_s?: number;
  profile?: string;
  backend?: string;
  base?: string;
  range?: string;
  chain?: string[];
};
```

### Key invariants

- Schema bounds are a strict subset of runtime checks — runtime remains the
  security boundary (registry gate, isSafeGitRef, preflight trust).
- No dynamic enums in schemas, ever (recorded lesson; supersedes WORKPLAN wording).
- One tool, one file, registered beside run_subagent; zero changes to
  run-resolver/bg/chain internals.

### Resolution / flow

```text
agents_run(params) → validateAgentsRunInput (pure)
  → mode run:  built-in? → dispatchChildRun
               else      → resolveRegisteredRunTarget → runResolvedTarget
  → mode bg:   getBgTerminalBackendByName → preflightBgAgent → backend launch
  → mode chain: validate chain array → chain-runner
  → deny outcome (ok:false, code, list) on every resolution failure
```

## Existing Hook Points

| File | Line(s) | What it does | Impact |
|---|---|---|---|
| `agents/lib/subagent-tool.ts` | L231-252 | run_subagent schema (raw JSON schema object) | REQ-6 adds pattern/maxLength inline |
| `agents/lib/subagent-tool.ts` | L48-74 | validateSubagentInput pattern to copy | REQ-2 modeled on it |
| `agents/lib/run-resolver.ts` | L264-283 | runAgentCommand routing (built-in vs registered) | REQ-3 calls the same exported functions |
| `agents/index.ts` | L174 | `registerSubagentTool(pi, () => sessionAgentsCtx);` | new registration line beside it |
| `agents/lib/specs.ts` | L6 | `RESERVED_BUILT_IN_AGENT_NAMES` | built-in routing check |

## Slice Ladder

| Slice | Objective | Primary files | Tests | Hard stops |
|---|---|---|---|---|
| SCHEMA1-A | pure validation + schema builder | `agents/lib/agents-run-tool.ts` (CREATE), tests + runner (CREATE) | REQ-1/2 | none touch pi API |
| SCHEMA1-B | registration + exec wiring | `agents/index.ts` (one line), agents-run-tool.ts (APPEND execute), wiring test (CREATE) | REQ-3/4/5 | mock-API harness required (AGENTS.md rule 4) |
| SCHEMA1-C | run_subagent schema polish | `agents/lib/subagent-tool.ts` (EDIT 2 properties) | REQ-6 | zero behavior change |
| SCHEMA1-D | docs | README.md, docs/USER_MANUAL.md, WORKPLAN amendment | grep smokes | none |

### Dependency graph

```text
SCHEMA1-A ── SCHEMA1-B ── SCHEMA1-D
     └───── SCHEMA1-C ──┘
```

## Cut Order

1. SCHEMA1-D docs (defer to landing commit).
2. `chain` mode (REQ-4 second half) if scope grows — tool ships with run+bg
   first, chain follows.

Do not cut: REQ-1/2 (the schema is the point), REQ-5 (fail-closed wiring),
REQ-6 (trivial, blocks nothing).

## Contracts

### `validateAgentsRunInput(raw: unknown): ValidatedAgentsRun | { ok: false; reason: string }`

**State table (exhaustive):**

| State | Condition | Output |
|---|---|---|
| A. ok | all patterns/bounds satisfied | `{ ok: true, mode, agent, task, timeout_s?, profile?, backend?, base?, range?, chain? }` |
| B. bad agent | fails agent pattern or empty | `{ ok:false, reason: "agent must be a safe identifier" }` |
| C. bad task | empty/whitespace, >8000, or C0 control chars | reason names which violation |
| D. bad timeout | not integer 1..3600 | `reason: "timeout_s must be an integer 1..3600"` |
| E. bad chain | <2 or >8 entries or entry fails agent pattern | `reason: "chain requires 2..8 safe agent names"` |
| F. bad ref | base/range fails its pattern | `reason: "invalid git ref: <field>"` |
| G. bad mode | not run/bg/chain (runtime re-check) | `reason: "mode must be run|bg|chain"` |
| H. type confusion | any field not its declared JS type (agent/task/profile/backend/base/range not string; timeout_s not integer; chain not array of strings) — explicit `typeof` rejects, mirroring validateSubagentInput's checks; NEVER regex-test a coerced value | `reason: "<field> must be a <type>"` |

**Deny codes:** `not-ready`, `unknown-agent`, `unknown-backend`,
`profile-unavailable`, `spawn-error`, `invalid-input`.

## Edge Cases

| # | Scenario | Expected behavior | Test |
|---|---|---|---|
| EC1 | `agent: "--flag"` | pattern reject | `validateRejectsEachBadInput` |
| EC2 | `timeout_s: 3601` | schema reject; direct runtime reject | `validateRejectsEachBadInput` |
| EC3 | mode bg, backend "tmux" not registered | deny + registered list | `bgUnknownBackendDeniesWithList` |
| EC4 | session ctx missing | deny `not-ready` | `noSessionContextDenies` |
| EC5 | built-in "scout" as agent | routes dispatchChildRun, no registry lookup | `runRoutesBuiltInAndRegistered` |
| EC6 | chain ["scout"] (1 entry) | reject state E | `validateRejectsEachBadInput` |
| EC7 | task with `\x00` | control-char reject | `validateRejectsEachBadInput` |
| EC8 | `{agent: 12345}` | state H type reject (no regex on coerced "12345") | `validateRejectsEachBadInput` |
| EC9 | `{task: {nested: "x"}}` | state H type reject | `validateRejectsEachBadInput` |
| EC10 | mode bg + agent "scout" | deny `invalid-input` registered-only (REQ-4 parity) | `bgBuiltInDenies` |

## Test Case Catalog

```text
Group 1: schema declaration (1)
  schemaDeclaresAllBounds
Group 2: validation negatives (1, EC-driven)
  validateRejectsEachBadInput
Group 3: routing (2)
  runRoutesBuiltInAndRegistered
  unknownAgentDeniesWithList
Group 4: bg/chain (2)
  bgUnknownBackendDeniesWithList
  chainRoutesToRunner
Group 5: wiring fail-closed (1)
  noSessionContextDenies
Group 6: REQ-6 (1)
  subagentSchemaDeclaresBounds
Group 7: preflight sentinel (1)
  bgRoutesThroughPreflight
```

Total: 9 tests. Every MUST REQ maps to ≥1 test.

## Risk Analysis

| Risk | Severity | Mitigation |
|---|---|---|
| bg wiring replicates handleBgCommand logic and drifts | Medium | slice B calls the same exported functions; wiring test asserts preflight invoked with sentinel |
| TypeBox/pattern Google-API incompatibility (string-enum.ts lesson) | Medium | patterns are on plain strings (the documented breakage was string enums); REQ-1 test asserts emitted schema retains pattern keywords |
| two doors (slash + tool) diverge over time | Low | tool is a thin router; drift caught by routing tests |

## Open Decisions

- `/agents do` semantics (auto-agent selection): 4th mode or human-only?
  Default: human-only (run_subagent covers the LLM need). Revisit post B.
- Chain mode in first ship vs follow-up (see Cut Order 2).

## Done Criteria

All MUST requirements passing = done, plus `bash agents/test/run-agents-run-tests.sh`
green from a clean checkout and `grep -c "agents_run" README.md` ≥ 1 after D.

## Review Consensus

| Pass | Reviewer | Model | Blocker count | Verdict |
|---|---|---|---|---|
| 1 | reviewer subagent | litellm/minimax | 0 | conditional-go — anchors verified byte-exact; C.1 verify grep fixed to `grep -F` |
| 2 | adversarial subagent | litellm/minimax | 3 | no-go → resolved: bg/built-in parity deny (REQ-4 + EC10; reviewer's claim that /agents bg scout works today was wrong — resolveRegisteredRunTarget L165 denies it), type-confusion state H + EC8/9, signal+timeout threading in B.1 |

### Resolved blockers

| # | Blocker | Resolution |
|---|---|---|
| 1 | mode:bg + built-in agent undefined (no preflight path exists) | REQ-4: registered-only in bg mode, explicit deny `invalid-input` — parity with today's /agents bg; EC10 test |
| 2 | type confusion (regex on coerced values) | Contract state H: explicit typeof rejects; EC8/EC9 |
| 3 | abort/timeout wiring missing from B.1 stub | B.1 amended: AbortSignal threaded (deny `aborted`); timeout_s → timeoutMs (run) / maxDurationSec (bg); wiring asserts sentinel |
| 4 | REQ-6 test passes on schema-only stub | noted: schema test is schema-scoped by design; runtime bounds already covered by existing test-fixtures/test-subagent-tool.mjs — B.3 runs the existing suite as regression guard |

## Appendix: Implementation Plan

### Files to create

1. `agents/lib/agents-run-tool.ts` — validation + schema builder + registration
2. `agents/test/test-agents-run-tool.mjs` — groups 1,2,3,6
3. `agents/test/test-agents-run-wiring.mjs` — groups 4,5,7 (mock ExtensionAPI)
4. `agents/test/run-agents-run-tests.sh` — runs both, red-then-green control

### Files to modify

| File | Change |
|---|---|
| `agents/index.ts` | registration line beside L174 + import |
| `agents/lib/subagent-tool.ts` | agent gains `pattern`, task gains `maxLength: 8000` |
| `README.md`, `docs/USER_MANUAL.md` | catalogue rows (SCHEMA1-D) |
| `.plans/SCHEMA/WORKPLAN.md` | Amendments: enum→pattern+runtime-gate refinement |

### Implementation sequence

| Step | Action | Validation |
|---|---|---|
| A1 | CREATE agents-run-tool.ts (types + validate + builder, stub deny execute) | node --test groups 1,2 |
| A2 | CREATE tests + runner; BREAK_VALIDATE=1 negative control | green; broken run non-zero |
| B1 | APPEND registerAgentsRunTool with DI seams | import succeeds |
| B2 | EDIT index.ts registration (anchor L174 line) | grep |
| B3 | CREATE wiring test (mock ExtensionAPI, sentinel through preflight fake) | green incl. negative |
| C1 | EDIT subagent-tool.ts agent/task properties | group 6 exact-value asserts |
| D1 | docs + WORKPLAN amendment | grep smokes |

## Appendix B: Mechanical Execution Spec

Executor contract per PLAN_TEMPLATE.md verbatim. Slices A and C are
executor-ready below; slice B carries verbatim anchors for its EDIT step, with
the wiring-test bodies authored at B kickoff against the
`smart-compaction/test/wiring.test.ts` harness shape (AGENTS.md rule 4) — the
one intentionally deferred detail, flagged **focused review before build**.

### Shared constants

```ts
export const AGENTS_RUN_AGENT_RE = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
export const AGENTS_RUN_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
export const AGENTS_RUN_RANGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{2,}\.\.[A-Za-z0-9][A-Za-z0-9._/-]{2,}$/;
export const AGENTS_RUN_TIMEOUT_MIN_S = 1;
export const AGENTS_RUN_TIMEOUT_MAX_S = 3600;
export const AGENTS_RUN_TASK_MAX_CHARS = 8_000;
export const AGENTS_RUN_CHAIN_MIN = 2;
export const AGENTS_RUN_CHAIN_MAX = 8;
```

(Control-char set replicated from subagent-tool.ts semantics to keep slice A
zero-dependency: `/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/`.)

### SCHEMA1-A — validation + schema (REQ-1, REQ-2)

| Step | File | Exact action | Verify |
|---|---|---|---|
| A.1 | `agents/lib/agents-run-tool.ts` | **CREATE** (Write): header comment, shared constants above, `AgentsRunMode`/`AgentsRunParams`/`ValidatedAgentsRun` types, `validateAgentsRunInput(raw: unknown)` implementing states A-G with the table's exact reason strings | `grep -c "export function validateAgentsRunInput" agents/lib/agents-run-tool.ts` → 1 |
| A.2 | same file | **APPEND** `buildAgentsRunToolDefinition()` returning name `agents_run`, description "Delegate to built-in or registered agents via run/bg/chain modes with schema-bounded inputs", promptSnippet, promptGuidelines, and the `parameters` object exactly as REQ-1 specifies (all patterns/bounds verbatim, `additionalProperties:false`, `required:["agent","task"]`) | `node -e 'import("./agents/lib/agents-run-tool.ts").then(m=>{const s=m.buildAgentsRunToolDefinition().parameters; if(s.properties.agent.pattern!=="^[A-Za-z][A-Za-z0-9._-]{0,127}$")process.exit(1); if(s.properties.task.maxLength!==8000)process.exit(2); if(s.properties.timeout_s.maximum!==3600)process.exit(3); if(s.properties.chain.maxItems!==8)process.exit(4); console.log("ok")})'` → ok |
| A.3 | `agents/test/test-agents-run-tool.mjs` | **CREATE**: imports the real module; group 1 asserts every REQ-1 bound by exact value; group 2 drives each contract state B-G with the EC inputs and asserts the exact reason strings | `node --test agents/test/test-agents-run-tool.mjs` → exit 0 |
| A.4 | `agents/test/run-agents-run-tests.sh` | **CREATE**: `node --test agents/test/test-agents-run-tool.mjs`, then `BREAK_VALIDATE=1 node --test agents/test/test-agents-run-tool.mjs; test $? -ne 0` (test file flips one assertion expectation under BREAK_VALIDATE so a validation that wrongly passes goes red) | `bash agents/test/run-agents-run-tests.sh; test $? -eq 0` |

### SCHEMA1-C — run_subagent polish (REQ-6)

| Step | File | Exact action | Verify |
|---|---|---|---|
| C.1 | `agents/lib/subagent-tool.ts` | **EDIT** anchored. `ANCHOR:` `				agent: { type: "string", description: "Built-in agent name (scout, planner, reviewer) or a registered user/project agent name." },` → `REPLACE:` same line with `pattern: "^[A-Za-z][A-Za-z0-9._-]{0,127}$", ` inserted after `type: "string", ` | `grep -cF 'pattern: "^[A-Za-z]' agents/lib/subagent-tool.ts` → 1 |
| C.2 | same file | **EDIT** anchored. `ANCHOR:` `				task: { type: "string", description: "Delegated task for the subagent. Bounded, read-only scope only." },` → `REPLACE:` same line with `maxLength: 8000, ` after `type: "string", ` | `grep -c "maxLength: 8000" agents/lib/subagent-tool.ts` → 1 |
| C.3 | `agents/test/test-agents-run-tool.mjs` | **APPEND** `subagentSchemaDeclaresBounds`: imports `buildSubagentToolDefinition`, asserts `properties.agent.pattern === "^[A-Za-z][A-Za-z0-9._-]{0,127}$"` and `properties.task.maxLength === 8000` | `node --test agents/test/test-agents-run-tool.mjs` → 0, +1 test |

### SCHEMA1-B — registration + wiring (REQ-3/4/5) — focused review before build

B.1 **APPEND** `registerAgentsRunTool(pi, sessionCtxRef)` with injectable
seams (`childRunner`, `bgPreflight`, `chainRunner`) to agents-run-tool.ts.
**Signal + timeout threading (adversarial pass 2):** execute passes its
AbortSignal into the child runner (abort → deny code `aborted`); `timeout_s`
threads as `timeoutMs = timeout_s * 1000` into `executeChildRun` (run mode)
and maps to the bg preflight's `maxDurationSec` in bg mode. Wiring tests
assert the sentinel timeout value arrives at the injected fake.
B.2 **EDIT** `agents/index.ts`, `ANCHOR:` `	registerSubagentTool(pi, () => sessionAgentsCtx);`
→ `REPLACE:` that line + `	registerAgentsRunTool(pi, () => sessionAgentsCtx);`
B.3 **CREATE** wiring test per groups 4,5,7 with mock ExtensionAPI and
sentinel task (`bgRoutesThroughPreflight` asserts the preflight fake received
exactly the sentinel string).

## Definition of done (whole plan)

`bash agents/test/run-agents-run-tests.sh` green (incl. negative control),
`node --test agents/test/test-agents-run-wiring.mjs` green, and
`grep -c "maxLength: 8000" agents/lib/subagent-tool.ts` ≥ 1.
