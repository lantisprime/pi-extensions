// herdr-control: brief + dispose wiring tests (lib/brief.ts + runSpawn pipeline).
import assert from "node:assert/strict";
import { createFakeHerdr, okResult, errResult, okEnvelope } from "./fake-herdr.ts";
import { withCleanupGuidance, shouldDisposeOnSettle, CLEANUP_GUIDANCE_HEADER, CLEANUP_GUIDANCE } from "../lib/brief.ts";
import { AGENT_LIST_JSON, AGENT_START_JSON, PANE_SPLIT_JSON, PANE_LAYOUT_JSON, AGENT_PROMPT_OK_JSON } from "./fixtures.ts";

// brief: footer appended, idempotent, opt-out respected
{
	const briefed = withCleanupGuidance("Review the diff.");
	assert.match(briefed, /^Review the diff\./);
	assert.match(briefed, new RegExp(CLEANUP_GUIDANCE_HEADER.replace(/[()]/g, "\\$&")));
	assert.match(briefed, /git worktree remove/);
	assert.equal(withCleanupGuidance(briefed), briefed, "idempotent");
	assert.equal(withCleanupGuidance("Task.", { cleanupGuidance: false }), "Task.", "opt-out");
}

// dispose policy: only settled prompts close the pane
{
	assert.equal(shouldDisposeOnSettle({ ok: true }, true), true);
	assert.equal(shouldDisposeOnSettle({ ok: true }, undefined), false, "default keeps pane");
	assert.equal(shouldDisposeOnSettle({ ok: false }, true), false, "blocked/timeout keeps pane");
}

// WIRING: runSpawn submits the briefed task and close_when_done closes the pane.
// Fake pi captures registry events; fake herdr records the prompt text.
{
	const extension = (await import("../index.ts")).default;
	const appended = [];
	const fakePi = {
		on() {},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerFlag() {},
		appendEntry(customType, data) {
			appended.push({ customType, data });
		},
	};
	extension(fakePi); // initializes module state
	const { runSpawnForTest } = await import("../index.ts");

	const fake = createFakeHerdr();
	let promptedTask = null;
	fake.onSubcommand("agent", (args) => {
		if (args[1] === "list") return okResult(AGENT_LIST_JSON);
		if (args[1] === "start") return okResult(AGENT_START_JSON);
		if (args[1] === "prompt") {
			promptedTask = args[3]; // ["agent","prompt",TARGET,TASK,...]
			return okResult(AGENT_PROMPT_OK_JSON);
		}
		if (args[1] === "read") return okResult("final answer\n");
		return errResult("unexpected " + args.join(" "), 1);
	});
	fake.onSubcommand("pane", (args) => {
		if (args[1] === "split") return okResult(PANE_SPLIT_JSON);
		if (args[1] === "close") return okResult(okEnvelope({ closed: true }));
		return okResult(PANE_LAYOUT_JSON);
	});

	const result = await runSpawnForTest(
		fakePi,
		fake.executor,
		{
			name: "pi-herdr-wiring",
			task: "Do the thing.",
			kind: "pi",
			cwd: "/tmp/wiring",
			direction: "auto",
			closeWhenDone: true,
		},
	);
	assert.equal(result.details.ok, true, `spawn settled: ${result.content[0].text.slice(0, 300)}`);
	assert.ok(promptedTask, "prompt was submitted");
	assert.match(promptedTask, /^Do the thing\./);
	assert.match(promptedTask, /git worktree remove/, "cleanup footer reached the submitted brief");
	assert.match(result.content[0].text, /closed \(close_when_done\)/, "pane disposal reported");
	assert.equal(result.details.paneClosed, true);

	const closes = fake.callsTo("pane").filter((a) => a[1] === "close");
	assert.equal(closes.length, 1, "pane closed exactly once");
	assert.deepEqual(closes[0].slice(2), ["w9:p4"]);
	const closeEvents = appended.filter((e) => e.data?.op === "close");
	assert.equal(closeEvents.length, 1, "close event persisted to the session");
}

// WIRING: default (no close_when_done) leaves the pane open; opt-out drops the footer.
{
	const { runSpawnForTest } = await import("../index.ts");
	const fake = createFakeHerdr();
	let promptedTask = null;
	fake.onSubcommand("agent", (args) => {
		if (args[1] === "list") return okResult(okEnvelope({ agents: [] }));
		if (args[1] === "start") return okResult(AGENT_START_JSON);
		if (args[1] === "prompt") {
			promptedTask = args[3];
			return okResult(AGENT_PROMPT_OK_JSON);
		}
		if (args[1] === "read") return okResult("done\n");
		return errResult("unexpected", 1);
	});
	fake.onSubcommand("pane", (args) => args[1] === "split" ? okResult(PANE_SPLIT_JSON) : okResult(PANE_LAYOUT_JSON));

	const fakePi = { on() {}, registerTool() {}, registerCommand() {}, registerShortcut() {}, registerFlag() {}, appendEntry() {} };
	const result = await runSpawnForTest(fakePi, fake.executor, {
		name: "pi-herdr-wiring2",
		task: "Quick check.",
		kind: "pi",
		cwd: "/tmp/wiring",
		direction: "auto",
		cleanupGuidance: false,
	});
	assert.equal(result.details.ok, true);
	assert.equal(promptedTask, "Quick check.", "footer omitted on opt-out");
	const closes = fake.callsTo("pane").filter((a) => a[1] === "close");
	assert.equal(closes.length, 0, "pane kept for follow-ups by default");

	// Auto-armed watchdog from the first spawn must not hold the process open.
	const { stopWatchForTest } = await import("../index.ts");
	stopWatchForTest();
}

console.log("test-brief-wiring: all tests passed");
