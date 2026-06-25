import assert from "node:assert/strict";
import { prepareAgentTask, providersForAgent } from "../lib/context-providers/prepare-task.ts";
import { getBuiltInAgentSpec } from "../lib/specs.ts";

// Fake assemble/writeBundle seams so no real git/fs is touched.
function fakeAssemble(meta) {
	return async (providers) => ({ markdown: `BUNDLE(${providers.join(",")})`, meta });
}
function fakeWriter(records) {
	return async (markdown) => {
		const path = `/tmp/fake-bundle-${records.length}.md`;
		const rec = { path, markdown, disposed: false };
		records.push(rec);
		return { path, dispose: async () => { rec.disposed = true; } };
	};
}
const META_WITH_CHANGES = { branch: "feature", base: "abc123", degraded: null, changedFiles: [{ path: "a.ts", added: 1, removed: 0, binary: false }], untracked: [], omittedDiffFiles: [] };
const META_EMPTY = { branch: "feature", base: null, degraded: "non-repo", changedFiles: [], untracked: [], omittedDiffFiles: [] };

// 1. providersForAgent: built-in name + spec + unknown
function testProvidersForAgent() {
	assert.deepEqual(providersForAgent("reviewer"), ["git-diff", "changed-files", "branch-commits", "plan-docs"]);
	assert.deepEqual(providersForAgent("planner"), ["plan-docs", "changed-files"]);
	assert.deepEqual(providersForAgent("scout"), []);
	assert.deepEqual(providersForAgent("not-an-agent"), []);
	assert.deepEqual(providersForAgent(getBuiltInAgentSpec("reviewer")), ["git-diff", "changed-files", "branch-commits", "plan-docs"]);
	// A registered-style spec without context: → none.
	assert.deepEqual(providersForAgent({ name: "x", context: undefined }), []);
}

// 2. No-context agent → raw task, no bundle, noop dispose
async function testNoContextAgentIsNoop() {
	const records = [];
	const out = await prepareAgentTask("scout", "do the thing", { cwd: "/repo", assemble: fakeAssemble(META_WITH_CHANGES), writeBundle: fakeWriter(records) });
	assert.equal(out.task, "do the thing");
	assert.equal(out.bundlePath, null);
	assert.deepEqual(out.providers, []);
	assert.equal(records.length, 0, "no bundle written for a context-less agent");
	await out.dispose(); // must not throw
}

// 3. No cwd → no-op even for a context agent (can't assemble)
async function testNoCwdIsNoop() {
	const records = [];
	const out = await prepareAgentTask("reviewer", "review", { assemble: fakeAssemble(META_WITH_CHANGES), writeBundle: fakeWriter(records) });
	assert.equal(out.task, "review");
	assert.equal(out.bundlePath, null);
	assert.equal(records.length, 0);
}

// 4. Reviewer with changes → task augmented with read-bundle directive + untrusted framing; bundle written
async function testReviewerAugments() {
	const records = [];
	const out = await prepareAgentTask("reviewer", "please review", { cwd: "/repo", assemble: fakeAssemble(META_WITH_CHANGES), writeBundle: fakeWriter(records) });
	assert.equal(records.length, 1, "bundle written");
	assert.equal(out.bundlePath, records[0].path);
	assert.match(out.task, /tool to read the review-context bundle/);
	assert.match(out.task, new RegExp(records[0].path.replace(/[/.]/g, "\\$&")));
	assert.match(out.task, /UNTRUSTED reference data/);
	assert.match(out.task, /branch feature vs base abc123/);
	assert.match(out.task, /please review$/m, "raw task preserved after the directive");
	assert.equal(records[0].markdown, "BUNDLE(git-diff,changed-files,branch-commits,plan-docs)");
}

// 5. Empty bundle (no changes) → no-op, no bundle written
async function testEmptyBundleIsNoop() {
	const records = [];
	const out = await prepareAgentTask("reviewer", "review", { cwd: "/repo", assemble: fakeAssemble(META_EMPTY), writeBundle: fakeWriter(records) });
	assert.equal(out.task, "review", "raw task when nothing to review");
	assert.equal(out.bundlePath, null);
	assert.equal(records.length, 0, "no bundle written when there are no changes");
}

// 6. dispose() deletes the bundle (B3 — caller calls in finally)
async function testDisposeDeletesBundle() {
	const records = [];
	const out = await prepareAgentTask("reviewer", "review", { cwd: "/repo", assemble: fakeAssemble(META_WITH_CHANGES), writeBundle: fakeWriter(records) });
	assert.equal(records[0].disposed, false);
	await out.dispose();
	assert.equal(records[0].disposed, true, "dispose deletes the bundle file");
}

// 7. Assembly throwing → degrades to raw task, never throws (N3)
async function testAssemblyThrowDegrades() {
	const throwingAssemble = async () => { throw new Error("git blew up"); };
	const out = await prepareAgentTask("reviewer", "review", { cwd: "/repo", assemble: throwingAssemble, writeBundle: fakeWriter([]) });
	assert.equal(out.task, "review");
	assert.equal(out.bundlePath, null);
	await out.dispose();
}

async function main() {
	testProvidersForAgent();
	await testNoContextAgentIsNoop();
	await testNoCwdIsNoop();
	await testReviewerAugments();
	await testEmptyBundleIsNoop();
	await testDisposeDeletesBundle();
	await testAssemblyThrowDegrades();
	console.log("OK: 7/7 tests passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
