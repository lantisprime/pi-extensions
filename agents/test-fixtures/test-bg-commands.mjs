// P4-5: Background agent command tests (library-level).
// Full command-handler integration tests are deferred to P4-7.

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	readBgResult,
	getBgRunPaths,
	createBgRunState,
	writeBgResult,
} from "../lib/bg-state.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTempHome(fn) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "p4-5-cmds-"));
	const home = path.join(root, "home");
	try {
		return await fn(home, root);
	} finally {
		await fs.rm(root, { recursive: true, force: true }).catch(() => {});
	}
}

async function test(name, fn) {
	await fn();
	console.log(`  ✓ ${name}`);
}

// ---------------------------------------------------------------------------
// readBgResult tests
// ---------------------------------------------------------------------------

/** No result file exists → undefined. */
async function testReadBgResultNoFile() {
	await withTempHome(async (home) => {
		const paths = getBgRunPaths("bg-test-no-result", home);
		const result = await readBgResult(paths);
		assert.equal(result, undefined, "missing result file should return undefined");
	});
}

/** Empty file (not valid JSON) → undefined. */
async function testReadBgResultEmptyFile() {
	await withTempHome(async (home) => {
		const paths = await createBgRunState({ homeDir: home, runId: "bg-test-empty" });
		await fs.writeFile(paths.resultPath, "", { mode: 0o600 });
		const result = await readBgResult(paths);
		assert.equal(result, undefined, "empty result file should return undefined (not valid JSON)");
	});
}

/** Corrupt JSON → undefined. */
async function testReadBgResultCorruptJson() {
	await withTempHome(async (home) => {
		const paths = await createBgRunState({ homeDir: home, runId: "bg-test-corrupt" });
		await fs.writeFile(paths.resultPath, "not { valid json", { mode: 0o600 });
		const result = await readBgResult(paths);
		assert.equal(result, undefined, "corrupt JSON should return undefined");
	});
}

/** Valid minimal result → parsed correctly. */
async function testReadBgResultMinimal() {
	await withTempHome(async (home) => {
		const paths = await createBgRunState({ homeDir: home, runId: "bg-test-minimal" });
		const written = {
			version: 1,
			runId: "bg-test-minimal",
			status: "completed",
		};
		await writeBgResult(paths, written);

		const result = await readBgResult(paths);
		assert.ok(result, "valid result file should return a result");
		assert.equal(result.version, 1);
		assert.equal(result.runId, "bg-test-minimal");
		assert.equal(result.status, "completed");
	});
}

/** Valid complete result (with all fields) → parsed correctly. */
async function testReadBgResultFull() {
	await withTempHome(async (home) => {
		const paths = await createBgRunState({ homeDir: home, runId: "bg-test-full" });
		const written = {
			version: 1,
			runId: "bg-test-full",
			status: "failed",
			agentName: "researcher",
			startedAt: "2026-06-25T00:00:00.000Z",
			finishedAt: "2026-06-25T00:05:00.000Z",
			resultText: "found 3 bugs:\n- bug 1\n- bug 2\n- bug 3",
			error: "timeout after 300s",
		};
		await writeBgResult(paths, written);

		const result = await readBgResult(paths);
		assert.ok(result, "valid result file should return a result");
		assert.equal(result.status, "failed");
		assert.equal(result.agentName, "researcher");
		assert.equal(result.startedAt, "2026-06-25T00:00:00.000Z");
		assert.equal(result.finishedAt, "2026-06-25T00:05:00.000Z");
		assert.ok(result.resultText.includes("3 bugs"), "resultText should include the body");
		assert.equal(result.error, "timeout after 300s");
	});
}

/** Multi-line result text survives JSON round-trip. */
async function testReadBgResultMultiLineText() {
	await withTempHome(async (home) => {
		const paths = await createBgRunState({ homeDir: home, runId: "bg-test-multiline" });
		const text = "line one\nline two\n\nline four";
		await writeBgResult(paths, { version: 1, runId: "bg-test-multiline", status: "completed", resultText: text });

		const result = await readBgResult(paths);
		assert.ok(result, "valid result file should return a result");
		assert.equal(result.resultText, text, "multi-line resultText should round-trip precisely");
	});
}

/** Result written by one call is readable immediately. */
async function testReadBgResultRoundTrip() {
	await withTempHome(async (home) => {
		const paths = await createBgRunState({ homeDir: home, runId: "bg-test-roundtrip" });

		const statuses = ["running", "completed", "failed", "timed-out", "stopped"];
		let lastResult;
		for (const status of statuses) {
			await writeBgResult(paths, { version: 1, runId: "bg-test-roundtrip", status, agentName: "test" });
			lastResult = await readBgResult(paths);
			assert.ok(lastResult, `result for status '${status}' should be readable`);
			assert.equal(lastResult.status, status, `status should be '${status}'`);
		}
	});
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
	console.log("P4-5 bg-commands tests");
	await test("readBgResult: no file → undefined", testReadBgResultNoFile);
	await test("readBgResult: empty file → undefined", testReadBgResultEmptyFile);
	await test("readBgResult: corrupt JSON → undefined", testReadBgResultCorruptJson);
	await test("readBgResult: minimal result parsed", testReadBgResultMinimal);
	await test("readBgResult: full result parsed", testReadBgResultFull);
	await test("readBgResult: multi-line text round-trip", testReadBgResultMultiLineText);
	await test("readBgResult: status sequence round-trip", testReadBgResultRoundTrip);
	console.log("P4-5 bg-commands tests passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
