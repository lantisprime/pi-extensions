// Tests for lib/exec.ts, lib/list.ts, lib/capture.ts, lib/send.ts, lib/launch.ts, lib/paste.ts.
// Uses fake-tmux.ts to drive executor behavior deterministically.
import assert from "node:assert/strict";
import { createFakeTmux, okResult, errResult } from "./fake-tmux.ts";
import { listAgentWindows } from "../lib/list.ts";
import { captureWindow } from "../lib/capture.ts";
import { sendText } from "../lib/send.ts";
import { launchSession } from "../lib/launch.ts";
import { pasteText } from "../lib/paste.ts";
import { PASTE_BUFFER_NAME, BRACKET_START, BRACKET_END } from "../lib/constants.ts";

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

// ── pasteText (P5c-2-S1) ──────────────────────────────────────────────────────

// pasteText REQ-1: argv includes `-p` (bracketed paste) and NOT `-r` (no LF→CR).
{
	const fake = createFakeTmux();
	fake.program([okResult(""), okResult(""), okResult("")]);
	const r = await pasteText(fake, [], { sessionName: "smoke", windowIndex: "2" }, "line1\nline2");
	assert.equal(r.ok, true);
	const pasteCall = fake.calls[1].args;
	assert.ok(pasteCall.includes("-p"), `paste-buffer argv must include -p, got: ${pasteCall.join(" ")}`);
	assert.ok(!pasteCall.includes("-r"), `paste-buffer argv must NOT include -r, got: ${pasteCall.join(" ")}`);
}

// pasteText REQ-2: text is delivered as ONE argv element of set-buffer (argv-only).
{
	const fake = createFakeTmux();
	fake.program([okResult(""), okResult(""), okResult("")]);
	const text = "echo hello\nworld\nwith spaces";
	const r = await pasteText(fake, [], { sessionName: "smoke", windowIndex: "2" }, text);
	assert.equal(r.ok, true);
	const setCall = fake.calls[0].args;
	// Text must be exactly ONE argv element (last arg of set-buffer).
	assert.equal(setCall[setCall.length - 1], text, "text reaches set-buffer as a single argv element");
	// The argv must not split on newlines.
	const textArgvCount = setCall.filter((a) => a === "hello" || a === "world" || a === "with spaces").length;
	assert.equal(textArgvCount, 0, "text must not be split into multiple argv elements");
}

// pasteText REQ-3: rejects oversize text BEFORE any tmux call.
{
	const fake = createFakeTmux();
	const r = await pasteText(fake, [], { sessionName: "smoke", windowIndex: "2" }, "x".repeat(5000));
	assert.equal(r.ok, false);
	assert.match(r.error, /too long/);
	assert.equal(fake.calls.length, 0, "no tmux invocation on oversize rejection");
}

// pasteText: rejects empty text before any tmux call.
{
	const fake = createFakeTmux();
	const r = await pasteText(fake, [], { sessionName: "smoke", windowIndex: "2" }, "");
	assert.equal(r.ok, false);
	assert.match(r.error, /empty/);
	assert.equal(fake.calls.length, 0, "no tmux invocation on empty rejection");
}

// pasteText REQ-4 happy path: argv includes `-d` AND buffer name matches set-buffer's.
{
	const fake = createFakeTmux();
	fake.program([okResult(""), okResult(""), okResult("")]);
	const r = await pasteText(fake, [], { sessionName: "smoke", windowIndex: "2" }, "hello");
	assert.equal(r.ok, true);
	const setCall = fake.calls[0].args;
	const pasteCall = fake.calls[1].args;
	const setBufIdx = setCall.indexOf("-b") + 1;
	const pasteBufIdx = pasteCall.indexOf("-b") + 1;
	assert.equal(setCall[setBufIdx], PASTE_BUFFER_NAME, "set-buffer uses PASTE_BUFFER_NAME");
	assert.equal(pasteCall[pasteBufIdx], PASTE_BUFFER_NAME, "paste-buffer uses same buffer name");
	assert.ok(pasteCall.includes("-d"), `paste-buffer must include -d for cleanup, got: ${pasteCall.join(" ")}`);
}

// pasteText REQ-4 failure path: best-effort delete-buffer issued after paste fails.
{
	const fake = createFakeTmux();
	fake.program([okResult(""), errResult("paste-buffer kaboom"), okResult("")]); // set ok, paste fail, delete ok
	const r = await pasteText(fake, [], { sessionName: "smoke", windowIndex: "2" }, "hello");
	assert.equal(r.ok, false);
	assert.match(r.error, /kaboom/);
	// 3rd call should be a best-effort delete-buffer with the same buffer name.
	const cleanupCall = fake.calls[2].args;
	assert.equal(cleanupCall[0], "delete-buffer", `expected delete-buffer cleanup call, got: ${cleanupCall.join(" ")}`);
	const bufIdx = cleanupCall.indexOf("-b") + 1;
	assert.equal(cleanupCall[bufIdx], PASTE_BUFFER_NAME, "cleanup uses same PASTE_BUFFER_NAME");
}

// pasteText OD-1: leading-dash text like "-X" is delivered verbatim via `--` terminator.
{
	const fake = createFakeTmux();
	fake.program([okResult(""), okResult(""), okResult("")]);
	const r = await pasteText(fake, [], { sessionName: "smoke", windowIndex: "2" }, "-X --bogus --foo=bar");
	assert.equal(r.ok, true);
	const setCall = fake.calls[0].args;
	// The `--` options terminator must precede the text.
	const ddIdx = setCall.indexOf("--");
	assert.ok(ddIdx >= 0, `set-buffer argv must include -- terminator, got: ${setCall.join(" ")}`);
	assert.equal(setCall[ddIdx + 1], "-X --bogus --foo=bar", "leading-dash text delivered as one argv element after --");
}

// pasteText: paste-buffer failure surfaces error.
{
	const fake = createFakeTmux();
	fake.program([okResult(""), errResult("buffer gone")]);
	const r = await pasteText(fake, [], { sessionName: "smoke", windowIndex: "2" }, "hello");
	assert.equal(r.ok, false);
	assert.match(r.error, /buffer gone/);
}

// pasteText: pressEnter:false skips the Enter call entirely.
{
	const fake = createFakeTmux();
	fake.program([okResult(""), okResult("")]);
	const r = await pasteText(fake, [], { sessionName: "smoke", windowIndex: "2" }, "hello", { pressEnter: false });
	assert.equal(r.ok, true);
	assert.equal(fake.calls.length, 2, "set + paste only; no Enter call");
}

// pasteText: pressEnterCount:100 clamps to MAX_ENTER_COUNT (10).
{
	const fake = createFakeTmux();
	// 2 (set + paste) + 10 (clamped Enters) = 12 responses
	fake.program(Array(12).fill(okResult("")));
	const r = await pasteText(fake, [], { sessionName: "smoke", windowIndex: "2" }, "hello", { pressEnterCount: 100 });
	assert.equal(r.ok, true);
	const enterCalls = fake.calls.filter((c) => c.args.includes("Enter")).length;
	assert.equal(enterCalls, 10, `pressEnterCount:100 must clamp to 10, got ${enterCalls}`);
}

// pasteText: pressEnterCount:3 fires exactly 3 Enter calls.
{
	const fake = createFakeTmux();
	// 2 (set + paste) + 3 (Enters) = 5 responses
	fake.program(Array(5).fill(okResult("")));
	const r = await pasteText(fake, [], { sessionName: "smoke", windowIndex: "2" }, "hello", { pressEnterCount: 3 });
	assert.equal(r.ok, true);
	const enterCalls = fake.calls.filter((c) => c.args.includes("Enter")).length;
	assert.equal(enterCalls, 3, `pressEnterCount:3 must fire 3 Enters, got ${enterCalls}`);
}

// pasteText: pressEnterCount:0 fires zero Enters (set + paste only).
{
	const fake = createFakeTmux();
	fake.program([okResult(""), okResult("")]);
	const r = await pasteText(fake, [], { sessionName: "smoke", windowIndex: "2" }, "hello", { pressEnterCount: 0 });
	assert.equal(r.ok, true);
	assert.equal(fake.calls.length, 2, "set + paste only; pressEnterCount:0 suppresses Enter");
}

// pasteText: pressEnterCount:NaN is a fail-safe — Math.min/max produce NaN, NaN>0 is false, loop skipped.
{
	const fake = createFakeTmux();
	fake.program([okResult(""), okResult("")]);
	const r = await pasteText(fake, [], { sessionName: "smoke", windowIndex: "2" }, "hello", { pressEnterCount: NaN });
	assert.equal(r.ok, true);
	assert.equal(fake.calls.length, 2, "set + paste only; NaN treated as 0 Enters (fail-safe)");
}

// pasteText REQ-20: embedded \e[200~ (paste-start) is rejected before any tmux call.
{
	const fake = createFakeTmux();
	const r = await pasteText(fake, [], { sessionName: "smoke", windowIndex: "2" }, `safe${BRACKET_START}INJECT`);
	assert.equal(r.ok, false);
	assert.match(r.error, /bracketed-paste marker/);
	assert.equal(fake.calls.length, 0, "no tmux call on rejected payload");
}

// pasteText REQ-20: embedded \e[201~ (paste-end) is rejected — this is the framing-break vector.
{
	const fake = createFakeTmux();
	const r = await pasteText(fake, [], { sessionName: "smoke", windowIndex: "2" }, `safe${BRACKET_END}end`);
	assert.equal(r.ok, false);
	assert.match(r.error, /bracketed-paste marker/);
	assert.equal(fake.calls.length, 0);
}

// pasteText REQ-20: multiple markers anywhere (start/middle/end) all reject.
{
	for (const payload of [
		`${BRACKET_END}at start`,
		`mid ${BRACKET_START} dle`,
		`at end${BRACKET_END}`,
		`${BRACKET_START}${BRACKET_END}`,
		`a\n${BRACKET_END}\nb`,
		`a${BRACKET_START}b${BRACKET_END}c${BRACKET_START}d${BRACKET_END}e`,
	]) {
		const fake = createFakeTmux();
		const r = await pasteText(fake, [], { sessionName: "smoke", windowIndex: "2" }, payload);
		assert.equal(r.ok, false, `must reject: ${JSON.stringify(payload)}`);
		assert.equal(fake.calls.length, 0, `no tmux call for: ${JSON.stringify(payload)}`);
	}
}

// pasteText REQ-20: NO false positive — clean text and partial/incomplete markers pass through.
{
	for (const payload of [
		"perfectly safe multi-line\nprompt text",
		"harmless \x1b[201 and [200~ text", // partial: ESC[201 (no ~) and [200~ (no ESC)
		"\x1b[2004~ looks close but is not a paste marker",
	]) {
		const fake = createFakeTmux();
		fake.program([okResult(""), okResult(""), okResult("")]);
		const r = await pasteText(fake, [], { sessionName: "smoke", windowIndex: "2" }, payload);
		assert.equal(r.ok, true, `must NOT reject: ${JSON.stringify(payload)}`);
		assert.equal(fake.calls[0].args[0], "set-buffer", "clean payload reaches set-buffer");
	}
}

// sendText REQ-20: multi-line payload with an embedded marker is rejected through the public entry.
{
	const fake = createFakeTmux();
	const r = await sendText(fake, [], { sessionName: "smoke", windowIndex: "2" }, `line one\n${BRACKET_END}\nline two`);
	assert.equal(r.ok, false);
	assert.match(r.error, /bracketed-paste marker/);
	assert.equal(fake.calls.length, 0, "rejected before any tmux call via routed pasteText");
}

// ── sendText multi-line routing (P5c-2-S1, REQ-18) ────────────────────────

// sendText REQ-18: multi-line text routes through pasteText (paste-buffer -p), not send-keys -l.
{
	const fake = createFakeTmux();
	// pasteText makes 3 calls with default pressEnter:true (set + paste + Enter).
	fake.program([okResult(""), okResult(""), okResult("")]);
	const r = await sendText(fake, [], { sessionName: "smoke", windowIndex: "2" }, "echo a\necho b\necho c");
	assert.equal(r.ok, true);
	const firstCmd = fake.calls[0].args[0];
	assert.equal(firstCmd, "set-buffer", `multi-line should route to pasteText (first call = set-buffer), got: ${firstCmd}`);
	const pasteCall = fake.calls[1].args;
	assert.ok(pasteCall.includes("-p"), `routed paste must include -p, got: ${pasteCall.join(" ")}`);
}

// sendText REQ-18: pressEnter:false on multi-line still routes, but skips Enter.
{
	const fake = createFakeTmux();
	fake.program([okResult(""), okResult("")]);
	const r = await sendText(fake, [], { sessionName: "smoke", windowIndex: "2" }, "a\nb", { pressEnter: false });
	assert.equal(r.ok, true);
	assert.equal(fake.calls.length, 2, "set + paste only; no Enter call (pressEnter:false)");
}

// sendText: single-line text stays on the literal send-keys -l path (no routing).
{
	const fake = createFakeTmux();
	fake.program([okResult(""), okResult("")]);
	const r = await sendText(fake, [], { sessionName: "smoke", windowIndex: "2" }, "single line only");
	assert.equal(r.ok, true);
	assert.equal(fake.calls[0].args[0], "send-keys", "single-line uses send-keys -l");
	assert.equal(fake.calls[0].args[1], "-l");
}

console.log("test-exec: all tests passed");