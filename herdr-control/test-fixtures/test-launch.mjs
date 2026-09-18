// herdr-control: spawn pipeline tests (collision, layout, start, orphans).
import assert from "node:assert/strict";
import { createFakeHerdr, okResult, errResult } from "./fake-herdr.ts";
import {
	AGENT_LIST_JSON,
	AGENT_START_JSON,
	PANE_SPLIT_JSON,
	WORKSPACE_CREATE_JSON,
	PANE_LAYOUT_JSON,
	PANE_LAYOUT_TALL_JSON,
	ERR_NOT_READY,
} from "./fixtures.ts";
import { resolveDirection, createPane, spawnAgent } from "../lib/launch.ts";

const REQ = { name: "pi-herdr-reviewer", kind: "pi", cwd: "/tmp/x", direction: "auto", newWorkspace: false };

// resolveDirection: wide -> right, tall -> down, failure -> right
{
	const wide = createFakeHerdr();
	wide.onSubcommand("pane", () => okResult(PANE_LAYOUT_JSON));
	assert.equal(await resolveDirection(wide.executor), "right");
	const tall = createFakeHerdr();
	tall.onSubcommand("pane", () => okResult(PANE_LAYOUT_TALL_JSON));
	assert.equal(await resolveDirection(tall.executor), "down");
	const broken = createFakeHerdr();
	broken.onSubcommand("pane", () => errResult("boom", 1));
	assert.equal(await resolveDirection(broken.executor), "right");
}

// createPane: sibling split parses .result.pane.pane_id; args carry --no-focus + cwd
{
	const fake = createFakeHerdr();
	fake.onSubcommand("pane", () => okResult(PANE_SPLIT_JSON));
	const out = await createPane(fake.executor, REQ, "down");
	assert.equal(out.ok, true);
	assert.equal(out.paneId, "w9:p4");
	const [split] = fake.callsTo("pane");
	assert.deepEqual(split.slice(1), ["split", "--current", "--direction", "down", "--cwd", "/tmp/x", "--no-focus"]);
}

// createPane: workspace mode parses .result.root_pane.pane_id
{
	const fake = createFakeHerdr();
	fake.onSubcommand("workspace", () => okResult(WORKSPACE_CREATE_JSON));
	const out = await createPane(fake.executor, { ...REQ, newWorkspace: true }, "right");
	assert.equal(out.ok, true);
	assert.equal(out.paneId, "w12:p1");
	assert.equal(out.workspaceId, "w12");
	assert.equal(out.tabId, "w12:t1");
}

// full spawn: happy path
{
	const fake = createFakeHerdr();
	fake.onSubcommand("agent", (args) => {
		if (args[1] === "list") return okResult(AGENT_LIST_JSON);
		if (args[1] === "start") return okResult(AGENT_START_JSON);
		return errResult("unexpected", 1);
	});
	fake.onSubcommand("pane", (args) => args[1] === "split" ? okResult(PANE_SPLIT_JSON) : okResult(PANE_LAYOUT_JSON));
	const out = await spawnAgent(fake.executor, REQ);
	assert.equal(out.ok, true);
	if (out.ok) {
		assert.equal(out.name, "pi-herdr-reviewer");
		assert.equal(out.paneId, "w9:p4");
		assert.equal(out.status, "idle");
	}
	const start = fake.callsTo("agent").find((a) => a[1] === "start");
	assert.deepEqual(start.slice(2, 8), ["pi-herdr-reviewer", "--kind", "pi", "--pane", "w9:p4", "--timeout"]);
}

// spawn: collision fails at stage "collision" with no layout side effects
{
	const fake = createFakeHerdr();
	fake.onSubcommand("agent", (args) => args[1] === "list" ? okResult(AGENT_LIST_JSON) : errResult("unexpected", 1));
	const out = await spawnAgent(fake.executor, { ...REQ, name: "pi" }); // "pi" is live in AGENT_LIST_JSON
	assert.equal(out.ok, false);
	if (!out.ok) {
		assert.equal(out.stage, "collision");
		assert.match(out.error, /already live/);
	}
	assert.equal(fake.callsTo("pane").length, 0, "no pane created on collision");
}

// spawn: agent_not_ready -> single wait --until idle recovery
{
	const fake = createFakeHerdr();
	fake.onSubcommand("agent", (args) => {
		if (args[1] === "list") return okResult(AGENT_LIST_JSON);
		if (args[1] === "start") return errResult(ERR_NOT_READY, 1);
		if (args[1] === "wait") return okResult(AGENT_START_JSON);
		return errResult("unexpected", 1);
	});
	fake.onSubcommand("pane", (args) => args[1] === "split" ? okResult(PANE_SPLIT_JSON) : okResult(PANE_LAYOUT_JSON));
	const out = await spawnAgent(fake.executor, REQ);
	assert.equal(out.ok, true, "recovers via wait --until idle");
	const waits = fake.callsTo("agent").filter((a) => a[1] === "wait");
	assert.equal(waits.length, 1);
	assert.deepEqual(waits[0].slice(2), ["pi-herdr-reviewer", "--until", "idle", "--timeout", "30000"]);
}

// spawn: start failure after pane creation -> orphaned pane reported
{
	const fake = createFakeHerdr();
	fake.onSubcommand("agent", (args) => {
		if (args[1] === "list") return okResult(AGENT_LIST_JSON);
		if (args[1] === "start") return errResult("detection failed", 1);
		return errResult("unexpected", 1);
	});
	fake.onSubcommand("pane", (args) => args[1] === "split" ? okResult(PANE_SPLIT_JSON) : okResult(PANE_LAYOUT_JSON));
	const out = await spawnAgent(fake.executor, REQ);
	assert.equal(out.ok, false);
	if (!out.ok) {
		assert.equal(out.stage, "start");
		assert.equal(out.paneId, "w9:p4", "pane id surfaced for orphan cleanup");
	}
}

console.log("test-launch: all tests passed");
