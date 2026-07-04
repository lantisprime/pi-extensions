// P5d-S5: cmux-control extension entry smoke test.
import assert from "node:assert/strict";

// ExtensionExportsDefault
{
	const extension = (await import("../index.ts")).default;
	assert.equal(typeof extension, "function");
}

console.log("test-extension: all tests passed");
