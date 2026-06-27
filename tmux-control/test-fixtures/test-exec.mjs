// Tests for lib/exec.ts, lib/list.ts, lib/capture.ts, lib/send.ts, lib/launch.ts.
// Uses fake-tmux.ts to drive executor behavior deterministically.
import assert from "node:assert/strict";
import { createFakeTmux, okResult, errResult } from "./fake-tmux.ts";
import { listAgentWindows } from "../lib/list.ts";
import { captureWindow } from "../lib/capture.ts";
import { sendText } from "../lib/send.ts";
import { launchSession } from "../lib/launch.ts";

// ── listAgentWindows ──────────────────────────────────────────────────

// listAgentWindows: filters by prefix and parses 5-tuple
{
	const fake = createFakeTmux();
	fake.program([
		okResult("smoke 1 pi-agent-bg-abc run-1 scout\nsmoke 2 pi-agent-bg-def run-2 planner\nlogs 1 zsh\n"),
	]);
	const wins = await listAgentWindows(fake, [], "pi-agent-");
	assert.equal(wins.length, 2, "two windows match prefix");
	assert.equal(wins[0].sessionName, "smoke");
	assert.equal(wins[0].windowIndex, "1");
	assert.equal(wins[0].windowName, "pi-agent-bg-abc");
	assert.equal(wins[0].runId, "run-1");
	assert.equal(wins[0].agentName, "scout");
}

// listAgentWindows: empty on failure
{
	const fake = createFakeTmux();
	fake.program([errResult("no server")]);
	const wins = await listAgentWindows(fake, [], "pi-agent-");
	assert.deepEqual(wins, [], "empty array on tmux failure");
}

// ── captureWindow ─────────────────────────────────────────────────────

// captureWindow: returns output, uses session:index target
{
	const fake = createFakeTmux();
	fake.program([okResult("line1\nline2\nline3\n")]);
	const r = await captureWindow(fake, [], { sessionName: "smoke", windowIndex: "2" }, { lines: 10 });
	assert.equal(r.ok, true);
	assert.equal(r.output, "line1\nline2\nline3\n");
	// Verify target format
	const args = fake.calls[0].args;
	const targetIdx = args.indexOf("-t") + 1;
	assert.equal(args[targetIdx], "smoke:2", "uses session:index target");
}

// captureWindow: error
{
	const fake = createFakeTmux();
	fake.program([errResult("can't find pane")]);
	const r = await captureWindow(fake, [], { sessionName: "smoke", windowIndex: "2" });
	assert.equal(r.ok, false);
	assert.match(r.error, /can't find pane/);
}

// captureWindow: clamps lines to MAX_CAPTURE_LINES
{
	const fake = createFakeTmux();
	fake.program([okResult("")]);
	await captureWindow(fake, [], { sessionName: "smoke", windowIndex: "2" }, { lines: 999999 });
	const args = fake.calls[0].args;
	const linesIdx = args.indexOf("-S") + 1;
	const lines = parseInt(args[linesIdx].replace("-", ""), 10);
	assert.ok(lines <= 5000, `lines clamped to ${lines}`);
}

// ── sendText ──────────────────────────────────────────────────────────

// sendText: sends text + Enter, uses session:index target
{
	const fake = createFakeTmux();
	fake.program([okResult(""), okResult("")]);
	const r = await sendText(fake, [], { sessionName: "smoke", windowIndex: "2" }, "hello world");
	assert.equal(r.ok, true);
	assert.equal(r.sentBytes, 11);
	assert.equal(fake.calls.length, 2, "two calls (text + Enter)");
	const textCall = fake.calls[0].args;
	assert.equal(textCall[0], "send-keys");
	assert.equal(textCall[1], "-l");
	assert.equal(textCall[textCall.length - 1], "hello world");
	const enterCall = fake.calls[1].args;
	assert.equal(enterCall[enterCall.length - 1], "Enter");
}

// sendText: rejects oversized text
{
	const fake = createFakeTmux();
	const r = await sendText(fake, [], { sessionName: "smoke", windowIndex: "2" }, "x".repeat(5000));
	assert.equal(r.ok, false);
	assert.match(r.error, /too long/);
}

// sendText: without Enter
{
	const fake = createFakeTmux();
	fake.program([okResult("")]);
	const r = await sendText(fake, [], { sessionName: "smoke", windowIndex: "2" }, "no enter", { pressEnter: false });
	assert.equal(r.ok, true);
	assert.equal(fake.calls.length, 1, "single call without Enter");
}

// sendText: reports Enter failure after text succeeded
{
	const fake = createFakeTmux();
	fake.program([okResult(""), errResult("Enter failed")]);
	const r = await sendText(fake, [], { sessionName: "smoke", windowIndex: "2" }, "x");
	assert.equal(r.ok, false);
	assert.match(r.error, /Enter failed/);
}

// ── launchSession ─────────────────────────────────────────────────────

// launchSession: spawns session
{
	const fake = createFakeTmux();
	fake.program([okResult("")]);
	const r = await launchSession(fake, [], "dev");
	assert.equal(r.ok, true);
	assert.equal(r.sessionName, "dev");
	assert.equal(fake.calls[0].args[0], "new-session");
	assert.equal(fake.calls[0].args[1], "-d");
	assert.equal(fake.calls[0].args[2], "-s");
	assert.equal(fake.calls[0].args[3], "dev");
}

// launchSession: with command
{
	const fake = createFakeTmux();
	fake.program([okResult("")]);
	await launchSession(fake, [], "logs", "tail -f /var/log/system.log");
	const args = fake.calls[0].args;
	assert.equal(args[args.length - 1], "tail -f /var/log/system.log", "command appended");
}

// launchSession: rejects invalid session name
{
	const fake = createFakeTmux();
	const r = await launchSession(fake, [], "name with space");
	assert.equal(r.ok, false);
	assert.match(r.error, /invalid session name/);
}

// launchSession: reports failure
{
	const fake = createFakeTmux();
	fake.program([errResult("duplicate session")]);
	const r = await launchSession(fake, [], "dev");
	assert.equal(r.ok, false);
	assert.match(r.error, /duplicate session/);
}

console.log("test-exec: all tests passed");