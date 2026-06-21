# P7 Prompt-Intent Gate Plan

## Status

Planning only. Do not implement until this plan, plan review, and adversarial review are accepted.

**PREREQUISITE (B1):** The Pi SDK `before_agent_message` hook (or equivalent pre-model user-message
intercept) must be verified to exist, support suppression of the normal model response, and support
system-prompt injection BEFORE any code is written. Without this hook the gate is infeasible.
Verification: install the SDK, read the type defs, confirm the hook fires before tools/edits and the
return value can short-circuit the turn. Flagged as an open track — do not implement P7-1 until resolved.

## Episode Search Summary

Searched episodic memory for prompt-intent gate, RW-1, P6 intent routing, hook points, Pi SDK hooks.

Key active memories:

- `20260621-072212`: Canonical workplan — P6 complete. All primitives exported and test-seamed.
- `20260621-064821`: P6-3b — runIntentCommand, __classifierRunner seam, read-only rail, auto-run rail.
- `20260619-093508`: Prompt intent classification must precede reviewer/profile/tool choice.
- `20260621-092405`: This plan's first review — 13 findings incl. SEC-1 config trust gap, SEC-3 no-confirm rail inheritance, B1 unverified hook.

## Objective

Add a prompt-intent gate to the agents extension that intercepts natural-language user prompts,
matches them against a project-local intent configuration (`.pi/intent-workflows.json`), and
conditionally routes review/plan intents to `/agents do` machinery — all before the model
processes the message. The gate is additive: unmatched prompts pass through unchanged.
The config is a project-trust-gated file defining phrase→workflow mappings.

## Why

P6 delivered `/agents do` — the user still has to type the command. This plan makes agent
invocation ambient: "review this plan for bugs" → reviewer agent runs automatically. The gate runs
first, classification is fast (phrase matching is O(n)), and all P6 safety rails apply — plus
additional gate-specific rails (always-confirm for NL-routed prompts, project-trust gating on
config, code-owned system instructions only).

## Requirements (Ground Truth)

| ID | Requirement | Test(s) | Priority | Notes |
|---|---|---|---|---|
| REQ-1 | Gate SHALL load intent config from `.pi/intent-workflows.json` on session_start; config takes effect ONLY when `ctx.isProjectTrusted() === true` | `testGate_configMissingSkips`, `testGate_untrustedProjectConfigIgnored` | MUST | SEC-1: untrusted repo config is dead; pass-through |
| REQ-2 | Gate SHALL classify user prompt using phrase matching (case-insensitive whole-word) first, then bounded regex if enabled | `testGate_phraseMatch`, `testGate_regexMatch`, `testGate_regexTimeout` | MUST | Regex: max 10 patterns × 256 chars, run under 100ms timeout, non-backtracking recommended; SEC-6 |
| REQ-3 | NL-routed intents SHALL ALWAYS require explicit TUI confirmation before any child spawn, regardless of confidence or read-only status | `testGate_nlRoutingAlwaysConfirms` | MUST | SEC-3: do NOT inherit P6 auto-run rail for NL prompts |
| REQ-4 | Matched review intent SHALL invoke runIntentCommand via /agents do path with confirmation; config profile is a NAME resolved through the trusted profile library only, never an inline model/thinking string | `testGate_reviewRoutesToAgent`, `testGate_configProfileResolvedThroughLibrary`, `testGate_configInlineModelRejected` | MUST | SEC-2: profiles trusted-library-only; inline model rejected at config-load time |
| REQ-5 | Matched plan-only intent SHALL inject a FIXED code-owned system instruction; the injected text is a constant, never supplied by config | `testGate_planOnlyInjectsInstruction`, `testGate_planOnlyInstructionIsCodeOwned` | MUST | SEC-4: config selects kind only; code supplies the instruction text |
| REQ-6 | Gate-routed children SHALL set disableContextFiles:true to prevent untrusted repo context injection | `testGate_routedChildDisablesContextFiles` | MUST | SEC-5 |
| REQ-7 | Unmatched/unknown/ambiguous prompt SHALL pass through to the model unchanged | `testGate_noMatchPassesThrough`, `testGate_ambiguityPassesThrough` | MUST | No friction for normal conversation |
| REQ-8 | Gate SHALL NOT intercept prompts starting with `/` (commands) | `testGate_skipsCommands` | MUST | Don't double-route |
| REQ-9 | Gate SHALL pass through when `ctx.hasUI === false` (non-interactive/CI) | `testGate_nonTuiPassesThrough` | MUST | No auto-execution in CI |
| REQ-10 | Gate SHALL track invocation metadata: intent id, matched phrase, agent, profile | `testGate_recordsMetadata` | SHOULD | Audit trail |
| REQ-11 | Implementation intent (`kind: "implementation"`) SHALL require explicit confirmation enforced by the GATE before delegating to runIntentCommand | `testGate_implementationEnforcesConfirm` | MUST | SEC-7: gate-level confirm, not relying on downstream |
| REQ-SEC-1 | Config SHALL NOT take effect unless project is trusted | `testGate_untrustedProjectConfigIgnored` | MUST | SEC-1 |
| REQ-SEC-2 | Config profile SHALL be a NAME string resolved through the trusted profile library only; inline model/thinking fields in config SHALL be rejected at load-time | `testGate_configInlineModelRejected` | MUST | SEC-2 |
| REQ-SEC-3 | NL-routed prompts SHALL always require TUI confirm, bypassing P6's confidence/read-only auto-run rail | `testGate_nlRoutingAlwaysConfirms` | MUST | SEC-3 |
| REQ-SEC-4 | Injected system instruction SHALL be code-owned constants; config selects kind only, never supplies instruction text | `testGate_planOnlyInstructionIsCodeOwned` | MUST | SEC-5 |
| REQ-SEC-5 | Gate-routed child spawns SHALL set disableContextFiles:true | `testGate_routedChildDisablesContextFiles` | MUST | SEC-4 |
| REQ-SEC-6 | Config regex SHALL run under 100ms timeout; phrase-only matching is the safe default if regex support is cut | `testGate_regexTimeout` | MUST | SEC-6 |
| REQ-SEC-7 | Implementation confirm SHALL be enforced by the gate before delegating | `testGate_implementationEnforcesConfirm` | MUST | SEC-7 |

**Priority legend:** MUST = blocker for first merge; SHOULD = before feature complete.

## Non-Goals

- Does not modify P6 routing logic — consumes exported primitives only.
- Does not replace `/agents do` — the command still works independently.
- Does not add new agent types or profiles.
- Does not handle multi-turn intent tracking (stateless per prompt).
- Does not execute `run_subagent` directly — routes through `/agents do` path.
- Does not add a new Pi extension — integrates into the existing `agents` extension.
- Does not allow config to supply system prompt text, inline model strings, or tool authority.

## Safety / Security

| Concern | Severity | Mitigation | Test(s) |
|---|---|---|---|
| Malicious repo config auto-runs built-in agent silently | High | Config gated on projectTrusted (SEC-1); NL routing always confirms (SEC-3) | `testGate_untrustedProjectConfigIgnored`, `testGate_nlRoutingAlwaysConfirms` |
| Config profile redirects to attacker-chosen model | High | Profile is a NAME resolved through trusted library; inline model rejected at load-time (SEC-2) | `testGate_configProfileResolvedThroughLibrary`, `testGate_configInlineModelRejected` |
| NL-routed prompt auto-runs without user knowledge | High | Always-confirm for NL prompts, regardless of P6 confidence/read-only (SEC-3) | `testGate_nlRoutingAlwaysConfirms` |
| Gate-routed child loads untrusted context files | Medium | disableContextFiles:true on all gate-routed spawns (SEC-5) | `testGate_routedChildDisablesContextFiles` |
| Config-supplied system instruction injects into model | Medium | System instruction is code-owned constant; config selects kind only (SEC-4) | `testGate_planOnlyInstructionIsCodeOwned` |
| Config regex causes catastrophic backtracking | Medium | Regex under 100ms timeout; phrase-only is safe fallback (SEC-6) | `testGate_regexTimeout` |
| Implementation confirm bypassed by P6 read-only rail | Low | Gate enforces confirm itself before delegating (SEC-7) | `testGate_implementationEnforcesConfirm` |

Every mitigation maps to a falsifiable test with a negative control (see Test Case Catalog).

## Design

### Integration point

The gate lives inside the `agents` extension. It intercepts user messages before the model via
the Pi SDK `before_agent_message` hook (PREREQUISITE — must be verified against the installed SDK
before P7-1). Classification is phrase-first, regex-second; both are O(n) over small configs.

### Key types

```ts
// Config schema (P7 owns this — RW-1 schema never materialized; B2 resolved)
type IntentGateConfig = {
  version: 1;
  intents: IntentGateEntry[];
};

type IntentGateEntry = {
  id: string;
  match: {
    phrases: string[];           // case-insensitive whole-word
    regex?: string[];            // optional, bounded (10 max × 256 chars each)
  };
  workflow:
    | { kind: "review"; profile?: string }     // profile NAME, resolved through library
    | { kind: "plan-only" }                     // code-owned instruction injected
    | { kind: "implementation" };               // gate-enforced confirm
};

// Gate decision (exhaustive discriminated union)
type GateDecision =
  | { kind: "route"; agent: string; task: string; profile?: string; metadata: GateMetadata }
  | { kind: "inject"; instruction: GateInstruction }
  | { kind: "confirm"; agent: string; task: string; metadata: GateMetadata }
  | { kind: "pass-through" };

type GateMetadata = { intentId: string; matchedBy: "phrase" | "regex" };
type GateInstruction = "PLAN_ONLY" | "IMPLEMENTATION_CONFIRM"; // code-owned enum only
```

### Key invariants

- Config absent or project untrusted → gate disabled (pass-through for all prompts).
- Config profiles are NAME strings only; validated against profile library at load-time.
- NL-routed prompts ALWAYS confirm in TUI before spawn — P6 auto-run rail not inherited.
- Gate-routed children always get `disableContextFiles: true`.
- System instructions are code-owned constants; config selects `kind` only.
- `/`-prefixed prompts and non-TUI sessions pass through.
- All P6 rails (read-only tools, canRunAgent, classifier sandboxed, task-on-stdin) still apply.

### Flow

```text
User prompt
  → Is ctx.hasUI false? → yes → pass-through
  → Is prompt a /command? → yes → pass-through
  → Is project trusted? → no → pass-through (config dead)
  → Load config → missing/invalid? → pass-through
  → Match phrases (case-insensitive, whole-word, first-match wins)
  → Match regex (if enabled, under timeout)
  → No match or ambiguous? → pass-through
  → Matched intent:
      kind=review → TUI confirm → runIntentCommand(task, ctx, diagnostics)
                    with config profile (resolved through library)
                    + disableContextFiles
      kind=plan-only → inject code-owned PLAN_ONLY instruction
      kind=implementation → TUI confirm → runIntentCommand(task, ctx, diagnostics)
                           without auto-run rail bypass
```

## Existing Hook Points

| File | Line(s) | What it does | Impact |
|---|---|---|---|
| `agents/index.ts` | ~55 | session_start handler | Add config load here (project-trust-gated) |
| `agents/index.ts` | ~53 | `eventApi.on?.("session_start", ...)` | Add `before_agent_message` hook here (PREREQUISITE) |
| `agents/lib/run-resolver.ts` | 211 | `runIntentCommand` exported | Consumed directly for review/implementation routing |
| `agents/lib/intent-router.ts` | 1-4 | `INTENT_AUTORUN_CONFIDENCE`, `profileEffect` | NOT used for NL routing (always-confirm) |
| `agents/lib/diagnostics.ts` | 412 | `buildIntentCandidates` | Consumed for candidate set |

## Slice Ladder

| Slice | Objective | Primary files | Tests | Hard stops |
|---|---|---|---|---|
| P7-1 | Config loader + parser (trust-gated, profile-as-name, inline-model rejected) + phrase matcher + gate decision engine | `agents/lib/intent-gate.ts` (NEW), `agents/index.ts` | 9 tests | No config → gate disabled; inline model rejected |
| P7-2 | before_agent_message hook wiring + confirmation flow + disableContextFiles + code-owned instructions | `agents/index.ts` | 7 tests | Hook verified (B1); non-TUI pass-through |
| P7-3 | Regex matching under timeout + metadata recording + ambiguity rules | `agents/lib/intent-gate.ts` | 4 tests | Regex timeout proven; phrase-only is safe cut |

### Dependency graph

```text
P7-1 (core) ── P7-2 (wiring) ── P7-3 (regex + polish)
```

## Cut Order

1. Regex matching (P7-3) — ship phrase-only first.
2. Metadata recording (REQ-10, SHOULD) — nice-to-have.
3. Implementation intent handling — defer if review routing works.

Do not cut:

- Project-trust gate on config (REQ-SEC-1).
- Profile-as-name / no-inline-model (REQ-SEC-2).
- Always-confirm for NL routing (REQ-SEC-3).
- Code-owned system instructions (REQ-SEC-4).
- disableContextFiles on gate-routed children (REQ-SEC-5).
- Pass-through for unmatched/ambiguous/non-TUI/commands.

## Contracts

### `loadGateConfig(path, trusted): ConfigResult`

| State | Condition | Output |
|---|---|---|
| Untrusted | `trusted === false` | `{ ok: false, reason: "untrusted" }` |
| Missing | File absent | `{ ok: false, reason: "missing" }` |
| Invalid | Bad JSON, wrong version, missing intents | `{ ok: false, reason: "invalid" }` |
| Inline model | Config entry has `model` or `thinking` field | `{ ok: false, reason: "inline-model" }` |
| Unsafe regex | Regex exceeds bounds or times out | `{ ok: false, reason: "unsafe-regex" }` |
| Valid | All checks pass | `{ ok: true, config }` |

### `classifyGateIntent(prompt, config): GateDecision`

| State | Condition | Output |
|---|---|---|
| Review match | Phrase/regex matches review intent | `{ kind: "route", agent: "reviewer", ... }` |
| Plan-only match | Phrase matches plan-only intent, no review overlap | `{ kind: "inject", instruction: "PLAN_ONLY" }` |
| Implementation match | Phrase matches implementation intent | `{ kind: "confirm", agent, task, ... }` |
| No match | No phrase/regex matched | `{ kind: "pass-through" }` |
| Ambiguous | Multiple conflicting kinds matched | `{ kind: "pass-through" }` |

## Edge Cases

| # | Scenario | Expected | Test |
|---|---|---|---|
| EC1 | User opens untrusted repo, config has "review" → reviewer | Pass-through (config gated on trust) | `testGate_untrustedProjectConfigIgnored` |
| EC2 | Config profile is "nonexistent" | Profile resolves to undefined; P6 handles per role-default rules | `testGate_configProfileResolvedThroughLibrary` |
| EC3 | Config has inline `"model": "gpt-5"` | Rejected at load-time with reason "inline-model" | `testGate_configInlineModelRejected` |
| EC4 | User says "/agents run scout task" | Skip gate, handle as command | `testGate_skipsCommands` |
| EC5 | Non-TUI session, user says "review this" | Pass-through | `testGate_nonTuiPassesThrough` |
| EC6 | Two intents match with different kinds | Pass-through (ambiguity) | `testGate_ambiguityPassesThrough` |
| EC7 | Plan-only phrase also matches review ("review the plan") | Pass-through (ambiguity) — phrase sets must be disjoint or this is a config bug | `testGate_ambiguityPassesThrough` |
| EC8 | Regex times out (>100ms) | Treat as no-match, pass-through | `testGate_regexTimeout` |

## Test Case Catalog

Grouped by concern. Every test maps to a requirement.

```text
Group 1: Config loading (4)
  testGate_configValid          → REQ-1
  testGate_configMissingSkips   → REQ-1
  testGate_configInvalidSkips   → REQ-1
  testGate_untrustedProjectConfigIgnored → REQ-SEC-1

Group 2: Config validation (3)
  testGate_configInlineModelRejected        → REQ-SEC-2
  testGate_configProfileResolvedThroughLibrary → REQ-4
  testGate_regexTimeout                     → REQ-SEC-6

Group 3: Phrase matching (5)
  testGate_phraseMatch          → REQ-2
  testGate_noMatchPassesThrough → REQ-7
  testGate_ambiguityPassesThrough → REQ-7
  testGate_skipsCommands        → REQ-8
  testGate_nonTuiPassesThrough  → REQ-9

Group 4: Routing (5)
  testGate_nlRoutingAlwaysConfirms          → REQ-3, REQ-SEC-3
  testGate_reviewRoutesToAgent              → REQ-4
  testGate_planOnlyInjectsInstruction       → REQ-5
  testGate_planOnlyInstructionIsCodeOwned   → REQ-5, REQ-SEC-4
  testGate_routedChildDisablesContextFiles  → REQ-6, REQ-SEC-5

Group 5: Implementation confirm + metadata (3)
  testGate_implementationEnforcesConfirm → REQ-11, REQ-SEC-7
  testGate_regexMatch                    → REQ-2
  testGate_recordsMetadata               → REQ-10
```

Total: 20 tests.

**Falsifiability note (B3):** Every routing test MUST invoke the real production gate entry point
end-to-end and assert via the P6 runner spy (`ctx._runnerCalls` + `__classifierRunner.fn` as used
in `test-intent-command.mjs`). Asserting only the `GateDecision` descriptor is vacuous — delete the
wiring line and the test stays green. Each routing test includes a negative control (disable the
wiring and confirm RED).

## Risk Analysis

| Risk | Severity | Mitigation |
|---|---|---|
| SDK hook doesn't exist (B1) | High | PREREQUISITE — verify before P7-1 |
| Malicious repo config (SEC-1) | High | Project-trust gate + always-confirm |
| Config profile model-redirect (SEC-2) | High | Name-only, resolved through library |
| NL auto-run without user knowledge (SEC-3) | High | Always-confirm for NL prompts |
| Untrusted context in child (SEC-4) | Medium | disableContextFiles on all gate-routed spawns |
| Config-supplied prompt injection (SEC-5) | Medium | Code-owned instruction constants only |
| Regex DoS (SEC-6) | Medium | Timeout; phrase-only fallback |

## Open Decisions

- **B1 (PREREQUISITE):** VERIFIED 2026-06-21. Pi SDK provides `InputEvent` with `on("input", handler)`. Handler fires "when user input is received, before agent processing." Can return `{ action: "handled" }` to suppress normal model processing. P7 gate hooks here.
- Config path: `.pi/intent-workflows.json` (project-local, trust-gated) — confirm with team.
- Should the gate be toggleable via `/agents gate on|off` for debugging?
- Should plan-only intents ever spawn the planner agent, or always inject instruction?

## Done Criteria

- [x] B1 prerequisite verified (SDK InputEvent hook exists).
- [ ] Phrase matching routes review prompts to `/agents do` with confirmation.
- [ ] Config gated on projectTrusted; untrusted repo → pass-through.
- [ ] Inline model/thinking in config rejected at load-time.
- [ ] NL-routed prompts always confirm before spawn.
- [ ] Gate-routed children have disableContextFiles:true.
- [ ] Unmatched/ambiguous/command/non-TUI prompts pass through.
- [ ] All 20 tests pass; existing P6 suite stays green.

## Review Consensus

| Pass | Reviewer | Model | Blocker count | Verdict |
|---|---|---|---|---|
| 1 | claude (conformance + adversarial) | Opus 4.8 | 13 | CHANGES REQUESTED (20260621-092405) |
| 2 | Pending | — | — | Pending |

### Resolved blockers (from pass 1)

| # | Finding | Resolution |
|---|---|---|
| B1 | before_agent_message unverified | Moved to PREREQUISITE; blocked until SDK verified |
| B2 | RW-1 schema missing | P7 now owns the config schema; RW-1 reference removed |
| B3 | Routing tests vacuous | Added falsifiability note: all routing tests must use P6 runner spy end-to-end |
| B4 | REQ-to-test mapping mismatch | Rebuilt catalog with named tests; 1:1 mapping verified |
| B5 | Test count mismatch | Catalog now shows 20 tests; slice ladder adjusted |
| B6 | Missing Appendix | Template conformance: Contracts expanded with state tables + error codes |
| SEC-1 | Config ungated by trust | REQ-SEC-1: projectTrusted gate added |
| SEC-2 | Profile model-redirect | REQ-SEC-2: name-only, resolved through library; inline model rejected |
| SEC-3 | NL routing inherits no-confirm rail | REQ-SEC-3: always-confirm for NL prompts |
| SEC-4 | Gate-routed children load context files | REQ-SEC-5: disableContextFiles:true |
| SEC-5 | System instruction injection surface | REQ-SEC-4: code-owned enum constants only |
| SEC-6 | Regex ReDoS | REQ-SEC-6: 100ms timeout; phrase-only safe fallback |
| SEC-7 | Implementation confirm bypassable | REQ-SEC-7: gate enforces confirm before delegating |

## Appendix: Implementation Plan

### Files to create

1. `agents/lib/intent-gate.ts` — Config loader, phrase matcher, gate decision engine.
2. `agents/test-fixtures/test-intent-gate.mjs` — P7-1 tests (config loading + matching).
3. `agents/test-fixtures/run-p7-1-tests.sh` — P7-1 test runner.

### Files to modify

| File | Change |
|---|---|
| `agents/index.ts` | Register `on("input", …)` hook; wire gate decision → runIntentCommand or pass-through |
| `WORKPLAN.md` | Update active implementation to P7 |

### Implementation sequence

| Step | Action | Validation |
|---|---|---|
| 1 | P7-1: intent-gate.ts core + tests | run-p7-1-tests.sh green; existing P6 suite green |
| 2 | P7-2: input hook wiring + confirm flow | run-p7-2-tests.sh green; existing P6 suite green |
| 3 | P7-3: regex + metadata (optional) | run-p7-3-tests.sh green |

## Appendix B: Mechanical Execution Spec (P7-1)

### Executor contract

1. Steps in numeric order. No skip/reorder/batch.
2. Each step names exactly one file.
3. Make no design decisions. If an ANCHOR is not found verbatim, STOP and ask.
4. Run verify after each step; fix only that step before proceeding.
5. Surgical edits: ANCHOR→REPLACE for existing files, CREATE for new files, APPEND for additions to files created earlier in the same slice.
6. One slice = one commit.
7. Slice test command: `bash agents/test-fixtures/run-p7-1-tests.sh`.

Read-only refs: `agents/index.ts`, `agents/lib/run-resolver.ts`, `agents/lib/diagnostics.ts`, `agents/lib/profiles.ts`.

### Shared constants

```ts
// Code-owned system instruction enum — config selects kind only (REQ-SEC-4)
const GATE_INSTRUCTIONS = {
  PLAN_ONLY: "The user requested a plan. Produce a detailed plan only. Do NOT implement, edit, or execute any code.",
  IMPLEMENTATION_CONFIRM: "The user requested implementation. Confirm scope before proceeding.",
} as const;
```

### P7-1 — Config loader + parser + phrase matcher + gate decision engine (REQ-1/2/7, REQ-SEC-1/2/6)

| Step | File | Exact action | Verify |
|---|---|---|---|
| 1.1 | `agents/lib/intent-gate.ts` | **CREATE.** Full module: imports, types (`IntentGateConfig`, `IntentGateEntry`, `GateDecision`, `GateMetadata`, `GateInstruction`), `loadGateConfig(path, trusted)`, `classifyGateIntent(prompt, config)`, `GATE_INSTRUCTIONS` constants. Config validation: reject inline `model`/`thinking` fields with reason `"inline-model"`; reject unknown workflow kinds with reason `"unknown-kind"`; gate on `trusted === false` returning reason `"untrusted"`. Phrase matching: case-insensitive whole-word match via `new RegExp("\\b" + phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i")` over prompt. First match wins; ambiguous (different kinds matched) → pass-through. Pass-through for `/`-prefixed prompts. | `grep -n 'export function loadGateConfig' agents/lib/intent-gate.ts && grep -n 'export function classifyGateIntent' agents/lib/intent-gate.ts && grep -n 'inline-model' agents/lib/intent-gate.ts` |
| 1.2 | `agents/test-fixtures/test-intent-gate.mjs` | **CREATE.** Full test suite for config loading + matching (9 tests). Each test imports and calls the real production functions. Each test includes a negative control where deleting/breaking the production line turns the test RED. Config tests: `testGate_configValid` (valid config returns ok:true), `testGate_configMissingSkips` (absent file → ok:false/"missing"), `testGate_configInvalidSkips` (bad JSON → ok:false/"invalid"), `testGate_untrustedProjectConfigIgnored` (trusted=false → ok:false/"untrusted"), `testGate_configInlineModelRejected` (config with model field → ok:false/"inline-model"). Matching tests: `testGate_phraseMatch` ("review this" → kind:"route", agent:"reviewer"), `testGate_noMatchPassesThrough` ("hello" → pass-through), `testGate_skipsCommands` ("/agents run" → pass-through), `testGate_nonTuiPassesThrough` (test that ctx.hasUI=false bypass point exists — see P7-2 for full wiring test). Self-run `main()` exiting non-zero on failure. | `node agents/test-fixtures/test-intent-gate.mjs` exits 0; all 9 test names printed on success |
| 1.3 | `agents/test-fixtures/run-p7-1-tests.sh` | **CREATE.** `#!/usr/bin/env bash`, `set -euo pipefail`, `node "$(dirname "$0")/test-intent-gate.mjs"`. `chmod +x`. | `bash agents/test-fixtures/run-p7-1-tests.sh` exits 0 |

### P7-2 — Input hook wiring + confirm flow (REQ-3/4/5/6/8/9/11, REQ-SEC-3/4/5/7)

| Step | File | Exact action | Verify |
|---|---|---|---|
| 2.1 | `agents/index.ts` | **EDIT.** `ANCHOR:` `eventApi.on?.("session_start", async (_event, ctx) => {` → `REPLACE:` same line. **APPEND** after the session_start handler: register `on("input", handler)` that: (a) skips on `!ctx.hasUI` (REQ-9); (b) skips on `text.startsWith("/")` (REQ-8); (c) loads config via `loadGateConfig(path, ctx.isProjectTrusted?.() ?? false)`; (d) if config !ok → pass-through; (e) calls `classifyGateIntent`; (f) on `kind:"route"` or `kind:"confirm"`: TUI confirm (REQ-SEC-3), on confirm → `runIntentCommand(text, ctx, diagnostics)` with disableContextFiles (REQ-SEC-5) and config profile resolved through library (REQ-SEC-2), return `{ action: "handled" }`; (g) on `kind:"inject"`: inject GATE_INSTRUCTIONS[instruction] via system prompt append, return `{ action: "continue" }`; (h) on `kind:"pass-through"`: return `{ action: "continue" }`. | `grep -n 'on.*"input"' agents/index.ts && grep -n 'runIntentCommand' agents/index.ts && grep -n 'disableContextFiles' agents/index.ts` |
| 2.2 | `agents/test-fixtures/test-intent-gate.mjs` | **APPEND.** P7-2 tests (7): `testGate_reviewRoutesToAgent` (gate hook → confirm → runner spy called with config-chosen agent), `testGate_nlRoutingAlwaysConfirms` (confirm called even at confidence 0.95), `testGate_configProfileResolvedThroughLibrary` (profile name threaded), `testGate_planOnlyInjectsInstruction` (PLAN_ONLY instruction injected), `testGate_planOnlyInstructionIsCodeOwned` (instruction text matches GATE_INSTRUCTIONS.PLAN_ONLY), `testGate_routedChildDisablesContextFiles` (disableContextFiles in child options), `testGate_implementationEnforcesConfirm` (implementation confirm before delegate). Each test uses the real gate entry point through the input hook, spies on runner calls, and includes a negative control. | `node agents/test-fixtures/test-intent-gate.mjs` exits 0; all 16 test names (9 P7-1 + 7 P7-2) printed |
| 2.3 | `agents/test-fixtures/run-p7-1-tests.sh` | **EDIT.** `ANCHOR:` `node "$(dirname "$0")/test-intent-gate.mjs"` → `REPLACE:` same (no change needed — P7-2 tests appended to same test file, run by same runner). | `bash agents/test-fixtures/run-p7-1-tests.sh` exits 0; existing P6 suite green |
