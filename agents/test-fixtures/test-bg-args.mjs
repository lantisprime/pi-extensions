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
			profileFlagMissingValue: false,
			restArgs: "scout do",
		});
	});

	await test("testParseFlagWithValue", async () => {
		assert.deepStrictEqual(parseBgArgs("--backend cmux scout do"), {
			backendName: "cmux",
			backendFlagMissingValue: false,
			profileFlagMissingValue: false,
			restArgs: "scout do",
		});
	});

	await test("testParseFlagNoValue", async () => {
		assert.deepStrictEqual(parseBgArgs("--backend"), {
			backendName: "",
			backendFlagMissingValue: true,
			profileFlagMissingValue: false,
			restArgs: "",
		});
	});

	await test("testParseEqualsFormNotConsumed", async () => {
		assert.deepStrictEqual(parseBgArgs("--backend=cmux scout"), {
			backendFlagMissingValue: false,
			profileFlagMissingValue: false,
			restArgs: "--backend=cmux scout",
		});
	});

	await test("testParseDuplicateSecondPairPassesThrough", async () => {
		assert.deepStrictEqual(parseBgArgs("--backend tmux scout --backend cmux thing"), {
			backendName: "tmux",
			backendFlagMissingValue: false,
			profileFlagMissingValue: false,
			restArgs: "scout --backend cmux thing",
		});
	});

	await test("testParseNoFlagPreservesRawArgs", async () => {
		assert.deepStrictEqual(parseBgArgs("  scout do  "), {
			backendFlagMissingValue: false,
			profileFlagMissingValue: false,
			restArgs: "  scout do  ",
		});
		assert.deepStrictEqual(parseBgArgs("   "), {
			backendFlagMissingValue: false,
			profileFlagMissingValue: false,
			restArgs: "   ",
		});
	});

	await test("testParseProfileFlagWithValue", async () => {
		assert.deepStrictEqual(parseBgArgs("--profile smart planner do thing"), {
			backendFlagMissingValue: false,
			profileName: "smart",
			profileFlagMissingValue: false,
			restArgs: "planner do thing",
		});
	});

	await test("testParseProfileFlagNoValue", async () => {
		assert.deepStrictEqual(parseBgArgs("--profile"), {
			backendFlagMissingValue: false,
			profileName: "",
			profileFlagMissingValue: true,
			restArgs: "",
		});
	});

	await test("testParseProfileFlagMidStringNotConsumed", async () => {
		// Profile is positional (first token only), like --backend. Mid-string --profile
		// flows into restArgs as task text, mirroring testParseEqualsFormNotConsumed.
		assert.deepStrictEqual(parseBgArgs("scout do --profile smart"), {
			backendFlagMissingValue: false,
			profileFlagMissingValue: false,
			restArgs: "scout do --profile smart",
		});
	});

	console.log("P5E1-1 bg-args pure-parser tests passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
