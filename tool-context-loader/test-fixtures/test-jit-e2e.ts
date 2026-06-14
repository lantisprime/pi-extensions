import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	DEFAULT_CONFIG,
	buildToolResultInjection,
	discover,
	matchRunbooksForToolCall,
	patchToolResultContent,
	readRunbookBody,
	type BodyInjectionItem,
	type RunbookRecord,
} from "../index.ts";

const fixtureRoot = path.resolve(import.meta.dirname, "..");
const projectFixture = path.join(fixtureRoot, "test-fixtures", "project");

async function makeTempProject(): Promise<{ temp: string; project: string; cleanup: () => Promise<void> }> {
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tcl-p1c-e2e-"));
	const project = path.join(temp, "project");
	await fs.cp(projectFixture, project, { recursive: true });
	return { temp, project, cleanup: () => fs.rm(temp, { recursive: true, force: true }) };
}

async function injectForToolCall(records: RunbookRecord[], toolName: string, input: Record<string, unknown>) {
	const matches = matchRunbooksForToolCall(records, toolName, input);
	const bodyItems: BodyInjectionItem[] = [];
	for (const match of matches) {
		const body = await readRunbookBody(match.record);
		if (body) bodyItems.push({ ...match, body });
	}
	const injection = buildToolResultInjection(bodyItems, { ...DEFAULT_CONFIG, maxInjectedBytesPerTurn: 10_000 });
	return patchToolResultContent([{ type: "text", text: "original tool output" }], { exitCode: 0 }, injection);
}

async function testEndToEndBashInjection() {
	const { temp, project, cleanup } = await makeTempProject();
	try {
		const state = await discover({ cwd: project, projectTrusted: true, homeDir: path.join(temp, "home"), config: { globalRoots: [] } });
		const patch = await injectForToolCall(state.records, "bash", { command: "kubectl get pods" });
		assert.ok(patch, "expected JIT patch for matching bash command");
		assert.equal(patch.content?.[0]?.text, "original tool output");
		const injected = String(patch.content?.[1]?.text ?? "");
		assert.ok(injected.includes("[tool-context-loader]"));
		assert.ok(injected.includes("Source: project-runbook:bash-kubectl.md"));
		assert.ok(injected.includes("SECRET BODY SHOULD NOT APPEAR IN DIAGNOSTICS"));
		assert.deepEqual((patch.details as Record<string, unknown>).exitCode, 0);
		assert.ok((patch.details as Record<string, unknown>).toolContextLoader);
	} finally {
		await cleanup();
	}
}

async function testEndToEndNegativeNonmatchNoPatch() {
	const { temp, project, cleanup } = await makeTempProject();
	try {
		const state = await discover({ cwd: project, projectTrusted: true, homeDir: path.join(temp, "home"), config: { globalRoots: [] } });
		const patch = await injectForToolCall(state.records, "bash", { command: "git status" });
		assert.equal(patch, undefined);
	} finally {
		await cleanup();
	}
}

async function testEndToEndNegativeDefaultInheritedNoPatch() {
	const { temp, project, cleanup } = await makeTempProject();
	try {
		const state = await discover({ cwd: project, projectTrusted: true, homeDir: path.join(temp, "home"), config: { globalRoots: [] } });
		const patch = await injectForToolCall(state.records, "read", { path: "README.md" });
		assert.equal(patch, undefined, "no-id.md inherits default tool_result but lacks explicit injection, so P1c must not inject it");
	} finally {
		await cleanup();
	}
}

async function testEndToEndNegativeUntrustedProjectNoPatch() {
	const { temp, project, cleanup } = await makeTempProject();
	try {
		const state = await discover({ cwd: project, projectTrusted: false, homeDir: path.join(temp, "home"), config: { globalRoots: [] } });
		assert.equal(state.records.length, 0);
		const patch = await injectForToolCall(state.records, "bash", { command: "kubectl get pods" });
		assert.equal(patch, undefined);
	} finally {
		await cleanup();
	}
}

async function testEndToEndNegativeDeletedBodyNoPatch() {
	const { temp, project, cleanup } = await makeTempProject();
	try {
		const state = await discover({ cwd: project, projectTrusted: true, homeDir: path.join(temp, "home"), config: { globalRoots: [] } });
		const match = matchRunbooksForToolCall(state.records, "bash", { command: "kubectl get pods" })[0];
		assert.ok(match);
		await fs.rm(match.record.absolutePath);
		const patch = await injectForToolCall(state.records, "bash", { command: "kubectl get pods" });
		assert.equal(patch, undefined);
	} finally {
		await cleanup();
	}
}

const tests: Array<[string, () => Promise<void>]> = [
	["e2e bash injection", testEndToEndBashInjection],
	["e2e negative nonmatch no patch", testEndToEndNegativeNonmatchNoPatch],
	["e2e negative default-inherited no patch", testEndToEndNegativeDefaultInheritedNoPatch],
	["e2e negative untrusted project no patch", testEndToEndNegativeUntrustedProjectNoPatch],
	["e2e negative deleted body no patch", testEndToEndNegativeDeletedBodyNoPatch],
];

async function main() {
	let passed = 0;
	for (const [name, test] of tests) {
		await test();
		passed += 1;
		console.log(`ok ${passed} - ${name}`);
	}
	console.log(`P1c JIT end-to-end tests passed: ${passed}/${tests.length}`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
