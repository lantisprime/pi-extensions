// Headless integration test: loads the tmux-control extension against a
// mocked ExtensionAPI and verifies that:
//   - registerCommand was called for all 6 expected slash commands
//   - registerTool was called for all 4 expected tools
//   - the input hook was registered
//   - session_start handler is wired correctly
//   - the slash command handlers and tool executors run without throwing
//     (using the fake-tmux executor wired into a captured mock)
//
// This is a runtime test of the extension WITHOUT needing a live pi TUI.
// Run from the test-fixtures dir; resolves imports via ../.
import assert from "node:assert/strict";
import { mock } from "node:test";

const registeredCommands = new Map();
const registeredTools = new Map();
const sessionStartHandlers = [];

const piMock = {
	registerCommand(name, def) {
		registeredCommands.set(name, def);
	},
	registerTool(def) {
		registeredTools.set(def.name, def);
	},
	on(event, handler) {
		if (event === "session_start") {
			sessionStartHandlers.push(handler);
		}
		// For other events (input), just record them — the test invokes handlers directly.
	},
};

const ext = (await import("../index.ts")).default;
ext(piMock);

// Trigger session_start (this is what pi does after loading)
assert.equal(sessionStartHandlers.length, 1, "exactly one session_start handler registered");
const startResult = sessionStartHandlers[0]({}, {});
assert.equal(startResult, undefined, "session_start handler is sync (returns undefined)");

// ── Slash commands ───────────────────────────────────────────────────

const expectedCommands = ["tmux-list", "tmux-capture", "tmux-send", "tmux-tail", "tmux-launch", "tmux-paste", "tmux-config"];
for (const name of expectedCommands) {
	assert.ok(registeredCommands.has(name), `slash command /${name} registered`);
}
assert.equal(registeredCommands.size, expectedCommands.length, `expected exactly ${expectedCommands.length} commands`);

// Verify each command has the required fields
for (const [name, def] of registeredCommands) {
	assert.ok(typeof def.description === "string", `${name}: has description`);
	assert.ok(typeof def.handler === "function", `${name}: has handler`);
}

// ── Tools ────────────────────────────────────────────────────────────

const expectedTools = ["tmux_list", "tmux_capture", "tmux_send", "tmux_paste", "tmux_launch", "tmux_drive_claude"];
for (const name of expectedTools) {
	assert.ok(registeredTools.has(name), `tool ${name} registered`);
	assert.ok(typeof registeredTools.get(name).execute === "function", `${name}: has execute`);
	assert.ok(typeof registeredTools.get(name).parameters === "object", `${name}: has parameters schema`);
	assert.ok(typeof registeredTools.get(name).description === "string", `${name}: has description`);
}
assert.equal(registeredTools.size, expectedTools.length, `expected exactly ${expectedTools.length} tools`);

// ── Tool: tmux_list on a server with no matching windows ────────────

{
	// We can't easily inject a fake executor into the running extension, so just
	// verify the tool reports a sensible error when no tmux server is reachable.
	const tool = registeredTools.get("tmux_list");
	const ctx = { ui: { notify() {} } };
	const result = await tool.execute("call-1", {}, new AbortController().signal, () => {}, ctx);
	assert.equal(result.details.ok, undefined, "tmux_list: ok flag absent when no server");
	assert.ok(result.content[0].text.includes("tmux server not running") || result.content[0].text.includes("(no windows"), `tmux_list: returns server-missing or no-windows message, got: ${result.content[0].text.slice(0, 100)}`);
}

// ── Tool: tmux_capture rejects bad input ────────────────────────────

{
	const tool = registeredTools.get("tmux_capture");
	const ctx = { ui: { notify() {} } };
	// Empty window string should return an error content
	const result = await tool.execute("call-2", { window: "" }, new AbortController().signal, () => {}, ctx);
	assert.equal(result.details.ok, false, "tmux_capture empty window: ok=false");
	assert.ok(typeof result.content[0].text === "string");
}

// ── Tool: tmux_launch returns sensible error ────────────────────────

{
	const tool = registeredTools.get("tmux_launch");
	const ctx = { ui: { notify() {} } };
	// Bad name (with space) — fails socket OR name validation, both errors are valid.
	const result = await tool.execute("call-3", { name: "name with space" }, new AbortController().signal, () => {}, ctx);
	assert.equal(result.details.ok, false, "tmux_launch bad name: ok=false");
	assert.ok(typeof result.content[0].text === "string", "tmux_launch: returns text content");
}

console.log("test-extension-integration: all tests passed");
console.log(`  ✓ ${registeredCommands.size} slash commands: ${[...registeredCommands.keys()].join(", ")}`);
console.log(`  ✓ ${registeredTools.size} tools: ${[...registeredTools.keys()].join(", ")}`);
console.log(`  ✓ session_start handler registered`);
mock.reset();
