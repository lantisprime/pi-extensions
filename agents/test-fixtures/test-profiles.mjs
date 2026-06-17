/**
 * P3f-1 test suite: model profiles pure helpers.
 * 42 tests, 5 groups. Follows test-specs.mjs conventions.
 *
 * Usage: npx --yes tsx agents/test-fixtures/test-profiles.mjs
 */

import assert from "node:assert/strict";
import {
  BUILT_IN_PROFILES,
  formatBuiltInProfilesList,
  getBuiltInProfile,
  listBuiltInProfiles,
  resolveSpecProfile,
  toProfileLibrary,
  validateProfile,
  validateProfileLibrary,
} from "../lib/profiles.ts";

function codes(result) {
  return result.issues.map((i) => i.code);
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

// ── Group 1: validateProfile (12 tests) ───────────────────────────────────

function validateProfile_rejects_non_record_input() {
  const results = [
    validateProfile(null),
    validateProfile(42),
    validateProfile("string"),
    validateProfile([]),
    validateProfile(true),
  ];
  for (const r of results) {
    assert.equal(r.ok, false);
    assert.deepEqual(codes(r), ["profile-invalid"]);
    assert.match(r.issues[0].message, /profile must be a non-null object/);
  }
}

function validateProfile_rejects_empty_name() {
  const results = [
    validateProfile({}),
    validateProfile({ name: "" }),
    validateProfile({ name: 123 }),
  ];
  for (const r of results) {
    assert.equal(r.ok, false);
    assert.equal(r.issues.some((i) => i.code === "name-required"), true);
  }
}

function validateProfile_rejects_invalid_name_characters() {
  const result = validateProfile({ name: "Bad Name!" });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ["name-invalid"]);
  assert.match(result.issues[0].message, /profile name must match/);
}

function validateProfile_rejects_forbidden_field_tools() {
  const result = validateProfile({ name: "test", tools: ["read"] });
  assert.equal(result.ok, false);
  assert.equal(result.issues.some((i) => i.field === "tools" && i.code === "profile-forbidden-field"), true);
  assert.match(result.issues.find((i) => i.field === "tools").message, /must not contain field 'tools'/);
}

function validateProfile_rejects_forbidden_field_safety() {
  const result = validateProfile({ name: "test", safety: {} });
  assert.equal(result.ok, false);
  assert.equal(result.issues.some((i) => i.field === "safety" && i.code === "profile-forbidden-field"), true);
}

function validateProfile_rejects_forbidden_field_limits() {
  const result = validateProfile({ name: "test", limits: {} });
  assert.equal(result.ok, false);
  assert.equal(result.issues.some((i) => i.field === "limits" && i.code === "profile-forbidden-field"), true);
}

function validateProfile_rejects_forbidden_field_forbiddenTools() {
  const result = validateProfile({ name: "test", forbiddenTools: ["bash"] });
  assert.equal(result.ok, false);
  assert.equal(result.issues.some((i) => i.field === "forbiddenTools" && i.code === "profile-forbidden-field"), true);
}

function validateProfile_rejects_invalid_thinking_value() {
  const result = validateProfile({ name: "test", thinking: "ultra" });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ["thinking-invalid"]);
  assert.match(result.issues[0].message, /thinking must be one of/);
}

function validateProfile_rejects_empty_model_string() {
  const result = validateProfile({ name: "test", model: "" });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ["model-invalid"]);
  assert.match(result.issues[0].message, /model must be a non-empty string/);
}

function validateProfile_rejects_unsafe_model_token() {
  const result = validateProfile({ name: "test", model: "bad model with spaces" });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ["model-invalid"]);
  assert.match(result.issues[0].message, /safe argv token/);
}

function validateProfile_rejects_non_string_purpose() {
  const result = validateProfile({ name: "test", purpose: 42 });
  assert.equal(result.ok, false);
  assert.equal(result.issues.some((i) => i.field === "purpose" && i.code === "purpose-invalid"), true);
  assert.match(result.issues.find((i) => i.field === "purpose").message, /purpose must be a string/);
}

function validateProfile_accepts_valid_profile() {
  const result = validateProfile({
    name: "test-profile",
    model: "claude-sonnet:high",
    thinking: "high",
    purpose: "Test profile",
    extraUnknown: "ignored",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
}

function validateProfile_allows_self_conflicting_at_validation_time() {
  // A profile with model:high + different thinking passes validation.
  // The conflict is a resolution-time concern (resolveSpecProfile State E).
  const result = validateProfile({
    name: "self-conflict",
    model: "claude-sonnet:high",
    thinking: "low",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
}

// ── Group 2: Model syntax in validateProfile (3 tests) ────────────────────

function validateProfile_rejects_provider_routing_syntax_in_model() {
  const result = validateProfile({ name: "test", model: "provider1|provider2/model" });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ["model-invalid"]);
  // Pipe character is not in SAFE_ARG_TOKEN_RE character set
}

function validateProfile_rejects_fallback_chain_syntax_in_model() {
  const result = validateProfile({ name: "test", model: "modelA,modelB" });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ["model-invalid"]);
  // Comma character is not in SAFE_ARG_TOKEN_RE character set
}

function validateProfile_allows_model_with_high_shorthand() {
  const result = validateProfile({ name: "test", model: "claude-sonnet:high" });
  assert.equal(result.ok, true);
  // :high shorthand is in the allowed character set ([A-Za-z0-9._/@:+-])
}

// ── Group 3: validateProfileLibrary (3 tests) ─────────────────────────────

function validateProfiles_rejects_non_array_profiles() {
  const result = validateProfileLibrary({ profiles: "not-an-array" });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ["library-invalid"]);
}

function validateProfiles_rejects_duplicate_names() {
  const library = {
    profiles: [
      { name: "dup", thinking: "high" },
      { name: "unique", thinking: "low" },
      { name: "dup", thinking: "medium" },
    ],
  };
  const result = validateProfileLibrary(library);
  assert.equal(result.ok, false);
  assert.equal(result.issues.some((i) => i.code === "profile-duplicate-name"), true);
  assert.match(result.issues.find((i) => i.code === "profile-duplicate-name").message, /duplicate profile name 'dup'/);
}

function validateProfiles_passes_valid_library() {
  const library = {
    profiles: [
      { name: "a", thinking: "high" },
      { name: "b", model: "claude-sonnet" },
    ],
  };
  const result = validateProfileLibrary(library);
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
}

function validateProfiles_invalid_profile_propagates_field_prefix() {
  const library = {
    profiles: [
      { name: "valid" },
      {}, // no name → name-required
    ],
  };
  const result = validateProfileLibrary(library);
  assert.equal(result.ok, false);
  // The error from profiles[1] should be field-prefixed
  assert.equal(result.issues.some((i) => i.field === "profiles[1].name" && i.code === "name-required"), true);
}

function validateProfiles_duplicate_and_individual_errors_coexist() {
  const library = {
    profiles: [
      {}, // invalid: no name
      {}, // invalid: no name
    ],
  };
  const result = validateProfileLibrary(library);
  assert.equal(result.ok, false);
  // Both individual errors should be present
  assert.equal(result.issues.filter((i) => i.code === "name-required").length, 2);
  // No duplicate-name error since neither has a string name (can't track)
  assert.equal(result.issues.some((i) => i.code === "profile-duplicate-name"), false);

  // Now: duplicate names WITH individual errors
  const lib2 = {
    profiles: [
      { name: "dup", thinking: "invalid" },
      { name: "dup", thinking: "also_invalid" },
    ],
  };
  const result2 = validateProfileLibrary(lib2);
  assert.equal(result2.ok, false);
  // Both individual thinking-invalid errors
  assert.equal(result2.issues.filter((i) => i.code === "thinking-invalid").length, 2);
  // AND a duplicate-name error
  assert.equal(result2.issues.some((i) => i.code === "profile-duplicate-name"), true);
}

// ── Group 4: resolveSpecProfile (15 tests) ────────────────────────────────

function resolveProfile_returns_profile_values_when_spec_has_none() {
  const spec = { profile: "test" };
  const library = { profiles: [{ name: "test", model: "gpt-4", thinking: "high" }] };
  const r = resolveSpecProfile(spec, library);
  assert.equal(r.resolved, true);
  if (r.resolved) {
    assert.equal(r.effectiveModel, "gpt-4");
    assert.equal(r.effectiveThinking, "high");
    assert.equal(r.profileName, "test");
    assert.equal(r.profileProvidedModel, true);
    assert.equal(r.profileProvidedThinking, true);
  }
}

function resolveProfile_profile_wins_over_spec_model() {
  const spec = { model: "slow-model", profile: "test" };
  const library = { profiles: [{ name: "test", model: "fast-model" }] };
  const r = resolveSpecProfile(spec, library);
  assert.equal(r.resolved, true);
  if (r.resolved) {
    assert.equal(r.effectiveModel, "fast-model");
    assert.equal(r.profileProvidedModel, true);
  }
}

function resolveProfile_profile_wins_over_spec_thinking() {
  const spec = { thinking: "low", profile: "test" };
  const library = { profiles: [{ name: "test", thinking: "high" }] };
  const r = resolveSpecProfile(spec, library);
  assert.equal(r.resolved, true);
  if (r.resolved) {
    assert.equal(r.effectiveThinking, "high");
    assert.equal(r.profileProvidedThinking, true);
  }
}

function resolveProfile_spec_thinking_fallback_when_profile_has_no_thinking() {
  const spec = { thinking: "medium", profile: "test" };
  const library = { profiles: [{ name: "test", model: "gpt-4" }] };
  const r = resolveSpecProfile(spec, library);
  assert.equal(r.resolved, true);
  if (r.resolved) {
    assert.equal(r.effectiveModel, "gpt-4");
    assert.equal(r.effectiveThinking, "medium"); // spec fallback
    assert.equal(r.profileProvidedModel, true);
    assert.equal(r.profileProvidedThinking, false);
  }
}

function resolveProfile_spec_model_fallback_when_profile_has_no_model() {
  const spec = { model: "fallback-model", profile: "test" };
  const library = { profiles: [{ name: "test", thinking: "high" }] };
  const r = resolveSpecProfile(spec, library);
  assert.equal(r.resolved, true);
  if (r.resolved) {
    assert.equal(r.effectiveModel, "fallback-model"); // spec fallback
    assert.equal(r.effectiveThinking, "high");
    assert.equal(r.profileProvidedModel, false);
    assert.equal(r.profileProvidedThinking, true);
  }
}

function resolveProfile_profile_model_spec_thinking_merge() {
  const spec = { thinking: "low", profile: "test" };
  const library = { profiles: [{ name: "test", model: "gpt-4" }] };
  const r = resolveSpecProfile(spec, library);
  assert.equal(r.resolved, true);
  if (r.resolved) {
    assert.equal(r.effectiveModel, "gpt-4");
    assert.equal(r.effectiveThinking, "low");
  }
}

function resolveProfile_profile_thinking_spec_model_merge() {
  const spec = { model: "fallback-model", profile: "test" };
  const library = { profiles: [{ name: "test", thinking: "high" }] };
  const r = resolveSpecProfile(spec, library);
  assert.equal(r.resolved, true);
  if (r.resolved) {
    assert.equal(r.effectiveModel, "fallback-model");
    assert.equal(r.effectiveThinking, "high");
  }
}

function resolveProfile_detects_thinking_conflict_from_fallback_merge() {
  // Profile has model:high (no thinking); spec has thinking:medium
  // Merge: model:high + thinking:medium → conflict
  const spec = { thinking: "medium", profile: "test" };
  const library = { profiles: [{ name: "test", model: "claude-sonnet:high" }] };
  const r = resolveSpecProfile(spec, library);
  assert.equal(r.resolved, false);
  if (!r.resolved) {
    assert.equal(r.error.code, "thinking-conflicts-with-model");
  }
}

function resolveProfile_profile_self_consistent_no_conflict() {
  // Profile provides both model:high AND thinking:high; spec has thinking:medium
  // Profile is self-consistent; spec thinking is ignored; no conflict
  const spec = { thinking: "medium", profile: "test" };
  const library = { profiles: [{ name: "test", model: "claude-sonnet:high", thinking: "high" }] };
  const r = resolveSpecProfile(spec, library);
  assert.equal(r.resolved, true);
  if (r.resolved) {
    assert.equal(r.effectiveModel, "claude-sonnet:high");
    assert.equal(r.effectiveThinking, "high");
    assert.equal(r.profileProvidedModel, true);
    assert.equal(r.profileProvidedThinking, true);
  }
}

function resolveProfile_rejects_unresolved_profile_name() {
  const spec = { profile: "nonexistent" };
  const library = { profiles: [{ name: "real", model: "gpt-4" }] };
  const r = resolveSpecProfile(spec, library);
  assert.equal(r.resolved, false);
  if (!r.resolved) {
    assert.equal(r.error.code, "profile-unresolved");
    assert.match(r.error.message, /profile 'nonexistent' not found/);
  }
}

function resolveProfile_rejects_when_no_profile_library_available() {
  const spec = { profile: "test" };
  const r = resolveSpecProfile(spec, undefined);
  assert.equal(r.resolved, false);
  if (!r.resolved) {
    assert.equal(r.error.code, "profile-unresolved");
    assert.match(r.error.message, /no profile library available/);
  }
}

function resolveProfile_unresolved_profile_hard_denies_no_fallback_to_spec() {
  // Spec has model/thinking, but profile can't resolve → hard deny, not fallback
  const spec = { model: "should-not-be-used", thinking: "high", profile: "missing" };
  const library = { profiles: [{ name: "real", model: "gpt-4" }] };
  const r = resolveSpecProfile(spec, library);
  assert.equal(r.resolved, false);
  if (!r.resolved) {
    assert.equal(r.error.code, "profile-unresolved");
  }
  // effective model/thinking must NOT be the spec values
}

function resolveProfile_passthrough_when_no_profile_reference() {
  // spec.profile is undefined/null/empty → passthrough
  const tests = [
    { model: "gpt-4", thinking: "high" },
    { model: "gpt-4", thinking: "high", profile: undefined },
    { model: "gpt-4", thinking: "high", profile: null },
    { model: "gpt-4", thinking: "high", profile: "" },
  ];
  const library = { profiles: [{ name: "unused", model: "should-not-appear" }] };
  for (const spec of tests) {
    const r = resolveSpecProfile(spec, library);
    assert.equal(r.resolved, true);
    if (r.resolved) {
      assert.equal(r.effectiveModel, "gpt-4");
      assert.equal(r.effectiveThinking, "high");
      assert.equal(r.profileName, undefined);
      assert.equal(r.profileProvidedModel, false);
      assert.equal(r.profileProvidedThinking, false);
    }
  }
}

function resolveProfile_does_not_mutate_original_spec() {
  const spec = clone({ model: "original", thinking: "low", profile: "test" });
  const library = { profiles: [{ name: "test", model: "override" }] };
  resolveSpecProfile(spec, library);
  // Original must be unchanged
  assert.equal(spec.model, "original");
  assert.equal(spec.thinking, "low");
  assert.equal(spec.profile, "test");
}

function resolveProfile_metadata_flags_set_correctly() {
  // Test profileProvidedModel/profileProvidedThinking on resolved path
  const library = { profiles: [{ name: "full", model: "gpt-4", thinking: "high" }] };

  // Profile provides both
  const r1 = resolveSpecProfile({ profile: "full" }, library);
  assert.equal(r1.resolved, true);
  if (r1.resolved) {
    assert.equal(r1.profileName, "full");
    assert.equal(r1.profileProvidedModel, true);
    assert.equal(r1.profileProvidedThinking, true);
  }

  // Passthrough (no profile) — all metadata false/undefined
  const r2 = resolveSpecProfile({ model: "gpt-4", thinking: "high" }, library);
  assert.equal(r2.resolved, true);
  if (r2.resolved) {
    assert.equal(r2.profileName, undefined);
    assert.equal(r2.profileProvidedModel, false);
    assert.equal(r2.profileProvidedThinking, false);
  }
}

// ── Group 5: Built-in profiles (9 tests) ──────────────────────────────────

function builtInProfiles_are_capability_hints_only() {
  for (const [name, profile] of Object.entries(BUILT_IN_PROFILES)) {
    assert.equal(profile.model, undefined, `Built-in '${name}' must not have a hardcoded model`);
  }
}

function builtInProfiles_all_have_valid_names() {
  for (const [name, profile] of Object.entries(BUILT_IN_PROFILES)) {
    assert.match(name, /^[a-z][a-z0-9_-]{0,63}$/, `Built-in '${name}' name invalid`);
    assert.equal(profile.name, name);
  }
}

function builtInProfiles_fast_local_is_intentionally_empty() {
  const profile = BUILT_IN_PROFILES["fast-local"];
  assert.ok(profile, "fast-local must exist");
  assert.equal(profile.model, undefined);
  assert.equal(profile.thinking, undefined);
}

function builtInProfiles_reasoning_and_review_contribute_at_least_thinking() {
  const reasoning = BUILT_IN_PROFILES["reasoning-deep"];
  assert.ok(reasoning, "reasoning-deep must exist");
  assert.equal(reasoning.thinking, "high");

  const review = BUILT_IN_PROFILES["adversarial-review"];
  assert.ok(review, "adversarial-review must exist");
  assert.equal(review.thinking, "high");
}

function builtInProfiles_all_pass_validation() {
  for (const profile of Object.values(BUILT_IN_PROFILES)) {
    const result = validateProfile(profile);
    assert.equal(result.ok, true, `Built-in '${profile.name}' must pass validation: ${JSON.stringify(result.issues)}`);
  }
}

function builtInProfiles_getBuiltInProfile_unknown_is_undefined() {
  assert.equal(getBuiltInProfile("nonexistent"), undefined);
  assert.equal(getBuiltInProfile(""), undefined);
}

function builtInProfiles_listBuiltInProfiles_has_correct_order() {
  const list = listBuiltInProfiles();
  assert.equal(list.length, 3);
  assert.equal(list[0].name, "fast-local");
  assert.equal(list[1].name, "reasoning-deep");
  assert.equal(list[2].name, "adversarial-review");
}

function builtInProfiles_toProfileLibrary_is_valid() {
  const library = toProfileLibrary();
  assert.ok(Array.isArray(library.profiles));
  assert.equal(library.profiles.length, 3);
  const result = validateProfileLibrary(library);
  assert.equal(result.ok, true, `toProfileLibrary() output must pass validation: ${JSON.stringify(result.issues)}`);
}

function builtInProfiles_formatBuiltInProfilesList_returns_non_empty() {
  const output = formatBuiltInProfilesList();
  assert.ok(typeof output === "string");
  assert.ok(output.length > 0);
  // Contains all three profile names
  assert.ok(output.includes("fast-local"));
  assert.ok(output.includes("reasoning-deep"));
  assert.ok(output.includes("adversarial-review"));

  // Empty list
  assert.equal(formatBuiltInProfilesList([]), "(none)");
}

// ── Runner ────────────────────────────────────────────────────────────────

function main() {
  // Group 1: validateProfile (12)
  validateProfile_rejects_non_record_input();
  validateProfile_rejects_empty_name();
  validateProfile_rejects_invalid_name_characters();
  validateProfile_rejects_forbidden_field_tools();
  validateProfile_rejects_forbidden_field_safety();
  validateProfile_rejects_forbidden_field_limits();
  validateProfile_rejects_forbidden_field_forbiddenTools();
  validateProfile_rejects_invalid_thinking_value();
  validateProfile_rejects_empty_model_string();
  validateProfile_rejects_unsafe_model_token();
  validateProfile_rejects_non_string_purpose();
  validateProfile_accepts_valid_profile();
  validateProfile_allows_self_conflicting_at_validation_time();

  // Group 2: Model syntax (3)
  validateProfile_rejects_provider_routing_syntax_in_model();
  validateProfile_rejects_fallback_chain_syntax_in_model();
  validateProfile_allows_model_with_high_shorthand();

  // Group 3: validateProfileLibrary (5)
  validateProfiles_rejects_non_array_profiles();
  validateProfiles_rejects_duplicate_names();
  validateProfiles_passes_valid_library();
  validateProfiles_invalid_profile_propagates_field_prefix();
  validateProfiles_duplicate_and_individual_errors_coexist();

  // Group 4: resolveSpecProfile (15)
  resolveProfile_returns_profile_values_when_spec_has_none();
  resolveProfile_profile_wins_over_spec_model();
  resolveProfile_profile_wins_over_spec_thinking();
  resolveProfile_spec_thinking_fallback_when_profile_has_no_thinking();
  resolveProfile_spec_model_fallback_when_profile_has_no_model();
  resolveProfile_profile_model_spec_thinking_merge();
  resolveProfile_profile_thinking_spec_model_merge();
  resolveProfile_detects_thinking_conflict_from_fallback_merge();
  resolveProfile_profile_self_consistent_no_conflict();
  resolveProfile_rejects_unresolved_profile_name();
  resolveProfile_rejects_when_no_profile_library_available();
  resolveProfile_unresolved_profile_hard_denies_no_fallback_to_spec();
  resolveProfile_passthrough_when_no_profile_reference();
  resolveProfile_does_not_mutate_original_spec();
  resolveProfile_metadata_flags_set_correctly();

  // Group 5: Built-in profiles (9)
  builtInProfiles_are_capability_hints_only();
  builtInProfiles_all_have_valid_names();
  builtInProfiles_fast_local_is_intentionally_empty();
  builtInProfiles_reasoning_and_review_contribute_at_least_thinking();
  builtInProfiles_all_pass_validation();
  builtInProfiles_getBuiltInProfile_unknown_is_undefined();
  builtInProfiles_listBuiltInProfiles_has_correct_order();
  builtInProfiles_toProfileLibrary_is_valid();
  builtInProfiles_formatBuiltInProfilesList_returns_non_empty();

  console.log("OK: 45/45 tests passed");
}

main();
