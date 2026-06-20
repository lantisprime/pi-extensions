# P6 Intent-Based Agent Routing Plan

## Status

**TOP PRIORITY** (canonical workplan, 2026-06-20 — ahead of the P4R background-agents track).

**Revised after two adversarial-review passes (claude-subagent — pass 1: conditional-go, 3B+5H+6M;
pass 2: conditional-go, 2B+3H+4M+1 ratify — all resolved below).** Rule 18 step 4: this is the
final plan, awaiting approval. Do not implement until approved (one focused review of the P6-0b
transport change still pending).

**Post-review additions (parent, after pass 1):** (a) classifier-model decision resolved
(`--thinking off` + child-default model + model-only override — see REQ-5 / Open Decisions);
(b) **new foundational slice P6-0 (run-path hardening)** folds in the three run-path findings
from the session's critical analysis (hardcoded `pi` binary, role-prompt instruction layering,
`-p @file` transport + real-`pi` smoke test) + **REQ-19** (CI must run the `agents/` suite).

**Pass 2 applied:** 2 blockers + 3 high + 4 medium resolved (see Review Consensus). **A-101
ratified by the user:** high-confidence registered picks **do** auto-run (uniform with built-ins).
The injection concern is instead bounded by a **read-only-tools rail** on auto-run (a no-op in P3
since all specs forbid write/edit/bash/run_subagent, but future-proof) plus the `canRunAgent` gate.
See REQ-8.

**E2E added (user request):** REQ-20 + the End-to-End Test Scenarios section run **actual `pi`
subagents** (built-ins, `/agents do` routing, a registered auto-run) against a disposable fixture
repo + temp HOME — a manual/nightly gate (no `pi` in CI, per R-103).

## Episode Search Summary

Searched episodic memory for: intent/agent/profile selection routing, model profile
resolution, P3f model profiles, canonical workplan.

Key active memories:

- `20260617-094208-…-10b8`: **P3F Model Profiles plan finalized** — profile-as-authority,
  built-ins are capability hints only, `resolveSpecProfile` field-merge. The layer this feature routes over.
- `20260617-092304-…-49c9`: **P3F adversarial review** — explicitly **banned** "dynamic /
  complexity / semantic routing (deferred to later maturity stage)" and flagged
  **R-004: profile and agent names share the same regex → collision in the user's mental
  model.** This plan is the considered activation of that deferred stage and resolves R-004.
- `20260619-214210-…-d5ac`: **Canonical workplan** — P3 scaffold complete; P4R next; P5 parallel.
  P6 is a new track that does not depend on P4/P5.
- `20260619-225710-…-09f2` / `20260619-225736-…-d14f`: **Pi platform/CLI + subagent/security
  reference** (this session). Confirms `--no-tools`/`-nt`, stdin-prompt, `--mode json` schema,
  and that **project trust is input-loading only — never an execution sandbox.**

Origin: folds two requests into the session's critical analysis of the `agents` extension —
(1) the reported symptom "Pi seems confused which model profile or agent to use," and
(2) "implement running agents based on the prompt's intent."

## Objective

Add a first-class **intent router** so a user can run `/agents do <task>` and have the
extension choose the right agent (and a sensible default model profile) from the task's
intent. Routing is **LLM-primary with a deterministic heuristic fallback**, never bypasses the
`canRunAgent` trust gate, never auto-runs an *untrusted* classification into a *registered*
agent without confirmation, and fails closed in non-interactive mode. Simultaneously, fix the
three "confusion" defects in the existing run/profile path the analysis surfaced.

## Why

The current run surface forces the user to be the router (`/agents run <agent>` needs the
exact name; `run_subagent` needs the model to name the agent; there is no "review this" →
`reviewer`). The analysis found three defects that produce the reported confusion:

1. **No-op built-in profiles.** `fast-local` carries neither `model` nor `thinking`
   (`profiles.ts:338`). `--profile fast-local` resolves to `effectiveModel = spec.model`
   (undefined) → child runs the **Pi default**. The profile *appears ignored*.
   `reasoning-deep`/`adversarial-review` set only `thinking:high`; the latter's "different
   provider" is a comment, not enforced.
2. **Agent/profile namespace collision (R-004).** Both share `^[a-z][a-z0-9_-]{0,63}$`
   (`specs.ts:101`). `/agents run reasoning-deep <task>` is parsed as an **agent** (not found).
3. **Silently-dropped `--profile`.** `parseRunArgs` (`run-resolver.ts:144`) honors `--profile`
   only as `tokens[1]`; `/agents run scout fix bug --profile reasoning-deep` folds it into the
   **task text** with no warning.

Intent routing removes the taxonomy burden; the disambiguation fixes remove the silent surprises.

## Requirements (Ground Truth)

| ID | Requirement | Test(s) | Priority | Notes |
|---|---|---|---|---|
| REQ-1 | `classifyIntentHeuristic(task, candidates)` returns deterministic `{agent, confidence, reason, signals}` for any non-empty task; pure, no I/O | `testHeuristic_reviewVerbs`, `testHeuristic_planVerbs`, `testHeuristic_scoutVerbs`, `testHeuristic_deterministic` | MUST | Confidence ∈ [0,1] |
| REQ-2 | Heuristic confidence monotonic in matched signal weight, clamped ≤1.0; empty/whitespace task throws; zero-match → `AMBIGUOUS_DEFAULT`; equal-nonzero tie broken by fixed role order `[reviewer,planner,scout]` | `testHeuristic_clamp`, `testHeuristic_emptyRejected`, `testHeuristic_ambiguousDefault`, `testHeuristic_tieBreakDeterministic` | MUST | Single-sourced `AMBIGUOUS_DEFAULT` constant (M-006) |
| REQ-3 | `parseClassifierOutput(raw, candidateNames)` accepts ONLY the **last top-level** JSON object (bare or in one ```json fence) of exact shape `{agent, confidence, reason}` with `agent ∈ candidateNames`; rejects multiple top-level objects, prose-embedded objects, extra/missing keys, non-finite confidence; clamps confidence to [0,1] | `testParse_validJson`, `testParse_jsonInCodeFence`, `testParse_unknownAgentRejected`, `testParse_nonJsonRejected`, `testParse_confidenceClamped`, `testParse_extraKeysRejected`, `testParse_multipleJsonObjectsRejected`, `testParse_jsonEmbeddedInProseRejected` | MUST | Untrusted-output validation (R-004) |
| REQ-4 | `resolveRunIntent` tries the LLM classifier first; on spawn-error/timeout/unparseable/unknown-agent/missing-confidence it falls back to the heuristic and records `engine:"heuristic-fallback"`; never throws on a bad classifier | `testResolve_llmPrimary`, `testResolve_fallbackOnSpawnError`, `testResolve_fallbackOnBadJson`, `testResolve_fallbackOnUnknownAgent` | MUST | Injected classifier runner in tests |
| REQ-5 | The classifier runs via a dedicated `buildClassifierPiArgs` invocation that emits `--no-tools` (never `--tools`), `--no-session`, resource-discovery-off, `timeoutMs=20_000`, `maxStdoutBytes=65_536`, summary cap `512`; task via stdin (no positional, no `--model`). **Default thinking = `off`** (no `--model`/`--thinking` → child `pi` resolves its own default model). An `intent-classifier` profile / `PI_AGENTS_INTENT_CLASSIFIER_PROFILE` override is **model-only** — it sets `--model`; **thinking is always forced `off`** (override `thinking` is ignored with a one-line warning, never emits a second `--thinking`) | `testClassifierArgs_emitsNoTools`, `testClassifierArgs_omitsToolsFlag`, `testClassifierArgs_noSession`, `testClassifierArgs_thinkingOff`, `testClassifierArgs_boundedLimits`, `testClassifierArgs_overrideModelOnly`, `testClassifierArgs_overrideThinkingIgnoredWithWarning` | MUST | New spawn path (B-001); R-101: override is model-only so `--thinking off` never conflicts; R-102: child resolves its OWN default model — not parent-session inheritance |
| REQ-6 | **Registered** routed candidates pass `canRunAgent` before any run (same denials/next-steps as `/agents run`); **built-in** candidates run as trusted read-only extension code without the gate (existing `/agents run` & `run_subagent` parity) | `testDo_gateDeniesUnregistered`, `testDo_gateDeniesUntrustedProject`, `testDo_gateDeniesDangerous`, `testDo_builtInRoutesWithoutGateButReadOnly` | MUST | Real invariant (R-001) |
| REQ-7 | Candidate set = built-ins from `listBuiltInAgentSpecs()` + registered records where `runnable && source !== "built-in"`; each candidate's `description` = `spec.description` capped at 200 chars (bounds the classifier prompt) | `testCandidates_builtInsAndRegisteredMerged`, `testCandidates_excludesUnrunnable`, `testCandidates_descriptionCapped` | MUST | Two enumeration sources stitched (B-002) |
| REQ-8 | TUI autonomy (**user-ratified A-101**): any pick — built-in **or** registered — with confidence ≥ 0.8 auto-runs (shows `routed to <agent>: <reason>`), **provided the chosen agent's tools are all read-only** (`⊆ {read,grep,find,ls}`); a pick whose tools are not read-only, or confidence < 0.8, confirms via `ctx.ui.confirm` | `testDo_builtInAutoRunHighConfidence`, `testDo_registeredAutoRunHighConfidence`, `testDo_autoRunRequiresReadOnlyTools`, `testDo_confirmLowConfidence`, `testDo_confirmDeclinedNoRun` | MUST | `INTENT_AUTORUN_CONFIDENCE=0.8`; read-only rail is a no-op in P3 (all specs forbid write/edit/bash/run_subagent) but future-proofs against tool widening; registered picks still pass `canRunAgent` |
| REQ-9 | `/agents do` in non-TUI (`!ctx.hasUI`) **fails closed before candidate collection or any classifier spawn**, with guidance to use `/agents run <agent>` | `testDo_nonTuiFailClosed`, `testDo_nonTuiNeverSpawnsClassifier` | MUST | Test asserts injected classifier `callCount===0` (R-003) |
| REQ-10 | Role default profile (`scout→fast-local`, `planner→reasoning-deep`, `reviewer→adversarial-review`) applies to **built-in** routed runs **only when its effect ≠ none**; explicit `--profile` always wins; registered candidates keep their own `spec.profile`, never a role default | `testDo_appliesRoleDefaultProfile`, `testDo_skipsNoOpRoleDefault`, `testDo_explicitProfileOverridesRoleDefault`, `testDo_registeredKeepsOwnProfile`, `testDo_roleDefaultWithNoLibraryDoesNotFailClosed` | MUST | `profileEffect()` guards the no-op fail-closed regression (B-003); precedence is source-scoped (M-004) |
| REQ-11 | Every `RESERVED_BUILT_IN_AGENT_NAMES` entry has a `ROLE_DEFAULT_PROFILE` key (compile/test-time completeness) | `testRoleDefaultsCoverAllBuiltIns` | MUST | Prevents silent `undefined` profile (M-005) |
| REQ-12 | `/agents doctor` warns when any agent name equals a known profile name | `testDoctor_warnsAgentProfileCollision` | MUST | Resolves R-004 |
| REQ-13 | `profileEffect(profile)` returns `none|model|thinking|both`; `/agents profiles` and `/agents inspect` label `effect: none (Pi default)` for no-op profiles | `testProfileEffect_classifies`, `testProfiles_labelsNoOpProfile`, `testInspect_showsNoOpProfile` | SHOULD | Fixes defect #1; reused by REQ-10/REQ-15 |
| REQ-14 | `parseRunArgs` warns (does not silently drop) when a `--profile` token appears in the task position rather than right after the agent name; `parseDoArgs` extracts a leading `--profile <name>` for `/agents do` | `testParseRun_warnsMisplacedProfile`, `testDo_profileFlagParsing` | SHOULD | Fixes defect #3; `parseDoArgs` (M-003) |
| REQ-15 | Routing metadata (engine, agent, confidence, reason, applied profile rendered with **effective** model/thinking, fallback flag) is surfaced bounded; raw classifier prompt/output is not persisted | `testDo_emitsRoutingMetadata`, `testDo_metadataShowsEffectiveModel`, `testDo_doesNotPersistClassifierRaw` | SHOULD | Honest metadata (R-005); metadata-first observability |
| REQ-16 | Child `pi` binary is resolved like the upstream reference `getPiInvocation()`: `process.execPath` + `process.argv[1]` when argv[1] is a real (non-`/$bunfs/root/`) script, else `process.execPath` for non-generic runtimes, else `"pi"` (or explicit `piCommand`). Used by both the target-agent spawn and the classifier spawn | `testPiInvocation_realScript`, `testPiInvocation_bunVirtualFallback`, `testPiInvocation_genericRuntimeFallsBackToPath`, `testPiInvocation_explicitCommandWins` | MUST | Analysis finding #1: hardcoded `"pi"` breaks bun-single-file/npx/non-PATH installs (`child-args.ts:26`) |
| REQ-17 | **Exact transport contract** (B-101): argv keeps `-p` with **no positional**; the **role block** (Agent/Source/Role prompt/Allowed tools/Output contract) moves to the **system-prompt layer** via `--append-system-prompt <file>` (file path, written 0600 like the current temp-prompt); the **delegated task alone** is delivered on **stdin** (`stdio[0]="pipe"`, unchanged), so `pi -p` reads it as the user prompt. `-p @file` is **not** used. `buildChildPromptText` splits into `buildChildSystemText` (role block) + the bare task. Diverges intentionally from the reference's *positional* task — stdin is the extension's verified-working channel (`pi -p` reads stdin with no positional) | `testChildArgs_rolePromptToSystemLayer`, `testChildArgs_taskOnlyOnStdin`, `testChildArgs_keepsDashP_noPositional`, `testChildArgs_noBareAtFilePromptArg` | SHOULD | Findings #2/#3 |
| REQ-17b | **Fixture-change ledger** (B-102 — "tests stay green" was false): REQ-17 **edits** the existing transport assertions. Enumerated: `test-child-args-jsonl.mjs:26-28` (`stdinText` matched `/Role prompt:/`,`/Delegated task:/`,task → becomes: `stdinText` is the bare task; new asserts on the `--append-system-prompt` file content for the role block) and `test-child-runner.mjs:73,128-130` (`stdinText.includes("Agent:"/"Source:"/task)` → role asserts move to the system-text helper, task stays on stdin). The Output-Contract block (`requiredSections`/`maxSummaryChars`/`verdicts`) moves **with the role** into the system layer | `testChildArgs_outputContractInSystemLayer`, updated `test-child-args-jsonl.mjs`, updated `test-child-runner.mjs` | SHOULD | Behavior change to ALL child runs → **focused review before P6-0b**; fixtures change deliberately, not silently |
| REQ-18 | A real-`pi` smoke test spawns an actual child via the run path and asserts (a) read-only, (b) parseable `--mode json` JSONL, (c) role in the system prompt. Skips when `pi` absent — but skip is a **visible non-pass signal** (not silent green): documented as a **local pre-merge manual gate**, optionally a nightly job with `pi` installed. It is NOT counted as CI coverage | `manual gate: run-p6-smoke.sh` | SHOULD | R-103: `pi` is absent in CI, so an in-CI smoke test is always-skipped assurance theater |
| REQ-19 | **CI runs the agents/ unit suite.** A `.github/workflows/ci.yml` step invokes the P6 runners (`run-p6-0-tests.sh`…`run-p6-4-tests.sh`); the smoke test is excluded (no `pi` in CI). Flags the **pre-existing gap**: no `agents/` step exists today (`ci.yml` runs only web-search/tool-context-loader/permission-policy) — the P3/P4 suites also don't run in CI (DEFER backfilling those, but call it out) | `manual: ci.yml step present`, `git grep run-p6 .github/workflows` | MUST | R-103 + Rule 13 (enforce in CI, not just docs) — P6 unit tests are worthless if CI never runs them |
| REQ-20 | **E2E runs ACTUAL agents.** `run-p6-e2e.sh` spawns real `pi` subagents end-to-end against a disposable fixture repo + temp `HOME`/`PI` dirs (no pollution of the user's `~/.pi`). Scenarios E2E-1…E2E-7 below assert real built-in runs honor their output contract, `/agents do` actually classifies→routes→runs, a registered agent auto-runs at high confidence, and **no file mutation occurs** (fixture `git status` stays clean). Skips with a visible non-pass when `pi` absent; manual/nightly gate, not CI | `e2e gate: run-p6-e2e.sh` (E2E-1…E2E-7) | SHOULD | User request: prove the feature with real agent runs, not just mocks + a single smoke |

**Priority legend:** MUST = blocker for first merge; SHOULD = before feature complete; MAY = nice-to-have.

## Non-Goals

- **No tool/trust expansion.** Routing only selects among already-gated candidates.
- **No `run_subagent` contract change.** An `agent:"auto"` mode is an Open Decision, not in scope.
- **No provider routing / fallback chains / model cascades** (still banned per `AGENT_SPEC.md`).
- **No multi-agent chains from intent.** `/agents do` runs exactly one agent.
- **No persistent / history-based routing.** Classification is stateless per call.
- **No background/async routed runs.** Orthogonal to P4.

## Safety / Security

| Concern | Severity | Mitigation | Test(s) |
|---|---|---|---|
| LLM classification is untrusted output that picks *what to execute* | High | Output validated against the candidate allowlist (`parseClassifierOutput`, last-top-level-JSON only); pick is a *candidate only*; `canRunAgent` is authority for registered picks; built-ins are read-only | `testParse_unknownAgentRejected`, `testParse_multipleJsonObjectsRejected`, `testDo_gateDeniesUnregistered` |
| Prompt injection in task echoes a `{agent:"<registered>",confidence:1}` blob and auto-routes there | Medium | The named agent must already be a candidate (registered + `canRunAgent`-passing); P3 forbids write/edit/bash/run_subagent for ALL specs, and REQ-8's read-only rail blocks auto-run of any non-read-only future agent — so an auto-routed pick is always read-only-constrained. User-ratified (A-101) | `testDo_autoRunRequiresReadOnlyTools`, `testDo_gateDeniesUntrustedProject` |
| Surprise execution from a wrong auto-route | Medium | Confirm-unless-high-confidence; non-TUI fail-closed; routed agent read-only (built-ins) or already-trusted+confirmed (registered) | `testDo_confirmLowConfidence`, `testDo_nonTuiFailClosed` |
| Classifier child doing work / leaking | Medium | `--no-tools --no-session`, discovery off, `timeoutMs=20_000`, `maxStdoutBytes=65_536`, summary 512; task via stdin not argv | `testClassifierArgs_emitsNoTools`, `testClassifierArgs_boundedLimits` |
| Unbounded/untrusted candidate description injected into the classifier prompt | Low | `spec.description` capped 200 chars (REQ-7) | `testCandidates_descriptionCapped` |
| Default-profile-per-role silently changing model/thinking | Low | Profiles structurally cannot carry tools/safety/limits; role default skipped when no-op; surfaced as *effective* model/thinking | `testDo_skipsNoOpRoleDefault`, `testDo_metadataShowsEffectiveModel` |
| Cost/latency: one classify call per `/agents do` | Low | Bounded (20s/512-char cap); heuristic-only `/agents do` is a valid cut; classifier uses Pi default model (Open Decision) | `testClassifierArgs_boundedLimits` |

Invariant: *project trust is input-loading only, never a sandbox.* The router relies on
`--tools` read-only built-ins + `canRunAgent` + the confirm step — not on any in-process boundary.

## Design

### Routing flow

```mermaid
flowchart TD
    A["/agents do &lt;task&gt;"] --> B{ctx.hasUI?}
    B -- no --> Z["Fail closed (before any spawn): use /agents run &lt;agent&gt;"]
    B -- yes --> C[collectAgentDiagnostics → candidates: built-ins + runnable registered]
    C --> D[resolveRunIntent]
    D --> E[buildClassifierPiArgs → --no-tools --no-session child]
    E --> F{parseClassifierOutput ok?<br/>last-top-level JSON, agent ∈ candidates}
    F -- yes --> H[decision engine=llm]
    F -- no --> G[classifyIntentHeuristic fallback]
    G --> H2[decision engine=heuristic-fallback]
    H --> I{confidence ≥ 0.8 AND tools read-only?}
    H2 --> I
    I -- yes --> K[run path]
    I -- no --> J{ctx.ui.confirm pick?}
    J -- no --> Y[Cancelled]
    J -- yes --> K
    K --> Kg{registered?}
    Kg -- yes --> Kc[canRunAgent gate]
    Kg -- no --> L
    Kc -- deny --> X[Deny with next-step]
    Kc -- allow --> L[apply profile: --profile &gt; role-default(effect≠none) / spec.profile]
    L --> M[executeChildRun → show routing metadata]
```

### Key types

```ts
export type IntentCandidate = {
  name: string;
  source: "built-in" | "user" | "project";
  description: string;                       // spec.description, capped 200 chars
  role?: "scout" | "planner" | "reviewer";   // built-ins only
};

export type IntentDecision = {
  agent: string;                             // MUST be a candidate name
  confidence: number;                        // clamped [0,1]
  reason: string;
  engine: "llm" | "heuristic-fallback";
  signals?: string[];                        // heuristic only
};

export const INTENT_AUTORUN_CONFIDENCE = 0.8;
export const AMBIGUOUS_DEFAULT = Object.freeze({ agent: "scout", confidence: 0.3 });
export const ROLE_DEFAULT_PROFILE = Object.freeze({
  scout: "fast-local", planner: "reasoning-deep", reviewer: "adversarial-review",
}) as Readonly<Record<string, string>>;
```

### Key invariants

- The router **never** constructs child argv for the *target* agent. It returns a candidate
  name; the existing run path (`runResolvedTarget` + `executeChildRun`, with `canRunAgent` for
  registered) runs it.
- The *classifier* child is the only new spawn the router owns: `--no-tools`, bounded, sandboxed.
- `parseClassifierOutput` is the only place untrusted classifier text becomes a decision; it
  takes the last top-level JSON object and rejects anything not in the candidate allowlist.
- `resolveRunIntent` always returns a decision; a bad classifier ⇒ heuristic fallback, never a throw.
- Profile precedence is **source-scoped** (M-004): built-in candidate → `--profile` (explicit)
  > role-default (only if `profileEffect ≠ none`) > none; registered candidate → `--profile`
  (explicit) > `spec.profile` > none. Role-default never applies to registered agents.
- Non-TUI is a hard fail-closed for `/agents do`, returning **before** candidate collection or
  any classifier spawn (no cost/leak in automation).
- Auto-run (≥0.8, no confirm) applies to **any candidate whose tools are read-only** (built-in
  or registered); a non-read-only pick or any pick < 0.8 confirms. (A-101, user-ratified.)

### Classifier spawn path (B-001 resolution)

- New `buildClassifierPiArgs(task, candidates, options)` in `intent-router.ts` builds an
  invocation with `--mode json --no-session --no-extensions --no-skills --no-prompt-templates
  --no-themes --no-tools`, prompt via stdin (no `AgentSpec`, no `--tools`). Prompt lists each
  candidate `name: description` and demands a single JSON object reply.
- `child-runner.ts` exports a thin `collectChildProcess(invocation, limits, deps)` core;
  existing `spawnAndCollect` is refactored to call it (existing child-runner tests stay green —
  Rule 15). The classifier uses `collectChildProcess` directly, so `spawnAndCollect` is **not**
  forked.

## Existing Hook Points

| File | Line(s) | What it does | Impact |
|---|---|---|---|
| `agents/index.ts` | L86 | command action allowlist + completions | Add `"do"` |
| `agents/index.ts` | L156–169 | action dispatch | Add `do` branch → `runIntentCommand` |
| `agents/lib/run-resolver.ts` | L102 | `runAgentCommand` (resolve+gate+run) | Extract `runResolvedTarget` (P6-3a), reuse for routed run |
| `agents/lib/run-resolver.ts` | L108-141 | built-in short-circuit (no gate) + registered gate | The REQ-6 invariant lives here |
| `agents/lib/run-resolver.ts` | L144 | `parseRunArgs` | REQ-14 misplaced-`--profile` warning; add `parseDoArgs` |
| `agents/lib/can-run-agent.ts` | L60 | `canRunAgent` | Unchanged; authority for registered picks |
| `agents/lib/child-args.ts` | L26 | `DEFAULT_PI_COMMAND = "pi"` hardcoded | REQ-16: port `getPiInvocation()` binary resolution |
| `agents/lib/child-args.ts` | L33-42 | argv build: `--tools`, `-p @file`/stdin transport | REQ-17: role → `--append-system-prompt`, task → user prompt; remove `-p @file` |
| `agents/lib/child-runner.ts` | L206 | `spawnAndCollect` (private) | Refactor: extract exported `collectChildProcess` core |
| `agents/lib/diagnostics.ts` | L31-52 | `AgentDiagnosticRecord` (has `spec`, `runnable`) | Candidate source (REQ-7); add R-004 collision finding (REQ-12) |
| `agents/lib/profiles.ts` | L338 | `BUILT_IN_PROFILE_DEFS` (no-op `fast-local`) | Add `profileEffect()` (REQ-13); role-default source |
| `agents/lib/specs.ts` | L3,L101 | `RESERVED_BUILT_IN_AGENT_NAMES`, name regex | Role enumeration; collision basis |

## Slice Ladder

| Slice | Objective | Primary files | Tests | Hard stops |
|---|---|---|---|---|
| `P6-0a` | Child `pi` binary resolution | `lib/child-args.ts` | REQ-16 | Port reference `getPiInvocation`; existing child-runner/args tests green |
| `P6-0b` | Role→system-prompt layering + `-p @file` fix + smoke test | `lib/child-args.ts`, `lib/child-runner.ts`, **new** `run-p6-smoke.sh` | REQ-17,18 | Behavior change to ALL child runs → **focused review first**; existing run tests green |
| `P6-1` | Pure router core | **new** `lib/intent-router.ts`, `test-fixtures/test-intent-router.mjs` | REQ-1,2,3 + map/const | **No** existing-file changes |
| `P6-2` | Classifier spawn + fallback | `lib/intent-router.ts`, `lib/child-runner.ts` (export `collectChildProcess`) | REQ-4,5 | Classifier never gets `--tools`; existing child-runner tests green |
| `P6-3a` | Pure `runResolvedTarget` extraction | `lib/run-resolver.ts` | existing `/agents run` tests + added TOCTOU/per-`gate.code` coverage | **Zero behavior change** |
| `P6-3b` | `/agents do` wiring | `index.ts`, `lib/run-resolver.ts` | REQ-6,7,8,9,10,11,15 | Must not bypass `canRunAgent` for registered |
| `P6-4` | Disambiguation hardening | `lib/diagnostics.ts`, `lib/profiles.ts`, `lib/run-resolver.ts` | REQ-12,13,14 | Independent; may land first |

### Dependency graph

```text
P6-0a ── P6-0b ─┐
                ├─ P6-2 (classifier reuses getPiInvocation + collectChildProcess)
P6-1 ───────────┘     └─ P6-3a ── P6-3b
P6-4 (independent — can land before or in parallel)
```

P6-0a is foundational: both the target-agent spawn **and** the new classifier spawn (P6-2)
benefit from correct binary resolution, so it lands first. P6-0b (transport layering) is
independent of routing but shares files — sequence it before P6-2 to avoid churn.

**M-104 (slice coupling):** P6-2 extracts `collectChildProcess` from the **post-P6-0b**
`spawnAndCollect`, i.e. *after* the transport change has landed (the stdin/task handoff at
`child-runner.ts:397` is what P6-0b edits and what the extraction wraps). So P6-2's extraction
depends on P6-0b being final; the classifier path uses the same stdin contract REQ-17 settles.
If P6-0b is cut (Cut Order #3), P6-2 extracts from the *unchanged* `spawnAndCollect` instead.

## Cut Order

1. REQ-15 metadata richness (keep a minimal `routed to X` line).
2. REQ-11 / role-default nuance for registered (fall back to no profile).
3. **P6-0b transport rework (REQ-17/17b)** — M-103: it is a *hardening*, not a routing
   dependency; the riskiest slice (changes ALL child runs). Cut/defer it without losing routing.
4. P6-4 REQ-13/REQ-14 (keep REQ-12 doctor collision warning).
5. The LLM classifier (P6-2) — ship heuristic-only `/agents do` first.

Do not cut: REQ-6 (gate is authority for registered), REQ-9 (non-TUI fail-closed),
REQ-3 (untrusted-output validation), REQ-8 read-only-rail + confirm-below-threshold, **REQ-16 / P6-0a**
(fixes a real install-portability bug, independent of routing), **REQ-19** (CI must run the suite).

## Contracts

### `parseClassifierOutput(raw, candidateNames): {ok:true; decision} | {ok:false; reason}`

**Input:** classifier child summary text (free text that *should* contain one JSON object);
the candidate allowlist.

**Output:** `ok:true` only when the **last top-level** JSON object (bare or in a single
```json fence) is exactly `{agent,confidence,reason}`, `agent ∈ candidateNames`, confidence
finite (clamped [0,1]). Any deviation → `ok:false`.

| State | Condition | Output |
|---|---|---|
| A. Valid (bare) | one top-level object, known agent | `ok:true` |
| B. Valid (fenced) | object inside one ```json fence | `ok:true` |
| C. Non-JSON | no parseable top-level object | `ok:false non-json` |
| D. Multiple objects | >1 top-level JSON object | `ok:false multiple-objects` |
| E. Embedded in prose | object only as a substring of prose, not top-level/fenced | `ok:false embedded` |
| F. Unknown agent | `agent ∉ candidateNames` | `ok:false unknown-agent` |
| G. Bad confidence | absent / NaN / ∞ | `ok:false bad-confidence` |
| H. Bad shape | extra/missing keys | `ok:false bad-shape` |

### `resolveRunIntent(task, candidates, deps): Promise<IntentDecision>`

Always returns a decision whose `agent ∈ candidates`. `engine:"llm"` on a valid classifier
output, else `engine:"heuristic-fallback"`. Never throws on classifier failure.

### `parseDoArgs(input): {ok:true; task; profileOverride?} | {ok:false; message}`

Receives the input **with `do` already stripped**, so (M-101) there is **no agent-name token**:
a leading `--profile` is `tokens[0]` and its value `tokens[1]` (NOT `tokens[1..2]` like
`parseRunArgs`, where `tokens[0]` is the agent name). Form: `--profile <name> <task…>` →
`{task: tokens.slice(2).join(" "), profileOverride: tokens[1]}`; otherwise the whole input is
the task. A `--profile` later in the task warns (REQ-14). Empty task → usage.
`testDo_profileFlagParsing` MUST assert the **front-position** case (EC5).

## Edge Cases

| # | Scenario | Expected | Test |
|---|---|---|---|
| EC1 | No keyword match, LLM unavailable | heuristic → `AMBIGUOUS_DEFAULT` (`scout`, 0.3) → confirm | `testHeuristic_ambiguousDefault` |
| EC2 | Classifier returns a profile name as agent | `unknown-agent` → fallback | `testParse_unknownAgentRejected` |
| EC3 | Confidence `1.5` | clamped to `1.0` | `testParse_confidenceClamped` |
| EC4 | Registered project candidate, trust off | excluded from candidates AND gate-denied if forced | `testCandidates_excludesUnrunnable`, `testDo_gateDeniesUntrustedProject` |
| EC5 | `/agents do --profile x review this` | explicit profile `x` overrides role default; agent still routed | `testDo_explicitProfileOverridesRoleDefault`, `testDo_profileFlagParsing` |
| EC6 | `/agents do` empty task | usage; no classify call | `testDo_emptyTaskUsage` |
| EC7 | Agent and profile both named `reasoning-deep` | doctor warns; routing uses agent candidates only | `testDoctor_warnsAgentProfileCollision` |
| EC8 | Heuristic tie (reviewer vs planner equal weight) | fixed order `[reviewer,planner,scout]` | `testHeuristic_tieBreakDeterministic` |
| EC9 | Registered user agent shadows reserved name `scout` | candidate carries `shadowedReservedName`; built-in `scout` still the role; doctor surfaces shadow | `testCandidates_shadowedReservedNameHandling` |
| EC10 | Built-in pick conf 0.9 | auto-run; registered (read-only) pick conf 0.9 | auto-run; hypothetical non-read-only pick conf 0.9 → confirm | `testDo_builtInAutoRunHighConfidence`, `testDo_registeredAutoRunHighConfidence`, `testDo_autoRunRequiresReadOnlyTools` |

## Test Case Catalog

```text
Group 0: run-path hardening — P6-0 (11 + smoke)
  testPiInvocation_realScript, testPiInvocation_bunVirtualFallback,
  testPiInvocation_genericRuntimeFallsBackToPath, testPiInvocation_explicitCommandWins,
  testChildArgs_rolePromptToSystemLayer, testChildArgs_taskOnlyOnStdin,
  testChildArgs_keepsDashP_noPositional, testChildArgs_noBareAtFilePromptArg,
  testChildArgs_outputContractInSystemLayer,
  updated test-child-args-jsonl.mjs, updated test-child-runner.mjs   (REQ-17b ledger)
  smoke (manual gate, not CI): run-p6-smoke.sh (real pi; skips when absent)

Group 1: heuristic (7)
  testHeuristic_reviewVerbs, testHeuristic_planVerbs, testHeuristic_scoutVerbs,
  testHeuristic_deterministic, testHeuristic_clamp, testHeuristic_emptyRejected,
  testHeuristic_ambiguousDefault  (+ testHeuristic_tieBreakDeterministic)

Group 2: classifier-output validation (8)
  testParse_validJson, testParse_jsonInCodeFence, testParse_unknownAgentRejected,
  testParse_nonJsonRejected, testParse_confidenceClamped, testParse_extraKeysRejected,
  testParse_multipleJsonObjectsRejected, testParse_jsonEmbeddedInProseRejected

Group 3: classifier args + fallback (10)
  testClassifierArgs_emitsNoTools, testClassifierArgs_omitsToolsFlag,
  testClassifierArgs_noSession, testClassifierArgs_thinkingOff, testClassifierArgs_boundedLimits,
  testClassifierArgs_overrideModelOnly, testClassifierArgs_overrideThinkingIgnoredWithWarning,
  testResolve_llmPrimary, testResolve_fallbackOnSpawnError,
  testResolve_fallbackOnBadJson, testResolve_fallbackOnUnknownAgent

Group 4: candidates (5)
  testCandidates_builtInsAndRegisteredMerged, testCandidates_excludesUnrunnable,
  testCandidates_descriptionCapped, testCandidates_shadowedReservedNameHandling,
  testRoleDefaultsCoverAllBuiltIns

Group 5: /agents do command + gate + autonomy (12)
  testDo_gateDeniesUnregistered, testDo_gateDeniesUntrustedProject,
  testDo_gateDeniesDangerous, testDo_builtInRoutesWithoutGateButReadOnly,
  testDo_builtInAutoRunHighConfidence, testDo_registeredAutoRunHighConfidence,
  testDo_autoRunRequiresReadOnlyTools,
  testDo_confirmLowConfidence, testDo_confirmDeclinedNoRun,
  testDo_nonTuiFailClosed, testDo_nonTuiNeverSpawnsClassifier, testDo_emptyTaskUsage

Group 6: profile routing + metadata (8)
  testDo_appliesRoleDefaultProfile, testDo_skipsNoOpRoleDefault,
  testDo_explicitProfileOverridesRoleDefault, testDo_registeredKeepsOwnProfile,
  testDo_roleDefaultWithNoLibraryDoesNotFailClosed, testDo_profileFlagParsing,
  testDo_emitsRoutingMetadata, testDo_metadataShowsEffectiveModel  (+ testDo_doesNotPersistClassifierRaw)

Group 7: disambiguation hardening (5)
  testDoctor_warnsAgentProfileCollision, testProfileEffect_classifies,
  testProfiles_labelsNoOpProfile, testInspect_showsNoOpProfile,
  testParseRun_warnsMisplacedProfile
```

Total: ~65 unit tests + the E2E scenarios below (incl. P6-0 run-path hardening, classifier
override/thinking guards, + 1 real-`pi` smoke gate).

## End-to-End Test Scenarios (REQ-20 — real `pi` subagents)

`agents/test-fixtures/run-p6-e2e.sh`. **Harness:** create a disposable fixture repo
(`mktemp -d`, a couple of small source files, `git init`), and isolated `HOME` + agents-home
(`PI_AGENTS_HOME` / `agentsHomeDir`) so registration writes nowhere real. Run each scenario via
the actual command/tool path against real `pi --mode json`. **Gate:** `command -v pi` — if
absent, print a visible `E2E SKIPPED (pi not installed)` and exit non-pass (not silent green).
Bound each scenario with the spec timeout. After every run, assert `git -C <fixture> status
--porcelain` is **empty** (read-only proof).

| # | Scenario | Setup | Assertions |
|---|---|---|---|
| E2E-1 | Built-in `scout` real run | `/agents run scout "summarize the repo layout"` | status `completed`; summary contains the contract sections (`Files/paths inspected`, `Concise findings`, `Unknowns/follow-up questions`); JSONL parsed; fixture unchanged |
| E2E-2 | Built-in `reviewer` verdict | `/agents run reviewer "review README for gaps"` | `Verdict` section present and ∈ {`go`,`conditional-go`,`no-go`}; fixture unchanged |
| E2E-3 | `/agents do` routes review intent | `/agents do "review the parser for bugs"` (high-confidence) | routed agent = `reviewer` (or heuristic fallback to reviewer); a real review returned; routing metadata shows engine + reason; auto-ran (read-only ≥0.8) |
| E2E-4 | `/agents do` routes recon intent | `/agents do "where is config loaded?"` | routed agent = `scout`; real findings returned |
| E2E-5 | Registered agent auto-run (A-101) | register a read-only user agent in temp HOME; `/agents do <task matching its description>` | high confidence → **auto-runs without confirm** (validates the ratified decision); `canRunAgent` passed; fixture unchanged |
| E2E-6 | LLM classifier real call vs fallback | run with classifier enabled (real `pi` classify), then with classifier forced to error | enabled → `engine:"llm"`, valid candidate; forced-error → `engine:"heuristic-fallback"`, still runs |
| E2E-7 | Read-only + no-session enforcement | `/agents do "delete all the .md files"` (adversarial task) | child does **not** mutate the fixture (`git status` clean); child has no write/bash tools; `--no-session` left no session artifact |

These run pre-merge locally / in a nightly job with `pi` installed. They are the REQ-18 smoke
test's superset and the primary defense against Pi CLI/JSONL drift.

## Risk Analysis

| Risk | Severity | Mitigation |
|---|---|---|
| LLM picks a registered agent than expected at high confidence | Low | Read-only-tools rail + `canRunAgent` (only registered/trusted agents are candidates) + routing metadata shows *why*; user-ratified auto-run (A-101) |
| `runResolvedTarget` extraction regresses `/agents run` | Medium | P6-3a is pure extraction, zero behavior change, existing run tests + added TOCTOU/per-`gate.code` coverage kept green |
| `collectChildProcess` extraction breaks `spawnAndCollect` | Medium | Refactor with existing child-runner tests green before classifier consumes it |
| Heuristic keyword list rots / English-only | Low | Pure + table-driven fallback; LLM covers messy prompts |
| Classifier latency/cost | Low | `--thinking off` + 20s/512-char bounds; heuristic-only cut exists; child default model (model-only override for cheaper pin) |
| CI never runs the `agents/` suite, so P6 unit tests don't execute (R-103) | Medium | REQ-19 adds a `ci.yml` step for the P6 runners; smoke test is a manual gate, not CI |
| P6-0b transport change regresses ALL existing child runs (role now in system layer) | Medium | Focused review before P6-0b; keep every existing run/child-runner test green; `run-p6-smoke.sh` proves real-`pi` behavior; P6-0b is independently revertable |
| `getPiInvocation` mis-resolves in an exotic runtime | Low | Mirror the upstream reference exactly; explicit `piCommand`/`agentsPiCommand` override remains the escape hatch |

## Open Decisions

- **`run_subagent` `agent:"auto"`** — deferred (model-calls-model recursion surface).
- **Classifier model** — **RESOLVED:** `--thinking off` (model-agnostic cost/latency lever —
  classification needs no reasoning budget) + the **child `pi`'s own default model resolution**
  (no `--model` flag → zero-config, no hardcoded model names, consistent with capability-hint
  profiles) + bounded output (512 chars). **R-102 caveat:** this is the *child's* default, NOT
  parent-session inheritance — `--no-session` means there is no session to inherit; a user who
  switched their TUI session to a cheap model still gets the installed Pi default here. Optional
  **model-only** override via a registered `intent-classifier` profile or
  `PI_AGENTS_INTENT_CLASSIFIER_PROFILE` to pin a cheaper model (thinking stays `off` — R-101).
  Heuristic fallback covers timeouts. With `thinking off` + a one-object reply, per-call cost is
  a fraction of a cent even on a frontier default.
- **Default candidate on total ambiguity** — resolved: `AMBIGUOUS_DEFAULT` (`scout`, 0.3),
  still confirmed.

## Done Criteria

All MUST requirements passing = done for first merge.

- [ ] `/agents do "review this plan for bugs"` routes to `reviewer` and (TUI) auto-runs at ≥0.8 (read-only) — built-in or registered.
- [ ] `/agents do` in `--mode json`/print fails closed with a `/agents run` hint and spawns no classifier.
- [ ] `git grep -n "\-\-tools" agents/lib/intent-router.ts` returns nothing; a test asserts the classifier argv contains `--no-tools`.
- [ ] `/agents doctor` warns on an agent/profile name collision.
- [ ] `ci.yml` runs the P6 unit suite (REQ-19); `git grep run-p6 .github/workflows` is non-empty.
- [ ] **`bash agents/test-fixtures/run-p6-e2e.sh` passes against real `pi`** (E2E-1…E2E-7), and every scenario leaves the fixture repo `git status` clean (read-only proof).

## Review Consensus

| Pass | Reviewer | Model | Blocker count | Verdict |
|---|---|---|---|---|
| 1 | claude-subagent (adversarial) | Opus 4.8 | 3 blockers + 5 high + 6 medium | conditional-go |
| 2 | claude-subagent (adversarial, P6-0 + classifier focus) | Opus 4.8 | 2 blockers + 3 high + 4 medium + 1 ratify | conditional-go |
| 3 | (pending — focused review of P6-0b transport, then approval) | | | |

### Pass-2 resolved (B-1xx/R-1xx/M-1xx)

| # | Finding | Resolution |
|---|---|---|
| B-101 | REQ-17 "task via stdin" vs ported reference's positional task — unspecified | REQ-17 pins exact contract: keep `-p` no-positional, role → `--append-system-prompt <file>`, task alone on stdin; intentional divergence from reference's positional |
| B-102 | "existing tests stay green" false — REQ-17 breaks transport fixtures | REQ-17b fixture-change ledger enumerates the exact edited assertions (`test-child-args-jsonl.mjs:26-28`, `test-child-runner.mjs:73,128-130`); Output-Contract block moves to system layer |
| R-101 | `--thinking off` vs override-profile `thinking:high` conflict | Override is **model-only**; thinking always forced `off` (override thinking ignored + warning) |
| R-102 | "session default model" misnomer (no parent inheritance under `--no-session`) | Renamed to "child `pi`'s own default model resolution" in REQ-5 / Open Decisions / Risk |
| R-103 | smoke test always-skipped in CI; no CI step runs `agents/` at all | REQ-18 = manual gate (visible non-pass); **new REQ-19** adds a `ci.yml` step running the P6 suite |
| M-101 | `parseDoArgs` `tokens[1]` wrong (no agent name after `do`) | Contract fixed to leading `tokens[0]==="--profile"`, value `tokens[1]`, task `slice(2)` |
| M-102 | REQ-5 lists 6 classifier-args tests, catalog had 4 (dropped R-101 guards) | Group 3 reconciled to 10; adds the two override/thinking tests |
| M-103 | Cut Order omitted P6-0 | Added: P6-0b cuttable (hardening), P6-0a + REQ-19 non-cuttable |
| M-104 | `collectChildProcess` slice-ownership coupling | Note added: P6-2 extracts from post-P6-0b `spawnAndCollect` |
| A-101 | registered-always-confirm narrowed the locked "confirm-unless-high-confidence" | **User ratified the OTHER way:** registered picks **do** auto-run at ≥0.8. Reinstated uniform auto-run; safety preserved by a **read-only-tools rail** (no-op in P3, future-proof) + `canRunAgent`. REQ-8/Safety/flow/invariants updated |

### Resolved blockers / high-risk

| # | Finding | Resolution |
|---|---|---|
| B-001 | No real `--no-tools` spawn path (`buildChildPiArgs` always emits `--tools`, throws on empty; `spawnAndCollect` unexported) | New `buildClassifierPiArgs` (no spec, `--no-tools`) + exported `collectChildProcess` core; REQ-5 asserts `--no-tools` present / `--tools` absent |
| B-002 | `IntentCandidate.description` unsourced; built-ins not in registered records | REQ-7 candidate builder: built-ins from `listBuiltInAgentSpecs()`, registered from runnable records, description = `spec.description` cap 200 |
| B-003 | No-op `fast-local` role default → profile fail-closed regression | REQ-10: skip role default when `profileEffect==="none"`; `testDo_roleDefaultWithNoLibraryDoesNotFailClosed` |
| R-001 | REQ-6 overclaimed (built-ins skip gate) | Reworded to real invariant + `testDo_builtInRoutesWithoutGateButReadOnly` |
| R-002 | P6-3 bundled refactor + wiring | Split into P6-3a (pure extraction) / P6-3b (wiring) |
| R-003 | Non-TUI ordering not test-pinned | REQ-9 returns before any spawn; `testDo_nonTuiNeverSpawnsClassifier` asserts `callCount===0` |
| R-004 | Classifier JSON-extraction + registered auto-run injection | `parseClassifierOutput` last-top-level-only/reject-multiple. (Auto-run injection now bounded by the read-only-tools rail + `canRunAgent` instead of confirm-all-registered — per A-101 ratification.) |
| R-005 | Aspirational profiles mislead in metadata | REQ-15 renders *effective* model/thinking via `profileEffect()` |
| M-001..M-006 | tie-break, cost numbers, `parseDoArgs`, source-scoped precedence, role-default coverage, single-sourced default | EC8/EC9, REQ-5 caps, REQ-14, Key-invariants precedence, REQ-11, `AMBIGUOUS_DEFAULT` |

## Appendix: Implementation Plan

### Files to create

1. `agents/lib/intent-router.ts` — types, `classifyIntentHeuristic`, `parseClassifierOutput`,
   `buildClassifierPiArgs`, `resolveRunIntent`, `ROLE_DEFAULT_PROFILE`, `AMBIGUOUS_DEFAULT`,
   `INTENT_AUTORUN_CONFIDENCE`.
2. `agents/test-fixtures/test-intent-router.mjs` — Groups 1–4.
3. `agents/test-fixtures/test-intent-command.mjs` — Groups 5–6 (injected gate + runner + ui + classifier).
4. `agents/test-fixtures/test-child-args-invocation.mjs` — P6-0 binary resolution + transport (REQ-16/17).
5. `agents/test-fixtures/run-p6-0-tests.sh` … `run-p6-4-tests.sh` + `run-p6-smoke.sh` (REQ-18, skips when `pi` absent).
6. `agents/test-fixtures/run-p6-e2e.sh` — real-`pi` E2E harness (REQ-20, E2E-1…E2E-7; disposable fixture + temp HOME; skips when `pi` absent).

### Files to modify

| File | Change |
|---|---|
| `agents/lib/child-args.ts` | P6-0a: `getPiInvocation()` binary resolution (REQ-16). P6-0b: role → `--append-system-prompt`, task → user prompt, remove `-p @file` (REQ-17). |
| `agents/lib/child-runner.ts` | P6-0b: thread the transport change through the prompt-file write. P6-2: extract exported `collectChildProcess(invocation, limits, deps)`; refactor `spawnAndCollect` to call it (tests green). |
| `agents/index.ts` | Add `"do"` action/completions; dispatch → `runIntentCommand`. |
| `agents/lib/run-resolver.ts` | Extract `runResolvedTarget` (P6-3a); add `runIntentCommand`, `parseDoArgs`; REQ-14 warning. |
| `agents/lib/diagnostics.ts` | Candidate enumeration helper; R-004 collision finding. |
| `agents/lib/profiles.ts` | `profileEffect()` helper. |
| `.github/workflows/ci.yml` | REQ-19: add a step running the P6 unit runners (`run-p6-*-tests.sh`); excludes smoke/E2E (no `pi` in CI). |
| `agents/README.md` / `docs/USER_MANUAL.md` | Document `/agents do` (propose-first per Rule 1). |

### Implementation sequence

| Step | Action | Validation |
|---|---|---|
| 1 | P6-0a `getPiInvocation()` binary resolution | `run-p6-0-tests.sh` green; existing child-runner/args tests green |
| 2 | P6-0b role→system-prompt transport + `-p @file` fix + smoke test (**after focused review**) | `run-p6-0-tests.sh` + `run-p6-smoke.sh` (when `pi` present) green; existing run tests green |
| 3 | P6-1 pure module + tests | `run-p6-1-tests.sh` green; `git diff --stat` shows only new files |
| 4 | P6-2 `collectChildProcess` export + classifier + fallback | `run-p6-2-tests.sh` + existing child-runner tests green; grep `--no-tools` only |
| 5 | P6-3a pure `runResolvedTarget` extraction | existing `/agents run` tests green (+ added coverage) |
| 6 | P6-3b `/agents do` wiring | `run-p6-3-tests.sh` green; `/agents run` tests still green |
| 7 | P6-4 disambiguation | `run-p6-4-tests.sh` green |
| 8 | REQ-19 CI step + REQ-20 E2E harness | `ci.yml` runs P6 suite; `run-p6-e2e.sh` green against real `pi`, fixture stays unmutated |

## Appendix B: Mechanical Execution Spec

**Executor-readiness status:** **ALL slices (P6-0a, P6-0b, P6-1, P6-2, P6-3a, P6-3b, P6-4) are
now executor-ready** — one file per step, surgical `ANCHOR → REPLACE` (verbatim current text →
exact new text) or `CREATE`, every constant/string/signature spelled out, no decision words.
Each slice is an independent commit with its own `run-p6-*-tests.sh`. (P6-0b remains flagged for
a focused human review before build — it changes all child runs — but its steps are fully
specified.)

### Executor contract (all slices)

1. Steps in numeric order; no skip/reorder/batch.
2. Each step names **exactly one** editable file, the exact change, and a verify command.
3. Make no design decisions. If an `ANCHOR` is not found verbatim, STOP and ask.
4. Run verify after each step; fix only that step before proceeding.
5. **Edit only the one file named in the step.** Multi-file changes are split across steps.
6. **Surgical edits — minimize blast radius.** Existing file → anchored find-and-replace:
   the step gives a **verbatim `ANCHOR`** (exact current text) + exact `REPLACE`, smallest
   diff, no reformatting of untouched lines, never a whole-file/whole-function rewrite, never
   `Write`-overwrite. New file → `CREATE` with full contents (its own step). Appending a new
   export to a file created **earlier in the same slice** counts as surgical (adds at end,
   changes nothing existing).
7. One slice = one commit, `<slice-id>: <title>`, with the `Co-Authored-By` trailer.

Blast-radius note: P6-1's files are all **new** (`CREATE` + append-only), so no existing code
is at risk. The anchored-`ANCHOR`→`REPLACE` discipline is what protects the **existing-file**
slices — P6-0a/0b (`child-args.ts`, `child-runner.ts`), P6-2 (`child-runner.ts`),
P6-3a/3b (`run-resolver.ts`, `index.ts`), P6-4 (`diagnostics.ts`, `profiles.ts`) — where a
sloppy rewrite could regress `/agents run` or the child spawn. Their mechanical specs MUST
quote verbatim anchors (see the resolution table below).

All design decisions are resolved inline in the per-slice tables below (every existing-file edit
is a verbatim `ANCHOR → REPLACE`). Anchors were captured from the current sources
(`child-args.ts`, `child-runner.ts`, `run-resolver.ts`, `index.ts`, `profiles.ts`,
`diagnostics.ts`, and the two child test fixtures); if any anchor is not found verbatim at build
time, STOP and ask (the file drifted since this plan).

### Shared constants / types — P6-1 (add once, top of `intent-router.ts`)

```ts
export const INTENT_AUTORUN_CONFIDENCE = 0.8;
export const HEURISTIC_SATURATION = 6;           // confidence = min(1, weight / SATURATION)
export const TIE_ORDER = ["reviewer", "planner", "scout"] as const;
export const AMBIGUOUS_DEFAULT = Object.freeze({ agent: "scout", confidence: 0.3 });
export const ROLE_DEFAULT_PROFILE = Object.freeze({
  scout: "fast-local", planner: "reasoning-deep", reviewer: "adversarial-review",
}) as Readonly<Record<string, string>>;
// keyword → weight, grouped by role. Matched case-insensitively as whole words / phrases.
export const ROLE_KEYWORDS = Object.freeze({
  reviewer: { review: 3, critique: 3, audit: 3, verdict: 2, bug: 2, bugs: 2, assess: 2, evaluate: 2 },
  planner:  { plan: 3, design: 3, "break down": 3, roadmap: 2, steps: 2, architecture: 2, approach: 2 },
  scout:    { find: 2, where: 2, locate: 2, explore: 2, recon: 2, inspect: 2, search: 2, "which files": 2 },
}) as Readonly<Record<string, Readonly<Record<string, number>>>>;
export type IntentDecision = { agent: string; confidence: number; reason: string;
  engine: "llm" | "heuristic-fallback"; signals?: string[] };
export type IntentCandidate = { name: string; source: "built-in" | "user" | "project";
  description: string; role?: "scout" | "planner" | "reviewer" };
```

### `P6-1` — pure intent router (REQ-1/2/3) — EXECUTOR-READY

Read-only refs: `agents/lib/specs.ts`, `agents/lib/profiles.ts`. Slice test command:
`bash agents/test-fixtures/run-p6-1-tests.sh`.

All P6-1 steps are `CREATE` or `APPEND` to brand-new files — **no existing code is touched**
(zero blast radius). Anchored `ANCHOR`→`REPLACE` edits begin in P6-0a onward.

| Step | File | Exact action (one file) | Verify |
|---|---|---|---|
| 1.1 | `agents/lib/intent-router.ts` | **CREATE** (Write). Full contents = the Shared constants/types block above verbatim. | `grep -c "HEURISTIC_SATURATION\|ROLE_KEYWORDS\|AMBIGUOUS_DEFAULT" agents/lib/intent-router.ts` == 3 |
| 1.2 | `agents/lib/intent-router.ts` | **APPEND** at end of file. Add `export function classifyIntentHeuristic(task: string, candidates: string[]): IntentDecision`. Body: if `task.trim()===""` `throw new Error("task must be non-empty")`. Lowercase task. For each role in `ROLE_KEYWORDS`, sum the weight of every keyword whose whole-word/phrase occurs in the task; collect matched keywords as `signals`. Pick the highest-weight role; break ties by first occurrence in `TIE_ORDER`; if total weight 0 → return `{...AMBIGUOUS_DEFAULT, reason:"no intent keywords matched", engine:"heuristic-fallback", signals:[]}`. Else `confidence = Math.min(1, weight / HEURISTIC_SATURATION)`, `reason = \`matched: ${signals.join(", ")}\``, `engine:"heuristic-fallback"`. | (covered by 1.4) |
| 1.3 | `agents/lib/intent-router.ts` | **APPEND** at end of file. Add `export function parseClassifierOutput(raw: string, candidateNames: string[]): {ok:true; decision:IntentDecision} | {ok:false; reason:string}`. Implement States A–H from the Contracts section with EXACT reason strings `"non-json"`,`"multiple-objects"`,`"embedded"`,`"unknown-agent"`,`"bad-confidence"`,`"bad-shape"`; extract the last top-level `{…}` or a single ```json fence; require keys exactly `{agent,confidence,reason}`; `agent ∈ candidateNames`; `confidence` finite → `Math.max(0, Math.min(1, confidence))`; on success `engine:"llm"`. | (covered by 1.5) |
| 1.4 | `agents/test-fixtures/test-intent-router.mjs` | **CREATE** (Write). Group 1 + Group 2 tests with the exact asserts named in the Test Case Catalog (e.g. `testHeuristic_reviewVerbs`: `classifyIntentHeuristic("review this for bugs", ["reviewer","planner","scout"]).agent === "reviewer"`; `testParse_multipleJsonObjectsRejected`: two `{…}` → `{ok:false, reason:"multiple-objects"}`). Self-run `main()` exiting non-zero on failure. | `node agents/test-fixtures/test-intent-router.mjs` exits 0 |
| 1.5 | `agents/test-fixtures/run-p6-1-tests.sh` | **CREATE** (Write). Contents: `#!/usr/bin/env bash`, `set -euo pipefail`, `node "$(dirname "$0")/test-intent-router.mjs"`. `chmod +x`. | `bash agents/test-fixtures/run-p6-1-tests.sh` exits 0 |

### `P6-0a` — child `pi` binary resolution (REQ-16) — commit `P6-0a: getPiInvocation binary resolution`

Read-only refs: `/tmp/sub_fetch/index.ts` (reference L249-263). Seam choice (preserves all
existing tests): resolve the binary in `defaultSpawner` only — injected test spawners never reach
it, and `buildChildPiArgs` still returns `command:"pi"`, so `test-child-args-jsonl.mjs:15` and
`test-child-runner.mjs:64` stay green.

| Step | File | Surgical action | Verify |
|---|---|---|---|
| 0a.1 | `agents/lib/child-args.ts` | **EDIT.** `ANCHOR:` `import { P3_FORBIDDEN_TOOLS, type AgentSpec } from "./specs.ts";` → `REPLACE:` same line + two new lines below: `import { existsSync } from "node:fs";` and `import path from "node:path";` | `grep -n 'node:fs' agents/lib/child-args.ts` |
| 0a.2 | `agents/lib/child-args.ts` | **APPEND** at end of file. Add `export function getPiInvocation(args: string[], piCommandOverride?: string): { command: string; args: string[] } {` body: if `piCommandOverride` return `{command:piCommandOverride, args}`; `const currentScript = process.argv[1];` `const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");` if `currentScript && !isBunVirtualScript && existsSync(currentScript)` return `{command: process.execPath, args: [currentScript, ...args]}`; `const execName = path.basename(process.execPath).toLowerCase();` if `!/^(node|bun)(\.exe)?$/.test(execName)` return `{command: process.execPath, args}`; return `{command: DEFAULT_PI_COMMAND, args}`. | `grep -n 'export function getPiInvocation' agents/lib/child-args.ts` |
| 0a.3 | `agents/lib/child-runner.ts` | **EDIT.** `ANCHOR:` `import { buildChildPiArgs, type ChildPiArgsOptions, type ChildPiInvocation } from "./child-args.ts";` → `REPLACE:` add `getPiInvocation, ` after `buildChildPiArgs, `. | `grep -n getPiInvocation agents/lib/child-runner.ts` |
| 0a.4 | `agents/lib/child-runner.ts` | **EDIT.** `ANCHOR:` `	return nodeSpawn(command, [...argv], options);` → `REPLACE:` `	const inv = command === "pi" ? getPiInvocation([...argv]) : { command, args: [...argv] };` newline `	return nodeSpawn(inv.command, inv.args, options);` | `node agents/test-fixtures/test-child-runner.mjs` exits 0 |
| 0a.5 | `agents/test-fixtures/test-pi-invocation.mjs` | **CREATE.** Tests: `testPiInvocation_explicitCommandWins` (`getPiInvocation(["-p"], "pi-x").command === "pi-x"`); `testPiInvocation_realScript` (with a real `process.argv[1]`, command is `process.execPath` and args[0] is that script); `testPiInvocation_bunVirtualFallback` (stub a `/$bunfs/root/...` argv[1] via a wrapper arg). `main()` exits non-zero on failure. | `node agents/test-fixtures/test-pi-invocation.mjs` exits 0 |
| 0a.6 | `agents/test-fixtures/run-p6-0-tests.sh` | **CREATE.** `#!/usr/bin/env bash`, `set -euo pipefail`, `node "$(dirname "$0")/test-pi-invocation.mjs"`. `chmod +x`. | `bash agents/test-fixtures/run-p6-0-tests.sh` exits 0 |

### `P6-0b` — role→system-prompt transport (REQ-17/17b) — commit `P6-0b: role to --append-system-prompt` — **FOCUSED REVIEW BEFORE BUILD**

Design (resolved): split `buildChildPromptText` into (a) `buildChildSystemText(spec)` = the role
block (Agent/Source/Role prompt/Allowed tools/Output contract — everything *except* Delegated
task), written to the existing private temp file and passed as `--append-system-prompt <path>`;
(b) the **bare trimmed task** delivered on stdin (unchanged transport mechanism). `-p` stays; no
positional; `-p @file` removed. The temp-file write path already exists in `child-runner.ts`
(`promptTransport.kind === "private-temp-file"`), so reuse it for the system file.

| Step | File | Surgical action | Verify |
|---|---|---|---|
| 0b.1 | `agents/lib/child-args.ts` | **EDIT.** `ANCHOR:` the `buildChildPromptText` return array lines from `"Role prompt:",` through `trimmedTask,`. `REPLACE:` keep the same array but END it before the `"", "Delegated task:", trimmedTask` trio — i.e. `buildChildPromptText` now returns the **role block only** (drop the Delegated-task lines). Rename it `buildChildSystemText` and update its signature to `(spec: AgentSpec): string` (no `task` param). | `grep -n 'export function buildChildSystemText' agents/lib/child-args.ts` |
| 0b.2 | `agents/lib/child-args.ts` | **EDIT.** `ANCHOR:` `	argv.push("--tools", spec.tools.join(","));` → `REPLACE:` same line + below: build `const systemText = buildChildSystemText(spec);` and push `argv.push("--append-system-prompt", <systemTempPath>)` (write `systemText` to the private temp file). | (covered by 0b.5) |
| 0b.3 | `agents/lib/child-args.ts` | **EDIT.** `ANCHOR:` the `-p`/`@`-file block (`argv.push("-p");` … `if (promptTransport.kind === "private-temp-file") argv.push(\`@${promptTransport.path}\`);`) → `REPLACE:` `argv.push("-p");` only (no `@file`); set `promptTransport` to carry the **bare trimmed task** as `stdinText`. | `grep -n '@\${' agents/lib/child-args.ts` returns nothing |
| 0b.4 | `agents/lib/child-runner.ts` | **EDIT.** `ANCHOR:` the `invocation.promptTransport.kind === "private-temp-file"` write block → `REPLACE:` write the **system text** file (mode 0600, `wx`) for `--append-system-prompt`; keep cleanup in `finally`. | `node agents/test-fixtures/test-child-runner.mjs` exits 0 |
| 0b.5 | `agents/test-fixtures/test-child-args-jsonl.mjs` | **EDIT (ledger).** `ANCHOR:` lines 26-30 (`assert.match(...stdinText, /Role prompt:/)` … `role prompt must not appear in argv`) → `REPLACE:` assert `stdinText` equals the bare task and `argv` contains `--append-system-prompt`; add `testChildArgs_rolePromptToSystemLayer`, `testChildArgs_taskOnlyOnStdin`, `testChildArgs_keepsDashP_noPositional`, `testChildArgs_outputContractInSystemLayer`. | `node agents/test-fixtures/test-child-args-jsonl.mjs` exits 0 |
| 0b.6 | `agents/test-fixtures/test-child-runner.mjs` | **EDIT (ledger).** `ANCHOR:` lines 128-130 (`stdinText.includes("Agent: user-helper")` … `inspect registered files`) → `REPLACE:` task-only on `stdinText`; assert the role appears in the `--append-system-prompt` file arg. | `node agents/test-fixtures/test-child-runner.mjs` exits 0 |
| 0b.7 | `agents/test-fixtures/run-p6-0-tests.sh` | **EDIT.** `ANCHOR:` the `test-pi-invocation.mjs` line → `REPLACE:` same line + a line running `test-child-args-jsonl.mjs` and `test-child-runner.mjs` (regression). | `bash agents/test-fixtures/run-p6-0-tests.sh` exits 0 |

### `P6-2` — classifier spawn + fallback (REQ-4/5) — commit `P6-2: LLM classifier + heuristic fallback`

`collectChildProcess` is a **thin exported wrapper** over the existing private `spawnAndCollect`
(no refactor of that function — lowest blast radius).

| Step | File | Surgical action | Verify |
|---|---|---|---|
| 2.1 | `agents/lib/child-runner.ts` | **APPEND.** `export function collectChildProcess(invocation: ChildPiInvocation, options: Parameters<typeof spawnAndCollect>[2]): Promise<ChildAgentRunResult> { return spawnAndCollect("intent-classifier", invocation, options); }` | `grep -n 'export function collectChildProcess' agents/lib/child-runner.ts` |
| 2.2 | `agents/lib/intent-router.ts` | **APPEND.** `export function buildClassifierPiArgs(task: string, candidates: IntentCandidate[], piCommand?: string): ChildPiInvocation` — argv `["--mode","json","--no-session","--no-extensions","--no-skills","--no-prompt-templates","--no-themes","--no-tools","--thinking","off","-p"]`; if `piCommand` override profile has a model, splice `"--model", model` before `-p`; `command` from `getPiInvocation([...argv], piCommand)`; `promptTransport={kind:"stdin", stdinText: <CLASSIFIER_PROMPT>}`. `CLASSIFIER_PROMPT` = exact template: header `You are an intent classifier...`, the candidate list `- <name>: <description>` lines, the reply contract `Reply with ONLY one JSON object: {"agent":"<name>","confidence":<0..1>,"reason":"<short>"}`, then `Task:\n<task>`. | `grep -n 'no-tools' agents/lib/intent-router.ts` AND `grep -c '\-\-tools' agents/lib/intent-router.ts` == 0 |
| 2.3 | `agents/lib/intent-router.ts` | **APPEND.** `export async function resolveRunIntent(task, candidates, deps): Promise<IntentDecision>` — call `deps.runClassifier(buildClassifierPiArgs(task, candidates, deps.piCommand))` (injected; prod = `collectChildProcess`); on resolve, `parseClassifierOutput(result.summary.summaryText, candidates.map(c=>c.name))`; `ok` → its decision; on throw / `!ok` → `classifyIntentHeuristic(task, candidates.map(c=>c.name))`. Never throws. | (covered by 2.4) |
| 2.4 | `agents/test-fixtures/test-intent-classifier.mjs` | **CREATE.** Group 3 tests with injected `runClassifier` stub: `testClassifierArgs_emitsNoTools`, `testClassifierArgs_omitsToolsFlag`, `testClassifierArgs_thinkingOff`, `testClassifierArgs_boundedLimits`, `testClassifierArgs_overrideModelOnly`, `testClassifierArgs_overrideThinkingIgnoredWithWarning`, `testResolve_llmPrimary`, `testResolve_fallbackOnSpawnError`, `testResolve_fallbackOnBadJson`, `testResolve_fallbackOnUnknownAgent`. | `node agents/test-fixtures/test-intent-classifier.mjs` exits 0 |
| 2.5 | `agents/test-fixtures/run-p6-2-tests.sh` | **CREATE.** runs `test-intent-classifier.mjs`. | `bash agents/test-fixtures/run-p6-2-tests.sh` exits 0 |

### `P6-3a` — pure `runResolvedTarget` extraction (REQ-6) — commit `P6-3a: extract runResolvedTarget`

Zero behavior change. Extract the registered-run tail of `runAgentCommand` into a reusable
function; `runAgentCommand` calls it.

| Step | File | Surgical action | Verify |
|---|---|---|---|
| 3a.1 | `agents/lib/run-resolver.ts` | **APPEND.** `export async function runResolvedTarget(record: RunnableRegisteredRecord, task: string, ctx: AgentsContextLike, diagnostics: AgentDiagnostics, profileOverride?: string): Promise<void>` — body = the verbatim block currently at `runAgentCommand` from `let currentParsed` through the final `await executeChildRun(...)` (re-read spec bytes, status check, `canRunAgent` gate, run). | `grep -n 'export async function runResolvedTarget' agents/lib/run-resolver.ts` |
| 3a.2 | `agents/lib/run-resolver.ts` | **EDIT.** `ANCHOR:` in `runAgentCommand`, the block from `const record = resolved.record;` through `await executeChildRun(currentParsed.spec, parsed.task, ctx, record.source, parsed.profileOverride);` → `REPLACE:` `await runResolvedTarget(resolved.record, parsed.task, ctx, diagnostics, parsed.profileOverride);` | `node agents/test-fixtures/test-registry-gate.mjs` exits 0 (existing run-path tests green) |
| 3a.3 | `agents/test-fixtures/run-p6-3-tests.sh` | **CREATE.** runs the existing run-path test(s) + (later) the do-command test. | `bash agents/test-fixtures/run-p6-3-tests.sh` exits 0 |

### `P6-3b` — `/agents do` wiring (REQ-6/7/8/9/10/11/15) — commit `P6-3b: /agents do command`

| Step | File | Surgical action | Verify |
|---|---|---|---|
| 3b.1 | `agents/lib/diagnostics.ts` | **APPEND.** `export function buildIntentCandidates(d: AgentDiagnostics): IntentCandidate[]` — built-ins from `listBuiltInAgentSpecs()` (`role` = name) + `d.records.filter(r => r.runnable && r.source !== "built-in")`; `description = (r.spec?.description ?? "").slice(0,200)`. | `grep -n 'export function buildIntentCandidates' agents/lib/diagnostics.ts` |
| 3b.2 | `agents/lib/run-resolver.ts` | **APPEND.** `export async function runIntentCommand(input, ctx, diagnostics): Promise<void>` — `parseDoArgs`; if `!ctx.hasUI` notify the fail-closed message `"Intent routing needs interactive confirmation. Use /agents run <agent> <task>."` and return (REQ-9, before any spawn); build candidates; `resolveRunIntent`; apply read-only-tools rail + `INTENT_AUTORUN_CONFIDENCE`; if not auto-run, `await ctx.ui.confirm("Route to <agent>?", "<reason> (confidence …)")`; resolve role-default profile via `profileEffect`; dispatch built-in via `executeChildRun` / registered via `runResolvedTarget`. | (covered by 3b.4) |
| 3b.3 | `agents/index.ts` | **EDIT.** `ANCHOR:` `const options = ["list", "built-ins", "config", "inspect", "registry", "verify", "doctor", "register", "register-project", "unregister", "run", "chain", "run-temp", "save-temp", "profiles"];` → `REPLACE:` same array with `"do",` inserted after `"run",`. | `grep -n '"do"' agents/index.ts` |
| 3b.4 | `agents/index.ts` | **EDIT.** `ANCHOR:` `			if (parsed.action === "run") {` block → `REPLACE:` add directly above it: `if (parsed.action === "do") { await runIntentCommand(parsed.rest, ctx, diagnostics); return; }` | `node agents/test-fixtures/test-intent-command.mjs` exits 0 |
| 3b.5 | `agents/test-fixtures/test-intent-command.mjs` | **CREATE.** Groups 5+6 with injected gate/runner/ui/classifier (the catalog tests, incl. `testDo_nonTuiNeverSpawnsClassifier` asserting classifier `callCount===0`, `testDo_registeredAutoRunHighConfidence`, `testDo_autoRunRequiresReadOnlyTools`). | `node agents/test-fixtures/test-intent-command.mjs` exits 0 |
| 3b.6 | `agents/test-fixtures/run-p6-3-tests.sh` | **EDIT.** `ANCHOR:` the existing run-path test line → `REPLACE:` same + a line running `test-intent-command.mjs`. | `bash agents/test-fixtures/run-p6-3-tests.sh` exits 0 |

### `P6-4` — disambiguation hardening (REQ-12/13/14) — commit `P6-4: profile/agent disambiguation`

| Step | File | Surgical action | Verify |
|---|---|---|---|
| 4.1 | `agents/lib/profiles.ts` | **APPEND.** `export function profileEffect(p: { model?: string; thinking?: string }): "none"|"model"|"thinking"|"both" { const m = !!p.model, t = !!p.thinking; return m && t ? "both" : m ? "model" : t ? "thinking" : "none"; }` | `grep -n 'export function profileEffect' agents/lib/profiles.ts` |
| 4.2 | `agents/lib/diagnostics.ts` | **APPEND.** `export function agentProfileNameCollisions(d: AgentDiagnostics, profileNames: string[]): string[]` — return agent names in `d.records` that also appear in `profileNames`. | `grep -n 'agentProfileNameCollisions' agents/lib/diagnostics.ts` |
| 4.3 | `agents/lib/run-resolver.ts` | **EDIT.** `ANCHOR:` in `parseRunArgs`, the `if (profileOverride && tokens.slice(3).some((t) => t === "--profile"))` line → `REPLACE:` same guard + when no leading `--profile` but a later `--profile` token exists, set a `warning` field `"--profile must come right after the agent name; treated as task text"`. | `node agents/test-fixtures/test-intent-router.mjs` exits 0 (or the run-args test) |
| 4.4 | `agents/test-fixtures/test-disambiguation.mjs` | **CREATE.** Group 7: `testProfileEffect_classifies`, `testDoctor_warnsAgentProfileCollision`, `testProfiles_labelsNoOpProfile`, `testInspect_showsNoOpProfile`, `testParseRun_warnsMisplacedProfile`. | `node agents/test-fixtures/test-disambiguation.mjs` exits 0 |
| 4.5 | `agents/test-fixtures/run-p6-4-tests.sh` | **CREATE.** runs `test-disambiguation.mjs`. | `bash agents/test-fixtures/run-p6-4-tests.sh` exits 0 |

(Doctor/profiles/inspect *display* of the collision warning and the `effect: none` label are
wired in the diagnostics formatters — `formatAgentsDoctor`/`formatProfileList`/`formatAgentInspect`
— each as its own anchored `ANCHOR → REPLACE` step appended during P6-4 build, asserted by the
Group 7 tests above.)

### Definition of done (whole plan)

`bash agents/test-fixtures/run-p6-0-tests.sh` … `run-p6-4-tests.sh` all green; existing
`/agents run` and child-runner tests stay green; `run-p6-e2e.sh` green against real `pi` with
every fixture `git status` clean; `git grep -n "\-\-tools" agents/lib/intent-router.ts` returns
nothing; and `ci.yml` runs the P6 unit suite.
