# P3f-1 Model Profiles — Pure Helpers Plan

## Status

Planning only. Do not implement until this plan, plan review, and adversarial review are accepted.
This plan is extracted from the broader P3F Model Profiles Plan (`agents/P3F_MODEL_PROFILES.md`)
which has completed 3 adversarial reviews with unanimous conditional-go.

## Episode Search Summary

Searched episodic memory for `P3F`, `model profiles`, `profile-as-authority`, `validation contracts`.

Key active memories:

- `20260617-102340-3e8b`: 3 reviews across 2 model families, unanimous conditional-go, 8 blockers resolved
- `20260617-100437-63e4`: Planner agent P3f-1 implementation plan — 3 new files, 37 tests, 5-step sequence
- `20260617-095954-bab8`: Scout recon confirmed zero changes to existing files for P3f-1
- `20260617-094208-10b8`: P3F plan finalized — precedence=profile-authoritative, built-ins=capability-hints
- `20260617-090352-be47`: Web research validating static per-role model assignment as industry baseline
- `20260617-102715-35e8`: Canonical workplan — P3f-1 can start in parallel with P3c-4

## Objective

Ship the pure-helper model profile layer as a single new file (`agents/lib/profiles.ts`) with zero
changes to existing code. Define the `ModelProfile` type, profile validation, profile-library
validation, profile resolution (profile-as-authority with spec fallback), and three built-in
capability-hint profiles. Deliver 37 pure helper tests with full contract coverage.

## Why

The agent spec already supports `model` and `thinking` per-spec, but every spec must hardcode a
literal model string. A profile layer enables:

- **Reusability**: define a profile once, reference it from many spec files
- **Role-based model selection**: scout → fast-local, planner → reasoning-deep, reviewer → adversarial-review
- **Governance**: the profile library is a versioned, inspected artifact; resolution is fail-closed
- **P3f-2 readiness**: P3f-1 provides the pure resolution function that P3f-2 wires into `runChildAgent`

P3f-1 is new files only — zero risk to the existing agent scaffold.

## Requirements (Ground Truth)

Every requirement SHALL be testable and SHALL map to at least one test or validation check.
Requirements are numbered REQ-1, REQ-2, ... and are the authoritative contract for the feature.
If a requirement cannot be tested, it is not a requirement — move it to Non-Goals or Design notes.

| ID | Requirement | Test(s) | Priority | Notes |
|---|---|---|---|---|
| REQ-1 | `validateProfile` rejects non-record input (null, array, primitive) | `validateProfile_rejects_non_record_input` | MUST | Check order: non-null object first |
| REQ-2 | `validateProfile` requires non-empty `name` matching `^[a-z][a-z0-9_-]{0,63}$` | `validateProfile_rejects_empty_name`, `validateProfile_rejects_invalid_name_characters` | MUST | Same regex as agent names (`isValidAgentName`) |
| REQ-3 | `validateProfile` rejects forbidden fields: `tools`, `safety`, `limits`, `forbiddenTools` | `validateProfile_rejects_forbidden_field_tools`, `_safety`, `_limits`, `_forbiddenTools` | MUST | 4 tests. Profile must not carry security/config fields — those belong on AgentSpec. Check order: forbidden fields fire before model/thinking validation. |
| REQ-4 | `validateProfile` validates `model` field: non-empty string matching `SAFE_ARG_TOKEN_RE` | `validateProfile_rejects_empty_model_string`, `validateProfile_rejects_unsafe_model_token`, `validateProfile_rejects_provider_routing_syntax_in_model`, `validateProfile_rejects_fallback_chain_syntax_in_model`, `validateProfile_allows_model_with_high_shorthand` | MUST | 5 tests. Model is optional; absent model is not an error. Pipe, comma, whitespace rejected by token regex. `:high` shorthand passes. |
| REQ-5 | `validateProfile` validates `thinking` field against `THINKING_LEVELS` when present | `validateProfile_rejects_invalid_thinking_value` | MUST | Absent thinking is not an error |
| REQ-6 | `validateProfile` validates `purpose` field is a string when present | `validateProfile_rejects_non_string_purpose` | MUST | Absent purpose is not an error; empty string is allowed |
| REQ-7 | `validateProfile` accepts a valid profile with no false errors | `validateProfile_accepts_valid_profile` | MUST | All checks pass, unknown keys silently ignored |
| REQ-8 | `validateProfileLibrary` requires `profiles` to be an array, validates each entry, rejects duplicate names | `validateProfiles_rejects_non_array_profiles`, `validateProfiles_rejects_duplicate_names`, `validateProfiles_passes_valid_library` | MUST | 3 tests. Empty array is valid. Duplicate check runs after individual validation. Profile order preserved in error reporting. |
| REQ-9 | `resolveSpecProfile` returns profile values when both profile and spec provide model/thinking (profile authority) | `resolveProfile_profile_wins_over_spec_model`, `resolveProfile_profile_wins_over_spec_thinking` | MUST | Profile is authoritative — profile model wins over spec model, profile thinking wins over spec thinking |
| REQ-10 | `resolveSpecProfile` uses spec values as fallback when profile omits model or thinking (field-level merge, not object-level) | `resolveProfile_spec_thinking_fallback_when_profile_has_no_thinking`, `resolveProfile_spec_model_fallback_when_profile_has_no_model`, `resolveProfile_profile_model_spec_thinking_merge`, `resolveProfile_profile_thinking_spec_model_merge`, `resolveProfile_returns_profile_values_when_spec_has_none` | MUST | 5 tests. Field-level: `effectiveModel = profile.model ?? spec.model` |
| REQ-11 | `resolveSpecProfile` detects conflict when fallback merge produces `model:high` + different thinking | `resolveProfile_detects_thinking_conflict_from_fallback_merge` | MUST | Uses `validateModelAndThinking` on merged result |
| REQ-12 | `resolveSpecProfile` accepts self-consistent profile (profile provides both `model:high` AND `thinking: high`) without false conflict | `resolveProfile_profile_self_consistent_no_conflict` | MUST | Spec thinking is silently ignored when profile provides thinking |
| REQ-13 | `resolveSpecProfile` hard-denies when profile name not found in library, or no library available — no silent fallback to spec model/thinking | `resolveProfile_rejects_unresolved_profile_name`, `resolveProfile_rejects_when_no_profile_library_available`, `resolveProfile_unresolved_profile_hard_denies_no_fallback_to_spec` | MUST | 3 tests. Fail-closed. Returns `resolved: false` with `profile-unresolved` error code. |
| REQ-14 | `resolveSpecProfile` passes through spec values when spec has no profile reference (no resolution needed) | `resolveProfile_passthrough_when_no_profile_reference` | MUST | `spec.profile` is undefined/null/empty → return spec values unchanged |
| REQ-15 | `resolveSpecProfile` does not mutate the input spec object | `resolveProfile_does_not_mutate_original_spec` | MUST | Immutability invariant |
| REQ-16 | Built-in profiles are capability hints — no hardcoded `model` values | `builtInProfiles_are_capability_hints_only` | MUST | Built-ins carry only `name`, `thinking`, `purpose` |
| REQ-17 | Built-in profiles satisfy specific invariants: `fast-local` has neither model nor thinking; `reasoning-deep` and `adversarial-review` each contribute at least `thinking: high` | `builtInProfiles_fast_local_is_intentionally_empty`, `builtInProfiles_reasoning_and_review_contribute_at_least_thinking` | MUST | Fast-local is "Pi defaults, fast" |
| REQ-18 | All built-in profiles pass `validateProfile`, have valid names, and helper functions (`getBuiltInProfile`, `listBuiltInProfiles`, `formatBuiltInProfilesList`, `toProfileLibrary`) behave correctly | `builtInProfiles_all_have_valid_names`, `builtInProfiles_all_pass_validation`, `builtInProfiles_getBuiltInProfile_unknown_is_undefined`, `builtInProfiles_listBuiltInProfiles_has_correct_order`, `builtInProfiles_toProfileLibrary_is_valid`, `builtInProfiles_formatBuiltInProfilesList_returns_non_empty` | MUST | Deep-frozen via `deepFreeze`. Helper tests verify: unknown lookup returns undefined, list preserves definition order, toProfileLibrary produces validatable library, format returns non-empty string. |
| REQ-19 | P3f-1 introduces zero changes to existing files | `manual: git diff --stat agents/lib/specs.ts agents/lib/agent-markdown.ts agents/lib/security-scan.ts agents/lib/registry.ts agents/lib/can-run-agent.ts agents/lib/child-args.ts agents/lib/child-runner.ts agents/lib/jsonl-monitor.ts agents/lib/diagnostics.ts agents/lib/registration.ts agents/index.ts` | MUST | P3f-1 = new files only. Empty diff output on all 11 existing files. |
| REQ-20 | `ResolvedProfile` metadata fields (`profileName`, `profileProvidedModel`, `profileProvidedThinking`) accurately reflect the resolution source | `resolveProfile_metadata_flags_set_correctly` | MUST | On resolved path: profileName matches the looked-up profile, profileProvidedModel/Thinking are `true` only when the profile (not spec fallback) set that field. On passthrough: profileName undefined, both flags false. |

**Priority legend:**
- **MUST**: Required for P3f-1 merge. Failing test = blocker.
- **SHOULD**: Required before the feature is considered complete; one slice may defer.
- **MAY**: Nice-to-have, not blocking any merge.

The `Test(s)` column accepts named automated tests (e.g. `testFoo`), manual smoke
checks (e.g. `manual: git diff --stat`), or static analysis (e.g. `git diff --check`).
List all verification methods that prove the requirement.

## Non-Goals

Out of scope for P3f-1:

- `AgentSpec.profile` field — deferred to P3f-2 (requires modifying specs.ts)
- Wiring into `runChildAgent` or `executeChildRun` — deferred to P3f-2
- `/agents profiles` command — deferred to P3f-2
- Profile file discovery (user/project profile Markdown files) — deferred to P3f-3
- Profile hash registration — deferred to P3f-3
- Override map for eval-time profile swapping — experimental, not in any P3F slice
- Provider routing, fallback chains, model cascades — out of P3F entirely
- Profiles that carry `tools`, `safety`, `forbiddenTools`, or `limits` — permanently excluded
- Changing `buildChildPiArgs`, `canRunAgent`, or any existing function signature

## Safety / Security

P3f-1 is pure helpers with no runtime surface. Security concerns are deferred to P3f-2 (wiring)
and P3f-3 (hash-registration). The only safety-relevant design decision in P3f-1 is:

| Concern | Severity | Mitigation | Test(s) |
|---|---|---|---|
| Profile could carry tools/safety/limits/forbiddenTools, weakening agent security | Low (pure helpers, no wiring yet) | `validateProfile` rejects these fields with `profile-forbidden-field` code before model/thinking validation runs | `validateProfile_rejects_forbidden_field_tools`, `validateProfile_rejects_forbidden_field_safety`, `validateProfile_rejects_forbidden_field_limits`, `validateProfile_rejects_forbidden_field_forbiddenTools` |
| Profile model field could carry provider routing or fallback chain syntax | Low (pure helpers, no wiring yet) | `SAFE_ARG_TOKEN_RE` rejects pipe and comma characters | `validateProfile_rejects_provider_routing_syntax_in_model`, `validateProfile_rejects_fallback_chain_syntax_in_model` |

## Design

### Key types

```ts
// A named reusable (model, thinking) combination. Carries only model-selection
// fields — never tools, safety, limits, or forbiddenTools (security/config
// boundaries belong on AgentSpec, not profiles).
export type ModelProfile = {
  name: string;              // ^[a-z][a-z0-9_-]{0,63}$ (same regex as agent names)
  model?: string;            // safe argv token (mirrors AgentSpec.model)
  thinking?: ThinkingLevel;  // one of: off, minimal, low, medium, high, xhigh
  purpose?: string;          // human-readable description for /agents profiles display (P3f-2)
};

// A collection of profiles for resolution. Order determines lookup precedence
// when constructing the library (built-in > user > project).
export type ModelProfileLibrary = {
  profiles: ModelProfile[];
};

// Output of successful profile resolution. Carries the effective model/thinking
// and metadata about which source provided each value.
export type ResolvedProfile = {
  effectiveModel: string | undefined;
  effectiveThinking: ThinkingLevel | undefined;
  profileName: string | undefined;              // which profile resolved (undefined = passthrough)
  profileProvidedModel: boolean;                // did the profile set model?
  profileProvidedThinking: boolean;             // did the profile set thinking?
};

// Discriminated union: resolution succeeds or fails.
export type ProfileResolutionResult =
  | (ResolvedProfile & { resolved: true })
  | { resolved: false; error: AgentValidationIssue };
```

### Key invariants

- **Profile is authoritative**: when a spec references a profile, profile values win over spec values for model and thinking. Spec values are used only as fallbacks when the profile omits a field.
- **Field-level merge**: `effectiveModel = profile.model ?? spec.model`, `effectiveThinking = profile.thinking ?? spec.thinking`. Not object-level `??` — a profile that provides only `thinking` does not overwrite a spec's `model`.
- **Fail-closed**: unresolved profile (name not found, no library) = hard deny. No silent fallback to spec values.
- **No input mutation**: `resolveSpecProfile` never mutates the input spec object.
- **`:high` shorthand preserved**: if the profile's model includes `:high`, it is preserved in `effectiveModel`. Pi interprets natively. `extractThinkingFromModel` recognizes it for conflict detection.
- **Structural typing**: `resolveSpecProfile` accepts `{ model?, thinking?, profile? }` — not `AgentSpec`. When P3f-2 adds `profile?: string` to `AgentSpec`, it satisfies this interface automatically.
- **Import dependencies**: from `specs.ts` — `isValidAgentName`, `isThinkingLevel`, `THINKING_LEVELS`, `ThinkingLevel`, `extractThinkingFromModel`, `validateModelAndThinking`, `AgentValidationResult`, `AgentValidationIssue`.
- **Local redefinitions**: `SAFE_ARG_TOKEN_RE` and `deepFreeze<T>` are not exported from `specs.ts` — reproduce locally (7-line `deepFreeze`, 1-line regex: `/^[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,127}$/`) with `// mirrors specs.ts L101` comments. The source constant is named `SAFE_ARG_TOKEN_RE` (no "V").

### Resolution / flow

```text
resolveSpecProfile({ model?, thinking?, profile? }, library?)
   │
   ├── spec.profile is undefined/null/"" → passthrough: return spec values unchanged
   │
   ├── spec.profile is set but no library → unresolved error (hard deny)
   │
   ├── spec.profile is set, library has profiles, profile not found → unresolved error
   │
   └── spec.profile is set, profile found
         │
         ├── apply field-level merge: effectiveModel = profile.model ?? spec.model
         │                                effectiveThinking = profile.thinking ?? spec.thinking
         │
         ├── if both effectiveModel and effectiveThinking are set →
         │      run validateModelAndThinking on merged result
         │      ├── conflict detected → unresolved error
         │      └── no conflict → resolved
         │
         └── if only one or neither is set → resolved (no conflict possible)
```

## Existing Hook Points

P3f-1 imports from existing code but does NOT modify any existing files.

| File | Line(s) | What it does | P3f-1 impact |
|---|---|---|---|
| `specs.ts` | L4 | `THINKING_LEVELS` array | Import for thinking validation |
| `specs.ts` | L13 | `ThinkingLevel` type | Import for type annotations |
| `specs.ts` | L80, L86 | `AgentValidationIssue`, `AgentValidationResult` | Import for validation return types |
| `specs.ts` | L140 | `isValidAgentName(name)` | Import for profile name validation |
| `specs.ts` | L148 | `isThinkingLevel(value)` | Import for thinking field validation |
| `specs.ts` | L201 | `extractThinkingFromModel(model)` | Import for `:high` shorthand detection |
| `specs.ts` | L207 | `validateModelAndThinking(model, thinking)` | Import for conflict re-validation on merged result |
| `specs.ts` | L101 | `SAFE_ARG_TOKEN_RE` | **Not exported** — redefine locally as `SAFE_ARG_TOKEN_RE` with literal `/^[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,127}$/` |
| `specs.ts` | L529 | `deepFreeze<T>` | **Not exported** — redefine locally (7 lines) |

## Contracts

### `validateProfile(profile: unknown): AgentValidationResult`

**Input contract:** Accepts any value. Returns `AgentValidationResult` (same shape as `validateAgentSpec`).

**Output contract:** `{ ok: boolean, issues: AgentValidationIssue[] }`. `ok === true` iff `issues.length === 0`.

**Check order (deterministic, collects all issues, not fail-fast):**

| # | Check | Field | Code | Message pattern |
|---|---|---|---|---|
| 1 | Must be a non-null, non-array object | `profile` | `profile-invalid` | "profile must be a non-null object" |
| 2 | `name` must be a non-empty string | `name` | `name-required` | "profile name must be a non-empty string" |
| 3 | `name` must pass `isValidAgentName()` | `name` | `name-invalid` | "profile name must match ^[a-z][a-z0-9_-]{0,63}$" |
| 4 | Reject forbidden field `tools` | `tools` | `profile-forbidden-field` | "profile must not contain field 'tools'" |
| 5 | Reject forbidden field `safety` | `safety` | `profile-forbidden-field` | same pattern |
| 6 | Reject forbidden field `limits` | `limits` | `profile-forbidden-field` | same pattern |
| 7 | Reject forbidden field `forbiddenTools` | `forbiddenTools` | `profile-forbidden-field` | same pattern |
| 8 | `model` if present: must be a non-empty string | `model` | `model-invalid` | "profile model must be a non-empty string when provided" |
| 9 | `model` if present: must pass `SAFE_ARG_TOKEN_RE` | `model` | `model-invalid` | "profile model must be a safe argv token" |
| 10 | `thinking` if present: must pass `isThinkingLevel()` | `thinking` | `thinking-invalid` | "thinking must be one of: off, minimal, low, medium, high, xhigh" |
| 11 | `purpose` if present: must be a string (empty allowed) | `purpose` | `purpose-invalid` | "purpose must be a string when provided" |

**Contract invariants:**
- Forbidden field checks (#4-7) fire before model/thinking validation (#8-10).
- Absent optional fields (`model`, `thinking`, `purpose`) are NOT errors.
- Unknown keys beyond `name`, `model`, `thinking`, `purpose` are silently ignored.

### `validateProfileLibrary(library: ModelProfileLibrary): AgentValidationResult`

**Input contract:** Must be a `ModelProfileLibrary` (TypeScript-enforced at call sites).

**Output contract:** `{ ok: boolean, issues: AgentValidationIssue[] }`.

**Issue codes:**

| # | Check | Field | Code | Message pattern |
|---|---|---|---|---|
| 1 | `library.profiles` must be an array | `library` | `library-invalid` | "profile library must have a profiles array" |
| 2 | Each profile passes `validateProfile` | varies | propagated | Individual issues field-prefixed `profiles[N].<field>` |
| 3 | No duplicate names in library | `profiles` | `profile-duplicate-name` | "duplicate profile name '<name>'" |

**Contract invariants:**
- Duplicate check runs AFTER individual validation — both error types can coexist.
- Empty `profiles` array is valid.
- Profile order preserved in issue reporting.

### `resolveSpecProfile(spec, library?): ProfileResolutionResult`

**Input contract:**
- `spec`: `{ model?: string; thinking?: ThinkingLevel; profile?: string }` — structural type, not `AgentSpec`
- `library`: `ModelProfileLibrary | undefined` — absence means no profiles available

**Output contract:** Discriminated union — `resolved: true` carries `ResolvedProfile`; `resolved: false` carries `error`.

**Resolution states (exhaustive):**

| State | `spec.profile` | Library | Profile found | Conflict | Output |
|---|---|---|---|---|---|
| A. Passthrough | undefined/null/"" | any | n/a | n/a | `resolved: true`, effective from spec, `profileName = undefined`, `profileProvided* = false` |
| B. No library | non-empty | undefined/null | n/a | n/a | `resolved: false`, error `profile-unresolved`, "no profile library available" |
| C. Not found | non-empty | has profiles | no | n/a | `resolved: false`, error `profile-unresolved`, "profile '<name>' not found" |
| D. Resolved | non-empty | has profiles | yes | no | `resolved: true`, field-level merge, `profileName` set, `profileProvided*` flags set |
| E. Conflict | non-empty | has profiles | yes | yes | `resolved: false`, error propagated from `validateModelAndThinking` |

**Error codes:**

| Code | Field | Trigger |
|---|---|---|
| `profile-unresolved` | `profile` | Profile name not found in library, or library is undefined/null/empty |
| `thinking-conflicts-with-model` | `thinking` | Propagated from `validateModelAndThinking` after fallback merge |

**Contract invariants:**
- Resolution never mutates input spec object.
- `validateModelAndThinking` is only called when resolution produces BOTH effective values (not passthrough).
- The resolver does NOT pre-validate the profile or library — callers responsible for validation.
- `:high` shorthand is preserved in `effectiveModel` — no normalization.

### Built-in profiles

```ts
export const BUILT_IN_PROFILES: Readonly<Record<string, ModelProfile>>; // deepFrozen
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

All three carry no `model` value — capability hints only. P3f-2 may add model values or users may combine with spec `model` fallback.

## Edge Cases

| # | Scenario | Expected behavior | Test |
|---|---|---|---|
| EC1 | Profile has model+thinking; spec has neither | Resolves to profile values | `resolveProfile_returns_profile_values_when_spec_has_none` |
| EC2 | Profile has model; spec has thinking | Merged: profile model + spec thinking (fallback since profile lacks thinking) | `resolveProfile_spec_thinking_fallback_when_profile_has_no_thinking` |
| EC3 | Profile has thinking; spec has model | Merged: profile thinking + spec model (fallback) | `resolveProfile_profile_thinking_spec_model_merge` |
| EC4 | Profile has `model:high` AND `thinking: high`; spec has `thinking: medium` | Profile self-consistent; spec thinking ignored; no conflict | `resolveProfile_profile_self_consistent_no_conflict` |
| EC5 | Profile has `model:high`; profile has NO thinking; spec has `thinking: medium` | Merge: `model:high` + `thinking: medium` → conflict → DENY | `resolveProfile_detects_thinking_conflict_from_fallback_merge` |
| EC6 | Spec references non-existent profile | `profile-unresolved` error, hard deny | `resolveProfile_rejects_unresolved_profile_name` |
| EC7 | Spec references profile but no library available | `profile-unresolved` error, hard deny | `resolveProfile_rejects_when_no_profile_library_available` |
| EC8 | Profile with empty name or invalid chars | `validateProfile` catches | `validateProfile_rejects_empty_name`, `validateProfile_rejects_invalid_name_characters` |
| EC9 | Duplicate profile names in library | `validateProfileLibrary` catches | `validateProfiles_rejects_duplicate_names` |
| EC10 | Profile with unsafe `model` token (whitespace, pipe, comma) | `validateProfile` catches via `SAFE_ARG_TOKEN_RE` | `validateProfile_rejects_unsafe_model_token`, `_rejects_provider_routing_syntax_in_model`, `_rejects_fallback_chain_syntax_in_model` |
| EC11 | Profile with `tools`/`safety`/`limits`/`forbiddenTools` field | `validateProfile` rejects with `profile-forbidden-field` | 4 forbidden-field tests |
| EC12 | Profile passed to resolver is structurally invalid | Resolver assumes pre-validation; behavior is safe (structural field access) | Covered by validateProfile tests (REQ-1 through REQ-7) |
| EC13 | Profile with neither model nor thinking (capability-descriptive only) | No-op resolution; effective values come from spec or remain undefined | `builtInProfiles_fast_local_is_intentionally_empty` |

## Test Case Catalog

Grouped by concern. Every test name here SHALL appear in the Requirements table.

```text
Group 1: validateProfile (12 tests)
  validateProfile_rejects_non_record_input
  validateProfile_rejects_empty_name
  validateProfile_rejects_invalid_name_characters
  validateProfile_rejects_forbidden_field_tools
  validateProfile_rejects_forbidden_field_safety
  validateProfile_rejects_forbidden_field_limits
  validateProfile_rejects_forbidden_field_forbiddenTools
  validateProfile_rejects_invalid_thinking_value
  validateProfile_rejects_empty_model_string
  validateProfile_rejects_unsafe_model_token
  validateProfile_rejects_non_string_purpose
  validateProfile_accepts_valid_profile

Group 2: Model syntax in validateProfile (3 tests)
  validateProfile_rejects_provider_routing_syntax_in_model
  validateProfile_rejects_fallback_chain_syntax_in_model
  validateProfile_allows_model_with_high_shorthand

Group 3: validateProfileLibrary (3 tests)
  validateProfiles_rejects_non_array_profiles
  validateProfiles_rejects_duplicate_names
  validateProfiles_passes_valid_library

Group 4: resolveSpecProfile (15 tests)
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
  resolveProfile_rejects_when_no_profile_library_available
  resolveProfile_unresolved_profile_hard_denies_no_fallback_to_spec
  resolveProfile_passthrough_when_no_profile_reference
  resolveProfile_does_not_mutate_original_spec
  resolveProfile_metadata_flags_set_correctly

Group 5: Built-in profiles (9 tests)
  builtInProfiles_are_capability_hints_only
  builtInProfiles_all_have_valid_names
  builtInProfiles_fast_local_is_intentionally_empty
  builtInProfiles_reasoning_and_review_contribute_at_least_thinking
  builtInProfiles_all_pass_validation
  builtInProfiles_getBuiltInProfile_unknown_is_undefined
  builtInProfiles_listBuiltInProfiles_has_correct_order
  builtInProfiles_toProfileLibrary_is_valid
  builtInProfiles_formatBuiltInProfilesList_returns_non_empty
```

Total: 42 tests.

## Risk Analysis

| Risk | Severity | Mitigation |
|---|---|---|
| `SAFE_ARG_TOKEN_RE` not exported from specs.ts → local duplication drifts | Low | Identical literal `/^[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,127}$/` with `// mirrors specs.ts L101` comment. P3f-2 consolidates via export/import. 7-line `deepFreeze` similarly low drift risk. |
| `isValidAgentName` used for profile names — semantic mismatch (function is agent-named) | Low | Logic is correct (same regex). Alias or rename in P3f-2 if desired. |
| Resolver accepts structural type `{model?, thinking?, profile?}` — not `AgentSpec` | Low | Forward-compatible: when P3f-2 adds `profile?: string` to AgentSpec, it satisfies the interface automatically. |
| Pipe/comma rejection relies on existing `SAFE_ARG_TOKEN_RE` character set | Low | Tests 22-23 use explicit `|` and `,` examples. No separate regex needed. |
| `validateModelAndThinking` called on merged result may produce false errors for edge cases | Low | Existing function already handles `model:high`, `thinking:` combinations. No new logic. |

## Open Decisions

| Decision | Deferral slice | Rationale |
|---|---|---|
| `AgentSpec.profile?: string` field | P3f-2 | Would require modifying specs.ts — violates P3f-1 zero-existing-changes rule |
| `profile` as accepted key in `AGENT_MARKDOWN_ACCEPTED_KEYS` | P3f-2 | Same rationale — agent-markdown.ts modification |
| Profile library parameter placement on `runChildAgent` | P3f-2 | Resolution happens at wiring time; P3f-1 is pure helpers |
| Profile hash registration for trust | P3f-3 | Trust gap accepted until P3f-3; P3f-2 provides visibility only |
| Override map for eval-time profile swapping | P3e+ | Experimental — requires eval harness first |

## Done Criteria

All MUST requirements passing = done. Specifically:

- [ ] `npx --yes tsc --noEmit --strict agents/lib/profiles.ts` passes
- [ ] `npx --yes tsx agents/test-fixtures/test-profiles.mjs` — all 42 tests pass
- [ ] `bash agents/test-fixtures/run-p3f-1-tests.sh` — same 42 tests pass
- [ ] `git diff --stat` on all 11 existing agent files = empty output

## Review Consensus

| Pass | Reviewer | Model | Blocker count | Verdict |
|---|---|---|---|---|
| 1 | Subagent | anthropic/claude-opus-4.8 | 0 | approve-with-nits — 4 nits found, all resolved |
| 2 | Human | — | (pending) | (pending) |

### Resolved blockers

None — zero blockers in P3f-1 review. P3F-level plan had 8 blockers resolved across 3 reviews.

### Resolved nits (P3f-1 review, 2026-06-17)

| # | Nit | Resolution |
|---|---|---|
| 1 | `SAFE_ARGV_TOKEN_RE` misspelled (source is `SAFE_ARG_TOKEN_RE`) | Renamed throughout, pinned exact literal, noted source name |
| 2 | Untested built-in helper exports | Added 4 tests: `getBuiltInProfile`, `listBuiltInProfiles`, `toProfileLibrary`, `formatBuiltInProfilesList` |
| 3 | `ResolvedProfile` metadata flags under-tested | Added `resolveProfile_metadata_flags_set_correctly` + REQ-20 |
| 4 | State B message inaccurate for empty-profiles-array case | State B now undefined/null only; empty array → State C |

## Appendix: Implementation Plan

### Files to create

1. `agents/lib/profiles.ts` — types, `validateProfile`, `validateProfileLibrary`, `resolveSpecProfile`, built-in profiles, `toProfileLibrary`, `formatBuiltInProfilesList`
2. `agents/test-fixtures/test-profiles.mjs` — 42 pure helper tests following `test-specs.mjs` conventions
3. `agents/test-fixtures/run-p3f-1-tests.sh` — single-line runner: `npx --yes tsx agents/test-fixtures/test-profiles.mjs`

### Files to modify

**None.** P3f-1 is new files only.

### Implementation sequence

| Step | Action | Validation |
|---|---|---|
| 1 | Write `profiles.ts`: types + built-in profiles + `deepFreeze` + `SAFE_ARG_TOKEN_RE` | `npx --yes tsc --noEmit --strict agents/lib/profiles.ts` |
| 2 | Add `validateProfile()` (11 checks, order doc'd above) | Same type-check |
| 3 | Add `validateProfileLibrary()` (array + duplicate checks) | Same type-check |
| 4 | Add `resolveSpecProfile()` (5-state resolution) | Same type-check |
| 5 | Write `test-profiles.mjs`: all 42 tests, 5 groups | `npx --yes tsx agents/test-fixtures/test-profiles.mjs` |
| 6 | Write `run-p3f-1-tests.sh` | `bash agents/test-fixtures/run-p3f-1-tests.sh` |
| 7 | Full validation: `git diff --stat` on 11 existing files | Empty output |
| 8 | Commit + PR | CI passes |

### Risks

| Risk | Mitigation |
|---|---|
| `tsc --noEmit` fails on import of unexported `SAFE_ARG_TOKEN_RE` | Already known — redefine locally with comment. Type-check validates. |
| `tsc --noEmit` fails on `deepFreeze` not exported | Already known — 7-line local copy. Type-check validates. |
| Test runner `tsx` not available | `npx --yes tsx` auto-installs if needed. Fallback: `npx ts-node --esm`. |
| `specs.ts` imports break if specs.ts API changes | Locked — specs.ts is stable since P3b-1. No planned changes before P3f-2. |
