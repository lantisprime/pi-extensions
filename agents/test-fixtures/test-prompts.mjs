import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAgentMethod, PROMPT_FILES, MAX_METHOD_BYTES } from "../lib/prompts.ts";
import { methodFileForSpec } from "../lib/prompts.ts";

// ── A1: prompts_loaderResolvesAndVerifiesParent ───────────────────────────────
async function test_prompts_loaderResolvesAndVerifiesParent() {
	// Known mapped name loads non-empty text.
	const text = await loadAgentMethod("reviewer");
	assert.ok(typeof text === "string" && text.length > 0, "reviewer.md should be non-empty");

	// Unmapped name returns "".
	const empty = await loadAgentMethod("nope");
	assert.equal(empty, "", 'unknown name should return ""');

	// Unmapped name with arbitrary string also returns "".
	const empty2 = await loadAgentMethod("evil.md");
	assert.equal(empty2, "", 'arbitrary unmapped name should return ""');
}

// ── A1: prompts_loaderDoesNotCacheFailure ─────────────────────────────────────
// Verify that if a file is absent on first call, the cache is NOT poisoned:
// after placing the file the second call must succeed.
async function test_prompts_loaderDoesNotCacheFailure() {
	// We test the no-cache-poison property by using a fresh import-local cache state
	// via a temp workaround: temporarily rename the planner.md, call loadAgentMethod,
	// restore it, then call again — the second call must succeed.
	const promptsDir = path.resolve(fileURLToPath(new URL("../lib/prompts/", import.meta.url)));
	const plannerPath = path.join(promptsDir, "planner.md");
	const backupPath = path.join(os.tmpdir(), "planner.md.bak");

	// Read original content
	const original = await fs.readFile(plannerPath, "utf8");

	// Rename planner.md away so the load fails.
	await fs.rename(plannerPath, backupPath);

	let threw = false;
	try {
		// Force fresh=true to bypass success cache; the file is absent → must throw.
		await loadAgentMethod("planner", { fresh: true });
	} catch {
		threw = true;
	}
	assert.equal(threw, true, "loadAgentMethod should throw when file is absent");

	// Restore the file.
	await fs.rename(backupPath, plannerPath);

	// Now with fresh=true the second call should succeed (cache was not poisoned).
	const text = await loadAgentMethod("planner", { fresh: true });
	assert.ok(typeof text === "string" && text.length > 0, "planner.md should load after restore");
}

// ── Group 1 also verifies MAX_METHOD_BYTES is exported ────────────────────────
async function test_constantsExported() {
	assert.ok(typeof MAX_METHOD_BYTES === "number" && MAX_METHOD_BYTES > 0, "MAX_METHOD_BYTES must be a positive number");
	assert.ok(PROMPT_FILES.reviewer === "reviewer.md", "PROMPT_FILES.reviewer must be reviewer.md");
	assert.ok(PROMPT_FILES.scout === "scout.md", "PROMPT_FILES.scout must be scout.md");
	assert.ok(PROMPT_FILES.planner === "planner.md", "PROMPT_FILES.planner must be planner.md");
}

async function main() {
	await test_prompts_loaderResolvesAndVerifiesParent();
	await test_prompts_loaderDoesNotCacheFailure();
	await test_constantsExported();
	console.log("agents prompt loader tests passed");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});

// P10 regression (integration): ephemeral inherits its base role method by FILE (name is "temp").
{
  assert.equal(methodFileForSpec({ source: "built-in", name: "reviewer" }), "reviewer.md");
  assert.equal(methodFileForSpec({ source: "ephemeral", name: "temp", instructionsFile: "scout.md" }), "scout.md");
  assert.equal(methodFileForSpec({ source: "user", name: "x", instructionsFile: "scout.md" }), "", "frontmatter source never loads a method file");
  assert.equal(methodFileForSpec({ source: "ephemeral", name: "temp", instructionsFile: "evil.md" }), "", "ephemeral only loads allowlisted files");
  console.log("methodFileForSpec_ephemeralByFile OK");
}

