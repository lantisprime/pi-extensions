import assert from "node:assert";
import {
  buildClassifierPiArgs, resolveRunIntent, CLASSIFIER_LIMITS,
} from "../lib/intent-router.ts";

// ── Helpers ──

function makeCandidates(names) {
  return names.map((n) => ({ name: n, source: "built-in", description: `${n} description` }));
}

function classifierResult(summaryText) {
  return {
    agentName: "intent-classifier",
    status: "completed",
    exitCode: 0,
    durationMs: 100,
    stdoutBytes: summaryText.length,
    stderrPreview: "",
    invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin", stdinText: "" } },
    summary: { summaryText, toolCalls: [], errors: [], usage: undefined, cost: undefined, stopReason: undefined, model: undefined, provider: undefined, truncation: {} },
    timedOut: false,
    outputLimitExceeded: false,
  };
}

// ── Group 3: Classifier args (7 tests) ──

function testClassifierArgs_emitsNoTools() {
  const { invocation } = buildClassifierPiArgs("review this", makeCandidates(["scout", "reviewer"]));
  assert.ok(invocation.argv.includes("--no-tools"), "argv must include --no-tools");
}

function testClassifierArgs_omitsToolsFlag() {
  const { invocation } = buildClassifierPiArgs("review this", makeCandidates(["scout", "reviewer"]));
  assert.equal(invocation.argv.includes("--tools"), false, "argv must NOT include --tools");
}

function testClassifierArgs_noSession() {
  const { invocation } = buildClassifierPiArgs("review this", makeCandidates(["scout"]));
  assert.ok(invocation.argv.includes("--no-session"), "argv must include --no-session");
}

function testClassifierArgs_thinkingOff() {
  const { invocation } = buildClassifierPiArgs("review this", makeCandidates(["scout"]));
  const ti = invocation.argv.indexOf("--thinking");
  assert.ok(ti !== -1, "argv must include --thinking");
  assert.equal(invocation.argv[ti + 1], "off", "--thinking must be off");
}

function testClassifierArgs_boundedLimits() {
  // buildClassifierPiArgs doesn't use CLASSIFIER_LIMITS directly — resolveRunIntent does.
  // Verify CLASSIFIER_LIMITS has the expected values (REQ-5 bounds).
  assert.equal(CLASSIFIER_LIMITS.stdoutLimit, 65536);
  assert.equal(CLASSIFIER_LIMITS.stderrLimit, 4096);
  assert.equal(CLASSIFIER_LIMITS.timeoutMs, 20000);
  assert.equal(CLASSIFIER_LIMITS.maxJsonLineBytes, 65536);
  assert.equal(CLASSIFIER_LIMITS.maxResultChars, 512);
  assert.equal(CLASSIFIER_LIMITS.killSignal, "SIGTERM");
  assert.equal(CLASSIFIER_LIMITS.forceKillAfterMs, 1000);
}

function testClassifierArgs_overrideModelOnly() {
  const { invocation } = buildClassifierPiArgs("task", makeCandidates(["scout"]), { overrideModel: "cheap-model" });
  const mi = invocation.argv.indexOf("--model");
  assert.ok(mi !== -1, "argv must include --model when overrideModel is set");
  assert.equal(invocation.argv[mi + 1], "cheap-model");
  // No extra --thinking beyond the forced off
  const thinkingCount = invocation.argv.filter((a) => a === "--thinking").length;
  assert.equal(thinkingCount, 1, "only one --thinking (forced off)");
}

function testClassifierArgs_overrideThinkingIgnoredWithWarning() {
  const { invocation, warnings } = buildClassifierPiArgs("task", makeCandidates(["scout"]), { overrideThinking: "high" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /thinking ignored.*forced off/);
  // --thinking must still be "off"
  const ti = invocation.argv.indexOf("--thinking");
  assert.equal(invocation.argv[ti + 1], "off");
}

// ── Group 3: resolveRunIntent fallback (4 tests) ──

async function testResolve_llmPrimary() {
  const candidates = makeCandidates(["scout", "reviewer"]);
  let capturedInvocation;
  let capturedLimits;
  const decision = await resolveRunIntent("review this code", candidates, {
    runClassifier: (inv, limits) => {
      capturedInvocation = inv;
      capturedLimits = limits;
      return classifierResult(JSON.stringify({ agent: "reviewer", confidence: 0.95, reason: "matched: review" }));
    },
  });
  assert.equal(decision.agent, "reviewer");
  assert.equal(decision.engine, "llm");
  assert.equal(decision.confidence, 0.95);
  // Verify CLASSIFIER_LIMITS were passed to runClassifier
  assert.equal(capturedLimits.timeoutMs, 20000);
  assert.equal(capturedLimits.stdoutLimit, 65536);
  assert.equal(capturedLimits.maxResultChars, 512);
}

async function testResolve_fallbackOnSpawnError() {
  const candidates = makeCandidates(["scout", "reviewer"]);
  let classifierCalled = false;
  const decision = await resolveRunIntent("review this code", candidates, {
    runClassifier: () => {
      classifierCalled = true;
      throw new Error("spawn failed");
    },
  });
  assert.equal(classifierCalled, true);
  assert.equal(decision.engine, "heuristic-fallback");
  // "review" keyword → reviewer
  assert.equal(decision.agent, "reviewer");
}

async function testResolve_fallbackOnBadJson() {
  const candidates = makeCandidates(["scout", "reviewer"]);
  const decision = await resolveRunIntent("review this code", candidates, {
    runClassifier: () => classifierResult("this is not json at all"),
  });
  assert.equal(decision.engine, "heuristic-fallback");
  assert.equal(decision.agent, "reviewer");
}

async function testResolve_fallbackOnUnknownAgent() {
  // Use a no-keyword task so heuristic returns AMBIGUOUS_DEFAULT=scout,
  // but classifier returns unknown agent → fallback
  const candidates = makeCandidates(["scout"]);
  const decision = await resolveRunIntent("do something", candidates, {
    runClassifier: () => classifierResult(JSON.stringify({ agent: "reviewer", confidence: 0.9, reason: "matched" })),
  });
  assert.equal(decision.engine, "heuristic-fallback");
  assert.equal(decision.agent, "scout"); // AMBIGUOUS_DEFAULT
  assert.equal(decision.confidence, 0.3);
}

// ── Main ──

async function main() {
  // Group 3: Classifier args (7)
  testClassifierArgs_emitsNoTools();
  testClassifierArgs_omitsToolsFlag();
  testClassifierArgs_noSession();
  testClassifierArgs_thinkingOff();
  testClassifierArgs_boundedLimits();
  testClassifierArgs_overrideModelOnly();
  testClassifierArgs_overrideThinkingIgnoredWithWarning();

  // Group 3: resolveRunIntent fallback (4)
  await testResolve_llmPrimary();
  await testResolve_fallbackOnSpawnError();
  await testResolve_fallbackOnBadJson();
  await testResolve_fallbackOnUnknownAgent();

  console.log("OK: 11/11 tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
