import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { collectAgentDiagnostics } from "../lib/diagnostics.ts";
import { registerAgent } from "../lib/registration.ts";
import { resolveRegisteredRunTarget, preflightAgentGate } from "../lib/run-resolver.ts";
import { preflightBgAgent } from "../lib/bg-preflight.ts";
import {
	readBgManifest,
	getBgRunPaths,
	verifyBgManifest,
	assertManifestIdentityMatchesRuntime,
	resolveTrustedHome,
	readSessionMacKey,
	getBgStateDir,
} from "../lib/bg-state.ts";

async function withTempHome(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "p4-2-preflight-"));
  const home = path.join(root, "home");
  try {
    return await fn(home, root);
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

function makeCtx(home) {
  return {
    cwd: home,
    hasUI: false,
    agentsHomeDir: home,
    ui: { notify: () => {}, confirm: async () => true },
  };
}

async function setupRegisteredUserAgent(home, name = "researcher") {
  const userAgentsDir = path.join(home, ".pi", "agent", "agents");
  await fs.mkdir(userAgentsDir, { recursive: true });
  const specPath = path.join(userAgentsDir, `${name}.md`);
  await fs.writeFile(specPath, `---\nname: ${name}\ndescription: d\nsource: user\ntools: [read]\nprompt: p\n---\nbody`);
  await registerAgent(specPath, { cwd: home, homeDir: home, projectTrusted: false, hasUI: true, ui: { notify: () => {}, confirm: async () => true } });
  const diag = await collectAgentDiagnostics({ cwd: home, homeDir: home, projectTrusted: false });
  const resolved = await resolveRegisteredRunTarget(name, diag);
  assert.equal(resolved.ok, true, `setup: agent '${name}' should resolve`);
  return { record: resolved.record, diag };
}

async function test(name, fn) {
  await fn();
  console.log(`  ✓ ${name}`);
}

async function testPreflightWritesSignedManifest() {
  await withTempHome(async (home) => {
    const { record, diag } = await setupRegisteredUserAgent(home);
    const ctx = makeCtx(home);
    const result = await preflightBgAgent(record, "find auth bugs", ctx, diag, { homeDir: home, maxDurationSec: 120, effectiveTimeoutSec: 60, ownerHandle: "win-1" });
    assert.equal(result.ok, true, "preflight should succeed for a registered user agent");
    if (!result.ok) return;
    assert.ok(result.runId.startsWith("bg-"), "runId is a bg- id");
    assert.equal(result.manifest.version, 1);
    assert.equal(result.manifest.runId, result.runId);
    assert.equal(result.manifest.identity.agentName, "researcher");
    assert.equal(result.manifest.identity.canonicalPath, record.canonicalPath);
    assert.equal(result.manifest.options.homeDir, home);
    assert.equal(result.manifest.options.maxDurationSec, 120);
    assert.match(result.manifest.mac, /^[0-9a-f]{64}$/);
    assert.match(result.manifest.keyGenId, /^[0-9a-f]{8}$/);

    // The manifest on disk is readable + verifies with the session MAC key.
    const read = await readBgManifest(result.paths);
    assert.equal(read.runId, result.runId);
    const key = await readSessionMacKey(home);
    assert.equal(verifyBgManifest(read, key), true, "manifest verifies against session MAC key");

    // Tampering the task breaks verification.
    const tampered = { ...read, task: "different task" };
    assert.equal(verifyBgManifest(tampered, key), false, "tampered manifest fails verify");
  });
}

async function testPreflightManifestHomeDirMatchesTrustedRoot() {
  await withTempHome(async (home) => {
    const { record, diag } = await setupRegisteredUserAgent(home);
    const ctx = makeCtx(home);
    const result = await preflightBgAgent(record, "task", ctx, diag, { homeDir: home });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // The worker's identity check must pass for the manifest we just wrote.
    assert.doesNotThrow(() => assertManifestIdentityMatchesRuntime(result.manifest, { homeDir: home }));
    // A mismatched homeDir would be rejected (N1).
    assert.throws(
      () => assertManifestIdentityMatchesRuntime({ ...result.manifest, options: { ...result.manifest.options, homeDir: "/tmp/fake" } }, { homeDir: home }),
      /does not match trusted runtime/,
    );
  });
}

async function testPreflightRejectsUnregisteredAgent() {
  await withTempHome(async (home) => {
    // No agent registered → resolveRegisteredRunTarget fails, so preflight can't even get a record.
    // Instead, build a record pointing at a non-existent file and assert the gate denies.
    const diag = await collectAgentDiagnostics({ cwd: home, homeDir: home, projectTrusted: false });
    const fakeRecord = {
      name: "ghost", source: "user", status: "runnable", runnable: true, registered: true, reason: "", nextStep: "",
      spec: { name: "ghost", description: "d", source: "user", tools: ["read"], prompt: "p", inputContract: { kind: "task-string", maxTaskChars: 100, emptyTask: "reject" }, outputContract: { requiredSections: ["Summary"], maxSummaryChars: 500 }, evals: [], limits: { timeoutMs: 1000, maxStdoutBytes: 1000, maxStderrChars: 200, maxResultChars: 500, maxJsonLineBytes: 500, maxTaskChars: 100, maxChildProcesses: 1, maxChainLength: 3 }, observability: { retainInMemoryRuns: 20, persistByDefault: false, includeToolTrajectory: true, storeFullPrompt: false, storeFullTask: false, storeFullToolResults: false, storeThinkingText: false }, safety: { approveProjectByDefault: false, projectSpecsRequireTrustAndRegistration: true, allowRecursiveSubagents: false, promptTransport: "stdin-or-private-tempfile", forbiddenTools: ["write", "edit", "bash", "run_subagent"], redactDisplayedCommand: true } },
      canonicalPath: path.join(home, ".pi", "agent", "agents", "ghost.md"),
      rawBytesSha256: "0".repeat(64),
      filePath: path.join(home, ".pi", "agent", "agents", "ghost.md"),
    };
    const ctx = makeCtx(home);
    const result = await preflightBgAgent(fakeRecord, "task", ctx, diag, { homeDir: home });
    assert.equal(result.ok, false, "preflight must deny when the spec file does not exist");
    if (result.ok) return;
    assert.equal(result.code, "re-read-failed");
  });
}

// F1: gate-denial (canRunAgent hash mismatch after file tamper) must
// write NO manifest and reserve NO slot — the actual security property.
async function testPreflightGateDenialNoLeak() {
  await withTempHome(async (home) => {
    const { record, diag } = await setupRegisteredUserAgent(home, "gate-test");
    const ctx = makeCtx(home);
    const { countActiveBgRuns } = await import("../lib/bg-state.ts");
    // Tamper the spec file so the re-read hash doesn't match the registry.
    const specPath = path.join(home, ".pi", "agent", "agents", "gate-test.md");
    await fs.appendFile(specPath, "\n// tampered");

    const result = await preflightBgAgent(record, "task", ctx, diag, { homeDir: home, effectiveTimeoutSec: 60 });
    assert.equal(result.ok, false, "preflight must deny when spec hash does not match registry");
    if (result.ok) return;
    assert.match(result.reason, /not runnable/, "gate-denied reason mentions not runnable");
    // No slot reserved (createBgRunState never called after gate denial).
    assert.equal(await countActiveBgRuns(home), 0, "gate denial must not reserve a slot");
  });
}

async function testPreflightReservationCounted() {
  await withTempHome(async (home) => {
    const { record, diag } = await setupRegisteredUserAgent(home);
    const ctx = makeCtx(home);
    const result = await preflightBgAgent(record, "task", ctx, diag, { homeDir: home, effectiveTimeoutSec: 86_400 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // The reserved run counts as active (manifest written, not done).
    const { countActiveBgRuns } = await import("../lib/bg-state.ts");
    assert.equal(await countActiveBgRuns(home), 1, "preflight reservation counts as active");
    assert.ok(await fs.stat(result.paths.manifestPath), "manifest file exists on disk");
  });
}

async function main() {
  console.log("P4-2 bg-preflight tests");
  await test("preflight writes a signed, verifiable manifest", testPreflightWritesSignedManifest);
  await test("manifest homeDir matches trusted root (N1)", testPreflightManifestHomeDirMatchesTrustedRoot);
  await test("preflight denies unregistered/missing agent (re-read-failed)", testPreflightRejectsUnregisteredAgent);
  await test("gate denial writes no manifest and reserves no slot", testPreflightGateDenialNoLeak);
  await test("preflight reservation is counted active", testPreflightReservationCounted);
  console.log("P4-2 bg-preflight tests passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
