// P5d-S2: cmux-control safety tests.
import assert from "node:assert/strict";
import { matchesPrefix, parseCmuxRef } from "../lib/safety.ts";

// ParseCmuxRefValidWorkspace
{
	assert.deepEqual(parseCmuxRef("workspace:1"), { type: "workspace", id: 1 });
}

// ParseCmuxRefValidSurface
{
	assert.deepEqual(parseCmuxRef("surface:42"), { type: "surface", id: 42 });
}

// ParseCmuxRefInvalid
{
	assert.equal(parseCmuxRef("garbage"), null);
	assert.equal(parseCmuxRef("workspace:"), null);
	assert.equal(parseCmuxRef("workspace:-1"), null);
}

// MatchesPrefix
{
	assert.equal(matchesPrefix("pi-cmux-abc123"), true);
	assert.equal(matchesPrefix("other-name"), false);
}
