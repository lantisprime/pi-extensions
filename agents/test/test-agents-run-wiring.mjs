// SCHEMA1-B wiring tests (plan catalog groups 3, 4, 5, 7):
// .plans/SCHEMA/SCHEMA1_AGENTS_RUN_PLAN.md Appendix B step B.3.
// Mock-API harness per AGENTS.md rule 4: the registration surface
// (registerAgentsRunTool) is driven through a fake ExtensionAPI, discovery is
// faked via the diagnosticsLoader seam, child/bg/chain execution via their
// seams — while resolveRegisteredRunTarget, preflightAgentGate, canRunAgent,
// and parseAgentMarkdownFile run REAL against a tmpdir spec file.
// Focused-review fixes verified here: hasUI:false inline dispatch (B1),
// abort-race catch tail (B2), onBgSettled parity hook (B3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { registerAgentsRunTool } from "../lib/agents-run-tool.ts";

const SPEC_BODY = `---
name: my-agent
description: wiring-test registered agent
tools: [read, grep, find, ls]
---

Body.
`;

function makeCompleteResult(agentName, summaryText = "ok") {
	return {
		agentName,
		status: "completed",
		exitCode: 0,
		signal: null,
		durationMs: 12,
		stdoutBytes: 100,
		stderrPreview: "",
		invocation: { command: "pi-test", argv: ["--mode", "json", "-p"], argvPreview: ["--mode", "json"], promptTransport: { kind: "stdin", stdinText: "redacted" } },
		summary: { eventsSeen: 1, malformedLines: 0, toolCalls: [], summaryText, truncation: { stdoutBytesTruncated: false, jsonLineBytesTruncated: false, summaryCharsTruncated: false, toolArgsCharsTruncated: false, toolResultCharsTruncated: false, toolCallsTruncated: false }, errors: [] },
		timedOut: false,
		outputLimitExceeded: false,
	};
}

async function writeRegisteredSpec(tmpDir) {
	const filePath = path.join(tmpDir, "my-agent.md");
	await fs.writeFile(filePath, SPEC_BODY);
	const rawBytesSha256 = createHash("sha256").update(SPEC_BODY).digest("hex");
	const record = {
		name: "my-agent",
		source: "user",
		filePath,
		canonicalPath: filePath,
		rawBytesSha256,
		runnable: true,
		spec: { name: "my-agent", description: "wiring-test registered agent", tools: ["read", "grep", "find", "ls"], source: "user", prompt: "Body." },
	};
	const registryEntry = {
		name: "my-agent",
		source: "user",
		canonicalPath: filePath,
		rawBytesSha256,
		scannerRisk: "safe",
	};
	return { filePath, record, registryEntry };
}

function makeFakeDiagnostics(tmpDir, { record, registryEntry } = {}) {
	const records = record ? [record] : [];
	return {
		cwd: tmpDir,
		projectRoot: tmpDir,
		projectTrusted: false,
		userAgentsDir: tmpDir,
		projectAgentsDir: tmpDir,
		userRegistryPath: path.join(tmpDir, "user-registry.json"),
		projectRegistryPath: path.join(tmpDir, "project-registry.json"),
		projectRegistryRootOk: true,
		projectRegistryRootIssues: [],
		userRegistry: { agents: registryEntry ? [registryEntry] : [] },
		projectRegistry: { agents: [] },
		records,
		registryOnlyEntries: [],
		summary: {},
	};
}

function setupTool({ sessionCtx, seams }) {
	let definition;
	const pi = { registerTool(def) { definition = def; } };
	registerAgentsRunTool(pi, sessionCtx, seams);
	assert(definition, "registerAgentsRunTool must register a tool");
	return definition;
}

function makeSessionCtx() {
	const notifications = [];
	return {
		ctx: {
			cwd: "/session/cwd",
			agentsHomeDir: "/session/home",
			ui: { notify: (message, level) => notifications.push({ message, level }) },
		},
		notifications,
	};
}

const extensionCtx = (cwd) => ({ cwd, isProjectTrusted: () => false });

async function makeTmpDir(prefix) {
	return fs.mkdtemp(path.join(os.tmpdir(), `agents-run-wiring-${prefix}-`));
}

// ========== Group 3: routing (2) ==========

test("runRoutesBuiltInAndRegistered", async () => {
	// (a) built-in: routes through the built-in dispatch seam; timeout_s lands
	// as timeoutMs in the child-runner options (plan blocker-3 threading).
	const tmpDir = await makeTmpDir("builtin");
	try {
		const calls = [];
		const { ctx: sessionCtx } = makeSessionCtx();
		const definition = setupTool({
			sessionCtx: () => sessionCtx,
			seams: {
				childRunner: async (agent, task, opts) => {
					calls.push({ agent, task, opts });
					return makeCompleteResult(typeof agent === "string" ? agent : agent.name);
				},
			},
		});
		const result = await definition.execute("id1", { agent: "scout", task: "sentinel-run", timeout_s: 45 }, undefined, undefined, extensionCtx(tmpDir));
		assert.equal(result.isError, false, result.content?.[0]?.text);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].agent, "scout");
		assert.ok(calls[0].task.includes("sentinel-run"), "sentinel task reaches the child");
		assert.equal(calls[0].opts.timeoutMs, 45_000, "timeout_s threads to the child runner as timeoutMs");
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}

	// (b) registered: real resolveRegisteredRunTarget + preflightAgentGate +
	// canRunAgent against a real tmp spec file; dispatch captured at the seam.
	const tmpDir2 = await makeTmpDir("registered");
	try {
		const { record, registryEntry } = await writeRegisteredSpec(tmpDir2);
		const diagnostics = makeFakeDiagnostics(tmpDir2, { record, registryEntry });
		const calls = [];
		const { ctx: sessionCtx } = makeSessionCtx();
		const definition = setupTool({
			sessionCtx: () => sessionCtx,
			seams: {
				diagnosticsLoader: async () => diagnostics,
				childRunner: async (agent, task, opts) => {
					calls.push({ agent, task, opts });
					return makeCompleteResult(typeof agent === "string" ? agent : agent.name);
				},
			},
		});
		const result = await definition.execute("id2", { agent: "my-agent", task: "sentinel-reg" }, undefined, undefined, extensionCtx(tmpDir2));
		assert.equal(result.isError, false, result.content?.[0]?.text);
		assert.equal(calls.length, 1, "registered agent dispatches exactly one child run");
		assert.equal(typeof calls[0].agent, "object", "registered dispatch passes the parsed spec");
		assert.equal(calls[0].agent.name, "my-agent");
		assert.ok(calls[0].task.includes("sentinel-reg"), "sentinel task reaches the child");
	} finally {
		await fs.rm(tmpDir2, { recursive: true, force: true });
	}
});

test("unknownAgentDeniesWithList", async () => {
	const tmpDir = await makeTmpDir("unknown");
	try {
		const { ctx: sessionCtx } = makeSessionCtx();
		const definition = setupTool({
			sessionCtx: () => sessionCtx,
			seams: {
				diagnosticsLoader: async () => makeFakeDiagnostics(tmpDir, {}),
			},
		});
		const result = await definition.execute("id3", { agent: "ghost", task: "x" }, undefined, undefined, extensionCtx(tmpDir));
		assert.equal(result.isError, true);
		assert.equal(result.details.code, "unknown-agent");
		const text = result.content[0].text;
		assert.match(text, /ghost/);
		assert.match(text, /available:/, "deny lists available agents");
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// ========== Group 4: bg/chain (3) ==========

test("bgUnknownBackendDeniesWithList", async () => {
	const tmpDir = await makeTmpDir("bgbackend");
	try {
		const { record, registryEntry } = await writeRegisteredSpec(tmpDir);
		const { ctx: sessionCtx } = makeSessionCtx();
		const definition = setupTool({
			sessionCtx: () => sessionCtx,
			seams: { diagnosticsLoader: async () => makeFakeDiagnostics(tmpDir, { record, registryEntry }) },
		});
		const result = await definition.execute("id4", { mode: "bg", agent: "my-agent", task: "x", backend: "nope" }, undefined, undefined, extensionCtx(tmpDir));
		assert.equal(result.isError, true);
		assert.equal(result.details.code, "unknown-backend");
		assert.match(result.content[0].text, /unknown backend 'nope'/);
		assert.match(result.content[0].text, /registered backends:/);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test("bgBuiltInDenies", async () => {
	// EC10 / REQ-4 parity: /agents bg scout denies today (registered-only);
	// the tool denies the same shape before any backend or preflight access.
	const tmpDir = await makeTmpDir("bgbuiltin");
	try {
		const { ctx: sessionCtx } = makeSessionCtx();
		const definition = setupTool({ sessionCtx: () => sessionCtx, seams: {} });
		const result = await definition.execute("id5", { mode: "bg", agent: "scout", task: "x", backend: "tmux" }, undefined, undefined, extensionCtx(tmpDir));
		assert.equal(result.isError, true);
		assert.equal(result.details.code, "invalid-input");
		assert.match(result.content[0].text, /registered agents only/);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test("chainRoutesToRunner", async () => {
	const tmpDir = await makeTmpDir("chain");
	try {
		const { ctx: sessionCtx } = makeSessionCtx();
		const runnerCalls = [];
		const definition = setupTool({
			sessionCtx: () => sessionCtx,
			seams: {
				chainRunner: async (resolved, task) => {
					runnerCalls.push({ resolved, task });
					return { ok: true, results: [] };
				},
			},
		});
		const result = await definition.execute(
			"id6",
			{ mode: "chain", agent: "scout", task: "sentinel-chain", chain: ["scout", "planner"] },
			undefined, undefined, extensionCtx(tmpDir),
		);
		assert.equal(result.isError, false, result.content?.[0]?.text);
		assert.equal(runnerCalls.length, 1, "chain routes exactly one runner call");
		assert.deepEqual(runnerCalls[0].resolved.map((r) => r.name), ["scout", "planner"]);
		assert.ok(runnerCalls[0].task.includes("sentinel-chain"), "sentinel task reaches the runner");

		// Runtime strictly finer than schema: 4 entries pass validate (max 8)
		// but the runner cap (MAX_CHAIN_LENGTH 3) denies before any runner call.
		const capped = await definition.execute(
			"id7",
			{ mode: "chain", agent: "scout", task: "x", chain: ["a-one", "b-two", "c-three", "d-four"] },
			undefined, undefined, extensionCtx(tmpDir),
		);
		assert.equal(capped.isError, true);
		assert.equal(capped.details.code, "invalid-input");
		assert.match(capped.content[0].text, /capped at 3/);
		assert.equal(runnerCalls.length, 1, "cap denies before the runner is invoked");
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// ========== Group 5: wiring fail-closed (1) ==========

test("noSessionContextDenies", async () => {
	const tmpDir = await makeTmpDir("noctx");
	try {
		const definition = setupTool({ sessionCtx: () => undefined, seams: {} });
		const result = await definition.execute("id8", { agent: "scout", task: "x" }, undefined, undefined, extensionCtx(tmpDir));
		assert.equal(result.isError, true);
		assert.equal(result.details.code, "not-ready");
		assert.match(result.content[0].text, /session context not ready/);

		// Validation precedes the context check: bad input denies invalid-input
		// even with no session context.
		const bad = await definition.execute("id9", { agent: "--flag", task: "x" }, undefined, undefined, extensionCtx(tmpDir));
		assert.equal(bad.details.code, "invalid-input");
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// ========== Group 7: preflight sentinel (1) ==========

test("bgRoutesThroughPreflight", async () => {
	const tmpDir = await makeTmpDir("bgpreflight");
	try {
		const { record, registryEntry } = await writeRegisteredSpec(tmpDir);
		const { ctx: sessionCtx, notifications } = makeSessionCtx();
		const preflightCalls = [];
		let settled = 0;
		const launchCalls = [];
		const definition = setupTool({
			sessionCtx: () => sessionCtx,
			seams: {
				diagnosticsLoader: async () => makeFakeDiagnostics(tmpDir, { record, registryEntry }),
				bgPreflight: async (rec, task, runCtx, diagnostics, options) => {
					preflightCalls.push({ rec, task, options });
					return { ok: true, runId: "run-abc123def456", paths: { runDir: tmpDir, manifestPath: path.join(tmpDir, "manifest.json") }, manifest: {} };
				},
				backendByName: (name) => (name === "fake" ? {
					name: "fake",
					launch: async (req) => {
						launchCalls.push(req);
						return { status: "ok", windowId: "w-1" };
					},
				} : undefined),
				onBgSettled: async () => { settled += 1; },
			},
		});
		const result = await definition.execute(
			"id10",
			{ mode: "bg", agent: "my-agent", task: "sentinel-bg", backend: "fake", timeout_s: 120 },
			undefined, undefined, extensionCtx(tmpDir),
		);
		assert.equal(result.isError, false, result.content?.[0]?.text);
		// Sentinel assertions: the exact task string and the mapped timeout
		// (timeout_s → maxDurationSec, plan blocker-3) reach the preflight fake.
		assert.equal(preflightCalls.length, 1);
		assert.equal(preflightCalls[0].task, "sentinel-bg", "preflight receives exactly the sentinel task string");
		assert.equal(preflightCalls[0].options.maxDurationSec, 120);
		assert.equal(preflightCalls[0].rec.name, "my-agent");
		assert.equal(launchCalls.length, 1);
		assert.equal(launchCalls[0].runId, "run-abc123def456");
		assert.equal(launchCalls[0].manifestPath, path.join(tmpDir, "manifest.json"));
		assert.match(result.content[0].text, /run-abc123def456/);
		assert.equal(settled, 1, "onBgSettled parity hook runs after success (review blocker B3)");
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// ========== Abort discipline (plan blocker-3, review blockers B1/B2) ==========

test("abortDeniesBeforeAndMidFlight", async () => {
	const tmpDir = await makeTmpDir("abort");
	try {
		let releaseChild;
		const childStarted = new Promise((resolve) => { releaseChild = resolve; });
		const { ctx: sessionCtx } = makeSessionCtx();
		const definition = setupTool({
			sessionCtx: () => sessionCtx,
			seams: {
				childRunner: async (agent, task) => {
					await childStarted;
					return makeCompleteResult(typeof agent === "string" ? agent : agent.name);
				},
			},
		});

		// (a) already-aborted signal denies before dispatch.
		const preAborted = new AbortController();
		preAborted.abort();
		const early = await definition.execute("id11", { agent: "scout", task: "x" }, preAborted.signal, undefined, extensionCtx(tmpDir));
		assert.equal(early.isError, true);
		assert.equal(early.details.code, "aborted");

		// (b) mid-flight abort: hasUI:false keeps dispatch inline, so the race
		// between exec and the abort listener is real (review blocker B1).
		const controller = new AbortController();
		const pending = definition.execute("id12", { agent: "scout", task: "slow" }, controller.signal, undefined, extensionCtx(tmpDir));
		await new Promise((r) => setTimeout(r, 10));
		controller.abort();
		const raced = await pending;
		assert.equal(raced.isError, true);
		assert.equal(raced.details.code, "aborted");
		releaseChild(); // settle the exec tail — its catch swallows it (B2)
		await new Promise((r) => setTimeout(r, 10));
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});
