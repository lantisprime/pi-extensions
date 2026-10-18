// Pure-function tests: globbing, steering budgets, bash mutation detection,
// gate decisions, state round-trip, contract normalization.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isDocsOnly, matchGlob } from "../lib/glob.ts";
import {
	deltaLine,
	gateReason,
	MAX_DELTA_BYTES,
	MAX_REASON_BYTES,
	MAX_STANDING_BYTES,
	STANDING_LINE,
	standingLine,
} from "../lib/steering.ts";
import { findProtectedMutation, isProtectedPath } from "../lib/bash.ts";
import { evaluateCommitGate, gitSubcommand, isCommitLikeCommand } from "../lib/gate.ts";
import { hashChangedFiles, parsePorcelain } from "../lib/git.ts";
import { commandRunsTest } from "../index.ts";
import { emptyState, loadState, recordGreen, saveState } from "../lib/state.ts";
import { normalizeContract } from "../lib/contract.ts";
import { DEFAULT_PROTECTED_PATHS } from "../lib/types.ts";
import { acceptDecision, buildDrafts, draftScanText, mergeContracts, redactCommand } from "../../scripts/workflow-derive.mjs";

const CWD = "/repo";

test("glob: package prefix and docs patterns", () => {
	assert.equal(matchGlob("tasks/**", "tasks/index.ts"), true);
	assert.equal(matchGlob("tasks/**", "tasks"), true);
	assert.equal(matchGlob("tasks/**", "tasks-extra/x.ts"), false);
	assert.equal(matchGlob("**/*.md", "a.md"), true);
	assert.equal(matchGlob("**/*.md", "deep/a.md"), true);
	assert.equal(matchGlob("**/*.md", "a.ts"), false);
	assert.equal(matchGlob("*.json", "package.json"), true);
	assert.equal(matchGlob("*.json", "sub/package.json"), false);
});

test("docs-only detection", () => {
	assert.equal(isDocsOnly(["**/*.md", ".plans/**"], ["README.md", ".plans/X/spec.md"]), true);
	assert.equal(isDocsOnly(["**/*.md", ".plans/**"], ["README.md", "tasks/index.ts"]), false);
	assert.equal(isDocsOnly(["**/*.md"], []), false);
});

test("standing line stays within budget", () => {
	assert.ok(Buffer.byteLength(standingLine(true), "utf8") <= MAX_STANDING_BYTES);
	assert.ok(Buffer.byteLength(standingLine(false), "utf8") <= MAX_STANDING_BYTES);
	assert.equal(standingLine(true), STANDING_LINE);
});

test("delta and gate strings stay bounded with many packages", () => {
	const packages = Array.from({ length: 25 }, (_, index) => ({
		glob: `package-with-a-long-name-${index}/**`,
		test: `bash package-with-a-long-name-${index}/test-fixtures/run-a-very-long-suite-name-${index}.sh`,
	}));
	const delta = deltaLine(packages);
	const reason = gateReason(packages);
	assert.ok(delta !== null);
	assert.ok(Buffer.byteLength(delta, "utf8") <= MAX_DELTA_BYTES);
	assert.ok(Buffer.byteLength(reason, "utf8") <= MAX_REASON_BYTES);
	assert.match(delta, /\(\+24 more\)/);
	assert.match(reason, /\(\+24 more packages\)/);
});

test("bash mutation detection catches writes, ignores reads", () => {
	const cwd = CWD;
	const cases = [
		["sed -i 's/a/b/' AGENTS.md", "AGENTS.md"],
		["perl -pi -e 's/a/b/' MEMORY.md", "MEMORY.md"],
		["echo hi >> .pi/runbooks/x.md", ".pi/runbooks/x.md"],
		["tee .pi/runbooks/x.md", ".pi/runbooks/x.md"],
		["cp /tmp/new .pi/workflow.json", ".pi/workflow.json"],
		["mv AGENTS.md /tmp/AGENTS.md", "AGENTS.md"],
		["git checkout -- AGENTS.md", "AGENTS.md"],
		["rm MEMORY.md", "MEMORY.md"],
		["truncate -s 0 MEMORY.md", "MEMORY.md"],
		["sed --in-place 's/a/b/' AGENTS.md", "AGENTS.md"],
		["git -C . checkout -- AGENTS.md", "AGENTS.md"],
		["unlink MEMORY.md", "MEMORY.md"],
		["find . -name AGENTS.md -delete", "AGENTS.md"],
		["cd sub && sed -i 1d ../AGENTS.md", "AGENTS.md"],
	];
	for (const [command, expected] of cases) {
		assert.equal(findProtectedMutation(command, DEFAULT_PROTECTED_PATHS, cwd), expected, command);
	}
	for (const command of ["cat AGENTS.md", "grep -n x AGENTS.md", "sed -n '1,5p' AGENTS.md", "git diff AGENTS.md", "cp AGENTS.md /tmp/x"]) {
		assert.equal(findProtectedMutation(command, DEFAULT_PROTECTED_PATHS, cwd), null, command);
	}
	assert.equal(isProtectedPath("/repo/.pi/runbooks/a.md", DEFAULT_PROTECTED_PATHS, cwd), true);
	assert.equal(isProtectedPath("/repo/tasks/index.ts", DEFAULT_PROTECTED_PATHS, cwd), false);
});

test("commit-like command detection", () => {
	for (const command of [
		"git commit -m x",
		"git push origin main",
		"gh pr create --fill",
		"cd x && git commit -am x",
		"git -C /repo commit -am x",
		"git -c user.name=x commit -m x",
	]) {
		assert.equal(isCommitLikeCommand(command), true, command);
	}
	for (const command of ["git status", "git diff", "gh pr view", "npm test", "git log --grep=commit", "git log --grep=push"]) {
		assert.equal(isCommitLikeCommand(command), false, command);
	}
	assert.equal(gitSubcommand("git -C /x commit"), "commit");
	assert.equal(gitSubcommand("git log --grep=commit"), "log");
});

test("porcelain -z: spaced paths and renames are parsed without quoting", () => {
	const parsed = parsePorcelain(" M pkg/a.js\0R  pkg/new.js\0pkg/old.js\0?? pkg/a b.js\0");
	assert.deepEqual(parsed.changed, ["pkg/a b.js", "pkg/a.js", "pkg/new.js", "pkg/old.js"]);
	assert.equal(parsed.truncated, false);
});

test("green recognition rejects failure masking and accepts cd-prefixed exact runs", () => {
	assert.equal(commandRunsTest("bash pkg/test.sh", "bash pkg/test.sh"), true);
	assert.equal(commandRunsTest("cd pkg && bash test.sh", "bash test.sh"), true);
	assert.equal(commandRunsTest("bash pkg/test.sh || true", "bash pkg/test.sh"), false);
	assert.equal(commandRunsTest("bash pkg/test.sh; echo ok", "bash pkg/test.sh"), false);
	assert.equal(commandRunsTest("echo bash pkg/test.sh", "bash pkg/test.sh"), false);
});

test("hashChangedFiles handles deletions, symlinks, and content changes", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wg-hash-"));
	try {
		fs.writeFileSync(path.join(dir, "a.txt"), "one", "utf8");
		fs.symlinkSync("a.txt", path.join(dir, "link.txt"));
		const first = await hashChangedFiles(dir, ["a.txt", "link.txt", "deleted.txt"]);
		const second = await hashChangedFiles(dir, ["a.txt", "link.txt", "deleted.txt"]);
		assert.equal(first, second, "hash must be deterministic");
		fs.writeFileSync(path.join(dir, "a.txt"), "two", "utf8");
		const third = await hashChangedFiles(dir, ["a.txt", "link.txt", "deleted.txt"]);
		assert.notEqual(first, third, "content change must change the hash");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

const baseContract = {
	version: 1,
	sources: [],
	packages: [{ glob: "tasks/**", test: "bash tasks/test/run-tests.sh" }],
	docsOnly: ["**/*.md"],
	protectedPaths: DEFAULT_PROTECTED_PATHS,
	gates: { "test-before-commit": { enabled: true } },
};

function gateInput(overrides = {}) {
	return {
		contract: baseContract,
		enforcing: true,
		command: "git commit -m x",
		changed: ["tasks/index.ts"],
		hashes: new Map([["tasks/**", "hash-now"]]),
		green: { "tasks/**": { hash: "hash-now" } },
		...overrides,
	};
}

test("commit gate: blocks when the current hash has no green match", () => {
	const decision = evaluateCommitGate(gateInput({ green: { "tasks/**": { hash: "old-hash" } } }));
	assert.ok(decision);
	assert.equal(decision.block, true);
	assert.match(decision.reason, /bash tasks\/test\/run-tests\.sh/);
});

test("commit gate: allows a matching green run, docs-only, and non-commit commands", () => {
	assert.equal(evaluateCommitGate(gateInput()), null);
	assert.equal(evaluateCommitGate(gateInput({ changed: ["README.md"] })), null);
	assert.equal(evaluateCommitGate(gateInput({ command: "git status" })), null);
	assert.equal(evaluateCommitGate(gateInput({ enforcing: false })), null);
});

test("commit gate: fails closed when a hash cannot be computed", () => {
	const decision = evaluateCommitGate(gateInput({ hashes: new Map([["tasks/**", null]]) }));
	assert.ok(decision);
	assert.equal(decision.block, true);
});

test("state: green records survive a save/load round trip", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "wg-state-"));
	const previous = process.env.HOME;
	process.env.HOME = home;
	try {
		const project = "/tmp/example-project";
		let state = emptyState(project);
		state = recordGreen(state, "tasks/**", "abc", "tasks/index.ts");
		await saveState(state);
		const loaded = await loadState(project);
		assert.equal(loaded.green["tasks/**"]?.hash, "abc");
		assert.equal(loaded.green["tasks/**"]?.changedKey, "tasks/index.ts");
	} finally {
		process.env.HOME = previous;
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("contract: defaults and invalid values are normalized", () => {
	const normalized = normalizeContract({ packages: [{ glob: "a/**", test: "true" }, { glob: "", test: "x" }] });
	assert.ok(normalized);
	assert.equal(normalized.packages.length, 1);
	assert.deepEqual(normalized.docsOnly, ["**/*.md", "docs/**", ".plans/**"]);
	assert.deepEqual(normalized.protectedPaths, DEFAULT_PROTECTED_PATHS);
	assert.equal(normalized.gates["test-before-commit"]?.enabled, true);
	assert.equal(normalizeContract([]), null);
	assert.equal(normalizeContract(null), null);
});

test("derive: redaction and merge preserve operator fields", () => {
	const redacted = redactCommand("GITHUB_TOKEN=ghp_secret bash x --token abc123");
	assert.doesNotMatch(redacted, /ghp_secret/);
	assert.doesNotMatch(redacted, /abc123/);
	assert.match(redacted, /\*\*\*/);

	const generated = { version: 1, packages: [], docsOnly: ["**/*.md"], protectedPaths: ["AGENTS.md"], gates: {}, sources: [] };
	const merged = mergeContracts({ docsOnly: [".plans/**"], protectedPaths: ["MEMORY.md"], gates: { a: { enabled: false } } }, generated);
	assert.deepEqual(merged.docsOnly, [".plans/**"]);
	assert.deepEqual(merged.protectedPaths, ["MEMORY.md"]);
	assert.deepEqual(merged.gates, { a: { enabled: false } });
});

test("derive: one aggregate runbook, triggered on git inspection", () => {
	const drafts = buildDrafts(
		[{ glob: "pkg/**", test: "bash pkg/test.sh", dir: "pkg" }],
		[{ name: "tests", command: "bash pkg/test.sh", source: ".github/workflows/ci.yml:10" }],
		"abc123",
	);
	assert.equal(drafts.length, 1);
	assert.equal(drafts[0].id, "ship-change");
	assert.match(drafts[0].content, /"git status"/);
	assert.match(drafts[0].content, /pkg\/\*\*/);
	assert.match(drafts[0].content, /bash pkg\/test\.sh/);
});

test("derive: scanner input excludes runbook metadata", () => {
	const text = draftScanText("---\nid: x\ntools: [bash]\nsummary: run tests\n---\n\n# body\nrun the suite");
	assert.doesNotMatch(text, /tools:/);
	assert.match(text, /run tests/);
	assert.match(text, /run the suite/);
});

test("negative control: a dirty commit must be blocked", { skip: !process.env.BREAK_GATE }, () => {
	// With BREAK_GATE=1 this assertion MUST fail; CI treats a pass as a broken guard.
	assert.equal(evaluateCommitGate(gateInput({ green: {} })), null, "negative control: gate allowed a dirty commit");
});

test("derive: acceptance is fail-closed on dangerous content", () => {
	assert.equal(acceptDecision("dangerous").ok, false);
	assert.equal(acceptDecision("suspicious").ok, false);
	assert.equal(acceptDecision("suspicious", true).ok, true);
	assert.equal(acceptDecision("safe").ok, true);
});
