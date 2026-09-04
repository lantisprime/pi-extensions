// herdr-control: LIVE smoke for the terminal feature (HERDR_ENV=1 + server).
//   node --experimental-strip-types test-fixtures/smoke-terminal-live.mjs
import assert from "node:assert/strict";

if (process.env.HERDR_ENV !== "1") {
	console.error("smoke-terminal-live: refusing to run outside a herdr pane");
	process.exit(1);
}

const extension = (await import("../index.ts")).default;
const tools = new Map();
const appended = [];
extension({
	on() {},
	registerTool(def) { tools.set(def.name, def); },
	registerCommand() {},
	appendEntry(customType, data) { appended.push({ customType, data }); },
});

const ctx = { hasUI: false, ui: {}, cwd: process.cwd() };

// 1. open a plain terminal with a command + label
const opened = await tools.get("herdr_terminal").execute("t1", {
	command: "echo TERMINAL_SMOKE_OK",
	label: "smoke terminal",
}, undefined, (u) => console.log("[progress]", u.content[0].text), ctx);
console.log(opened.content[0].text);
assert.equal(opened.details.ok, true, "terminal opened");
const name = opened.details.name;
const paneId = opened.details.paneId;
assert.ok(appended.some((e) => e.data?.op === "spawn" && e.data?.record?.kind === "terminal"), "terminal spawn event persisted");

// 2. read its output via herdr_read (pane-read path through registry name)
await new Promise((r) => setTimeout(r, 1500));
const read = await tools.get("herdr_read").execute("t2", { agent: name }, undefined, undefined, ctx);
console.log("--- herdr_read output ---");
console.log(read.content[0].text.split("\n").filter((l) => l.includes("TERMINAL_SMOKE_OK")).join("\n") || read.content[0].text.slice(0, 300));
assert.match(read.content[0].text, /TERMINAL_SMOKE_OK/, "command output visible via pane read");

// 3. close via registry
const closed = await tools.get("herdr_close").execute("t3", { agent: name }, undefined, undefined, ctx);
console.log(closed.content[0].text);
assert.equal(closed.details.ok, true, "terminal closed");

console.log("\nsmoke-terminal-live: done");
