import assert from "node:assert";
import { parseDoArgs, runIntentCommand, runAgentCommand, __classifierRunner } from "../lib/run-resolver.ts";
import { __resetBackgroundRuns, WIDGET_KEY } from "../lib/bg-run.ts";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const flush = () => new Promise((r) => setImmediate(r));
function completedResult(name) {
  return { agentName: name, status: "completed", exitCode: 0, durationMs: 1, stdoutBytes: 0, stderrPreview: "", invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin", stdinText: "" } }, summary: { summaryText: "ok", toolCalls: [], errors: [], usage: undefined, cost: undefined, stopReason: undefined, model: undefined, provider: undefined, truncation: {} }, timedOut: false, outputLimitExceeded: false };
}

// ── Helpers ──

function makeCtx(overrides = {}) {
  const calls = [];
  const uiOverrides = overrides.ui || {};
  const ctx = {
    hasUI: true,
    agentsChildRunner: async (agent, task, opts) => {
      calls.push({ agent, task, opts });
      return { agentName: typeof agent === "string" ? agent : agent.name, status: "completed", exitCode: 0, durationMs: 1, stdoutBytes: 0, stderrPreview: "", invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin", stdinText: "" } }, summary: { summaryText: "ok", toolCalls: [], errors: [], usage: undefined, cost: undefined, stopReason: undefined, model: undefined, provider: undefined, truncation: {} }, timedOut: false, outputLimitExceeded: false };
    },
    ui: { notify: uiOverrides.notify || ((_msg, _level) => {}), confirm: uiOverrides.confirm || (async (_title, _message) => true), ...(uiOverrides.setWidget ? { setWidget: uiOverrides.setWidget } : {}) },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "ui")),
    _runnerCalls: calls,
  };
  return ctx;
}

function makeDiagnostics(records = []) {
  return { records, summary: { blocked: 0 }, projectTrusted: true, projectRoot: "/fake/project", userRegistry: null, projectRegistry: null, registryOnlyEntries: [], projectRegistryRootOk: true };
}

function registeredRecord(name, overrides = {}) {
  return { name, source: "user", status: "runnable", runnable: true, registered: true, reason: "", nextStep: "", tools: ["read", "grep"], evalStatus: "missing", spec: { name, description: `${name} desc`, source: "user", tools: ["read", "grep"], prompt: "helper", inputContract: { kind: "task-string", maxTaskChars: 100, emptyTask: "reject" }, outputContract: { requiredSections: ["Summary"], maxSummaryChars: 500 }, evals: [], limits: { timeoutMs: 1000, maxStdoutBytes: 1000, maxStderrChars: 200, maxResultChars: 500, maxJsonLineBytes: 500, maxTaskChars: 100, maxChildProcesses: 1, maxChainLength: 3 }, observability: { retainInMemoryRuns: 20, persistByDefault: false, includeToolTrajectory: true, storeFullPrompt: false, storeFullTask: false, storeFullToolResults: false, storeThinkingText: false }, safety: { approveProjectByDefault: false, projectSpecsRequireTrustAndRegistration: true, allowRecursiveSubagents: false, promptTransport: "stdin-or-private-tempfile", forbiddenTools: ["write", "edit", "bash", "run_subagent"], redactDisplayedCommand: true }, ...overrides }, canonicalPath: `/fake/${name}.md`, rawBytesSha256: "abc123", filePath: `/fake/${name}.md` };
}

function stubClassifier(agent = "scout", confidence = 0.9, reason = "matched") {
  __classifierRunner.fn = async () => ({ agentName: "intent-classifier", status: "completed", exitCode: 0, durationMs: 100, stdoutBytes: 0, stderrPreview: "", invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin", stdinText: "" } }, summary: { summaryText: JSON.stringify({ agent, confidence, reason }), toolCalls: [], errors: [], usage: undefined, cost: undefined, stopReason: undefined, model: undefined, provider: undefined, truncation: {} }, timedOut: false, outputLimitExceeded: false });
}

async function writeTempSpec(name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-test-spec-"));
  const filePath = path.join(dir, `${name}.md`);
  await fs.writeFile(filePath, ["---", `name: ${name}`, `description: ${name} desc`, "tools: [read, grep]", "---", "", "Prompt body."].join("\n"), "utf-8");
  return { dir, filePath };
}

// ── parseDoArgs (5) ──
function testParseDoArgs_basic() { const r = parseDoArgs("review this code"); assert.equal(r.ok, true); if (r.ok) assert.equal(r.task, "review this code"); }
function testParseDoArgs_withProfile() { const r = parseDoArgs("--profile fast-local review this"); assert.equal(r.ok, true); if (r.ok) { assert.equal(r.profileOverride, "fast-local"); assert.equal(r.task, "review this"); } }
function testParseDoArgs_emptyRejected() { assert.equal(parseDoArgs("").ok, false); }
function testParseDoArgs_profileNoValueRejected() { assert.equal(parseDoArgs("--profile").ok, false); }
function testParseDoArgs_profileNoTaskRejected() { assert.equal(parseDoArgs("--profile fast-local").ok, false); }

// ── Group 5: gate + autonomy ──
async function testDo_nonTuiFailClosed() { const m = []; const ctx = makeCtx({ hasUI: false, ui: { notify: (x) => m.push(x) } }); await runIntentCommand("review this", ctx, makeDiagnostics()); assert.ok(m.some((x) => x.includes("interactive confirmation")), "non-TUI"); }
async function testDo_nonTuiNeverSpawnsClassifier() { let c = false; __classifierRunner.fn = async () => { c = true; throw new Error("nope"); }; await runIntentCommand("review this", makeCtx({ hasUI: false }), makeDiagnostics()); assert.equal(c, false, "no spawn"); }
async function testDo_emptyTaskUsage() { const m = []; await runIntentCommand("", makeCtx({ ui: { notify: (x) => m.push(x) } }), makeDiagnostics()); assert.ok(m.some((x) => x.includes("Usage")), "usage"); }
async function testDo_classifierFallbackRuns() { __classifierRunner.fn = async () => ({ agentName: "intent-classifier", status: "completed", exitCode: 0, durationMs: 1, stdoutBytes: 0, stderrPreview: "", invocation: { command:"pi", argv:[], argvPreview:[], promptTransport:{kind:"stdin",stdinText:""} }, summary: { summaryText:"not json", toolCalls:[], errors:[], usage:undefined, cost:undefined, stopReason:undefined, model:undefined, provider:undefined, truncation:{} }, timedOut:false, outputLimitExceeded:false }); const ctx = makeCtx(); await runIntentCommand("do something random", ctx, makeDiagnostics()); assert.equal(ctx._runnerCalls.length, 1, "fallback runs"); assert.equal(ctx._runnerCalls[0].agent, "scout"); }
async function testDo_builtInAutoRunHighConfidence() { stubClassifier("reviewer", 0.95); let cf = false; const ctx = makeCtx({ ui: { confirm: async () => { cf = true; return true; } } }); await runIntentCommand("review this code", ctx, makeDiagnostics()); assert.equal(cf, false, "no-confirm"); assert.equal(ctx._runnerCalls.length, 1); assert.equal(ctx._runnerCalls[0].agent, "reviewer"); assert.equal(ctx._runnerCalls[0].task, "review this code"); }
async function testDo_confirmLowConfidence() { stubClassifier("reviewer", 0.5); let cf = false; const ctx = makeCtx({ ui: { confirm: async () => { cf = true; return true; } } }); await runIntentCommand("review this", ctx, makeDiagnostics()); assert.equal(cf, true, "confirm"); assert.equal(ctx._runnerCalls.length, 1); }
async function testDo_confirmDeclinedNoRun() { stubClassifier("reviewer", 0.5); const m = []; const ctx = makeCtx({ ui: { notify: (x) => m.push(x), confirm: async () => false } }); await runIntentCommand("review this", ctx, makeDiagnostics()); assert.ok(m.some((x) => x.includes("cancelled"))); assert.equal(ctx._runnerCalls.length, 0); }
async function testDo_autoRunRequiresReadOnlyTools() { const rec = registeredRecord("writer", { tools: ["read", "write"] }); stubClassifier("writer", 0.95); let cf = false; const ctx = makeCtx({ ui: { confirm: async () => { cf = true; return false; } } }); await runIntentCommand("write something", ctx, makeDiagnostics([rec])); assert.equal(cf, true, "non-ro confirm"); assert.equal(ctx._runnerCalls.length, 0); }
async function testDo_registeredDispatchFailsClosedOnReReadError() { const rec = registeredRecord("blocked-agent"); stubClassifier("blocked-agent", 0.85); const m = []; const ctx = makeCtx({ ui: { notify: (x) => m.push(x) } }); await runIntentCommand("do something", ctx, makeDiagnostics([rec])); assert.ok(m.some((x) => x.includes("failed to re-read")), "re-read err"); assert.equal(ctx._runnerCalls.length, 0); }
async function testDo_gateDeniesUntrustedProject() { const { dir, filePath: fp } = await writeTempSpec("dangerous-agent"); try { const rec = { ...registeredRecord("dangerous-agent"), source: "project", filePath: fp, canonicalPath: fp, spec: { ...registeredRecord("dangerous-agent").spec, source: "project", name: "dangerous-agent" } }; const diag = makeDiagnostics([rec]); diag.projectTrusted = false; stubClassifier("dangerous-agent", 0.85); const m = []; const ctx = makeCtx({ ui: { notify: (x) => m.push(x) } }); await runIntentCommand("do something", ctx, diag); assert.ok(m.some((x) => x.includes("not runnable")), "canRunAgent deny"); assert.equal(ctx._runnerCalls.length, 0); } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); } }

// ── Group 6: profile routing ──
async function testDo_appliesRoleDefaultProfile() { stubClassifier("reviewer", 0.95); const ctx = makeCtx({ profileLibrary: { profiles: [{ name: "adversarial-review", model: "claude-opus", thinking: "high" }] } }); await runIntentCommand("review this", ctx, makeDiagnostics()); assert.equal(ctx._runnerCalls.length, 1); assert.equal(ctx._runnerCalls[0].opts.profileOverride, "adversarial-review"); }
async function testDo_skipsNoOpRoleDefault() { stubClassifier("scout", 0.95); const ctx = makeCtx({ profileLibrary: { profiles: [{ name: "fast-local" }] } }); await runIntentCommand("find files", ctx, makeDiagnostics()); assert.equal(ctx._runnerCalls.length, 1); assert.equal(ctx._runnerCalls[0].opts.profileOverride, undefined); }
async function testDo_explicitProfileOverridesRoleDefault() { stubClassifier("reviewer", 0.95); const ctx = makeCtx({ profileLibrary: { profiles: [{ name: "adversarial-review", model: "claude-opus", thinking: "high" }, { name: "custom", model: "custom-model" }] } }); await runIntentCommand("--profile custom review this", ctx, makeDiagnostics()); assert.equal(ctx._runnerCalls.length, 1); assert.equal(ctx._runnerCalls[0].opts.profileOverride, "custom"); }
async function testDo_roleDefaultWithNoLibraryDoesNotFailClosed() { stubClassifier("reviewer", 0.95); const ctx = makeCtx({ profileLibrary: undefined }); await runIntentCommand("review this", ctx, makeDiagnostics()); assert.equal(ctx._runnerCalls.length, 1); assert.equal(ctx._runnerCalls[0].opts.profileOverride, undefined); }

// ── Group 7: P8-3 non-blocking wiring ──

// REQ-1: with hasUI + setWidget, the do handler returns BEFORE the child run settles.
async function testHandlerReturnsBeforeChildSettles() {
  __resetBackgroundRuns();
  stubClassifier("scout", 0.95); // read-only + high confidence → auto-run, no confirm
  const widgets = [], notifies = [];
  let settled = false;
  let release;
  const gate = new Promise((res) => { release = res; });
  const ctx = {
    hasUI: true,
    agentsChildRunner: async () => { await gate; settled = true; return completedResult("scout"); },
    ui: { notify: (m, l) => notifies.push({ m, l }), confirm: async () => true, setWidget: (k, c) => widgets.push({ k, c }) },
  };
  await runIntentCommand("find files", ctx, makeDiagnostics());
  assert.equal(settled, false, "child still running when handler returned (non-blocking)");
  assert.ok(widgets.some((w) => Array.isArray(w.c)), "a progress widget was rendered while running");
  assert.equal(notifies.some((n) => /completed|status:/.test(n.m)), false, "no child-result notify until the run settles");
  release();
  await flush(); await flush();
  assert.equal(settled, true, "child settled after release");
  assert.deepEqual(widgets[widgets.length - 1], { k: WIDGET_KEY, c: undefined }, "widget cleared after settle");
  __resetBackgroundRuns();
}

// REQ-8: !hasUI falls back to the synchronous await path with ZERO widget calls (even if setWidget exists).
async function testNoUiFallbackSynchronous() {
  __resetBackgroundRuns();
  const widgets = [], notifies = [];
  const ctx = makeCtx({ hasUI: false, ui: { notify: (m) => notifies.push(m), setWidget: (k, c) => widgets.push({ k, c }) } });
  await runAgentCommand("scout find files", ctx, makeDiagnostics());
  assert.equal(ctx._runnerCalls.length, 1, "child ran synchronously");
  assert.equal(widgets.length, 0, "no widget calls when !hasUI (REQ-8)");
  assert.ok(notifies.some((m) => /read-only tools/.test(m) || /status:/.test(m)), "result notified synchronously");
  __resetBackgroundRuns();
}

// REQ-9: the run_subagent tool path must not route through the backgrounding wiring.
async function testToolPathDoesNotBackground() {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "subagent-tool.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.equal(/startBackgroundRun/.test(code), false, "run_subagent must not call startBackgroundRun");
  assert.equal(/dispatchChildRun/.test(code), false, "run_subagent must not route through dispatchChildRun");
}

// P8-followup: a completed do-run injects its result (NL summary + tools) into pi's context.
async function testDoDeliversResultToContext() {
  stubClassifier("scout", 0.95);
  const delivered = [];
  const ctx = makeCtx();
  ctx.deliverResult = (content) => delivered.push(content);
  await runIntentCommand("review this code", ctx, makeDiagnostics());
  assert.equal(ctx._runnerCalls.length, 1);
  assert.equal(delivered.length, 1, "completed run delivers exactly one context message");
  assert.match(delivered[0], /`scout` subagent finished/);
  assert.match(delivered[0], /Summary:/);
}

// Non-completed runs must NOT inject into context.
async function testDoDoesNotDeliverOnNonCompleted() {
  stubClassifier("scout", 0.95);
  const delivered = [];
  const ctx = makeCtx();
  ctx.agentsChildRunner = async (agent) => ({ agentName: typeof agent === "string" ? agent : agent.name, status: "failed", exitCode: 1, durationMs: 1, stdoutBytes: 0, stderrPreview: "", invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin", stdinText: "" } }, summary: { summaryText: "", toolCalls: [], errors: [], usage: undefined, cost: undefined, stopReason: undefined, model: undefined, provider: undefined, truncation: {} }, timedOut: false, outputLimitExceeded: false });
  ctx.deliverResult = (content) => delivered.push(content);
  await runIntentCommand("review this", ctx, makeDiagnostics());
  assert.equal(delivered.length, 0, "a failed run does not inject into pi's context");
}

async function main() {
  testParseDoArgs_basic(); testParseDoArgs_withProfile(); testParseDoArgs_emptyRejected(); testParseDoArgs_profileNoValueRejected(); testParseDoArgs_profileNoTaskRejected();
  await testDo_nonTuiFailClosed(); await testDo_nonTuiNeverSpawnsClassifier(); await testDo_emptyTaskUsage(); await testDo_classifierFallbackRuns();
  await testDo_builtInAutoRunHighConfidence(); await testDo_confirmLowConfidence(); await testDo_confirmDeclinedNoRun(); await testDo_autoRunRequiresReadOnlyTools();
  await testDo_registeredDispatchFailsClosedOnReReadError(); await testDo_gateDeniesUntrustedProject();
  await testDo_appliesRoleDefaultProfile(); await testDo_skipsNoOpRoleDefault(); await testDo_explicitProfileOverridesRoleDefault(); await testDo_roleDefaultWithNoLibraryDoesNotFailClosed();
  await testHandlerReturnsBeforeChildSettles(); await testNoUiFallbackSynchronous(); await testToolPathDoesNotBackground();
  await testDoDeliversResultToContext(); await testDoDoesNotDeliverOnNonCompleted();
  console.log("OK: 24/24 tests passed");
}
main().catch((error) => { console.error(error); process.exit(1); });
