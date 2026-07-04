// P5d-S4: cmux-control NLP tests.
import assert from "node:assert/strict";
import { matchNlp } from "../lib/nlp.ts";

// MatchListWorkspaces
{
	assert.deepEqual(matchNlp("list cmux workspaces"), { action: "list" });
}

// MatchCmuxList
{
	assert.deepEqual(matchNlp("cmux list"), { action: "list" });
}

// MatchCaptureSurface
{
	assert.deepEqual(matchNlp("tail surface:42"), { action: "capture", surfaceRef: "surface:42" });
}

// MatchSendSurface
{
	assert.deepEqual(matchNlp(`send "hello" to surface:42`), { action: "send", surfaceRef: "surface:42", text: "hello" });
}

// MatchSplitRight
{
	assert.deepEqual(matchNlp("split pane right"), { action: "split", direction: "right" });
}

// NoMatch
{
	assert.equal(matchNlp("random text"), null);
}

console.log("test-nlp: all tests passed");
