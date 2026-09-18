// herdr-control: plain-terminal pane tests (lib/terminal.ts).
import assert from "node:assert/strict";
import { createFakeHerdr, okResult, errResult } from "./fake-herdr.ts";
import {
	PANE_SPLIT_JSON,
	WORKSPACE_CREATE_JSON,
	PANE_LAYOUT_JSON,
	PANE_LAYOUT_TALL_JSON,
} from "./fixtures.ts";
import { createTerminal, runInPane, renamePane, readPane } from "../lib/terminal.ts";

const BASE = { cwd: "/tmp/x", direction: "auto" };

// default: sibling split, wide -> right (via pane layout probe), --no-focus
{
	const fake = createFakeHerdr();
	fake.onSubcommand("pane", (args) => {
		if (args[1] === "layout") return okResult(PANE_LAYOUT_JSON);
		if (args[1] === "split") return okResult(PANE_SPLIT_JSON);
		return errResult("unexpected", 1);
	});
	const out = await createTerminal(fake.executor, { ...BASE });
	assert.equal(out.ok, true);
	if (out.ok) assert.equal(out.paneId, "w9:p4");
	const split = fake.callsTo("pane").find((a) => a[1] === "split");
	assert.deepEqual(split.slice(2), ["--current", "--direction", "right", "--cwd", "/tmp/x", "--no-focus"]);
}

// tall pane -> down
{
	const fake = createFakeHerdr();
	fake.onSubcommand("pane", (args) => args[1] === "layout" ? okResult(PANE_LAYOUT_TALL_JSON) : okResult(PANE_SPLIT_JSON));
	const out = await createTerminal(fake.executor, { ...BASE });
	assert.equal(out.ok, true);
	const split = fake.callsTo("pane").find((a) => a[1] === "split");
	assert.equal(split[4], "down");
}

// tab mode: tab create with explicit workspace + label, root pane parsed
{
	process.env.HERDR_WORKSPACE_ID = "w9";
	const fake = createFakeHerdr();
	fake.onSubcommand("tab", () => okResult(JSON.stringify({
		id: "cli:tab:create",
		result: { tab: { id: "w9:t2" }, root_pane: { pane_id: "w9:p7" } },
	})));
	const out = await createTerminal(fake.executor, { ...BASE, newTab: true, label: "logs" });
	assert.equal(out.ok, true);
	if (out.ok) {
		assert.equal(out.paneId, "w9:p7");
		assert.equal(out.tabId, "w9:t2");
	}
	const [tab] = fake.callsTo("tab");
	assert.deepEqual(tab.slice(1), ["create", "--cwd", "/tmp/x", "--no-focus", "--workspace", "w9", "--label", "logs"]);
	delete process.env.HERDR_WORKSPACE_ID;
}

// workspace mode: label on workspace create, root pane parsed
{
	const fake = createFakeHerdr();
	fake.onSubcommand("workspace", () => okResult(WORKSPACE_CREATE_JSON));
	const out = await createTerminal(fake.executor, { ...BASE, newWorkspace: true, label: "sandbox" });
	assert.equal(out.ok, true);
	if (out.ok) assert.equal(out.paneId, "w12:p1");
	const [ws] = fake.callsTo("workspace");
	assert.deepEqual(ws.slice(1), ["create", "--cwd", "/tmp/x", "--no-focus", "--label", "sandbox"]);
}

// layout failure surfaces stderr message
{
	const fake = createFakeHerdr();
	fake.onSubcommand("pane", (args) => args[1] === "layout" ? okResult(PANE_LAYOUT_JSON) : errResult("no space", 1));
	const out = await createTerminal(fake.executor, { ...BASE });
	assert.equal(out.ok, false);
	if (!out.ok) {
		assert.equal(out.stage, "layout");
		assert.match(out.error, /no space/);
	}
}

// runInPane: single argv token preserves quoting
{
	const fake = createFakeHerdr();
	fake.onSubcommand("pane", (args) => args[1] === "run" ? okResult() : errResult("x", 1));
	const out = await runInPane(fake.executor, "w9:p4", "just test --watch 'all'");
	assert.equal(out.ok, true);
	const [run] = fake.callsTo("pane");
	assert.deepEqual(run.slice(2), ["w9:p4", "just test --watch 'all'"]);
	assert.equal((await runInPane(fake.executor, "w9:p4", "   ")).ok, false, "empty command rejected");
	assert.equal((await runInPane(fake.executor, "bogus", "ls")).ok, false, "bad pane ref rejected");
}

// renamePane
{
	const fake = createFakeHerdr();
	fake.onSubcommand("pane", (args) => args[1] === "rename" ? okResult() : errResult("x", 1));
	const out = await renamePane(fake.executor, "w9:p4", "dev server");
	assert.equal(out.ok, true);
	const [ren] = fake.callsTo("pane");
	assert.deepEqual(ren.slice(2), ["w9:p4", "dev server"]);
}

// readPane: plain text, not envelope
{
	const fake = createFakeHerdr();
	fake.onSubcommand("pane", (args) => args[1] === "read" ? okResult("server listening on :3000\n") : errResult("x", 1));
	const out = await readPane(fake.executor, "w9:p4", { source: "recent-unwrapped", lines: 50 });
	assert.equal(out.ok, true);
	if (out.ok) assert.match(out.text, /listening/);
	const [read] = fake.callsTo("pane");
	assert.deepEqual(read.slice(2), ["w9:p4", "--source", "recent-unwrapped", "--lines", "50"]);
}

console.log("test-terminal: all tests passed");
