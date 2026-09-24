// BUILTINS tests (plan catalog groups 1-4): .plans/SCHEMA/BUILTINS_PLAN.md
// Group 1: reservedNamesIncludeAllEight, specContractMatchesPrompt
// Group 2: methodFilesLoadAndMatchContracts
// Group 3: routingDispatchesNewBuiltins, intentRouterRoutesNewRoles (BUILTINS-C)
// Group 4: diagnosticsListAllBuiltins (BUILTINS-C)
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	RESERVED_BUILT_IN_AGENT_NAMES,
	P3_READONLY_TOOLS,
	listBuiltInAgentSpecs,
} from "../lib/specs.ts";
import { PROMPT_FILES, loadAgentMethod } from "../lib/prompts.ts";
import { executeSubagentRun } from "../lib/subagent-tool.ts";
import { classifyIntentHeuristic } from "../lib/intent-router.ts";
import { formatAgentsConfig } from "../lib/diagnostics.ts";

const NEW_ROLES = ["architect", "builder", "orchestrator", "researcher", "test-architect"];

test("reservedNamesIncludeAllEight", async (t) => {
	assert.equal(RESERVED_BUILT_IN_AGENT_NAMES.length, 8, "roster must be exactly 8");
	for (const name of ["scout", "planner", "reviewer", ...NEW_ROLES]) {
		assert(
			RESERVED_BUILT_IN_AGENT_NAMES.includes(name),
			`roster must include ${name}`,
		);
	}
	// Discriminating negative control: the retired name must NOT be present.
	assert.equal(RESERVED_BUILT_IN_AGENT_NAMES.includes("tester"), false, "old name 'tester' must be absent");
});

test("specContractMatchesPrompt", async (t) => {
	const specs = listBuiltInAgentSpecs();
	for (const name of NEW_ROLES) {
		const spec = specs.find((s) => s.name === name);
		assert(spec, `spec entry exists for ${name}`);
		if (!spec) continue;
		assert.deepEqual([...spec.tools], [...P3_READONLY_TOOLS], `${name} read-only tools`);
		assert(spec.source === "built-in", `${name} source`);
		assert(
			spec.instructionsFile === PROMPT_FILES[name],
			`${name} instructionsFile matches PROMPT_FILES key (${spec.instructionsFile} vs ${PROMPT_FILES[name]})`,
		);
		assert(
			spec.prompt.length <= 2048,
			`${name} inline prompt <= BUILT_IN_PROMPT_TARGET_CHARS (got ${spec.prompt.length})`,
		);
	}
});

test("methodFilesLoadAndMatchContracts", async (t) => {
	for (const name of ["scout", "planner", "reviewer", ...NEW_ROLES]) {
		const text = await loadAgentMethod(name);
		assert(text && text.length > 0, `${name} method loads non-empty`);
	}
	// Contract ↔ method-file cross-check: each new spec's required sections
	// appear verbatim in its method file's Output discipline.
	const specs = listBuiltInAgentSpecs();
	for (const name of NEW_ROLES) {
		const spec = specs.find((s) => s.name === name);
		const text = await loadAgentMethod(name);
		for (const section of spec?.outputContract.requiredSections ?? []) {
			assert(
				text.includes(section),
				`${name} method file must name required section "${section}"`,
			);
		}
	}
	// Boundary lines (role-drift guard, plan Safety table)
	const boundaries = {
		architect: "you do not stage implementation steps",
		builder: "cannot write, edit, or run anything",
		orchestrator: "You do not spawn agents",
		researcher: "Scout answers a bounded",
		"test-architect": "you never run them",
	};
	for (const [name, phrase] of Object.entries(boundaries)) {
		const text = await loadAgentMethod(name);
		assert(text.includes(phrase), `${name} states its boundary vs neighbors`);
	}
});

// ========== Group 3: routing/wiring (2) ==========

// Minimal completed ChildAgentRunResult (same shape as the fixture harness).
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

test("routingDispatchesNewBuiltins", async () => {
	// REQ-4: every reserved built-in (incl. the five new roles) routes through
	// the built-in dispatch seam with the sentinel task text. instructionsFile
	// ↔ spec wiring is asserted by specContractMatchesPrompt/methodFiles tests.
	for (const name of RESERVED_BUILT_IN_AGENT_NAMES) {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), `builtins-route-${name}-`));
		try {
			const calls = [];
			const result = await executeSubagentRun(name, `sentinel-${name}`, {
				cwd,
				projectTrusted: false,
				childRunner: async (agent, task) => {
					calls.push({ agent, task });
					return makeCompleteResult(typeof agent === "string" ? agent : agent.name);
				},
			});
			assert.equal(result.isError, false, `${name} dispatches without error: ${result.text}`);
			assert.equal(calls.length, 1, `${name} routes exactly one child run`);
			assert.equal(calls[0].agent, name, `${name} reaches the child runner by name`);
			assert.ok(
				calls[0].task.includes(`sentinel-${name}`),
				`${name} task text reaches the child (context bundle may augment)`,
			);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}
});

test("intentRouterRoutesNewRoles", () => {
	// REQ-5: each new role wins on its own keywords (exact plan keyword sets).
	const cases = [
		["architect", "design the system interface for the auth module"],
		["builder", "implement the patch and draft the module"],
		["orchestrator", "orchestrate the delegation of these tasks"],
		["researcher", "investigate the failing flow and synthesize findings"],
		["test-architect", "assertions and coverage for the new module"],
	];
	for (const [role, task] of cases) {
		const d = classifyIntentHeuristic(task, []);
		assert.equal(d.agent, role, `"${task}" routes to ${role}, got ${d.agent} (${d.reason})`);
	}
	// Legacy behavior preserved: a genuine legacy tie (review 3 vs plan 3)
	// still resolves by TIE_ORDER (reviewer before planner).
	assert.equal(classifyIntentHeuristic("review and plan", []).agent, "reviewer");
});

// ========== Group 4: strings (1) ==========

test("diagnosticsListAllBuiltins", () => {
	// REQ-6: the config/usage diagnostics line names all eight built-ins
	// (derived from RESERVED_BUILT_IN_AGENT_NAMES, so drift fails here).
	const diag = {
		cwd: "/x", projectRoot: "/x", projectTrusted: false, userAgentsDir: "/x",
		projectAgentsDir: "/x", userRegistryPath: "/x", projectRegistryPath: "/x",
		projectRegistryRootOk: true, projectRegistryRootIssues: [],
		userRegistry: { agents: [] }, projectRegistry: { agents: [] },
		records: [], registryOnlyEntries: [], summary: {},
	};
	const text = formatAgentsConfig(diag);
	for (const name of RESERVED_BUILT_IN_AGENT_NAMES) {
		assert.ok(text.includes(name), `formatAgentsConfig lists built-in ${name}`);
	}
});
