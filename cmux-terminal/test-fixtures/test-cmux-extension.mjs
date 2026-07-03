// P5b-1-S4: REQ-T5 extension-surface test for cmuxTerminalTools.
//
// Verifies the extension entry exports a factory that binds cmuxPaste /
// cmuxWaitFor / cmuxSendKeys to an injected CmuxExecutor. This covers the
// tool-extension wiring without invoking the production cmux executor.
import assert from "node:assert/strict";
import { cmuxTerminalTools } from "../index.ts";
import { FakeCmuxExecutor } from "./fake-cmux.ts";

const SAMPLE_SURFACE = "surface:11";

// Test 10: ToolsExtensionExportsCmuxPaste — factory exists and binds tools.
{
	assert.equal(typeof cmuxTerminalTools, "function", "cmuxTerminalTools must be exported as a factory");

	const fake = new FakeCmuxExecutor();
	const tools = cmuxTerminalTools(fake);
	assert.deepEqual(
		Object.keys(tools),
		["cmuxPaste", "cmuxWaitFor", "cmuxSendKeys"],
		"factory must return exactly the three cmux tool functions",
	);
	assert.equal(typeof tools.cmuxPaste, "function", "cmuxPaste must be a bound function");
	assert.equal(typeof tools.cmuxWaitFor, "function", "cmuxWaitFor must be a bound function");
	assert.equal(typeof tools.cmuxSendKeys, "function", "cmuxSendKeys must be a bound function");
}

// Bound cmuxPaste delegates to the injected executor, not the production one.
{
	const fake = new FakeCmuxExecutor();
	const tools = cmuxTerminalTools(fake);
	const r = await tools.cmuxPaste({ window: SAMPLE_SURFACE, text: "hi", pressEnter: false });
	assert.equal(r.ok, true, "bound cmuxPaste must succeed with fake executor");
	assert.equal(fake.calls.length, 1, "bound cmuxPaste must issue exactly one exec");
	assert.deepEqual(
		fake.calls[0].args,
		["send", "--surface", SAMPLE_SURFACE, "'hi'"],
		"bound cmuxPaste must delegate with shell-escaped text argv",
	);
}

// Bound cmuxWaitFor delegates read-screen polling through the injected executor.
{
	const fake = new FakeCmuxExecutor();
	fake.enqueueResponse({ ok: true, stdout: "ready prompt\n", stderr: "", exitCode: 0 });
	const tools = cmuxTerminalTools(fake);
	const r = await tools.cmuxWaitFor({ window: SAMPLE_SURFACE, regex: /ready/, timeoutMs: 50 });
	assert.equal(r.ok, true, "bound cmuxWaitFor must succeed with matching fake output");
	assert.equal(r.matched, true, "bound cmuxWaitFor must report matched:true on regex hit");
	assert.equal(fake.calls.length, 1, "bound cmuxWaitFor must issue exactly one exec on first-match output");
	assert.equal(fake.calls[0].args[0], "read-screen", "bound cmuxWaitFor must delegate to read-screen");
}

// Bound cmuxSendKeys delegates key-mode send-key calls to the injected executor.
{
	const fake = new FakeCmuxExecutor();
	const tools = cmuxTerminalTools(fake);
	const r = await tools.cmuxSendKeys({ window: SAMPLE_SURFACE, text: "C-c", mode: "keys" });
	assert.equal(r.ok, true, "bound cmuxSendKeys must succeed with fake executor");
	assert.equal(fake.calls.length, 1, "bound cmuxSendKeys must issue exactly one exec");
	assert.deepEqual(
		fake.calls[0].args,
		["send-key", "--surface", SAMPLE_SURFACE, "C-c"],
		"bound cmuxSendKeys must delegate key-mode token argv",
	);
}

console.log("P5b-1 cmux-extension tests passed");
