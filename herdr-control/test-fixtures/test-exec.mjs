// herdr-control: executor tests (timeout clamping, ENOENT mapping).
import assert from "node:assert/strict";
import { defaultHerdrExecutor, clampExecTimeout } from "../lib/exec.ts";
import { HERDR_EXEC_ABS_MAX_MS } from "../lib/constants.ts";

assert.equal(clampExecTimeout(5_000), 5_000);
assert.equal(clampExecTimeout(999_999), HERDR_EXEC_ABS_MAX_MS, "clamped to abs max");
assert.equal(clampExecTimeout(-1), HERDR_EXEC_ABS_MAX_MS, "invalid input falls back to abs max");
assert.equal(clampExecTimeout(Number.NaN), HERDR_EXEC_ABS_MAX_MS);

// missing binary maps to a friendly ENOENT result (not a throw)
const savedPath = process.env.PATH;
process.env.PATH = "/nonexistent-dir-for-herdr-tests";
try {
	const executor = defaultHerdrExecutor();
	const result = await executor.exec(["status", "client"], { timeoutMs: 5_000 });
	assert.equal(result.ok, false);
	assert.match(result.stderr, /ENOENT/);
	assert.equal(result.exitCode, -1);
} finally {
	process.env.PATH = savedPath;
}

console.log("test-exec: all tests passed");
