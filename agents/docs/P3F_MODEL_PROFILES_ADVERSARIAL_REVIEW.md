# P3F Model Profiles Adversarial Review

Review target: `agents/P3F_MODEL_PROFILES.md`
Status: **ALL BLOCKERS RESOLVED — see plan doc for Review Consensus section.** A reviewer-subagent second-opinion review was also conducted (episode `20260617-094630-2d88`). The two reviews reached consensus with the reviewer escalating the trust gap from "future extension" to a P3f-2/P3f-3 deliverable. All findings folded into the plan doc.

## Executive Verdict

**Conditional-go. The direction is sound and research-backed, but four blockers must be resolved before P3f-1 implementation starts.** The design correctly scopes profiles to `model+thinking` only, uses a static/non-dynamic resolution model, and separates profile selection from trust/safety boundaries. However, several assumptions about live references, cross-source precedence, and the absence of tool/safety bleed-through are not proven — they are asserted.

## Blocker Summary

| ID | Issue | Severity | Required before |
|---|---|---|---|
| B-001 | Profile precedence: spec-overrides-profile creates an unexpected override chain | Blocker | P3f-1 code |
| B-002 | Live references (profiles resolve at runtime) change agent behavior without registration change | Blocker | P3f-2 wiring |
| B-003 | Project trust gating is weaker than agent hash registration — a trust gap | Blocker | P3f-3 design |
| B-004 | Missing profile name in agent-markdown accepted keys creates a spec gap | Blocker | P3f-1 code |

---

## Blocker B-001: Precedence semantics — spec-overrides-profile is correct in code but wrong in user mental model

**Current design:** explicit `spec.model` / `spec.thinking` override the profile; profile fills gaps.

**The problem:** There are two plausible interpretations and the design picks one without acknowledging the conflict:

1. **Profile is the authority** (user's mental model of "I set up `deep-planner` to use DeepSeek with high thinking; the spec just says 'use deep-planner'"): The profile is a configuration layer that specs reference. If a spec ALSO has model/thinking, that's a spec bug — the profile should win, because "use deep-planner" means "use what deep-planner says."

2. **Spec is the authority** (current design): The spec is the source of truth; the profile is a convenience default. If a spec explicitly sets model/thinking, it overrides the profile because the spec author presumably had a reason.

Both are valid. Which one applies depends on who configures what:

- If the **profile** is managed centrally (ops team, standard config) and specs are authored by developers who reference profiles for consistency, profile-as-authority makes sense.
- If the **spec** is what developers control directly and profiles are personal shortcuts, spec-as-authority makes sense.

**The current design picks spec-as-authority with no justification.** This is a user-experience trap: a developer writes `profile: deep-planner` and later adds `model: gpt-4o-mini` to the spec, expecting the profile to still win. The profile silently loses. Conversely, an ops admin creates a `reviewer-critical` profile pointing at a strong model, and a developer can silently override it in their spec back to a weak model.

**Recommendation:** Explicitly pick AND DOCUMENT the authority model, with rationale. I recommend **profile is the authority** for two reasons:
1. The whole point of profiles is "this role uses this model — period." If you want a different model, create a different profile or use the override map for evals.
2. If spec overrides profile, then profiles are not enforceable centrally — a single spec can bypass them. This defeats the governance purpose (research finding #7).

**Required action:** Change the design to profile-as-authority: if `spec.profile` is set AND the profile provides a value for `model` or `thinking`, that value wins. Spec-level `model`/`thinking` is only consulted when the profile does NOT provide that field (gap-filling, the reverse of today's design).

**Acceptance criteria:**
- Test: profile has model; spec has model → profile wins
- Test: profile has thinking; spec has thinking → profile wins
- Test: profile has model only; spec has thinking only → merged (profile model + spec thinking, no conflict)
- Test: profile has neither model nor thinking; spec has both → spec wins (profile is doc-only)
- Test: profile has `model:high`; spec has `thinking: medium` → profile wins, spec thinking is ignored and no conflict error (profile is authoritative)
- Spec can still have `model`/`thinking` — but they act as fallbacks if the profile is missing that field

---

## Blocker B-002: Live profile references change agent behavior without registration gate

**Current design:** "Profiles are NOT registered by raw-file-byte hash. They are not prompts and do not execute."

**The problem:** An agent spec is registered by exact hash → trusted. The spec says `profile: adversarial-reviewer`. A profile change (operator edits `adversarial-reviewer` from `kimi-k2` to `gpt-4o-mini-fast`) silently changes what model the registered, hash-verified agent runs against. The hash says "the spec hasn't changed" but the agent's behavior has materially changed.

This is philosophically different from the agent spec model:
- Agent specs: content-addressed. If the content changes, trust is lost.
- Profiles: live references. Content changes silently affect behavior.

**The problem gets worse with malicious profiles.** A project profile under `.pi/profiles/` behind `isProjectTrusted()` could point a reviewer at `gpt-3.5-turbo` while the spec appears legitimate. If project trust is active, the profile resolves. The hash-registered agent spec can't detect this.

**Not a blocker if documented and bounded, but currently hand-waved:** The doc says "Profiles are live references (like symlinks)" — that's an assertion, not a design decision with acknowledged risk. It needs to be explicit about what this means and what the mitigations are.

**Recommendation (minimum):** Document that profile changes are NOT detectible through spec-hash verification. Add a distinct `/agents verify-profiles` or `/agents doctor` check that compares cached profile hashes to current. Add a profile-hash column to `/agents profiles` listing. This gives visibility without full hash-registration machinery.

**Recommendation (stronger, for P3f-3):** For project profiles, consider storing the resolved effective model in the registry entry alongside the profile name. Then `/agents run` can warn if the effective model at runtime differs from what was registered. This is not full hash-registration but provides a lightweight change-detection layer.

**Required action:** At minimum, document the live-reference risk explicitly in the plan doc and in `AGENT_SPEC.md`. Add profile hash visibility to `/agents doctor` in P3f-2. Defer the stronger registry-level change-detection to a design note for P3f-3.

---

## Blocker B-003: Project trust gating for profiles is weaker than agent hash registration

**Current design:** Project profiles are gated behind `ctx.isProjectTrusted()`. Agent specs are gated behind trust PLUS exact-hash registration.

**The problem:** Agent specs adopted exact-hash registration because project-local files are repo-controlled and could contain malicious prompts. The threat model acknowledged: "a project can ship a malicious agent spec; don't auto-execute it." The same threat applies to project profiles: a project can ship a `.pi/profiles/adversarial-reviewer.md` that says `model: gpt-4o-mini`. When trust is active and a registered reviewer agent references this profile, the reviewer runs at reduced capability.

The project-trust gate is NOT enough on its own — it's the same "trust once, trust everything" model that agent hash registration was specifically designed to avoid. Profiles escape that model.

**Two paths to resolve:**

**Path A (simple):** Require project profiles to be hash-registered in the project registry, same as agents. A profile change = hash mismatch = must re-register. This closes the gap but adds registry machinery to profiles.

**Path B (pragmatic):** Accept the weaker bar for profiles but add explicit visibility. Require `/agents profiles` to show project profiles, their hashes, and whether they've changed since last doctor check. Add a doctor warning for changed project profiles. This is lighter but leaves the gap partially open.

**Recommendation:** Path B for P3f-3, with Path A as a documented future extension. Profiles are NOT prompts — they can't inject instructions, only select models. A weak model is a capability degradation, not a prompt injection. The threat is real but lower severity. Explicit visibility (changed-profile warnings in doctor) is proportionate for P3. But Path A should be listed as a required enhancement if project profiles gain broader use.

**Required action:** Document this trust-gap analysis in the plan doc. Commit to profile-change visibility in P3f-2/3 doctor checks. Note hash-registration as a future extension with clear trigger criteria (e.g., "when project profiles are used in production or in shared repos").

---

## Blocker B-004: `AGENT_MARKDOWN_ACCEPTED_KEYS` must include `profile`

**Current state:** `agents/lib/agent-markdown.ts` defines `AGENT_MARKDOWN_ACCEPTED_KEYS = ["name", "description", "tools", "model", "thinking"]`. The P3F plan says to add `profile` to accepted keys.

**The problem:** The plan mentions this in the touchpoint catalog but does not explicitly list it as a required change in the slice deliverables for P3f-1. P3f-1 says "No command/wiring changes, no file discovery, no execution path edits." But adding `profile` to `AGENT_MARKDOWN_ACCEPTED_KEYS` is in `agent-markdown.ts`, not a new file. This crosses the P3f-1 boundary unless explicitly scoped.

Also: `buildSpecFromMetadata` in `agent-markdown.ts` does not currently read a `profile` key. It needs to add `...(metadata.profile ? { profile: metadata.profile as string } : {})` to the returned spec. This is a one-line change but it's in `agent-markdown.ts`, which is NOT a new P3f-1 file.

**Required action:** Either:
1. Expand P3f-1 scope slightly to include `agent-markdown.ts` changes (adding `profile` to accepted keys + `buildSpecFromMetadata`), OR
2. Create a P3f-1 micro-slice: write `profiles.ts` as a standalone module that defines the `ModelProfile` type and `resolveProfile`, WITHOUT a `profile` field on `AgentSpec`. The `profile?: string` field and frontmatter key are added in P3f-2. This keeps P3f-1 pure-additive (new file only).

**I recommend option 2** — it keeps P3f-1 reviewable in complete isolation (one new file, one test file). The `AgentSpec.profile` field and accepted keys go into P3f-2 where the wiring lives.

---

## High-Risk Issues

### R-001: No mechanism to detect "profile drift" across runs

If `adversarial-reviewer` is swapped from Kimi to GLM between two runs of the same agent, the behavior changes with zero audit trail unless the user manually inspects `/agents profiles`. The observability design captures the resolved profile name in run metadata — but run metadata is not persistent by default in P3 (observability policy: `persistByDefault: false`).

**Recommendation:** Add a profile-change event (warning-level notification) when the resolved effective model for a registered agent differs from what was last used. Even without persistence, the in-memory run history (20 entries) gives a short audit window. Doctor should show profile hashes to enable manual comparison.

### R-002: Override map is an eval feature that doesn't exist yet

The `resolveProfile(spec, library, { overrides })` design is forward-looking — it expects an eval harness that can swap profile bindings for A/B comparisons. No eval harness exists (evals are P3e, not yet implemented).

**Risk:** The override map adds complexity (and test surface) for a feature that may never be used in the expected way, or may need a different design when evals actually materialize.

**Recommendation:** Keep the override map in the type signature but mark it as `experimental` / defer tests for it. If evals require a different mechanism, the type can change before it stabilizes. Do not spend test effort on `resolveProfile_override_map_*` tests until an eval harness exists.

### R-003: Spec-level `model`/`thinking` without a profile creates a "what profile am I?" confusion

Currently, an agent spec can have no profile but explicit `model`/`thinking`. Another spec can have a profile AND explicit `model`/`thinking`. In the display (`/agents list`, `/agents inspect`), these look different but work similarly. The semantics are confusing:

- Spec A: `model: deepseek-v3.2, thinking: high` — no profile, direct model selection
- Spec B: `profile: deep-planner, model: deepseek-v3.2, thinking: high` — profile PLUS overrides

Under the **current design** (spec-overrides-profile), Spec A and Spec B are identical at runtime. Under the **B-001 fix** (profile-as-authority), Spec B would use the profile's values and ignore the explicit spec model/thinking — very different behavior from Spec A despite looking similar in the spec file.

**Recommendation:** `/agents inspect` should clearly separate effective model (after resolution) from declared model (in the spec) so the user can see what's actually happening. Show:

```text
Profile: deep-planner
  Profile.model: deepseek-v3.2 (applied)
  Profile.thinking: high (applied)
Spec.model: <not set>
Spec.thinking: <not set>
Effective: deepseek-v3.2, thinking=high
```

And when there's an override:

```text
Profile: deep-planner  
  Profile.model: deepseek-v3.2 (overridden by spec)
  Profile.thinking: high (applied)
Spec.model: glm-5.1 (override)
Spec.thinking: <not set>
Effective: glm-5.1, thinking=high
```

This is more diagnostic work but prevents the confusion.

### R-004: Profile names use the same regex as agent names — collision possible

Both agents and profiles use `^[a-z][a-z0-9_-]{0,63}$`. A user can have an agent named `deep-planner` AND a profile named `deep-planner`. These are in different namespaces (agent spec names vs profile names), but the user sees `deep-planner` in two contexts and may confuse them.

**Recommendation:** `/agents list` and `/agents profiles` are separate commands, so the namespaces are syntactically separated. But `/agents inspect deep-planner` should show both if both exist: agent record AND profile record. Document the namespace separation clearly.

---

## Medium-Risk Issues

### M-001: Profile library loading — when, where, how often?

The design says "resolve in `runChildAgent`, pass profileLibrary via `RunChildAgentOptions`." But where does the profile library come from? Is it loaded once at session start (like diagnostics), or per-run?

**If loaded once at session start:** Needs a load point in the extension lifecycle. Currently diagnostics are collected on-command. A profile library load adds session-start overhead for something that may not be used.

**If loaded per-run:** Parsing profile files on every `/agents run` is wasteful and slow for Markdown discovery.

**Recommendation:** Load once in `executeChildRun` or at session start, cache in `AgentsContext`, refresh on `/agents reload` or profile change. Document the caching strategy in P3f-2.

### M-002: Purpose field is doc-only — dead weight?

`ModelProfile.purpose` is described as "human documentation only; not used at runtime." If it's never read by code, it becomes stale metadata that authors forget to update. It serves no structural purpose in validation or resolution.

**Recommendation:** Either:
1. Use `purpose` in diagnostics — show it in `/agents profiles` listing as the human-readable description of what the profile is for. This gives it a display slot and keeps it maintained.
2. Drop it from the type and defer to a later slice if needed.

Option 1 is cheap and adds value.

### M-003: Built-in profiles create a maintenance burden

The plan proposes built-in profiles (e.g. `local-coder`, `deep-planner`, `adversarial-reviewer`) in `specs.ts`. These encode opinionated model choices in extension code:
- `local-coder → qwen3-coder-30b` — assumes a local model
- `deep-planner → deepseek-v3.2` — assumes access to a specific commercial model
- `adversarial-reviewer → kimi-k2-thinking` — assumes access to another specific model

These models may not exist for all users. A built-in profile that can't resolve (model not available in user's Pi config) will cause a spawn-error at runtime — the child Pi will fail to start. This is worse than no profile, where Pi uses its default model.

**Recommendation:** Built-in profiles should NOT encode specific model names. Instead, they should be capability-descriptive:
- `fast-local` — no model/thinking set (lets Pi default)
- `reasoning-deep` — `thinking: high` only (no model, Pi picks based on what's configured)
- `adversarial-review` — `thinking: high` only (no model, let Pi pick a different provider for diversity)

This way built-in profiles are capability hints that don't break when a user doesn't have a specific model. Users/projects can override with specific model names in their own profiles.

OR: If specific model names in built-ins are desired, add a validation step that checks profile model availability at resolution time and falls back gracefully (which the current design does NOT do — it passes unknown models to Pi and lets Pi fail).

### M-004: `RunChildAgentOptions.profileLibrary` breaks the clean injection separation

Currently `RunChildAgentOptions` carries execution concerns (cwd, env, spawn, timeouts, limits). Adding `profileLibrary` couples execution options to configuration. Profile library is a configuration concern, not an execution concern.

**Recommendation:** Either pass `profileLibrary` separately from `RunChildAgentOptions`, or move resolution into `executeChildRun` in index.ts (resolve before calling `runChildAgent`). The latter is actually cleaner — resolution happens at the orchestration layer, not the execution layer. A third option: resolve in `buildChildPiArgs` directly (add a profileLibrary param there). This is the most localized change but couples argv construction to configuration.

I lean toward resolving in `runChildAgent` but keeping profileLibrary separate from execution options:

```ts
export async function runChildAgent(spec: AgentSpec, task: string, options: RunChildAgentOptions = {}, profiles?: ModelProfileLibrary): Promise<ChildAgentRunResult>
```

This is a new parameter, not a field on options. Clean separation.

### M-005: The plan currently has 23 test cases for P3f-1 — scope slip risk

23 pure-helper test cases is a large test surface for a single slice. Several of these (override map tests, purpose-only profile tests) are edge cases with no corresponding code path in P3f-1.

**Recommendation:** Implement core tests first (resolution precedence, conflict detection, unresolved denial, built-in integrity). Defer edge-case tests to P3f-2 when the wiring proves them valuable. Ship P3f-1 with ~12-15 tests, not 23.

---

## Non-Blockers (noted for awareness)

### N-001: CrewAI-style function-calling-model split

Documented as a future extension. No action needed in P3F.

### N-002: Dynamic/complexity routing

Correctly scoped out. The research backs this.

### N-003: Fallback chains

Correctly banned. No design change needed.

### N-004: Profile file format (Markdown vs JSON)

Deferred to P3f-3. Reasonable. But note that Markdown frontmatter reuses the bounded parser for agents. If agent-markdown.ts changes its parser, profiles inherit those changes. JSON would be independent. Small coupling risk; document it.

---

## Required Plan Changes Before Implementation

1. **B-001 (blocker):** Flip precedence to profile-as-authority, with rationale documented.
2. **B-002 (blocker):** Document live-reference risk; commit to profile-hash visibility in doctor; note registry change-detection as future extension.
3. **B-003 (blocker):** Document trust-gap between agent hash registration and profile trust-gating; choose Path B (hash visibility) for P3f-3; note Path A (hash-registration for profiles) as future.
4. **B-004 (blocker):** Decide P3f-1 boundary: either include agent-markdown.ts changes or defer AgentSpec.profile field to P3f-2. Recommend deferring.
5. **M-001 (medium):** Document profile library caching strategy.
6. **M-003 (medium):** Reconsider built-in profiles — capability hints vs specific model names.
7. **M-004 (medium):** Separate profileLibrary from RunChildAgentOptions.
8. **M-005 (medium):** Trim P3f-1 test cases to 12-15 core tests.

## Final Recommendation

**Conditional-go.** Proceed with P3f-1 only after the four blockers are resolved in the plan doc. The direction is right, the research backing is solid, and the execution seam is clean. But the precedence, live-reference, trust-gap, and slice-boundary issues are real design problems that should be settled in the plan, not discovered during code review.

Recommended resolution order:

1. First: resolve B-001 (precedence flip) — this changes the entire semantics
2. Second: resolve B-004 (P3f-1 boundary) — this determines what goes in the first PR
3. Third: resolve B-002 + B-003 (trust/reference risk) — critical for P3f-2/3 design
4. Fourth: address M-001 through M-005 (nice-to-haves)

After all blockers are resolved in `P3F_MODEL_PROFILES.md`, P3f-1 is:

```text
NEW FILE: agents/lib/profiles.ts
  - ModelProfile type, THINKING_LEVELS reuse, name validation
  - resolveProfile(spec, library) with profile-as-authority precedence
  - validateProfile(single), validateProfiles(library)
  - built-in profiles (capability hints only, no specific models)
  - unresolved-profile denial code

NEW FILE: agents/test-fixtures/test-profiles.mjs
  - ~12-15 core tests (resolution, precedence, conflict, denial, built-in integrity)
  - No override map tests (defer to evals)

NO CHANGES to existing files
```

After P3f-1 merge and P3c-3 stability, P3f-2 adds the AgentSpec.profile field, accepted keys, wiring, diagnostics, and doctor checks.
