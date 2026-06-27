// Tests for lib/safety.ts.
import assert from "node:assert/strict";
import { isValidWindowName, matchesPrefix, resolveWindowName, resolveTarget } from "../lib/safety.ts";

function ok(cond, msg) {
	assert.ok(cond, msg);
}
function eq(a, b, msg) {
	assert.deepEqual(a, b, msg);
}

// isValidWindowName
ok(isValidWindowName("pi-agent-bg-abc"), "plain window name is valid");
ok(isValidWindowName("main"), "simple name is valid");
ok(!isValidWindowName(""), "empty is invalid");
ok(!isValidWindowName("a".repeat(257)), "too-long is invalid");
ok(!isValidWindowName("name with space"), "spaces are invalid");
ok(!isValidWindowName('name"quote'), "double quote is invalid");
ok(!isValidWindowName("name'quote"), "single quote is invalid");
ok(!isValidWindowName("name$var"), "dollar is invalid");
ok(!isValidWindowName("name`back"), "backtick is invalid");
ok(!isValidWindowName("name;semicolon"), "semicolon is invalid");
ok(!isValidWindowName("name|pipe"), "pipe is invalid");
ok(!isValidWindowName("name&amp"), "ampersand is invalid");

// matchesPrefix
ok(matchesPrefix("pi-agent-bg-abc", "pi-agent-"), "matches default prefix");
ok(!matchesPrefix("zsh", "pi-agent-"), "non-matching rejected");
ok(matchesPrefix("anything", ""), "empty prefix matches all");
ok(!matchesPrefix("Pi-agent-bg-abc", "pi-agent-"), "case-sensitive (no match)");

// resolveWindowName: exact match
{
	const known = ["pi-agent-bg-abc", "pi-agent-bg-def", "zsh"];
	const r = resolveWindowName("pi-agent-bg-abc", known, { prefix: "pi-agent-" });
	eq(r, { windowName: "pi-agent-bg-abc" }, "exact match returns window");
}
{
	// Known list contains a non-prefixed window; requesting it exactly should be rejected.
	const r = resolveWindowName("zsh", ["pi-agent-bg-abc", "zsh"], { prefix: "pi-agent-" });
	ok("error" in r, "non-prefixed exact match returns error");
	ok(r.error.includes("does not match prefix"), "error mentions prefix mismatch");
}

// resolveWindowName: runId → prefix expansion
{
	const r = resolveWindowName("bg-abc", ["pi-agent-bg-abc"], { prefix: "pi-agent-" });
	eq(r, { windowName: "pi-agent-bg-abc" }, "bare runId resolved via prefix expansion");
}
{
	const r = resolveWindowName("bg-zzz", ["pi-agent-bg-abc"], { prefix: "pi-agent-" });
	ok("error" in r, "unknown runId returns error");
}

// resolveWindowName: allowUnprefixed
{
	const r = resolveWindowName("zsh", ["zsh"], { prefix: "pi-agent-", allowUnprefixed: true });
	eq(r, { windowName: "zsh" }, "allowUnprefixed permits non-prefix");
}

// resolveWindowName: rejects invalid identifiers
{
	const r = resolveWindowName("name with space", ["x"], { prefix: "" });
	ok("error" in r, "invalid id rejected before lookup");
}

// resolveTarget: object-based lookup (modern API)
{
	const wins = [
		{ sessionName: "smoke", windowIndex: "1", windowName: "pi-agent-bg-abc" },
		{ sessionName: "smoke", windowIndex: "2", windowName: "zsh" },
	];
	const r = resolveTarget("pi-agent-bg-abc", wins, { prefix: "pi-agent-" });
	ok(!("error" in r), "exact match returns target");
	if ("target" in r) {
		eq(r.target.sessionName, "smoke", "session populated");
		eq(r.target.windowIndex, "1", "index populated");
	}
}
{
	// runId expansion
	const wins = [{ sessionName: "smoke", windowIndex: "1", windowName: "pi-agent-bg-abc" }];
	const r = resolveTarget("bg-abc", wins, { prefix: "pi-agent-" });
	ok("target" in r, "runId expansion matches");
	if ("target" in r) eq(r.target.windowName, "pi-agent-bg-abc", "expanded window name");
}
{
	// prefix gate rejects even when window exists
	const wins = [{ sessionName: "smoke", windowIndex: "1", windowName: "zsh" }];
	const r = resolveTarget("zsh", wins, { prefix: "pi-agent-" });
	ok("error" in r, "non-prefixed window rejected");
}
{
	// allowUnprefixed bypasses the gate
	const wins = [{ sessionName: "smoke", windowIndex: "1", windowName: "zsh" }];
	const r = resolveTarget("zsh", wins, { prefix: "pi-agent-", allowUnprefixed: true });
	ok("target" in r, "allowUnprefixed permits");
}

console.log("test-safety: all tests passed");