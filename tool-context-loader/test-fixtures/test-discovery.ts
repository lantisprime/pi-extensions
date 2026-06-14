import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	DIAGNOSTICS_RECORD_LIMIT,
	MAX_DISCOVERY_FILE_BYTES,
	dedupeRecords,
	deriveToolsFromTags,
	discover,
	formatDiagnostics,
	parseFrontmatter,
	parseValue,
} from "../index.ts";

const fixtureRoot = path.resolve(import.meta.dirname, "..");
const projectFixture = path.join(fixtureRoot, "test-fixtures", "project");
const globalFixture = path.join(fixtureRoot, "test-fixtures", "global", "runbooks");

async function makeTempProject(): Promise<{ temp: string; project: string; home: string; cleanup: () => Promise<void> }> {
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tcl-p1a-"));
	const project = path.join(temp, "project");
	const home = path.join(temp, "home");
	await fs.cp(projectFixture, project, { recursive: true });
	await fs.mkdir(path.join(home, ".pi", "agent"), { recursive: true });
	await fs.cp(globalFixture, path.join(home, ".pi", "agent", "runbooks"), { recursive: true });
	await fs.cp(path.join(fixtureRoot, "test-fixtures", "global", "episodes"), path.join(home, ".episodic-memory", "episodes"), { recursive: true });
	return { temp, project, home, cleanup: () => fs.rm(temp, { recursive: true, force: true }) };
}

function stableProjection(state: Awaited<ReturnType<typeof discover>>) {
	return state.records.map((record) => ({
		id: record.id,
		displayPath: record.displayPath,
		status: record.status,
		tools: record.tools,
		summary: record.summary,
		priority: record.priority,
		sourcePrecedence: record.sourcePrecedence,
		match: record.match,
	}));
}

async function testFrontmatterParser() {
	const parsed = parseFrontmatter(`---\nid: quoted\nsummary: "Hello world"\ntools: [bash, edit]\npriority: 42\nmatch:\n  commandIncludes: [kubectl, helm]\n  pathIncludes: [.github/workflows/]\n---\n# Body\n`);
	assert.equal(parsed.metadata.id, "quoted");
	assert.equal(parsed.metadata.summary, "Hello world");
	assert.deepEqual(parsed.metadata.tools, ["bash", "edit"]);
	assert.equal(parsed.metadata.priority, 42);
	assert.deepEqual(parsed.metadata.match, {
		commandIncludes: ["kubectl", "helm"],
		pathIncludes: [".github/workflows/"],
	});
	assert.equal(parseValue("true"), true);
	assert.deepEqual(deriveToolsFromTags(["tool:bash", "decision", "tool:edit", "tool:bash"]), ["bash", "edit"]);
	assert.throws(() => parseFrontmatter("---\nid: bad\n  nope\n---\n"), /unexpected indented line|invalid nested line/);
}

async function testDiscoveryHappyPath() {
	const { project, home, cleanup } = await makeTempProject();
	try {
		const state = await discover({ cwd: project, projectTrusted: true, homeDir: home });
		const byId = new Map(state.records.map((record) => [record.id, record]));
		assert.equal(byId.get("bash-kubectl")?.status, "eligible");
		assert.equal(byId.get("bash-kubectl")?.summary, "Kubernetes safety checks for bash kubectl commands");
		assert.deepEqual(byId.get("bash-kubectl")?.tools, ["bash"]);
		assert.deepEqual(byId.get("bash-kubectl")?.match.commandIncludes, ["kubectl", "helm"]);
		assert.equal(byId.get("bash-kubectl")?.displayPath, "project-runbook:bash-kubectl.md");
		assert.equal(byId.get("github-actions-edit")?.status, "eligible");
		assert.deepEqual(byId.get("github-actions-edit")?.match.pathIncludes, [".github/workflows/"]);
		assert.equal(byId.get("no-id.md")?.status, "eligible");
		assert.equal(byId.get("no-id.md")?.identity, "path:no-id.md");
		assert.equal(byId.get("episode-tool-mapped")?.status, "eligible");
		assert.deepEqual(byId.get("episode-tool-mapped")?.tools, ["bash"]);
		assert.equal(byId.get("episode-unmapped")?.status, "unmapped");
		assert.equal(byId.get("no-tools-runbook")?.status, "skipped");
		assert.equal(byId.get("global-bash")?.status, "eligible");
		assert.equal(byId.get("global-episode-tool-mapped")?.status, "unmapped");
		assert.match(byId.get("global-episode-tool-mapped")?.warning ?? "", /global episodes are diagnostics-only/);
		assert.equal(state.records.filter((record) => record.id === "bash-kubectl").length, 1, "duplicate IDs should be deduped");
		assert.ok(state.warnings.some((warning) => warning.includes("invalid frontmatter")), "invalid frontmatter warning missing");
	} finally {
		await cleanup();
	}
}

async function testDeterministicDiscovery() {
	const { project, home, cleanup } = await makeTempProject();
	try {
		const first = stableProjection(await discover({ cwd: project, projectTrusted: true, homeDir: home }));
		const second = stableProjection(await discover({ cwd: project, projectTrusted: true, homeDir: home }));
		assert.deepEqual(second, first);
	} finally {
		await cleanup();
	}
}

async function testUntrustedProjectGate() {
	const { project, home, cleanup } = await makeTempProject();
	try {
		const state = await discover({ cwd: project, projectTrusted: false, homeDir: home });
		assert.equal(state.projectTrusted, false);
		assert.ok(state.roots.some((root) => root.configuredPath === ".pi/runbooks" && root.skippedReason === "project is not trusted"));
		assert.ok(!state.records.some((record) => record.sourceKind.startsWith("project")), "project-local records must not load");
		assert.ok(state.records.some((record) => record.id === "global-bash"), "global roots may still scan");
	} finally {
		await cleanup();
	}
}

async function testMissingRootsSafe() {
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tcl-missing-"));
	try {
		const state = await discover({
			cwd: temp,
			projectTrusted: true,
			homeDir: path.join(temp, "home"),
			config: { roots: ["missing-a", "missing-b"], globalRoots: ["~/missing-global"] },
		});
		assert.equal(state.records.length, 0);
		assert.equal(state.roots.length, 3);
		assert.ok(state.roots.every((root) => !root.scanned));
	} finally {
		await fs.rm(temp, { recursive: true, force: true });
	}
}

async function testDisabledConfigScansNothing() {
	const { project, home, cleanup } = await makeTempProject();
	try {
		const state = await discover({ cwd: project, projectTrusted: true, homeDir: home, config: { enabled: false } });
		assert.equal(state.enabled, false);
		assert.equal(state.roots.length, 0);
		assert.equal(state.records.length, 0);
	} finally {
		await cleanup();
	}
}

async function testNonDirectoryRootSkipped() {
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tcl-file-root-"));
	try {
		await fs.writeFile(path.join(temp, "not-a-dir"), "not a directory");
		const state = await discover({
			cwd: temp,
			projectTrusted: true,
			homeDir: path.join(temp, "home"),
			config: { roots: ["not-a-dir"], globalRoots: [] },
		});
		assert.equal(state.records.length, 0);
		assert.equal(state.roots[0]?.exists, true);
		assert.equal(state.roots[0]?.scanned, false);
		assert.equal(state.roots[0]?.skippedReason, "not a directory");
	} finally {
		await fs.rm(temp, { recursive: true, force: true });
	}
}

async function testOversizedFileSkipped() {
	const { project, home, cleanup } = await makeTempProject();
	try {
		const largePath = path.join(project, ".pi", "runbooks", "large.md");
		await fs.writeFile(largePath, `---\nid: too-large\ntools: [bash]\n---\n${"x".repeat(MAX_DISCOVERY_FILE_BYTES + 1)}`);
		const state = await discover({ cwd: project, projectTrusted: true, homeDir: home });
		assert.ok(!state.records.some((record) => record.id === "too-large"));
		assert.ok(state.warnings.some((warning) => warning.includes("larger than")));
	} finally {
		await cleanup();
	}
}

async function testSymlinkEscapeRejected() {
	const { project, home, temp, cleanup } = await makeTempProject();
	try {
		const outside = path.join(temp, "outside.md");
		await fs.writeFile(outside, "---\nid: escaped\ntools: [bash]\n---\n# escaped\n");
		const link = path.join(project, ".pi", "runbooks", "escaped.md");
		await fs.symlink(outside, link);
		const state = await discover({ cwd: project, projectTrusted: true, homeDir: home });
		assert.ok(!state.records.some((record) => record.id === "escaped"));
		assert.ok(state.warnings.some((warning) => warning.includes("escapes configured root")));
	} finally {
		await cleanup();
	}
}

async function testDiagnosticsOmitBodiesAndCapOutput() {
	const { project, home, cleanup } = await makeTempProject();
	try {
		const state = await discover({ cwd: project, projectTrusted: true, homeDir: home });
		const diagnostics = formatDiagnostics(state, 2);
		assert.ok(diagnostics.includes("Tool Context Loader: enabled"));
		assert.ok(diagnostics.includes("Records:"));
		assert.ok(diagnostics.includes("more records omitted"));
		assert.ok(!diagnostics.includes("SECRET BODY SHOULD NOT APPEAR"));
		assert.ok(!diagnostics.includes("Do not dump this body"));
		for (const record of state.records) {
			assert.equal(Object.prototype.hasOwnProperty.call(record, "body"), false, "records must not retain body text");
		}
		assert.equal(DIAGNOSTICS_RECORD_LIMIT, 50);
	} finally {
		await cleanup();
	}
}

async function testDedupePreference() {
	const preferred = {
		id: "same",
		identity: "id:same",
		absolutePath: "/a",
		displayPath: "project-runbook:a.md",
		root: "/root-a",
		sourceKind: "project-runbook" as const,
		sourcePrecedence: 1,
		status: "eligible" as const,
		summary: "preferred",
		tools: ["bash"],
		tags: [],
		injection: "tool_result" as const,
		preload: "index" as const,
		priority: 1,
		maxBytes: 100,
		bodyBytes: 1,
		contentHash: "a",
		match: { commandIncludes: [], pathIncludes: [] },
	};
	const loser = { ...preferred, absolutePath: "/b", displayPath: "project-runbook:b.md", sourcePrecedence: 2, priority: 999, summary: "loser" };
	assert.deepEqual(dedupeRecords([loser, preferred]).map((record) => record.summary), ["preferred"]);
}

const tests: Array<[string, () => Promise<void>]> = [
	["frontmatter parser", testFrontmatterParser],
	["discovery happy path", testDiscoveryHappyPath],
	["deterministic discovery", testDeterministicDiscovery],
	["untrusted project gate", testUntrustedProjectGate],
	["missing roots safe", testMissingRootsSafe],
	["disabled config scans nothing", testDisabledConfigScansNothing],
	["non-directory root skipped", testNonDirectoryRootSkipped],
	["oversized file skipped", testOversizedFileSkipped],
	["symlink escape rejected", testSymlinkEscapeRejected],
	["diagnostics omit bodies and cap output", testDiagnosticsOmitBodiesAndCapOutput],
	["dedupe preference", testDedupePreference],
];

async function main() {
	let passed = 0;
	for (const [name, test] of tests) {
		await test();
		passed += 1;
		console.log(`ok ${passed} - ${name}`);
	}
	console.log(`P1a discovery tests passed: ${passed}/${tests.length}`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
