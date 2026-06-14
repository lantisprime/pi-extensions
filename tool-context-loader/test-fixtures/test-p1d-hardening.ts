import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	DEFAULT_CONFIG,
	buildToolResultPatchForMatches,
	claimMatchesForTurn,
	createRuntimeState,
	discover,
	estimateBodyInjectionReservation,
	matchRunbooksForToolCall,
	resetLoaderRuntimeState,
	resetTurnInjectionState,
	selectPreloadRecords,
	suspendRuntimeForRescan,
	type LoaderConfig,
	type RunbookRecord,
	type ToolCallMatch,
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
		bodyBytes: 50,
		contentHash: `hash-${id}`,
		match: { commandIncludes: [], pathIncludes: [] },
		...overrides,
	};
}

function match(item: RunbookRecord): ToolCallMatch {
	return { record: item, reason: "tool `read` matched declared tools metadata" };
}

function config(overrides: Partial<LoaderConfig> = {}): LoaderConfig {
	return { ...DEFAULT_CONFIG, maxInjectedBytesPerTurn: 10_000, ...overrides };
}

async function makeTempProject(): Promise<{ temp: string; project: string; cleanup: () => Promise<void> }> {
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tcl-p1d-"));
	const project = path.join(temp, "project");
	await fs.cp(projectFixture, project, { recursive: true });
	return { temp, project, cleanup: () => fs.rm(temp, { recursive: true, force: true }) };
}

async function discoveredRecords() {
	const env = await makeTempProject();
	const state = await discover({ cwd: env.project, projectTrusted: true, homeDir: path.join(env.temp, "home"), config: { globalRoots: [] } });
	return { ...env, state, byId: new Map(state.records.map((item) => [item.id, item])) };
}

async function testClaimBeforeAwaitSameRunbook() {
	const state = createRuntimeState();
	const item = record({ id: "same" });
	const first = claimMatchesForTurn([match(item)], state, config());
	const second = claimMatchesForTurn([match(item)], state, config());
	assert.equal(first.claimed.length, 1);
	assert.equal(second.claimed.length, 0);
	assert.equal(second.omitted[0]?.reason, "already claimed this turn");
	assert.ok(state.reservedBytesThisTurn > 0);
}

async function testParallelSameRunbookE2E() {
	const state = createRuntimeState();
	const item = record({ id: "parallel-same", bodyBytes: 20 });
	let reads = 0;
	const readBody = async () => {
		reads += 1;
		await new Promise((resolve) => setTimeout(resolve, 20));
		return "parallel body";
	};
	const [first, second] = await Promise.all([
		buildToolResultPatchForMatches([match(item)], [{ type: "text", text: "first" }], {}, config(), state, readBody),
		buildToolResultPatchForMatches([match(item)], [{ type: "text", text: "second" }], {}, config(), state, readBody),
	]);
	const patches = [first, second].filter(Boolean);
	assert.equal(patches.length, 1);
	assert.equal(reads, 1);
	assert.equal(state.reservedBytesThisTurn, 0);
	assert.ok(state.injectedThisTurn.has("parallel-same:tool_result"));
}

async function testParallelBudgetReservation() {
	const first = record({ id: "budget-a", bodyBytes: 40, priority: 10 });
	const second = record({ id: "budget-b", bodyBytes: 40, priority: 9 });
	const maxInjectedBytesPerTurn = estimateBodyInjectionReservation(match(first), config()) + 5;
	const smallConfig = config({ maxInjectedBytesPerTurn });
	const state = createRuntimeState();
	const readBody = async (item: RunbookRecord) => {
		await new Promise((resolve) => setTimeout(resolve, 20));
		return `${item.id} body`;
	};
	const [patchA, patchB] = await Promise.all([
		buildToolResultPatchForMatches([match(first)], [{ type: "text", text: "a" }], {}, smallConfig, state, readBody),
		buildToolResultPatchForMatches([match(second)], [{ type: "text", text: "b" }], {}, smallConfig, state, readBody),
	]);
	const byteTotal = [patchA, patchB]
		.flatMap((patch) => patch?.content ?? [])
		.filter((part) => part.type === "text" && part.text !== "a" && part.text !== "b")
		.reduce((total, part) => total + Buffer.byteLength(String(part.text), "utf8"), 0);
	assert.ok(byteTotal <= maxInjectedBytesPerTurn);
	assert.equal(state.reservedBytesThisTurn, 0);
	assert.ok(state.injectedBytesThisTurn <= maxInjectedBytesPerTurn);
}

async function testDedupeResetOnNextTurn() {
	const state = createRuntimeState();
	const item = record({ id: "reset-dedupe" });
	assert.equal(claimMatchesForTurn([match(item)], state, config()).claimed.length, 1);
	assert.equal(claimMatchesForTurn([match(item)], state, config()).claimed.length, 0);
	resetTurnInjectionState(state);
	assert.equal(claimMatchesForTurn([match(item)], state, config()).claimed.length, 1);
}

async function testBudgetResetOnNextTurn() {
	const state = createRuntimeState();
	const first = record({ id: "budget-reset-a", bodyBytes: 30 });
	const second = record({ id: "budget-reset-b", bodyBytes: 30 });
	const smallConfig = config({ maxInjectedBytesPerTurn: estimateBodyInjectionReservation(match(first), config()) + 1 });
	assert.equal(claimMatchesForTurn([match(first)], state, smallConfig).claimed.length, 1);
	assert.equal(claimMatchesForTurn([match(second)], state, smallConfig).claimed.length, 0);
	resetTurnInjectionState(state);
	assert.equal(claimMatchesForTurn([match(second)], state, smallConfig).claimed.length, 1);
}

async function testPendingCleanupOnReset() {
	const state = createRuntimeState();
	state.pendingToolCallMatches.set("call-1", [match(record({ id: "pending" }))]);
	resetLoaderRuntimeState(state);
	assert.equal(state.pendingToolCallMatches.size, 0);
	assert.equal(state.claimedThisTurn.size, 0);
	assert.equal(state.reservedBytesThisTurn, 0);
}

async function testConfigDisabledNoJit() {
	const { temp, project, cleanup } = await makeTempProject();
	try {
		const disabled = await discover({ cwd: project, projectTrusted: true, homeDir: path.join(temp, "home"), config: { enabled: false, globalRoots: [] } });
		assert.equal(disabled.enabled, false);
		assert.deepEqual(disabled.records, []);
		assert.deepEqual(selectPreloadRecords(disabled, ["bash"]), []);
		const matches = matchRunbooksForToolCall(disabled.records, "bash", { command: "kubectl get pods" });
		const patch = await buildToolResultPatchForMatches(matches, [{ type: "text", text: "output" }], {}, config(), createRuntimeState());
		assert.equal(patch, undefined);
	} finally {
		await cleanup();
	}
}

async function testOffToggleNoStaleInjection() {
	const state = createRuntimeState();
	const item = record({ id: "off-stale" });
	state.pendingToolCallMatches.set("call-1", [match(item)]);
	resetLoaderRuntimeState(state);
	const pending = state.pendingToolCallMatches.get("call-1") ?? [];
	const patch = await buildToolResultPatchForMatches(pending, [{ type: "text", text: "output" }], {}, config(), state, async () => "body");
	assert.equal(patch, undefined);
}

async function testSuspendRuntimeForRescanDisablesStaleState() {
	const state = createRuntimeState();
	state.pendingToolCallMatches.set("call-1", [match(record({ id: "stale" }))]);
	state.claimedThisTurn.add("stale:tool_result");
	state.injectedBytesThisTurn = 123;
	state.reservedBytesThisTurn = 456;
	const suspended = suspendRuntimeForRescan(true, state);
	assert.equal(suspended.enabled, false);
	assert.equal(suspended.projectTrusted, true);
	assert.deepEqual(suspended.records, []);
	assert.deepEqual(selectPreloadRecords(suspended, ["read"]), []);
	assert.equal(state.pendingToolCallMatches.size, 0);
	assert.equal(state.claimedThisTurn.size, 0);
	assert.equal(state.injectedBytesThisTurn, 0);
	assert.equal(state.reservedBytesThisTurn, 0);
}

async function testDedupeDisabledDoesNotSuppressClaimKey() {
	const state = createRuntimeState();
	const item = record({ id: "dedupe-disabled", bodyBytes: 10 });
	const noDedupe = config({ dedupePerTurn: false, maxInjectedBytesPerTurn: 20_000 });
	assert.equal(claimMatchesForTurn([match(item)], state, noDedupe).claimed.length, 1);
	assert.equal(claimMatchesForTurn([match(item)], state, noDedupe).claimed.length, 1);
}

async function testNegativeTinyBudgetNoPatchAndNoReservationLeak() {
	const state = createRuntimeState();
	const item = record({ id: "tiny-budget", bodyBytes: 10 });
	const patch = await buildToolResultPatchForMatches(
		[match(item)],
		[{ type: "text", text: "output" }],
		{},
		config({ maxInjectedBytesPerTurn: 1 }),
		state,
		async () => "body",
	);
	assert.equal(patch, undefined);
	assert.equal(state.reservedBytesThisTurn, 0);
	assert.equal(state.injectedBytesThisTurn, 0);
	assert.equal(state.claimedThisTurn.size, 0);
}

async function testNegativeBodyReadFailureNoPatchAndClaimHeld() {
	const state = createRuntimeState();
	const item = record({ id: "read-failure", bodyBytes: 10 });
	const patch = await buildToolResultPatchForMatches(
		[match(item)],
		[{ type: "text", text: "output" }],
		{},
		config(),
		state,
		async () => undefined,
	);
	assert.equal(patch, undefined);
	assert.equal(state.reservedBytesThisTurn, 0);
	assert.equal(state.injectedBytesThisTurn, 0);
	assert.ok(state.claimedThisTurn.has("read-failure:tool_result"));
	assert.equal(claimMatchesForTurn([match(item)], state, config()).claimed.length, 0);
}

async function testEndToEndDiscoveredParallelSameRunbookInjectsOnce() {
	const { state: discovery, byId, cleanup } = await discoveredRecords();
	try {
		const kubectl = byId.get("bash-kubectl");
		assert.ok(kubectl);
		const matches = matchRunbooksForToolCall(discovery.records, "bash", { command: "kubectl get pods" });
		assert.deepEqual(matches.map((item) => item.record.id), ["bash-kubectl"]);
		const state = createRuntimeState();
		const [first, second] = await Promise.all([
			buildToolResultPatchForMatches(matches, [{ type: "text", text: "first" }], {}, config(), state),
			buildToolResultPatchForMatches(matches, [{ type: "text", text: "second" }], {}, config(), state),
		]);
		const patches = [first, second].filter(Boolean);
		assert.equal(patches.length, 1);
		const injected = String(patches[0]?.content?.at(-1)?.text ?? "");
		assert.ok(injected.includes("[tool-context-loader]"));
		assert.ok(injected.includes("SECRET BODY SHOULD NOT APPEAR IN DIAGNOSTICS"));
		assert.equal(state.reservedBytesThisTurn, 0);
	} finally {
		await cleanup();
	}
}

async function testEndToEndSuspendBetweenCallAndResultNoPatch() {
	const { state: discovery, cleanup } = await discoveredRecords();
	try {
		const matches = matchRunbooksForToolCall(discovery.records, "bash", { command: "kubectl get pods" });
		assert.equal(matches.length, 1);
		const state = createRuntimeState();
		state.pendingToolCallMatches.set("call-1", matches);
		const suspended = suspendRuntimeForRescan(true, state);
		const pending = state.pendingToolCallMatches.get("call-1") ?? [];
		const patch = await buildToolResultPatchForMatches(pending, [{ type: "text", text: "output" }], {}, config(), state);
		assert.equal(suspended.enabled, false);
		assert.equal(patch, undefined);
		assert.equal(state.pendingToolCallMatches.size, 0);
	} finally {
		await cleanup();
	}
}

const tests: Array<[string, () => Promise<void>]> = [
	["claim before await same runbook", testClaimBeforeAwaitSameRunbook],
	["parallel same-runbook e2e", testParallelSameRunbookE2E],
	["parallel budget reservation", testParallelBudgetReservation],
	["dedupe reset on next turn", testDedupeResetOnNextTurn],
	["budget reset on next turn", testBudgetResetOnNextTurn],
	["pending cleanup on reset", testPendingCleanupOnReset],
	["config disabled no JIT", testConfigDisabledNoJit],
	["off-toggle no stale injection", testOffToggleNoStaleInjection],
	["suspend runtime for rescan disables stale state", testSuspendRuntimeForRescanDisablesStaleState],
	["dedupe disabled does not suppress claim key", testDedupeDisabledDoesNotSuppressClaimKey],
	["negative tiny budget no patch and no reservation leak", testNegativeTinyBudgetNoPatchAndNoReservationLeak],
	["negative body read failure no patch and claim held", testNegativeBodyReadFailureNoPatchAndClaimHeld],
	["e2e discovered parallel same runbook injects once", testEndToEndDiscoveredParallelSameRunbookInjectsOnce],
	["e2e suspend between call and result no patch", testEndToEndSuspendBetweenCallAndResultNoPatch],
];

async function main() {
	let passed = 0;
	for (const [name, test] of tests) {
		await test();
		passed += 1;
		console.log(`ok ${passed} - ${name}`);
	}
	console.log(`P1d hardening tests passed: ${passed}/${tests.length}`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
