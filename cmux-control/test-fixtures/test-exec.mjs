// P5d-S1: macOS cmux 0.64.17+ executor tests.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultCmuxExecutor } from "../lib/exec.ts";

function createFakeCmux(script) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmux-control-exec-"));
	const bin = path.join(dir, "cmux");
	fs.writeFileSync(bin, script, { mode: 0o755 });
	return dir;
}

// execReturnsStdout: fake returns {ok:true}, assert the result.
{
	const dir = createFakeCmux("#!/bin/sh\nprintf 'cmux stdout'\n");
	const previousPath = process.env.PATH;
	process.env.PATH = dir;
	const result = await defaultCmuxExecutor().exec(["identify"], { timeoutMs: 5000 });
	process.env.PATH = previousPath;
	assert.deepEqual(result, { ok: true, stdout: "cmux stdout", stderr: "", exitCode: 0 });
}

// execReturnsStderrOnFailure: fake returns {ok:false}, assert stderr.
{
	const dir = createFakeCmux("#!/bin/sh\nprintf 'cmux stderr' >&2\nexit 7\n");
	const previousPath = process.env.PATH;
	process.env.PATH = dir;
	const result = await defaultCmuxExecutor().exec(["identify"], { timeoutMs: 5000 });
	process.env.PATH = previousPath;
	assert.equal(result.ok, false);
	assert.equal(result.stderr, "cmux stderr");
	assert.equal(result.exitCode, 7);
}

// execENOENT: simulate ENOENT, assert "spawn cmux ENOENT".
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmux-control-empty-path-"));
	const previousPath = process.env.PATH;
	process.env.PATH = dir;
	const result = await defaultCmuxExecutor().exec(["identify"], { timeoutMs: 5000 });
	process.env.PATH = previousPath;
	assert.equal(result.ok, false);
	assert.equal(result.stderr, "spawn cmux ENOENT");
}

// execTimeout: simulate killed+signal, assert "timed out after Nms".
{
	const dir = createFakeCmux("#!/bin/sh\nsleep 1\n");
	const previousPath = process.env.PATH;
	process.env.PATH = dir;
	const result = await defaultCmuxExecutor().exec(["identify"], { timeoutMs: 50 });
	process.env.PATH = previousPath;
	assert.equal(result.ok, false);
	assert.equal(result.stderr, "timed out after 50ms");
}
