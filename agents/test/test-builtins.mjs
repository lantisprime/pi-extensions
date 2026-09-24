// BUILTINS roster tests (plan catalog groups 1-2): .plans/SCHEMA/BUILTINS_PLAN.md
// Group 1: reservedNamesIncludeAllEight, specContractMatchesPrompt
// Group 2: methodFilesLoadAndMatchContracts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	RESERVED_BUILT_IN_AGENT_NAMES,
	P3_READONLY_TOOLS,
	listBuiltInAgentSpecs,
} from "../lib/specs.ts";
import { PROMPT_FILES, loadAgentMethod } from "../lib/prompts.ts";

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
