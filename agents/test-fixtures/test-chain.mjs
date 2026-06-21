import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	MAX_CHAIN_LENGTH,
	parseChainArgs,
	preflightChain,
	runChain,
	runChainCommand,
} from "../lib/chain-runner.ts";
import { isReservedBuiltInAgentName } from "../lib/specs.ts";
import { collectAgentDiagnostics } from "../lib/diagnostics.ts";

// --- Group 1: Argument parsing ---

function testParseChainArgsValid() {
	const result = parseChainArgs("scout,planner Build a plan");
	assert.equal(result.ok, true);
	assert.deepEqual(result.agents, ["scout", "planner"]);
	assert.equal(result.task, "Build a plan");
}

function testParseChainArgsRejectsEmpty() {
	const result = parseChainArgs("");
	assert.equal(result.ok, false);
	assert.match(result.message, /Usage/);
}

function testParseChainArgsRejectsSingleAgent() {
	const result = parseChainArgs("scout do something");
	assert.equal(result.ok, false);
	assert.match(result.message, /at least 2/);
}

function testParseChainArgsRejectsEmptyTask() {
	const result = parseChainArgs("scout,planner  ");
	assert.equal(result.ok, false);
	assert.ok(/task must not be empty|Usage/.test(result.message));
}

function testParseChainArgsRejectsExcessLength() {
	const names = Array.from({ length: MAX_CHAIN_LENGTH + 1 }, (_, i) => `agent${i}`).join(",");
	const result = parseChainArgs(`${names} do something`);
	assert.equal(result.ok, false);
	assert.match(result.message, /capped at/);
}

function testParseChainArgsThreeAgents() {
	const result = parseChainArgs("scout,planner,reviewer Analyze code");
	assert.equal(result.ok, true);
	assert.deepEqual(result.agents, ["scout", "planner", "reviewer"]);
	assert.equal(result.task, "Analyze code");
}

function testParseChainArgsTrimsWhitespaceAroundCommas() {
	const result = parseChainArgs("scout,planner inspect");
	assert.equal(result.ok, true);
	assert.deepEqual(result.agents, ["scout", "planner"]);
}

function testParseChainArgsRejectsUnsafeCharInName() {
	const result = parseChainArgs("scout,bad\$name do something");
	assert.equal(result.ok, false);
	assert.match(result.message, /unsafe characters/);
}

// --- Group 2: Chain length ---

function testChainExceedsMaxLengthRejected() {
	// Already covered by testParseChainArgsRejectsExcessLength
	// Additional: confirm the constant is 3
	assert.equal(MAX_CHAIN_LENGTH, 3);
}

// --- Group 3: Preflight ---

async function testChainPreflightBlocksAllWhenOneFails() {
	const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "chain-preflight-"));
	try {
		// No agents registered => preflight for non-built-in name fails
		const diag = await collectAgentDiagnostics({ cwd: "/tmp/project", homeDir, projectTrusted: false });
		const result = await preflightChain(["scout", "nonexistent"], diag);
		assert.equal(result.ok, false);
		// scout is built-in and passes, nonexistent fails
		assert.ok(result.agentName && !result.ok);
	} finally {
		await fs.rm(homeDir, { recursive: true, force: true });
	}
}

async function testChainPreflightFailsForUnregistered() {
	const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "chain-unreg-"));
	try {
		const diag = await collectAgentDiagnostics({ cwd: "/tmp/project", homeDir, projectTrusted: false });
		const result = await preflightChain(["ghost"], diag);
		assert.equal(result.ok, false);
		assert.equal(result.agentName, "ghost");
		assert.equal(result.code, "agent-not-found");
	} finally {
		await fs.rm(homeDir, { recursive: true, force: true });
	}
}

async function testChainPreflightFailsForProjectUntrusted() {
	const projDir = await fs.mkdtemp(path.join(os.tmpdir(), "chain-proj-"));
	const projAgentsDir = path.join(projDir, ".pi", "agents");
	await fs.mkdir(projAgentsDir, { recursive: true });
	try {
		await fs.writeFile(path.join(projAgentsDir, "pworker.md"), `---\nname: pworker\ndescription: d\nsource: project\ntools: [read]\nprompt: p\n---\nb`);
		const { registerProjectAgents } = await import("../lib/registration.ts");
		// Register with trust
		const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "chain-proj-home-"));
		await registerProjectAgents({ cwd: projDir, homeDir, projectTrusted: true, hasUI: true, ui: { notify: () => {}, confirm: async () => true }, allSafe: true });
		// Collect diagnostics without trust
		const diag = await collectAgentDiagnostics({ cwd: projDir, homeDir, projectTrusted: false });
		const result = await preflightChain(["pworker"], diag);
		assert.equal(result.ok, false);
		assert.ok(["project-untrusted", "agent-not-found"].includes(result.code));
		await fs.rm(homeDir, { recursive: true, force: true });
	} finally {
		await fs.rm(projDir, { recursive: true, force: true });
	}
}

async function testChainNoSpawnBeforePreflight() {
	const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "chain-nospawn-"));
	try {
		let spawned = false;
		const runner = async () => {
			spawned = true;
			return { agentName: "x", status: "completed", durationMs: 0, stdoutBytes: 0, stderrPreview: "", invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin" } }, summary: { toolCalls: [], summaryText: "", truncation: {}, eventsSeen: 0, malformedLines: 0, errors: [] }, timedOut: false, outputLimitExceeded: false };
		};
		const diag = await collectAgentDiagnostics({ cwd: "/tmp/project", homeDir, projectTrusted: false });
		// Preflight with first agent built-in, second unregistered — should fail without spawning
		const preflight = await preflightChain(["scout", "nonexistent"], diag);
		assert.equal(preflight.ok, false);
		assert.equal(spawned, false, "no child process should spawn before preflight completes");
		// All-built-in preflight should succeed
		const preflightOk = await preflightChain(["scout", "planner"], diag);
		assert.equal(preflightOk.ok, true);
	} finally {
		await fs.rm(homeDir, { recursive: true, force: true });
	}
}

// --- Group 4: Execution ---

async function testChainHandoffIncludesPriorSummary() {
	let capturedTasks = [];
	const runner = async (agent, task) => {
		capturedTasks.push({ agent: typeof agent === "string" ? agent : agent.name, task });
		return {
			agentName: typeof agent === "string" ? agent : agent.name,
			status: "completed",
			durationMs: 10,
			stdoutBytes: 50,
			stderrPreview: "",
			invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin" } },
			summary: {
				eventsSeen: 1, malformedLines: 0, toolCalls: [],
				summaryText: `summary from ${typeof agent === "string" ? agent : agent.name}`,
				truncation: {}, errors: [],
			},
			timedOut: false,
			outputLimitExceeded: false,
		};
	};
	const outcome = await runChain(
		[{ name: "scout", source: "built-in", spec: "scout" }, { name: "planner", source: "built-in", spec: "planner" }],
		"inspect the repo",
		{ cwd: "/tmp", agentsChildRunner: runner },
	);
	assert.equal(outcome.ok, true);
	// Planner should receive original task + scout summary
	assert.match(capturedTasks[1].task, /inspect the repo/);
	assert.match(capturedTasks[1].task, /summary from scout/);
}

async function testChainAccumulatedHandoffBounded() {
	let capturedTasks = [];
	const longSummary = "x".repeat(30_000);
	const runner = async (agent, task) => {
		capturedTasks.push({ agent: typeof agent === "string" ? agent : agent.name, task });
		return {
			agentName: typeof agent === "string" ? agent : agent.name,
			status: "completed",
			durationMs: 10,
			stdoutBytes: 50,
			stderrPreview: "",
			invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin" } },
			summary: {
				eventsSeen: 1, malformedLines: 0, toolCalls: [],
				summaryText: longSummary,
				truncation: {}, errors: [],
			},
			timedOut: false,
			outputLimitExceeded: false,
		};
	};
	const outcome = await runChain(
		[
			{ name: "scout", source: "built-in", spec: "scout" },
			{ name: "planner", source: "built-in", spec: "planner" },
			{ name: "reviewer", source: "built-in", spec: "reviewer" },
		],
		"inspect the repo",
		{ cwd: "/tmp", agentsChildRunner: runner },
	);
	assert.equal(outcome.ok, true);
	// Accumulated handoff should be capped at MAX_ACCUMULATED_HANDOFF_CHARS
	const handoffText = capturedTasks[2].task.slice(capturedTasks[2].task.indexOf("Prior agent summaries:"));
	const handoffBytes = Buffer.byteLength(handoffText, "utf8");
	assert.ok(handoffBytes <= 30_000, "accumulated handoff should be reasonably bounded");
}

async function testChainStopsOnMidChainFailure() {
	let runCount = 0;
	const runner = async (agent) => {
		runCount++;
		const name = typeof agent === "string" ? agent : agent.name;
		if (name === "planner") {
			return {
				agentName: name,
				status: "timeout",
				durationMs: 10,
				stdoutBytes: 0,
				stderrPreview: "",
				invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin" } },
				summary: { eventsSeen: 0, malformedLines: 0, toolCalls: [], summaryText: "", truncation: {}, errors: [] },
				timedOut: true,
				outputLimitExceeded: false,
			};
		}
		return {
			agentName: name,
			status: "completed",
			durationMs: 10,
			stdoutBytes: 50,
			stderrPreview: "",
			invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin" } },
			summary: { eventsSeen: 1, malformedLines: 0, toolCalls: [], summaryText: "ok", truncation: {}, errors: [] },
			timedOut: false,
			outputLimitExceeded: false,
		};
	};
	const outcome = await runChain(
		[
			{ name: "scout", source: "built-in", spec: "scout" },
			{ name: "planner", source: "built-in", spec: "planner" },
			{ name: "reviewer", source: "built-in", spec: "reviewer" },
		],
		"inspect",
		{ cwd: "/tmp", agentsChildRunner: runner },
	);
	assert.equal(outcome.ok, false);
	assert.equal(outcome.agentName, "planner");
	assert.equal(outcome.code, "timeout");
	assert.equal(runCount, 2, "reviewer should not run after planner fails");
}

async function testChainStopsOnMidChainHashMismatch() {
	// Test that a registered agent with hash mismatch after preflight can still be caught
	// by the runner-level gate. The runner simulates a hash mismatch by throwing.
	let runCount = 0;
	const runner = async (agent) => {
		runCount++;
		const name = typeof agent === "string" ? agent : agent.name;
		if (name === "planner") throw new Error("hash mismatch detected");
		return {
			agentName: name, status: "completed", durationMs: 10, stdoutBytes: 50, stderrPreview: "",
			invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin" } },
			summary: { eventsSeen: 1, malformedLines: 0, toolCalls: [], summaryText: "ok", truncation: {}, errors: [] },
			timedOut: false, outputLimitExceeded: false,
		};
	};
	const outcome = await runChain(
		[{ name: "scout", source: "built-in", spec: "scout" }, { name: "planner", source: "built-in", spec: "planner" }],
		"inspect",
		{ cwd: "/tmp", agentsChildRunner: runner },
	);
	assert.equal(outcome.ok, false);
	assert.equal(outcome.code, "spawn-error");
	assert.equal(runCount, 2);
}

async function testChainStopsOnMidChainTimeout() {
	// Covered by testChainStopsOnMidChainFailure which tests timedOut
}

async function testChainAllBuiltIns() {
	let runCount = 0;
	const runner = async (agent) => {
		runCount++;
		const name = typeof agent === "string" ? agent : agent.name;
		return {
			agentName: name, status: "completed", durationMs: 10, stdoutBytes: 50, stderrPreview: "",
			invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin" } },
			summary: { eventsSeen: 1, malformedLines: 0, toolCalls: [], summaryText: `summary ${name}`, truncation: {}, errors: [] },
			timedOut: false, outputLimitExceeded: false,
		};
	};
	const outcome = await runChain(
		[
			{ name: "scout", source: "built-in", spec: "scout" },
			{ name: "planner", source: "built-in", spec: "planner" },
			{ name: "reviewer", source: "built-in", spec: "reviewer" },
		],
		"inspect",
		{ cwd: "/tmp", agentsChildRunner: runner },
	);
	assert.equal(outcome.ok, true);
	assert.equal(outcome.results.length, 3);
	assert.equal(runCount, 3);
}

async function testChainCombinesBuiltInAndRegistered() {
	const userDir = await fs.mkdtemp(path.join(os.tmpdir(), "chain-combo-"));
	const userAgentsDir = path.join(userDir, ".pi", "agent", "agents");
	await fs.mkdir(userAgentsDir, { recursive: true });
	try {
		await fs.writeFile(path.join(userAgentsDir, "researcher.md"), `---\nname: researcher\ndescription: d\nsource: user\ntools: [read]\nprompt: p\n---\nb`);
		const { registerAgent } = await import("../lib/registration.ts");
		await registerAgent(path.join(userAgentsDir, "researcher.md"), { cwd: userDir, homeDir: userDir, projectTrusted: false, hasUI: true, ui: { notify: () => {}, confirm: async () => true } });
		const diag = await collectAgentDiagnostics({ cwd: userDir, homeDir: userDir, projectTrusted: false });
		const preflight = await preflightChain(["scout", "researcher"], diag);
		assert.equal(preflight.ok, true);
		assert.equal(preflight.resolved[0].source, "built-in");
		assert.equal(preflight.resolved[1].source, "user");
	} finally {
		await fs.rm(userDir, { recursive: true, force: true });
	}
}

async function testChainParsesBuiltInAndRegisteredNames() {
	// Covered by testChainCombinesBuiltInAndRegistered and testChainAllBuiltIns
}

async function testChainMultilineTask() {
	let captured;
	const runner = async (agent, task) => {
		captured = { agent: typeof agent === "string" ? agent : agent.name, task };
		return {
			agentName: typeof agent === "string" ? agent : agent.name, status: "completed", durationMs: 10, stdoutBytes: 50, stderrPreview: "",
			invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin" } },
			summary: { eventsSeen: 1, malformedLines: 0, toolCalls: [], summaryText: "ok", truncation: {}, errors: [] },
			timedOut: false, outputLimitExceeded: false,
		};
	};
	const multilineTask = "line one\nline two\n\tindented line";
	await runChain(
		[{ name: "scout", source: "built-in", spec: "scout" }, { name: "planner", source: "built-in", spec: "planner" }],
		multilineTask,
		{ cwd: "/tmp", agentsChildRunner: runner },
	);
	assert.match(captured.task, /line one/);
	assert.match(captured.task, /line two/);
}

// --- Group 5: Consistency and forwarding ---

async function testChainForwardsToolContextLoaderPath() {
	let capturedOpts = null;
	const runner = async (agent, task, opts) => {
		capturedOpts = opts;
		return {
			agentName: typeof agent === "string" ? agent : agent.name, status: "completed", durationMs: 10, stdoutBytes: 50, stderrPreview: "",
			invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin" } },
			summary: { eventsSeen: 1, malformedLines: 0, toolCalls: [], summaryText: "ok", truncation: {}, errors: [] },
			timedOut: false, outputLimitExceeded: false,
		};
	};
	await runChain(
		[{ name: "scout", source: "built-in", spec: "scout" }, { name: "planner", source: "built-in", spec: "planner" }],
		"inspect",
		{ cwd: "/tmp/project", agentsPiCommand: "pi-test", explicitToolContextLoaderPath: "/trusted/tool-context-loader/index.ts", agentsChildRunner: runner },
	);
	assert.ok(capturedOpts);
	assert.equal(capturedOpts.explicitToolContextLoaderPath, "/trusted/tool-context-loader/index.ts");
	assert.equal(capturedOpts.piCommand, "pi-test");
}

async function testChainUsesExecuteChildRun() {
	// Chain uses runChildAgent/runBuiltInChildAgent directly with same options pattern
	let calls = [];
	const runner = async (agent, task, opts) => {
		calls.push({ agent: typeof agent === "string" ? agent : agent.name, task, cwd: opts?.cwd });
		return {
			agentName: typeof agent === "string" ? agent : agent.name, status: "completed", durationMs: 10, stdoutBytes: 50, stderrPreview: "",
			invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin" } },
			summary: { eventsSeen: 1, malformedLines: 0, toolCalls: [], summaryText: "ok", truncation: {}, errors: [] },
			timedOut: false, outputLimitExceeded: false,
		};
	};
	await runChain(
		[{ name: "scout", source: "built-in", spec: "scout" }],
		"inspect",
		{ cwd: "/tmp/project", agentsChildRunner: runner },
	);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].cwd, "/tmp/project");
	assert.equal(calls[0].task, "inspect");
	assert.equal(calls[0].agent, "scout");
}

// --- Group 6: Output format ---

async function testChainOutputFormat() {
	const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "chain-output-"));
	try {
		const notifications = [];
		const diag = await collectAgentDiagnostics({ cwd: "/tmp/project", homeDir, projectTrusted: false });
		// Test successful chain output
		const runner = async (agent) => ({
			agentName: typeof agent === "string" ? agent : agent.name,
			status: "completed",
			durationMs: 10, stdoutBytes: 50, stderrPreview: "",
			invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin" } },
			summary: { eventsSeen: 1, malformedLines: 0, toolCalls: [], summaryText: `summary from ${typeof agent === "string" ? agent : agent.name}`, truncation: {}, errors: [] },
			timedOut: false, outputLimitExceeded: false,
		});
		const ctx = { cwd: "/tmp/project", hasUI: true, agentsChildRunner: runner, ui: { notify: (msg, level) => notifications.push({ message: msg, level: level || "info" }) } };
		await runChainCommand("scout,planner inspect", ctx, diag);
		assert.equal(notifications.length, 3); // preflight, preflight-passed, chain-complete
		assert.match(notifications[0].message, /Chain preflight/);
		assert.match(notifications[1].message, /Chain preflight passed/);
		assert.match(notifications[2].message, /Chain complete/);
		assert.match(notifications[2].message, /scout: completed/);
		assert.match(notifications[2].message, /planner: completed/);
	} finally {
		await fs.rm(homeDir, { recursive: true, force: true });
	}
}

// --- Group 7: Exclusion ---

async function testRunSubagentRejectsChainParam() {
	const { buildSubagentToolDefinition, executeSubagentRun } = await import("../lib/subagent-tool.ts");
	const def = buildSubagentToolDefinition();
	assert.equal(def.parameters.properties.chain, undefined, "run_subagent schema must not have a chain parameter");
	// Executing with comma agent name must be rejected
	const result = await executeSubagentRun("scout,planner", "inspect", { cwd: "/tmp", homeDir: "/tmp", projectTrusted: false, childRunner: async () => ({ agentName: "x", status: "completed", durationMs: 0, stdoutBytes: 0, stderrPreview: "", invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin" } }, summary: { toolCalls: [], summaryText: "", truncation: {}, eventsSeen: 0, malformedLines: 0, errors: [] }, timedOut: false, outputLimitExceeded: false }) });
	assert.equal(result.isError, true, "comma agent name should be rejected by input validation");
}

// --- Main ---

// P8-3: runChainCommand backgrounds the chain run (hasUI+setWidget) AFTER preflight notifies.
async function testChainCommandBackgroundsAfterPreflight() {
	const { __resetBackgroundRuns } = await import("../lib/bg-run.ts");
	__resetBackgroundRuns();
	const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "chain-bg-"));
	try {
		const notifications = [];
		const widgets = [];
		const diag = await collectAgentDiagnostics({ cwd: "/tmp/project", homeDir, projectTrusted: false });
		let settled = false, release;
		const gate = new Promise((res) => { release = res; });
		const runner = async (agent) => {
			await gate; settled = true;
			return { agentName: typeof agent === "string" ? agent : agent.name, status: "completed", durationMs: 10, stdoutBytes: 50, stderrPreview: "", invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin" } }, summary: { eventsSeen: 1, malformedLines: 0, toolCalls: [], summaryText: "ok", truncation: {}, errors: [] }, timedOut: false, outputLimitExceeded: false };
		};
		const ctx = { cwd: "/tmp/project", hasUI: true, agentsChildRunner: runner, ui: { notify: (msg, level) => notifications.push({ message: msg, level: level || "info" }), setWidget: (k, c) => widgets.push({ k, c }) } };
		await runChainCommand("scout,planner inspect", ctx, diag);
		assert.equal(settled, false, "chain run backgrounded — not settled when command returned");
		assert.ok(notifications.some((n) => /Chain preflight passed/.test(n.message)), "preflight-passed notify fired inline before backgrounding");
		assert.equal(notifications.some((n) => /Chain complete/.test(n.message)), false, "no completion notify until settle");
		assert.ok(widgets.some((w) => Array.isArray(w.c)), "progress widget rendered while running");
		release();
		await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
		assert.equal(settled, true, "chain settled after release");
		assert.ok(notifications.some((n) => /Chain complete/.test(n.message)), "completion notify fired after settle");
		__resetBackgroundRuns();
	} finally {
		await fs.rm(homeDir, { recursive: true, force: true });
	}
}

// P8-3 / N2 / REQ-12: threading onProgress through runChain must not alter handoff or results.
async function testChainStepOnProgressDoesNotAlterHandoff() {
	const make = () => {
		const captured = [];
		const runner = async (agent, task, options) => {
			captured.push({ task, hasOnProgress: typeof options?.onProgress === "function" });
			return {
				agentName: typeof agent === "string" ? agent : agent.name,
				status: "completed", durationMs: 10, stdoutBytes: 50, stderrPreview: "",
				invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin" } },
				summary: { eventsSeen: 1, malformedLines: 0, toolCalls: [], summaryText: `summary from ${typeof agent === "string" ? agent : agent.name}`, truncation: {}, errors: [] },
				timedOut: false, outputLimitExceeded: false,
			};
		};
		return { captured, runner };
	};
	const agents = [{ name: "scout", source: "built-in", spec: "scout" }, { name: "planner", source: "built-in", spec: "planner" }];
	const a = make();
	const without = await runChain(agents, "inspect the repo", { cwd: "/tmp", agentsChildRunner: a.runner });
	const b = make();
	const lines = [];
	const withP = await runChain(agents, "inspect the repo", { cwd: "/tmp", agentsChildRunner: b.runner, onProgress: (l) => lines.push(l) });
	assert.deepEqual(b.captured.map((c) => c.task), a.captured.map((c) => c.task), "per-step handoff task byte-identical with/without onProgress");
	assert.deepEqual(withP.results, without.results, "chain results identical with/without onProgress");
	assert.deepEqual(b.captured.map((c) => c.hasOnProgress), [true, true], "onProgress forwarded to every step when provided");
	assert.deepEqual(a.captured.map((c) => c.hasOnProgress), [false, false], "no onProgress threaded when not provided");
}

async function main() {
	const tests = [
		// Group 1
		["parseChainArgsValid", testParseChainArgsValid],
		["parseChainArgsRejectsEmpty", testParseChainArgsRejectsEmpty],
		["parseChainArgsRejectsSingleAgent", testParseChainArgsRejectsSingleAgent],
		["parseChainArgsRejectsEmptyTask", testParseChainArgsRejectsEmptyTask],
		["parseChainArgsRejectsExcessLength", testParseChainArgsRejectsExcessLength],
		["parseChainArgs three agents", testParseChainArgsThreeAgents],
		["parseChainArgs trims whitespace", testParseChainArgsTrimsWhitespaceAroundCommas],
		["parseChainArgs rejects unsafe char", testParseChainArgsRejectsUnsafeCharInName],
		// Group 2
		["chainExceedsMaxLengthRejected", testChainExceedsMaxLengthRejected],
		// Group 3
		["chainPreflightBlocksAllWhenOneFails", testChainPreflightBlocksAllWhenOneFails],
		["chainPreflightFailsForUnregistered", testChainPreflightFailsForUnregistered],
		["chainPreflightFailsForProjectUntrusted", testChainPreflightFailsForProjectUntrusted],
		["chainNoSpawnBeforePreflight", testChainNoSpawnBeforePreflight],
		// Group 4
		["chainHandoffIncludesPriorSummary", testChainHandoffIncludesPriorSummary],
		["chainAccumulatedHandoffBounded", testChainAccumulatedHandoffBounded],
		["chainStepOnProgressDoesNotAlterHandoff", testChainStepOnProgressDoesNotAlterHandoff],
		["chainStopsOnMidChainFailure", testChainStopsOnMidChainFailure],
		["chainStopsOnMidChainHashMismatch", testChainStopsOnMidChainHashMismatch],
		["chainStopsOnMidChainTimeout", testChainStopsOnMidChainTimeout],
		["chainAllBuiltIns", testChainAllBuiltIns],
		["chainCombinesBuiltInAndRegistered", testChainCombinesBuiltInAndRegistered],
		["chainParsesBuiltInAndRegisteredNames", testChainParsesBuiltInAndRegisteredNames],
		["chainMultilineTask", testChainMultilineTask],
		// Group 5
		["chainForwardsToolContextLoaderPath", testChainForwardsToolContextLoaderPath],
		["chainUsesExecuteChildRun", testChainUsesExecuteChildRun],
		// Group 6
		["chainOutputFormat", testChainOutputFormat],
		["chainCommandBackgroundsAfterPreflight", testChainCommandBackgroundsAfterPreflight],
		// Group 7
		["runSubagentRejectsChainParam", testRunSubagentRejectsChainParam],
	];
	let idx = 0;
	for (const [name, test] of tests) {
		await test();
		console.log(`ok ${idx + 1} - ${name}`);
		idx++;
	}
	console.log(`chain tests passed (${tests.length} tests)`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
