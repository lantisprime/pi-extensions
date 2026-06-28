// Tests for lib/exec.ts, lib/list.ts, lib/capture.ts, lib/send.ts, lib/launch.ts, lib/paste.ts, lib/drive.ts.
// Uses fake-tmux.ts to drive executor behavior deterministically.
import assert from "node:assert/strict";
import { createFakeTmux, okResult, errResult } from "./fake-tmux.ts";
import { listAgentWindows } from "../lib/list.ts";
import { captureWindow } from "../lib/capture.ts";
import { sendText } from "../lib/send.ts";
import { launchSession } from "../lib/launch.ts";
import { pasteText } from "../lib/paste.ts";
import { waitForWindow } from "../lib/wait.ts";
import { checkExtendedKeys } from "../lib/keyscheck.ts";
import { driveClaude } from "../lib/drive.ts";
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

// ── sendText pressEnterCount (P5c-2-S3) ───────────────────────────────

// sendText: pressEnterCount:3 fires exactly 3 Enter calls on multi-line path (routes through pasteText).
{
	const fake = createFakeTmux();
	// pasteText does set + paste + 3 Enters = 5 responses
	fake.program(Array(5).fill(okResult("")));
	const r = await sendText(fake, [], { sessionName: "smoke", windowIndex: "2" },
		"line1\nline2\nline3", { pressEnterCount: 3 });
	assert.equal(r.ok, true);
	const enterCalls = fake.calls.filter((c) => c.args.includes("Enter")).length;
	assert.equal(enterCalls, 3, `expected 3 Enter calls, got ${enterCalls}`);
}

// sendText: pressEnterCount:100 clamps to MAX_ENTER_COUNT (10) on multi-line path.
{
	const fake = createFakeTmux();
	// pasteText does set + paste + 10 clamped Enters = 12 responses
	fake.program(Array(12).fill(okResult("")));
	const r = await sendText(fake, [], { sessionName: "smoke", windowIndex: "2" },
		"multi\nline", { pressEnterCount: 100 });
	assert.equal(r.ok, true);
	const enterCalls = fake.calls.filter((c) => c.args.includes("Enter")).length;
	assert.equal(enterCalls, 10, `expected clamp to MAX_ENTER_COUNT=10, got ${enterCalls}`);
}

// sendText: pressEnterCount:3 fires exactly 3 Enter calls on literal (single-line) path.
// Regression guard for S3: the literal-mode Enter block must honor pressEnterCount, not just send 1.
{
	const fake = createFakeTmux();
	// literal path does send-keys + 3 Enters = 4 responses (no set/paste; no -l flag interception)
	fake.program(Array(4).fill(okResult("")));
	const r = await sendText(fake, [], { sessionName: "smoke", windowIndex: "2" },
		"single line no newlines", { pressEnterCount: 3 });
	assert.equal(r.ok, true);
	assert.equal(fake.calls.length, 4, "single-line + pressEnterCount:3 should be send-keys + 3 Enters");
	const enterCalls = fake.calls.filter((c) => c.args.includes("Enter")).length;
	assert.equal(enterCalls, 3, `literal path: expected 3 Enter calls, got ${enterCalls}`);
}

// sendText: pressEnterCount:NaN is fail-safe on literal path — Enter loop skipped (0 Enters).
// NaN-safe parity with pasteText: Math.max(NaN, 0) = NaN; `for (let i = 0; i < NaN; i++)` does not execute.
// Regression guard for codex MAJOR round 2: effectiveEnterCount must be 0, not NaN.
{
	const fake = createFakeTmux();
	// literal path does send-keys only (Enter loop skipped) = 1 response
	fake.program([okResult("")]);
	const r = await sendText(fake, [], { sessionName: "smoke", windowIndex: "2" },
		"single line", { pressEnterCount: NaN });
	assert.equal(r.ok, true);
	const enterCalls = fake.calls.filter((c) => c.args.includes("Enter")).length;
	assert.equal(enterCalls, 0, `NaN pressEnterCount must skip Enter loop on literal path, got ${enterCalls}`);
	assert.equal(r.effectiveEnterCount, 0, `NaN pressEnterCount must yield effectiveEnterCount=0 (not NaN), got ${r.effectiveEnterCount}`);
}

// sendText: effectiveEnterCount reflects the actual (post-clamp) Enter count on the literal path.
// Regression guard for codex MAJOR: the displayed count must match what was fired, not what was requested.
{
	const fake = createFakeTmux();
	fake.program(Array(11).fill(okResult("")));  // send-keys + 10 clamped Enters
	const r = await sendText(fake, [], { sessionName: "smoke", windowIndex: "2" },
		"single line", { pressEnterCount: 100 });
	assert.equal(r.ok, true);
	assert.equal(r.effectiveEnterCount, 10, `effectiveEnterCount must reflect clamp (100→10), got ${r.effectiveEnterCount}`);
}

// sendText: effectiveEnterCount=0 when pressEnter is false (no Enters fired regardless of pressEnterCount).
{
	const fake = createFakeTmux();
	fake.program([okResult("")]);  // send-keys only, no Enter
	const r = await sendText(fake, [], { sessionName: "smoke", windowIndex: "2" },
		"single line", { pressEnter: false, pressEnterCount: 5 });
	assert.equal(r.ok, true);
	assert.equal(r.effectiveEnterCount, 0, `pressEnter:false must yield effectiveEnterCount=0, got ${r.effectiveEnterCount}`);
}

// pasteText: effectiveEnterCount reflects the actual (post-clamp) Enter count.
{
	const fake = createFakeTmux();
	fake.program(Array(12).fill(okResult("")));  // set + paste + 10 clamped Enters
	const r = await pasteText(fake, [], { sessionName: "smoke", windowIndex: "2" },
		"hello", { pressEnterCount: 100 });
	assert.equal(r.ok, true);
	assert.equal(r.effectiveEnterCount, 10, `pasteText effectiveEnterCount must reflect clamp, got ${r.effectiveEnterCount}`);
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
// Regression guard for codex MAJOR round 2: effectiveEnterCount must be 0, not NaN.
{
	const fake = createFakeTmux();
	fake.program([okResult(""), okResult("")]);
	const r = await pasteText(fake, [], { sessionName: "smoke", windowIndex: "2" }, "hello", { pressEnterCount: NaN });
	assert.equal(r.ok, true);
	assert.equal(fake.calls.length, 2, "set + paste only; NaN treated as 0 Enters (fail-safe)");
	assert.equal(r.effectiveEnterCount, 0, `NaN pressEnterCount must yield effectiveEnterCount=0 (not NaN), got ${r.effectiveEnterCount}`);
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

// ── sendText keys mode (P5c-2-S5) ──────────────────────────────────────────

// testSendKeysMode: mode:"keys" splits whitespace tokens into individual key args,
// sends them in ONE send-keys call with NO `-l`, and fires NO trailing Enter.
{
	const fake = createFakeTmux();
	fake.program([okResult("")]);  // single send-keys call, no Enter
	const r = await sendText(fake, [], { sessionName: "smoke", windowIndex: "2" },
		"C-c", { mode: "keys" });
	assert.equal(r.ok, true);
	assert.equal(r.effectiveEnterCount, 0, `mode:"keys" must report effectiveEnterCount:0 (no trailing Enter), got ${r.effectiveEnterCount}`);
	assert.equal(fake.calls.length, 1, `mode:"keys" must be a single send-keys call, got ${fake.calls.length}`);
	const args = fake.calls[0].args;
	assert.equal(args[0], "send-keys", "uses send-keys");
	assert.equal(args[1], "-t", "argv is send-keys -t <target> <key1> [<key2>...]");
	assert.ok(!args.includes("-l"), `mode:"keys" must NOT pass -l, got: ${args.join(" ")}`);
	const targetIdx = args.indexOf("-t") + 1;
	assert.equal(args[targetIdx], "smoke:2", "uses session:index target");
	// Tokens must come AFTER the target.
	const tokens = args.slice(targetIdx + 1);
	assert.deepEqual(tokens, ["C-c"], `mode:"keys" tokens after target, got: ${tokens.join(" ")}`);
	// No Enter was fired — count calls whose last arg is "Enter".
	const enterCalls = fake.calls.filter((c) => c.args[c.args.length - 1] === "Enter").length;
	assert.equal(enterCalls, 0, `mode:"keys" must NOT fire trailing Enter, got ${enterCalls}`);
}

// testSendLiteralDefault: mode omitted → literal `-l` path (back-compat regression guard).
{
	const fake = createFakeTmux();
	fake.program([okResult(""), okResult("")]);  // send-keys -l + Enter
	const r = await sendText(fake, [], { sessionName: "smoke", windowIndex: "2" },
		"hello world");  // no opts.mode
	assert.equal(r.ok, true);
	assert.equal(fake.calls[0].args[0], "send-keys");
	assert.equal(fake.calls[0].args[1], "-l", "omitted mode must use the literal (-l) path");
	assert.equal(fake.calls[0].args[fake.calls[0].args.length - 1], "hello world", "text delivered as a single argv element");
	assert.equal(fake.calls.length, 2, "send-keys + Enter (literal default)");
}

// testSendKeysEmpty: mode:"keys" with whitespace-only text → ok:false error, no tmux call.
{
	const fake = createFakeTmux();
	// Whitespace-only: "   \t  \n  " — split on /\s+/ and filter empties yields no tokens.
	const r = await sendText(fake, [], { sessionName: "smoke", windowIndex: "2" },
		"   \t  \n  ", { mode: "keys" });
	assert.equal(r.ok, false, `mode:"keys" with whitespace-only text must reject, got ${JSON.stringify(r)}`);
	assert.match(r.error, /keys mode requires at least one key token/);
	assert.equal(fake.calls.length, 0, "no tmux invocation on empty keys rejection");
}

// testSendKeysMultiWord: mode:"keys" with "C-c Enter Up" → exactly 3 key args in one call.
{
	const fake = createFakeTmux();
	fake.program([okResult("")]);  // single send-keys call, no Enter
	const r = await sendText(fake, [], { sessionName: "smoke", windowIndex: "2" },
		"C-c Enter Up", { mode: "keys" });
	assert.equal(r.ok, true);
	assert.equal(fake.calls.length, 1, `multi-token mode:"keys" must be a single send-keys call, got ${fake.calls.length}`);
	const args = fake.calls[0].args;
	assert.equal(args[0], "send-keys");
	assert.ok(!args.includes("-l"), `mode:"keys" must NOT pass -l, got: ${args.join(" ")}`);
	const targetIdx = args.indexOf("-t") + 1;
	assert.equal(args[targetIdx], "smoke:2");
	const tokens = args.slice(targetIdx + 1);
	assert.deepEqual(tokens, ["C-c", "Enter", "Up"], `expected 3 separate key args in argv order, got: ${tokens.join(" ")}`);
	// No trailing Enter — only the Enter in the tokens list is sent.
	const enterCalls = fake.calls.filter((c) => c.args[c.args.length - 1] === "Enter").length;
	assert.equal(enterCalls, 0, `mode:"keys" trailing Enter is the caller's responsibility (not auto-fired), got ${enterCalls} standalone Enter calls`);
}

// ── waitForWindow (P5c-2-S2) ─────────────────────────────────────────────

// waitForWindow REQ-5: RegExp regex matches on second poll → matched:"regex".
{
	const fake = createFakeTmux();
	fake.program([
		okResult("still loading...\n"),
		okResult("ready ❯\n"),
	]);
	let time = 0;
	const deps = {
		now: () => time,
		sleep: async (ms) => { time += ms; },
	};
	const r = await waitForWindow(fake, [], { sessionName: "smoke", windowIndex: "2" },
		{ regex: /❯/, timeoutMs: 5000, intervalMs: 1000, lines: 50 }, deps);
	assert.equal(r.ok, true);
	assert.equal(r.matched, "regex");
	assert.equal(r.polls, 2, `expected matched on 2nd poll, got ${r.polls}`);
	assert.match(r.output, /ready/);
	// Every call is a capture-pane exec (argv shape, not routed through pasteText).
	assert.equal(fake.calls.length, 2);
	assert.equal(fake.calls[0].args[0], "capture-pane");
	assert.equal(fake.calls[1].args[0], "capture-pane");
}

// waitForWindow REQ-5: string regex is compiled via new RegExp (pipe alternation works).
{
	const fake = createFakeTmux();
	fake.program([
		okResult("thinking...\n"),
		okResult("Cooked for 5s\n"),
	]);
	let time = 0;
	const deps = {
		now: () => time,
		sleep: async (ms) => { time += ms; },
	};
	const r = await waitForWindow(fake, [], { sessionName: "smoke", windowIndex: "2" },
		{ regex: "Cooked for|Baked for|✻", timeoutMs: 5000, intervalMs: 1000, lines: 50 }, deps);
	assert.equal(r.ok, true);
	assert.equal(r.matched, "regex");
	assert.match(r.output, /Cooked/);
}

// waitForWindow REQ-6, EC3: timeoutMs fires → {ok:false, reason:"timeout"}, bounded polls, last output.
{
	const fake = createFakeTmux();
	fake.program(Array(10).fill(okResult("still loading\n")));
	let time = 0;
	const deps = {
		now: () => time,
		sleep: async (ms) => { time += ms; },
	};
	const r = await waitForWindow(fake, [], { sessionName: "smoke", windowIndex: "2" },
		{ regex: /READY/, timeoutMs: 3000, intervalMs: 1000, lines: 50 }, deps);
	assert.equal(r.ok, false);
	assert.equal(r.reason, "timeout");
	const upperBound = Math.ceil(3000 / 1000) + 1;
	assert.ok(r.polls <= upperBound, `polls ${r.polls} exceeds ceil(timeoutMs/intervalMs)+1 = ${upperBound}`);
	assert.equal(r.output, "still loading\n", "last captured output returned");
}

// waitForWindow REQ-7, EC4 positive: output stable from start; stableMs reached → matched:"stable".
{
	const fake = createFakeTmux();
	fake.program(Array(10).fill(okResult("constant output\n")));
	let time = 0;
	const deps = {
		now: () => time,
		sleep: async (ms) => { time += ms; },
	};
	const r = await waitForWindow(fake, [], { sessionName: "smoke", windowIndex: "2" },
		{ stableMs: 1000, timeoutMs: 5000, intervalMs: 500, lines: 50 }, deps);
	assert.equal(r.ok, true);
	assert.equal(r.matched, "stable");
	assert.ok(r.polls >= 3, `expected >= 3 polls to reach stable, got ${r.polls}`);
}

// waitForWindow EC4 negative control: output changes then settles, but stableMs larger than remaining time → timeout (NOT stable on first repeat).
{
	const fake = createFakeTmux();
	fake.program([
		okResult("loading 1\n"),
		okResult("loading 2\n"),
		okResult("loading 3\n"),
		okResult("settled\n"),
		okResult("settled\n"),
		okResult("settled\n"),
	]);
	let time = 0;
	const deps = {
		now: () => time,
		sleep: async (ms) => { time += ms; },
	};
	const r = await waitForWindow(fake, [], { sessionName: "smoke", windowIndex: "2" },
		{ stableMs: 5000, timeoutMs: 3000, intervalMs: 500, lines: 50 }, deps);
	assert.equal(r.ok, false, `expected timeout (stableMs too large), got ${JSON.stringify(r)}`);
	assert.equal(r.reason, "timeout");
	// The last change was at the "settled" capture; we ran out of timeoutMs before reaching 5000ms idle.
}

// waitForWindow REQ-8: long timeoutMs honored via multiple separate capture-pane execs (never one long exec).
{
	const fake = createFakeTmux();
	fake.program(Array(20).fill(okResult("loading\n")));
	let time = 0;
	const deps = {
		now: () => time,
		sleep: async (ms) => { time += ms; },
	};
	const r = await waitForWindow(fake, [], { sessionName: "smoke", windowIndex: "2" },
		{ regex: /DONE/, timeoutMs: 10000, intervalMs: 1000, lines: 50 }, deps);
	assert.equal(r.reason, "timeout");
	// Every call is a separate capture-pane exec (REQ-8 — polling, not long exec).
	for (let i = 0; i < fake.calls.length; i++) {
		assert.equal(fake.calls[i].args[0], "capture-pane", `call ${i} must be capture-pane, got: ${fake.calls[i].args[0]}`);
	}
	// 10000ms timeout / 1000ms interval = ~10 captures.
	assert.equal(fake.calls.length, 10, `expected 10 capture-pane execs, got ${fake.calls.length}`);
}

// waitForWindow EC9: capture-pane error → reason:"capture-error" immediately (does NOT spin to timeout).
{
	const fake = createFakeTmux();
	fake.program([errResult("can't find pane: smoke:99")]);
	const r = await waitForWindow(fake, [], { sessionName: "smoke", windowIndex: "99" },
		{ regex: /READY/, timeoutMs: 30000, intervalMs: 1000, lines: 50 });
	assert.equal(r.ok, false);
	assert.equal(r.reason, "capture-error");
	assert.match(r.error, /can't find pane/);
	assert.equal(r.polls, 1, "stopped after first capture error — no spin to timeout");
	assert.equal(fake.calls.length, 1);
}

// waitForWindow: neither regex nor stableMs — behaves as a plain timeout sleep-poll returning reason:"timeout".
{
	const fake = createFakeTmux();
	fake.program(Array(10).fill(okResult("anything\n")));
	let time = 0;
	const deps = {
		now: () => time,
		sleep: async (ms) => { time += ms; },
	};
	const r = await waitForWindow(fake, [], { sessionName: "smoke", windowIndex: "2" },
		{ timeoutMs: 2000, intervalMs: 1000, lines: 50 }, deps);
	assert.equal(r.ok, false);
	assert.equal(r.reason, "timeout");
}

// waitForWindow: invalid timeoutMs / intervalMs throws TypeError (programmer error, not a polled failure).
{
	await assert.rejects(
		() => waitForWindow(createFakeTmux(), [], { sessionName: "s", windowIndex: "1" }, { timeoutMs: 0 }),
		/timeoutMs must be a positive finite number/,
	);
	await assert.rejects(
		() => waitForWindow(createFakeTmux(), [], { sessionName: "s", windowIndex: "1" }, { timeoutMs: -100 }),
		/timeoutMs must be a positive finite number/,
	);
	await assert.rejects(
		() => waitForWindow(createFakeTmux(), [], { sessionName: "s", windowIndex: "1" }, { timeoutMs: NaN }),
		/timeoutMs must be a positive finite number/,
	);
	await assert.rejects(
		() => waitForWindow(createFakeTmux(), [], { sessionName: "s", windowIndex: "1" }, { timeoutMs: 5000, intervalMs: 0 }),
		/intervalMs must be a positive finite number/,
	);
}

// waitForWindow: regex takes precedence over stableMs (precedence: regex > stable).
{
	const fake = createFakeTmux();
	// Output is stable (no change) but contains the regex marker on first poll.
	fake.program(Array(10).fill(okResult("marker ❯ reached\n")));
	let time = 0;
	const deps = {
		now: () => time,
		sleep: async (ms) => { time += ms; },
	};
	const r = await waitForWindow(fake, [], { sessionName: "smoke", windowIndex: "2" },
		{ regex: /❯/, stableMs: 100, timeoutMs: 5000, intervalMs: 1000, lines: 50 }, deps);
	assert.equal(r.ok, true);
	assert.equal(r.matched, "regex", "regex hit takes precedence over stable even when output is stable");
	assert.equal(r.polls, 1);
}

// waitForWindow Blocker #1 fix: stable-from-start with stableMs==intervalMs must NOT trigger on first repeat (polls=3, not polls=2).
{
	const fake = createFakeTmux();
	fake.program(Array(10).fill(okResult("constant output\n")));
	let time = 0;
	const deps = {
		now: () => time,
		sleep: async (ms) => { time += ms; },
	};
	const r = await waitForWindow(fake, [], { sessionName: "smoke", windowIndex: "2" },
		{ stableMs: 1000, timeoutMs: 5000, intervalMs: 1000, lines: 50 }, deps);
	assert.equal(r.ok, true);
	assert.equal(r.matched, "stable");
	// Old impl returned polls=2 here (lastChangeAt seeded to startMs). New impl
	// returns polls=3 because stability window starts at the first repeat, not
	// at startMs.
	assert.equal(r.polls, 3, `expected polls=3 (first repeat is not enough), got ${r.polls}`);
}

// waitForWindow Blocker #1 negative-control: "not on first repeat" applies after every change, not just the initial capture.
{
	const fake = createFakeTmux();
	// Output changes for 2 polls then settles long enough for stableMs to trigger.
	fake.program([
		okResult("loading A\n"),
		okResult("loading B\n"),
		okResult("settled\n"),
		okResult("settled\n"),
		okResult("settled\n"),
	]);
	let time = 0;
	const deps = {
		now: () => time,
		sleep: async (ms) => { time += ms; },
	};
	const r = await waitForWindow(fake, [], { sessionName: "smoke", windowIndex: "2" },
		{ stableMs: 500, timeoutMs: 10000, intervalMs: 500, lines: 50 }, deps);
	assert.equal(r.ok, true, `expected matched:stable, got ${JSON.stringify(r)}`);
	assert.equal(r.matched, "stable");
	// Trace: output changed to "settled" at iter 3 (t=1000); lastChangeAt=null.
	// First repeat of "settled" at iter 4 (t=1500); lastChangeAt=1500.
	// Second repeat at iter 5 (t=2000); check 2000-1500=500 >= 500 -> trigger.
	// (Without the reset-to-null-on-change fix, we'd trigger at iter 4 because
	// lastChangeAt=1000 would let 1500-1000=500 trivially satisfy stableMs=500.)
	assert.equal(r.polls, 5, `expected polls=5 for stable-after-change with reset-to-null-on-change, got ${r.polls}`);
}

// waitForWindow Blocker #2 fix: caller-provided stateful RegExp (/g flag with nonzero lastIndex) does NOT skip earlier matches.
{
	const fake = createFakeTmux();
	fake.program([
		okResult("READY now\n"),
	]);
	const stateful = /READY/g;
	stateful.lastIndex = 100; // would skip the match if not copied
	let time = 0;
	const deps = {
		now: () => time,
		sleep: async (ms) => { time += ms; },
	};
	const r = await waitForWindow(fake, [], { sessionName: "smoke", windowIndex: "2" },
		{ regex: stateful, timeoutMs: 5000, intervalMs: 1000, lines: 50 }, deps);
	assert.equal(r.ok, true, `expected matched:regex, got ${JSON.stringify(r)}`);
	assert.equal(r.matched, "regex");
	assert.equal(r.polls, 1);
	// Caller's lastIndex must NOT have been mutated.
	assert.equal(stateful.lastIndex, 100, "caller's regex lastIndex must not be mutated");
}

// waitForWindow: regex-or-stable fallback — regex set but never matches, stable path must still trigger.
{
	const fake = createFakeTmux();
	fake.program(Array(10).fill(okResult("constant output\n")));
	let time = 0;
	const deps = {
		now: () => time,
		sleep: async (ms) => { time += ms; },
	};
	const r = await waitForWindow(fake, [], { sessionName: "smoke", windowIndex: "2" },
		{ regex: /NEVER/, stableMs: 500, timeoutMs: 5000, intervalMs: 500, lines: 50 }, deps);
	assert.equal(r.ok, true, `expected matched:stable (regex never matches, stable should win), got ${JSON.stringify(r)}`);
	assert.equal(r.matched, "stable");
}

// waitForWindow: mid-stream capture-error (not just first-capture) — 2 ok captures then error on 3rd.
{
	const fake = createFakeTmux();
	fake.program([
		okResult("first\n"),
		okResult("second\n"),
		errResult("window killed mid-poll"),
	]);
	const r = await waitForWindow(fake, [], { sessionName: "smoke", windowIndex: "2" },
		{ regex: /DONE/, timeoutMs: 5000, intervalMs: 1000, lines: 50 });
	assert.equal(r.ok, false);
	assert.equal(r.reason, "capture-error");
	assert.match(r.error, /window killed mid-poll/);
	assert.equal(r.polls, 3, "stopped on 3rd capture error (not first; mid-stream error path)");
}

// waitForWindow: intervalMs invalid values (NaN/Infinity/negative) match the timeoutMs coverage.
{
	for (const bad of [0, -100, NaN, Infinity, -Infinity]) {
		await assert.rejects(
			() => waitForWindow(createFakeTmux(), [], { sessionName: "s", windowIndex: "1" },
				{ timeoutMs: 5000, intervalMs: bad }),
			/intervalMs must be a positive finite number/,
			`expected TypeError for intervalMs=${bad}`,
		);
	}
}

// waitForWindow: malformed regex string throws SyntaxError BEFORE any tmux call (eager validation).
{
	const fake = createFakeTmux();
	await assert.rejects(
		() => waitForWindow(fake, [], { sessionName: "s", windowIndex: "1" },
			{ regex: "[unclosed", timeoutMs: 5000, intervalMs: 1000, lines: 50 }),
		(SyntaxError),
		"malformed regex should throw SyntaxError",
	);
	assert.equal(fake.calls.length, 0, "no tmux call on invalid regex");
}

// waitForWindow: default intervalMs/lines path — omit both, confirm DEFAULT_WAIT_INTERVAL_MS / DEFAULT_WAIT_LINES apply.
{
	const fake = createFakeTmux();
	fake.program(Array(20).fill(okResult("x\n")));
	let time = 0;
	const deps = {
		now: () => time,
		sleep: async (ms) => { time += ms; },
	};
	const r = await waitForWindow(fake, [], { sessionName: "smoke", windowIndex: "2" },
		{ regex: /NEVER/, timeoutMs: 5000 }, deps); // no intervalMs, no lines
	assert.equal(r.ok, false);
	assert.equal(r.reason, "timeout");
	// DEFAULT_WAIT_INTERVAL_MS = 1000: expect ~5 captures (5000/1000).
	assert.ok(fake.calls.length >= 4 && fake.calls.length <= 6, `expected ~5 captures with default intervalMs=1000, got ${fake.calls.length}`);
	// Every call's -S lines arg should be -50 (DEFAULT_WAIT_LINES).
	for (let i = 0; i < fake.calls.length; i++) {
		const args = fake.calls[i].args;
		const sIdx = args.indexOf("-S");
		assert.equal(args[sIdx + 1], "-50", `call ${i} should use DEFAULT_WAIT_LINES=50`);
	}
}

// ── checkExtendedKeys (P5c-2-S4) ──────────────────────────────────────────

// checkExtendedKeys: tmux 3.6 with extended-keys-format=csi-u → ok.
{
	const fake = createFakeTmux();
	fake.program([
		okResult("tmux 3.6a\n"),
		okResult("csi-u\n"),
	]);
	const r = await checkExtendedKeys(fake, []);
	assert.equal(r.ok, true, `expected ok:true for csi-u, got ${JSON.stringify(r)}`);
	assert.equal(r.format, "csi-u");
	assert.match(String(r.version), /tmux 3\.6/);
	// First call: tmux -V (no socket prefix in args beyond "-V").
	assert.equal(fake.calls[0].args[0], "-V");
	// Second call: show-option with socket prefix prepended.
	assert.equal(fake.calls[1].args[0], "show-option");
	assert.equal(fake.calls[1].args[1], "-gv");
	assert.equal(fake.calls[1].args[2], "extended-keys-format");
}

// checkExtendedKeys: tmux 3.6 with extended-keys-format=xterm-keys → !ok.
{
	const fake = createFakeTmux();
	fake.program([
		okResult("tmux 3.6\n"),
		okResult("xterm-keys\n"),
	]);
	const r = await checkExtendedKeys(fake, []);
	assert.equal(r.ok, false, `expected ok:false for xterm-keys, got ${JSON.stringify(r)}`);
	assert.equal(r.format, "xterm-keys");
	assert.match(String(r.warning), /extended-keys-format is "xterm-keys"/);
	assert.match(String(r.warning), /csi-u/);
}

// checkExtendedKeys: tmux 3.4 → !ok (version < 3.5). No show-option call.
{
	const fake = createFakeTmux();
	fake.program([
		okResult("tmux 3.4\n"),
	]);
	const r = await checkExtendedKeys(fake, []);
	assert.equal(r.ok, false, `expected ok:false for tmux < 3.5, got ${JSON.stringify(r)}`);
	assert.match(String(r.warning), /does not support extended-keys-format/);
	assert.match(String(r.warning), /3\.4/);
	assert.equal(fake.calls.length, 1, "no show-option call when version < 3.5");
}

// checkExtendedKeys: tmux -V parse failure → !ok (unparseable output).
{
	const fake = createFakeTmux();
	fake.program([
		okResult("garbage output with no version\n"),
	]);
	const r = await checkExtendedKeys(fake, []);
	assert.equal(r.ok, false, `expected ok:false for parse failure, got ${JSON.stringify(r)}`);
	assert.match(String(r.warning), /could not parse tmux version/);
	assert.equal(r.version, "garbage output with no version");
	assert.equal(fake.calls.length, 1, "no show-option call on parse failure");
}

// checkExtendedKeys: tmux 3.5 (edge — exactly the threshold) with csi-u → ok.
{
	const fake = createFakeTmux();
	fake.program([
		okResult("tmux 3.5\n"),
		okResult("csi-u\n"),
	]);
	const r = await checkExtendedKeys(fake, []);
	assert.equal(r.ok, true, `tmux 3.5 (threshold) with csi-u should be ok, got ${JSON.stringify(r)}`);
}

// checkExtendedKeys: tmux -V exec fails → !ok with error message.
{
	const fake = createFakeTmux();
	fake.program([
		errResult("spawn tmux ENOENT", -1),
	]);
	const r = await checkExtendedKeys(fake, []);
	assert.equal(r.ok, false);
	assert.match(String(r.warning), /version check failed/);
	assert.equal(fake.calls.length, 1);
}

// checkExtendedKeys: show-option fails (option not found, etc.) → !ok.
{
	const fake = createFakeTmux();
	fake.program([
		okResult("tmux 3.6\n"),
		errResult("unknown option: extended-keys-format", 1),
	]);
	const r = await checkExtendedKeys(fake, []);
	assert.equal(r.ok, false);
	assert.match(String(r.warning), /could not read extended-keys-format option/);
	assert.equal(fake.calls.length, 2);
}

// checkExtendedKeys: tmux next-3.6 → ok (version parser strips "next-" prefix).
{
	const fake = createFakeTmux();
	fake.program([
		okResult("tmux next-3.6\n"),
		okResult("csi-u\n"),
	]);
	const r = await checkExtendedKeys(fake, []);
	assert.equal(r.ok, true, `tmux next-3.6 with csi-u should be ok, got ${JSON.stringify(r)}`);
	assert.equal(r.format, "csi-u");
}

// checkExtendedKeys: executor.exec() throws (rejection, not {ok:false}) → caught, returns {ok:false, warning}.
{
	const fake = createFakeTmux();
	fake.exec = async () => { throw new Error("executor exploded"); };
	const r = await checkExtendedKeys(fake, []);
	assert.equal(r.ok, false, `executor throw should yield ok:false, got ${JSON.stringify(r)}`);
	assert.match(String(r.warning), /exploded/);
}

// checkExtendedKeys: show-option executor.exec() throws → caught, returns {ok:false, version, warning}.
{
	const fake = createFakeTmux();
	let callCount = 0;
	fake.exec = async (args) => {
		callCount++;
		if (callCount === 1) return { ok: true, stdout: "tmux 3.6\n", stderr: "", exitCode: 0 };
		throw new Error("show-option exec threw");
	};
	const r = await checkExtendedKeys(fake, []);
	assert.equal(r.ok, false);
	assert.equal(r.version, "tmux 3.6");
	assert.match(String(r.warning), /show-option exec threw/);
}

// ── driveClaude (P5c-2-S6) ────────────────────────────────────────────────────

// testDriveRefusesUnprefixed: non-prefixed target → phase:"resolve", error, 0 tmux calls.
// Phase 0 (resolveTarget) is pure — no executor.exec() calls fire when the
// prefix-gate rejects the identifier. This is the safety invariant: the
// orchestrator MUST short-circuit before any tmux exec if the window is
// unsafe, so a hostile LLM can't probe tmux state via driveClaude.
{
	const fake = createFakeTmux();
	const windows = [
		{ sessionName: "smoke", windowIndex: "1", windowName: "zsh" }, // NOT prefixed
	];
	const r = await driveClaude(fake, [], windows, "pi-agent-", {
		window: "zsh",
		prompt: "hi",
	});
	assert.equal(r.ok, false, `unprefixed target must refuse, got ${JSON.stringify(r)}`);
	assert.equal(r.phase, "resolve", `unprefixed → phase:"resolve", got ${r.phase}`);
	assert.match(r.error ?? "", /does not match prefix/, "error mentions prefix mismatch");
	assert.equal(fake.calls.length, 0, `phase:resolve must NOT fire any tmux exec, got ${fake.calls.length}`);
}

// testDriveHappyPath: all 4 phases succeed → phase:"capture" with output.
// Call sequence (8 tmux execs total):
//   1. capture-pane  (ready poll 1 — no match)
//   2. capture-pane  (ready poll 2 — "❯" hits DEFAULT_DRIVE_READY_REGEX)
//   3. set-buffer    (pasteText: S1 argv-only delivery)
//   4. paste-buffer  (pasteText: bracketed paste + delete)
//   5. send-keys     (pasteText: trailing Enter, default pressEnterCount:1)
//   6. capture-pane  (done poll 1 — no match)
//   7. capture-pane  (done poll 2 — "Cooked for" hits DEFAULT_DRIVE_DONE_REGEX)
//   8. capture-pane  (final captureWindow — returned to LLM)
{
	const fake = createFakeTmux();
	fake.program([
		okResult("loading...\n"),      // ready poll 1: no match
		okResult("ready ❯\n"),         // ready poll 2: regex hit
		okResult(""),                  // set-buffer
		okResult(""),                  // paste-buffer -d -p
		okResult(""),                  // send-keys Enter
		okResult("thinking...\n"),     // done poll 1: no match
		okResult("Cooked for 5s\n"),   // done poll 2: regex hit
		okResult("Cooked for 5s\n❯\n"), // final capture: returned verbatim
	]);
	const windows = [
		{ sessionName: "smoke", windowIndex: "1", windowName: "pi-agent-bg-abc" },
	];
	const r = await driveClaude(fake, [], windows, "pi-agent-", {
		window: "pi-agent-bg-abc",
		prompt: "what is the meaning of life",
	});
	assert.equal(r.ok, true, `happy path must succeed, got ${JSON.stringify(r)}`);
	assert.equal(r.phase, "capture", `happy path ends at phase:"capture", got ${r.phase}`);
	assert.equal(r.target, "smoke:1", "target = sessionName:windowIndex");
	assert.equal(r.output, "Cooked for 5s\n❯\n", "final capture returned verbatim");
	assert.equal(fake.calls.length, 8, `happy path = 8 tmux execs (2+3+2+1), got ${fake.calls.length}`);
	// Call-shape verification — every phase lands where it should.
	assert.equal(fake.calls[0].args[0], "capture-pane", "call 0: ready poll 1");
	assert.equal(fake.calls[1].args[0], "capture-pane", "call 1: ready poll 2");
	assert.equal(fake.calls[2].args[0], "set-buffer", "call 2: pasteText set-buffer");
	assert.equal(fake.calls[3].args[0], "paste-buffer", "call 3: pasteText paste-buffer -p");
	assert.equal(fake.calls[4].args[0], "send-keys", "call 4: pasteText trailing Enter");
	assert.equal(fake.calls[5].args[0], "capture-pane", "call 5: done poll 1");
	assert.equal(fake.calls[6].args[0], "capture-pane", "call 6: done poll 2");
	assert.equal(fake.calls[7].args[0], "capture-pane", "call 7: final captureWindow");
	// Paste target uses session:index format (paste-buffer -t smoke:1).
	const pasteCall = fake.calls[3].args;
	const pasteTargetIdx = pasteCall.indexOf("-t") + 1;
	assert.equal(pasteCall[pasteTargetIdx], "smoke:1", "paste-buffer targets smoke:1");
	// Enter key arg must be exactly "Enter".
	assert.equal(fake.calls[4].args[fake.calls[4].args.length - 1], "Enter", "send-keys fires Enter");
}

// testDriveReadyTimeout: ready wait times out → phase:"ready", 0 paste/final-capture calls.
// Uses a short readyTimeoutMs (2000) so the test completes in ~2-3 seconds.
// readyTimeoutMs < DEFAULT_DRIVE_READY_TIMEOUT_MS (30s) so this is a fast test.
{
	const fake = createFakeTmux();
	// Always-returning "loading" — never matches the default ready regex (❯).
	fake.program(Array(10).fill(okResult("loading\n")));
	const windows = [
		{ sessionName: "smoke", windowIndex: "1", windowName: "pi-agent-bg-abc" },
	];
	const start = Date.now();
	const r = await driveClaude(fake, [], windows, "pi-agent-", {
		window: "pi-agent-bg-abc",
		prompt: "hi",
		readyTimeoutMs: 2000,
	});
	const elapsed = Date.now() - start;
	assert.equal(r.ok, false, `ready timeout must fail, got ${JSON.stringify(r)}`);
	assert.equal(r.phase, "ready", `ready timeout → phase:"ready", got ${r.phase}`);
	assert.equal(r.target, "smoke:1", "target still set on ready-phase failure");
	assert.match(r.error ?? "", /(timeout|after)/, "error mentions wait reason");
	assert.ok(elapsed < 6000, `ready timeout (2000ms + slack) should be fast, took ${elapsed}ms`);
	// Critical: pasteText and final capture MUST NOT have fired.
	// All fake.calls are capture-pane from the ready wait loop.
	for (let i = 0; i < fake.calls.length; i++) {
		assert.equal(fake.calls[i].args[0], "capture-pane", `call ${i} must be capture-pane (ready wait only), got ${fake.calls[i].args[0]}`);
	}
}

// testDriveDoneTimeoutPartial: paste succeeds but done wait times out → phase:"done", partial output.
// Drives the most useful failure mode: paste landed, TUI produced SOMETHING,
// but never reached the "Cooked for" marker before doneTimeoutMs fired.
// The orchestrator must return the partial output so the LLM can read it.
{
	const fake = createFakeTmux();
	fake.program([
		okResult("ready ❯\n"),         // ready poll 1: regex hits on first try
		okResult(""),                  // set-buffer
		okResult(""),                  // paste-buffer -d -p
		okResult(""),                  // send-keys Enter
		okResult("thinking step 1\n"), // done poll 1
		okResult("thinking step 2\n"), // done poll 2
		okResult("thinking step 3\n"), // done poll 3 — last capture before timeout
	]);
	const windows = [
		{ sessionName: "smoke", windowIndex: "1", windowName: "pi-agent-bg-abc" },
	];
	const start = Date.now();
	const r = await driveClaude(fake, [], windows, "pi-agent-", {
		window: "pi-agent-bg-abc",
		prompt: "hi",
		doneTimeoutMs: 3000,
	});
	const elapsed = Date.now() - start;
	assert.equal(r.ok, false, `done timeout must fail, got ${JSON.stringify(r)}`);
	assert.equal(r.phase, "done", `done timeout → phase:"done", got ${r.phase}`);
	assert.equal(r.target, "smoke:1", "target still set on done-phase failure");
	// Partial output: the LAST capture from the done wait loop. With
	// doneTimeoutMs=3000 + intervalMs=1000, only 3 done polls fire
	// (iter 1 at t=0, iter 2 at t=1000, iter 3 at t=2000; then sleep to
	// t=3000, then the while-check fires and we exit before a 4th poll).
	assert.ok(r.output !== undefined, "partial output must be present on done timeout");
	assert.equal(r.output, "thinking step 3\n", `partial output must be the LAST done-wait capture, got: ${JSON.stringify(r.output)}`);
	// Error explains the reason.
	assert.match(r.error ?? "", /(timeout|after)/, "error mentions wait reason");
	assert.ok(elapsed < 8000, `done timeout (3000ms + ready + slack) should be bounded, took ${elapsed}ms`);
	// Sanity: 1 ready capture + 3 paste calls + 3 done captures = 7.
	assert.equal(fake.calls.length, 7, `done-timeout path = 1 ready + 3 paste + 3 done, got ${fake.calls.length}`);
	// No final captureWindow fires on done timeout.
	assert.equal(fake.calls[fake.calls.length - 1].args[0], "capture-pane", "last call is capture-pane (done-wait poll, not final capture)");
}

console.log("test-exec: all tests passed");
