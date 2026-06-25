import assert from "node:assert/strict";
import {
	BUILT_IN_PROMPT_TARGET_CHARS,
	DEFAULT_LIMITS,
	DEFAULT_SAFETY,
	P3_FORBIDDEN_TOOLS,
	P3_READONLY_TOOLS,
	RESERVED_BUILT_IN_AGENT_NAMES,
	THINKING_LEVELS,
	extractThinkingFromModel,
	formatBuiltInAgentList,
	getBuiltInAgentSpec,
	isReservedBuiltInAgentName,
	isValidAgentName,
	listBuiltInAgentSpecs,
	validateAgentName,
	validateAgentSpec,
	validateBuiltInAgentSpecs,
	validateModelAndThinking,
	validateOutputContract,
	validateTools,
	validateContextProviders,
	resolveSpecContextProviders,
} from "../lib/specs.ts";
import { AGENT_MARKDOWN_ACCEPTED_KEYS } from "../lib/agent-markdown.ts";

function codes(result) {
	return result.issues.map((issue) => issue.code);
}

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function testBuiltInSpecsAreValidAndOrdered() {
	const specs = listBuiltInAgentSpecs();
	assert.deepEqual(specs.map((spec) => spec.name), RESERVED_BUILT_IN_AGENT_NAMES);
	assert.equal(specs.length, 3);
	assert.equal(validateBuiltInAgentSpecs().ok, true);

	for (const spec of specs) {
		assert.equal(spec.source, "built-in");
		assert.deepEqual(spec.tools, P3_READONLY_TOOLS);
		assert.deepEqual(spec.safety.forbiddenTools, P3_FORBIDDEN_TOOLS);
		assert.equal(spec.safety.allowRecursiveSubagents, false);
		assert.equal(spec.safety.redactDisplayedCommand, true);
		assert.equal(spec.observability.persistByDefault, false);
		assert.equal(spec.observability.storeFullPrompt, false);
		assert.equal(spec.observability.storeFullTask, false);
		assert.equal(spec.limits.maxTaskChars, DEFAULT_LIMITS.maxTaskChars);
		assert.ok(spec.prompt.length <= BUILT_IN_PROMPT_TARGET_CHARS, `${spec.name} prompt exceeds built-in prompt target`);
		assert.match(spec.prompt, /child Pi subagent/);
		assert.match(spec.prompt, /Do not modify files/);
		assert.match(spec.prompt, /Do not spawn subagents/);
		assert.ok(spec.evals.length >= 1, `${spec.name} should declare eval metadata`);
		assert.equal(getBuiltInAgentSpec(spec.name), spec);
		assert.equal(isReservedBuiltInAgentName(spec.name), true);
	}
}

function testRoleSpecificContracts() {
	assert.deepEqual(getBuiltInAgentSpec("scout").outputContract.requiredSections, [
		"Files/paths inspected",
		"Concise findings",
		"Unknowns/follow-up questions",
	]);
	assert.deepEqual(getBuiltInAgentSpec("planner").outputContract.requiredSections, [
		"Proposed files to change",
		"Staged steps",
		"Risks",
		"Validation commands",
		"Out-of-scope items",
	]);
	assert.deepEqual(getBuiltInAgentSpec("reviewer").outputContract.requiredSections, [
		"Blocking issues",
		"Non-blocking issues",
		"Missing tests/validation",
		"Safety/security concerns",
		"Verdict",
	]);
	assert.deepEqual(getBuiltInAgentSpec("reviewer").outputContract.verdicts, ["go", "conditional-go", "no-go"]);
	assert.equal(getBuiltInAgentSpec("missing"), undefined);
}

function testNameValidation() {
	for (const name of ["a", "agent-1", "agent_name", "a".repeat(64)]) {
		assert.equal(isValidAgentName(name), true, `${name} should be valid`);
		assert.equal(validateAgentName(name).ok, true);
	}
	for (const name of ["", "Agent", "1agent", "agent.name", "agent name", "a".repeat(65)]) {
		assert.equal(isValidAgentName(name), false, `${name} should be invalid`);
		assert.equal(validateAgentName(name).ok, false);
	}
}

function testToolValidation() {
	assert.equal(validateTools(P3_READONLY_TOOLS, { readonlyOnly: true }).ok, true);
	assert.ok(codes(validateTools([], { readonlyOnly: true })).includes("tools-required"));
	assert.ok(codes(validateTools(["read", "read"], { readonlyOnly: true })).includes("tool-duplicate"));
	assert.ok(codes(validateTools(["bash"], { readonlyOnly: true })).includes("tool-forbidden"));
	assert.ok(codes(validateTools(["write"], { readonlyOnly: true })).includes("tool-forbidden"));
	assert.ok(codes(validateTools(["run_subagent"], { readonlyOnly: true })).includes("tool-forbidden"));
	assert.ok(codes(validateTools(["web_search"], { readonlyOnly: true })).includes("tool-not-readonly"));
	assert.ok(codes(validateTools(["BadTool"], { readonlyOnly: true })).includes("tool-invalid"));
}

function testModelThinkingValidation() {
	assert.deepEqual(THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh"]);
	assert.equal(validateModelAndThinking(undefined, undefined).ok, true);
	assert.equal(validateModelAndThinking("sonnet", "high").ok, true);
	assert.equal(validateModelAndThinking("anthropic/claude-sonnet:high", "high").ok, true);
	assert.equal(extractThinkingFromModel("anthropic/claude-sonnet:high"), "high");
	assert.equal(extractThinkingFromModel("anthropic/claude-sonnet:latest"), undefined);
	assert.ok(codes(validateModelAndThinking("anthropic/claude sonnet", undefined)).includes("model-invalid"));
	assert.ok(codes(validateModelAndThinking("sonnet", "turbo")).includes("thinking-invalid"));
	assert.ok(codes(validateModelAndThinking("sonnet:high", "medium")).includes("thinking-conflicts-with-model"));
}

function testOutputContractValidation() {
	assert.equal(validateOutputContract({ requiredSections: ["A", "B"], maxSummaryChars: 100 }).ok, true);
	assert.equal(validateOutputContract({ requiredSections: ["A"], maxSummaryChars: 100, verdicts: ["go", "no-go"] }).ok, true);
	assert.ok(codes(validateOutputContract({ requiredSections: [], maxSummaryChars: 100 })).includes("required-sections-missing"));
	assert.ok(codes(validateOutputContract({ requiredSections: ["A", " a "], maxSummaryChars: 100 })).includes("required-section-duplicate"));
	assert.ok(codes(validateOutputContract({ requiredSections: ["A"], maxSummaryChars: 0 })).includes("max-summary-invalid"));
	assert.ok(codes(validateOutputContract({ requiredSections: ["A"], maxSummaryChars: 100, verdicts: ["go", "GO"] })).includes("verdict-duplicate"));
}

function testWholeSpecValidationCatchesMutations() {
	const invalid = clone(getBuiltInAgentSpec("scout"));
	invalid.name = "Scout";
	invalid.source = { toString: () => "built-in" };
	invalid.tools = ["read", "bash"];
	invalid.thinking = "turbo";
	invalid.outputContract.requiredSections = [];
	invalid.safety.allowRecursiveSubagents = true;
	invalid.safety.forbiddenTools = ["write"];
	const invalidCodes = codes(validateAgentSpec(invalid));
	assert.ok(invalidCodes.includes("name-invalid"));
	assert.ok(invalidCodes.includes("source-invalid"));
	assert.ok(invalidCodes.includes("tool-forbidden"));
	assert.ok(invalidCodes.includes("thinking-invalid"));
	assert.ok(invalidCodes.includes("required-sections-missing"));
	assert.ok(invalidCodes.includes("recursion-invalid"));
	assert.ok(invalidCodes.includes("forbidden-tool-missing"));
}

function testSafetyPolicyValidationAndImmutability() {
	assert.equal(Object.isFrozen(DEFAULT_SAFETY), true);
	assert.equal(Object.isFrozen(DEFAULT_SAFETY.forbiddenTools), true);
	assert.deepEqual(DEFAULT_SAFETY.forbiddenTools, P3_FORBIDDEN_TOOLS);

	const invalid = clone(getBuiltInAgentSpec("planner"));
	invalid.safety.forbiddenTools = ["write", "write", "BadTool"];
	const invalidCodes = codes(validateAgentSpec(invalid));
	assert.ok(invalidCodes.includes("forbidden-tool-duplicate"));
	assert.ok(invalidCodes.includes("forbidden-tool-invalid"));
	assert.ok(invalidCodes.includes("forbidden-tool-missing"));
}

function testBuiltInListFormatting() {
	const formatted = formatBuiltInAgentList();
	assert.match(formatted, /scout: Read-only codebase reconnaissance/);
	assert.match(formatted, /planner: Implementation or validation planning/);
	assert.match(formatted, /reviewer: Adversarial review/);
	assert.match(formatted, /tools=read,grep,find,ls/);
}

// P9: built-in context: declarations + validation + N4 (frontmatter must NOT accept context)
function testContextProviderDeclarations() {
	// Built-in declared sets.
	assert.deepEqual(resolveSpecContextProviders(getBuiltInAgentSpec("reviewer")), ["git-diff", "changed-files", "branch-commits", "plan-docs"]);
	assert.deepEqual(resolveSpecContextProviders(getBuiltInAgentSpec("planner")), ["plan-docs", "changed-files"]);
	assert.deepEqual(resolveSpecContextProviders(getBuiltInAgentSpec("scout")), []);

	// Validation: undefined ok, valid array ok.
	assert.deepEqual(codes(validateContextProviders(undefined)), []);
	assert.deepEqual(codes(validateContextProviders(["git-diff", "plan-docs"])), []);
	// Unknown id rejected.
	assert.deepEqual(codes(validateContextProviders(["git-diff", "bogus"])), ["context-unknown"]);
	// Duplicate rejected.
	assert.deepEqual(codes(validateContextProviders(["git-diff", "git-diff"])), ["context-duplicate"]);
	// Non-array rejected.
	assert.deepEqual(codes(validateContextProviders("git-diff")), ["context-invalid"]);

	// Whole-spec validation surfaces a bad context field.
	const spec = clone(getBuiltInAgentSpec("reviewer"));
	spec.context = ["nope"];
	assert.ok(codes(validateAgentSpec(spec)).includes("context-unknown"), "validateAgentSpec catches bad context");

	// N4: agent-markdown frontmatter must NOT accept `context` (no trust-expanding compel-git-from-project).
	assert.ok(!AGENT_MARKDOWN_ACCEPTED_KEYS.includes("context"), "context is not a frontmatter-accepted key in v1");

	// Built-in specs (with their context fields) still pass full validation.
	assert.equal(validateBuiltInAgentSpecs().ok, true, "built-in specs valid incl. context");
}

function main() {
	testContextProviderDeclarations();
	testBuiltInSpecsAreValidAndOrdered();
	testRoleSpecificContracts();
	testNameValidation();
	testToolValidation();
	testModelThinkingValidation();
	testOutputContractValidation();
	testWholeSpecValidationCatchesMutations();
	testSafetyPolicyValidationAndImmutability();
	testBuiltInListFormatting();
	console.log("agents spec tests passed");
}

main();
