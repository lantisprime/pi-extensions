import assert from "node:assert";
import { parseRunArgs, parseDoArgs, dispatchChildRun, __prepareTaskSeam } from "../lib/run-resolver.ts";
import { resolveDiffTarget } from "../lib/context-providers/review-context.ts";
import { isSafeGitRef } from "../lib/context-providers/git-runner.ts";

// Tiny fake git (argv → canned result); records nothing here — resolve tests only need rev-parse to "exist".
function fakeGit(stdout = "x\n") {
	return async () => ({ ok: true, stdout, stderr: "", code: 0 });
}

// ── Group D: flag parsing edge cases ────────────────────────────────────────
function D1_base_repeat() {
	const r = parseRunArgs("reviewer --base x --base y do the review");
	assert.equal(r.ok, false, "repeated --base is a usage error");
}
function D2_range_repeat() {
	assert.equal(parseRunArgs("reviewer --range a..b --range c..d task").ok, false, "repeated --range is a usage error");
}
function D3_literal_dashdash() {
	assert.equal(parseRunArgs("reviewer --base -- task").ok, false, "--base -- (value '--') is rejected");
}
function D4_both_flags_range_wins() {
	const r = parseRunArgs("reviewer --base main --range a..b please review");
	assert.equal(r.ok, true);
	assert.deepEqual(r.reviewTarget, { kind: "range", spec: "a..b" }, "range wins over base");
	assert.match(r.warning, /both --range and --base given; using --range/, "a typed --base is never silently dropped");
	assert.equal(r.task, "please review");
}
function D6_missing_value() {
	const r = parseRunArgs("reviewer --base --range x task");
	assert.equal(r.ok, false, "--base with no value (next token is --range) is a clean usage error, not a git throw");
}
async function D7_base_contains_dotdot() {
	// Parser accepts it syntactically as a base ref...
	const r = parseRunArgs("reviewer --base HEAD~3..HEAD task");
	assert.deepEqual(r.reviewTarget, { kind: "base", ref: "HEAD~3..HEAD" });
	// ...but resolveDiffTarget refuses a range value passed to --base (use --range) → falls to auto + note.
	const t = await resolveDiffTarget(fakeGit(), "/repo", ["main"], { kind: "base", ref: "HEAD~3..HEAD" });
	assert.equal(t.mode, "auto");
	assert.match(t.scopeNote, /range operator|use --range/);
}
function D8_do_rejects_flags() {
	// /agents do never targets a diff — --base stays TASK TEXT, no reviewTarget threaded (B6).
	const r = parseDoArgs("--base main fix the bug");
	assert.equal(r.ok, true);
	assert.equal(r.reviewTarget, undefined, "do produces no review target");
	assert.equal(r.task, "--base main fix the bug", "--base main is part of the task text");
}
function D9_do_range_is_text() {
	const r = parseDoArgs("--range a..b investigate");
	assert.equal(r.reviewTarget, undefined);
	assert.match(r.task, /^--range a\.\.b investigate$/);
}

// D5: both flags with an INVALID range → range wins (REQ-11), the typo'd range resolves to AUTO (not
// the discarded --base), and the user is warned that --base was ignored. Pins the chosen precedence.
async function D5_both_flags_invalid_range() {
	const r = parseRunArgs("reviewer --base main --range ..bad review the thing");
	assert.deepEqual(r.reviewTarget, { kind: "range", spec: "..bad" }, "range wins even when invalid");
	assert.match(r.warning, /using --range, ignoring --base/);
	const t = await resolveDiffTarget(fakeGit(), "/repo", ["main"], r.reviewTarget);
	assert.equal(t.mode, "auto", "invalid range resolves to auto, NOT the discarded --base (REQ-11 governs both-flags)");
	assert.match(t.scopeNote, /invalid --range/);
}
// A11: a space-split range value (`--range a .. b`) is detected — only "a" is captured and a warning
// surfaces so the mangled task text + dropped range are not silent.
function A11_spaced_range_warns() {
	const r = parseRunArgs("reviewer --range a .. b review this");
	assert.equal(r.ok, true);
	assert.deepEqual(r.reviewTarget, { kind: "range", spec: "a" }, "only the first token after --range is captured");
	assert.match(r.warning, /split by spaces|without spaces/, "spaced range is warned, not silent");
	assert.equal(r.task, ".. b review this", "leftover tokens become task text (surfaced by the warning)");
}

// ── Group E: positive ref grammar ───────────────────────────────────────────
function E1_weird_valid_refs() {
	const b = parseRunArgs("reviewer --base release/v1.2 review");
	assert.deepEqual(b.reviewTarget, { kind: "base", ref: "release/v1.2" });
	assert.equal(isSafeGitRef("release/v1.2"), true);
	const rg = parseRunArgs("reviewer --range v1.0..HEAD review");
	assert.deepEqual(rg.reviewTarget, { kind: "range", spec: "v1.0..HEAD" });
	const tilde = parseRunArgs("reviewer --base HEAD~2 review");
	assert.deepEqual(tilde.reviewTarget, { kind: "base", ref: "HEAD~2" });
	assert.equal(isSafeGitRef("HEAD~2"), true);
}

// ── Group F: plumbing & cwd (seam-asserted) ─────────────────────────────────
function makeCtx(captured) {
	return {
		cwd: "/repo",
		hasUI: false, // forces the synchronous executeChildRun → executeChildRunResult path
		ui: { notify() {} },
		// Short-circuit after prepareAgentTask so we don't run a real child; the seam capture already happened.
		agentsChildRunner: async () => { throw new Error("stop-after-prepare"); },
	};
}
async function withSeam(fn) {
	const orig = __prepareTaskSeam.fn;
	const captured = {};
	__prepareTaskSeam.fn = async (agent, task, opts) => { captured.agent = agent; captured.task = task; captured.opts = opts; return { task, bundlePath: null, providers: [], dispose: async () => {} }; };
	try { await fn(captured); } finally { __prepareTaskSeam.fn = orig; }
}
async function F1_target_reaches_prepare() {
	await withSeam(async (captured) => {
		await dispatchChildRun("reviewer", "do it", makeCtx(), "built-in", undefined, undefined, { kind: "range", spec: "a..b" });
		assert.deepEqual(captured.opts.reviewTarget, { kind: "range", spec: "a..b" }, "reviewTarget threads dispatch → prepareAgentTask");
		assert.equal(captured.opts.cwd, "/repo");
	});
}
async function F5_gate_five_positional_no_target() {
	await withSeam(async (captured) => {
		// The NL gate calls dispatchChildRun with exactly 5 positionals (agent, task, ctx, source, profile).
		await dispatchChildRun("reviewer", "do it", makeCtx(), "built-in", undefined);
		assert.equal(captured.opts.reviewTarget, undefined, "gate's 5-arg call threads no review target (and does not crash)");
	});
}
async function F1b_no_target_forwards_undefined() {
	await withSeam(async (captured) => {
		await dispatchChildRun("reviewer", "do it", makeCtx(), "built-in", "myprofile", 5000);
		assert.equal(captured.opts.reviewTarget, undefined, "profile+timeout but no target → undefined, never a stale target");
	});
}

async function main() {
	D1_base_repeat();
	D2_range_repeat();
	D3_literal_dashdash();
	D4_both_flags_range_wins();
	D6_missing_value();
	await D7_base_contains_dotdot();
	D8_do_rejects_flags();
	D9_do_range_is_text();
	await D5_both_flags_invalid_range();
	A11_spaced_range_warns();
	E1_weird_valid_refs();
	await F1_target_reaches_prepare();
	await F5_gate_five_positional_no_target();
	await F1b_no_target_forwards_undefined();
	console.log("OK: 14/14 tests passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
