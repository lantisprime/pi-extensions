import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	MAX_PRELOAD_SUMMARY_CHARS,
	activeToolSet,
	buildPreloadIndex,
	discover,
	selectPreloadRecords,
	truncateSummary,
	type DiscoveryState,
	type RunbookRecord,
} from "../index.ts";

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
		injection: "preload",
		preload: "index",
		priority: 0,
		maxBytes: 5_000,
		bodyBytes: 123,
		contentHash: `hash-${id}`,
		match: { commandIncludes: [], pathIncludes: [] },
		...overrides,
	};
}

function state(records: RunbookRecord[], enabled = true): DiscoveryState {
	return {
		enabled,
		projectTrusted: true,
		scannedAt: new Date(0).toISOString(),
		roots: [],
		records,
		warnings: [],
	};
}

function bytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

async function testActiveToolPreload() {
	const selected = selectPreloadRecords(state([record({ id: "read-guide", tools: ["read"] })]), ["read", "bash"]);
	assert.deepEqual(selected.map((item) => item.id), ["read-guide"]);
	const preload = buildPreloadIndex(selected, 2_000);
	assert.ok(preload.text.includes("## Tool Context Loader Preload Index"));
	assert.ok(preload.text.includes("read-guide"));
	assert.ok(preload.text.includes("Source: project-runbook:read-guide.md"));
	assert.ok(bytes(preload.text) <= 2_000);
}

async function testInactiveToolExclusion() {
	const selected = selectPreloadRecords(state([record({ id: "bash-guide", tools: ["bash"] })]), ["read"]);
	assert.deepEqual(selected, []);
	assert.equal(buildPreloadIndex(selected, 2_000).text, "");
}

async function testPreloadModeRequired() {
	const selected = selectPreloadRecords(
		state([
			record({ id: "preload-guide", injection: "preload" }),
			record({ id: "jit-guide", injection: "tool_result" }),
		]),
		["read"],
	);
	assert.deepEqual(selected.map((item) => item.id), ["preload-guide"]);
}

async function testBudgetCapAndOmissions() {
	const first = record({ id: "first", priority: 20 });
	const second = record({ id: "second", priority: 10 });
	const oneEntryBudget = buildPreloadIndex([first], 10_000).byteLength;
	const preload = buildPreloadIndex([first, second], oneEntryBudget);
	assert.deepEqual(preload.included.map((item) => item.id), ["first"]);
	assert.deepEqual(preload.omitted.map((item) => item.id), ["second"]);
	assert.ok(preload.byteLength <= oneEntryBudget);
	assert.ok(preload.text.includes("first"));
	assert.ok(!preload.text.includes("second"));

	const longSecond = record({ id: "long-second", priority: 10, summary: "x".repeat(1_000) });
	const detailedOmission = buildPreloadIndex([first, longSecond], oneEntryBudget + 140);
	assert.deepEqual(detailedOmission.included.map((item) => item.id), ["first"]);
	assert.deepEqual(detailedOmission.omitted.map((item) => item.id), ["long-second"]);
	assert.ok(detailedOmission.text.includes("Omitted 1 additional preload entries due to budget:"));
	assert.ok(detailedOmission.text.includes("- long-second: project-runbook:long-second.md"));
	assert.ok(detailedOmission.byteLength <= oneEntryBudget + 140);

	const tiny = buildPreloadIndex([first, second], 10);
	assert.equal(tiny.text, "");
	assert.deepEqual(tiny.included, []);
	assert.deepEqual(tiny.omitted.map((item) => item.id), ["first", "second"]);
}

async function testDeterministicOrdering() {
	const records = [
		record({ id: "z-low-priority", priority: 1, sourcePrecedence: 1, displayPath: "project-runbook:z.md" }),
		record({ id: "global-high", priority: 50, sourcePrecedence: 4, displayPath: "global-runbook:a.md" }),
		record({ id: "project-high", priority: 50, sourcePrecedence: 1, displayPath: "project-runbook:b.md" }),
		record({ id: "project-high-a", priority: 50, sourcePrecedence: 1, displayPath: "project-runbook:a.md" }),
	];
	const selected = selectPreloadRecords(state(records), ["read"]);
	assert.deepEqual(selected.map((item) => item.id), ["project-high-a", "project-high", "global-high", "z-low-priority"]);
}

async function testBodiesOmittedEvenForBodyPreload() {
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tcl-p1b-body-"));
	try {
		await fs.mkdir(path.join(temp, ".pi", "runbooks"), { recursive: true });
		await fs.writeFile(
			path.join(temp, ".pi", "runbooks", "body-preload.md"),
			`---\nid: body-preload\nsummary: Body preload metadata only\ntools: [read]\ninjection: preload\npreload: body\n---\n# Body\nSECRET BODY SHOULD NOT APPEAR IN PRELOAD\n`,
		);
		const discovered = await discover({ cwd: temp, projectTrusted: true, homeDir: path.join(temp, "home"), config: { globalRoots: [] } });
		const selected = selectPreloadRecords(discovered, ["read"]);
		assert.deepEqual(selected.map((item) => item.id), ["body-preload"]);
		assert.equal(Object.prototype.hasOwnProperty.call(selected[0], "body"), false);
		const preload = buildPreloadIndex(selected, 2_000);
		assert.ok(preload.text.includes("body-preload"));
		assert.ok(!preload.text.includes("SECRET BODY SHOULD NOT APPEAR IN PRELOAD"));
		assert.ok(!preload.text.includes("# Body"));
	} finally {
		await fs.rm(temp, { recursive: true, force: true });
	}
}

async function testNoToolDocsDuplicated() {
	const toolSnippet = "Read file contents, supports offset and limit.";
	const selected = selectPreloadRecords(state([record({ id: "read-local-guidance", summary: "Local read caveats" })]), ["read"]);
	const preload = buildPreloadIndex(selected, 2_000);
	assert.ok(!preload.text.includes(toolSnippet));
	assert.ok(!preload.text.includes("Use the `read` tool for file contents"));
}

async function testDisabledAndEmptyActiveTools() {
	const disabled = selectPreloadRecords(state([record({ id: "disabled-guide" })], false), ["read"]);
	assert.deepEqual(disabled, []);
	assert.deepEqual(selectPreloadRecords(state([record({ id: "no-tools-selected" })]), undefined), []);
	assert.deepEqual(selectPreloadRecords(state([record({ id: "empty-tools-selected" })]), []), []);
	assert.deepEqual([...activeToolSet(["read", "", " bash "])], ["read", "bash"]);
}

async function testSummaryTruncation() {
	assert.equal(truncateSummary("  one\n two\tthree  "), "one two three");
	const long = "x".repeat(MAX_PRELOAD_SUMMARY_CHARS + 20);
	const truncated = truncateSummary(long);
	assert.equal(truncated.length, MAX_PRELOAD_SUMMARY_CHARS);
	assert.ok(truncated.endsWith("…"));
}

const tests: Array<[string, () => Promise<void>]> = [
	["active-tool preload", testActiveToolPreload],
	["inactive-tool exclusion", testInactiveToolExclusion],
	["preload mode required", testPreloadModeRequired],
	["budget cap and omissions", testBudgetCapAndOmissions],
	["deterministic ordering", testDeterministicOrdering],
	["bodies omitted even for body preload", testBodiesOmittedEvenForBodyPreload],
	["no tool docs duplicated", testNoToolDocsDuplicated],
	["disabled and empty active tools", testDisabledAndEmptyActiveTools],
	["summary truncation", testSummaryTruncation],
];

async function main() {
	let passed = 0;
	for (const [name, test] of tests) {
		await test();
		passed += 1;
		console.log(`ok ${passed} - ${name}`);
	}
	console.log(`P1b preload tests passed: ${passed}/${tests.length}`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
