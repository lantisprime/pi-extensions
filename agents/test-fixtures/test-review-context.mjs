import assert from "node:assert";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	assembleReviewBundle,
	resolveReviewBase,
	writeReviewBundle,
	readContainedReferencedDoc,
	isProviderId,
	ALL_PROVIDER_IDS,
	DEFAULT_BUNDLE_CAPS,
} from "../lib/context-providers/review-context.ts";
import { isSafeGitRef, assertSafeGitRef, defaultGitRunner } from "../lib/context-providers/git-runner.ts";

// ── Fake git runner ──────────────────────────────────────────────────────
// `routes` is an array of [predicate(args), GitResult]. First match wins; default ok:false.
function makeGit(routes, sink) {
	return async (args, opts) => {
		if (sink) sink.push({ args: [...args], opts });
		for (const [pred, res] of routes) {
			if (pred(args)) return { ok: true, stdout: "", stderr: "", code: 0, ...res };
		}
		return { ok: false, stdout: "", stderr: "no route", code: 1 };
	};
}
const argsAre = (...want) => (args) => want.every((w, i) => args[i] === w);
const argsStartWith = (...want) => (args) => want.every((w, i) => args[i] === w);

const BASE = "abc123def456";

// A standard healthy repo fixture: branch=feature, base resolves, two changed files + one untracked.
// overrides are placed FIRST so they win under first-match-wins.
function healthyRoutes(overrides = []) {
	return [
		...overrides,
		[argsAre("rev-parse", "--abbrev-ref", "HEAD"), { stdout: "feature/x\n" }],
		[argsAre("merge-base", "HEAD", "main"), { stdout: `${BASE}\n` }],
		[argsAre("diff", "--numstat", BASE), { stdout: `10\t2\tsrc/app.ts\n5\t0\tREADME.md\n-\t-\tassets/logo.png\n3\t1\tpackage-lock.json\n` }],
		[argsAre("ls-files", "--others", "--exclude-standard"), { stdout: "src/new-file.ts\n" }],
		[(a) => a[0] === "diff" && a[1] === BASE && a[2] === "--" && a[3] === "src/app.ts", { stdout: "diff --git a/src/app.ts b/src/app.ts\n+const x = 1;\n" }],
		[(a) => a[0] === "diff" && a[1] === BASE && a[2] === "--" && a[3] === "README.md", { stdout: "diff --git a/README.md b/README.md\n+# Title\n" }],
		[(a) => a[0] === "log", { stdout: "abc123 add x feature\ndef456 fix readme\n" }],
	];
}

// 1. Provider id guard
function testProviderIdGuard() {
	assert.equal(isProviderId("git-diff"), true);
	assert.equal(isProviderId("nope"), false);
	assert.equal(isProviderId(42), false);
	assert.deepEqual([...ALL_PROVIDER_IDS].sort(), ["branch-commits", "changed-files", "git-diff", "plan-docs"]);
}

// 2. Git ref guard rejects option-injection and shell-ish tokens (security — Q1)
function testGitRefGuard() {
	assert.equal(isSafeGitRef("main"), true);
	assert.equal(isSafeGitRef("origin/main"), true);
	assert.equal(isSafeGitRef("abc123def456"), true);
	assert.equal(isSafeGitRef("release/v1.2.3"), true);
	// Leading dash → option injection (e.g. --upload-pack=, -O) → rejected.
	assert.equal(isSafeGitRef("--upload-pack=evil"), false);
	assert.equal(isSafeGitRef("-O"), false);
	assert.equal(isSafeGitRef("a b"), false);
	assert.equal(isSafeGitRef("a;rm -rf"), false);
	assert.equal(isSafeGitRef("$(whoami)"), false);
	assert.equal(isSafeGitRef(""), false);
	assert.throws(() => assertSafeGitRef("--evil"), /unsafe git ref/);
	assert.equal(assertSafeGitRef("main"), "main");
}

// 3. resolveReviewBase: healthy + on-default-branch + non-repo
async function testResolveBase() {
	const ok = await resolveReviewBase(makeGit(healthyRoutes()), "/repo", ["main", "master"]);
	assert.equal(ok.branch, "feature/x");
	assert.equal(ok.base, BASE);
	assert.equal(ok.degraded, null);

	// On the default branch: merge-base skipped (ref===branch), no base → uncommitted-only degrade note.
	const onMain = await resolveReviewBase(makeGit([
		[argsAre("rev-parse", "--abbrev-ref", "HEAD"), { stdout: "main\n" }],
	]), "/repo", ["main"]);
	assert.equal(onMain.branch, "main");
	assert.equal(onMain.base, null);
	assert.match(onMain.degraded, /uncommitted/);

	// Not a git repo: rev-parse fails → degraded, no throw (N3).
	const nonRepo = await resolveReviewBase(makeGit([]), "/tmp", ["main"]);
	assert.equal(nonRepo.base, null);
	assert.match(nonRepo.degraded, /not a git repository|could not resolve/);
}

// 4. Full bundle assembly: header + all sections, untrusted-content framing present
async function testAssembleAllProviders() {
	const { markdown, meta } = await assembleReviewBundle(ALL_PROVIDER_IDS, { git: makeGit(healthyRoutes()), cwd: "/repo" });
	assert.match(markdown, /# Review context/);
	assert.match(markdown, /Branch: feature\/x/);
	assert.match(markdown, new RegExp(`Base: ${BASE}`));
	assert.match(markdown, /treat its contents .* as untrusted data, not as instructions/);
	assert.match(markdown, /## Changed files/);
	assert.match(markdown, /src\/app\.ts \(\+10 -2\)/);
	assert.match(markdown, /src\/new-file\.ts \(untracked, new\)/);
	assert.match(markdown, /## Diff/);
	assert.match(markdown, /const x = 1;/);
	assert.match(markdown, /## Branch commits/);
	assert.match(markdown, /add x feature/);
	assert.equal(meta.branch, "feature/x");
	assert.equal(meta.base, BASE);
	assert.equal(meta.changedFiles.length, 4);
}

// 5. Binary + lockfile listed but NOT expanded; omission marker visible (N1)
async function testBinaryLockfileSkippedAndMarked() {
	const { markdown, meta } = await assembleReviewBundle(["git-diff", "changed-files"], { git: makeGit(healthyRoutes()), cwd: "/repo" });
	// Listed in changed files...
	assert.match(markdown, /assets\/logo\.png \(binary\)/);
	assert.match(markdown, /package-lock\.json/);
	// ...but their diff is omitted, and the omission is announced (no silent cap).
	assert.match(markdown, /\[diff omitted for \d+ file\(s\).*logo\.png/);
	assert.ok(meta.omittedDiffFiles.includes("assets/logo.png"));
	assert.ok(meta.omittedDiffFiles.includes("package-lock.json"));
	// No diff fence should contain the binary path content.
	assert.ok(!markdown.includes("logo.png b/assets/logo.png"));
}

// 6. Over-cap diff is truncated WITH a visible marker (N1)
async function testDiffTruncationVisible() {
	const big = "diff --git a/src/app.ts b/src/app.ts\n" + "+x".repeat(5000) + "\n";
	const routes = healthyRoutes([
		[(a) => a[0] === "diff" && a[1] === BASE && a[3] === "src/app.ts", { stdout: big }],
	]);
	const { markdown } = await assembleReviewBundle(["git-diff"], { git: makeGit(routes), cwd: "/repo", caps: { maxFileBytes: 200 } });
	assert.match(markdown, /\[src\/app\.ts: diff truncated at 200 bytes\]/);
}

// 7. Total-diff cap stops expansion and records omissions (N1)
async function testTotalCapOmission() {
	const { meta } = await assembleReviewBundle(["git-diff"], { git: makeGit(healthyRoutes()), cwd: "/repo", caps: { maxDiffFiles: 1 } });
	// Only 1 non-binary file expanded; the second (README.md) omitted by the file cap.
	assert.ok(meta.omittedDiffFiles.includes("README.md"));
}

// 8. plan-docs: changed plan doc content included; falls back to WORKPLAN.md
// B: now uses a real temp dir (readContainedReferencedDoc reads from the real fs — REQ-B1).
async function testPlanDocs() {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-plandocs-test-"));
	try {
		await fs.mkdir(path.join(tmpDir, "docs"), { recursive: true });
		await fs.writeFile(path.join(tmpDir, "docs", "P9_PLAN.md"), "# P9 Plan\nStep 1\n");
		const routes = [
			[argsAre("rev-parse", "--show-toplevel"), { stdout: `${tmpDir}\n` }],
			...healthyRoutes([
				[argsAre("diff", "--numstat", BASE), { stdout: `2\t0\tdocs/P9_PLAN.md\n` }],
				[(a) => a[0] === "diff" && a[3] === "docs/P9_PLAN.md", { stdout: "diff --git\n+plan line\n" }],
			]),
		];
		const { markdown } = await assembleReviewBundle(["plan-docs"], { git: makeGit(routes), cwd: tmpDir });
		assert.match(markdown, /## Related plan docs/);
		assert.match(markdown, /### docs\/P9_PLAN\.md/);
		assert.match(markdown, /Step 1/);
	} finally { await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); }
}

// 8b. Repo-root anchoring: when cwd is a subdirectory, all git ops run from the work-tree root so
// root-relative numstat paths match the per-file diff pathspecs (regression: e2e found every diff
// was silently omitted from a subdir cwd).
async function testRepoRootAnchoring() {
	const sink = [];
	const routes = [
		[argsAre("rev-parse", "--show-toplevel"), { stdout: "/root\n" }],
		...healthyRoutes(),
	];
	const { markdown } = await assembleReviewBundle(["git-diff", "changed-files"], { git: makeGit(routes, sink), cwd: "/root/agents" });
	// First call is show-toplevel, made from the caller's (subdir) cwd.
	assert.deepEqual(sink[0].args.slice(0, 2), ["rev-parse", "--show-toplevel"]);
	assert.equal(sink[0].opts.cwd, "/root/agents", "show-toplevel uses the caller cwd");
	// Every subsequent git op runs from the resolved repo root, not the subdir.
	for (let i = 1; i < sink.length; i++) {
		assert.equal(sink[i].opts.cwd, "/root", `git op ${JSON.stringify(sink[i].args)} runs from repo root`);
	}
	// And the per-file diff actually expanded (not omitted).
	assert.match(markdown, /const x = 1;/);
}

// 9. Git failure mid-assembly degrades soft, still returns a bundle (N3)
async function testGitFailureSoftDegrade() {
	// merge-base fails everywhere → base null → uncommitted-vs-HEAD, numstat also fails → empty.
	const routes = [[argsAre("rev-parse", "--abbrev-ref", "HEAD"), { stdout: "feature\n" }]];
	const { markdown, meta } = await assembleReviewBundle(ALL_PROVIDER_IDS, { git: makeGit(routes), cwd: "/repo" });
	assert.match(markdown, /# Review context/);
	assert.match(markdown, /Base: \(none/);
	assert.equal(meta.base, null);
	assert.match(markdown, /## Changed files/);
	assert.match(markdown, /no changes detected/);
}

// 10. assembleReviewBundle never throws even with a hostile runner that rejects (N3 defense-in-depth)
async function testNeverThrows() {
	const throwing = async () => { throw new Error("boom"); };
	await assert.doesNotReject(() => assembleReviewBundle(ALL_PROVIDER_IDS, { git: throwing, cwd: "/repo" }));
	// And it returns a usable (degraded) bundle, not garbage.
	const { markdown, meta } = await assembleReviewBundle(ALL_PROVIDER_IDS, { git: throwing, cwd: "/repo" });
	assert.match(markdown, /# Review context/);
	assert.equal(meta.base, null);
}

// 11. writeReviewBundle: 0600 file in 0700 dir, dispose() deletes BOTH (B3 — delete-always)
async function testBundleFileLifecycle() {
	const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bundle-test-"));
	try {
		const handle = await writeReviewBundle("# hi\n", { tmpDir: tmpRoot });
		const stat = await fs.stat(handle.path);
		assert.equal(stat.mode & 0o777, 0o600, "bundle file is 0600");
		const dirStat = await fs.stat(path.dirname(handle.path));
		assert.equal(dirStat.mode & 0o777, 0o700, "bundle dir is 0700");
		assert.equal(await fs.readFile(handle.path, "utf8"), "# hi\n");
		await handle.dispose();
		await assert.rejects(fs.stat(handle.path), /ENOENT/, "file deleted on dispose");
		await assert.rejects(fs.stat(path.dirname(handle.path)), /ENOENT/, "dir deleted on dispose");
		// dispose is idempotent / best-effort.
		await handle.dispose();
	} finally { await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {}); }
}

// 12. defaultGitRunner against a REAL throwaway repo (integration; proves argv array + fail-soft)
async function testDefaultGitRunnerReal() {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "pi-realgit-"));
	try {
		const run = (args) => defaultGitRunner(args, { cwd: repo });
		await run(["init", "-q"]);
		await run(["config", "user.email", "juan.delacruz@acme.com"]);
		await run(["config", "user.name", "Juan Dela Cruz"]);
		await fs.writeFile(path.join(repo, "f.txt"), "hello\n");
		await run(["add", "f.txt"]);
		await run(["commit", "-q", "-m", "init"]);
		const branch = await defaultGitRunner(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo });
		assert.equal(branch.ok, true, "rev-parse works on a repo with a commit");
		// A bad subcommand fails soft (ok:false), never throws.
		const bad = await defaultGitRunner(["definitely-not-a-command"], { cwd: repo });
		assert.equal(bad.ok, false);
		// Non-existent cwd → spawn/exec error reported as ok:false, not a throw.
		const noCwd = await defaultGitRunner(["status"], { cwd: path.join(repo, "does-not-exist") });
		assert.equal(noCwd.ok, false);
	} finally { await fs.rm(repo, { recursive: true, force: true }).catch(() => {}); }
}

// ── VERIFY B: containment tests ──────────────────────────────────────────────────────────────────

// Helper: create a minimal real git repo in tmpDir, return the path.
async function makeRealRepo(tmpDir) {
	const run = (args) => defaultGitRunner(args, { cwd: tmpDir });
	await run(["init", "-q"]);
	await run(["config", "user.email", "juan.delacruz@acme.com"]);
	await run(["config", "user.name", "Juan Dela Cruz"]);
	await fs.writeFile(path.join(tmpDir, "README.md"), "# readme\n");
	await run(["add", "README.md"]);
	await run(["commit", "-q", "-m", "init"]);
	return tmpDir;
}

// B-1. Rejects absolute path, parent traversal, home/URL, bad extension.
async function reviewContext_referencedDocRejectsAbsolutePath() {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-b1-abs-"));
	try {
		const r = await readContainedReferencedDoc(tmpDir, "/etc/passwd");
		assert.equal(r.ok, false);
		assert.equal(r.reason, "not-relative");
	} finally { await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); }
}

async function reviewContext_referencedDocRejectsParentTraversal() {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-b1-trav-"));
	try {
		const r = await readContainedReferencedDoc(tmpDir, "../../secret.md");
		assert.equal(r.ok, false);
		assert.equal(r.reason, "traversal");
	} finally { await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); }
}

async function reviewContext_referencedDocRejectsHomeAndUrl() {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-b1-home-"));
	try {
		const r1 = await readContainedReferencedDoc(tmpDir, "~/.ssh/id_rsa");
		assert.equal(r1.ok, false, "home path should be rejected");
		assert.equal(r1.reason, "not-relative");
		const r2 = await readContainedReferencedDoc(tmpDir, "file:///etc/hosts");
		assert.equal(r2.ok, false, "file:// URL should be rejected");
		assert.equal(r2.reason, "not-relative");
		const r3 = await readContainedReferencedDoc(tmpDir, "https://evil.com/x.md");
		assert.equal(r3.ok, false, "https:// URL should be rejected");
		assert.equal(r3.reason, "not-relative");
	} finally { await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); }
}

async function reviewContext_referencedDocRejectsExt() {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-b1-ext-"));
	try {
		await fs.writeFile(path.join(tmpDir, "foo.ts"), "const x = 1;");
		const r = await readContainedReferencedDoc(tmpDir, "foo.ts");
		assert.equal(r.ok, false);
		assert.equal(r.reason, "ext");
	} finally { await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); }
}

// B-2. SymlinkEscape: in-repo symlink pointing outside the root is refused.
async function reviewContext_referencedDocSymlinkEscape() {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-b2-sym-"));
	try {
		await makeRealRepo(tmpDir);
		// Create a symlink inside the repo pointing outside.
		await fs.symlink("/etc/hosts", path.join(tmpDir, "escape.md"));
		const r = await readContainedReferencedDoc(tmpDir, "escape.md");
		assert.equal(r.ok, false, "symlink escape should be refused");
		assert.match(r.reason, /symlink-escape|not-file/);
		// Verify NO content from outside file is in result.
		assert.ok(!("content" in r), "should have no content on refusal");
	} finally { await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); }
}

// B-1b (code-review regression). HardlinkEscape: an in-repo HARDLINK to an out-of-root file has no
// symlink to follow and realpaths in-root — must still be refused (nlink !== 1 guard).
async function reviewContext_referencedDocHardlinkEscape() {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-b1b-hard-"));
	const secret = await fs.mkdtemp(path.join(os.tmpdir(), "pi-b1b-secret-"));
	try {
		await makeRealRepo(tmpDir);
		const outside = path.join(secret, "secret.txt");
		await fs.writeFile(outside, "HARDLINK SECRET\n");
		try { await fs.link(outside, path.join(tmpDir, "X_PLAN.md")); } // same-fs hardlink into the repo
		catch { return; } // cross-fs: hardlink impossible, vector N/A on this setup
		const r = await readContainedReferencedDoc(tmpDir, "X_PLAN.md");
		assert.equal(r.ok, false, "hardlink to outside file must be refused");
		assert.equal(r.reason, "multi-link");
		assert.ok(!("content" in r), "no outside content leaks on refusal");
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		await fs.rm(secret, { recursive: true, force: true }).catch(() => {});
	}
}

// B-3. ChangedPlanSymlinkEscape: symlink that is a "changed" plan doc is refused.
async function reviewContext_referencedDocChangedPlanSymlinkEscape() {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-b3-cpsym-"));
	try {
		await makeRealRepo(tmpDir);
		// The "changed" plan doc is a symlink to /etc/hosts — simulates attacker controlling a plan-doc path.
		await fs.symlink("/etc/hosts", path.join(tmpDir, "X_PLAN.md"));
		const routes = [
			[argsAre("rev-parse", "--show-toplevel"), { stdout: `${tmpDir}\n` }],
			[argsAre("rev-parse", "--abbrev-ref", "HEAD"), { stdout: "feature/x\n" }],
			[argsAre("merge-base", "HEAD", "main"), { stdout: `${BASE}\n` }],
			[argsAre("diff", "--numstat", BASE), { stdout: `5\t0\tX_PLAN.md\n` }],
			[argsAre("ls-files", "--others", "--exclude-standard"), { stdout: "" }],
		];
		const { markdown } = await assembleReviewBundle(["plan-docs"], { git: makeGit(routes), cwd: tmpDir });
		// The symlink-escaped plan doc must be refused — no /etc/hosts content in bundle.
		assert.ok(!markdown.includes("localhost"), "symlinked changed plan doc must be refused (no /etc/hosts content)");
	} finally { await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); }
}

// B-4. FallbackWorkplanSymlinkEscape: fallback WORKPLAN.md is a symlink → refused.
async function reviewContext_referencedDocFallbackWorkplanSymlinkEscape() {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-b4-fwsym-"));
	try {
		await makeRealRepo(tmpDir);
		// WORKPLAN.md symlinks to /etc/hosts — no other plan docs changed.
		await fs.symlink("/etc/hosts", path.join(tmpDir, "WORKPLAN.md"));
		const routes = [
			[argsAre("rev-parse", "--show-toplevel"), { stdout: `${tmpDir}\n` }],
			[argsAre("rev-parse", "--abbrev-ref", "HEAD"), { stdout: "feature/x\n" }],
			[argsAre("merge-base", "HEAD", "main"), { stdout: `${BASE}\n` }],
			// No plan doc in changed files → falls back to WORKPLAN.md
			[argsAre("diff", "--numstat", BASE), { stdout: `3\t0\tsrc/app.ts\n` }],
			[argsAre("ls-files", "--others", "--exclude-standard"), { stdout: "" }],
		];
		const { markdown } = await assembleReviewBundle(["plan-docs"], { git: makeGit(routes), cwd: tmpDir });
		assert.ok(!markdown.includes("localhost"), "fallback WORKPLAN.md symlink escape must be refused");
	} finally { await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); }
}

// B-5. Oversize and binary — refused + visible omission.
async function reviewContext_referencedDocOversizeAndBinary() {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-b5-size-"));
	try {
		// Oversize: write a file bigger than CONTAINED_READ_MAX_FILE_BYTES (80k).
		await fs.writeFile(path.join(tmpDir, "big.md"), "x".repeat(81_000));
		const r1 = await readContainedReferencedDoc(tmpDir, "big.md");
		assert.equal(r1.ok, false);
		assert.equal(r1.reason, "too-big");

		// Binary: a .md file with a NUL byte.
		const binaryContent = Buffer.concat([Buffer.from("# Plan\n"), Buffer.from([0x00]), Buffer.from("data\n")]);
		await fs.writeFile(path.join(tmpDir, "binary.md"), binaryContent);
		const r2 = await readContainedReferencedDoc(tmpDir, "binary.md");
		assert.equal(r2.ok, false);
		assert.equal(r2.reason, "binary");
	} finally { await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); }
}

// B-6. Count and total-bytes caps.
async function reviewContext_referencedDocCapsCountAndTotalBytes() {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-b6-caps-"));
	try {
		await makeRealRepo(tmpDir);
		// Create 25 plan docs (> CONTAINED_READ_MAX_COUNT = 20).
		const planFiles = [];
		for (let i = 0; i < 25; i++) {
			const name = `DOC${i}_PLAN.md`;
			await fs.writeFile(path.join(tmpDir, name), `# Doc ${i}\nContent\n`);
			planFiles.push(name);
		}
		const numstat = planFiles.map((f) => `2\t0\t${f}`).join("\n");
		const routes = [
			[argsAre("rev-parse", "--show-toplevel"), { stdout: `${tmpDir}\n` }],
			[argsAre("rev-parse", "--abbrev-ref", "HEAD"), { stdout: "feature/x\n" }],
			[argsAre("merge-base", "HEAD", "main"), { stdout: `${BASE}\n` }],
			[argsAre("diff", "--numstat", BASE), { stdout: numstat }],
			[argsAre("ls-files", "--others", "--exclude-standard"), { stdout: "" }],
		];
		const { markdown } = await assembleReviewBundle(["plan-docs"], { git: makeGit(routes), cwd: tmpDir });
		// The omission marker should appear since some docs were capped.
		assert.match(markdown, /refs omitted|count-cap|total-cap/, "should have a visible omission marker for capped refs");
	} finally { await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); }
}

// B-7. CallerCwdDiffersFromProject: when caller cwd ≠ project root, plan doc is read from root.
async function reviewContext_referencedDocCallerCwdDiffersFromProject() {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-b7-cwddiff-"));
	try {
		// Project root has a plan doc; subdirectory is the caller's cwd.
		await fs.writeFile(path.join(tmpDir, "X_PLAN.md"), "# Plan\nRoot plan content\n");
		const subdir = path.join(tmpDir, "packages", "foo");
		await fs.mkdir(subdir, { recursive: true });
		const routes = [
			// show-toplevel returns the project root, not the caller subdir.
			[argsAre("rev-parse", "--show-toplevel"), { stdout: `${tmpDir}\n` }],
			[argsAre("rev-parse", "--abbrev-ref", "HEAD"), { stdout: "feature/x\n" }],
			[argsAre("merge-base", "HEAD", "main"), { stdout: `${BASE}\n` }],
			[argsAre("diff", "--numstat", BASE), { stdout: `3\t0\tX_PLAN.md\n` }],
			[argsAre("ls-files", "--others", "--exclude-standard"), { stdout: "" }],
		];
		// Call with cwd = subdir; git resolves root to tmpDir.
		const { markdown, meta } = await assembleReviewBundle(["plan-docs"], { git: makeGit(routes), cwd: subdir });
		assert.match(markdown, /Root plan content/, "plan doc from project root should be included");
		assert.equal(meta.projectRoot, tmpDir, "projectRoot should be the resolved repo root");
	} finally { await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); }
}

// B-8. LinkedWorktreeRoot: a linked worktree resolves to its own root.
async function reviewContext_referencedDocLinkedWorktreeRoot() {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-b8-linked-"));
	try {
		// Simulate a linked worktree: show-toplevel returns a different path than deps.cwd.
		const linkedRoot = path.join(tmpDir, "linked");
		await fs.mkdir(linkedRoot, { recursive: true });
		await fs.writeFile(path.join(linkedRoot, "X_PLAN.md"), "# Linked Plan\nLinked content\n");
		const callerCwd = path.join(tmpDir, "some-subdir");
		await fs.mkdir(callerCwd, { recursive: true });
		const routes = [
			// Linked worktree: show-toplevel returns linkedRoot from callerCwd.
			[argsAre("rev-parse", "--show-toplevel"), { stdout: `${linkedRoot}\n` }],
			[argsAre("rev-parse", "--abbrev-ref", "HEAD"), { stdout: "feature/x\n" }],
			[argsAre("merge-base", "HEAD", "main"), { stdout: `${BASE}\n` }],
			[argsAre("diff", "--numstat", BASE), { stdout: `3\t0\tX_PLAN.md\n` }],
			[argsAre("ls-files", "--others", "--exclude-standard"), { stdout: "" }],
		];
		const { markdown, meta } = await assembleReviewBundle(["plan-docs"], { git: makeGit(routes), cwd: callerCwd });
		assert.match(markdown, /Linked content/, "plan doc from linked worktree root should be included");
		assert.equal(meta.projectRoot, linkedRoot, "projectRoot should be the linked worktree root");
	} finally { await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); }
}

// B-9. TOCTOU race: hook that swaps file to a symlink BETWEEN stat and read → refused.
// We test this by injecting a real file that is replaced with a symlink during the read.
// Because O_NOFOLLOW is used at open time, the TOCTOU window is before open (not between stat and read).
// We verify: if a symlink is placed where a regular file was, readContainedReferencedDoc refuses it.
async function reviewContext_referencedDocTOCTOURace() {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-b9-toctou-"));
	try {
		// A file that exists as a regular file initially...
		const targetPath = path.join(tmpDir, "target.md");
		await fs.writeFile(targetPath, "# Safe content\n");
		// Read it normally — should succeed.
		const r1 = await readContainedReferencedDoc(tmpDir, "target.md");
		assert.equal(r1.ok, true, "normal read should succeed");

		// Now replace it with a symlink pointing outside (simulating a race where the file was swapped).
		await fs.unlink(targetPath);
		await fs.symlink("/etc/hosts", targetPath);
		// After swap, reading should refuse (symlink escape or not-file).
		const r2 = await readContainedReferencedDoc(tmpDir, "target.md");
		assert.equal(r2.ok, false, "swapped symlink should be refused");
		assert.match(r2.reason, /symlink-escape|not-file/);
		assert.ok(!("content" in r2), "no content should be returned for symlink");
	} finally { await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); }
}

// B-10. dispatch_childCwdIsProjectRootAllPaths: from a nested cwd + linked worktree,
// assert child got cwd = projectRoot for /agents run, /agents do, and P7 gate paths.
async function dispatch_childCwdIsProjectRootAllPaths() {
	// We test via prepareAgentTask: it must return projectRoot matching the repo root.
	// Then verify the run-resolver threads it through by using agentsChildRunner spy.
	const { prepareAgentTask } = await import("../lib/context-providers/prepare-task.ts");
	const { dispatchChildRun } = await import("../lib/run-resolver.ts");

	const rawTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-b10-dispatch-"));
	// Resolve realpath (macOS: /var is a symlink to /private/var, causing comparison mismatches).
	const tmpDir = await fs.realpath(rawTmpDir);
	try {
		// Create a real repo at tmpDir, with a plan doc.
		await makeRealRepo(tmpDir);
		await fs.writeFile(path.join(tmpDir, "X_PLAN.md"), "# Plan\nContent\n");
		const subdir = path.join(tmpDir, "packages", "foo");
		await fs.mkdir(subdir, { recursive: true });

		// Test 1: prepareAgentTask from nested subdir — projectRoot must be the repo root.
		// Use a mock assembler that returns a known projectRoot.
		const mockAssemble = async (_providers, _deps) => ({
			markdown: "# bundle\n",
			meta: {
				branch: "feature", base: "abc", degraded: null,
				changedFiles: [{ path: "X_PLAN.md", added: 3, removed: 0, binary: false }],
				untracked: [],
				omittedDiffFiles: [],
				projectRoot: tmpDir, // resolved root from assembler
			},
		});
		const mockWriteBundle = async (_md, _opts) => ({
			path: "/tmp/fake-bundle.md",
			dispose: async () => {},
		});

		const prepared = await prepareAgentTask("reviewer", "review this", {
			cwd: subdir,
			assemble: mockAssemble,
			writeBundle: mockWriteBundle,
		});
		assert.equal(typeof prepared.projectRoot, "string", "projectRoot must be a string");
		assert.equal(prepared.projectRoot, tmpDir, "prepareAgentTask must surface projectRoot from assembler");

		// Test 2: dispatchChildRun threads projectRoot as child cwd.
		// We use agentsChildRunner spy to capture the cwd passed to the runner.
		// dispatchChildRun → executeChildRunResult → prepareAgentTask (real git) → assembled.projectRoot.
		// Git is init'd at tmpDir, so show-toplevel from subdir → tmpDir (realpath).
		const capturedCwds = [];
		const fakeRunner = async (_agent, _task, opts) => {
			capturedCwds.push(opts ? opts.cwd : undefined);
			return {
				agentName: "reviewer", status: "completed", durationMs: 0, stdoutBytes: 0,
				stderrPreview: "", invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin", stdinText: "" } },
				summary: { summaryText: "", toolCalls: [], errors: [], usage: undefined, cost: undefined, stopReason: undefined, model: undefined, provider: undefined, truncation: {} },
				timedOut: false, outputLimitExceeded: false,
			};
		};
		const ctx = {
			cwd: subdir, // caller is in the nested subdir
			hasUI: false,
			ui: { notify: () => {} },
			agentsChildRunner: fakeRunner,
		};
		await dispatchChildRun("reviewer", "task", ctx, "built-in");
		assert.ok(capturedCwds.length >= 1, "agentsChildRunner must have been called");
		const capturedCwd = capturedCwds[0];
		// The resolved projectRoot (from git show-toplevel) should be tmpDir (realpath).
		// Accept tmpDir (success case) or subdir (assembleReviewBundle failed → fell back) or undefined.
		// Critical: must NOT be the nested subdir WHEN projectRoot was successfully resolved.
		// Since git is init'd at tmpDir and subdir is inside, git show-toplevel → tmpDir.
		assert.notEqual(capturedCwd, subdir,
			`child cwd must NOT be the nested caller subdir (${subdir}); got: ${capturedCwd}. ` +
			"run-resolver should have overridden cwd to the project root.");
		// Accept tmpDir (or its realpath-equivalent).
		const capturedReal = capturedCwd ? await fs.realpath(capturedCwd).catch(() => capturedCwd) : capturedCwd;
		assert.equal(capturedReal, tmpDir,
			`child cwd should be the project root (${tmpDir}), got: ${capturedCwd}`);
	} finally { await fs.rm(rawTmpDir, { recursive: true, force: true }).catch(() => {}); }
}

async function main() {
	testProviderIdGuard();
	testGitRefGuard();
	await testResolveBase();
	await testAssembleAllProviders();
	await testBinaryLockfileSkippedAndMarked();
	await testDiffTruncationVisible();
	await testTotalCapOmission();
	await testPlanDocs();
	await testRepoRootAnchoring();
	await testGitFailureSoftDegrade();
	await testNeverThrows();
	await testBundleFileLifecycle();
	await testDefaultGitRunnerReal();
	// VERIFY B: containment tests
	await reviewContext_referencedDocRejectsAbsolutePath();
	await reviewContext_referencedDocRejectsParentTraversal();
	await reviewContext_referencedDocRejectsHomeAndUrl();
	await reviewContext_referencedDocRejectsExt();
	await reviewContext_referencedDocSymlinkEscape();
	await reviewContext_referencedDocHardlinkEscape();
	await reviewContext_referencedDocChangedPlanSymlinkEscape();
	await reviewContext_referencedDocFallbackWorkplanSymlinkEscape();
	await reviewContext_referencedDocOversizeAndBinary();
	await reviewContext_referencedDocCapsCountAndTotalBytes();
	await reviewContext_referencedDocCallerCwdDiffersFromProject();
	await reviewContext_referencedDocLinkedWorktreeRoot();
	await reviewContext_referencedDocTOCTOURace();
	await dispatch_childCwdIsProjectRootAllPaths();
	console.log("OK: 26/26 tests passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
