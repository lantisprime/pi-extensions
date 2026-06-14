import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	DEFAULT_CONFIG,
	buildToolResultInjection,
	discover,
	filterAlreadyInjected,
	matchRunbooksForToolCall,
	patchToolResultContent,
	readRunbookBody,
	toolContextClaimKey,
	type BodyInjectionItem,
	type RunbookRecord,
} from "../index.ts";

const fixtureRoot = path.resolve(import.meta.dirname, "..");
const projectFixture = path.join(fixtureRoot, "test-fixtures", "project");

function record(overrides: Partial<RunbookRecord> = {}): RunbookRecord {
	const id = overrides.id ?? "runbook";
	return {
		id,
		identity: `id:${id}`,
		absolutePath: `/tmp/${id}.md`,
		displayPath: `project-runbook:${id}.md`,
		root: "/tmp",
		sourceKind: "project-runbook",
		sourcePrecedence: 1,
		status: "eligible",
		summary: `${id} summary`,
		tools: ["read"],
		tags: [],
		injection: "tool_result",
		explicitInjection: true,
		preload: "index",
		priority: 0,
		maxBytes: 5_000,
		bodyBytes: 123,
		contentHash: `hash-${id}`,
		match: { commandIncludes: [], pathIncludes: [] },
		...overrides,
	};
}

async function makeTempProject(): Promise<{ temp: string; project: string; cleanup: () => Promise<void> }> {
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tcl-p1c-"));
	const project = path.join(temp, "project");
	await fs.cp(projectFixture, project, { recursive: true });
	return { temp, project, cleanup: () => fs.rm(temp, { recursive: true, force: true }) };
}

async function discoveredRecords() {
	const env = await makeTempProject();
	const state = await discover({ cwd: env.project, projectTrusted: true, homeDir: path.join(env.temp, "home"), config: { globalRoots: [] } });
	return { ...env, state, byId: new Map(state.records.map((item) => [item.id, item])) };
}

async function testBashCommandTrigger() {
	const { byId, cleanup } = await discoveredRecords();
	try {
		const kubectl = byId.get("bash-kubectl");
		assert.ok(kubectl);
		const matches = matchRunbooksForToolCall([kubectl], "bash", { command: "kubectl get pods" });
		assert.deepEqual(matches.map((item) => item.record.id), ["bash-kubectl"]);
		assert.match(matches[0]?.reason ?? "", /command substring `kubectl`/);
	} finally {
		await cleanup();
	}
}

async function testNonmatchingBashCommand() {
	const { byId, cleanup } = await discoveredRecords();
	try {
		const kubectl = byId.get("bash-kubectl");
		assert.ok(kubectl);
		assert.deepEqual(matchRunbooksForToolCall([kubectl], "bash", { command: "git status" }), []);
	} finally {
		await cleanup();
	}
}

async function testPathTrigger() {
	const { byId, cleanup } = await discoveredRecords();
	try {
		const actions = byId.get("github-actions-edit");
		assert.ok(actions);
		const matches = matchRunbooksForToolCall([actions], "edit", { path: ".github/workflows/ci.yml" });
		assert.deepEqual(matches.map((item) => item.record.id), ["github-actions-edit"]);
		assert.match(matches[0]?.reason ?? "", /path substring `.github\/workflows\/`/);
	} finally {
		await cleanup();
	}
}

async function testInactiveToolAndFallbackRules() {
	const bashNoMatcher = record({ id: "bash-broad", tools: ["bash"], match: { commandIncludes: [], pathIncludes: [] } });
	assert.deepEqual(matchRunbooksForToolCall([bashNoMatcher], "bash", { command: "echo hi" }), []);

	const readFallback = record({ id: "read-fallback", tools: ["read"], match: { commandIncludes: [], pathIncludes: [] } });
	assert.deepEqual(matchRunbooksForToolCall([readFallback], "read", { path: "README.md" }).map((item) => item.record.id), ["read-fallback"]);

	const editOnly = record({ id: "edit-only", tools: ["edit"], match: { commandIncludes: [], pathIncludes: ["src/"] } });
	assert.deepEqual(matchRunbooksForToolCall([editOnly], "read", { path: "src/index.ts" }), []);
}

async function testExplicitInjectionRequired() {
	const inherited = record({ id: "default-inherited", explicitInjection: false, injection: "tool_result", tools: ["read"] });
	assert.deepEqual(matchRunbooksForToolCall([inherited], "read", { path: "README.md" }), []);
}

async function testNoArgumentMutation() {
	const input = { command: "kubectl get pods", nested: { keep: true } };
	const before = structuredClone(input);
	const kubectl = record({ id: "kubectl", tools: ["bash"], match: { commandIncludes: ["kubectl"], pathIncludes: [] } });
	matchRunbooksForToolCall([kubectl], "bash", input);
	assert.deepEqual(input, before);
}

async function testReadRunbookBodyAndNoRetention() {
	const { byId, cleanup } = await discoveredRecords();
	try {
		const kubectl = byId.get("bash-kubectl");
		assert.ok(kubectl);
		assert.equal(Object.prototype.hasOwnProperty.call(kubectl, "body"), false);
		const body = await readRunbookBody(kubectl);
		assert.ok(body?.includes("SECRET BODY SHOULD NOT APPEAR IN DIAGNOSTICS"));
		assert.ok(!body?.includes("id: bash-kubectl"));
		assert.equal(Object.prototype.hasOwnProperty.call(kubectl, "body"), false);
	} finally {
		await cleanup();
	}
}

async function testReadErrorsSafe() {
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tcl-p1c-missing-"));
	try {
		const root = path.join(temp, "runbooks");
		await fs.mkdir(root);
		const file = path.join(root, "missing.md");
		await fs.writeFile(file, "---\nid: missing\ntools: [read]\ninjection: tool_result\n---\nbody");
		const missing = record({ id: "missing", root, absolutePath: file });
		await fs.rm(file);
		assert.equal(await readRunbookBody(missing), undefined);
		await fs.rm(root, { recursive: true, force: true });
		assert.equal(await readRunbookBody(missing), undefined);
	} finally {
		await fs.rm(temp, { recursive: true, force: true });
	}
}

async function testAdvisoryWrapperAndBudget() {
	const first = record({ id: "first", priority: 20, maxBytes: 30 });
	const second = record({ id: "second", priority: 10 });
	const items: BodyInjectionItem[] = [
		{ record: second, reason: "tool `read` matched declared tools metadata", body: "second body" },
		{ record: first, reason: "tool `read` matched declared tools metadata", body: "x".repeat(200) },
	];
	const injection = buildToolResultInjection(items, { ...DEFAULT_CONFIG, maxInjectedBytesPerTurn: 10_000, maxRunbookBytes: 100, maxInjectedLinesPerRunbook: 20 });
	assert.deepEqual(injection.injected.map((item) => item.id), ["first", "second"]);
	assert.ok(injection.text.includes("[tool-context-loader]"));
	assert.ok(injection.text.includes("This is local advisory guidance"));
	assert.ok(injection.text.includes("higher-priority instruction"));
	assert.ok(injection.text.includes("excerpt truncated by byte/line budget"));

	const capped = buildToolResultInjection(items, { ...DEFAULT_CONFIG, maxInjectedBytesPerTurn: 10_000 }, 10);
	assert.equal(capped.text, "");
	assert.deepEqual(capped.injected, []);
}

async function testPerTurnBudgetAndDedupeHelpers() {
	const first = record({ id: "first" });
	const match = { record: first, reason: "tool `read` matched declared tools metadata" };
	assert.deepEqual(filterAlreadyInjected([match], new Set([toolContextClaimKey(first)]), true), []);
	assert.deepEqual(filterAlreadyInjected([match], new Set([toolContextClaimKey(first)]), false).map((item) => item.record.id), ["first"]);

	const item: BodyInjectionItem = { ...match, body: "body" };
	const full = buildToolResultInjection([item], { ...DEFAULT_CONFIG, maxInjectedBytesPerTurn: 10_000 });
	const remaining = buildToolResultInjection([item], { ...DEFAULT_CONFIG, maxInjectedBytesPerTurn: 10_000 }, Math.max(0, full.byteLength - 1));
	assert.equal(remaining.text, "");
}

async function testResultPreservationAndNoPatch() {
	const injection = buildToolResultInjection(
		[{ record: record({ id: "preserve" }), reason: "tool `read` matched declared tools metadata", body: "body" }],
		{ ...DEFAULT_CONFIG, maxInjectedBytesPerTurn: 10_000 },
	);
	const content = [
		{ type: "text", text: "original text" },
		{ type: "image", source: { type: "base64", mediaType: "image/png", data: "abc" } },
	];
	const details = { ok: true };
	const patch = patchToolResultContent(content, details, injection);
	assert.ok(patch);
	assert.deepEqual(patch.content?.slice(0, 2), content);
	assert.equal(patch.content?.[2]?.type, "text");
	assert.deepEqual(patch.details, { ok: true, toolContextLoader: { injected: injection.injected, omitted: injection.omitted } });
	assert.equal(Object.prototype.hasOwnProperty.call(patch, "isError"), false);

	assert.equal(patchToolResultContent(content, details, { text: "", injected: [], omitted: [], byteLength: 0 }), undefined);
	const primitiveDetailsPatch = patchToolResultContent(content, "details", injection);
	assert.ok(primitiveDetailsPatch);
	assert.equal(Object.prototype.hasOwnProperty.call(primitiveDetailsPatch, "details"), false);
}

const tests: Array<[string, () => Promise<void>]> = [
	["bash command trigger", testBashCommandTrigger],
	["nonmatching bash command", testNonmatchingBashCommand],
	["path trigger", testPathTrigger],
	["inactive tool and fallback rules", testInactiveToolAndFallbackRules],
	["explicit injection required", testExplicitInjectionRequired],
	["no argument mutation", testNoArgumentMutation],
	["read runbook body and no retention", testReadRunbookBodyAndNoRetention],
	["read errors safe", testReadErrorsSafe],
	["advisory wrapper and budget", testAdvisoryWrapperAndBudget],
	["per-turn budget and dedupe helpers", testPerTurnBudgetAndDedupeHelpers],
	["result preservation and no patch", testResultPreservationAndNoPatch],
];

async function main() {
	let passed = 0;
	for (const [name, test] of tests) {
		await test();
		passed += 1;
		console.log(`ok ${passed} - ${name}`);
	}
	console.log(`P1c JIT tests passed: ${passed}/${tests.length}`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
