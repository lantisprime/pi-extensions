// P5b-1-S4: 9 unit tests for cmux-terminal/lib/tools.ts
// (cmuxPaste / cmuxWaitFor / cmuxSendKeys).
//
// Mirrors tmux-control/test-fixtures/test-exec.mjs: injects a
// FakeCmuxExecutor, asserts exact argv shapes (cmux CLI surface pinned by
// the S2.5 spike at cmux-terminal/docs/cli-spike-output.txt), and exercises
// the regex / stable / timeout paths on the wait function via fake time.
//
// cmux 0.64.17 command surface asserted by these tests:
//   paste  → `cmux send --surface <ref> <text>` + optional `cmux send-key --surface <ref> enter`
//   wait   → `cmux read-screen --surface <ref> --lines <n>` (polled)
//   send   → literal: `cmux send --surface <ref> <text>` (+ optional Enter)
//            keys:    one `cmux send-key --surface <ref> <token>` per token
import assert from "node:assert/strict";
import { cmuxPaste, cmuxWaitFor, cmuxSendKeys } from "../lib/tools.ts";
import { FakeCmuxExecutor } from "./fake-cmux.ts";

const SAMPLE_SURFACE = "surface:11";

// Test 1: PasteCallsSendText — argv is exactly ["send", "--surface", "<ref>", "<text>"]
// The 4-element shape is pinned by REQ-T2: cmuxPaste uses `cmux send --surface
// <ref> '<text>'`, NOT `send-keys`. The text is shell-escaped (single-quote
// wrapped) for safety, mirroring the cmux-backend.ts pattern.
{
	const fake = new FakeCmuxExecutor();
	fake.setDefaultResponse({ ok: true, stdout: "", stderr: "", exitCode: 0 });
	const r = await cmuxPaste(fake, { window: SAMPLE_SURFACE, text: "hello", pressEnter: false });
	assert.equal(r.ok, true, "paste must succeed with valid inputs");
	assert.equal(fake.calls.length, 1, "pressEnter:false should be a single send call (no Enter)");
	const args = fake.calls[0].args;
	assert.deepEqual(
		args,
		["send", "--surface", SAMPLE_SURFACE, "'hello'"],
		"argv MUST be exactly [" + JSON.stringify(["send", "--surface", SAMPLE_SURFACE, "'hello'"]) + "] (send --surface <ref> <shell-escaped text>). No --workspace flag (matches task spec).",
	);
	assert.equal(args[0], "send", "first arg must be `send` (literal text), not `send-keys` (key tokens)");
	assert.equal(args[1], "--surface", "must use --surface flag (not --workspace)");
	assert.equal(args[2], SAMPLE_SURFACE, "must pass the surface ref after --surface");
}

// Test 2: PasteUsesSendNotSendKeys — assert NOT ["send-keys", ...]
// REQ-T2: cmuxPaste uses `cmux send` for literal text, NOT `cmux send-keys`
// (which is for key tokens like "C-c", "Up"). The S2.5 spike pinned this.
{
	const fake = new FakeCmuxExecutor();
	fake.setDefaultResponse({ ok: true, stdout: "", stderr: "", exitCode: 0 });
	const r = await cmuxPaste(fake, { window: SAMPLE_SURFACE, text: "hello world", pressEnter: false });
	assert.equal(r.ok, true);
	const sendKeysCalls = fake.calls.filter((c) => c.args[0] === "send-keys");
	assert.equal(sendKeysCalls.length, 0, "cmuxPaste MUST NOT use `cmux send-keys` (that's for key tokens, not literal text)");
	const sendCalls = fake.calls.filter((c) => c.args[0] === "send");
	assert.equal(sendCalls.length, 1, "cmuxPaste MUST use `cmux send` for literal text");
}

// Test 3: PasteShellescapes — special chars in text are shell-escaped
// REQ-T2 + defensive: text with shell metachars (`;`, `|`, `'`, `$`, space)
// MUST be single-quote wrapped in argv so the receiving terminal's shell
// can't interpret them. Mirrors cmux-backend.ts's pattern for the
// `workspace create --command` payload.
{
	const fake = new FakeCmuxExecutor();
	fake.setDefaultResponse({ ok: true, stdout: "", stderr: "", exitCode: 0 });
	const evil = "echo hello; touch /tmp/pwned; rm -rf $HOME";
	const r = await cmuxPaste(fake, { window: SAMPLE_SURFACE, text: evil, pressEnter: false });
	assert.equal(r.ok, true);
	const sendCall = fake.calls.find((c) => c.args[0] === "send");
	assert.ok(sendCall, "must have called cmux send");
	const textArg = sendCall.args[sendCall.args.length - 1];
	// POSIX shell single-quote escape: wrap the whole text in single quotes.
	// The metachars are now inert — the receiving shell strips the wrapping
	// quotes and sees the original text as one token (so it would try to run
	// "echo hello; touch /tmp/pwned; rm -rf $HOME" as one command, which
	// won't exist, but that's the receiving shell's problem, not injection).
	assert.equal(
		textArg,
		"'" + evil + "'",
		"text with metachars MUST be POSIX-shell-escaped (single-quote wrapped) in argv (got: " + textArg + ")",
	);
	// Defensive: the metachars MUST NOT appear unquoted (would inject).
	const unquotedSpace = textArg.indexOf(" " + evil);
	assert.equal(unquotedSpace, -1, "metachars MUST NOT appear unquoted in argv (would inject into receiving shell)");
}

// Test 4: WaitForExitsOnRegexMatch — exits when regex matches
// REQ-T3: cmuxWaitFor polls `cmux read-screen --surface <ref> --lines <n>`
// and returns matched:true on the first regex hit. Mirrors tmux-control
// wait.ts REQ-5 (RegExp regex matches on second poll).
{
	const fake = new FakeCmuxExecutor();
	fake.enqueueResponse({ ok: true, stdout: "still loading...\n", stderr: "", exitCode: 0 });
	fake.enqueueResponse({ ok: true, stdout: "ready ❯\n", stderr: "", exitCode: 0 });
	let time = 0;
	const deps = {
		now: () => time,
		sleep: async (ms) => { time += ms; },
	};
	const r = await cmuxWaitFor(
		fake,
		{ window: SAMPLE_SURFACE, regex: /❯/, timeoutMs: 5000 },
		deps,
	);
	assert.equal(r.ok, true);
	assert.equal(r.matched, true, "matched must be true on regex hit");
	assert.equal(r.iterations, 2, "expected match on 2nd poll, got " + r.iterations);
	assert.match(r.output, /ready/, "output must contain the matched screen content");
	// Every call must be `cmux read-screen --surface <ref> --lines <n>`.
	assert.equal(fake.calls.length, 2);
	for (let i = 0; i < fake.calls.length; i++) {
		assert.equal(fake.calls[i].args[0], "read-screen", "call " + i + " must be read-screen (argv[0])");
		assert.equal(fake.calls[i].args[1], "--surface", "call " + i + " must use --surface (argv[1])");
		assert.equal(fake.calls[i].args[2], SAMPLE_SURFACE, "call " + i + " must pass the surface ref (argv[2])");
		assert.equal(fake.calls[i].args[3], "--lines", "call " + i + " must use --lines (argv[3])");
		assert.equal(fake.calls[i].args[4], "50", "call " + i + " must use default lines=50 (argv[4])");
	}
}

// Test 5: WaitForTimesOutCleanly — returns error on timeout
// REQ-T3 + REQ-T6: timeoutMs fires → {ok:false, error:"timeout"}. Polls
// bounded by timeoutMs/intervalMs.
{
	const fake = new FakeCmuxExecutor();
	fake.setDefaultResponse({ ok: true, stdout: "still loading\n", stderr: "", exitCode: 0 });
	let time = 0;
	const deps = {
		now: () => time,
		sleep: async (ms) => { time += ms; },
	};
	const r = await cmuxWaitFor(
		fake,
		{ window: SAMPLE_SURFACE, regex: /READY/, timeoutMs: 3000 },
		deps,
	);
	assert.equal(r.ok, false);
	assert.equal(r.error, "timeout", "must return error:'timeout' when no regex match within timeoutMs");
	// Polls bounded by ceil(timeoutMs/intervalMs)+1 (default interval=1000ms).
	// With timeoutMs=3000 and intervalMs=1000, we expect ~3 polls. The
	// failure result intentionally omits `iterations` (per spec — failure
	// return is just {ok:false, error}), so we check the fake's call count
	// instead.
	const upperBound = Math.ceil(3000 / 1000) + 1;
	assert.ok(fake.calls.length <= upperBound, "polls " + fake.calls.length + " exceeds ceil(timeoutMs/intervalMs)+1 = " + upperBound);
}

// Test 6: WaitForStableMsDefault — stableMs works with default lines/intervalMs
// REQ-T3: stableMs-based detection mirrors tmux-control wait.ts. With
// constant output, the first repeat (iter 2) starts the stability window;
// the second repeat (iter 3) triggers matched:true when now-lastChangeAt
// >= stableMs. So iterations >= 3.
{
	const fake = new FakeCmuxExecutor();
	fake.setDefaultResponse({ ok: true, stdout: "constant output\n", stderr: "", exitCode: 0 });
	let time = 0;
	const deps = {
		now: () => time,
		sleep: async (ms) => { time += ms; },
	};
	const r = await cmuxWaitFor(
		fake,
		{ window: SAMPLE_SURFACE, stableMs: 1000, timeoutMs: 5000 },
		deps,
	);
	assert.equal(r.ok, true);
	assert.equal(r.matched, true, "stableMs must trigger matched:true on stable output");
	// With stableMs=1000 and intervalMs=1000 (default), the first repeat
	// (iter 2) sets lastChangeAt=1000, and the second repeat (iter 3, t=2000)
	// checks 2000-1000=1000 >= 1000 → trigger. So iterations=3.
	assert.ok(r.iterations >= 3, "expected >= 3 polls to reach stable (first repeat doesn't count), got " + r.iterations);
	assert.equal(r.iterations, 3, "with stableMs==intervalMs==1000, expected exactly 3 polls, got " + r.iterations);
}

// Test 7: SendKeysLiteralMode — uses `cmux send` (not `cmux send-key`)
// REQ-T4: in literal mode (the default), the whole text is sent as one
// chunk via `cmux send --surface <ref> <text>`. The S2.5 spike pinned this.
{
	const fake = new FakeCmuxExecutor();
	fake.setDefaultResponse({ ok: true, stdout: "", stderr: "", exitCode: 0 });
	const r = await cmuxSendKeys(fake, { window: SAMPLE_SURFACE, text: "hello world", pressEnter: false });
	assert.equal(r.ok, true);
	const sendCalls = fake.calls.filter((c) => c.args[0] === "send");
	const sendKeyCalls = fake.calls.filter((c) => c.args[0] === "send-key");
	assert.equal(sendCalls.length, 1, "literal mode MUST use `cmux send` (one call)");
	assert.equal(sendKeyCalls.length, 0, "literal mode with pressEnter:false MUST NOT call `cmux send-key`");
	// argv shape: send --surface <ref> <shell-escaped text>
	const args = sendCalls[0].args;
	assert.equal(args[0], "send", "argv[0] must be 'send'");
	assert.equal(args[1], "--surface", "argv[1] must be '--surface'");
	assert.equal(args[2], SAMPLE_SURFACE, "argv[2] must be the surface ref");
	// 'hello world' is shell-escaped (contains a space) → wrapped in single quotes.
	assert.equal(args[3], "'hello world'", "literal mode delivers shell-escaped text as a single argv element (got: " + args[3] + ")");
	// sentKeys reports the single chunk sent (the text itself).
	assert.deepEqual(r.sentKeys, ["hello world"], "literal mode sentKeys must report the text chunk");
	assert.equal(r.pressEnter, false, "literal mode with pressEnter:false must report pressEnter:false");
}

// Test 8: SendKeysKeysMode — splits tokens, uses `send-key` per token
// REQ-T4: in keys mode, each whitespace-separated token in `text` is sent
// as a separate `cmux send-key --surface <ref> <token>` invocation. Mirrors
// tmux-control send.ts S5 keys-mode semantics (one call per token, no -l).
{
	const fake = new FakeCmuxExecutor();
	fake.setDefaultResponse({ ok: true, stdout: "", stderr: "", exitCode: 0 });
	const r = await cmuxSendKeys(fake, { window: SAMPLE_SURFACE, text: "C-c Enter Up", mode: "keys" });
	assert.equal(r.ok, true);
	assert.deepEqual(r.sentKeys, ["C-c", "Enter", "Up"], "keys mode sentKeys must report the token list in order");
	assert.equal(fake.calls.length, 3, "keys mode MUST issue one send-key per token (3 tokens = 3 calls)");
	for (let i = 0; i < 3; i++) {
		const args = fake.calls[i].args;
		assert.equal(args[0], "send-key", "call " + i + " must use `cmux send-key`");
		assert.equal(args[1], "--surface", "call " + i + " must use --surface");
		assert.equal(args[2], SAMPLE_SURFACE, "call " + i + " must pass the surface ref");
		assert.equal(args[3], ["C-c", "Enter", "Up"][i], "call " + i + " must pass the i-th token");
	}
	// No `cmux send` (literal) call in keys mode.
	const sendCalls = fake.calls.filter((c) => c.args[0] === "send");
	assert.equal(sendCalls.length, 0, "keys mode MUST NOT use `cmux send`");
}

// Test 9: SendKeysKeysModePressEnterDefault — pressEnter defaults to false in keys mode
// REQ-T4: in keys mode, the trailing Enter is the caller's responsibility
// (caller appends "Enter" as a final token). Mirrors tmux-control send.ts
// S5 keys-mode: NO implicit trailing Enter.
{
	const fake = new FakeCmuxExecutor();
	fake.setDefaultResponse({ ok: true, stdout: "", stderr: "", exitCode: 0 });
	// No pressEnter specified — must default to false in keys mode.
	const r = await cmuxSendKeys(fake, { window: SAMPLE_SURFACE, text: "C-c", mode: "keys" });
	assert.equal(r.ok, true);
	assert.equal(r.pressEnter, false, "keys mode MUST default pressEnter to false (caller appends Enter as a token if needed)");
	// No "enter" key call should be issued.
	const enterCalls = fake.calls.filter((c) => c.args[c.args.length - 1] === "enter");
	assert.equal(enterCalls.length, 0, "keys mode with default pressEnter MUST NOT fire a separate Enter call");
	assert.equal(fake.calls.length, 1, "keys mode default pressEnter MUST be a single send-key call (no auto Enter)");
	// The single call should be send-key C-c, not send-key enter.
	const args = fake.calls[0].args;
	assert.equal(args[0], "send-key");
	assert.equal(args[3], "C-c", "default pressEnter in keys mode must send the literal token, not 'enter'");
}

console.log("P5b-1 cmux-tools tests passed");
