import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  appendBgEvent,
  cleanupBgStateOnSessionStart,
  countActiveBgRuns,
  createBgRunState,
  deleteSessionMacKey,
  ensureBgStateDir,
  getBgRunPaths,
  getBgSessionMacPath,
  getBgStateDir,
  listBgRuns,
  markBgRunDone,
  readOrCreateSessionMacKey,
  readSessionMacKey,
  signBgPayload,
  verifyBgPayloadMac,
  writeBgManifest,
  writeBgResult,
} from "../lib/bg-state.ts";

async function withTempHome(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agents-bg-state-"));
  const home = path.join(root, "home");
  try {
    return await fn(home, root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function modeOf(filePath) {
  const stat = await fs.stat(filePath);
  return stat.mode & 0o777;
}

async function test(name, fn) {
  await fn();
  console.log(`  ✓ ${name}`);
}

async function testStateDirectoryAndPaths() {
  await withTempHome(async (home) => {
    const stateDir = await ensureBgStateDir(home);
    assert.equal(stateDir, path.join(home, ".pi", "agent", "bg"));
    assert.equal(getBgStateDir(home), stateDir);
    assert.equal(await modeOf(stateDir), 0o700);

    const paths = getBgRunPaths("bg-test-0001", home);
    assert.equal(paths.runDir, path.join(stateDir, "bg-test-0001"));
    assert.equal(paths.manifestPath, path.join(paths.runDir, "manifest.json"));
    assert.equal(paths.resultPath, path.join(paths.runDir, "result.json"));
    assert.equal(paths.eventsPath, path.join(paths.runDir, "events.jsonl"));
    assert.equal(paths.donePath, path.join(paths.runDir, "done"));
    assert.equal(paths.reservationPath, path.join(paths.runDir, ".reserved"));

    assert.throws(() => getBgRunPaths("../bad", home), /invalid background run id/);
  });
}

async function testSessionMacKeyLifecycleAndSigning() {
  await withTempHome(async (home) => {
    const key = await readOrCreateSessionMacKey(home, () => Buffer.alloc(32, 7));
    assert.equal(key.toString("hex"), "07".repeat(32));
    assert.equal(await modeOf(getBgSessionMacPath(home)), 0o600);

    const reread = await readSessionMacKey(home);
    assert.equal(reread.toString("hex"), key.toString("hex"));
    const payload = { z: 1, a: { b: true } };
    const mac = signBgPayload(payload, key);
    assert.equal(verifyBgPayloadMac({ a: { b: true }, z: 1 }, key, mac), true);
    assert.equal(verifyBgPayloadMac({ a: { b: false }, z: 1 }, key, mac), false);

    await deleteSessionMacKey(home);
    await assert.rejects(() => readSessionMacKey(home), /ENOENT/);
  });
}

async function testSessionMacRejectsSymlink() {
  await withTempHome(async (home, root) => {
    await ensureBgStateDir(home);
    const target = path.join(root, "outside-key");
    await fs.writeFile(target, `${"08".repeat(32)}\n`);
    await fs.symlink(target, getBgSessionMacPath(home));
    await assert.rejects(() => readOrCreateSessionMacKey(home), /refusing symlinked session MAC key/);
    await assert.rejects(() => readSessionMacKey(home), /refusing symlinked session MAC key/);
  });
}

async function testSessionMacRejectsUnsafeModeAndMalformedContents() {
  await withTempHome(async (home) => {
    await ensureBgStateDir(home);
    const keyPath = getBgSessionMacPath(home);
    await fs.writeFile(keyPath, `${"09".repeat(32)}\n`, { mode: 0o600 });
    await fs.chmod(keyPath, 0o644);
    await assert.rejects(() => readSessionMacKey(home), /must not be readable by group or others/);
    await fs.chmod(keyPath, 0o600);
    await fs.writeFile(keyPath, "not-a-hex-key\n");
    await assert.rejects(() => readSessionMacKey(home), /invalid background session MAC key/);
  });
}

async function testStateAncestorSafetyIsRechecked() {
  await withTempHome(async (home, root) => {
    await readOrCreateSessionMacKey(home, () => Buffer.alloc(32, 10));
    const bgDir = getBgStateDir(home);
    await fs.chmod(bgDir, 0o755);
    await assert.rejects(() => readSessionMacKey(home), /must not be accessible by group or others/);
    await fs.chmod(bgDir, 0o700);

    const movedBg = path.join(root, "moved-bg");
    await fs.rename(bgDir, movedBg);
    await fs.symlink(movedBg, bgDir);
    await assert.rejects(() => readSessionMacKey(home), /refusing symlinked background state directory/);
  });
}

async function testCreateRunStateAndDoneLifecycle() {
  await withTempHome(async (home) => {
    const paths = await createBgRunState({ homeDir: home, runId: "bg-test-0002" });
    assert.equal(await modeOf(paths.runDir), 0o700);
    assert.equal(await modeOf(paths.reservationPath), 0o600);
    assert.equal(await countActiveBgRuns(home), 1);

    const manifest = {
      version: 1,
      runId: paths.runId,
      identity: { agentName: "scout", canonicalPath: "/tmp/scout.md", expectedHash: "a".repeat(64) },
      task: "find issues",
      options: { cwd: "/tmp/project", homeDir: home, maxDurationSec: 120 },
      mac: "m".repeat(64),
    };
    await writeBgManifest(paths, manifest);
    assert.deepEqual(JSON.parse(await fs.readFile(paths.manifestPath, "utf8")), manifest);
    assert.equal(await modeOf(paths.manifestPath), 0o600);

    await appendBgEvent(paths, { type: "started" });
    await appendBgEvent(paths, { type: "finished" });
    assert.equal((await fs.readFile(paths.eventsPath, "utf8")).trim().split("\n").length, 2);
    assert.equal(await modeOf(paths.eventsPath), 0o600);

    await writeBgResult(paths, { version: 1, runId: paths.runId, status: "completed", agentName: "scout", resultText: "ok" });
    assert.equal(await modeOf(paths.resultPath), 0o600);
    await markBgRunDone(paths);
    assert.equal(await modeOf(paths.donePath), 0o600);
    assert.equal(await countActiveBgRuns(home), 0);
    assert.equal((await listBgRuns(home))[0].status, "completed");
    await assert.rejects(() => fs.stat(paths.reservationPath), /ENOENT/);
    await assert.rejects(() => writeBgResult(paths, { version: 1, runId: paths.runId, status: "completed" }), /background run is not reserved/);
  });
}

async function testManifestAndResultRequireReservation() {
  await withTempHome(async (home) => {
    const paths = getBgRunPaths("bg-test-0011", home);
    const manifest = {
      version: 1,
      runId: paths.runId,
      identity: { agentName: "scout", canonicalPath: "/tmp/scout.md", expectedHash: "a".repeat(64) },
      task: "find issues",
      options: { cwd: "/tmp/project", homeDir: home },
      mac: "m".repeat(64),
    };
    await assert.rejects(() => writeBgManifest(paths, manifest), /ENOENT|background run directory/);
    await assert.rejects(() => writeBgResult(paths, { version: 1, runId: paths.runId, status: "completed" }), /ENOENT|background run directory/);
    await ensureBgStateDir(home);
    await fs.mkdir(paths.runDir, { mode: 0o700 });
    await assert.rejects(() => writeBgManifest(paths, manifest), /background run is not reserved/);
    await assert.rejects(() => writeBgResult(paths, { version: 1, runId: paths.runId, status: "completed" }), /background run is not reserved/);
    await assert.rejects(() => appendBgEvent(paths, { type: "started" }), /background run is not reserved/);
    await assert.rejects(() => markBgRunDone(paths), /background run is not reserved/);

    const outside = path.join(home, "outside-reservation");
    await fs.writeFile(outside, "reserved\n");
    await fs.symlink(outside, paths.reservationPath);
    await assert.rejects(() => writeBgManifest(paths, manifest), /refusing symlinked state path/);
    await fs.rm(paths.runDir, { recursive: true, force: true });

    const real = await createBgRunState({ homeDir: home, runId: "bg-test-0016" });
    await assert.rejects(
      () => writeBgResult({ ...real, resultPath: path.join(home, "outside-result.json") }, { version: 1, runId: real.runId, status: "completed" }),
      /non-canonical background run path 'resultPath'/,
    );
    await assert.rejects(
      () => markBgRunDone({ ...real, reservationPath: paths.reservationPath }),
      /non-canonical background run path 'reservationPath'/,
    );
    await assert.rejects(
      () => appendBgEvent({ ...real, stateDir: path.join(home, "not-pi-agent-bg") }, { type: "started" }),
      /non-canonical background state directory/,
    );
  });
}

async function testRunIdCollisionRetriesAndExplicitCollisionFails() {
  await withTempHome(async (home) => {
    const first = await createBgRunState({ homeDir: home, runId: "bg-test-0003" });
    assert.equal(first.runId, "bg-test-0003");
    await assert.rejects(() => createBgRunState({ homeDir: home, runId: "bg-test-0003" }), /EEXIST/);

    let calls = 0;
    const second = await createBgRunState({
      homeDir: home,
      generateRunId: () => (++calls === 1 ? "bg-test-0003" : "bg-test-0004"),
    });
    assert.equal(second.runId, "bg-test-0004");

    await assert.rejects(() => createBgRunState({ homeDir: home, maxAttempts: 0 }), /maxAttempts must be a positive integer/);
  });
}

async function testConcurrencyLimit() {
  await withTempHome(async (home) => {
    await createBgRunState({ homeDir: home, runId: "bg-test-0005", maxConcurrentRuns: 1 });
    await assert.rejects(
      () => createBgRunState({ homeDir: home, runId: "bg-test-0006", maxConcurrentRuns: 1 }),
      /concurrency limit reached \(1\)/,
    );
  });
}

async function testSymlinkedRunDirRefused() {
  await withTempHome(async (home, root) => {
    await ensureBgStateDir(home);
    const outside = path.join(root, "outside-run");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(getBgStateDir(home), "bg-test-0007"));
    await assert.rejects(() => createBgRunState({ homeDir: home, runId: "bg-test-0007" }), /refusing symlinked background run directory/);
    await assert.rejects(() => listBgRuns(home), /refusing symlinked background run directory/);
  });
}

async function testDoneDirectoryAndInvalidResultStatusAreUnknown() {
  await withTempHome(async (home) => {
    const paths = await createBgRunState({ homeDir: home, runId: "bg-test-0012" });
    await fs.chmod(paths.runDir, 0o755);
    await assert.rejects(() => writeBgResult(paths, { version: 1, runId: paths.runId, status: "completed" }), /background run directory must not be accessible/);
    await fs.chmod(paths.runDir, 0o700);
    await fs.mkdir(paths.donePath);
    let runs = await listBgRuns(home);
    assert.equal(runs[0].done, false);
    assert.equal(runs[0].status, "reserved");
    await assert.rejects(() => markBgRunDone(paths), /EEXIST/);
    assert.equal(await countActiveBgRuns(home), 1);
    await fs.rm(paths.donePath, { recursive: true });

    await writeBgResult(paths, { version: 1, runId: paths.runId, status: "not-a-real-status" });
    await markBgRunDone(paths);
    runs = await listBgRuns(home);
    assert.equal(runs[0].done, true);
    assert.equal(runs[0].status, "unknown");

    const symlinkedResult = await createBgRunState({ homeDir: home, runId: "bg-test-0017" });
    const outsideResult = path.join(home, "outside-result.json");
    await fs.writeFile(outsideResult, JSON.stringify({ status: "completed" }));
    await fs.symlink(outsideResult, symlinkedResult.resultPath);
    await markBgRunDone(symlinkedResult);
    await assert.rejects(() => listBgRuns(home), /refusing symlinked state path/);
    await fs.rm(symlinkedResult.resultPath);

    const corrupt = await createBgRunState({ homeDir: home, runId: "bg-test-0014" });
    await fs.writeFile(corrupt.resultPath, "{not json", { mode: 0o600 });
    await markBgRunDone(corrupt);
    runs = await listBgRuns(home);
    assert.equal(runs.find((run) => run.runId === "bg-test-0014").status, "unknown");
  });
}

async function testDonePlusReservedRejectsFurtherWrites() {
  await withTempHome(async (home) => {
    const paths = await createBgRunState({ homeDir: home, runId: "bg-test-0015" });
    await fs.writeFile(paths.donePath, "", { mode: 0o600, flag: "wx" });
    assert.equal(await countActiveBgRuns(home), 0);
    await assert.rejects(() => writeBgResult(paths, { version: 1, runId: paths.runId, status: "completed" }), /background run is already done/);
    await assert.rejects(() => writeBgManifest(paths, {
      version: 1,
      runId: paths.runId,
      identity: { agentName: "scout", canonicalPath: "/tmp/scout.md", expectedHash: "a".repeat(64) },
      task: "find issues",
      options: { cwd: "/tmp/project", homeDir: home },
      mac: "m".repeat(64),
    }), /background run is already done/);
    await assert.rejects(() => appendBgEvent(paths, { type: "late" }), /background run is already done/);
    await markBgRunDone(paths);
    await assert.rejects(() => fs.stat(paths.reservationPath), /ENOENT/);
  });
}

async function testLifecycleWritersRejectSymlinkTargets() {
  await withTempHome(async (home, root) => {
    const target = path.join(root, "outside.json");
    await fs.writeFile(target, "{}\n");
    const resultRun = await createBgRunState({ homeDir: home, runId: "bg-test-0008" });
    await fs.symlink(target, resultRun.resultPath);
    await assert.rejects(() => writeBgResult(resultRun, { version: 1, runId: resultRun.runId, status: "completed" }), /refusing symlinked atomic write target/);

    const paths = await createBgRunState({ homeDir: home, runId: "bg-test-0013" });
    const eventTarget = path.join(root, "outside-events.jsonl");
    await fs.writeFile(eventTarget, "");
    await fs.symlink(eventTarget, paths.eventsPath);
    await assert.rejects(() => appendBgEvent(paths, { type: "started" }), /refusing symlinked events file/);
  });
}

async function testCleanupPrunesCompletedAndRemovesPromptFiles() {
  await withTempHome(async (home) => {
    const oldRun = await createBgRunState({ homeDir: home, runId: "bg-test-0009" });
    await writeBgResult(oldRun, { version: 1, runId: oldRun.runId, status: "completed" });
    await markBgRunDone(oldRun);

    // Ensure different mtimes for deterministic pruning order.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const keptRun = await createBgRunState({ homeDir: home, runId: "bg-test-0010" });
    await fs.writeFile(path.join(keptRun.runDir, "prompt.txt"), "orphan");
    await appendBgEvent(keptRun, { type: "debug" });
    await writeBgResult(keptRun, { version: 1, runId: keptRun.runId, status: "completed" });
    await markBgRunDone(keptRun);

    const cleanup = await cleanupBgStateOnSessionStart({ homeDir: home, keepRecentRuns: 1 });
    assert.deepEqual(cleanup.prunedRunIds, ["bg-test-0009"]);
    assert.equal(cleanup.removedPromptFiles.length, 1);
    assert.equal(cleanup.removedEventFiles.length, 1);
    await assert.rejects(() => fs.stat(oldRun.runDir), /ENOENT/);
    await assert.rejects(() => fs.stat(path.join(keptRun.runDir, "prompt.txt")), /ENOENT/);
    await assert.rejects(() => fs.stat(keptRun.eventsPath), /ENOENT/);
    assert.equal((await listBgRuns(home)).map((run) => run.runId).join(","), "bg-test-0010");
  });
}

async function main() {
  console.log("P4-1 bg-state tests");
  await test("state directory and paths", testStateDirectoryAndPaths);
  await test("session MAC key lifecycle and signing", testSessionMacKeyLifecycleAndSigning);
  await test("session MAC symlink rejection", testSessionMacRejectsSymlink);
  await test("session MAC unsafe mode and malformed contents rejection", testSessionMacRejectsUnsafeModeAndMalformedContents);
  await test("state ancestor safety is rechecked", testStateAncestorSafetyIsRechecked);
  await test("run state and done lifecycle", testCreateRunStateAndDoneLifecycle);
  await test("manifest/result require reservation", testManifestAndResultRequireReservation);
  await test("run id collision retry", testRunIdCollisionRetriesAndExplicitCollisionFails);
  await test("concurrency limit", testConcurrencyLimit);
  await test("symlinked run dir refused", testSymlinkedRunDirRefused);
  await test("done directory and invalid result status are unknown", testDoneDirectoryAndInvalidResultStatusAreUnknown);
  await test("done plus reserved rejects further writes", testDonePlusReservedRejectsFurtherWrites);
  await test("lifecycle writers reject symlink targets", testLifecycleWritersRejectSymlinkTargets);
  await test("cleanup prunes completed runs and prompt files", testCleanupPrunesCompletedAndRemovesPromptFiles);
  console.log("agents bg-state tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
