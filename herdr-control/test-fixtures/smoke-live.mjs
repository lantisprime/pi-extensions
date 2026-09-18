// herdr-control: LIVE smoke test (requires a running herdr server + HERDR_ENV=1).
// NOT part of run-tests.sh — run explicitly:
//   node --experimental-strip-types test-fixtures/smoke-live.mjs
//
// Spawns a real `pi` subagent in a sibling pane with a trivial task, waits for
// it to settle, reads the transcript, then closes the pane via the registry.
import assert from "node:assert/strict";

if (process.env.HERDR_ENV !== "1") {
	console.error("smoke-live: refusing to run outside a herdr pane (HERDR_ENV!=1)");
	process.exit(1);
}

const extension = (await import("../index.ts")).default;
const tools = new Map();
const appended = [];
const fakePi = {
	on() {},
	registerTool(def) { tools.set(def.name, def); },
	registerCommand() {},
	appendEntry(customType, data) { appended.push({ customType, data }); },
};
extension(fakePi);

const ctx = { hasUI: false, ui: {}, cwd: process.cwd() };

// 1. baseline: list agents
const before = await tools.get("herdr_agents").execute("s1", {}, undefined, undefined, ctx);
console.log("=== herdr_agents (before) ===\n" + before.content[0].text);

// 2. spawn + prompt + read (real pipeline)
console.log("\n=== herdr_spawn (live) ===");
const name = "pi-herdr-smoke";
const spawned = await tools.get("herdr_spawn").execute(
	"s2",
	{
		name,
		task: "This is a smoke test. Reply with exactly SMOKE_OK and nothing else. Do not use any tools.",
		kind: "pi",
		timeout_ms: 120_000,
	},
	{
		aborted: false,
	},
	(update) => console.log("[progress]", update.content[0].text),
	ctx,
);
console.log(spawned.content[0].text.slice(0, 1500));
console.log("details:", JSON.stringify(spawned.details, null, 1).slice(0, 600));

// 3. registry event was persisted
assert.ok(appended.some((e) => e.customType === "herdr-control/spawn-registry" && e.data?.op === "spawn"), "spawn event persisted");

// 4. close via registry (no UI needed for registered targets)
if (spawned.details.paneId) {
	console.log("\n=== herdr_close (live) ===");
	const closed = await tools.get("herdr_close").execute("s3", { agent: name }, undefined, undefined, ctx);
	console.log(closed.content[0].text);
}

// 5. verify cleanup
const after = await tools.get("herdr_agents").execute("s4", {}, undefined, undefined, ctx);
const stillThere = after.content[0].text.includes(name);
console.log("\n=== herdr_agents (after) ===");
console.log(after.content[0].text);
console.log(stillThere ? "WARN: agent still listed after close" : "cleanup verified: agent gone");

console.log("\nsmoke-live: done");
