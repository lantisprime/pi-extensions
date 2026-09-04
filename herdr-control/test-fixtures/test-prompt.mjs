// herdr-control: prompt/wait classification tests.
import assert from "node:assert/strict";
import { createFakeHerdr, okResult, errResult } from "./fake-herdr.ts";
import {
	AGENT_PROMPT_OK_JSON,
	ERR_BLOCKED,
	ERR_STALLED,
	ERR_TIMEOUT,
	ERR_NOT_RUNNING,
} from "./fixtures.ts";
import { promptAgent, clampPromptTimeout } from "../lib/prompt.ts";

assert.equal(clampPromptTimeout(undefined), 300_000, "default 5 minutes");
assert.equal(clampPromptTimeout(1), 5_000, "clamped to 5s minimum");
assert.equal(clampPromptTimeout(10_000_000), 600_000, "clamped to 10m maximum");

const T = "review the diff";

// success reads settled status from .result.agent.agent_status
{
	const fake = createFakeHerdr();
	fake.onSubcommand("agent", (args) => args[1] === "prompt" ? okResult(AGENT_PROMPT_OK_JSON) : errResult("x", 1));
	const out = await promptAgent(fake.executor, "pi-herdr-reviewer", T, 120_000);
	assert.deepEqual(out, { ok: true, status: "idle" });
	const [call] = fake.callsTo("agent");
	assert.deepEqual(call.slice(2), ["pi-herdr-reviewer", T, "--wait", "--timeout", "120000"]);
	assert.equal(fake.calls[0].opts.timeoutMs, 130_000, "exec timeout = wait timeout + 10s");
}

// no-wait mode omits --wait
{
	const fake = createFakeHerdr();
	fake.onSubcommand("agent", (args) => args[1] === "prompt" ? okResult(AGENT_PROMPT_OK_JSON) : errResult("x", 1));
	await promptAgent(fake.executor, "pi-herdr-reviewer", T, undefined, false);
	const [call] = fake.callsTo("agent");
	assert.deepEqual(call.slice(2), ["pi-herdr-reviewer", T], "no --wait/--timeout flags");
}

// blocked
{
	const fake = createFakeHerdr();
	fake.onSubcommand("agent", () => errResult(ERR_BLOCKED, 1));
	const out = await promptAgent(fake.executor, "a", T, 60_000);
	assert.deepEqual(out, { ok: false, kind: "blocked", error: "agent is blocked at a dialog" });
}

// stalled
{
	const fake = createFakeHerdr();
	fake.onSubcommand("agent", () => errResult(ERR_STALLED, 1));
	const out = await promptAgent(fake.executor, "a", T, 60_000);
	assert.equal(out.ok, false);
	assert.equal(out.kind, "stalled");
}

// timeout
{
	const fake = createFakeHerdr();
	fake.onSubcommand("agent", () => errResult(ERR_TIMEOUT, 1));
	const out = await promptAgent(fake.executor, "a", T, 60_000);
	assert.equal(out.ok, false);
	assert.equal(out.kind, "timeout");
}

// not running
{
	const fake = createFakeHerdr();
	fake.onSubcommand("agent", () => errResult(ERR_NOT_RUNNING, 1));
	const out = await promptAgent(fake.executor, "a", T, 60_000);
	assert.equal(out.ok, false);
	assert.equal(out.kind, "not-running");
}

// unknown error -> generic
{
	const fake = createFakeHerdr();
	fake.onSubcommand("agent", () => errResult("kaboom", 1));
	const out = await promptAgent(fake.executor, "a", T, 60_000);
	assert.equal(out.ok, false);
	assert.equal(out.kind, "error");
	assert.match(out.error, /kaboom/);
}

console.log("test-prompt: all tests passed");
