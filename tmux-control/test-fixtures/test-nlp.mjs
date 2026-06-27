// Tests for lib/nlp.ts.
import assert from "node:assert/strict";
import { matchNlp, isCandidate } from "../lib/nlp.ts";

function eq(a, b, msg) { assert.deepEqual(a, b, msg); }

// isCandidate: positive
{
	assert.equal(isCandidate("tail bg-abc123"), true);
	assert.equal(isCandidate("list agents"), true);
	assert.equal(isCandidate("tmux list"), true);
}

// isCandidate: negative
{
	assert.equal(isCandidate("hello world"), false, "no runId or tmux keyword");
	assert.equal(isCandidate("/tmux-list"), false, "slash command excluded");
	assert.equal(isCandidate(""), false, "empty excluded");
}

// Capture patterns
eq(matchNlp("tail bg-abc123"), { action: "capture", runId: "bg-abc123", lines: undefined, confidence: 0.85 }, "tail bare runId");
eq(matchNlp("tail bg-abc123 last 50"), { action: "capture", runId: "bg-abc123", lines: 50, confidence: 0.85 }, "tail with line count");
eq(matchNlp("show me bg-abc123"), { action: "capture", runId: "bg-abc123", lines: undefined, confidence: 0.85 }, "show me");
eq(matchNlp("what is bg-abc123 doing?"), { action: "capture", runId: "bg-abc123", lines: undefined, confidence: 0.85 }, "what is doing");
eq(matchNlp("capture last 50 lines of bg-abc123"), { action: "capture", runId: "bg-abc123", lines: 50, confidence: 0.85 }, "capture last N lines");
eq(matchNlp("peek bg-abc123"), { action: "capture", runId: "bg-abc123", lines: undefined, confidence: 0.85 }, "peek");

// Send patterns
eq(matchNlp(`send "continue" to bg-abc123`), { action: "send", runId: "bg-abc123", text: "continue", confidence: 0.95 }, "send with double quotes");
eq(matchNlp(`send 'try again' to bg-abc123`), { action: "send", runId: "bg-abc123", text: "try again", confidence: 0.95 }, "send with single quotes");
eq(matchNlp(`tell bg-abc123 'hello'`), { action: "send", runId: "bg-abc123", text: "hello", confidence: 0.95 }, "tell with runId first");

// List patterns
eq(matchNlp("list agents"), { action: "list", confidence: 0.9 }, "list agents");
eq(matchNlp("tmux list"), { action: "list", confidence: 0.9 }, "tmux list");
eq(matchNlp("list tmux windows"), { action: "list", confidence: 0.9 }, "list tmux windows");
eq(matchNlp("list"), null, "bare 'list' is too generic");

// Launch patterns
eq(matchNlp("launch a tmux session named dev"), { action: "launch", sessionName: "dev", command: undefined, confidence: 0.8 }, "launch named");
{
	const m = matchNlp("start a tmux session for npm run dev");
	assert.ok(m && m.action === "launch", "start a tmux session for command");
	assert.equal(m.command, "npm run dev", "command captured");
}
{
	const m = matchNlp("spawn tmux");
	assert.ok(m && m.action === "launch", "bare spawn matches launch");
	assert.ok(m && typeof m.sessionName === "string" && m.sessionName.startsWith("pi-ctrl-"), `auto-generated session name: ${m?.sessionName}`);
}

// Non-matches (must not false-positive)
assert.equal(matchNlp("hello world"), null, "plain greeting doesn't match");
assert.equal(matchNlp("show me the latest from the project"), null, "show me without runId doesn't match");
assert.equal(matchNlp("please list all files in this directory"), null, "list without tmux keyword + agents/windows doesn't match");
assert.equal(matchNlp("send the email to john"), null, "send without quoted text + bg-xxx doesn't match");

console.log("test-nlp: all tests passed");