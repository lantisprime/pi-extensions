// herdr-control: extension entry smoke test + graceful-degradation execute.
import assert from "node:assert/strict";

const extension = (await import("../index.ts")).default;
assert.equal(typeof extension, "function");

// Fake pi: capture registrations.
const tools = new Map();
const commands = new Map();
const handlers = new Map();
const appended = [];
const fakePi = {
	on(name, fn) {
		if (!handlers.has(name)) handlers.set(name, []);
		handlers.get(name).push(fn);
	},
	registerTool(def) {
		tools.set(def.name, def);
	},
	registerCommand(name, opts) {
		commands.set(name, opts);
	},
	registerShortcut() {},
	registerFlag() {},
	appendEntry(customType, data) {
		appended.push({ customType, data });
	},
};

extension(fakePi);

// tool surface
assert.deepEqual(
	[...tools.keys()].sort(),
	["herdr_agents", "herdr_close", "herdr_prompt", "herdr_read", "herdr_send_keys", "herdr_spawn", "herdr_terminal"].sort(),
);
for (const def of tools.values()) {
	assert.equal(typeof def.execute, "function", `${def.name} has execute`);
	assert.ok(def.description, `${def.name} has description`);
}

// command surface
assert.deepEqual([...commands.keys()].sort(), ["herdr-config", "herdr-list", "herdr-spawn", "herdr-term"].sort());

// lifecycle + input hooks
assert.ok(handlers.has("session_start"));
assert.ok(handlers.has("session_shutdown"));
assert.ok(handlers.has("input"));

// graceful degradation: with herdr unreachable (PATH stripped), tools return
// a normal error result (ok:false) instead of throwing, for expected paths.
const savedPath = process.env.PATH;
const savedHerdrEnv = process.env.HERDR_ENV;
process.env.PATH = "/nonexistent-dir-for-herdr-tests";
process.env.HERDR_ENV = "1";
try {
	const ctx = { hasUI: false, ui: {}, cwd: "/tmp", sessionManager: { getEntries: () => [] } };
	const agents = await tools.get("herdr_agents").execute("t1", {}, undefined, undefined, ctx);
	assert.equal(agents.details.ok, false, "herdr_agents reports failure via details");
	assert.match(agents.content[0].text, /failed|not reachable|ENOENT/);

	// lifecycle handlers are best-effort: must not throw with herdr missing
	await handlers.get("session_start")[0]({ reason: "startup" }, ctx);
	await handlers.get("session_shutdown")[0]({ reason: "quit" }, ctx);
} finally {
	if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
	if (savedHerdrEnv === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = savedHerdrEnv;
}

// outside herdr: hard gate errors surface as failures, not silent success
{
	process.env.HERDR_ENV = "";
	const ctx = { hasUI: false, ui: {}, cwd: "/tmp" };
	const agents = await tools.get("herdr_agents").execute("t2", {}, undefined, undefined, ctx);
	assert.equal(agents.details.ok, false);
	assert.match(agents.content[0].text, /HERDR_ENV/);
	if (savedHerdrEnv === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = savedHerdrEnv;
}

console.log("test-extension: all tests passed");
