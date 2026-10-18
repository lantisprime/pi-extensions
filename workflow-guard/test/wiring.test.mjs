// Wire-level tests: drive the real handler map through a mock ExtensionAPI in a
// throwaway git repo. Unit tests cannot catch state-lifecycle bugs (repo rule:
// "wiring bugs get wiring tests").

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { default: createExtension } = await import("../index.ts");

const TEMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wg-home-"));
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), "wg-repo-"));
process.env.HOME = TEMP_HOME;

const CONTRACT = {
	version: 1,
	sources: ["test"],
	packages: [{ glob: "pkg/**", test: "bash pkg/test.sh" }],
	docsOnly: ["**/*.md"],
	protectedPaths: ["AGENTS.md", "MEMORY.md", ".pi/runbooks/**", ".pi/workflow.json"],
	gates: {
		"protect-instructions": { enabled: true },
		"test-before-commit": { enabled: true },
		"plan-before-pr": { enabled: false },
	},
};

function git(...args) {
	return execFileSync("git", args, { cwd: REPO, encoding: "utf8" });
}

function write(relative, content) {
	const absolute = path.join(REPO, relative);
	fs.mkdirSync(path.dirname(absolute), { recursive: true });
	fs.writeFileSync(absolute, content, "utf8");
}

function commitAll(message) {
	git("add", "-A");
	git("commit", "-q", "-m", message);
}

function mockPi() {
	const handlers = new Map();
	const commands = new Map();
	const pi = {
		on: (event, handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerCommand: (name, options) => commands.set(name, options),
	};
	return { pi, handlers, commands };
}

function mockCtx(confirmAnswer = true, cwd = REPO) {
	const state = { confirms: 0, statuses: [], notices: [] };
	const ctx = {
		cwd,
		hasUI: true,
		isProjectTrusted: () => true,
		ui: {
			setStatus: (_key, value) => state.statuses.push(value),
			notify: (message) => state.notices.push(message),
			confirm: async () => {
				state.confirms += 1;
				return confirmAnswer;
			},
		},
	};
	return { ctx, state };
}

/** Run every handler; a tool_call block wins over later undefined results. */
async function emit(handlers, event, payload, ctx) {
	const results = [];
	for (const handler of handlers.get(event) ?? []) results.push(await handler({ type: event, ...payload }, ctx));
	return results.find((result) => result && result.block) ?? results.find((result) => result !== undefined);
}

async function start(confirmAnswer = true, cwd = REPO) {
	const { pi, handlers, commands } = mockPi();
	createExtension(pi);
	const { ctx, state } = mockCtx(confirmAnswer, cwd);
	await emit(handlers, "session_start", {}, ctx);
	return { handlers, commands, ctx, state };
}

write(".pi/workflow.json", `${JSON.stringify(CONTRACT, null, 2)}\n`);
write(".gitignore", ".pi/workflow-telemetry.jsonl\n");
write("pkg/file.js", "export const value = 1;\n");
write("pkg/test.sh", "exit 0\n");
write("AGENTS.md", "# rules\n");
git("init", "-q");
git("config", "user.email", "test@example.com");
git("config", "user.name", "test");
commitAll("initial");

test("standing line: one bounded append, nothing else while clean", async () => {
	const { handlers } = await start();
	const result = await emit(handlers, "before_agent_start", { systemPrompt: "BASE" }, mockCtx().ctx);
	assert.ok(result.systemPrompt.startsWith("BASE\n\n[workflow]"));
	const added = result.systemPrompt.slice("BASE".length);
	assert.ok(Buffer.byteLength(added, "utf8") <= 182, `added ${Buffer.byteLength(added, "utf8")} bytes`);
	assert.equal(added.includes("tests not green"), false);
});

test("G2: commit blocks without a green run, allows after one, blocks again after a new edit", async () => {
	const { handlers, ctx } = await start();
	const tool = "tool_call";

	write("pkg/file.js", "export const value = 2;\n");
	let result = await emit(handlers, tool, { toolName: "bash", toolCallId: "c1", input: { command: "git commit -m change" } }, ctx);
	assert.ok(result, "commit must be blocked");
	assert.equal(result.block, true);
	assert.match(result.reason, /bash pkg\/test\.sh/);

	await emit(handlers, tool, { toolName: "bash", toolCallId: "t1", input: { command: "bash pkg/test.sh" } }, ctx);
	await emit(handlers, "tool_result", { toolName: "bash", toolCallId: "t1", isError: false }, ctx);
	result = await emit(handlers, tool, { toolName: "bash", toolCallId: "c2", input: { command: "git commit -m change" } }, ctx);
	assert.equal(result, undefined, "commit should pass after green");

	write("pkg/file.js", "export const value = 3;\n");
	result = await emit(handlers, tool, { toolName: "bash", toolCallId: "c3", input: { command: "git commit -m again" } }, ctx);
	assert.ok(result?.block, "a new edit invalidates the green run");
	commitAll("change");
});

test("G1: protected write and bash mutation require confirmation", async () => {
	const denied = await start(false);
	const writeResult = await emit(
		denied.handlers,
		"tool_call",
		{ toolName: "write", toolCallId: "w1", input: { path: "AGENTS.md", content: "x" } },
		denied.ctx,
	);
	assert.ok(writeResult?.block);
	assert.equal(denied.state.confirms, 1);

	const allowed = await start();
	const allowedResult = await emit(
		allowed.handlers,
		"tool_call",
		{ toolName: "write", toolCallId: "w2", input: { path: "AGENTS.md", content: "x" } },
		allowed.ctx,
	);
	assert.equal(allowedResult, undefined);
	assert.equal(allowed.state.confirms, 1);

	const sed = await start(false);
	const sedResult = await emit(
		sed.handlers,
		"tool_call",
		{ toolName: "bash", toolCallId: "b1", input: { command: "sed -i 's/a/b/' AGENTS.md" } },
		sed.ctx,
	);
	assert.ok(sedResult?.block);
	assert.equal(sed.state.confirms, 1);

	const read = await start();
	const readResult = await emit(
		read.handlers,
		"tool_call",
		{ toolName: "bash", toolCallId: "b2", input: { command: "cat AGENTS.md" } },
		read.ctx,
	);
	assert.equal(readResult, undefined);
	assert.equal(read.state.confirms, 0);
});

test("restart: a green record survives a new extension instance", async () => {
	const first = await start();
	await emit(first.handlers, "tool_call", { toolName: "bash", toolCallId: "t2", input: { command: "bash pkg/test.sh" } }, first.ctx);
	await emit(first.handlers, "tool_result", { toolName: "bash", toolCallId: "t2", isError: false }, first.ctx);

	write("pkg/file.js", "export const value = 4;\n");
	const restarted = await start();
	const blocked = await emit(
		restarted.handlers,
		"tool_call",
		{ toolName: "bash", toolCallId: "c4", input: { command: "git commit -m after-restart" } },
		restarted.ctx,
	);
	assert.ok(blocked?.block, "edits after restart must still require tests");
	git("checkout", "--", "pkg/file.js");
});

test("enforcement off and per-action override", async () => {
	const off = await start();
	await off.commands.get("workflow").handler("enforce off", off.ctx);
	write("pkg/file.js", "export const value = 5;\n");
	const allowed = await emit(
		off.handlers,
		"tool_call",
		{ toolName: "bash", toolCallId: "c5", input: { command: "git commit -m off" } },
		off.ctx,
	);
	assert.equal(allowed, undefined);
	commitAll("off");

	const override = await start();
	write("pkg/file.js", "export const value = 6;\n");
	assert.ok(
		(
			await emit(
				override.handlers,
				"tool_call",
				{ toolName: "bash", toolCallId: "c6", input: { command: "git commit -m blocked" } },
				override.ctx,
			)
		)?.block,
	);
	await override.commands.get("workflow").handler("override operator said ship it", override.ctx);
	const after = await emit(
		override.handlers,
		"tool_call",
		{ toolName: "bash", toolCallId: "c7", input: { command: "git commit -m override" } },
		override.ctx,
	);
	assert.equal(after, undefined, "override allows exactly the next gated action");
	assert.match(fs.readFileSync(path.join(REPO, ".pi/workflow-telemetry.jsonl"), "utf8"), /"event":"override"/);
	commitAll("override");
});

test("docs-only commits are not gated", async () => {
	const { handlers, ctx } = await start();
	write("README.md", "docs\n");
	const allowed = await emit(
		handlers,
		"tool_call",
		{ toolName: "bash", toolCallId: "c8", input: { command: "git commit -m docs" } },
		ctx,
	);
	assert.equal(allowed, undefined);
	commitAll("docs");
});

test("deleting a package file does not deadlock the gate", async () => {
	const { handlers, ctx } = await start();
	write("pkg/extra.js", "export const extra = 1;\n");
	commitAll("add extra");
	fs.unlinkSync(path.join(REPO, "pkg/extra.js"));
	await emit(handlers, "tool_call", { toolName: "bash", toolCallId: "t3", input: { command: "bash pkg/test.sh" } }, ctx);
	await emit(handlers, "tool_result", { toolName: "bash", toolCallId: "t3", isError: false }, ctx);
	const allowed = await emit(
		handlers,
		"tool_call",
		{ toolName: "bash", toolCallId: "c9", input: { command: "git commit -m delete" } },
		ctx,
	);
	assert.equal(allowed, undefined, "a green run after a deletion must be committable");
	commitAll("delete extra");
});

test("snapshot failure fails closed for commit-like commands", async () => {
	const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "wg-nongit-"));
	try {
		write2(nonGit, ".pi/workflow.json", `${JSON.stringify(CONTRACT, null, 2)}\n`);
		write2(nonGit, "pkg/file.js", "export const value = 9;\n");
		const { handlers, ctx } = await start(true, nonGit);
		const blocked = await emit(
			handlers,
			"tool_call",
			{ toolName: "bash", toolCallId: "c10", input: { command: "git commit -m x" } },
			ctx,
		);
		assert.ok(blocked?.block, "no git snapshot must block a commit");
		assert.match(blocked.reason, /cannot read git state/);
	} finally {
		fs.rmSync(nonGit, { recursive: true, force: true });
	}
});

test("composition: appends survive a prior appender", async () => {
	const { handlers, ctx } = await start();
	const prior = { systemPrompt: "BASE\n\n[tasks] TASK BLOCK" };
	const result = await emit(handlers, "before_agent_start", prior, ctx);
	assert.ok(result.systemPrompt.startsWith("BASE\n\n[tasks] TASK BLOCK"));
	assert.match(result.systemPrompt, /\[workflow\]/);
});

function write2(root, relative, content) {
	const absolute = path.join(root, relative);
	fs.mkdirSync(path.dirname(absolute), { recursive: true });
	fs.writeFileSync(absolute, content, "utf8");
}
