// herdr-control: safety module tests (names, prefixes, refs, keys, gate).
import assert from "node:assert/strict";
import {
	isValidAgentName,
	matchesPrefix,
	isPaneRef,
	requirePaneRef,
	validateKeyTokens,
	insideHerdr,
	herdrGateError,
} from "../lib/safety.ts";

// agent names: [a-z][a-z0-9_-]{0,31}
assert.equal(isValidAgentName("pi-herdr-reviewer"), true);
assert.equal(isValidAgentName("a"), true);
assert.equal(isValidAgentName("a".repeat(32)), true);
assert.equal(isValidAgentName("a".repeat(33)), false, "33 chars exceeds herdr limit");
assert.equal(isValidAgentName("Reviewer"), false, "uppercase rejected");
assert.equal(isValidAgentName("1reviewer"), false, "must start with a letter");
assert.equal(isValidAgentName("has space"), false);
assert.equal(isValidAgentName(""), false);

// prefix gate
assert.equal(matchesPrefix("pi-herdr-x", "pi-herdr-"), true);
assert.equal(matchesPrefix("other-x", "pi-herdr-"), false);
assert.equal(matchesPrefix("anything", ""), true, "empty prefix allows all");

// pane refs
assert.equal(isPaneRef("w9:p1"), true);
assert.equal(isPaneRef("w123:p45"), true);
assert.equal(isPaneRef("w:p1"), false);
assert.equal(isPaneRef("9:p1"), false);
assert.equal(isPaneRef("surface:1"), false);
assert.equal(requirePaneRef("w1:p2").ok, true);
assert.equal(requirePaneRef("bogus").ok, false);

// key tokens
assert.deepEqual(validateKeyTokens("esc").tokens, ["esc"]);
assert.deepEqual(validateKeyTokens("ctrl+c enter").tokens, ["ctrl+c", "enter"]);
assert.deepEqual(validateKeyTokens("escape up down left right").ok, true);
assert.equal(validateKeyTokens("").ok, false, "empty rejected");
assert.equal(validateKeyTokens("rm -rf /").ok, false, "shell text rejected");
assert.equal(validateKeyTokens("a b c d e f g h i").ok, false, "more than 8 keys rejected");
assert.equal(validateKeyTokens("ctrl+c ctrl+c ctrl+c ctrl+c ctrl+c ctrl+c ctrl+c ctrl+c ctrl+c").ok, false);
assert.equal(validateKeyTokens("SUPER_NOVA").ok, false, "unknown long key rejected");

// env gate
const savedEnv = process.env.HERDR_ENV;
process.env.HERDR_ENV = "1";
assert.equal(insideHerdr(), true);
process.env.HERDR_ENV = "";
assert.equal(insideHerdr(), false);
assert.match(herdrGateError(), /HERDR_ENV/);
if (savedEnv === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = savedEnv;

console.log("test-safety: all tests passed");
