// herdr-control: NLP matcher tests (conservative, >= 0.8 confidence only).
import assert from "node:assert/strict";
import { matchHerdrNlp } from "../lib/nlp.ts";

// list
assert.deepEqual(matchHerdrNlp("list herdr agents"), { action: "list", confidence: 0.95 });
assert.deepEqual(matchHerdrNlp("herdr agents"), { action: "list", confidence: 0.95 });
assert.deepEqual(matchHerdrNlp("  Herdr Agents? "), { action: "list", confidence: 0.95 });

// spawn
{
	const m = matchHerdrNlp("herdr spawn pi-herdr-reviewer review the auth diff");
	assert.equal(m.action, "spawn");
	assert.equal(m.confidence, 0.85);
	assert.equal(m.rest, "pi-herdr-reviewer review the auth diff");
}

// pass-through
assert.equal(matchHerdrNlp("what is herdr?"), null, "questions pass through");
assert.equal(matchHerdrNlp("list agents"), null);
assert.equal(matchHerdrNlp("herdr spawn"), null, "spawn without name/task passes through");
assert.equal(matchHerdrNlp("herdr spawn x"), null, "spawn without task passes through");
assert.equal(matchHerdrNlp(""), null);

console.log("test-nlp: all tests passed");
