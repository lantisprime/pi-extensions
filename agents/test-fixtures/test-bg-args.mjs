// P5E1-1: Pure-parser unit tests for `parseBgArgs` (agents/lib/bg-args.ts).
// See agents/docs/P5E1_BACKEND_SELECTOR_PLAN.md, Group 6 (6 named tests).
//
// Each assertion references the literal observed value of `parseBgArgs(...)`
// against an expected concrete string. No registry, no I/O, no backend
// instantiation — the parser is a pure function of its string input.

import assert from "node:assert/strict";

import { parseBgArgs } from "../lib/bg-args.ts";

async function test(name, fn) {
	await fn();
	console.log(`  ✓ ${name}`);
}

async function main() {
	console.log("P5E1-1 bg-args pure-parser tests");

	await test("testParseNoFlag", async () => {
		assert.deepStrictEqual(parseBgArgs("scout do"), {
			backendFlagMissingValue: false,
			restArgs: "scout do",
		});
	});

	await test("testParseFlagWithValue", async () => {
		assert.deepStrictEqual(parseBgArgs("--backend cmux scout do"), {
			backendName: "cmux",
			backendFlagMissingValue: false,
			restArgs: "scout do",
		});
	});

	await test("testParseFlagNoValue", async () => {
		assert.deepStrictEqual(parseBgArgs("--backend"), {
			backendName: "",
			backendFlagMissingValue: true,
			restArgs: "",
		});
	});

	await test("testParseEqualsFormNotConsumed", async () => {
		assert.deepStrictEqual(parseBgArgs("--backend=cmux scout"), {
			backendFlagMissingValue: false,
			restArgs: "--backend=cmux scout",
		});
	});

	await test("testParseDuplicateSecondPairPassesThrough", async () => {
		assert.deepStrictEqual(parseBgArgs("--backend tmux scout --backend cmux thing"), {
			backendName: "tmux",
			backendFlagMissingValue: false,
			restArgs: "scout --backend cmux thing",
		});
	});

	await test("testParseNoFlagPreservesRawArgs", async () => {
		assert.deepStrictEqual(parseBgArgs("  scout do  "), {
			backendFlagMissingValue: false,
			restArgs: "  scout do  ",
		});
		assert.deepStrictEqual(parseBgArgs("   "), {
			backendFlagMissingValue: false,
			restArgs: "   ",
		});
	});

	console.log("P5E1-1 bg-args pure-parser tests passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
