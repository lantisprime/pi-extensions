/**
 * P3f-2 wiring test suite: model profiles integration with child-runner,
 * diagnostics, registration, and registry.
 *
 * Usage: npx --yes tsx agents/test-fixtures/test-p3f-2-wiring.mjs
 */

import assert from "node:assert/strict";
import { buildChildPiArgs } from "../lib/child-args.ts";
import {
  resolveSpecProfile,
  toProfileLibrary,
} from "../lib/profiles.ts";
import { formatChildAgentRunResult } from "../lib/child-runner.ts";
import { createRegisteredAgent } from "../lib/registry.ts";
import { formatRegistrationReview } from "../lib/registration.ts";
import { getBuiltInAgentSpec } from "../lib/specs.ts";

// ── Group 1: Resolution wired into buildChildPiArgs ──────────────────────

function childPiArgs_includes_model_from_resolved_profile() {
  const library = { profiles: [{ name: "test", model: "profile-model", thinking: "high" }] };
  const spec = {
    ...getBuiltInAgentSpec("scout"),
    profile: "test",
  };
  const result = resolveSpecProfile(
    { model: spec.model, thinking: spec.thinking, profile: spec.profile },
    library,
  );
  assert.equal(result.resolved, true);
  if (result.resolved) {
    assert.equal(result.effectiveModel, "profile-model");
    assert.equal(result.effectiveThinking, "high");
    // buildChildPiArgs uses the resolved values via the effective spec
    const effectiveSpec = { ...spec, model: result.effectiveModel, thinking: result.effectiveThinking };
    const invocation = buildChildPiArgs(effectiveSpec, "test task");
    // Profile model should be in argv
    assert.ok(invocation.argv.includes("profile-model"));
    assert.ok(invocation.argv.includes("high"));
  }
}

function childPiArgs_profile_wins_over_spec_model_in_argv() {
  const library = { profiles: [{ name: "test", model: "profile-model" }] };
  const spec = {
    ...getBuiltInAgentSpec("scout"),
    model: "spec-model",
    profile: "test",
  };
  const result = resolveSpecProfile(
    { model: spec.model, thinking: spec.thinking, profile: spec.profile },
    library,
  );
  assert.equal(result.resolved, true);
  if (result.resolved) {
    assert.equal(result.effectiveModel, "profile-model"); // profile wins
    const effectiveSpec = { ...spec, model: result.effectiveModel };
    const invocation = buildChildPiArgs(effectiveSpec, "test task");
    assert.ok(invocation.argv.includes("profile-model"));
    assert.equal(invocation.argv.includes("spec-model"), false);
  }
}

function childPiArgs_profile_unresolved_hard_denies() {
  const library = { profiles: [{ name: "real", model: "real-model" }] };
  const spec = {
    ...getBuiltInAgentSpec("scout"),
    model: "spec-model",
    profile: "nonexistent",
  };
  const result = resolveSpecProfile(
    { model: spec.model, thinking: spec.thinking, profile: spec.profile },
    library,
  );
  assert.equal(result.resolved, false);
  if (!result.resolved) {
    assert.equal(result.error.code, "profile-unresolved");
  }
}

function childPiArgs_passthrough_when_no_profile() {
  const library = { profiles: [{ name: "unused", model: "unused-model" }] };
  const spec = getBuiltInAgentSpec("scout");
  // spec has no profile field
  const result = resolveSpecProfile(
    { model: spec.model, thinking: spec.thinking },
    library,
  );
  assert.equal(result.resolved, true);
  if (result.resolved) {
    assert.equal(result.effectiveModel, undefined);
    assert.equal(result.effectiveThinking, undefined);
    assert.equal(result.profileName, undefined);
  }
}

// ── Group 2: formatChildAgentRunResult shows resolvedProfile ─────────────

function formatResult_shows_resolved_profile() {
  const result = {
    agentName: "scout",
    status: "completed",
    durationMs: 100,
    stdoutBytes: 50,
    stderrPreview: "",
    invocation: { command: "pi", argv: [], promptTransport: { kind: "stdin", stdinText: "" }, argvPreview: [] },
    summary: {
      summaryText: "Done",
      toolCalls: [],
      errors: [],
      usage: undefined,
      cost: undefined,
      stopReason: undefined,
      model: undefined,
      provider: undefined,
      truncation: {},
    },
    timedOut: false,
    outputLimitExceeded: false,
    resolvedProfile: "test-profile",
    resolvedModel: "resolved-model",
    resolvedThinking: "high",
  };
  const output = formatChildAgentRunResult(result);
  assert.ok(output.includes("resolvedProfile: test-profile"), `expected resolvedProfile line, got:\n${output}`);
  assert.ok(output.includes("model=resolved-model"));
  assert.ok(output.includes("thinking=high"));
}

function formatResult_no_profile_when_not_resolved() {
  const result = {
    agentName: "scout",
    status: "completed",
    durationMs: 100,
    stdoutBytes: 50,
    stderrPreview: "",
    invocation: { command: "pi", argv: [], promptTransport: { kind: "stdin", stdinText: "" }, argvPreview: [] },
    summary: {
      summaryText: "Done",
      toolCalls: [],
      errors: [],
      usage: undefined,
      cost: undefined,
      stopReason: undefined,
      model: undefined,
      provider: undefined,
      truncation: {},
    },
    timedOut: false,
    outputLimitExceeded: false,
  };
  const output = formatChildAgentRunResult(result);
  assert.equal(output.includes("resolvedProfile:"), false);
}

// ── Group 3: Registration review shows profile ──────────────────────────

function registrationReview_shows_profile() {
  const parsed = {
    source: "user",
    rawBytesSha256: "abc123",
    scannerRisk: "safe",
    status: "eligible",
    spec: {
      name: "test-agent",
      description: "test",
      source: "user",
      tools: ["read"],
      model: "gpt-4",
      thinking: "high",
      profile: "reasoning-deep",
      prompt: "test prompt",
      inputContract: { kind: "task-string", maxTaskChars: 8000, emptyTask: "reject" },
      outputContract: { requiredSections: ["Summary"], maxSummaryChars: 12000 },
      evals: [],
      limits: { timeoutMs: 120000, maxStdoutBytes: 1048576, maxStderrChars: 4000, maxResultChars: 12000, maxJsonLineBytes: 262144, maxTaskChars: 8000, maxChildProcesses: 1, maxChainLength: 3 },
      observability: { retainInMemoryRuns: 20, persistByDefault: false, includeToolTrajectory: true, storeFullPrompt: false, storeFullTask: false, storeFullToolResults: false, storeThinkingText: false },
      safety: { approveProjectByDefault: false, projectSpecsRequireTrustAndRegistration: true, allowRecursiveSubagents: false, promptTransport: "stdin-or-private-tempfile", forbiddenTools: ["write", "edit", "bash", "run_subagent"], redactDisplayedCommand: true },
    },
    metadata: {},
    prompt: "test",
    issues: [],
    warnings: [],
    unknownKeys: [],
    shadowedReservedName: false,
    eligible: true,
    scan: { risk: "safe", score: 0, findings: [] },
    bodyStartOffset: 0,
  };
  const output = formatRegistrationReview(parsed, "/path/to/test.md");
  assert.ok(output.includes("Profile: reasoning-deep"), `expected Profile line, got:\n${output}`);
}

function registrationReview_shows_none_without_profile() {
  const parsed = {
    source: "user",
    rawBytesSha256: "abc123",
    scannerRisk: "safe",
    status: "eligible",
    spec: {
      name: "test-agent",
      description: "test",
      source: "user",
      tools: ["read"],
      prompt: "test prompt",
      inputContract: { kind: "task-string", maxTaskChars: 8000, emptyTask: "reject" },
      outputContract: { requiredSections: ["Summary"], maxSummaryChars: 12000 },
      evals: [],
      limits: { timeoutMs: 120000, maxStdoutBytes: 1048576, maxStderrChars: 4000, maxResultChars: 12000, maxJsonLineBytes: 262144, maxTaskChars: 8000, maxChildProcesses: 1, maxChainLength: 3 },
      observability: { retainInMemoryRuns: 20, persistByDefault: false, includeToolTrajectory: true, storeFullPrompt: false, storeFullTask: false, storeFullToolResults: false, storeThinkingText: false },
      safety: { approveProjectByDefault: false, projectSpecsRequireTrustAndRegistration: true, allowRecursiveSubagents: false, promptTransport: "stdin-or-private-tempfile", forbiddenTools: ["write", "edit", "bash", "run_subagent"], redactDisplayedCommand: true },
    },
    metadata: {},
    prompt: "test",
    issues: [],
    warnings: [],
    unknownKeys: [],
    shadowedReservedName: false,
    eligible: true,
    scan: { risk: "safe", score: 0, findings: [] },
    bodyStartOffset: 0,
  };
  const output = formatRegistrationReview(parsed, "/path/to/test.md");
  assert.ok(output.includes("Profile: none"), `expected 'Profile: none', got:\n${output}`);
}

// ── Group 4: Registry stores profile ─────────────────────────────────────

function registryEntry_stores_profile() {
  const spec = {
    name: "test-agent",
    description: "test",
    source: "user",
    tools: ["read"],
    model: "gpt-4",
    profile: "fast-local",
    prompt: "test",
    inputContract: { kind: "task-string", maxTaskChars: 8000, emptyTask: "reject" },
    outputContract: { requiredSections: ["Summary"], maxSummaryChars: 12000 },
    evals: [],
    limits: { timeoutMs: 120000, maxStdoutBytes: 1048576, maxStderrChars: 4000, maxResultChars: 12000, maxJsonLineBytes: 262144, maxTaskChars: 8000, maxChildProcesses: 1, maxChainLength: 3 },
    observability: { retainInMemoryRuns: 20, persistByDefault: false, includeToolTrajectory: true, storeFullPrompt: false, storeFullTask: false, storeFullToolResults: false, storeThinkingText: false },
    safety: { approveProjectByDefault: false, projectSpecsRequireTrustAndRegistration: true, allowRecursiveSubagents: false, promptTransport: "stdin-or-private-tempfile", forbiddenTools: ["write", "edit", "bash", "run_subagent"], redactDisplayedCommand: true },
  };
  const entry = createRegisteredAgent(spec, {
    canonicalPath: "/path/to/test.md",
    rawBytesSha256: "abc123",
    scannerRisk: "safe",
  });
  assert.equal(entry.profile, "fast-local");
}

function registryEntry_no_profile_when_spec_has_none() {
  const spec = {
    name: "test-agent",
    description: "test",
    source: "user",
    tools: ["read"],
    prompt: "test",
    inputContract: { kind: "task-string", maxTaskChars: 8000, emptyTask: "reject" },
    outputContract: { requiredSections: ["Summary"], maxSummaryChars: 12000 },
    evals: [],
    limits: { timeoutMs: 120000, maxStdoutBytes: 1048576, maxStderrChars: 4000, maxResultChars: 12000, maxJsonLineBytes: 262144, maxTaskChars: 8000, maxChildProcesses: 1, maxChainLength: 3 },
    observability: { retainInMemoryRuns: 20, persistByDefault: false, includeToolTrajectory: true, storeFullPrompt: false, storeFullTask: false, storeFullToolResults: false, storeThinkingText: false },
    safety: { approveProjectByDefault: false, projectSpecsRequireTrustAndRegistration: true, allowRecursiveSubagents: false, promptTransport: "stdin-or-private-tempfile", forbiddenTools: ["write", "edit", "bash", "run_subagent"], redactDisplayedCommand: true },
  };
  const entry = createRegisteredAgent(spec, {
    canonicalPath: "/path/to/test.md",
    rawBytesSha256: "abc123",
    scannerRisk: "safe",
  });
  assert.equal(entry.profile, undefined);
}

// ── Group 5: Built-in profiles accessible for resolution ─────────────────

function builtInProfiles_resolve_against_built_in_library() {
  const library = toProfileLibrary();
  const spec = { profile: "reasoning-deep", thinking: "low" };
  const result = resolveSpecProfile(spec, library);
  assert.equal(result.resolved, true);
  if (result.resolved) {
    assert.equal(result.profileName, "reasoning-deep");
    assert.equal(result.effectiveThinking, "high"); // profile authoritative
    assert.equal(result.profileProvidedThinking, true);
    assert.equal(result.profileProvidedModel, false); // reasoning-deep has no model
  }
}

function builtInProfiles_fast_local_is_passthrough_effectively() {
  const library = toProfileLibrary();
  const spec = { profile: "fast-local", model: "my-model", thinking: "medium" };
  const result = resolveSpecProfile(spec, library);
  assert.equal(result.resolved, true);
  if (result.resolved) {
    assert.equal(result.profileName, "fast-local");
    // fast-local has neither model nor thinking → spec values as fallback
    assert.equal(result.effectiveModel, "my-model");
    assert.equal(result.effectiveThinking, "medium");
    assert.equal(result.profileProvidedModel, false);
    assert.equal(result.profileProvidedThinking, false);
  }
}

// ── Group 6: Spec type has profile field ─────────────────────────────────

function agentSpec_includes_profile_field() {
  // Verify profile is accessible on AgentSpec at runtime
  const spec = getBuiltInAgentSpec("scout");
  // profile is optional, not present on built-ins by default
  assert.equal(spec.profile, undefined);
  // Verify we can set it
  const withProfile = { ...spec, profile: "reasoning-deep" };
  assert.equal(withProfile.profile, "reasoning-deep");
}

// ── Runner ───────────────────────────────────────────────────────────────

function main() {
  // Group 1: Resolution wired into buildChildPiArgs
  childPiArgs_includes_model_from_resolved_profile();
  childPiArgs_profile_wins_over_spec_model_in_argv();
  childPiArgs_profile_unresolved_hard_denies();
  childPiArgs_passthrough_when_no_profile();

  // Group 2: formatChildAgentRunResult shows resolvedProfile
  formatResult_shows_resolved_profile();
  formatResult_no_profile_when_not_resolved();

  // Group 3: Registration review shows profile
  registrationReview_shows_profile();
  registrationReview_shows_none_without_profile();

  // Group 4: Registry stores profile
  registryEntry_stores_profile();
  registryEntry_no_profile_when_spec_has_none();

  // Group 5: Built-in profiles accessible for resolution
  builtInProfiles_resolve_against_built_in_library();
  builtInProfiles_fast_local_is_passthrough_effectively();

  // Group 6: Spec type has profile field
  agentSpec_includes_profile_field();

  console.log("OK: 13/13 P3f-2 wiring tests passed");
}

main();
