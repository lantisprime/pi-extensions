# P3 Implementation Slices

This file turns the P3 agent scaffold plan into smaller implementation slices for better token/context efficiency and safer review.

## Why Slice Further

The current P3 scope includes specs, scanner, registry, TUI guidance, doctor diagnostics, child Pi execution, ephemeral agents, `run_subagent`, and chain mode. Implementing this in one pass would create too much context pressure and too many interacting failure modes.

Implementation should proceed in small PRs where each slice has a narrow objective, focused tests, and a clear stop point.

## Current Status

Completed and merged:

### P3 Agent Scaffold (COMPLETE)
- P3b-1: core spec model and built-ins, PR #18, commit `9f213f7`
- P3b-2: Markdown parser and deterministic scanner, PR #19, commit `c5bb433`
- P3b-3: registry and runtime gate, PR #20, commit `44e2b43`
- P3b-4: diagnostics commands and proactive guidance, PR #21, commit `21a8ed0`
- P3b-5: registration flows, PR #22, commit `691f001`
- P3c-1: JSONL monitor/parser and child argv builder, PR #26, commit `dddb726`
- P3c-2: command-only built-in child execution, PR #27, commit `6c7d885`
- P3c-3: registered user/project execution, PR #28, commit `b72d531`
- P3c-4: ephemeral one-shot agents, PR #30, commit `72e62bf`
- P3d-1: run_subagent single-run LLM-callable tool, PR #33, commit `729cbc9`
- P3f-1: model profiles pure helpers, PR #31, commit `6a492b7`
- P3G: child tool-context-loader JIT, PR #34, commit `c09ac5e`
- P3f-2: model profiles wiring, PR #35, commit `8c7243a`
- P3d-2: command-only chain mode, PR #36, commit `bf1a240`
- P3f-3: profile file discovery + hash-registration, PR #37, commit `4f0a87b`

### P6 Intent Routing (COMPLETE)
- P6-0a: getPiInvocation binary resolution, PR #50
- P6-0b: role→system-prompt transport, PR #50
- P6-1: pure intent router core, PR #50
- P6-2: LLM classifier spawn + fallback, PR #58, commit `cc5ca7c`
- P6-3a: runResolvedTarget extraction, PR #59, commit `df19e14`
- P6-3b: /agents do wiring, PR #60, commit `cee56ac`
- P6-4: disambiguation hardening, PR #61, commit `09dfe5e`

### P7 Prompt-Intent Gate (COMPLETE)
- P7-1: config loader + phrase matcher + gate decision engine, PR #64, commit `8d06a9c`
- P7-2: input hook wiring + confirm flow + disableContextFiles, PR #67, commit `4d61dcd`
- P7-3: regex matching under timeout + worker timeout fix, PR #69/#70, commits `ed12dc1`/`c5fe526`

### P8 Responsive Agent UX (COMPLETE)
- P8: non-blocking in-process agent runs + live TUI feedback, PR #65, commit `f599fdd`
- P8 follow-ups: UX/results/error/timeout, PR #66, commit `b481c58`

### P4R Background Agents Remediation (COMPLETE)
- P4R-3: manifest integrity + schema + keyGenId, PR #72, commit aa2cce7
- P4R-0: authority-root binding, PR #73, commit 9b2dbc4
- P4R-1: reservation + no-kill reaping, PR #75, commit ac10d65
- P4R-2: tolerant + honest listing, PR #76, commit b13b06b
- P4R-5: MAC key lifecycle, PR #77, commit fd29e9a
- P4R-6: hygiene + parent-plan correction, PR #78, commit d34cd20
- Plan: agents/docs/P4_REMEDIATION_PLAN.md — v3 GO consensus
- All slices edit agents/lib/bg-state.ts

### P4-2 Preflight (COMPLETE)
- P4-2: signed identity manifest + shared preflight gate, PR #81, commit 993cacf
- New file: agents/lib/bg-preflight.ts
- Tests: test-bg-preflight.mjs (5 tests)

### P4-3 Worker (COMPLETE)
- P4-3: background-agent worker process, PR #82, commit b29a277
- New file: agents/lib/bg-worker.ts
- Tests: test-bg-worker.mjs (10 tests)

### P4-4 Terminal Backend Interface (COMPLETE)
- bg-terminal.ts: TermBgBackend interface + register/get backend registry
- PR #88, commit 8e2f596

### P4-5 Command Wiring (COMPLETE)
- index.ts: /agents bg, bg-status, bg-stop, bg-result, bg-open
- PR #91

### P4-6 Status Line (COMPLETE)
- Running agent count via appendEntry
- PR #96

### P4-7 Integration Tests (COMPLETE)
- Fake TermBgBackend, temp state dir, ~30 tests
- PR #97, commit bea9eb0

### P5 Pluggable Terminal Backend (COMPLETE)
- tmux-terminal/ extension: reference TermBgBackend implementation
- 14 new files + 2 anchored edits; 22 requirements / 63 tests
- Initial merge: PR #98, commit f3b247c
- Post-merge fixes (D5 + D6): PR #100, commit 4f4339b
- Post-merge fix (D7, symlink-loading): PR #102, commit 6ec1b4f
- Branches: `p5-tmux-terminal`, `fix/p5-d5-d6-real-tmux`, `fix/p5-d7-resolve-worker-symlink` (all 3 deleted post-merge).
- Post-merge fixes (D5 + D6): real-tmux smoke test surfaced two bugs invisible to FakeTmuxExecutor unit tests:
  - **D5**: `isAvailable` probe changed from `has-session -t __pi_probe__` to `list-sessions`. Original probe returned exit 1 for nonexistent session; `defaultTmuxExecutor` catches → `{ok: false}`; my D1 `result.ok === true` check made `isAvailable` always return `false` even when server reachable. `list-sessions` correctly distinguishes server-reachable from server-unreachable.
  - **D6**: launch argv now prepends `"node"` before workerPath (`[..., "--", "node", workerPath, manifestPath]`). `bg-worker.ts` is mode 644 with no shebang; tmux cannot exec it directly. Without the prefix, the window is created then immediately destroyed; user-options never set; `isAlive` returns false.
  - New `test-real-tmux-smoke.mjs` exercises the actual implementation against an isolated `tmux -L p5-smoke-<pid>` socket; catches both bugs in CI.
- Status: All 5 rounds of plan review complete (v1 14 blockers → v5 UNCONDITIONAL-GO); 1 round of code review (APPROVE, 0 blockers).
- Plan (ACTIVE): agents/docs/P5_PLUGGABLE_TERMINAL_BACKEND_PLAN_V5.md
- Plan review: agents/docs/P5_PLUGGABLE_TERMINAL_BACKEND_PLAN_REVIEW.md
- Adversarial review: agents/docs/P5_PLUGGABLE_TERMINAL_BACKEND_ADVERSARIAL_REVIEW.md
- Implementation: 14 new files in `tmux-terminal/` (8 production + 5 test + runner + README) + 2 anchored edits in `agents/`. All 63 tests pass on macOS. REQ-13 grep clean. P4-4 regression suite still green.
- Stats: 22 requirements / 63 test functions across 16 groups / 15 contract states / 16 mechanical-execution steps.
- Implementation deviations from plan (executor fix-ups, all required to make tests pass):
  1. `isAvailable` and `launch` now check `result.ok` on executor return (not just catch throws). The plan's try/catch-only design fails the tests because `FakeTmuxExecutor` returns `{ ok: false }` instead of throwing. Production `defaultTmuxExecutor` never throws either, so the original try/catch was dead code.
  2. Removed contradictory first assertion in `testLaunchDoesNotInterpolateRunId`. The assertion `!newWindowStr.includes(SAMPLE_RUN_ID)` fails by design (REQ-5 mandates `windowName = pi-agent-<runId>`, so runId appears in argv). Kept the second (correct) assertion: `runIdOccurrences === 0` (no standalone runId token). Test author's own comment clarified intent.
  3. `test-bg.mjs` REQ-22 test wrapped as `async function testListEntryWithoutRunIdIsTreatedAsUnknown()` + main() entry, matching file style. Plan's inline-block style wouldn't execute (file uses `main()` invocation only).
  4. Anchors adapted: file uses `// ---...` dashes not `// ── Test helpers ──`. Used equivalent sections.
  5. **D5 (post-merge, real-tmux smoke surfaced)**: `isAvailable` probe changed from `has-session -t __pi_probe__` to `list-sessions`. See D5/D6 note above.
  6. **D6 (post-merge, real-tmux smoke surfaced)**: launch argv now prepends `"node"` before workerPath — `[..., "--", "node", workerPath, manifestPath]`. `bg-worker.ts` has no shebang and is not executable; tmux cannot exec it directly. See D5/D6 note above.
  7. **D7 (post-merge, symlink loading surfaced)**: `resolveWorkerPath()` production mode walks UP from the module's location to find `agents/lib/bg-worker.{ts,mjs,js}` instead of looking only in `tmux-terminal/` (its own directory). The original implementation computed `baseDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))` which resolved to `tmux-terminal/` — wrong; `bg-worker.ts` lives in `agents/lib/`. When loaded via symlink (`~/.pi/agent/extensions/tmux-terminal → .../pi-extensions/tmux-terminal`), `resolveWorkerPath` returned null, the extension's `registerBgTerminalBackend` was silently skipped, and `/agents bg` produced "No terminal backend installed." Surfaced by the user's interactive test. Fix: walk up from `import.meta.url`'s dir, checking for `agents/lib/bg-worker.*` at each level until found or root reached. New `testProductionModeFindsWorkerByWalkingUp` unit test (in test-helpers.mjs) catches the regression: it sets up a fake repo layout in a tmpdir, copies the resolve-worker-path.ts + constants.ts into a fake-extension/lib dir, and spawns a child node process to verify the production-mode path resolves correctly.
- Regression guards verified:
  - Mutation #1 (realpathSync → path.resolve in resolve-worker-path.ts): `testWorkerPathIsRealpathed` fails as expected.
  - Mutation #2 (reorder WORKER_BASENAMES to `[.mjs, .ts, .js]`): `testWorkerPathPrefersTsOverMjs` fails as expected.
  - Both pass when reverted.
- Real-tmux smoke test (post-merge):
  - New `tmux-terminal/test-fixtures/test-real-tmux-smoke.mjs` exercises the actual implementation against an isolated `tmux -L p5-smoke-<pid>` socket. Skipped (exit 0) if tmux not on $PATH.
  - Catches D5 and D6 — bugs invisible to FakeTmuxExecutor unit tests.

### P4R-PROJ Project Background Agents (DEFERRED)
- Requires disk-backed trust reader
- Not in current cut

- P3e: docs, README, user manual, smoke, PR #38, commit `04695e6`
- P3f-4: runtime profile override + stdout spill, PR #41, commit `4473431`

**P6 Intent Routing** (next: P6-2 classifier spawn + fallback):
- P6-2 through P6-4: pending (see agents/docs/P6_INTENT_ROUTING_PLAN.md)

Track 2 (planning only):
- P4: background agents (planning — agents/docs/P4_BACKGROUND_AGENTS_PLAN.md)
- P4R: remediation plan GO — agents/docs/P4_REMEDIATION_PLAN.md
- P5: pluggable terminal backend (planning — agents/docs/P5_PLUGGABLE_TERMINAL_BACKEND.md)

## Slice Rules

- One primary concern per slice.
- Prefer pure helper tests before Pi runtime integration.
- Do not add child execution until the shared runtime gate exists.
- Do not add `run_subagent` until command execution is validated.
- Do not add chain mode until single-run behavior is validated.
- Keep each slice reviewable without reloading all prior docs; include a short slice summary in PR body.

## Implementation Strategy Table

| Slice | Objective | Primary files | Key deliverables | Tests / validation | Hard stop / do not include |
|---|---|---|---|---|---|
| P3b-0 | Planning docs only | `agents/*.md` | Plan, spec, security model, registration guide, reviews, blocker resolution | `git diff --check` | No runtime code |
| P3b-1 | Core spec model and built-ins | `agents/index.ts` or `agents/lib/specs.ts`, `agents/test-fixtures/test-specs.mjs` | `AgentSpec` types/constants; built-in `scout`, `planner`, `reviewer`; name/tool/model/thinking validation; output contracts | Pure helper tests for built-ins and validators | No Markdown discovery, registry, child process, or broad TUI |
| P3b-2 | Markdown parser and deterministic scanner | `agents/lib/agent-markdown.ts`, `agents/lib/security-scan.ts`, parser tests, shared sync scripts | Bounded frontmatter/body parser; raw-file-byte SHA-256; vendored shared scanner from `shared/security-scan.ts`; safe/suspicious/dangerous classification; reserved-name shadow detection | Parser cap tests; invalid fields; raw hash changes; dangerous scanner blocks eligibility; shared scanner sync/verify passes | No registry writes or child execution |
| P3b-3 | Registry and runtime gate | `agents/lib/registry.ts`, `agents/lib/can-run-agent.ts`, registry tests | User/project registries; project-root hash; `canRunAgent`; root mismatch detection | Unregistered/hash-mismatch/trust-inactive/project-root isolation tests | No child argv construction before gate passes |
| P3b-4 | Diagnostics and proactive guidance | `agents/index.ts`, diagnostics helpers/tests | `/agents`, `/agents list`, `/agents config`, `/agents inspect`, `/agents registry`, `/agents verify`, `/agents doctor`; proactive recommendation dedupe | Doctor bounded/deterministic tests; next-step output tests | No registration writes unless slice stays small; no child execution |
| P3b-5 | Registration flows | registration command handlers/tests | `/agents register`, `/agents register-project`, `/agents unregister`; TUI confirmation; non-TUI fail-closed; `--all-safe` safe-only behavior | TUI/non-TUI branch tests; suspicious per-spec confirmation; dangerous blocked | No child execution |
| P3c-1 | JSONL monitor/parser and child argv builder | `agents/lib/child-args.ts`, `agents/lib/jsonl-monitor.ts`, fake JSONL fixtures | Safe child argv; stdin/temp prompt transport; JSONL reducer; usage/cost/stopReason/tool trajectory; truncation flags | Fake JSONL tests; no prompt/task in argv | No live child Pi execution |
| P3c-2 | Command-only built-in child execution | child runner + command handler | `/agents run scout|planner|reviewer <task>`; timeout/output caps; compact result rendering | Extension load smoke; optional live built-in smoke | Built-ins only; no user/project specs, ephemeral, `run_subagent`, or chain |
| P3c-3 | Registered user/project execution | run command + registry integration tests | `/agents run <registered-user-agent>` and `<registered-project-agent>` through `canRunAgent` | Runtime hash recheck; project trust check; registered spec smoke where possible | No unregistered specs; no chain/tool exposure expansion |
| P3c-4 | Ephemeral one-shot agents ✅ | temp-agent handlers/tests | `/agents run-temp`; `/agents save-temp`; scan prompt; save does not register | Dangerous/suspicious prompt tests; no persistence on run; saved spec blocked until registered | No `run_subagent` prompt override |
| P3f-1 | Model profiles — pure helpers ✅ | `agents/lib/profiles.ts`, `agents/test-fixtures/test-profiles.mjs` | `ModelProfile` type, `resolveSpecProfile` (profile-as-authority), `validateProfile` (11 checks + 4 forbidden-field), `validateProfileLibrary`, built-in capability profiles | Pure helper tests (full contract coverage); `git diff --stat` on 10 existing files = empty | No wiring, no `AgentSpec.profile` field, no file discovery, no override-map tests |
| P3f-2 | Model profiles — wiring ✅ | `agents/index.ts`, `specs.ts`, `agent-markdown.ts`, `child-runner.ts`, `diagnostics.ts`, `registration.ts`, `registry.ts` | `AgentSpec.profile` field; `profile` in accepted keys; resolution wired into `runChildAgent`; `/agents profiles` with hashes; effective vs declared in inspect; doctor checks; observability metadata | Wiring tests; profile hash visibility; doctor flags unresolved refs + hash drift; no runtime trust enforcement | No user/project profile file discovery; no profile hash registration; trust gap accepted until P3f-3 |
| P3f-3 | Model profiles — file discovery + hash-registration | profile file parser/discovery, registry, diagnostics | User/project profile file discovery; project trust gating; hash-register project profiles in registry; profile-change re-registration flow | File parsing caps; hash-registration prevents unregistered profile changes; re-registration tests | None — closes the trust gap |
| P3d-1 | `run_subagent` single-run tool ✅ | tool registration/tests | Model-callable single read-only run; same gate; child excludes `run_subagent`; no prompt override; redacted tool result details | Tool schema/gate/recursion/redaction tests; P3c regressions; opus-4.8 review `go` | No chain/parallel/write/bash |
| P3d-2 | Command-only chain mode | chain handler/tests | `/agents chain`; max length 3; preflight all agents; bounded prior-summary handoff | Chain preflight failure tests; handoff bounds tests | No chain via `run_subagent` |
| P3e | Docs, local eval command, smoke | `agents/README.md`, eval docs/tests | README; local eval command docs; smoke commands; validation notes | `pi --no-extensions -e ./agents/index.ts --list-models`; local eval command | No new runtime capabilities |
| P6-1 | Intent router core (pure helpers) ✅ | `agents/lib/intent-router.ts`, `agents/test-fixtures/test-intent-router.mjs` | classifyIntentHeuristic, parseClassifierOutput, profileEffect, CLASSIFIER_LIMITS, shared types/constants | 22 tests (8 heuristic + 8 parser + 6 constants); zero blast radius | No existing-file changes |
| P6-0a | Child pi binary resolution ✅ | `agents/lib/child-args.ts`, `agents/lib/child-runner.ts`, `agents/test-fixtures/test-pi-invocation.mjs` | getPiInvocation() with env? test-seam; wired into defaultSpawner | 4 REQ-16 tests; existing child-runner/args/subagent-tool regressions green | No transport changes |
| P6-0b | Role→system-prompt transport | `agents/lib/child-args.ts`, `agents/lib/child-runner.ts`, 5 test fixtures | systemPromptFile channel; --append-system-prompt; remove -p @file; bare-task stdin | 5-test fixture-change ledger + smoke (REQ-17/17b/18) | Focused review before build; changes ALL child runs |
| P6-2 | LLM classifier spawn + fallback | `agents/lib/intent-router.ts`, `agents/lib/child-runner.ts` | buildClassifierPiArgs, resolveRunIntent, collectChildProcess wrapper | 11 tests (REQ-4/5); classifier never gets --tools | No existing child-runner refactor |
| P6-3a | Pure runResolvedTarget extraction | `agents/lib/run-resolver.ts` | Extract registered-run tail into reusable function | existing /agents run tests + added TOCTOU coverage | Zero behavior change |
| P6-3b | /agents do wiring | `agents/index.ts`, `agents/lib/run-resolver.ts` | runIntentCommand, parseDoArgs, REQ-6/7/8/9/10/11/15 | 12 command tests; must not bypass canRunAgent for registered | No chain/parallel/write/bash |
| P6-4 | Disambiguation hardening | `agents/lib/diagnostics.ts`, `agents/index.ts` | Agent/profile collision doctor warning; no-op profile labels; misplaced --profile warning | 5 tests (REQ-12/13/14) | Parallel after P6-1; imports profileEffect from intent-router.ts |

## Recommended Slice Ladder

### P3b-0: Planning docs only

Status: current planning work.

Includes:

- `P3_AGENT_SCAFFOLD_PLAN.md`
- `AGENT_SPEC.md`
- `SECURITY_MODEL.md`
- `REGISTRATION_GUIDE.md`
- plan/adversarial/security reviews

No runtime code.

### P3b-1: Core spec model and built-ins

Goal: establish pure data model and built-in specs.

Files:

- `agents/index.ts` or `agents/lib/specs.ts`
- `agents/test-fixtures/test-specs.mjs`

Implement:

- `AgentSpec` types/constants
- built-in `scout`, `planner`, `reviewer`
- name validation
- tool allowlist validation
- model/thinking validation
- output-contract metadata

Do not implement:

- Markdown discovery
- registry
- child process execution
- TUI commands beyond maybe `/agents list` stub

### P3b-2: Markdown parser and deterministic scanner

Goal: parse and risk-score specs without running them.

Implement:

- bounded Markdown/frontmatter parser
- accepted keys only
- raw-file-byte SHA-256 helper
- vendored copy of the repo shared deterministic scanner: `shared/security-scan.ts -> agents/lib/security-scan.ts`
- safe/suspicious/dangerous classification
- reserved-name shadow detection

Tests:

- file/frontmatter/body caps
- invalid names/tools/thinking
- raw bytes hash changes on any file change
- dangerous scanner findings block registration eligibility
- shared scanner sync/verify includes `agents/lib/security-scan.ts` once added

### P3b-3: Registry and `canRunAgent` gate

Goal: make trust enforceable before any child execution exists.

Implement:

- user registry path
- project registry path from canonical project root SHA-256
- registry read/write helpers
- `canRunAgent(spec, context)`
- project trust input abstraction for tests
- root mismatch detection

Tests:

- unregistered user/project blocked
- hash mismatch blocked
- project trust inactive blocked even with registry entry
- project approvals do not apply across roots
- built-ins pass
- saved ephemeral specs are treated as user specs and blocked until registered

### P3b-4: Diagnostics commands and proactive guidance

Goal: user can understand state before any child execution.

Implement commands:

- `/agents`
- `/agents list`
- `/agents config`
- `/agents inspect <name>`
- `/agents registry`
- `/agents verify`
- `/agents doctor`

Implement:

- bounded, deterministic doctor checks
- proactive project-agent recommendation dedupe
- next-step messages

Do not implement:

- registration writes, unless this slice remains small
- child execution

### P3b-5: Registration flows

Status: completed and merged in PR #22 at commit `691f001`.

Goal: get user/project specs from discovered to runnable.

Implement commands:

- `/agents register <path-or-name>`
- `/agents register-project [--all-safe]`
- `/agents unregister <name>`

Implement:

- TUI confirmation path using `ctx.hasUI`
- non-TUI fail-closed path
- suspicious per-spec confirmation
- `--all-safe` safe-only behavior
- dangerous never registers

Tests:

- TUI confirmation required
- non-TUI writes no registry entry
- suspicious excluded from `--all-safe`
- dangerous blocked

### P3c-1: JSONL monitor/parser and child argv builder

Status: completed and merged in PR #26 at commit `dddb726`.

Goal: prepare child execution without executing Pi.

Implement:

- `buildChildPiArgs`
- prompt transport abstraction: stdin/private temp file
- no prompt/task in argv tests
- JSONL parser/reducer
- tool trajectory extraction
- usage/cost/stopReason extraction when present
- truncation flags

Tests use fake JSONL only.

### P3c-2: Command-only built-in child execution

Status: completed and merged in PR #27 at commit `6c7d885`.

Goal: first live child Pi runner for built-ins only.

Implement:

- `/agents run scout|planner|reviewer <task>`
- timeout/output caps
- process kill on timeout/excess output
- compact result rendering

Scope limit:

- built-ins only
- no user/project spec execution yet
- no ephemeral agents
- no `run_subagent`
- no chain

### P3c-3: Registered user/project execution

Status: current implementation slice.

Goal: allow registered Markdown specs to run through the same gate.

Implement:

- `/agents run <registered-user-agent> <task>`
- `/agents run <registered-project-agent> <task>`

Required:

- shared `canRunAgent` gate before argv construction
- project trust check at runtime
- hash recheck at runtime

### P3c-4: Ephemeral one-shot agents

Goal: support temporary user-prompted agents without persistence.

Implement:

- `/agents run-temp <base-role> <task>`
- `/agents save-temp <name>`

Constraints:

- slash/direct user request only
- read-only base role
- scan prompt
- no persistence on run
- save does not register
- suspicious non-TUI fails closed

### P3d-1: `run_subagent` single-run tool

Status: merged in PR #33 at commit `729cbc9`.

Goal: expose safe LLM-callable delegation after command path is proven.

Implemented:

- single read-only run only
- no prompt override
- no chain/parallel
- same `canRunAgent` gate
- child tool list excludes `run_subagent`
- result `details` expose only allowlisted redacted fields
- multiline task text allowed while NUL/other controls are rejected

### P3d-2: Command-only chain mode

Goal: bounded sequential chain after single-run is stable.

Implement:

- `/agents chain scout,planner <task>`
- max length 3
- preflight all agents before first child starts
- bounded prior-summary handoff

No chain through `run_subagent` in P3.

### P3e: README, eval command, smoke

Goal: documentation and operational validation.

Implement:

- `agents/README.md`
- local eval command docs
- final smoke commands
- validation matrix update if needed

### P3f-1: Model profiles — pure helpers

Status: merged in PR #31 at commit `6a492b7`.

Goal: define profile model, validation, and resolution as pure helpers in a new file.

Files:

- `agents/lib/profiles.ts`
- `agents/test-fixtures/test-profiles.mjs`
- `agents/test-fixtures/run-p3f-1-tests.sh`

Implement:

- `ModelProfile`, `ModelProfileLibrary`, `ResolvedProfile`, `ProfileResolutionResult` types
- `resolveSpecProfile` — profile-as-authority, spec-falls-back, 5-state resolution
- `validateProfile` — 11 checks including 4 forbidden-field rejection (tools/safety/limits/forbiddenTools)
- `validateProfileLibrary` — duplicate name detection
- Built-in capability profiles: `fast-local`, `reasoning-deep`, `adversarial-review`
- 37 tests with full contract coverage

Do not implement:

- `AgentSpec.profile` field (deferred to P3f-2)
- Any changes to existing files
- Wiring, commands, or file discovery

### P3f-2: Model profiles — wiring

Status: merged in PR #35 at commit `8c7243a`.

Goal: wire profile resolution into the agent execution path.

Depends on: P3f-1 + P3c-3 (runChildAgent seam at child-runner.ts L65).

Files:

- `agents/lib/specs.ts` — `AgentSpec.profile?: string`
- `agents/lib/agent-markdown.ts` — `profile` in accepted keys + buildSpecFromMetadata
- `agents/lib/child-runner.ts` — `profiles` parameter on runChildAgent (L65) + runBuiltInChildAgent (L58)
- `agents/lib/diagnostics.ts` — model/thinking/profile in inspect + list; doctor checks
- `agents/lib/registration.ts` — Profile line in review output
- `agents/lib/registry.ts` — `profile?` on RegisteredAgent
- `agents/index.ts` — `/agents profiles` command; profileLibrary forwarded through executeChildRun (L161)

Implement:

- Profile resolution wired before buildChildPiArgs in runChildAgent
- `/agents profiles` list with SHA-256 hashes
- Effective vs declared model/thinking display in `/agents inspect`
- Doctor checks for unresolved profile references + hash-change warnings
- Run metadata records resolved profile name
- Profile hash visibility but NO runtime trust enforcement (gap accepted until P3f-3)

Do not implement:

- User/project profile file discovery
- Profile hash registration

### P3f-3: Model profiles — file discovery + hash-registration

Goal: close the trust gap by hash-registering project profiles.

Depends on: P3f-2 + registry infrastructure (P3b-3).

Implement:

- User-level profile file discovery (`~/.pi/agent/profiles/*.md`)
- Project-level profile file discovery (`.pi/profiles/*` behind project trust)
- Frontmatter-only parsing reusing bounded parser from agent-markdown.ts
- Hash-register project profiles in project registry (same model as agent specs)
- Profile-change re-registration flow
- Diagnostics for registered profiles

## Recommended Cut Order

If context or implementation scope grows, cut in this order:

1. chain mode
2. ephemeral save flow, keeping run-temp only
3. user/project Markdown execution, keeping built-ins only
4. `run_subagent` tool

Do not cut:

- shared `canRunAgent` gate
- raw-file-byte hash trust
- prompt/task not in argv
- no `--approve` by default
- timeout/output caps
- non-TUI fail-closed registration
