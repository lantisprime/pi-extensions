// P5 test-helpers.mjs — 12 tests:
//   shellEscape (3) + redactError (2) + workerPath realpath/precedence/force-null (3) +
//   defaultTmuxExecutor + Fake seam (4).
// v5 macOS fix: testWorkerPathIsRealpathed and testWorkerPathPrefersTsOverMjs
// assert against fs.realpathSync(expected) for macOS portability (os.tmpdir()
// canonicalizes /var → /private/var). Still discriminating — a path.resolve-only
// impl returns the symlink path (not the canonicalized target).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shellEscape } from "../lib/shell-escape.ts";
import { redactError } from "../lib/redact-error.ts";
import { resolveWorkerPath, __setResolveWorkerPathForTest, __resetResolveWorkerPathForTest } from "../lib/resolve-worker-path.ts";
import { FakeTmuxExecutor } from "./fake-tmux.ts";
import { defaultTmuxExecutor } from "../lib/exec.ts";

// shellEscape (3 tests)
{
	assert.equal(shellEscape("hello"), "'hello'", "plain string must be single-quote-wrapped");
}
{
	assert.equal(shellEscape("O'Brien"), "'O'\\''Brien'", "single quote must be escaped per POSIX");
}
{
	assert.equal(shellEscape(""), "''", "empty string must produce two single quotes");
}

// redactError (2 tests)
{
	const stderr = "error at /abs/worker.ts and /abs/manifest.json";
	const out = redactError(stderr, "/abs/worker.ts", "/abs/manifest.json");
	assert.ok(out.includes("<worker>"), "worker path must be redacted");
	assert.ok(out.includes("<manifest>"), "manifest path must be redacted");
	assert.ok(!out.includes("/abs/worker.ts"), "raw worker path MUST NOT appear (B5 strength)");
	assert.ok(!out.includes("/abs/manifest.json"), "raw manifest path MUST NOT appear");
	const longStderr = "x".repeat(600);
	const longOut = redactError(longStderr, "", "");
	assert.ok(longOut.length <= 513, "long stderr MUST be truncated to 512 + ellipsis");
}
{
	const out = redactError("no paths here", "/abs/worker.ts", "/abs/manifest.json");
	assert.equal(out, "no paths here", "redactError with absent paths MUST return unchanged");
}

// workerPath resolution (3 tests) — v5 macOS fix applied to realpath/precedence
{
	// B2a: real symlink fixture. resolveWorkerPath(searchDir) runs the REAL
	// production existsSync + realpathSync loop at agentsLibDir.
	// Assert against fs.realpathSync(realWorker) for macOS portability:
	// os.tmpdir() returns /var/... on macOS but fs.realpathSync canonicalizes
	// to /private/var/... . Still discriminating: a path.resolve-only impl
	// returns the symlink path (under agents/lib/), which != canonicalized target.
	__resetResolveWorkerPathForTest();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p5-realpath-"));
	const realWorker = path.join(tmpDir, "bg-worker.ts");
	const targetContent = "// real worker";
	fs.writeFileSync(realWorker, targetContent);
	const agentsLibDir = path.join(tmpDir, "agents", "lib");
	fs.mkdirSync(agentsLibDir, { recursive: true });
	const symlinkPath = path.join(agentsLibDir, "bg-worker.ts");
	fs.symlinkSync(realWorker, symlinkPath);
	const result = resolveWorkerPath(agentsLibDir);
	const canonicalExpected = fs.realpathSync(realWorker);
	__resetResolveWorkerPathForTest();
	fs.rmSync(tmpDir, { recursive: true, force: true });
	assert.ok(result !== null, "resolveWorkerPath must find the symlink");
	assert.equal(result, canonicalExpected, "MUST return realpath of symlink target, canonicalized for macOS (B2a portability fix)");
}
{
	// Precedence: .ts wins over .mjs. resolveWorkerPath(searchDir) runs the REAL
	// production WORKER_BASENAMES loop at tmpDir.
	// Assert against fs.realpathSync(tsPath) for macOS portability.
	// Still discriminating: a wrong-precedence impl returns realpathSync(mjsPath)
	// != realpathSync(tsPath).
	__resetResolveWorkerPathForTest();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p5-precedence-"));
	const tsPath = path.join(tmpDir, "bg-worker.ts");
	const mjsPath = path.join(tmpDir, "bg-worker.mjs");
	fs.writeFileSync(tsPath, "ts");
	fs.writeFileSync(mjsPath, "mjs");
	const result = resolveWorkerPath(tmpDir);
	const canonicalTs = fs.realpathSync(tsPath);
	__resetResolveWorkerPathForTest();
	fs.rmSync(tmpDir, { recursive: true, force: true });
	assert.equal(result, canonicalTs, ".ts MUST win over .mjs when both present (canonicalized for macOS)");
}
{
	// Force-null seam unit test (drives B2b's missing-worker test path)
	__resetResolveWorkerPathForTest();
	__setResolveWorkerPathForTest(function _r() { return null; });
	const result = resolveWorkerPath(); // no searchDir → uses injectedResolver
	__resetResolveWorkerPathForTest();
	assert.equal(result, null, "null seam MUST return null when injected");
}

// defaultTmuxExecutor + Fake seam (4 tests)
{
	const fake = new FakeTmuxExecutor();
	await fake.exec(["new-window", "-d"], { timeoutMs: 5000 });
	assert.equal(fake.calls.length, 1, "Fake executor MUST record calls");
	assert.deepEqual(fake.calls[0].args, ["new-window", "-d"]);
	assert.equal(fake.calls[0].opts.timeoutMs, 5000);
}
{
	const fake = new FakeTmuxExecutor();
	fake.setDefaultResponse({ ok: true, stdout: "ok-output", stderr: "" });
	const result = await fake.exec(["list-windows"], { timeoutMs: 5000 });
	assert.equal(result.ok, true);
	assert.equal(result.stdout, "ok-output");
}
{
	const fake = new FakeTmuxExecutor();
	fake.setDefaultResponse({ simulateTimeout: true });
	let threw = false;
	try { await fake.exec(["new-window"], { timeoutMs: 100 }); } catch { threw = true; }
	assert.ok(threw, "simulateTimeout MUST cause fake.exec to throw a killed-error");
}
{
	// defaultTmuxExecutor contract: never rejects (resolves on ENOENT)
	const exec = defaultTmuxExecutor();
	const result = await exec.exec(["nonexistent-tmux-subcommand-xyz"], { timeoutMs: 1000 });
	assert.equal(result.ok, false, "defaultTmuxExecutor MUST resolve (not reject) on missing tmux");
	assert.ok(typeof result.exitCode === "number", "exitCode MUST be a number even on ENOENT");
}

console.log("P5 helper tests passed");