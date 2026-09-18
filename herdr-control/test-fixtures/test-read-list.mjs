// herdr-control: agent read + list/get tests.
import assert from "node:assert/strict";
import { createFakeHerdr, okResult, errResult } from "./fake-herdr.ts";
import { AGENT_LIST_JSON, AGENT_GET_JSON, ERR_NOT_IDLE } from "./fixtures.ts";
import { readAgent, keepTail, clampReadLines } from "../lib/read.ts";
import { listAgents, getAgent, formatAgent, agentsFromResult, agentFromGetResult } from "../lib/list.ts";

// read: plain text passthrough (not envelope), default source/lines
{
	const fake = createFakeHerdr();
	fake.onSubcommand("agent", (args) => args[1] === "read" ? okResult("line1\nline2\n") : errResult("x", 1));
	const out = await readAgent(fake.executor, "pi-herdr-reviewer");
	assert.equal(out.ok, true);
	if (out.ok) assert.equal(out.text, "line1\nline2\n");
	const [call] = fake.callsTo("agent");
	assert.deepEqual(call.slice(2), ["pi-herdr-reviewer", "--source", "recent-unwrapped", "--lines", "200"]);
}

// read: agent_not_idle classification
{
	const fake = createFakeHerdr();
	fake.onSubcommand("agent", () => errResult(ERR_NOT_IDLE, 1));
	const out = await readAgent(fake.executor, "a");
	assert.equal(out.ok, false);
	assert.equal(out.kind, "not-idle");
	assert.match(out.error, /wait for the agent to settle/);
}

// tail-keeping keeps the END (final answer lives at the bottom)
{
	const kept = keepTail("abcdefgh", 4);
	assert.equal(kept.text, "efgh");
	assert.equal(kept.truncated, true);
	assert.deepEqual(keepTail("ab", 10), { text: "ab", truncated: false });
}

assert.equal(clampReadLines(undefined), 200);
assert.equal(clampReadLines(0), 1);
assert.equal(clampReadLines(99_999), 1000);

// list parsing
{
	const agents = agentsFromResult(JSON.parse(AGENT_LIST_JSON).result);
	assert.equal(agents.length, 2);
	assert.equal(agents[0].agent, "claude");
	assert.equal(agents[1].agent_status, "working");
	assert.match(formatAgent(agents[1]), /pi  w9:p1  working/);
	assert.match(formatAgent(agents[1]), / \*$/, "focused marker");
}

{
	const agent = agentFromGetResult(JSON.parse(AGENT_GET_JSON).result);
	assert.equal(agent.pane_id, "w9:p3");
}

// listAgents / getAgent over the executor
{
	const fake = createFakeHerdr();
	fake.onSubcommand("agent", (args) => {
		if (args[1] === "list") return okResult(AGENT_LIST_JSON);
		if (args[1] === "get") return okResult(AGENT_GET_JSON);
		return errResult("x", 1);
	});
	const listed = await listAgents(fake.executor);
	assert.equal(listed.ok, true);
	const got = await getAgent(fake.executor, "pi-herdr-reviewer");
	assert.equal(got.ok, true);
	const bad = await getAgent(fake.executor, "ghost");
	assert.equal(bad.ok, true, "fake returns get for any target; error path covered by launch tests");
}

{
	const fake = createFakeHerdr();
	fake.onSubcommand("agent", () => errResult("server gone", 1));
	const listed = await listAgents(fake.executor);
	assert.equal(listed.ok, false);
	assert.match(listed.error, /server gone/);
}

console.log("test-read-list: all tests passed");
