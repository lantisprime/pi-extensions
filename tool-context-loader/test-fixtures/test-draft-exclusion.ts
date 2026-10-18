// Regression: a configured root of `.pi` (or `.`) must not discover quarantined
// drafts, VCS metadata, or dependency trees.

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findMarkdownFiles } from "../index.ts";

async function main(): Promise<void> {
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tcl-drafts-"));
try {
	await fs.mkdir(path.join(temp, ".pi", "runbooks"), { recursive: true });
	await fs.mkdir(path.join(temp, ".pi", "workflow-drafts"), { recursive: true });
	await fs.mkdir(path.join(temp, ".git"), { recursive: true });
	await fs.mkdir(path.join(temp, "node_modules", "pkg"), { recursive: true });
	await fs.writeFile(path.join(temp, ".pi", "runbooks", "ok.md"), "---\nid: ok\n---\n", "utf8");
	await fs.writeFile(path.join(temp, ".pi", "workflow-drafts", "draft.md"), "---\nid: draft\n---\n", "utf8");
	await fs.writeFile(path.join(temp, ".git", "note.md"), "git metadata", "utf8");
	await fs.writeFile(path.join(temp, "node_modules", "pkg", "README.md"), "dep docs", "utf8");

	const files = await findMarkdownFiles(temp);
	const relative = files.map((file) => path.relative(temp, file));

	assert.ok(relative.includes(path.join(".pi", "runbooks", "ok.md")), "accepted runbook must be discovered");
	assert.equal(relative.some((file) => file.includes("workflow-drafts")), false, "drafts must never be discovered");
	assert.equal(relative.some((file) => file.startsWith(".git")), false, "VCS metadata must be skipped");
	assert.equal(relative.some((file) => file.startsWith("node_modules")), false, "dependency trees must be skipped");
	console.log("draft exclusion: ok");
} finally {
	await fs.rm(temp, { recursive: true, force: true });
}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
