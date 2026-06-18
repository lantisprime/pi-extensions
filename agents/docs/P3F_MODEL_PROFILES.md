# P3F Model Profiles Plan

## Status

Planning only. Do not implement until this plan is accepted and the current P3c-3 registered-execution slice is merged. P3F is additive to the agent spec model and does not alter trust/scanner/registry behavior.

## Episode Search Summary

Searched episodic memory for `model profile`, `agent`, and recalled the canonical workplan and P3 slice history.

Key active memories:

- `20260615-143159-canonical-workplan-updated-after-p3c-2-m-678b`: P3c-2 built-in child execution merged; P3c-3 registered user/project execution is the current slice.
- `20260614-095159-child-pi-json-subprocesses-inherit-globa-1860`: child Pi JSON subprocesses inherit global extensions; explicit `-e` fallback available.
- `20260617-090352-web-be47` (local research): web research on model profile/routing best practices. Validates static task-type routing, per-agent model assignment, pre-generation routing, scoped profiles (model+thinking only), and observability of routing decisions for evals. Explicitly scopes out dynamic/complexity routing and fallback chains.

## Objective

Add a named **model profile** preset layer above the existing `AgentSpec.model` / `AgentSpec.thinking` fields so agents can reference a reusable `(model, thinking)` combination by name instead of hardcoding a model per spec.

A profile resolves to exactly one concrete model selection. It is not a router, not a fallback chain, and not a provider selector. After resolution the existing `buildChildPiArgs` machinery emits `--model` / `--thinking` unchanged.

## Why

The agent spec already supports `model` and `thinking`, and `buildChildPiArgs` already emits them into child argv. Today every spec must name a literal model. A profile layer provides:

- **Reusability** — define a profile once; many spec files reference it.
- **Role-based model selection** — `scout → fast-local`, `planner → reasoning-deep`, `reviewer → adversarial-review`, matching the cost-capability tier pattern documented in the research episode.
- **Eval comparability** — an override map lets a future eval harness bind `planner → "glm-high"` vs `planner → "deepseek-high"` without editing specs, so pass-rate/cost/latency can be compared per routed branch.
- **Provenance/governance** — the profile library is a versioned, inspected artifact rather than scattered literal model strings.

This matches the industry baseline (research finding #1, #4): static per-role model assignment is the standard first maturity stage. Dynamic/complexity/semantic routing and cascading fallbacks are explicitly later stages and remain out of scope.

## Research Alignment

The 2026-06-17 web research (`20260617-090352-web-be47`) validates this design point-for-point:

| Finding | Design consequence |
|---|---|
| Static task-type routing is the recommended baseline | P3f ships static named profiles only |
| Separate "which model" from "how to call it" (OpenAI `model` vs `ModelSettings`; CrewAI `llm` vs `function_calling_llm`) | `ModelProfile` carries only `model`+`thinking`; never tools/safety/limits |
| Pre-generation routing is standard; cascades are advanced | Resolver runs before `buildChildPiArgs`; no post-generation cascade |
| Per-agent model assignment is the norm | Per-spec `profile?` field is industry-standard, not custom |
| Cost-capability tiers map to profiles | Built-in profiles are capability hints (`fast-local`, `reasoning-deep`, `adversarial-review`), not specific model names |
| Routing decisions must be observable for evals | Record resolved profile name + any eval override in run/eval metadata |
| Governance/provenance matters | Profile library is versioned; project profiles trust-gated |
| Avoid fallback chains initially | A profile resolves to exactly one `(model, thinking)` |

## Non-Goals

Out of scope for P3F:

- provider routing, fallback chains, or model cascades
- dynamic / complexity-scored / semantic / RL routing
- automatic model optimization or benchmarking
- profiles that carry `tools`, `safety`, `forbiddenTools`, or `limits` (these are security/config boundaries, not model-selection)
- a separate function-calling model (CrewAI-style `function_calling_llm` split) — documented as a future extension only
- changing `canRunAgent` trust/scanner/registry semantics
- changing `buildChildPiArgs` signature

## Existing Hook Points

The spec layer already supports everything a profile resolves into:

- `agents/lib/specs.ts`: `AgentSpec.model?: string`, `AgentSpec.thinking?: ThinkingLevel`, validated by `validateModelAndThinking` including `model:high` shorthand conflict detection via `extractThinkingFromModel`.
- `agents/lib/child-args.ts`: `buildChildPiArgs` already emits `--model spec.model` and `--thinking spec.thinking`.
- `agents/lib/agent-markdown.ts`: frontmatter already accepts `model` and `thinking` keys. The `profile` key will be added to `AGENT_MARKDOWN_ACCEPTED_KEYS` in P3f-2.
- `AGENT_SPEC.md` already bans provider routing/fallback chains — a profile respects this by resolving to one concrete selection.

## Design

### Resolution seam

Profiles resolve **before argv construction, after the trust gate**:

```text
AgentSpec (has profile?: string)
   └─ resolveProfile(spec, profileLibrary, { overrides })   <- NEW pure helper
        └─ materialized { model, thinking }                 (profile is authoritative; spec values are fallbacks)
             └─ buildChildPiArgs(materializedSpec, ...)     <- unchanged
```

- `canRunAgent` (trust/hash/scanner gate) stays **unaware** of profiles. Profiles are not a trust concern.
- `buildChildPiArgs` signature stays **unchanged** — it already reads `spec.model` / `spec.thinking`.
- Resolution happens inside `runChildAgent` in `child-runner.ts`, right before `buildChildPiArgs` is called. The profile library is passed as a **separate parameter** to `runChildAgent` (not a field on `RunChildAgentOptions`, keeping execution and configuration concerns separated).

### ModelProfile shape

```ts
type ModelProfile = {
  name: string;            // reuse ^[a-z][a-z0-9_-]{0,63}$ from specs.ts
  model?: string;          // safe argv token (same rule as spec.model)
  thinking?: ThinkingLevel;
  purpose?: string;        // human-readable description; surfaced in /agents profiles display
};
```

Deliberately excludes `tools`, `safety`, `forbiddenTools`, `limits`. A profile must not be able to weaken a tool allowlist or relax safety.

The `purpose` field is surfaced in `/agents profiles` listing (P3f-2) so users can understand what each profile is for without inspecting the raw data.

### AgentSpec change (deferred to P3f-2)

P3f-1 does NOT modify `AgentSpec`, `agent-markdown.ts`, or any existing file. The `profile?: string` field on `AgentSpec` and the corresponding frontmatter key in `AGENT_MARKDOWN_ACCEPTED_KEYS` are added in P3f-2, where the wiring proves the resolution path. P3f-1 defines only the pure profile model, resolver, and validation — all in the new `profiles.ts` file.

### Resolution precedence: profile is the authority

When a spec references a profile, the **profile is authoritative** for model and thinking. The spec's `model`/`thinking` fields act as **fallbacks** — they are consulted only when the profile does not provide that field.

Rationale: the purpose of a profile is "this role uses THIS model — period." If a spec could silently override the profile, centrally-managed model selection (governance, cost control, capability assurance) would be unenforceable. A single spec-level `model` field could bypass the profile. For eval-time or development-time overrides, use the explicit override map instead (see Eval hook below).

Resolution rules:

1. **Profile is authoritative.** If `spec.profile` references a profile and the profile provides a value for `model`, that value wins — even if the spec also sets `model`. Same for `thinking`.
2. **Spec fills gaps.** If the profile does NOT provide `model` or `thinking`, the spec's value (if any) is used as the fallback.
3. **No profile reference = no resolution.** If `spec.profile` is absent or undefined, `spec.model`/`spec.thinking` are used directly — no resolution needed.
4. **Conflict detection after merge.** After merging profile+fallback values, run the existing `validateModelAndThinking` on the result. If the profile's `model` includes a `:high` shorthand and the spec provides `thinking: medium` (used only if profile lacks thinking), the existing conflict check fires. However, if the profile provides BOTH `model:high` AND `thinking: high`, there is no conflict — the profile is self-consistent and the spec's `thinking` is not consulted at all.
5. **Unresolved profile = hard deny.** If `spec.profile` names a non-existent profile, produce a `profile-unresolved` error with a bounded diagnostic. At runtime (P3f-2), this is a **HARD DENY** — the agent must not run with a silent model fallback. Fail-closed.

### Eval hook (experimental)

```ts
resolveProfile(spec, library, { overrides?: Record<string, string> })
```

The override map binds spec profile names to alternate profile names, so an eval harness can swap `planner → "glm-high"` without editing specs. This is the comparability mechanism the research calls for, without runtime fallback.

**Status:** The signature exists in the type definition but override-map tests are deferred until an eval harness exists (P3e). The feature is marked experimental. The `overrides` parameter may be redesigned when eval infrastructure materializes.

### Observability addition

Record in run/eval metadata (alongside the model/provider already captured from child JSONL):

- resolved profile name (or `none`)
- whether an eval override was applied
- final resolved `model` / `thinking`

This satisfies research finding #6 (routing decisions must be observable for evals).

Additionally, `/agents inspect` should show the effective model after profile resolution alongside the declared spec values, so users can see when a profile is providing or overriding a value:

```text
Profile: deep-planner
  Profile.model: deepseek-v3.2 (applied)
  Profile.thinking: high (applied)
Spec.model: <not set>
Spec.thinking: <not set>
Effective: deepseek-v3.2, thinking=high
```

When spec values ARE used (as fallbacks for unset profile fields):

```text
Profile: deep-planner
  Profile.model: deepseek-v3.2 (applied)
  Profile.thinking: <not set>
Spec.model: <not set>
Spec.thinking: high (fallback — profile does not set thinking)
Effective: deepseek-v3.2, thinking=high
```

This prevents the semantic confusion identified in the adversarial review: a spec with no profile but explicit `model`/`thinking` looks identical to a profiled spec in its file representation, but the resolution path differs.

### Profile library caching

The profile library is loaded **once at session start** (or on first use) and held in `AgentsContext`. It is refreshed on `/agents reload` or `/agents profiles rescan`. No per-run file I/O for profile resolution. Profile names and hashes are available in the in-memory library for doctor/diagnostics use.

### Profile drift detection

Because profiles are live references (not hash-registered), changing a profile definition silently changes behavior for all referencing agents. To mitigate this, P3f-2 adds:

- Profile names and raw-file-byte SHA-256 hashes shown in `/agents profiles` listing
- Doctor check: "profile `<name>` hash changed since last doctor check" warning if a profile file differs from its last-known hash (stored in the profile library's in-memory cache, not in the agent registry)
- In-memory run history (20 entries) provides a short audit window showing which profile/model was used per run

### Profile library sources

Mirrors the agent spec pattern but lighter, since profiles are not prompts:

- **Built-in profiles** in `profiles.ts` — **capability hints only**, not specific model names. They encode tier-per-role without assuming model availability:
  - `fast-local`: no model or thinking set (lets Pi use its default for quick scans)
  - `reasoning-deep`: `thinking: high` only (no model, Pi picks from configured providers)
  - `adversarial-review`: `thinking: high` only (no model; Pi picks a different provider for model-diversity in review)
  - Users/projects can override with specific models in their own profiles.
  - Rationale: built-in profiles with hardcoded model names (`qwen3-coder-30b`, `deepseek-v3.2`) would fail for users who don't have those models configured. Capability hints are universally portable.
- **User-level** `~/.pi/agent/profiles/*.md` — frontmatter-only, reusing the bounded frontmatter parser.
- **Project-level** `.pi/profiles/*` — **behind `ctx.isProjectTrusted()`**. A malicious profile pointing a reviewer at a weak model is a real risk, so project profiles need trust gating even though they are not prompts.

Profiles are **not** registered by raw-file-byte hash in P3F. They are not prompts and do not execute.

### Trust gap: profiles vs agents

Agent specs adopted exact-hash registration because project-local files are repo-controlled and could contain malicious prompts. The same threat applies to project profiles: a project can ship a `.pi/profiles/` entry that points a reviewer at a weak model. When project trust is active and a registered reviewer agent references this profile, the reviewer runs at reduced capability.

The project-trust gate is NOT equivalent to hash registration — it's the same "trust once, trust everything" model that agent hash registration was specifically designed to avoid. However, profiles are capability-level (model selection), not content-level (prompts). A weak model is a capability degradation, not a prompt injection. The threat is lower severity.

**Consensus from adversarial review (human + reviewer subagent): this gap MUST close before P3f-2 wiring lands.** A hash-registered agent spec that reliably downgrades to a weak model via profile swap breaks the spirit of the trust anchor, even if the letter of `canRunAgent` is satisfied. The gate must see the resolved model.

Resolution strategy:

1. **P3f-3 hash-registration (recommended):** Hash-register project profiles in the project registry alongside agent specs. A profile change = hash mismatch = must re-register with explicit confirmation. This closes the gap fully.
2. **P3f-2 visibility only:** `/agents profiles` shows profile file SHA-256 hashes; doctor warns when a project profile hash differs from its last-known value. No runtime enforcement — profiles are live references. This is the gap-acceptance period between P3f-2 wiring and P3f-3 registration.

**Why no P3f-2 runtime mitigation:** A GLM-5.2 third-pass adversarial review (2026-06-17) identified that the previously-proposed P3f-2 interim trust-denial ("refuse to run when project profile changes model of registered spec") is structurally impossible without violating the `canRunAgent` invariant. Profile resolution happens inside `runChildAgent` (AFTER `canRunAgent`), so the resolved model is not available at gate time. Moving resolution before the gate would alter the gate's semantics. Adding a post-gate check inside `runChildAgent` would be a second undeclared gate that replicates trust logic outside the canonical audit path. The clean resolution is to accept the gap between P3f-2 and P3f-3 — it only affects project profiles behind explicit project trust, the threat is capability-level not prompt-injection, and P3f-3 hash-registration closes it properly.

This gap is fully documented. The current design is safe for P3f-1 (no wiring). P3f-2 provides visibility but no runtime enforcement. P3f-3 closes with hash-registration.

## Slice Ladder

P3F slots after P3c-3 (current slice, registered execution). It is purely additive to the spec model.

| Slice | Objective | Primary files | Tests / validation | Hard stop / do not include |
|---|---|---|---|---|
| **P3f-1** | Pure profile model + resolver + validation + built-in capability profiles + unresolved-profile denial | `agents/lib/profiles.ts`, `agents/test-fixtures/test-profiles.mjs` | Pure helper tests: profile name validation; built-in profile validity; resolution with profile-as-authority precedence; conflict re-validation; unresolved profile denied; forbidden-field rejection tests (37 tests, full contract coverage) | No command/wiring changes, no file discovery, no existing-file changes (no `AgentSpec.profile` field, no `agent-markdown.ts` edits), no override-map tests (deferred to evals) |
| **P3f-2** | Add `AgentSpec.profile` field + `AGENT_MARKDOWN_ACCEPTED_KEYS` + frontmatter parsing; wire resolution into `runChildAgent`; `/agents profiles` list with hashes; effective model/thinking in `/agents inspect` (declared vs resolved); doctor check for unresolved profile refs + profile hash-change warnings; observability metadata | `agents/index.ts`, `specs.ts`, `agent-markdown.ts`, `child-runner.ts`, diagnostics | Resolution-wiring tests; inspect shows effective vs declared; doctor flags unresolved refs + profile hash drift; run metadata includes resolved profile; profile hash visibility in listing | No user/project profile file discovery; no profile hash-registration; no runtime trust-enforcement (gap accepted until P3f-3) |
| **P3f-3** | User/project profile file discovery + parsing (reuse bounded frontmatter parser); project trust gating; **hash-register project profiles** in project registry (same model as agents: exact path + raw-file-byte SHA-256); profile-change re-registration flow; diagnostics for registered profiles | profile file parser, discovery, profile registration, diagnostics | File parsing caps; project trust gating; unknown-key warning; hash-registration prevents unregistered profile changes; re-registration flow tests; diagnostics reflect discovered + registered profiles | None — this is the closure of the trust gap |

## Cut Order

If scope grows, cut in this order:

1. P3f-3 user/project profile file discovery (keep built-in profiles + literal spec model/thinking only)
2. P3f-2 observability metadata (keep resolution but drop profile-name recording)
3. override map (keep single-profile resolution only)

Do not cut:

- profile name validation
- resolution precedence (profile is authoritative)
- conflict re-validation via `validateModelAndThinking`
- unresolved-profile denial

## Validation Matrix

- built-in profile set is valid and non-empty
- profile names match `^[a-z][a-z0-9_-]{0,63}$`
- profile `model` is a safe argv token; `thinking` is a valid `ThinkingLevel`
- `model:high` shorthand inside a profile is detected by `extractThinkingFromModel`
- spec with `profile` resolves to the profile's model + thinking (profile is authoritative)
- spec with `profile` AND explicit `model` → **profile wins**, spec model ignored
- spec with `profile` AND explicit `thinking` → **profile wins**, spec thinking ignored
- spec with `profile` that has model only; spec has thinking only → merged (profile model + spec thinking fallback)
- spec with `profile` that has `model:high` + `thinking: high`; spec has `thinking: medium` → profile is self-consistent, no conflict, spec thinking ignored
- conflicting `model:high` vs `thinking` from profile+spec fallback merge is rejected by existing `validateModelAndThinking`
- unresolved `spec.profile` produces `profile-unresolved` with a bounded diagnostic
- no `profile` field on spec → passthrough, `spec.model`/`spec.thinking` used directly
- override map swaps profile binding for evals (experimental, tests deferred)
- resolution result is a plain `{ model?, thinking? }` consumable by existing `buildChildPiArgs` with no signature change

## Open Decisions (defer to P3f-2)

1. **Built-in agents referencing profiles** — should built-in `scout`/`planner`/`reviewer` get default `profile` fields (e.g. reviewer → `adversarial-reviewer`), or stay model-less and let only user/project specs opt in? Giving built-ins a profile makes default behavior model-aware but couples built-ins to the profile library.
2. **User profiles remapping built-ins** — should a user profile library be consulted when resolving a built-in agent's profile (powerful: point the built-in reviewer at Kimi), or should built-ins resolve against built-in profiles only for determinism?
3. **Profile file format** — Markdown frontmatter (consistent with agents) vs. a single `profiles.json`. Leaning Markdown for parser consistency.

These do not block P3f-1, which is pure data + resolver + tests with no wiring.

## Review Consensus (2026-06-17)

Three adversarial reviews were conducted across two model families:

| Pass | Reviewer | Model | Verdict |
|---|---|---|---|
| 1 | Human | — | Conditional-go (4 blockers) |
| 2 | Subagent | deepseek-v4-pro | Conditional-go (1 blocker: trust gap) |
| 3 | Subagent | z-ai/glm-5.2 | Conditional-go (3 blockers: merge ambiguity, :high lifecycle, canRunAgent tension) |

**All three reviews agree: conditional-go. All 8 blockers resolved.**

**Areas of unanimous agreement:**
- Profile-as-authority precedence model is correct
- Slice boundaries are clean (P3f-1 is new-files-only, P3f-2 adds wiring, P3f-3 adds file discovery + hash-registration)
- Fail-closed on unresolved profiles (hard deny, no silent fallback)
- Profiles must NOT carry tools/safety/limits/forbiddenTools
- `buildChildPiArgs` and `canRunAgent` signatures stay unchanged
- `profileLibrary` as separate parameter to `runChildAgent`, not on `RunChildAgentOptions`

**Areas resolved by reviewer escalation:**
- Trust gap: originally documented as a future extension with Path A/B options. Reviewer escalated it: the gap must close before P3f-2 wiring ships. Resolution: P3f-2 provides visibility (profile hashes in `/agents profiles`, doctor hash-change warnings) but accepts the gap until P3f-3 hash-registration. A GLM-5.2 third-pass review (2026-06-17) confirmed the P3f-2 interim runtime-mitigation was structurally impossible without violating the `canRunAgent` invariant — resolution happens after the gate, so the gate can't see the resolved model. The gap-acceptance approach is the correct path.
- Test catalog: expanded from ~15 to 37 tests incorporating 12 reviewer-identified negative tests (including 4 forbidden-field rejection and 2 syntax-rejection tests) plus 4 contract-coverage gaps identified by a second reviewer-consistency pass, plus a field-level merge clarification identified by the GLM-5.2 review.

## P3c-3 Compatibility (2026-06-17)

P3c-3 (registered agent execution) was merged at commit `b72d531` on 2026-06-17, before P3f planning started. P3f slots cleanly after P3c-3 with zero conflicts.

### P3c-3 changes that P3f-2 integrates with

P3c-3 refactored the execution path in ways that directly benefit P3f-2:

| P3c-3 change | File | Why it helps P3f-2 |
|---|---|---|
| Extracted `runChildAgent(spec: AgentSpec, task, options)` as a standalone function | `child-runner.ts` | This is the exact resolution seam. Previously the execution body was inside `runBuiltInChildAgent`; now it is a dedicated function accepting `AgentSpec`. |
| `runBuiltInChildAgent` now delegates to `runChildAgent` | `child-runner.ts` | Only one function needs the `profiles` parameter. The forwarding chain is `runBuiltInChildAgent → runChildAgent → buildChildPiArgs`. |
| Created `RunChildAgentOptions` type alias | `child-runner.ts` | Clean anchor type for the separate `profiles` parameter. The plan mandates `profiles` NOT go on `RunChildAgentOptions` (execution vs config separation); the alias makes this explicit. |
| Created `executeChildRun` dispatch function | `index.ts` | Single integration point for forwarding the profile library to both `runChildAgent` and `runBuiltInChildAgent`. No need to touch `runAgentCommand`. |
| `ChildAgentRunner` type: `(agent: string \| AgentSpec, ...)` | `child-runner.ts` | Test-injected path unchanged by P3f-2. The injection type stays profile-unaware, which is correct — tests inject fake runners that don't spawn child Pi. |
| `ChildAgentRunResult.agentName`: `BuiltInAgentName → string` | `child-runner.ts` | Genericized result type can carry resolved profile metadata fields without type narrowing. |

### P3f-2 integration points (against merged P3c-3 code)

**`index.ts` — `executeChildRun`** (the profile library dispatch point):

```ts
// Current (P3c-3):
const result = ctx.agentsChildRunner
    ? await ctx.agentsChildRunner(agent, task, { cwd: ctx.cwd, piCommand: ctx.agentsPiCommand })
    : typeof agent === "string"
        ? await runBuiltInChildAgent(agent, task, { cwd: ctx.cwd, piCommand: ctx.agentsPiCommand })
        : await runChildAgent(agent, task, { cwd: ctx.cwd, piCommand: ctx.agentsPiCommand });

// P3f-2 adds ONE argument to each production branch:
const result = ctx.agentsChildRunner
    ? await ctx.agentsChildRunner(agent, task, { cwd: ctx.cwd, piCommand: ctx.agentsPiCommand })
    : typeof agent === "string"
        ? await runBuiltInChildAgent(agent, task, { cwd: ctx.cwd, piCommand: ctx.agentsPiCommand }, ctx.profileLibrary)
        : await runChildAgent(agent, task, { cwd: ctx.cwd, piCommand: ctx.agentsPiCommand }, ctx.profileLibrary);
```

The test-injected path (`ctx.agentsChildRunner`) does NOT receive profiles — correct behavior since test runners don't spawn child Pi.

**`child-runner.ts` — `runChildAgent`** (the resolution seam):

```ts
// P3f-2 adds optional 4th parameter — backward-compatible, existing callers unchanged:
export async function runChildAgent(
    spec: AgentSpec,
    task: string,
    options: RunChildAgentOptions = {},
    profiles?: ModelProfileLibrary,          // NEW
): Promise<ChildAgentRunResult> {
    const resolved = resolveSpecProfile(spec, profiles);
    if (!resolved.resolved) {
        return spawnErrorResult(spec.name, ..., new Error(resolved.error.message));
    }
    // Materialize resolved model/thinking into spec for buildChildPiArgs
    const effectiveSpec = { ...spec, model: resolved.effectiveModel, thinking: resolved.effectiveThinking };
    const invocation = buildChildPiArgs(effectiveSpec, task, options);
    // ... rest unchanged
}
```

**`child-runner.ts` — `runBuiltInChildAgent`** (forwarding):

```ts
export async function runBuiltInChildAgent(
    agentName: string,
    task: string,
    options: RunBuiltInChildAgentOptions = {},
    profiles?: ModelProfileLibrary,          // NEW — forward to runChildAgent
): Promise<ChildAgentRunResult> {
    // ... existing guard logic unchanged ...
    return runChildAgent(spec, task, options, profiles);  // forward
}
```

### Files with zero risk of conflict

These files are confirmed untouched by P3c-3 (verified via `git diff 6c7d885..b72d531 --stat`):

- `agents/lib/child-args.ts` — never changes in P3F (buildChildPiArgs signature unchanged)
- `agents/lib/can-run-agent.ts` — never changes in P3F (gate stays profile-unaware)
- `agents/lib/agent-markdown.ts` — P3f-2 adds `profile` key to accepted list
- `agents/lib/registration.ts` — P3f-2 adds Profile line to review display
- `agents/lib/registry.ts` — P3f-2 adds `profile?` field to `RegisteredAgent`
- `agents/lib/jsonl-monitor.ts` — never changes in P3F

P3c-3 only touched `index.ts`, `child-runner.ts`, and `diagnostics.ts` — and all changes are compatible with P3f-2's additive modifications.

### GLM-5.2 Third-Pass Review (2026-06-17)

A third adversarial pass using `z-ai/glm-5.2` (different model family) found issues prior reviews missed:

**Resolved blockers:**
- State-D merge clarified: explicitly documented as field-level merge (`profile.model ?? spec.model`, not object-level `profile ?? spec`)
- `:high` shorthand lifecycle added to state table: shorthand preserved in `effectiveModel`, Pi interprets natively
- P3f-2 interim trust-gap mitigation dropped: structurally impossible without violating `canRunAgent` invariant (resolution after gate). Gap accepted until P3f-3 hash-registration.

**Non-blocking concerns (noted for P3f-2/3):**
- `fast-local` is a no-op placebo — provides zero authoritative fields, functionally identical to no profile. Worth reassessing in P3f-2.
- Profile name collision precedence undefined across built-in/user/project sources. Must define merge order before P3f-2 profiles command.
- `adversarial-review` purpose text says "requiring a different provider" but model is unset — purpose copy may need update.
- `resolveSpecProfile` structural typing could accept extra AgentSpec fields if they're added later. Consider `Pick<AgentSpec, 'model'|'thinking'|'profile'>` after P3f-2.
- No test for profile library mutation after resolution — if libraries are live objects, a mutation could retroactively change resolved values. Consider clone/freeze.
- Unregistered specs using project profiles are unmitigated until P3f-3 (acknowledged gap).

## Future Extensions (out of P3F scope)

- **Function-calling model split** — a profile could later carry a separate `function_calling_model` (CrewAI `function_calling_llm` pattern). Not needed now; P3 agents are read-only with fixed tool lists.
- **Dynamic/complexity routing** — a later maturity stage per every research source. Explicitly deferred.
- **Agent-to-profile binding at registration time** — storing the resolved effective model in the registry entry alongside the profile name for runtime change detection (reviewer non-blocking concern). Not in P3F scope; deferred.

## Appendix: Integration Analysis (2026-06-17)

Deep code-level trace of every touchpoint, resolution hook, edge case, and risk.

### Touchpoint Catalog

Every location in the codebase where `model` / `thinking` is read or written, with the profile impact:

| File | Line(s) | What it does | Profile impact |
|---|---|---|---|
| `specs.ts` | L69 | `AgentSpec.model?, thinking?` definition | Add `profile?: string` |
| `specs.ts` | L202-228 | `extractThinkingFromModel`, `validateModelAndThinking` | Run AFTER resolution on merged result — no change to validate functions |
| `specs.ts` | L354-356 | `formatBuiltInAgentList` shows `model=X thinking=Y` | Add profile if present |
| `child-args.ts` | L35-36 | Pushes `--model` / `--thinking` into argv | **Unchanged** — receives materialized spec |
| `child-args.ts` | L95 | `validateChildArgInputs` checks model/thinking token safety | **Unchanged** — already validates whatever lands in spec |
| `child-runner.ts` | L78-79 | `runChildAgent` calls `buildChildPiArgs(spec, ...)` | **Resolution seam**: resolve profile here, before argv construction |
| `child-runner.ts` | L119 | `formatChildAgentRunResult` shows `model: provider/model` from JSONL | Add resolved profile + eval-override flag |
| `agent-markdown.ts` | L280-294 | `buildSpecFromMetadata` reads model/thinking from frontmatter | Add profile to `AGENT_MARKDOWN_ACCEPTED_KEYS` + metadata→spec mapping |
| `registration.ts` | L169-170 | `formatRegistrationReview` shows Model/Thinking | Add Profile line |
| `registry.ts` | L156-157 | `createRegisteredAgentFromParsed` stores model/thinking in entries | Store profile name too (registry is spec snapshot) |
| `diagnostics.ts` | L179-210 | `formatAgentInspect`, `formatAgentsList` — neither shows model/thinking today | Add model/thinking/profile to both; doctor checks for `profile-unresolved` |
| `jsonl-monitor.ts` | L76-77, L138-139 | Captures model/provider from child JSONL | **Unchanged** — captures what Pi actually used |
| `index.ts` | L111 | `runAgentCommand` → `executeChildRun` | Pass profile library into execution path |

### Resolution Hook Point

The single cleanest insertion point is **inside `runChildAgent`** in `child-runner.ts`, right before `buildChildPiArgs`:

```ts
// child-runner.ts — proposed
export async function runChildAgent(
    spec: AgentSpec,
    task: string,
    options: RunChildAgentOptions = {},
    profiles?: ModelProfileLibrary,              // separate parameter, not on RunChildAgentOptions
): Promise<ChildAgentRunResult> {
    const { effectiveModel, effectiveThinking, profileMeta } = resolveSpecProfile(spec, profiles);
    const materializedSpec = { ...spec, model: effectiveModel, thinking: effectiveThinking };
    const invocation = buildChildPiArgs(materializedSpec, task, options);
    // ... pass profileMeta through to result for observability
}
```

Why here and not in `executeChildRun` in index.ts:
- `runChildAgent` is the single execution bottleneck — called by both `runBuiltInChildAgent` (built-in path) and `executeChildRun` (user/project path).
- `buildChildPiArgs` is called on the very next line; resolved data has zero travel distance.
- Profile library is passed as a **separate parameter** (not a field on `RunChildAgentOptions`) to keep execution and configuration concerns separated. `RunChildAgentOptions` carries execution parameters (cwd, env, spawn, timeouts); profiles are configuration, not execution.

### Edge-Case Catalog

**P3f-1 (pure helpers):**

| # | Scenario | Expected behavior |
|---|---|---|
| EC1 | Profile has model+thinking; spec has neither | Resolves to profile values |
| EC2 | Profile has model; spec has thinking | Merged: profile's model + spec's thinking (fallback since profile lacks thinking) |
| EC3 | Spec has `model:high` shorthand and `profile: x`; profile has `thinking: low` | Profile is authoritative. If profile also has `model`, it wins over spec's `model:high`. If profile has thinking, it wins. Spec's shorthand only matters for `thinking` if profile does not set it. |
| EC4 | Profile has `model:high` AND `thinking: high`; spec has `thinking: medium` | Profile is self-consistent: `model:high`, `thinking: high`. Spec's `thinking: medium` is ignored. No conflict. |
| EC4b | Profile has `model:high`; profile has NO thinking; spec has `thinking: medium` | Profile provides model with `:high` shorthand. Spec provides thinking as fallback. Merge: `model:high` + `thinking: medium`. `validateModelAndThinking` catches conflict → **DENY** |
| EC5 | Spec references non-existent profile | `profile-unresolved` with bounded diagnostic listing available names |
| EC6 | Profile with empty name or invalid chars | `validateProfile` catches (same regex: `^[a-z][a-z0-9_-]{0,63}$`) |
| EC7 | Duplicate profile names in same library source | `validateProfiles` catches; cross-source is precedence-based (built-in > user > project) |
| EC8 | Profile with unsafe `model` token | `validateProfile` catches via `SAFE_ARG_TOKEN_RE` |
| EC9 | Profile with invalid `thinking` value | `validateProfile` catches |
| EC10 | Override map swaps profile binding (experimental) | Resolution uses override profile's values |
| EC11 | Override map references non-existent profile (experimental) | Resolution error: override target not found |
| EC12 | Profile with model only; spec with thinking only | Merged (profile model applied, spec thinking as fallback) |
| EC13 | Profile with neither model nor thinking (capability-descriptive only) | No-op resolution; Pi uses its default, or spec values if set |
| EC14 | Spec has no `profile` field | `resolveSpecProfile` is a no-op passthrough

**P3f-2 (wiring — runtime and diagnostics):**

| # | Scenario | Expected behavior |
|---|---|---|
| EC15 | Built-in agent references a valid profile | Resolution applies; child Pi uses profile's model |
| EC16 | Built-in agent's profile is unresolved | **HARD DENY** at runtime — fail-closed, no silent model fallback. Doctor flags the issue. |
| EC17 | User changes profile definition after agent registration | Affected agent resolves against new profile on next run. Registry stores profile name, not resolved values. Profiles are live references (like symlinks). |
| EC18 | Profile deleted after agent registered | Doctor surfaces `profile-unresolved` for affected agents. `/agents run` fails at resolution. |
| EC19 | Project trust deactivated; project agent references project-level profile | Project profiles inaccessible → `profile-unresolved` |
| EC20 | Same name across built-in + user + project profiles | Precedence: built-in > user > project. Shadow diagnostic in `/agents profiles`. |
| EC21 | Resolved model not available in Pi | Pi exits nonzero → `spawn-error`/`failed` status. Same behavior as hardcoded unknown model today. |
| EC22 | Profile resolved but spec has explicit model/thinking | Profile values win (profile is authoritative). Inspector shows `Effective: <profile-value>`. Spec values shown but marked as unused fallback. |

### Risk/Dependency Analysis

| Risk | Severity | Mitigation |
|---|---|---|
| Profile resolution happens before trust gate | **Low** — profiles only change model selection, not tools/safety. But a weak model = weakened review. | Resolution runs AFTER `canRunAgent` already passed (gate runs in `executeChildRun` → calls runner → `runChildAgent`). Trust is already enforced. |
| Malicious project profile pointing at weak model | **Medium** — project can ship `reviewer-profile` → `gpt-4o-mini`. | Project profiles behind `ctx.isProjectTrusted()`. Same bar as running project agents at all. Opt-in trust is the defense. |
| Profile name collision between sources | **Low** | Same-source duplicates caught by `validateProfiles`. Cross-source uses precedence (built-in > user > project). |
| Changing profile silently breaks evals | **Medium** — swapping `deep-planner` model backends changes behavior for all referencing specs. | Profile name is recorded in run metadata. Override map lets evals pin specific profiles. |
| `profile-unresolved` silently degrades to Pi default model | **High** — wrong-model behavior with no visibility. | Design rule: **HARD DENY** at runtime if `spec.profile` is set and can't resolve. Fail-closed. No silent fallback. This is a safety requirement, not a convenience feature. |
| P3c-3 execution path changes race with profile wiring | **Low** | P3f-1 is pure helpers with zero wiring. P3f-2 sits at a clean seam (`runChildAgent`) after P3c-3 is stable. Sequence P3f after P3c-3 merge. |
| `validateChildArgInputs` receives resolved model with different safety properties | **Low** | The check on line 95 of `child-args.ts` uses `SAFE_ARG_TOKEN_RE` — same regex applied to both original and resolved model values. No bypass. |

### Test Case Catalog (for `test-profiles.mjs`)

P3f-1 core tests (37 tests — see Appendix for full catalog and contract coverage):

```text
resolveProfile_returns_profile_values_when_spec_has_none
resolveProfile_profile_wins_over_spec_model
resolveProfile_profile_wins_over_spec_thinking
resolveProfile_spec_thinking_fallback_when_profile_has_no_thinking
resolveProfile_spec_model_fallback_when_profile_has_no_model
resolveProfile_profile_model_spec_thinking_merge
resolveProfile_profile_thinking_spec_model_merge
resolveProfile_detects_thinking_conflict_from_fallback_merge
resolveProfile_profile_self_consistent_no_conflict
resolveProfile_rejects_unresolved_profile_name
resolveProfile_unresolved_profile_hard_denies_no_fallback_to_spec
resolveProfile_passthrough_when_no_profile_reference
resolveProfile_does_not_mutate_original_spec

validateProfile_rejects_empty_name
validateProfile_rejects_invalid_name_characters
validateProfile_rejects_invalid_thinking_value
validateProfile_rejects_unsafe_model_token
validateProfile_rejects_forbidden_field_tools
validateProfile_rejects_forbidden_field_safety
validateProfile_rejects_forbidden_field_limits
validateProfile_rejects_forbidden_field_forbiddenTools
validateProfile_rejects_provider_routing_syntax_in_model
validateProfile_rejects_fallback_chain_syntax_in_model
validateProfile_allows_model_with_high_shorthand
validateProfile_accepts_valid_profile

validateProfiles_rejects_duplicate_names
validateProfiles_passes_valid_library

builtInProfiles_are_capability_hints_only
builtInProfiles_all_have_valid_names
builtInProfiles_each_contributes_at_least_model_or_thinking
builtInProfiles_all_pass_validation
```

Note: the 4 forbidden-field tests (`tools`, `safety`, `limits`, `forbiddenTools`) are critical for the profile security boundary. A profile must never be able to carry fields that could weaken an agent's tool allowlist or relax its safety policy. These are part of core P3f-1 validation.

The 2 syntax-rejection tests (`provider_routing_syntax`, `fallback_chain_syntax`) ensure the model field remains a single safe argv token — no `provider1|provider2/model` pipes and no `modelA,modelB` cascades.

Override-map tests (`resolveProfile_override_map_*`) are deferred until an eval harness exists (P3e). The override map signature is present in the type definition but experimental.

P3f-2 wiring tests:

```text
childPiArgs_includes_model_from_resolved_profile
childPiArgs_profile_wins_over_spec_model_in_argv
childPiArgs_profile_unresolved_hard_denies
runAgent_uses_profile_model_in_child_invocation
runAgent_trust_denial_when_profile_changes_model_of_registered_spec
inspect_shows_effective_and_declared_model
inspect_shows_profile_authority_notice
doctor_flags_unresolved_profile_references
doctor_warns_on_profile_hash_change
formatList_shows_model_thinking_and_profile
registration_review_shows_profile_info
registry_entry_stores_profile_name
```

## Appendix: P3f-1 Implementation Plan (Planner Agent, 2026-06-17)

Concrete file-level implementation plan produced by the planner agent, building on the scout reconnaissance, reviewer consensus, and plan doc design.

### Files to Create

#### 1. `agents/lib/profiles.ts` — types, validation, resolver, built-in profiles

**Imports from specs.ts:**
- `isValidAgentName` — profile name validation (same regex as agents)
- `isThinkingLevel`, `THINKING_LEVELS`, `ThinkingLevel` — thinking type/validation
- `extractThinkingFromModel` — detect `model:high` shorthand
- `validateModelAndThinking` — conflict re-validation on merged result
- `AgentValidationResult`, `AgentValidationIssue` — validation shape reuse

**Locally redefined (not exported from specs.ts):**
- `SAFE_ARGV_TOKEN_RE` — mirrors `SAFE_ARG_TOKEN_RE` (specs.ts L101). P3f-2 exports and imports instead.
- `deepFreeze<T>()` — mirrors specs.ts L529-535. 7 lines.

**Public API surface:**

Types:
```ts
export type ModelProfile = { name: string; model?: string; thinking?: ThinkingLevel; purpose?: string };
export type ModelProfileLibrary = { profiles: ModelProfile[] };
export type ResolvedProfile = { effectiveModel, effectiveThinking, profileName, profileProvidedModel, profileProvidedThinking };
export type ProfileResolutionResult = (ResolvedProfile & { resolved: true }) | { resolved: false; error: AgentValidationIssue };
```

### Validation Contracts

#### `validateProfile(profile: unknown): AgentValidationResult`

**Input contract:** Accepts any value. Returns `AgentValidationResult` (same shape as `validateAgentSpec`).

**Output contract:** `{ ok: boolean, issues: AgentValidationIssue[] }`. `ok === true` iff `issues.length === 0`.

**Issue codes (in check order):**

| # | Check | Field | Code | Message pattern |
|---|---|---|---|---|
| 1 | Must be a record (non-null, non-array object) | `profile` | `profile-invalid` | "profile must be a non-null object" |
| 2 | `name` must be a non-empty string | `name` | `name-required` | "profile name must be a non-empty string" |
| 3 | `name` must pass `isValidAgentName()` | `name` | `name-invalid` | "profile name must match ^[a-z][a-z0-9_-]{0,63}$" |
| 4 | Reject forbidden field `tools` | `tools` | `profile-forbidden-field` | "profile must not contain field 'tools' — use an agent spec for tool configuration" |
| 5 | Reject forbidden field `safety` | `safety` | `profile-forbidden-field` | same pattern, field=safety |
| 6 | Reject forbidden field `limits` | `limits` | `profile-forbidden-field` | same pattern, field=limits |
| 7 | Reject forbidden field `forbiddenTools` | `forbiddenTools` | `profile-forbidden-field` | same pattern, field=forbiddenTools |
| 8 | `model` if present: must be non-empty string | `model` | `model-invalid` | "profile model must be a non-empty string when provided" |
| 9 | `model` if present: must pass `SAFE_ARGV_TOKEN_RE` | `model` | `model-invalid` | "profile model must be a safe argv token without whitespace or special chars" |
| 10 | `thinking` if present: must pass `isThinkingLevel()` | `thinking` | `thinking-invalid` | "thinking must be one of: off, minimal, low, medium, high, xhigh" |
| 11 | `purpose` if present: must be a string (empty allowed) | `purpose` | `purpose-invalid` | "purpose must be a string when provided" |

**Contract invariants:**
- Check order is deterministic and stops after all checks (collects ALL issues, not fail-fast).
- Forbidden field checks (#4-7) fire before model/thinking validation (#8-10) — a profile that leaks tools is rejected regardless of valid model.
- An absent optional field (`model`, `thinking`, `purpose`) is NOT an error.
- `unknown` keys other than `name`, `model`, `thinking`, `purpose` are silently ignored (no error, no warning — P3f-1 is pure validation, not discovery).
- Pipe `|` and comma `,` in `model` are caught by check #9 (not in SAFE_ARGV_TOKEN_RE character set). No separate regex needed.

#### `validateProfileLibrary(library: ModelProfileLibrary): AgentValidationResult`

**Input contract:** Must be a `ModelProfileLibrary` (TypeScript-enforced).

**Output contract:** `{ ok: boolean, issues: AgentValidationIssue[] }`.

**Issue codes:**

| # | Check | Field | Code | Message pattern |
|---|---|---|---|---|
| 1 | `library.profiles` must be an array | `library` | `library-invalid` | "profile library must have a profiles array" |
| 2 | Each profile passes `validateProfile` | varies | propagated | Individual profile issues are propagated with field prefix `profiles[N].<field>` |
| 3 | No duplicate names in the library | `profiles` | `profile-duplicate-name` | "duplicate profile name '<name>'" |

**Contract invariants:**
- Duplicate check runs AFTER individual profile validation. Both types of errors can appear in the result.
- An empty `profiles` array is valid (no duplicate check needed, returns `ok: true`).
- Profile order in the array is preserved in issue reporting.

#### `resolveSpecProfile(spec, library?): ProfileResolutionResult`

**Input contract:**
- `spec`: `{ model?: string; thinking?: ThinkingLevel; profile?: string }` — structural type, not `AgentSpec`. Forward-compatible: when P3f-2 adds `profile?: string` to `AgentSpec`, it satisfies this interface automatically.
- `library`: `ModelProfileLibrary | undefined` — absence means no profiles available.

**Output contract:** Discriminated union:
- `resolved: true` → carries `ResolvedProfile` with `effectiveModel`, `effectiveThinking`, `profileName`, `profileProvidedModel`, `profileProvidedThinking`.
- `resolved: false` → carries `error: AgentValidationIssue` with field=`profile`, code describing the failure.

**Resolution states (exhaustive):**

| State | `spec.profile` | Library | Profile found | Conflict | Output |
|---|---|---|---|---|---|
| A. Passthrough | undefined/null/"" | any | n/a | n/a | `resolved: true`, `effective{Model,Thinking} = spec.{model,thinking}`, `profileName = undefined`, `profileProvided{Model,Thinking} = false` |
| B. No library | non-empty | undefined/empty | n/a | n/a | `resolved: false`, error `profile-unresolved`, "no profile library available" |
| C. Not found | non-empty | has profiles | no | n/a | `resolved: false`, error `profile-unresolved`, "profile '<name>' not found in library" |
| D. Resolved | non-empty | has profiles | yes | no | `resolved: true`, `effectiveModel = profile.model ?? spec.model`, `effectiveThinking = profile.thinking ?? spec.thinking`, `profileName = profile.name`, `profileProvided*` flags set. **Merge is field-level, not object-level** — a profile that provides only `thinking` does not overwrite a spec's `model`. |
| E. Conflict | non-empty | has profiles | yes | yes | `resolved: false`, error propagated from `validateModelAndThinking` with field prefix |

**`:high` shorthand lifecycle:** If the profile's `model` includes a `:high` shorthand (e.g., `"claude-sonnet:high"`), the shorthand is **preserved in `effectiveModel`**. Pi interprets the `:high` suffix natively; `extractThinkingFromModel` in the conflict-detection path recognizes it. If the profile also sets `thinking`, the two must agree (profile self-consistent). If the profile sets only `model:high` and no `thinking`, the shorthand is the sole thinking signal — Pi uses it. No normalization or stripping is needed.

**Failure codes:**

| Code | Field | Trigger |
|---|---|---|
| `profile-unresolved` | `profile` | Profile name not found in library, or no library available |
| `thinking-conflicts-with-model` | `thinking` | Propagated from `validateModelAndThinking` after fallback merge (profile has `model:high`, no thinking; spec has differing thinking) |

**Contract invariants:**
- Resolution never mutates the input `spec` object (immutability).
- When profile is self-consistent (`model:high` + `thinking: high`), spec thinking is silently ignored — no conflict error (state D, not E).
- `validateModelAndThinking` is only called when profile resolution produces both effective values — not for the passthrough case (state A already passes through spec values that were validated during spec creation).
- The resolver does NOT pre-validate the profile or library — it assumes callers have validated via `validateProfile`/`validateProfileLibrary`. If given an invalid profile, behavior is undefined (but safe — structural field access on a validated object).

#### Built-in profiles contract

**Invariants:**
- `BUILT_IN_PROFILES` is a `Record<string, ModelProfile>` deeply frozen via `deepFreeze`.
- Every built-in profile passes `validateProfile`.
- No built-in profile has a hardcoded `model` value (capability hints only).
- `fast-local` is the only built-in with neither `model` nor `thinking` — intentional "Pi defaults" profile for quick scans. Test: `builtInProfiles_fast_local_is_intentionally_empty`.
- `reasoning-deep` and `adversarial-review` both contribute at least `thinking: high`. Test: `builtInProfiles_reasoning_and_review_contribute_at_least_thinking`.
- `getBuiltInProfile(name)` returns `undefined` for unknown names (safe lookup).
- `listBuiltInProfiles()` returns profiles in definition order.
- `toProfileLibrary()` returns `{ profiles: listBuiltInProfiles() }`.

**Review note (2026-06-17):** A prior version of the test catalog had a contradictory assertion (`builtInProfiles_each_contributes_at_least_model_or_thinking` claiming ALL built-ins contribute, conflicting with `fast-local` intentionally having neither). Fixed by splitting into two tests that accurately reflect the contract.

Built-in profiles:
```ts
export const BUILT_IN_PROFILES: Readonly<Record<string, ModelProfile>>;  // deepFrozen
export function getBuiltInProfile(name: string): ModelProfile | undefined;
export function listBuiltInProfiles(): ModelProfile[];
export function formatBuiltInProfilesList(profiles?: readonly ModelProfile[]): string;
export function toProfileLibrary(): ModelProfileLibrary;
```

| name | model | thinking | purpose |
|---|---|---|---|
| `fast-local` | (unset) | (unset) | Quick local scans where latency matters more than depth |
| `reasoning-deep` | (unset) | `high` | Deep reasoning for planning and analysis |
| `adversarial-review` | (unset) | `high` | Skeptical review requiring a different provider for model-diversity |

Note: `fast-local` has neither model nor thinking — intentional; it's "use Pi defaults, fast." The reviewer's concern about dead-weight built-ins is addressed by clear `purpose` documentation.

#### 2. `agents/test-fixtures/test-profiles.mjs` — 37 tests

Follows `test-specs.mjs` conventions: standalone `.mjs`, `node:assert/strict`, flat `testFoo()` functions, `main()` calling all, `codes()`/`clone()` helpers.

37 tests organized into 5 groups:

**Resolution (14 tests):** `resolveProfile_returns_profile_values_when_spec_has_none`, `_profile_wins_over_spec_model`, `_profile_wins_over_spec_thinking`, `_spec_thinking_fallback_when_profile_has_no_thinking`, `_spec_model_fallback_when_profile_has_no_model`, `_profile_model_spec_thinking_merge`, `_profile_thinking_spec_model_merge`, `_detects_thinking_conflict_from_fallback_merge`, `_profile_self_consistent_no_conflict`, `_rejects_unresolved_profile_name`, `_rejects_when_no_profile_library_available`, `_unresolved_profile_hard_denies_no_fallback_to_spec`, `_passthrough_when_no_profile_reference`, `_does_not_mutate_original_spec`

**validateProfile (12 tests):** `validateProfile_rejects_non_record_input`, `validateProfile_rejects_empty_name`, `validateProfile_rejects_invalid_name_characters`, `validateProfile_rejects_invalid_thinking_value`, `validateProfile_rejects_empty_model_string`, `validateProfile_rejects_unsafe_model_token`, `validateProfile_rejects_forbidden_field_tools`, `validateProfile_rejects_forbidden_field_safety`, `validateProfile_rejects_forbidden_field_limits`, `validateProfile_rejects_forbidden_field_forbiddenTools`, `validateProfile_rejects_non_string_purpose`, `validateProfile_accepts_valid_profile`

**Syntax rejection (3 tests):** `_rejects_provider_routing_syntax_in_model`, `_rejects_fallback_chain_syntax_in_model`, `_allows_model_with_high_shorthand`

**validateProfiles (3 tests):** `validateProfiles_rejects_non_array_profiles`, `validateProfiles_rejects_duplicate_names`, `validateProfiles_passes_valid_library`

**Built-in integrity (5 tests):** `builtInProfiles_are_capability_hints_only` (no model set), `builtInProfiles_all_have_valid_names`, `builtInProfiles_fast_local_is_intentionally_empty`, `builtInProfiles_reasoning_and_review_contribute_at_least_thinking`, `builtInProfiles_all_pass_validation`

Note on pipe/comma tests: `SAFE_ARGV_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,127}$/` already rejects `|` and `,` since they are not in the allowed character set. The tests verify that `provider1|provider2/model` and `modelA,modelB` are rejected with `model-invalid` code via the existing token check.

#### 3. `agents/test-fixtures/run-p3f-1-tests.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
npx --yes tsx agents/test-fixtures/test-profiles.mjs
```

### Implementation Sequence

| Step | Action | Validation |
|---|---|---|
| 1 | Write `profiles.ts`: types, validation, built-in profiles (no resolver yet) | `npx --yes tsc --noEmit --strict agents/lib/profiles.ts` |
| 2 | Add `resolveSpecProfile()` to `profiles.ts` | Same type-check |
| 3 | Write `test-profiles.mjs`: all 37 tests | `npx --yes tsx agents/test-fixtures/test-profiles.mjs` |
| 4 | Write `run-p3f-1-tests.sh` | `bash agents/test-fixtures/run-p3f-1-tests.sh` |
| 5 | Full validation: `git diff --stat` on all 10 existing lib files + `index.ts` | Empty output (zero changes to existing files) |

### P3f-1 Risks

| Risk | Mitigation |
|---|---|
| `SAFE_ARG_TOKEN_RE` not exported → local duplication | Identical literal with `// mirrors specs.ts L101` comment. P3f-2 consolidates via export/import. |
| `deepFreeze` not exported → local duplication | 7-line function, low drift probability. Accept for P3f-1. |
| `isValidAgentName` used for profile names — semantic mismatch | Function name is agent-specific but logic is correct. Alias or rename in P3f-2 if needed. |
| Pipe/comma rejection relies on existing token regex | Tests 22-23 use explicit `|` and `,` examples. No separate regex needed. |
| Structural typing for `resolveSpecProfile` input | The resolver accepts `{model?, thinking?, profile?}` — structural typing means AgentSpec satisfies this automatically when P3f-2 adds `profile?: string`. Forward-compatible. |
