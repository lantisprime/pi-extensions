# P3G Child Tool-Context-Loader JIT Plan

## Status

Implemented locally after plan review fallback returned conditional-go with zero blockers. Do not merge until final implementation review/adversarial review are accepted.

This plan is intentionally file-level and test-mapped. It converts the lightweight planner note stored in episodic memory into the formal `agents/PLAN_TEMPLATE.md` format.

## Episode Search Summary

Searched episodic memory for:

- `tool-context-loader child Pi subagents extensions JIT runbooks explicitToolContextLoaderPath`
- `PR #32 native tools JIT runbooks`
- `canonical-workplan`

Key active memories:

- `20260618-001151-child-agent-jit-runbook-plan`: Initial planner note for wiring tool-context-loader JIT runbooks into child/subagent Pi processes.
- `20260618-002105-pr-32-merged-tool-context-loader-jit-run-5eee`: PR #32 merged; tool-context-loader JIT runbooks now support native/custom Pi tools.
- `20260614-095159-child-pi-json-subprocesses-inherit-globa-1860`: Prior decision/finding about child Pi JSON subprocess extension inheritance and tool-context-loader relevance.
- `20260617-151043-canonical-workplan-p3d-1-next-p3f-2-para-48f0`: Current canonical workplan: P3d-1 next, P3f-2 parallel; P3c4 and P3f-1 merged.

## Objective

Enable child Pi processes launched by the agents extension to receive tool-context-loader JIT runbook context when they use matching tools. Do this without enabling broad extension discovery, without weakening child agent authority boundaries, and without allowing model-controlled inputs to choose extension paths.

The first slice wires an already-supported `explicitToolContextLoaderPath` option through `/agents run`, `run_subagent`, and, if accepted, `/agents run-temp`. The resulting child argv should keep `--no-extensions` while also including `-e <trusted tool-context-loader path>`.

## Why

Parent-session JIT runbooks now work for native/custom Pi tools after PR #32. Child/subagent Pi models still do not reliably receive those runbooks because child invocations disable extension discovery with `--no-extensions` and current runner paths do not forward the explicit loader path supported by `agents/lib/child-args.ts`.

Wiring the trusted loader path lets smaller child context windows benefit from the same local procedural guidance as the parent session while preserving the existing no-broad-discovery safety posture.

## Requirements (Ground Truth)

Every requirement SHALL be testable and SHALL map to at least one test or validation check.

| ID | Requirement | Test(s) | Priority | Notes |
|---|---|---|---|---|
| REQ-1 | `/agents run <built-in> <task>` SHALL forward a trusted `explicitToolContextLoaderPath` to child invocation options when the path is present in session context. | `testRunBuiltInForwardsToolContextLoaderPath` | MUST | Covers `runBuiltInChildAgent` path via `executeChildRun`. |
| REQ-2 | `/agents run <registered> <task>` SHALL forward the same trusted `explicitToolContextLoaderPath` to registered child invocation options after the existing freshness and `canRunAgent` gate pass. | `testRunRegisteredForwardsToolContextLoaderPath` | MUST | Must not bypass re-read/hash/gate logic. |
| REQ-3 | `run_subagent` built-in execution SHALL forward the trusted `explicitToolContextLoaderPath` to child invocation options. | `testRunSubagentBuiltInForwardsToolContextLoaderPath` | MUST | Covers built-in branch in `executeSubagentRun`. |
| REQ-4 | `run_subagent` registered execution SHALL forward the trusted `explicitToolContextLoaderPath` after current registration/freshness/gate checks pass. | `testRunSubagentRegisteredForwardsToolContextLoaderPath` | MUST | Must preserve denial behavior for unregistered/invalid/project-untrusted specs. |
| REQ-5 | Child argv construction SHALL keep `--no-extensions` while also including `-e <explicitToolContextLoaderPath>` when the option is present. | `testChildArgsExplicitLoaderKeepsNoExtensions`, existing child-args coverage | MUST | The explicit `-e` is additive; broad discovery stays disabled. |
| REQ-6 | The explicit loader path SHALL come only from trusted extension/session context and SHALL NOT be accepted from agent specs, delegated tasks, `run_subagent` tool params, command strings, or frontmatter. | `testSubagentParamsCannotSetLoaderPath`, `testAgentSpecCannotSetLoaderPath`, static review: no schema param, static review: no AgentSpec field | MUST | Prevents model-controlled extension loading. |
| REQ-7 | Existing runs without `explicitToolContextLoaderPath` SHALL preserve current argv/options behavior. | `testNoLoaderPathPreservesOptions`, existing child-runner tests | MUST | No migration required for users without tool-context-loader. |
| REQ-8 | Failure/denial paths SHALL not spawn children and SHALL not require or inspect the loader path. | Existing P3d denial tests, `testDeniedRegisteredAgentDoesNotForwardOrSpawn` | MUST | Preserve fail-closed behavior. |
| REQ-9 | `/agents run-temp` SHALL either forward the trusted loader path consistently or be explicitly out of scope in code comments/tests. | `testRunTempForwardsToolContextLoaderPath` OR `manual: documented out-of-scope decision` | SHOULD | Open decision. Including it gives all child Pi launches consistent behavior. |
| REQ-10 | Result formatting SHALL continue to redact prompt transport and private paths; the explicit loader path SHALL NOT be exposed in tool result details beyond existing argvPreview behavior. | `testSubagentDetailsDoNotExposePromptTransport`, existing compact-result tests | MUST | `argvPreview` may show `-e` and path if current redaction does; do not add unredacted private prompt details. |
| REQ-11 | The change SHALL not modify `buildChildPiArgs` semantics beyond already-supported option usage. | `git diff -- agents/lib/child-args.ts` | SHOULD | Low-level support already exists. |
| REQ-12 | P3G-1 SHALL resolve and test the trusted source that populates `explicitToolContextLoaderPath`; implementation SHALL NOT merge with an ambiguous source. | `testTrustedLoaderPathSourcePopulatesSessionContext`, `testEnvToolContextLoaderPathSourcePopulatesRunOptions`, `testLoaderPathSourcePrecedenceAndValidation`, static review: source is trusted session context or parent-process environment | MUST | Resolved source: `ctx.explicitToolContextLoaderPath` overrides `PI_AGENTS_TOOL_CONTEXT_LOADER_PATH`. Neither source is accepted from model/tool params/specs/tasks. |

**Priority legend:**
- **MUST**: Required for the first slice merge. Failing test = blocker.
- **SHOULD**: Required before the feature is considered complete; one slice may defer.
- **MAY**: Nice-to-have, not blocking any merge.

## Non-Goals

Out of scope for this feature:

- Enabling broad child extension discovery by removing `--no-extensions` or setting `disableResourceDiscovery: false`.
- Passing `--approve` or changing child project trust approval behavior.
- Allowing agent specs, Markdown frontmatter, model prompts, `run_subagent` params, or delegated tasks to choose an extension path.
- Loading arbitrary extension lists in child processes.
- Changing tool-context-loader matching semantics; PR #32 already added native/custom tool support.
- Preloading runbook bodies into initial child prompts. This feature is about enabling the existing JIT extension in child Pi.
- Changing `buildChildPiArgs` unless a test exposes an actual gap.
- Implementing model profile wiring (P3f-2) or unrelated P3d-1 behavior.

## Safety / Security

| Concern | Severity | Mitigation | Test(s) |
|---|---|---|---|
| Model-controlled extension loading | High | Loader path only comes from session/extension context; no tool parameter, no AgentSpec field, no task parsing. | `testSubagentParamsCannotSetLoaderPath`, static review |
| Broad extension discovery re-enabled | High | Keep `--no-extensions`; add only explicit `-e`. | `testChildArgsExplicitLoaderKeepsNoExtensions` |
| Registered agent gate bypass | High | Forward option only inside existing runner calls after current re-read and `canRunAgent` checks. | `testRunRegisteredForwardsToolContextLoaderPath`, existing denial tests |
| Path leakage in child result details | Medium | Do not add new details fields for loader path; preserve existing compact result whitelist. | `testSubagentDetailsDoNotExposePromptTransport` |
| Local environment path assumptions | Medium | Make path optional; no path = current behavior. | `testNoLoaderPathPreservesOptions` |
| Ephemeral inconsistency | Low/Medium | Decide explicitly: include run-temp or document deferral. | `testRunTempForwardsToolContextLoaderPath` or documented out-of-scope |

## Design

### Key types

```ts
export type AgentsContextLike = {
  cwd?: string;
  agentsHomeDir?: string;
  agentsPiCommand?: string;
  agentsChildRunner?: ChildAgentRunner;
  explicitToolContextLoaderPath?: string;
  // existing UI/trust fields unchanged
};

export type SubagentRunContext = {
  cwd: string;
  homeDir?: string;
  projectTrusted: boolean;
  piCommand?: string;
  childRunner?: ChildAgentRunner;
  explicitToolContextLoaderPath?: string;
};

export type EphemeralRunHandlerContext = {
  cwd?: string;
  agentsPiCommand?: string;
  agentsChildRunner?: ChildAgentRunner;
  explicitToolContextLoaderPath?: string;
  // existing fields unchanged
};
```

Naming is open to final implementation review. If `explicitToolContextLoaderPath` is used, keep it consistent with `ChildPiArgsOptions.explicitToolContextLoaderPath`.

### Key invariants

- The path is optional.
- The trusted source is `ctx.explicitToolContextLoaderPath` when supplied by the embedding/session context, otherwise parent-process environment variable `PI_AGENTS_TOOL_CONTEXT_LOADER_PATH`.
- The path is session/user-environment-owned, not model-owned.
- If absent, child invocation behavior is unchanged.
- If present, all relevant child-runner calls receive it in the options object.
- `--no-extensions` remains in child argv.
- `-e <explicitToolContextLoaderPath>` is additive.
- Existing gate order remains unchanged: parse → resolve → re-read current bytes → canRunAgent → spawn.

### Resolution / flow

```text
Parent/session context has optional explicitToolContextLoaderPath, or parent process has PI_AGENTS_TOOL_CONTEXT_LOADER_PATH
  → /agents run OR run_subagent OR run-temp resolves the trusted loader path
  → each surface builds child runner options
  → options include cwd, piCommand, explicitToolContextLoaderPath
  → runChildAgent/runBuiltInChildAgent call buildChildPiArgs
  → buildChildPiArgs emits --mode json --no-session --no-approve --no-extensions ... -e <path> --tools ... -p
  → child Pi loads only the explicit loader extension plus built-in runtime
  → child tool calls can receive tool-context-loader JIT runbooks
```

## Existing Hook Points

Line numbers are based on the current worktree during plan creation and may shift before implementation.

| File | Line(s) | What it does | Impact |
|---|---:|---|---|
| `agents/lib/child-args.ts` | L9, L37, L98-L100 | Defines and validates `explicitToolContextLoaderPath`; emits `-e <path>`. | No semantic change expected; use existing option. |
| `agents/lib/run-resolver.ts` | L13-L24 | `AgentsContextLike` for `/agents run` execution. | Add optional loader path field. |
| `agents/lib/run-resolver.ts` | L60-L67 | `executeChildRun` calls custom child runner, `runBuiltInChildAgent`, or `runChildAgent`. | Forward loader path in all three options objects. |
| `agents/lib/subagent-tool.ts` | L17-L24 | `SubagentRunContext`. | Add optional loader path field. |
| `agents/lib/subagent-tool.ts` | L111-L126 | Built-in `run_subagent` execution branch. | Forward loader path to custom/built-in child runner options. |
| `agents/lib/subagent-tool.ts` | L180-L188 | Registered `run_subagent` execution branch. | Forward loader path after existing gate. |
| `agents/lib/subagent-tool.ts` | L227-L253 | Tool registration builds `SubagentRunContext` from session and per-call extension context. | Copy trusted path from captured session context into run context. |
| `agents/index.ts` | L24-L36 | `AgentsContext` shape captured on `session_start`. | Add optional loader path field if Pi extension context supplies it or local extension config sets it. |
| `agents/index.ts` | L40-L45 | Captures `sessionAgentsCtx`. | Ensure the trusted loader path is available in session context before `registerSubagentTool` uses it. |
| `agents/lib/ephemeral.ts` | L60-L71 | `EphemeralRunHandlerContext`. | Optional if run-temp included. |
| `agents/lib/ephemeral.ts` | L116-L117 | `/agents run-temp` calls custom child runner or `runChildAgent`. | Forward loader path if run-temp included. |

## Slice Ladder

| Slice | Objective | Primary files | Key deliverables | Tests | Hard stops |
|---|---|---|---|---|---|
| `P3G-1` | Wire trusted explicit loader path through `/agents run` and `run_subagent`. | `run-resolver.ts`, `subagent-tool.ts`, `index.ts`, tests | Options forwarding; no broad discovery; no schema/user input path. | `testRunBuiltInForwardsToolContextLoaderPath`, `testRunRegisteredForwardsToolContextLoaderPath`, `testRunSubagentBuiltInForwardsToolContextLoaderPath`, `testRunSubagentRegisteredForwardsToolContextLoaderPath`, child args argv test | No `--approve`, no removal of `--no-extensions`, no model-controlled path. |
| `P3G-2` | Decide and implement `/agents run-temp` consistency if accepted. | `ephemeral.ts`, ephemeral tests | Forward loader path for ephemeral child runs or document deferral. | `testRunTempForwardsToolContextLoaderPath` or documented out-of-scope validation | Do not add persistence/registration changes. |
| `P3G-3` | Docs/status follow-up if needed. | `agents/P3_IMPLEMENTATION_SLICES.md`, local runbooks if applicable | Document child JIT behavior and validation path. | Docs review/manual smoke | Do not commit `.pi/runbooks` unless policy changes. |

### Dependency graph

```text
PR #32 native/custom JIT support (merged)
        │
        ▼
P3G-1 /agents run + run_subagent forwarding
        │
        ├── P3G-2 run-temp decision/forwarding
        │
        ▼
P3G-3 docs/status follow-up
```

## Cut Order

If context or implementation scope grows, cut in this order:

1. P3G-3 docs/status follow-up.
2. P3G-2 run-temp support, if it proves contentious.
3. Registered-agent positive tests can be simplified to fake child-runner assertions if full fixture setup is too large, but gate-denial tests must remain.

Do not cut:

- Keeping `--no-extensions`.
- Preventing model-controlled extension paths.
- Forwarding through both built-in and registered `run_subagent` branches.
- Negative tests that prove nonmatching/wrong tool paths do not spawn or do not forward.

## Contracts

### `makeChildRunOptions(ctx): ChildRunOptions` (implementation may inline)

**Input contract:** Session/runner context with optional `cwd`, optional `agentsPiCommand`/`piCommand`, and optional trusted `explicitToolContextLoaderPath`.

**Output contract:** Plain options object passed to `ChildAgentRunner`/`runChildAgent`/`runBuiltInChildAgent` with `cwd`, `piCommand`, and `explicitToolContextLoaderPath` only when present.

**State table (exhaustive):**

| State | Condition | Output |
|---|---|---|
| A. No loader path | `explicitToolContextLoaderPath` absent/undefined and `PI_AGENTS_TOOL_CONTEXT_LOADER_PATH` unset | Existing options shape: `{ cwd, piCommand }` or equivalent undefined fields. |
| B. Trusted session loader path | `explicitToolContextLoaderPath` present in session/embedding context | Options include `{ explicitToolContextLoaderPath }` from context. |
| C. Trusted environment loader path | Context path absent and `PI_AGENTS_TOOL_CONTEXT_LOADER_PATH` set in parent process | Options include `{ explicitToolContextLoaderPath }` from environment. |
| D. Child runner fake | `agentsChildRunner`/`childRunner` present | Fake receives same options object as real child runner. |
| E. Built-in child | Agent name is reserved built-in | `runBuiltInChildAgent` receives options with loader path if present. |
| F. Registered child | Agent spec passes current gates | `runChildAgent` receives options with loader path if present. |

**Error codes:**

No new runtime error codes are expected. Existing validation in `buildChildPiArgs` can still throw:

| Code | Field | Trigger |
|---|---|---|
| `Error` | `explicitToolContextLoaderPath` | Empty string or path containing NUL/newline reaches `buildChildPiArgs`. |
| existing denial code | agent/gate fields | Existing `canRunAgent`/run_subagent denial conditions. |

### `registerSubagentTool(pi, sessionCtxRef)`

**Input contract:** `sessionCtxRef()` returns captured trusted session context or undefined.

**Output contract:** Registered tool builds `SubagentRunContext` from per-call `extensionCtx` for cwd/trust and session context for static trusted fields (`agentsHomeDir`, `agentsPiCommand`, `agentsChildRunner`, `explicitToolContextLoaderPath`).

**State table (exhaustive):**

| State | Condition | Output |
|---|---|---|
| A. No session | `sessionCtxRef()` undefined | Existing fail-closed not-ready outcome. |
| B. Session without loader and env unset | Session context lacks loader path and `PI_AGENTS_TOOL_CONTEXT_LOADER_PATH` unset | Existing run behavior unchanged. |
| C. Session with loader | Session context has loader path | `executeSubagentRun` receives path from context. |
| D. Environment with loader | Session context lacks loader path and `PI_AGENTS_TOOL_CONTEXT_LOADER_PATH` is set | `executeSubagentRun` resolves path from parent process environment. |
| E. Tool params include fake path | User/model tries to pass extra path param | Ignored/rejected by schema; not copied to run context. |

## Edge Cases

| # | Scenario | Expected behavior | Test |
|---|---|---|---|
| EC1 | No `explicitToolContextLoaderPath` in session context | Options/argv unchanged from current behavior. | `testNoLoaderPathPreservesOptions` |
| EC2 | Loader path present for built-in `/agents run planner ...` | Child options include loader path; argv includes `-e` and keeps `--no-extensions`. | `testRunBuiltInForwardsToolContextLoaderPath`, `testChildArgsExplicitLoaderKeepsNoExtensions` |
| EC3 | Loader path present for registered project agent but project trust inactive | No child spawn; path does not matter. | existing denial test + `testDeniedRegisteredAgentDoesNotForwardOrSpawn` |
| EC4 | `run_subagent` called before `session_start` | Existing not-ready denial; no path forwarding. | existing not-ready test |
| EC5 | `run_subagent` params include extra `explicitToolContextLoaderPath` | Schema disallows/implementation ignores it; session path only. | `testSubagentParamsCannotSetLoaderPath` |
| EC6 | Loader path contains newline/NUL | Existing child-args validation throws before spawn; test if constructing real argv directly. | child-args validation test |
| EC7 | Custom/fake child runner path | Fake receives same option as real runner. | forwarding tests |
| EC8 | `/agents run-temp` path if included | Ephemeral child options include loader path after existing scan/confirm/gate. | `testRunTempForwardsToolContextLoaderPath` |

## Test Case Catalog

Grouped by concern. Every test name here appears in the Requirements table.

```text
Group 1: /agents run forwarding (2 tests)
  testRunBuiltInForwardsToolContextLoaderPath
  testRunRegisteredForwardsToolContextLoaderPath

Group 2: run_subagent forwarding and model-input exclusion (5 tests)
  testRunSubagentBuiltInForwardsToolContextLoaderPath
  testRunSubagentRegisteredForwardsToolContextLoaderPath
  testSubagentParamsCannotSetLoaderPath
  testAgentSpecCannotSetLoaderPath
  testSubagentDetailsDoNotExposePromptTransport

Group 3: argv, trusted source, and no-regression behavior (6 tests/checks)
  testChildArgsExplicitLoaderKeepsNoExtensions
  testTrustedLoaderPathSourcePopulatesSessionContext
  testEnvToolContextLoaderPathSourcePopulatesRunOptions
  testLoaderPathSourcePrecedenceAndValidation
  testNoLoaderPathPreservesOptions
  git diff -- agents/lib/child-args.ts

Group 4: denial/fail-closed behavior (1+ existing tests)
  testDeniedRegisteredAgentDoesNotForwardOrSpawn
  existing P3d denial tests

Group 5: optional run-temp consistency (1 test or documented deferral)
  testRunTempForwardsToolContextLoaderPath OR manual: documented out-of-scope decision
```

Total: 14 named/explicit checks minimum if run-temp is included; 13 if run-temp is deferred with documented rationale.

## Risk Analysis

| Risk | Severity | Mitigation |
|---|---|---|
| Loading executable extension code in child process expands attack surface | High | Only load a trusted path from session/extension context; keep no broad discovery. |
| Future developer sources path from agent spec for convenience | High | Tests/static review assert no AgentSpec field or tool schema param. |
| Merge conflict with in-progress P3d-1 files | Medium | Keep changes narrow; coordinate with `run-resolver.ts`/`subagent-tool.ts` untracked branch state. |
| Optional run-temp support causes scope creep | Low/Medium | Make run-temp a separate slice or explicit out-of-scope decision. |
| Existing tests use exact option object equality | Medium | Update expected options intentionally and add no-path regression tests. |
| Child runbook JIT creates unexpected context in child models | Low/Medium | Runbooks are advisory and subordinate; tool-context-loader already wraps injections with lower-priority guidance. |

## Open Decisions

| Decision | Deferral slice | Rationale |
|---|---|---|
| What exact trusted source provides the loader path? | Resolved in local implementation | `ctx.explicitToolContextLoaderPath` is the highest-priority trusted session/embedding field. If absent, the parent-process environment variable `PI_AGENTS_TOOL_CONTEXT_LOADER_PATH` is used. Covered by `testTrustedLoaderPathSourcePopulatesSessionContext` and `testEnvToolContextLoaderPathSourcePopulatesRunOptions`. |
| Should `/agents run-temp` inherit JIT runbooks? | P3G-2 | Consistency argues yes; minimal P3G-1 scope may defer. |
| Should the agents extension auto-detect a sibling `tool-context-loader/index.ts` path? | P3G-1/P3G-3 | Auto-detection is convenient but risks local path assumptions. Safer first slice may only forward a provided trusted path. |
| Should docs mention `.pi/runbooks` local metadata? | P3G-3 | Project-local runbooks are ignored and environment-specific; avoid implying packaged behavior. |

## Done Criteria

All MUST requirements passing = done for P3G-1.

Additional completion checks:

- [ ] Plan review accepted.
- [ ] Adversarial review accepted with no unresolved blockers.
- [ ] `/agents run` built-in and registered forwarding tests pass.
- [ ] `run_subagent` built-in and registered forwarding tests pass.
- [ ] Real child argv test proves `--no-extensions` and `-e <path>` coexist.
- [x] Trusted loader-path source decision is resolved and covered by `testTrustedLoaderPathSourcePopulatesSessionContext` plus `testEnvToolContextLoaderPathSourcePopulatesRunOptions`.
- [ ] No model/tool/spec-controlled field can set the loader path, including AgentSpec/frontmatter (`testAgentSpecCannotSetLoaderPath`).
- [ ] Existing P3d/P3c child-agent tests still pass.

## Review Consensus

| Pass | Reviewer | Model | Blocker count | Verdict |
|---|---|---:|---:|---|
| 1 | Reviewer-role fallback after `/agents run reviewer` quota failure | `openrouter/z-ai/glm-5.2` | 0 | conditional-go |
| 2 | Implementation adversarial reviewer fallback | `openrouter/deepseek/deepseek-chat` | 0 | go |

### Resolved blockers

| # | Blocker | Resolution |
|---|---|---|
| 1 | No blockers found in pass 1. Non-blocking findings requested stronger tests/Done Criteria for trusted path source and AgentSpec exclusion. | Added REQ-12, `testAgentSpecCannotSetLoaderPath`, `testTrustedLoaderPathSourcePopulatesSessionContext`, expanded Done Criteria, and recorded review in `agents/P3G_CHILD_TOOL_CONTEXT_LOADER_JIT_PLAN_REVIEW.md`. |
| 2 | Implementation review suggested optional tests for invalid loader path and context-vs-env precedence. | Added `testLoaderPathSourcePrecedenceAndValidation` and recorded review in `agents/P3G_CHILD_TOOL_CONTEXT_LOADER_JIT_IMPLEMENTATION_REVIEW.md`. |

## Appendix: Implementation Plan

Concrete file-level implementation plan.

### Files to create

1. `agents/P3G_CHILD_TOOL_CONTEXT_LOADER_JIT_PLAN_REVIEW.md` — plan review record after reviewer pass.
2. `agents/P3G_CHILD_TOOL_CONTEXT_LOADER_JIT_ADVERSARIAL_REVIEW.md` — adversarial/security review record.

No new production source files are expected.

### Files to modify

| File | Change |
|---|---|
| `agents/lib/run-resolver.ts` | Add optional trusted loader path to `AgentsContextLike`; add `TOOL_CONTEXT_LOADER_PATH_ENV`, `resolveExplicitToolContextLoaderPath`, and `buildChildRunOptions`; forward resolved `explicitToolContextLoaderPath` to `ctx.agentsChildRunner`, `runBuiltInChildAgent`, and `runChildAgent` in `executeChildRun`. |
| `agents/lib/subagent-tool.ts` | Add optional loader path to `SubagentRunContext`; forward it in built-in and registered branches; copy trusted path from `sessionCtx` in `registerSubagentTool`; ensure tool schema does not expose any loader-path parameter. |
| `agents/index.ts` | Add optional loader path to local `AgentsContext`; define how it is populated from trusted context/config; pass through captured `sessionAgentsCtx` for `run_subagent` and command handlers. |
| `agents/lib/ephemeral.ts` | If P3G-2 includes run-temp, add optional loader path to `EphemeralRunHandlerContext` and forward it through custom/real child runner calls. Otherwise add no code and document out-of-scope. |
| `agents/test-fixtures/test-subagent-tool.mjs` | Add tests for `run_subagent` built-in/registered forwarding, params cannot set loader path, and no-path behavior. |
| `agents/test-fixtures/test-extension-scaffold.mjs` or relevant `/agents run` fixture | Add `/agents run` built-in/registered forwarding coverage using fake child runner options. |
| `agents/test-fixtures/test-child-args-jsonl.mjs` | Ensure/extend assertion that `explicitToolContextLoaderPath` produces `-e <path>` while retaining `--no-extensions`. |
| `agents/test-fixtures/test-ephemeral*.mjs` | If run-temp included, assert `runEphemeralCommand` forwards loader path. |
| `agents/test-fixtures/run-p3d-1-tests.sh` | Include any new/updated test file needed for P3G if P3d runner script is the nearest aggregate. Alternatively create a P3G runner script. |
| `agents/P3_IMPLEMENTATION_SLICES.md` | Optional/docs slice: add P3G row/status after implementation plan is accepted. |

### Implementation sequence

| Step | Action | Validation |
|---:|---|---|
| 1 | Add failing tests for native option forwarding in `/agents run` built-in and registered paths. | Run targeted test; confirm failure before implementation. |
| 2 | Add failing tests for `run_subagent` built-in and registered forwarding. | Run targeted test; confirm failure before implementation. |
| 3 | Add/confirm child argv test for `--no-extensions` + `-e <path>`. | `npx --yes tsx agents/test-fixtures/test-child-args-jsonl.mjs` |
| 4 | Add optional type fields and forward `explicitToolContextLoaderPath` through `run-resolver.ts`. | `/agents run` forwarding tests pass. |
| 5 | Add optional type fields and forward through `subagent-tool.ts`. | `run_subagent` forwarding tests pass. |
| 6 | Decide run-temp scope. If included, patch `ephemeral.ts` and tests; if deferred, add explicit note to plan/review. | Run ephemeral test or document deferral. |
| 7 | Run aggregate tests. | `./agents/test-fixtures/run-p3d-1-tests.sh`; child-args test; any P3G script. |
| 8 | Update docs/slice tracker if approved. | `git diff --stat`; docs review. |

### Risks

| Risk | Mitigation |
|---|---|
| Accidentally committing unrelated in-progress P3d files | Stage only P3G files; inspect `git diff --cached`. |
| Hidden option object equality tests fail | Update expected objects deliberately and add no-loader regression coverage. |
| Ambiguous source of loader path | Decide source before implementation; do not auto-invent unsafe path sourcing in code. |
| Child JIT not observable in deterministic CI | Test option/argv forwarding deterministically; keep live child JIT as manual smoke. |
| `.pi/runbooks` local metadata differs across machines | Do not depend on `.pi/runbooks` in CI; use fixture runbooks if end-to-end smoke is needed. |
