import assert from "node:assert";
import { profileEffect } from "../lib/intent-router.ts";
import { parseRunArgs } from "../lib/run-resolver.ts";
import { agentProfileNameCollisions, formatAgentsDoctor, formatAgentInspect } from "../lib/diagnostics.ts";

// ── Group 7: Disambiguation hardening ──

function testProfileEffect_classifies() {
  assert.equal(profileEffect({}), "none");
  assert.equal(profileEffect({ model: "gpt-5" }), "model");
  assert.equal(profileEffect({ thinking: "high" }), "thinking");
  assert.equal(profileEffect({ model: "gpt-5", thinking: "high" }), "both");
}

function testParseRun_warnsMisplacedProfile() {
  // --profile must come right after agent name
  const r = parseRunArgs("scout --profile fast-local task text");
  assert.equal(r.ok, true);
  // --profile is at tokens[1], so it IS in the right position — no warning
  assert.equal(r.warning, undefined);

  // Misplaced: --profile appears mid-task
  const r2 = parseRunArgs("scout do something --profile fast-local");
  assert.equal(r2.ok, true);
  assert.ok(r2.warning && r2.warning.includes("must come right after the agent name"),
    `expected warning, got: ${r2.warning}`);

  // No --profile at all → no warning
  const r3 = parseRunArgs("scout simple task");
  assert.equal(r3.ok, true);
  assert.equal(r3.warning, undefined);
}

function testDoctor_warnsAgentProfileCollision() {
  const records = [{
    name: "fast-local", source: "user", status: "runnable", runnable: true, registered: true,
    reason: "", nextStep: "", tools: ["read"], evalStatus: "missing",
    issues: [], hashMismatch: false, shadowedReservedName: false, scannerRisk: "safe",
    filePath: "/fake/fast-local.md", canonicalPath: "/fake/fast-local.md", rawBytesSha256: "abc",
    spec: { name: "fast-local", description: "test", source: "user", tools: ["read"], prompt: "test",
      inputContract: { kind: "task-string", maxTaskChars: 100, emptyTask: "reject" },
      outputContract: { requiredSections: ["Summary"], maxSummaryChars: 500 }, evals: [],
      limits: { timeoutMs: 1000, maxStdoutBytes: 1000, maxStderrChars: 200, maxResultChars: 500, maxJsonLineBytes: 500, maxTaskChars: 100, maxChildProcesses: 1, maxChainLength: 3 },
      observability: { retainInMemoryRuns: 20, persistByDefault: false, includeToolTrajectory: true, storeFullPrompt: false, storeFullTask: false, storeFullToolResults: false, storeThinkingText: false },
      safety: { approveProjectByDefault: false, projectSpecsRequireTrustAndRegistration: true, allowRecursiveSubagents: false, promptTransport: "stdin-or-private-tempfile", forbiddenTools: ["write", "edit", "bash", "run_subagent"], redactDisplayedCommand: true },
    },
  }];
  const diag = { records, summary: { blocked: 0 }, projectTrusted: true, projectRoot: "/fake", userRegistry: null, projectRegistry: null, registryOnlyEntries: [], projectRegistryRootOk: true };
  const output = formatAgentsDoctor(diag);
  assert.ok(output.includes("shares a name with a built-in profile"),
    "doctor must warn about agent/profile name collision");
  assert.ok(output.includes("fast-local"), "output must name the colliding agent");

  // Negative: no collision for non-matching names
  const diag2 = { records: [{...records[0], name: "my-agent"}], summary: { blocked: 0 }, projectTrusted: true, projectRoot: "/fake", userRegistry: null, projectRegistry: null, registryOnlyEntries: [], projectRegistryRootOk: true };
  const output2 = formatAgentsDoctor(diag2);
  assert.equal(output2.includes("shares a name with a built-in profile"), false,
    "doctor must NOT warn when no collision exists");
}

async function testProfiles_labelsNoOpProfile() {
  const { formatProfileList } = await import("../index.ts");
  const ctx = {
    cwd: "/fake", hasUI: true, agentsHomeDir: "/fake/home",
    profileLibrary: { profiles: [
      { name: "fast-local", purpose: "fast local agent" },
      { name: "adversarial-review", model: "claude-opus", thinking: "high" },
    ] },
    ui: { notify: () => {} },
  };
  const diag = { records: [], summary: { blocked: 0 }, projectTrusted: true, projectRoot: "/fake", userRegistry: null, projectRegistry: null, registryOnlyEntries: [], projectRegistryRootOk: true };
  const output = formatProfileList(ctx, diag);
  assert.ok(output.includes("effect: none (Pi default)"),
    "no-op profile must show effect: none label");
  assert.ok(output.includes("fast-local"), "output must include profile name");
  // Negative: adversarial-review has model+thinking → should NOT have no-op label on its line
  assert.ok(output.includes("adversarial-review"), "output must include non-no-op profile too");
}

function testInspect_showsNoOpProfile() {
  const diag = {
    records: [{
      name: "my-agent", source: "user", status: "runnable", runnable: true, registered: true,
      reason: "", nextStep: "", tools: ["read"], evalStatus: "missing",
      issues: [], warnings: [], hashMismatch: false, shadowedReservedName: false, scannerRisk: "safe",
      filePath: "/fake/my-agent.md", canonicalPath: "/fake/my-agent.md", rawBytesSha256: "abc",
      spec: { name: "my-agent", description: "test", source: "user", tools: ["read"], prompt: "test", profile: "fast-local",
        inputContract: { kind: "task-string", maxTaskChars: 100, emptyTask: "reject" },
        outputContract: { requiredSections: ["Summary"], maxSummaryChars: 500 }, evals: [],
        limits: { timeoutMs: 1000, maxStdoutBytes: 1000, maxStderrChars: 200, maxResultChars: 500, maxJsonLineBytes: 500, maxTaskChars: 100, maxChildProcesses: 1, maxChainLength: 3 },
        observability: { retainInMemoryRuns: 20, persistByDefault: false, includeToolTrajectory: true, storeFullPrompt: false, storeFullTask: false, storeFullToolResults: false, storeThinkingText: false },
        safety: { approveProjectByDefault: false, projectSpecsRequireTrustAndRegistration: true, allowRecursiveSubagents: false, promptTransport: "stdin-or-private-tempfile", forbiddenTools: ["write", "edit", "bash", "run_subagent"], redactDisplayedCommand: true },
      },
    }],
    summary: { blocked: 0 }, projectTrusted: true, projectRoot: "/fake", userRegistry: null, projectRegistry: null, registryOnlyEntries: [], projectRegistryRootOk: true,
  };
  const output = formatAgentInspect(diag, "my-agent");
  assert.ok(output.includes("effect: none (Pi default)"),
    "inspect must show effect: none for no-op built-in profile");

  // Negative: record without profile should NOT show the label
  const diag2 = {
    records: [{...diag.records[0], spec: {...diag.records[0].spec, profile: undefined}}],
    summary: { blocked: 0 }, projectTrusted: true, projectRoot: "/fake", userRegistry: null, projectRegistry: null, registryOnlyEntries: [], projectRegistryRootOk: true,
  };
  const output2 = formatAgentInspect(diag2, "my-agent");
  assert.equal(output2.includes("effect: none (Pi default)"), false,
    "inspect must NOT show effect: none when no profile is set");
}

// ── Main ──

// --timeout flag: seconds → ms, any order with --profile, validated.
function testParseRun_timeoutFlag() {
  const a = parseRunArgs("scout --timeout 300 explore");
  assert.equal(a.ok, true);
  if (a.ok) { assert.equal(a.timeoutMs, 300000); assert.equal(a.task, "explore"); }
  const b = parseRunArgs("planner --profile fast --timeout 60 plan it");
  assert.equal(b.ok, true);
  if (b.ok) { assert.equal(b.profileOverride, "fast"); assert.equal(b.timeoutMs, 60000); assert.equal(b.task, "plan it"); }
  const c = parseRunArgs("scout --timeout 30 --profile fast explore"); // order-independent
  assert.equal(c.ok, true);
  if (c.ok) { assert.equal(c.timeoutMs, 30000); assert.equal(c.profileOverride, "fast"); }
  assert.equal(parseRunArgs("scout --timeout abc task").ok, false, "non-numeric rejected");
  assert.equal(parseRunArgs("scout --timeout 0 task").ok, false, "non-positive rejected");
  assert.equal(parseRunArgs("scout --timeout 99999 task").ok, false, "above 3600s cap rejected");
  assert.equal(parseRunArgs("scout --timeout").ok, false, "missing value rejected");
  const d = parseRunArgs("scout do --timeout 30 thing"); // mid-task → part of task + warning
  assert.equal(d.ok, true);
  if (d.ok) { assert.equal(d.timeoutMs, undefined); assert.ok(d.warning); }
}

async function main() {
  testProfileEffect_classifies();
  testParseRun_warnsMisplacedProfile();
  testParseRun_timeoutFlag();
  testDoctor_warnsAgentProfileCollision();
  await testProfiles_labelsNoOpProfile();
  testInspect_showsNoOpProfile();
  console.log("OK: 6/6 tests passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
