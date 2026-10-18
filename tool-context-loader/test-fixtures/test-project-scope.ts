// Regression: auto-derived runbooks are project-scoped. A record whose
// match.project names another checkout must be discovered but never injected,
// and must not inflate the status-line count.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { discover, formatStatusText, matchRunbooksForToolCall } from "../index.ts";

function scopeKey(dir: string): string {
	return createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 24);
}

async function main(): Promise<void> {
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tcl-scope-"));
	try {
		const project = path.join(temp, "project");
		const roots = path.join(temp, "roots");
		await fs.mkdir(project, { recursive: true });
		await fs.mkdir(roots, { recursive: true });
		const runbook = (id: string, projectKey: string) =>
			[
				"---",
				`id: ${id}`,
				"summary: scoped",
				"tools: [bash]",
				"match:",
				'  commandIncludes: ["git status"]',
				`  project: "${projectKey}"`,
				"injection: tool_result",
				"priority: 60",
				"---",
				"body",
				"",
			].join("\n");

		await fs.writeFile(path.join(roots, "other.md"), runbook("other", "deadbeefdeadbeefdeadbeef"), "utf8");
		const config = { roots: [] as string[], globalRoots: [roots] };
		const mismatched = await discover({ cwd: project, projectTrusted: true, config });
		const other = mismatched.records.find((record) => record.id === "other");
		assert.equal(other?.status, "skipped", "foreign project runbook must be skipped");
		assert.equal(formatStatusText(mismatched), "│ runbooks: 0");
		assert.equal(matchRunbooksForToolCall(mismatched.records, "bash", { command: "git status" }).length, 0);

		await fs.writeFile(path.join(roots, "own.md"), runbook("own", scopeKey(project)), "utf8");
		const own = await discover({ cwd: project, projectTrusted: true, config });
		assert.equal(own.records.find((record) => record.id === "own")?.status, "eligible");
		assert.equal(formatStatusText(own), "│ runbooks: 1");
		assert.equal(matchRunbooksForToolCall(own.records, "bash", { command: "git status" }).length, 1);
		console.log("project scope: ok");
	} finally {
		await fs.rm(temp, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
