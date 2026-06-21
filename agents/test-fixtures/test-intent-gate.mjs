import assert from "node:assert";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadGateConfig, classifyGateIntent, GATE_INSTRUCTIONS } from "../lib/intent-gate.ts";
import { handleGateInput, __gateDispatch } from "../index.ts";
import { dispatchChildRun } from "../lib/run-resolver.ts";

// ── Helpers ──

async function writeTempConfig(json) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-test-gate-"));
	const filePath = path.join(dir, "intent-workflows.json");
	await fs.writeFile(filePath, JSON.stringify(json), "utf-8");
	return { dir, filePath };
}

const SAMPLE_CONFIG = {
	version: 1,
	intents: [
		{
			id: "security-review",
			match: { phrases: ["security review", "adversarial review", "threat review"] },
			workflow: { kind: "review", profile: "security-profile" },
		},
		{
			id: "code-review",
			match: { phrases: ["code review", "review this", "review the"] },
			workflow: { kind: "review", profile: "code-profile" },
		},
		{
			id: "plan-request",
			match: { phrases: ["create a plan", "make a plan", "use the plan template"] },
			workflow: { kind: "plan-only" },
		},
	],
};

// ── Config loading (7) ──

async function testGate_configValid() {
	const { dir, filePath } = await writeTempConfig(SAMPLE_CONFIG);
	try {
		const result = await loadGateConfig(filePath, true);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.config.intents.length, 3);
			assert.equal(result.config.intents[0].id, "security-review");
		}
	} finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

async function testGate_configMissingSkips() {
	const result = await loadGateConfig("/nonexistent/path/config.json", true);
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.reason, "missing");
}

async function testGate_configInvalidSkips() {
	const { dir, filePath } = await writeTempConfig({ not: "valid" });
	try {
		const result = await loadGateConfig(filePath, true);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, "invalid");
	} finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

async function testGate_untrustedProjectConfigIgnored() {
	const { dir, filePath } = await writeTempConfig(SAMPLE_CONFIG);
	try {
		const result = await loadGateConfig(filePath, false);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, "untrusted");
	} finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

async function testGate_configInlineModelRejected() {
	const badConfig = {
		version: 1,
		intents: [{
			id: "test", match: { phrases: ["test"] },
			workflow: { kind: "review", model: "gpt-5" },
		}],
	};
	const { dir, filePath } = await writeTempConfig(badConfig);
	try {
		const result = await loadGateConfig(filePath, true);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, "inline-model");
	} finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

async function testGate_configInlineModelEntryLevelRejected() {
	const badConfig = {
		version: 1,
		intents: [{
			id: "test", model: "gpt-5", match: { phrases: ["test"] },
			workflow: { kind: "review" },
		}],
	};
	const { dir, filePath } = await writeTempConfig(badConfig);
	try {
		const result = await loadGateConfig(filePath, true);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, "inline-model");
	} finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

async function testGate_configUnknownKindRejected() {
	const badConfig = {
		version: 1,
		intents: [{
			id: "test", match: { phrases: ["test"] },
			workflow: { kind: "execute" },
		}],
	};
	const { dir, filePath } = await writeTempConfig(badConfig);
	try {
		const result = await loadGateConfig(filePath, true);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, "unknown-kind");
	} finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

// ── Phrase matching (7) ──

async function testGate_phraseMatch() {
	const { dir, filePath } = await writeTempConfig(SAMPLE_CONFIG);
	try {
		const result = await loadGateConfig(filePath, true);
		assert.equal(result.ok, true);
		if (!result.ok) return;

		const decision = classifyGateIntent("can you do a security review of this module?", result.config);
		assert.equal(decision.kind, "route");
		if (decision.kind === "route") {
			assert.equal(decision.agent, "reviewer");
			assert.equal(decision.profile, "security-profile");
			assert.equal(decision.metadata.intentId, "security-review");
		}
	} finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

async function testGate_noMatchPassesThrough() {
	const { dir, filePath } = await writeTempConfig(SAMPLE_CONFIG);
	try {
		const result = await loadGateConfig(filePath, true);
		assert.equal(result.ok, true);
		if (!result.ok) return;

		assert.equal(classifyGateIntent("hello, how are you?", result.config).kind, "pass-through");
	} finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

async function testGate_skipsCommands() {
	const { dir, filePath } = await writeTempConfig(SAMPLE_CONFIG);
	try {
		const result = await loadGateConfig(filePath, true);
		assert.equal(result.ok, true);
		if (!result.ok) return;

		assert.equal(classifyGateIntent("/agents run scout task", result.config).kind, "pass-through");
		assert.equal(classifyGateIntent("  /agents do review this", result.config).kind, "pass-through");
	} finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

function testGate_emptyPromptPassesThrough() {
	const config = { version: 1, intents: [] };
	assert.equal(classifyGateIntent("", config).kind, "pass-through");
}

async function testGate_ambiguityPassesThrough() {
	const config = {
		version: 1,
		intents: [
			{ id: "review", match: { phrases: ["review this"] }, workflow: { kind: "review" } },
			{ id: "plan", match: { phrases: ["create a plan"] }, workflow: { kind: "plan-only" } },
		],
	};
	const { dir, filePath } = await writeTempConfig(config);
	try {
		const result = await loadGateConfig(filePath, true);
		assert.equal(result.ok, true);
		if (!result.ok) return;

		// Matches BOTH review and plan-only → ambiguity → pass-through
		const decision = classifyGateIntent("review this and create a plan", result.config);
		assert.equal(decision.kind, "pass-through",
			"ambiguity (different workflow kinds) must pass through");
	} finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

async function testGate_planOnlyInjectsInstruction() {
	const config = {
		version: 1,
		intents: [
			{ id: "plan", match: { phrases: ["create a plan"] }, workflow: { kind: "plan-only" } },
		],
	};
	const { dir, filePath } = await writeTempConfig(config);
	try {
		const result = await loadGateConfig(filePath, true);
		assert.equal(result.ok, true);
		if (!result.ok) return;

		const decision = classifyGateIntent("create a plan for the migration", result.config);
		assert.equal(decision.kind, "inject");
		if (decision.kind === "inject") {
			assert.equal(decision.instruction, "PLAN_ONLY");
		}
	} finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

async function testGate_implementationConfirm() {
	const config = {
		version: 1,
		intents: [
			{ id: "impl", match: { phrases: ["implement this"] }, workflow: { kind: "implementation" } },
		],
	};
	const { dir, filePath } = await writeTempConfig(config);
	try {
		const result = await loadGateConfig(filePath, true);
		assert.equal(result.ok, true);
		if (!result.ok) return;

		const decision = classifyGateIntent("please implement this feature", result.config);
		assert.equal(decision.kind, "confirm");
		if (decision.kind === "confirm") {
			assert.equal(decision.agent, "planner");
		}
	} finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

// ── P7-2: Gate + hook wiring tests ─────────────────────────────────────

const _origGateDispatch = dispatchChildRun;

async function withGateConfig(intents, body) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-test-gate-p7-2-"));
	const configDir = path.join(dir, ".pi");
	await fs.mkdir(configDir);
	const config = { version: 1, intents };
	await fs.writeFile(path.join(configDir, "intent-workflows.json"), JSON.stringify(config), "utf-8");
	try { await body(dir); }
	finally {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
		__gateDispatch.fn = _origGateDispatch;
	}
}

function makeGateCtx(overrides = {}) {
	return {
		hasUI: true,
		cwd: "/tmp",
		ui: {
			notify: () => {},
			confirm: overrides.confirm !== undefined ? overrides.confirm : async () => true,
		},
		isProjectTrusted: overrides.isProjectTrusted !== undefined ? overrides.isProjectTrusted : () => true,
		...overrides,
	};
}

// REQ-4: review intent routes to agent via gate runner
async function testGate_reviewRoutesToAgent() {
	const intents = [{ id: "review", match: { phrases: ["review this"] }, workflow: { kind: "review" } }];
	let dispatchCalls = [];
	__gateDispatch.fn = async (agent, task, ctx, source, profile) => { dispatchCalls.push({ agent, task, ctx, source, profile }); };

	await withGateConfig(intents, async (dir) => {
		const ctx = makeGateCtx({ cwd: dir });
		const result = await handleGateInput("review this code", ctx);
		assert.equal(result.action, "handled");
		assert.equal(dispatchCalls.length, 1, "gate dispatch called");
		assert.equal(dispatchCalls[0].agent, "reviewer", "C3: config agent = spawned agent");
		assert.equal(dispatchCalls[0].task, "review this code", "task passed through");
		assert.equal(dispatchCalls[0].source, "built-in", "source is built-in");
		// Negative control: delete config → no dispatch
		await fs.unlink(path.join(dir, ".pi", "intent-workflows.json"));
		dispatchCalls = [];
		const result2 = await handleGateInput("review this code", ctx);
		assert.equal(result2.action, "continue", "pass-through when no config");
		assert.equal(dispatchCalls.length, 0, "no dispatch without config");
	});
}

// REQ-SEC-3: NL-routed prompts always confirm
async function testGate_nlRoutingAlwaysConfirms() {
	const intents = [{ id: "review", match: { phrases: ["review"] }, workflow: { kind: "review" } }];
	__gateDispatch.fn = async () => {};

	await withGateConfig(intents, async (dir) => {
		let confirmCalled = false;
		const ctx = makeGateCtx({ cwd: dir, confirm: async () => { confirmCalled = true; return true; } });
		await handleGateInput("review this", ctx);
		assert.equal(confirmCalled, true, "confirm always called for NL routing");
	});
}

// REQ-SEC-3: confirm declined → no child dispatch
async function testGate_nlRoutingConfirmDeclinedNoRun() {
	const intents = [{ id: "review", match: { phrases: ["review"] }, workflow: { kind: "review" } }];
	let dispatchCalled = false;
	__gateDispatch.fn = async () => { dispatchCalled = true; };

	await withGateConfig(intents, async (dir) => {
		const ctx = makeGateCtx({ cwd: dir, confirm: async () => false });
		const result = await handleGateInput("review this", ctx);
		assert.equal(result.action, "continue");
		assert.equal(dispatchCalled, false, "no dispatch when confirm declined");
	});
}

// REQ-4 / REQ-SEC-2: config profile threaded structurally (not string interpolation)
async function testGate_configProfileFlagPrepended() {
	const intents = [{ id: "review", match: { phrases: ["review"] }, workflow: { kind: "review", profile: "security-profile" } }];
	let dispatchCalls = [];
	__gateDispatch.fn = async (agent, task, ctx, source, profile) => { dispatchCalls.push({ agent, task, source, profile }); };

	await withGateConfig(intents, async (dir) => {
		const ctx = makeGateCtx({ cwd: dir });
		await handleGateInput("review this code", ctx);
		assert.equal(dispatchCalls.length, 1);
		assert.equal(dispatchCalls[0].profile, "security-profile", "profile passed structurally to dispatch");
	});
}

// REQ-5 / REQ-SEC-4: plan-only injects code-owned instruction
async function testGate_nlPlanOnlyInjectsInstruction() {
	const intents = [{ id: "plan", match: { phrases: ["create a plan"] }, workflow: { kind: "plan-only" } }];

	await withGateConfig(intents, async (dir) => {
		const ctx = makeGateCtx({ cwd: dir });
		const result = await handleGateInput("create a plan for the migration", ctx);
		assert.equal(result.action, "transform");
		assert.ok(result.text.includes(GATE_INSTRUCTIONS.PLAN_ONLY), "instruction text injected");
		assert.ok(result.text.includes("create a plan for the migration"), "original prompt preserved");
	});
}

// REQ-5 / REQ-SEC-4: instruction text is code-owned (matches GATE_INSTRUCTIONS constant)
async function testGate_planOnlyInstructionIsCodeOwned() {
	const intents = [{ id: "plan", match: { phrases: ["make a plan"] }, workflow: { kind: "plan-only" } }];

	await withGateConfig(intents, async (dir) => {
		const ctx = makeGateCtx({ cwd: dir });
		const result = await handleGateInput("make a plan for this", ctx);
		assert.equal(result.action, "transform");
		// Instruction text matches code-owned constant, not config-supplied
		assert.equal(result.text.startsWith(GATE_INSTRUCTIONS.PLAN_ONLY), true,
			"injected instruction must match the code-owned constant");
		// Negative control: if we hardcoded different text, test catches it
		assert.ok(!result.text.startsWith("Config-supplied-instruction"),
			"instruction is not config-supplied");
	});
}

// REQ-SEC-5: gate-routed children must disable context files
async function testGate_routedChildDisablesContextFiles() {
	const intents = [{ id: "review", match: { phrases: ["review"] }, workflow: { kind: "review" } }];
	let capturedCtx = null;
	__gateDispatch.fn = async (agent, task, ctx) => { capturedCtx = ctx; };

	await withGateConfig(intents, async (dir) => {
		const ctx = makeGateCtx({ cwd: dir });
		await handleGateInput("review this", ctx);
		assert.equal(capturedCtx.disableContextFiles, true, "disableContextFiles set on ctx");
		// Negative control: without a matching config, ctx is unchanged
		capturedCtx = null;
		await fs.unlink(path.join(dir, ".pi", "intent-workflows.json"));
		const ctx2 = makeGateCtx({ cwd: dir });
		const result = await handleGateInput("review this", ctx2);
		assert.equal(result.action, "continue");
		assert.equal(ctx2.disableContextFiles, undefined, "disableContextFiles not set on pass-through");
	});
}

// REQ-11 / REQ-SEC-7: implementation intent requires confirm
async function testGate_implementationEnforcesConfirm() {
	const intents = [{ id: "impl", match: { phrases: ["implement"] }, workflow: { kind: "implementation" } }];

	await withGateConfig(intents, async (dir) => {
		let confirmCalled = false;
		let dispatchCalled = false;
		__gateDispatch.fn = async () => { dispatchCalled = true; };

		// confirm → dispatch called
		const ctx = makeGateCtx({ cwd: dir, confirm: async () => { confirmCalled = true; return true; } });
		await handleGateInput("implement this feature", ctx);
		assert.equal(confirmCalled, true, "confirm called for implementation");
		assert.equal(dispatchCalled, true, "dispatch called after confirm");

		// decline → no dispatch
		confirmCalled = false; dispatchCalled = false;
		await fs.writeFile(path.join(dir, ".pi", "intent-workflows.json"), JSON.stringify({ version: 1, intents }), "utf-8");
		__gateDispatch.fn = _origGateDispatch; // reset
		__gateDispatch.fn = async () => { dispatchCalled = true; };
		const ctx2 = makeGateCtx({ cwd: dir, confirm: async () => { confirmCalled = true; return false; } });
		const result = await handleGateInput("implement this feature", ctx2);
		assert.equal(confirmCalled, true, "confirm called on decline path too");
		assert.equal(result.action, "continue", "pass-through after decline");
		assert.equal(dispatchCalled, false, "no dispatch after confirm declined");
	});
}

// ── Main ──

async function main() {
	// Config loading (7)
	await testGate_configValid();
	await testGate_configMissingSkips();
	await testGate_configInvalidSkips();
	await testGate_untrustedProjectConfigIgnored();
	await testGate_configInlineModelRejected();
	await testGate_configInlineModelEntryLevelRejected();
	await testGate_configUnknownKindRejected();

	// Phrase matching (7)
	await testGate_phraseMatch();
	await testGate_noMatchPassesThrough();
	await testGate_skipsCommands();
	testGate_emptyPromptPassesThrough();
	await testGate_ambiguityPassesThrough();
	await testGate_planOnlyInjectsInstruction();
	await testGate_implementationConfirm();

	// P7-2 Gate + hook wiring (7)
	await testGate_reviewRoutesToAgent();
	await testGate_nlRoutingAlwaysConfirms();
	await testGate_nlRoutingConfirmDeclinedNoRun();
	await testGate_configProfileFlagPrepended();
	await testGate_nlPlanOnlyInjectsInstruction();
	await testGate_planOnlyInstructionIsCodeOwned();
	await testGate_routedChildDisablesContextFiles();
	await testGate_implementationEnforcesConfirm();

	console.log("OK: 22/22 tests passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
