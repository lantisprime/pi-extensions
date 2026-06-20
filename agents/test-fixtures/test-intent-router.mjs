import assert from "node:assert";
import {
  classifyIntentHeuristic, parseClassifierOutput,
  AMBIGUOUS_DEFAULT, HEURISTIC_SATURATION, TIE_ORDER,
  profileEffect, CLASSIFIER_LIMITS, ROLE_DEFAULT_PROFILE,
} from "../lib/intent-router.ts";

// ── Group 1: Heuristic (8 tests) ──

function testHeuristic_reviewVerbs() {
  const r = classifyIntentHeuristic("review this for bugs", ["reviewer", "scout", "planner"]);
  assert.equal(r.agent, "reviewer");
  assert.ok(r.signals && r.signals.includes("review"));
  assert.equal(r.engine, "heuristic-fallback");
}

function testHeuristic_planVerbs() {
  const r = classifyIntentHeuristic("plan the roadmap", ["scout", "planner", "reviewer"]);
  assert.equal(r.agent, "planner");
}

function testHeuristic_scoutVerbs() {
  const r = classifyIntentHeuristic("find where this is used", ["reviewer", "planner", "scout"]);
  assert.equal(r.agent, "scout");
}

function testHeuristic_deterministic() {
  const candidates = ["reviewer", "planner", "scout"];
  const r1 = classifyIntentHeuristic("review and audit the design", candidates);
  const r2 = classifyIntentHeuristic("review and audit the design", candidates);
  assert.deepEqual(r1, r2);
}

function testHeuristic_clamp() {
  // "review audit bug critique" = 3+3+2+3 = 11 > 6 (SATURATION) -> confidence = 1
  const r = classifyIntentHeuristic("review audit bug critique", ["reviewer", "scout"]);
  assert.equal(r.confidence, 1);
  assert.equal(r.agent, "reviewer");
}

function testHeuristic_emptyRejected() {
  assert.throws(() => classifyIntentHeuristic("", ["scout"]), /task must be non-empty/);
  assert.throws(() => classifyIntentHeuristic("   ", ["scout"]), /task must be non-empty/);
}

function testHeuristic_ambiguousDefault() {
  const r = classifyIntentHeuristic("do something random", ["scout", "reviewer"]);
  assert.equal(r.agent, "scout");
  assert.equal(r.confidence, 0.3);
  assert.equal(r.reason, "no intent keywords matched");
  assert.deepEqual(r.signals, []);
}

function testHeuristic_tieBreakDeterministic() {
  // "plan the review": plan(3) + review(3) -> tie, reviewer first in TIE_ORDER
  const r = classifyIntentHeuristic("plan the review", ["reviewer", "planner", "scout"]);
  assert.equal(r.agent, "reviewer");
}

// ── Group 2: Classifier-output parsing (8 tests) ──

function testParse_validJson() {
  const raw = JSON.stringify({ agent: "scout", confidence: 0.9, reason: "matched: find" });
  const r = parseClassifierOutput(raw, ["scout", "reviewer"]);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.decision.agent, "scout");
    assert.equal(r.decision.confidence, 0.9);
    assert.equal(r.decision.engine, "llm");
  }
}

function testParse_jsonInCodeFence() {
  const raw = 'Some text\n```json\n{"agent":"planner","confidence":0.7,"reason":"matched: plan"}\n```\nMore text';
  const r = parseClassifierOutput(raw, ["planner", "reviewer"]);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.decision.agent, "planner");
}

function testParse_unknownAgentRejected() {
  const raw = JSON.stringify({ agent: "unknown-agent", confidence: 0.5, reason: "test" });
  const r = parseClassifierOutput(raw, ["scout", "reviewer"]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "unknown-agent");
}

function testParse_nonJsonRejected() {
  const r = parseClassifierOutput("this is not json", ["scout"]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "non-json");
}

function testParse_confidenceClamped() {
  const raw = JSON.stringify({ agent: "scout", confidence: 1.5, reason: "test" });
  const r = parseClassifierOutput(raw, ["scout"]);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.decision.confidence, 1.0);
}

function testParse_extraKeysRejected() {
  const raw = JSON.stringify({ agent: "scout", confidence: 0.5, reason: "test", extra: "key" });
  const r = parseClassifierOutput(raw, ["scout"]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "bad-shape");
}

function testParse_multipleJsonObjectsRejected() {
  const raw = '{"agent":"scout","confidence":0.5,"reason":"a"} {"agent":"planner","confidence":0.6,"reason":"b"}';
  const r = parseClassifierOutput(raw, ["scout", "planner"]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "multiple-objects");
}

function testParse_jsonEmbeddedInProseRejected() {
  const raw = 'Here is the JSON: {"agent":"scout","confidence":0.5,"reason":"test"} which is embedded';
  const r = parseClassifierOutput(raw, ["scout"]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "embedded");
}

// ── Group: Constant + helper sanity ──

function testProfileEffect_classifies() {
  assert.equal(profileEffect({}), "none");
  assert.equal(profileEffect({ model: "gpt-5" }), "model");
  assert.equal(profileEffect({ thinking: "high" }), "thinking");
  assert.equal(profileEffect({ model: "gpt-5", thinking: "high" }), "both");
}

function testAmbiguousDefaultValue() {
  assert.equal(AMBIGUOUS_DEFAULT.agent, "scout");
  assert.equal(AMBIGUOUS_DEFAULT.confidence, 0.3);
}

function testHeuristicSaturationValue() {
  assert.equal(HEURISTIC_SATURATION, 6);
}

function testTieOrderValue() {
  assert.deepEqual(TIE_ORDER, ["reviewer", "planner", "scout"]);
}

function testRoleDefaultProfileCoverage() {
  for (const role of TIE_ORDER) {
    assert.ok(ROLE_DEFAULT_PROFILE[role] !== undefined,
      "ROLE_DEFAULT_PROFILE missing key: " + role);
  }
}

function testClassifierLimitsValues() {
  assert.equal(CLASSIFIER_LIMITS.stdoutLimit, 65536);
  assert.equal(CLASSIFIER_LIMITS.timeoutMs, 20000);
  assert.equal(CLASSIFIER_LIMITS.maxResultChars, 512);
}

// ── Main ──

function main() {
  // Group 1: Heuristic (8)
  testHeuristic_reviewVerbs();
  testHeuristic_planVerbs();
  testHeuristic_scoutVerbs();
  testHeuristic_deterministic();
  testHeuristic_clamp();
  testHeuristic_emptyRejected();
  testHeuristic_ambiguousDefault();
  testHeuristic_tieBreakDeterministic();

  // Group 2: Classifier-output parsing (8)
  testParse_validJson();
  testParse_jsonInCodeFence();
  testParse_unknownAgentRejected();
  testParse_nonJsonRejected();
  testParse_confidenceClamped();
  testParse_extraKeysRejected();
  testParse_multipleJsonObjectsRejected();
  testParse_jsonEmbeddedInProseRejected();

  // Constant + helper sanity (6)
  testProfileEffect_classifies();
  testAmbiguousDefaultValue();
  testHeuristicSaturationValue();
  testTieOrderValue();
  testRoleDefaultProfileCoverage();
  testClassifierLimitsValues();

  console.log("OK: 22/22 tests passed");
}

main();
