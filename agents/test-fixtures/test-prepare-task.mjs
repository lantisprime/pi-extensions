import assert from "node:assert/strict";
import { prepareAgentTask, providersForAgent } from "../lib/context-providers/prepare-task.ts";
import { getBuiltInAgentSpec } from "../lib/specs.ts";
import { NOTE_BASE_EQ_HEAD } from "../lib/context-providers/review-context.ts";

// Fake assemble/writeBundle seams so no real git/fs is touched.
function fakeAssemble(meta) {
	return async (providers) => ({ markdown: `BUNDLE(${providers.join(",")})`, meta });
}
// Capturing assemble: records the (providers, deps) it was called with so a test can assert that
// prepareAgentTask forwarded opts.reviewTarget into the bundle assembler (P11 plumbing).
function capturingAssemble(meta, sink) {
	return async (providers, deps) => { sink.push({ providers, deps }); return { markdown: `BUNDLE(${providers.join(",")})`, meta }; };
}
function fakeWriter(records) {
	return async (markdown) => {
		const path = `/tmp/fake-bundle-${records.length}.md`;
		const rec = { path, markdown, disposed: false };
		records.push(rec);
		return { path, dispose: async () => { rec.disposed = true; } };
	};
}
const META_WITH_CHANGES = { branch: "feature", base: "abc123", degraded: null, changedFiles: [{ path: "a.ts", added: 1, removed: 0, binary: false }], untracked: [], omittedDiffFiles: [], projectRoot: "/repo", mode: "auto", scopeNote: null };
const META_EMPTY = { branch: "feature", base: null, degraded: "non-repo", changedFiles: [], untracked: [], omittedDiffFiles: [], projectRoot: "/repo", mode: "auto", scopeNote: null };
const META_RANGE = { branch: "feature", base: "v1.0", degraded: null, changedFiles: [{ path: "a.ts", added: 1, removed: 0, binary: false }], untracked: [], omittedDiffFiles: [], projectRoot: "/repo", mode: "range", scopeNote: "committed range v1.0..v2.0 (changes on v2.0 since it forked from v1.0)" };
const META_BASE_EMPTY_DEGRADED = { branch: "feature", base: "nope", degraded: "base \"nope\" may not exist; diff may be empty.", changedFiles: [], untracked: [], omittedDiffFiles: [], projectRoot: "/repo", mode: "base", scopeNote: null };

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

// 8. P11: prepareAgentTask forwards opts.reviewTarget into the assembler (plumbing — F1).
async function testReviewTargetForwarded() {
	const sink = [];
	const target = { kind: "range", spec: "v1.0..v2.0" };
	await prepareAgentTask("reviewer", "review", { cwd: "/repo", reviewTarget: target, assemble: capturingAssemble(META_RANGE, sink), writeBundle: fakeWriter([]) });
	assert.equal(sink.length, 1, "assembler called once");
	assert.deepEqual(sink[0].deps.reviewTarget, target, "reviewTarget reached the assembler verbatim");
	// Negative control: omitting reviewTarget forwards undefined (auto), never a stale target.
	const sink2 = [];
	await prepareAgentTask("reviewer", "review", { cwd: "/repo", assemble: capturingAssemble(META_WITH_CHANGES, sink2), writeBundle: fakeWriter([]) });
	assert.equal(sink2[0].deps.reviewTarget, undefined, "no target → undefined forwarded");
}

// 9. P11: range mode produces committed-range directive wording, NOT "vs base, plus uncommitted" (F3).
async function testRangeDirectiveWording() {
	const out = await prepareAgentTask("reviewer", "please review", { cwd: "/repo", reviewTarget: { kind: "range", spec: "v1.0..v2.0" }, assemble: fakeAssemble(META_RANGE), writeBundle: fakeWriter([]) });
	assert.match(out.task, /committed range v1\.0 \(no uncommitted changes\)/, "range wording present");
	assert.doesNotMatch(out.task, /plus uncommitted changes/, "must not claim uncommitted in range mode");
}

// 10. P11 G1/G2: an EXPLICIT base/range that produced no changes but DID degrade still writes the
// bundle so the "may not exist" note reaches the child; an AUTO empty stays a no-op (contrast #5).
async function testExplicitDegradedDelivered() {
	const records = [];
	const out = await prepareAgentTask("reviewer", "review", { cwd: "/repo", reviewTarget: { kind: "base", ref: "nope" }, assemble: fakeAssemble(META_BASE_EMPTY_DEGRADED), writeBundle: fakeWriter(records) });
	assert.equal(records.length, 1, "explicit degraded target writes a bundle even with 0 changes");
	assert.equal(out.bundlePath, records[0].path);
	await out.dispose();
}

// 11. CR-1: base==HEAD directive says uncommitted-only (matches header), NOT "vs base ... plus uncommitted".
async function testBaseEqHeadDirective() {
	const META_BASE_EQ_HEAD = { branch: "main", base: "main", degraded: null, changedFiles: [{ path: "a.ts", added: 1, removed: 0, binary: false }], untracked: [], omittedDiffFiles: [], projectRoot: "/repo", mode: "base", scopeNote: NOTE_BASE_EQ_HEAD };
	const out = await prepareAgentTask("reviewer", "review", { cwd: "/repo", reviewTarget: { kind: "base", ref: "main" }, assemble: fakeAssemble(META_BASE_EQ_HEAD), writeBundle: fakeWriter([]) });
	assert.match(out.task, /uncommitted changes vs HEAD on main/, "base==HEAD directive uses uncommitted-only wording");
	assert.doesNotMatch(out.task, /vs base main, plus uncommitted/, "must not claim a committed delta when base==HEAD");
}
// 12. G4: an explicit base/range on a CLEAN tree (0 changes, no degrade) stays a no-op (no bundle written).
async function testG4_explicit_clean_tree_noop() {
	const records = [];
	const META = { branch: "feature", base: "v1.0", degraded: null, changedFiles: [], untracked: [], omittedDiffFiles: [], projectRoot: "/repo", mode: "base", scopeNote: null };
	const out = await prepareAgentTask("reviewer", "review", { cwd: "/repo", reviewTarget: { kind: "base", ref: "v1.0" }, assemble: fakeAssemble(META), writeBundle: fakeWriter(records) });
	assert.equal(out.bundlePath, null, "clean tree + valid explicit base → no bundle");
	assert.equal(records.length, 0);
}
// 13. G2: a RANGE target with 0 changes but a degraded note still delivers the bundle (the other half).
async function testG2_range_degraded_delivered() {
	const records = [];
	const META = { branch: "feature", base: "a", degraded: "range \"a..b\" endpoint may not exist; diff may be empty.", changedFiles: [], untracked: [], omittedDiffFiles: [], projectRoot: "/repo", mode: "range", scopeNote: "committed range a..b" };
	const out = await prepareAgentTask("reviewer", "review", { cwd: "/repo", reviewTarget: { kind: "range", spec: "a..b" }, assemble: fakeAssemble(META), writeBundle: fakeWriter(records) });
	assert.equal(records.length, 1, "range + degraded + 0 changes → bundle written (range disjunct of the write rule)");
	assert.equal(out.bundlePath, records[0].path);
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
	await testReviewTargetForwarded();
	await testRangeDirectiveWording();
	await testExplicitDegradedDelivered();
	await testBaseEqHeadDirective();
	await testG4_explicit_clean_tree_noop();
	await testG2_range_degraded_delivered();
	console.log("OK: 13/13 tests passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
