import assert from "node:assert";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadGateConfig, classifyGateIntent } from "../lib/intent-gate.ts";

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

	console.log("OK: 14/14 tests passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
