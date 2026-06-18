# P3d-2 Command-Only Chain Mode Plan

## Status

Planning only. Do not implement until this plan, plan review, and adversarial review are accepted.

## Episode Search Summary

Searched episodic memory for:

- `chain mode`, `p3d-2`, `/agents chain`, `preflight`, `handoff`

Key active memories:

- `20260617-151043-canonical-workplan-p3d-1-next-p3f-2-para-48f0`: Canonical workplan with P3d-2 as next after P3d-1 merge.
- `20260618-005840-pr-34-merged-child-agents-can-receive-to-4d82`: PR #34 merged, confirming P3d-1 was already merged.

## Objective

Add a bounded sequential chain command (`/agents chain scout,planner <task>`) that runs multiple child agents in sequence, passing each prior agent's summary as bounded context to the next, with full preflight validation before any child process starts.

## Why

A single agent run is often useful but limited. Common workflows need scout → plan → implement or review → implement. Chain mode lets users compose these into one command without manual handoff between runs, while preserving preflight safety gates and preventing runaway resource usage with a hard maximum chain length.

## Requirements (Ground Truth)

Every requirement SHALL be testable and SHALL map to at least one test or validation check.

| ID | Requirement | Test(s) | Priority | Notes |
|---|---|---|---|---|
| REQ-1 | `/agents chain <agent>,<agent> <task>` SHALL accept comma-separated agent names and a single task string. | `testParseChainArgsValid`, `testParseChainArgsRejectsEmpty`, `testParseChainArgsRejectsSingleAgent`, `testParseChainArgsRejectsEmptyTask`, `testParseChainArgsRejectsExcessLength` | MUST | Uses existing built-in names (scout, planner, reviewer) and registered user/project names. |
| REQ-2 | Chain length SHALL be capped at 3 agents; excess length SHALL be rejected before any child process starts. | `testChainExceedsMaxLengthRejected` | MUST | MAX_CHAIN_LENGTH = 3, as specified in the scaffold plan. |
| REQ-3 | Every agent in the chain SHALL be preflighted through `canRunAgent` before the first child process spawns. If any agent fails preflight, the entire chain SHALL fail with next-step guidance for the failing agent. | `testChainPreflightBlocksAllWhenOneFails`, `testChainPreflightFailsForUnregistered`, `testChainPreflightFailsForProjectUntrusted` | MUST | Per SECURITY_MODEL.md: "preflight every agent through `canRunAgent` before starting any child." |
| REQ-4 | After each child agent completes, its bounded summary text (the `summary.summaryText` field from `ChildAgentRunResult`) SHALL be appended to the next agent's task as handoff context. | `testChainHandoffIncludesPriorSummary`, `testChainAccumulatedHandoffBounded` | MUST | Uses `summary.summaryText` (not full formatted result). Accumulated handoff across all prior agents capped at `MAX_ACCUMULATED_HANDOFF_CHARS` (24000). |
| REQ-5 | If a child agent fails mid-chain, subsequent agents SHALL NOT be spawned. The chain SHALL report which agent failed and why. | `testChainStopsOnMidChainFailure`, `testChainStopsOnMidChainHashMismatch`, `testChainStopsOnMidChainTimeout` | MUST | Fail-closed. Do not continue chain after any failure. Timeout, output-limit, and hash-mismatch failures all count as mid-chain failures. |
| REQ-6 | Chain mode SHALL NOT be available through `run_subagent`; it is command-only. | existing `run_subagent` schema test, `testRunSubagentRejectsChainParam` | MUST | Prevents model-triggered chain fan-out. |
| REQ-7 | Chain execution SHALL reuse `executeChildRun` for each individual agent run to ensure consistent child invocation, gating, and result formatting. | `testChainUsesExecuteChildRun` | MUST | Each step uses the same options forwarding as `/agents run`, including `explicitToolContextLoaderPath`. |
| REQ-8 | Parsed agent names SHALL support both built-in names and registered user/project names, consistent with `/agents run`. | `testChainParsesBuiltInAndRegisteredNames`, `testChainAllBuiltIns`, `testChainCombinesBuiltInAndRegistered` | MUST | No new agent name resolution logic; reuse `resolveRegisteredRunTarget` and `isReservedBuiltInAgentName`. |
| REQ-9 | The chain status output SHALL show per-agent results and overall chain completion/failure. | `testChainOutputFormat` | MUST | Advisory formatting, not a contract schema. |
| REQ-10 | Chain execution SHALL respect existing `AgentsContext` fields including `explicitToolContextLoaderPath`. | `testChainForwardsToolContextLoaderPath` | MUST | Each child run uses the same options as `/agents run` via `executeChildRun`. |
| REQ-11 | Preflight SHALL be all-or-nothing: no child Pi process SHALL be spawned until every agent in the chain has passed `canRunAgent`. | `testChainNoSpawnBeforePreflight` | MUST | Proves zero spawns when any agent fails preflight, and at least one spawn when all pass. |

**Priority legend:**
- **MUST**: Required for the first slice merge. Failing test = blocker.
- **SHOULD**: Required before the feature is considered complete; one slice may defer.
- **MAY**: Nice-to-have, not blocking any merge.

## Non-Goals

Out of scope for this feature:

- Chain mode through `run_subagent` (model-triggered fan-out). This is explicitly forbidden per the scaffold plan.
- Parallel agent execution. Only sequential chains.
- Chain length > 3. Hard cap.
- Pipelining or streaming handoff. Only post-completion summary handoff.
- Chain within a chain (no recursive chain launch).
- Persisting chain state across sessions.
- Chain composition DSL beyond comma-separated names.

## Safety / Security

| Concern | Severity | Mitigation | Test(s) |
|---|---|---|---|
| Model-triggered chain via `run_subagent` | High | `run_subagent` schema has no chain parameter; chain is command-only. | `testRunSubagentRejectsChainParam`, existing schema tests |
| Mid-chain process resource exhaustion | High | Max length 3; each run has existing timeout/output caps from child-runner. | `testChainExceedsMaxLengthRejected` |
| Preflight bypass — one failed agent lets others run | High | Preflight all before first spawn; fail entire chain on any block. | `testChainPreflightBlocksAllWhenOneFails` |
| Failed agent state leaking into next task | Medium | Only bounded summary text is handed off; no raw tool outputs or full agent state. | `testChainHandoffIncludesPriorSummary` |
| Chain using unregistered agent | High | Same `canRunAgent` gate as single runs; preflight resolves each name. | `testChainPreflightFailsForUnregistered` |
| Path/extension leakage through chain options | Medium | Each step calls `executeChildRun` which uses `buildChildRunOptions` with existing source resolution. | `testChainForwardsToolContextLoaderPath` |

## Design

### Key types

```ts
const MAX_CHAIN_LENGTH = 3;
const MAX_ACCUMULATED_HANDOFF_CHARS = 24_000;

type ParsedChainArgs =
  | { ok: true; agents: string[]; task: string }
  | { ok: false; message: string };

type ChainPreflightResult =
  | { ok: true; resolved: Array<{ name: string; source: string; spec: AgentSpec }> }
  | { ok: false; agentName: string; code: string; message: string; nextStep?: string };

type ChainRunOutcome =
  | { ok: true; results: Array<{ agentName: string; status: string; summaryText: string; durationMs: number }> }
  | { ok: false; agentName: string; stage: string; message: string };
```

### Key invariants

- Preflight is all-or-nothing: no child Pi process is spawned until every name resolves and passes `canRunAgent`.
- Chain stops after first failure: if agent N fails, agents N+1..max are not spawned.
- Each agent sees the original task plus a bounded summary of all prior completions.
- Existing child-runner timeout/output caps apply to each child individually.
- `executeChildRun` is reused unmodified; the chain only changes orchestration.

### Resolution / flow

```text
Input: /agents chain scout,planner "Build a plan for X"
  → parseChainArgs → validate length ≤ 3, at least 2 agents
  → preflight: for each agent name
      → isReservedBuiltIn? → use built-in spec
      → else → resolveRegisteredRunTarget → re-read spec bytes → canRunAgent
      → accumulate resolved specs or fail with next-step for first failing agent
  → if preflight fails → notify failure, stop
  → run agent[0] via executeChildRun(agent[0].spec, task)
  → on complete → extract bounded summary → handoffAccumulator += summary
  → run agent[1] via executeChildRun(agent[1].spec, task + "\n\nPrior agent summary:\n" + handoffAccumulator)
  → repeat for agent[2] if present
  → on any failure → stop chain, notify which agent failed
  → notify chain complete
```

## Existing Hook Points

| File | Line(s) | What it does | Impact |
|---|---:|---|---|
| `agents/index.ts` | L57-132 | `/agents` command handler with `parseAgentsArgs` | Add `chain` action and `parseChainArgs`; pass to new orchestrator. |
| `agents/index.ts` | L59 | `getArgumentCompletions` options list | Add `chain`. |
| `agents/index.ts` | L136-141 | `parseAgentsArgs` | Unchanged; chain will parse `<agent>,<agent>` from `parsed.rest` itself. |
| `agents/lib/run-resolver.ts` | L7-12 | `executeChildRun` | Reused as-is for each chain step. |
| `agents/lib/run-resolver.ts` | L32-47 | `buildChildRunOptions` | Already forwards `explicitToolContextLoaderPath`; chain uses it. |
| `agents/lib/run-resolver.ts` | L53-71 | `resolveRegisteredRunTarget` | Used in preflight for registered agents. |
| `agents/lib/specs.ts` | L3 | `isReservedBuiltInAgentName` | Used in preflight for built-in agents. |
| `agents/lib/child-runner.ts` | L120 | `formatChildAgentRunResult` | Used or referenced for extracting bounded summary from completed run. |

## Slice Ladder

Single slice for P3d-2.

| Slice | Objective | Primary files | Key deliverables | Tests | Hard stops |
|---|---|---|---|---|---|
| `P3d-2` | Command-only chain mode | `agents/lib/chain-runner.ts` (new), `agents/index.ts` (completions + dispatch) | `/agents chain`; max length 3; preflight; bounded handoff; failure stops chain | 22 tests across 7 groups | No chain via `run_subagent`; no parallel; no length > 3 |

## Cut Order

If context or scope grows:

1. Registered agent chain support can be deferred to a follow-up (built-in-only chain is still useful).
2. Formatted chain output styling can be simplified.
3. Tool-context-loader forwarding test can be folded into an existing test case.

Do not cut:

- Preflight before first spawn.
- Max length enforcement.
- No chain through `run_subagent`.

## Contracts

### `parseChainArgs(input: string): ParsedChainArgs`

**Input contract:** Raw input string after `/agents chain `, e.g., `scout,planner Build a plan`.

**Output contract:** Discriminated union:
- `{ ok: true, agents: ["scout", "planner"], task: "Build a plan" }`
- `{ ok: false, message: "..." }`

**State table (exhaustive):**

| State | Condition | Output |
|---|---|---|
| A. Valid chain | `<name>,<name>[,...] <task>` with 2-3 agents and non-empty task | `ok: true` |
| B. Empty input | No arguments | `ok: false`, message suggests usage |
| C. Single agent | Only one agent name, no comma | `ok: false`, message suggests `/agents run` for single |
| D. Excess length | More than 3 agent names | `ok: false`, message states max chain length |
| E. Missing task | Agent names present but no task text after | `ok: false`, message requires task |
| F. Whitespace in agent names | Names may be trimmed but no embedded spaces | Trimmed; invalid chars rejected |

### `runChainCommand(agents: string[], task: string, ctx: AgentsContextLike, diagnostics: AgentDiagnostics): Promise<void>`

**Input contract:**
- `agents`: 2-3 validated agent names (built-in or registered).
- `task`: Non-empty task string.
- `ctx`: Agents context with `cwd`, `ui`, `agentsChildRunner`, `agentsPiCommand`, `explicitToolContextLoaderPath`.
- `diagnostics`: Fresh agent diagnostics for registered agent resolution.

**Output contract:** Notifies via `ctx.ui.notify`; no return value for command handlers.

**State table (exhaustive):**

| State | Condition | Output |
|---|---|---|
| A. All preflight passes | All agent names resolve and pass `canRunAgent` | Proceed to spawn step 1. |
| B. Preflight partially fails | Any agent is unregistered, invalid, dangerous, project-untrusted, or ambiguous | Notify failure for first failing agent with next-step; no spawn. |
| C. Step N completes | Agent N child finishes successfully | Extract bounded summary, accumulate, pass to step N+1. |
| D. Step N fails | Agent N child returns error, times out, or exceeds limits | Notify chain failure; stop; no further spawns. |
| E. Final step completes | All agents in chain finished successfully | Notify chain complete with per-agent results. |

**Error codes:**

| Code | Field | Trigger |
|---|---|---|
| `agent-not-found` | Resolve step | Registered agent not found in diagnostics records. |
| `ambiguous-name` | Resolve step | Multiple records match the same agent name. |
| `project-untrusted` | canRunAgent | Project trust inactive for a project agent. |
| `project-registry-root-mismatch` | canRunAgent | Project registry root does not match current project root. |
| `dangerous` | canRunAgent | Current spec bytes classified as dangerous by scanner. |
| `invalid` | canRunAgent | Current spec fails validation. |
| `missing-spec` | Re-read step | Spec file cannot be re-read before spawn. |
| `timeout` | Child execution | Child run exceeded its timeout limit. |
| `limit-exceeded` | Child execution | Child run exceeded its output limit. |
| `hash-mismatch` | Child execution | Registered agent's spec hash changed after preflight (caught by `executeChildRun` re-read). |
| `spawn-error` | Child execution | Child process spawn or execution failed. |

## Edge Cases

| # | Scenario | Expected behavior | Test |
|---|---|---|---|
| EC1 | Chain with one built-in and one registered agent | Both resolve via correct resolution path; preflight passes only if registered agent passes gate. | `testChainCombinesBuiltInAndRegistered` |
| EC2 | Registered agent hash mismatch after preflight but before spawn | The existing re-read in `executeChildRun` for registered agents catches this; that single step fails, chain stops. | `testChainStopsOnMidChainHashMismatch` |
| EC3 | All three agents are built-ins | All preflight via `isReservedBuiltInAgentName`; no registry lookup needed. | `testChainAllBuiltIns` |
| EC4 | Task text is multiline | Task is passed as-is to each agent; handoff context appended. | `testChainMultilineTask` |
| EC5 | Chain with comma-only agent list and no task | Rejected by parser; 'Usage' message shown. | `testParseChainArgsRejectsEmptyTask` |
| EC6 | Agent name is duplicated in chain | Preflight succeeds for both; runs sequentially with the same spec. Not blocked at chain level. | Acceptable — no special dedupe required. |
| EC7 | Mid-chain timeout cutoff | The child-runner timeout applies per agent; if agent 2 times out, agent 3 is not spawned. | `testChainStopsOnMidChainTimeout` |

## Test Case Catalog

Grouped by concern. Every test name here appears in the Requirements table.

```text
Group 1: Argument parsing (5 tests)
  testParseChainArgsValid
  testParseChainArgsRejectsEmpty
  testParseChainArgsRejectsSingleAgent
  testParseChainArgsRejectsEmptyTask
  testParseChainArgsRejectsExcessLength

Group 2: Chain length and validation (1 test)
  testChainExceedsMaxLengthRejected

Group 3: Preflight (4 tests)
  testChainPreflightBlocksAllWhenOneFails
  testChainPreflightFailsForUnregistered
  testChainPreflightFailsForProjectUntrusted
  testChainNoSpawnBeforePreflight

Group 4: Execution (8 tests)
  testChainHandoffIncludesPriorSummary
  testChainAccumulatedHandoffBounded
  testChainStopsOnMidChainFailure
  testChainStopsOnMidChainHashMismatch
  testChainStopsOnMidChainTimeout
  testChainAllBuiltIns
  testChainCombinesBuiltInAndRegistered
  testChainParsesBuiltInAndRegisteredNames
  testChainMultilineTask

Group 5: Consistency and forwarding (2 tests)
  testChainForwardsToolContextLoaderPath
  testChainUsesExecuteChildRun

Group 6: Output format (1 test)
  testChainOutputFormat

Group 7: Exclusion (1 test)
  testRunSubagentRejectsChainParam
```

Total: 22 tests.

## Risk Analysis

| Risk | Severity | Mitigation |
|---|---|---|
| Registered agent re-read gap during preflight | Medium | Preflight uses `resolveRegisteredRunTarget` which re-reads spec bytes and runs `canRunAgent`. The actual spawn also re-reads in `executeChildRun`. TOCTOU window exists between preflight and spawn but is identical to the single-run case. |
| Chain summary accumulation exceeds token budget for later agents | Low | Handoff uses raw `summary.summaryText` (not formatted result). Accumulated handoff is capped at `MAX_ACCUMULATED_HANDOFF_CHARS` (24000). |
| User expects chain to work with ephemeral agents | None | Ephemeral agents are not named/registered; chain only accepts built-in or registered names. Documented as non-goal. |
| Merge conflict with P3f-2 if both touch index.ts | Low | P3f-2 touches profiles command routing; P3d-2 adds chain command routing. Different actions in the same handler, trivial merge conflict. |
| Cross-chain prompt injection from prior agent output | Medium | Accepted as inherent to sequential handoff. Handoff uses bounded `summary.summaryText` only, not raw tool outputs. Each child agent's built-in prompt already includes the advisory-guidance subordination notice from `COMMON_PROMPT`. |

## Open Decisions

| Decision | Deferral slice | Rationale |
|---|---|---|
| Chain output format style | P3d-2 implementation | Should be informative but not a verbose table unless required by review feedback. |
| Whether to surface chain progress as it runs (per-step notification) | P3d-2 implementation | Notify after each step for long chains; acceptable to notify only at end for simplicity. |

## Done Criteria

All MUST requirements passing = done for P3d-2.

Additional completion checks:

- [ ] Plan review accepted.
- [ ] Adversarial implementation review accepted with no unresolved blockers.
- [ ] `/agents chain scout,planner <task>` accepts `planner,reviewer` and `scout,planner,reviewer`.
- [ ] Chain preflight fails on unregistered/project-untrusted/dangerous agents.
- [ ] Mid-chain failure stops subsequent agents.
- [ ] Handoff includes prior summary text.
- [ ] Existing P3d/P3c/P3b agent tests still pass.
- [ ] `/agents` completions include `chain`.
- [ ] Usage message includes chain.

## Review Consensus

| Pass | Reviewer | Model | Blocker count | Verdict |
|---|---|---:|---:|---|
| 1 | Built-in review agent (`/agents run reviewer`) | `openrouter/anthropic/claude-opus-4-8` | 5 (resolved) | request-changes → go after fixes |
| 2 | Pending adversarial/implementation reviewer | Pending | Pending | Pending |

### Resolved blockers

| # | Blocker | Resolution |
|---|---|---|
| 1 | REQ-9 test not in catalog | Added `testChainOutputFormat` to Group 6. |
| 2 | REQ-8 test not in catalog | Added `testChainParsesBuiltInAndRegisteredNames` to Group 4. |
| 3 | REQ-1 `testParseChainArgsRejectsExcessLength` not in catalog | Added to Group 1. |
| 4 | Edge-case tests EC2/EC7 not catalogued | Added `testChainStopsOnMidChainHashMismatch` and `testChainStopsOnMidChainTimeout` to Group 4. |
| 5 | No spawning-order assertion | Added REQ-11 and `testChainNoSpawnBeforePreflight`. |
| 6 | No accumulated-handoff bound test | Added `testChainAccumulatedHandoffBounded`. |
| 7 | No error codes table | Added error codes to Contracts. |
| 8 | Handoff source ambiguous | REQ-4 now specifies `summary.summaryText`. |
| 9 | Slice ladder ambiguous | Resolved to `agents/lib/chain-runner.ts`. |
| 10 | Cross-chain prompt injection not in Safety table | Added as accepted risk with mitigation. |
| 11 | Test count wrong; B1/B2 reverse-mapping violation | Fixed Group 4 count (9), total (22). Mapped EC2/EC7 tests to REQ-5, EC4 to REQ-1. |
| 12 | Missing error codes for timeout/limit/hash-mismatch | Added `timeout`, `limit-exceeded`, `hash-mismatch` to error codes. |
| 13 | ChainRunOutcome failure variant lacks `code` field | Added `code: string` to failure variant. |
| 14 | REQ-4 handoff source contradicts Risk Analysis/Appendix | REQ-4 now specifies `summary.summaryText` vs `formatChildAgentRunResult`. Added `MAX_ACCUMULATED_HANDOFF_CHARS = 24000`. |

## Appendix: Implementation Plan

Concrete file-level implementation plan.

### Files to create

1. `agents/lib/chain-runner.ts` — Chain argument parser, preflight orchestrator, chain execution.
2. `agents/test-fixtures/test-chain.mjs` — Chain tests covering parsing, preflight, execution, and forwarding.
3. `agents/test-fixtures/run-p3d-2-tests.sh` — Aggregate test runner.
4. `agents/P3D2_CHAIN_MODE_PLAN_REVIEW.md` — Plan review record after review.
5. `agents/P3D2_CHAIN_MODE_IMPLEMENTATION_REVIEW.md` — Implementation review record after review.

### Files to modify

| File | Change |
|---|---|
| `agents/index.ts` | Add `chain` to argument completions; add chain action dispatch in command handler; import and call chain orchestrator. |
| `agents/index.ts` | Update usage message to include chain. |

### Implementation sequence

| Step | Action | Validation |
|---:|---|---|
| 1 | Add failing tests for chain argument parsing. | `npx --yes tsx agents/test-fixtures/test-chain.mjs` |
| 2 | Implement `parseChainArgs` in `agents/lib/chain-runner.ts`. | Parsing tests pass. |
| 3 | Add failing tests for chain preflight and execution. | Run targeted test; confirm failure before implementation. |
| 4 | Implement preflight orchestrator. | Preflight tests pass. |
| 5 | Implement chain execution loop using `executeChildRun`. | Execution tests pass. |
| 6 | Wire `/agents chain` into `agents/index.ts`. | Integration tests pass. |
| 7 | Run aggregate agents tests. | `./agents/test-fixtures/run-p3d-2-tests.sh`; `./agents/test-fixtures/run-p3d-1-tests.sh`; `./agents/test-fixtures/run-p3c-3-tests.sh`. |
| 8 | Create PR, plan review, implementation review. | Review docs. |

### Risks

| Risk | Mitigation |
|---|---|
| `executeChildRun` not exported or not usable for chain | It is exported from `run-resolver.ts` and P3G wired it with `buildChildRunOptions`. It accepts `AgentsContextLike` which chain can supply. |
| Preflight needs diagnostics that aren't available in chain context | Diagnostics are already collected in the `/agents` command handler and passed to run commands; chain will receive them the same way. |
| Handoff summary format needs access to internal `formatChildAgentRunResult` | Exported function, simple to call from chain runner. |
