// SCHEMA1-A+C tests (plan catalog groups 1, 2, 6):
// .plans/SCHEMA/SCHEMA1_AGENTS_RUN_PLAN.md Appendix B
// Group 1: schemaDeclaresAllBounds
// Group 2: validateRejectsEachBadInput (EC-driven, exact reason strings)
// Group 6: subagentSchemaDeclaresBounds (REQ-6, slice C)
// BREAK_VALIDATE=1 flips one expectation so a validation that wrongly passes
// goes red — the runner's negative control depends on this file failing.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	AGENTS_RUN_AGENT_RE,
	AGENTS_RUN_REF_RE,
	AGENTS_RUN_RANGE_RE,
	AGENTS_RUN_TASK_MAX_CHARS,
	AGENTS_RUN_CHAIN_MAX,
	buildAgentsRunToolDefinition,
	validateAgentsRunInput,
} from "../lib/agents-run-tool.ts";
import { MAX_CHAIN_LENGTH } from "../lib/chain-runner.ts";
import { buildSubagentToolDefinition } from "../lib/subagent-tool.ts";

const AGENT_PATTERN_SOURCE = "^[A-Za-z][A-Za-z0-9._-]{0,127}$";
const REF_PATTERN_SOURCE = "^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$";
const RANGE_PATTERN_SOURCE = "^[A-Za-z0-9][A-Za-z0-9._/-]{2,}\\.\\.[A-Za-z0-9][A-Za-z0-9._/-]{2,}$";

test("schemaDeclaresAllBounds", () => {
	const def = buildAgentsRunToolDefinition();
	assert.equal(def.name, "agents_run");
	const params = def.parameters;
	assert.equal(params.type, "object");
	assert.equal(params.additionalProperties, false);
	assert.deepEqual([...params.required], ["agent", "task"]);
	const props = params.properties;

	// mode: StringEnum run|bg|chain, default "run" (REQ-1)
	assert.deepEqual([...props.mode.enum], ["run", "bg", "chain"]);
	assert.equal(props.mode.default, "run");

	// agent: required, pattern (REQ-1)
	assert.equal(props.agent.type, "string");
	assert.equal(props.agent.pattern, AGENT_PATTERN_SOURCE);

	// task: required, maxLength 8000 (REQ-1)
	assert.equal(props.task.type, "string");
	assert.equal(props.task.maxLength, 8000);

	// timeout_s: integer 1..3600 (REQ-1; mirrors parseLeadingRunFlags)
	assert.equal(props.timeout_s.type, "integer");
	assert.equal(props.timeout_s.minimum, 1);
	assert.equal(props.timeout_s.maximum, 3600);

	// profile/backend: same pattern family as agent (REQ-1)
	assert.equal(props.profile.pattern, AGENT_PATTERN_SOURCE);
	assert.equal(props.backend.pattern, AGENT_PATTERN_SOURCE);

	// base/range: ref patterns (prefilters; isSafeGitRef stays the boundary)
	assert.equal(props.base.pattern, REF_PATTERN_SOURCE);
	assert.equal(props.range.pattern, RANGE_PATTERN_SOURCE);

	// chain: array 2..MAX_CHAIN_LENGTH of agent-pattern strings. The advertised
	// bound IS the runner's enforced bound — the schema used to say 8 while the
	// relay capped at 3, which cost a model a wasted turn discovering it.
	assert.equal(props.chain.type, "array");
	assert.equal(props.chain.minItems, 2);
	assert.equal(props.chain.maxItems, MAX_CHAIN_LENGTH);
	assert.equal(props.chain.maxItems, AGENTS_RUN_CHAIN_MAX);
	assert.equal(props.chain.items.type, "string");
	assert.equal(props.chain.items.pattern, AGENT_PATTERN_SOURCE);
	assert.match(props.chain.description, new RegExp(`2\\.\\.${MAX_CHAIN_LENGTH} agent names`));

	// Constants agree with the declared schema bounds (no silent drift).
	assert.equal(AGENTS_RUN_AGENT_RE.source, AGENT_PATTERN_SOURCE);
	assert.equal(AGENTS_RUN_REF_RE.source, REF_PATTERN_SOURCE);
	assert.equal(AGENTS_RUN_RANGE_RE.source, RANGE_PATTERN_SOURCE);
	assert.equal(AGENTS_RUN_TASK_MAX_CHARS, 8000);
});

test("validateRejectsEachBadInput", () => {
	// State B: bad agent (EC1 "--flag"; also empty)
	assert.deepEqual(
		validateAgentsRunInput({ mode: "run", agent: "--flag", task: "ok" }),
		{ ok: false, reason: "agent must be a safe identifier" },
	);
	assert.deepEqual(
		validateAgentsRunInput({ agent: "", task: "ok" }),
		{ ok: false, reason: "agent must be a safe identifier" },
	);

	// State H: type confusion before any regex (EC8/EC9 — never coerce)
	assert.deepEqual(
		validateAgentsRunInput({ agent: 12345, task: "ok" }),
		{ ok: false, reason: "agent must be a string" },
	);
	assert.deepEqual(
		validateAgentsRunInput({ agent: "scout", task: { nested: "x" } }),
		{ ok: false, reason: "task must be a string" },
	);
	assert.deepEqual(
		validateAgentsRunInput({ agent: "scout", task: "ok", timeout_s: "60" }),
		{ ok: false, reason: "timeout_s must be an integer" },
	);
	assert.deepEqual(
		validateAgentsRunInput({ agent: "scout", task: "ok", timeout_s: 1.5 }),
		{ ok: false, reason: "timeout_s must be an integer" },
	);
	assert.deepEqual(
		validateAgentsRunInput({ agent: "scout", task: "ok", profile: 7 }),
		{ ok: false, reason: "profile must be a string" },
	);
	assert.deepEqual(
		validateAgentsRunInput({ agent: "scout", task: "ok", backend: false }),
		{ ok: false, reason: "backend must be a string" },
	);
	assert.deepEqual(
		validateAgentsRunInput({ agent: "scout", task: "ok", base: 12 }),
		{ ok: false, reason: "base must be a string" },
	);
	assert.deepEqual(
		validateAgentsRunInput({ agent: "scout", task: "ok", range: {} }),
		{ ok: false, reason: "range must be a string" },
	);
	assert.deepEqual(
		validateAgentsRunInput({ agent: "scout", task: "ok", chain: "scout,planner" }),
		{ ok: false, reason: "chain must be an array" },
	);
	assert.deepEqual(
		validateAgentsRunInput({ agent: "scout", task: "ok", chain: ["scout", 99] }),
		{ ok: false, reason: "chain must be an array of strings" },
	);

	// State C: bad task (empty, control chars EC7, over 8000)
	assert.deepEqual(
		validateAgentsRunInput({ agent: "scout", task: "   " }),
		{ ok: false, reason: "task must not be empty or whitespace-only" },
	);
	assert.deepEqual(
		validateAgentsRunInput({ agent: "scout", task: "a\x00b" }),
		{ ok: false, reason: "task contains control characters (NUL or other control bytes)" },
	);
	assert.deepEqual(
		validateAgentsRunInput({ agent: "scout", task: "x".repeat(8001) }),
		{ ok: false, reason: "task exceeds maxTaskChars (8000)" },
	);

	// State D: timeout out of range (EC2 3601; also 0)
	assert.deepEqual(
		validateAgentsRunInput({ agent: "scout", task: "ok", timeout_s: 3601 }),
		{ ok: false, reason: "timeout_s must be an integer 1..3600" },
	);
	assert.deepEqual(
		validateAgentsRunInput({ agent: "scout", task: "ok", timeout_s: 0 }),
		{ ok: false, reason: "timeout_s must be an integer 1..3600" },
	);

	// State E: bad chain (EC6 single entry; over the cap; entry fails agent pattern)
	assert.deepEqual(
		validateAgentsRunInput({ agent: "scout", task: "ok", mode: "chain", chain: ["scout"] }),
		{ ok: false, reason: "chain requires 2..3 safe agent names" },
	);
	// One over the enforced cap must be rejected at the SCHEMA, not discovered
	// later as a runtime denial.
	assert.deepEqual(
		validateAgentsRunInput({ agent: "scout", task: "ok", mode: "chain", chain: Array.from({ length: 4 }, () => "scout") }),
		{ ok: false, reason: "chain requires 2..3 safe agent names" },
	);
	// The old over-cap sample stays rejected (9 entries).
	assert.deepEqual(
		validateAgentsRunInput({ agent: "scout", task: "ok", mode: "chain", chain: Array.from({ length: 9 }, () => "scout") }),
		{ ok: false, reason: "chain requires 2..3 safe agent names" },
	);
	// Exactly at the cap must be ACCEPTED (guards against off-by-one in the fix).
	assert.deepEqual(
		validateAgentsRunInput({ agent: "scout", task: "ok", mode: "chain", chain: ["a-one", "b-two", "c-three"] }),
		{ ok: true, mode: "chain", agent: "scout", task: "ok", chain: ["a-one", "b-two", "c-three"] },
	);
	assert.deepEqual(
		validateAgentsRunInput({ agent: "scout", task: "ok", mode: "chain", chain: ["scout", "--bad"] }),
		{ ok: false, reason: "chain requires 2..3 safe agent names" },
	);

	// State F: bad refs (base with space; range without "..")
	assert.deepEqual(
		validateAgentsRunInput({ agent: "scout", task: "ok", base: "main branch" }),
		{ ok: false, reason: "invalid git ref: base" },
	);
	assert.deepEqual(
		validateAgentsRunInput({ agent: "scout", task: "ok", range: "main" }),
		{ ok: false, reason: "invalid git ref: range" },
	);

	// State G: bad mode
	assert.deepEqual(
		validateAgentsRunInput({ agent: "scout", task: "ok", mode: "do" }),
		{ ok: false, reason: "mode must be run|bg|chain" },
	);

	// Non-object params (fail closed)
	assert.deepEqual(
		validateAgentsRunInput(null),
		{ ok: false, reason: "params must be an object" },
	);
	assert.deepEqual(
		validateAgentsRunInput("scout"),
		{ ok: false, reason: "params must be an object" },
	);

	// State A: happy paths — mode default, optional fields preserved
	assert.equal(validateAgentsRunInput({ agent: "scout", task: "ok" }).ok, true);
	const full = validateAgentsRunInput({
		mode: "bg",
		agent: "my-agent",
		task: "ok",
		timeout_s: 60,
		profile: "code.fast",
		backend: "tmux-main",
		base: "main",
		range: "v1.0.0..v1.2.0",
		chain: ["scout", "planner"],
	});
	assert.equal(full.ok, true);
	if (full.ok) {
		assert.equal(full.mode, "bg");
		assert.equal(full.agent, "my-agent");
		assert.equal(full.timeout_s, 60);
		assert.equal(full.profile, "code.fast");
		assert.equal(full.backend, "tmux-main");
		assert.equal(full.base, "main");
		assert.equal(full.range, "v1.0.0..v1.2.0");
		assert.deepEqual([...full.chain], ["scout", "planner"]);
	}

	if (process.env.BREAK_VALIDATE === "1") {
		// Negative-control flip (runner expects this run to exit non-zero):
		// assert a known-VALID input is rejected. On correct validation code
		// this assertion fails, proving the suite actually gates on validate.
		const good = validateAgentsRunInput({ agent: "scout", task: "ok" });
		assert.equal(good.ok, false, "negative control: must fail on correct code");
	}
});

test("subagentSchemaDeclaresBounds", () => {
	// REQ-6 / slice C: run_subagent's emitted schema declares the bounds its
	// runtime already enforces (pattern on agent, maxLength on task).
	const params = buildSubagentToolDefinition().parameters;
	assert.equal(params.properties.agent.pattern, AGENT_PATTERN_SOURCE);
	assert.equal(params.properties.task.maxLength, 8000);
});
