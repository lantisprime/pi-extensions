import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAgentMarkdownFile } from "../lib/agent-markdown.ts";
import { canRunAgent } from "../lib/can-run-agent.ts";
import {
	addOrReplaceRegisteredAgent,
	canonicalizeProjectRoot,
	createRegisteredAgentFromParsed,
	emptyProjectRegistry,
	emptyUserRegistry,
	getProjectRegistryPaths,
	getUserRegistryPath,
	hashProjectRoot,
	readProjectRegistry,
	readUserRegistry,
	validateProjectRegistryRoot,
	writeProjectRegistry,
	writeUserRegistry,
} from "../lib/registry.ts";
import { getBuiltInAgentSpec } from "../lib/specs.ts";

function markdown(name, body = "Read files and summarize findings.") {
	return `---\nname: ${name}\ndescription: ${name} description\ntools: [read, grep, find, ls]\n---\n${body}\n`;
}

async function withTempDir(fn) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-reg-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function parsedAgent(root, name, source = "user") {
	const filePath = path.join(root, `${name}.md`);
	await fs.writeFile(filePath, markdown(name));
	const parsed = await parseAgentMarkdownFile(filePath, { source });
	assert.equal(parsed.status, "eligible");
	return parsed;
}

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

async function testRegistryPathsReadWriteAndRootMismatch() {
	await withTempDir(async (temp) => {
		const home = path.join(temp, "home");
		const project = path.join(temp, "project");
		await fs.mkdir(project, { recursive: true });

		assert.equal(getUserRegistryPath(home), path.join(home, ".pi", "agent", "agents", "registry.json"));
		const missingUserRegistry = await readUserRegistry(home);
		assert.deepEqual(missingUserRegistry, emptyUserRegistry(missingUserRegistry.updatedAt));

		const paths = await getProjectRegistryPaths(project, home);
		const canonicalRoot = await canonicalizeProjectRoot(project);
		assert.equal(paths.projectRoot, canonicalRoot);
		assert.equal(paths.projectRootHash, hashProjectRoot(canonicalRoot));
		assert.equal(paths.registryPath, path.join(home, ".pi", "agent", "agents", "projects", `${paths.projectRootHash}.json`));

		const projectRegistry = await readProjectRegistry(project, home);
		assert.equal(projectRegistry.projectRoot, canonicalRoot);
		assert.equal(projectRegistry.projectRootHash, hashProjectRoot(canonicalRoot));
		assert.equal(validateProjectRegistryRoot(projectRegistry, canonicalRoot).ok, true);

		const mismatched = { ...projectRegistry, projectRoot: path.join(temp, "other") };
		assert.equal(validateProjectRegistryRoot(mismatched, canonicalRoot).ok, false);

		await writeUserRegistry({ ...emptyUserRegistry("2026-01-01T00:00:00.000Z"), agents: [] }, home);
		assert.equal((await readUserRegistry(home)).version, 1);
		await writeProjectRegistry(projectRegistry, project, home);
		assert.equal((await readProjectRegistry(project, home)).projectRootHash, paths.projectRootHash);
	});
}

async function testBuiltInsPassWithoutRegistry() {
	const result = await canRunAgent({ spec: getBuiltInAgentSpec("scout") }, { projectTrusted: false });
	assert.equal(result.ok, true);
	assert.equal(result.code, "allowed-built-in");
}

async function testUserRegistryExactHashGate() {
	await withTempDir(async (temp) => {
		const parsed = await parsedAgent(temp, "user-helper", "user");
		const canonicalPath = parsed.filePath;
		const unregistered = await canRunAgent(
			{ parsed, canonicalPath },
			{ projectTrusted: false, userRegistry: emptyUserRegistry("2026-01-01T00:00:00.000Z") },
		);
		assert.equal(unregistered.ok, false);
		assert.equal(unregistered.code, "user-unregistered");

		const entry = await createRegisteredAgentFromParsed(parsed, { canonicalPath, approvedAt: "2026-01-01T00:00:00.000Z" });
		const registry = await addOrReplaceRegisteredAgent(emptyUserRegistry("2026-01-01T00:00:00.000Z"), entry, "2026-01-01T00:00:01.000Z");
		const allowed = await canRunAgent({ parsed, canonicalPath }, { projectTrusted: false, userRegistry: registry });
		assert.equal(allowed.ok, true);
		assert.equal(allowed.code, "allowed-registered-user");
		assert.equal(allowed.registryEntry.name, "user-helper");

		const changedHash = await canRunAgent(
			{ parsed, canonicalPath, rawBytesSha256: `${parsed.rawBytesSha256.slice(0, -1)}0` },
			{ projectTrusted: false, userRegistry: registry },
		);
		assert.equal(changedHash.ok, false);
		assert.equal(changedHash.code, "user-unregistered");
	});
}

async function testProjectRegistryTrustAndRootIsolation() {
	await withTempDir(async (temp) => {
		const rootA = path.join(temp, "root-a");
		const rootB = path.join(temp, "root-b");
		await fs.mkdir(rootA, { recursive: true });
		await fs.mkdir(rootB, { recursive: true });
		const parsed = await parsedAgent(rootA, "project-helper", "project");
		const canonicalPath = parsed.filePath;
		const pathsA = await getProjectRegistryPaths(rootA, path.join(temp, "home"));
		const entry = await createRegisteredAgentFromParsed(parsed, { canonicalPath, approvedAt: "2026-01-01T00:00:00.000Z" });
		const registryA = await addOrReplaceRegisteredAgent(
			emptyProjectRegistry(pathsA.projectRoot, pathsA.projectRootHash, "2026-01-01T00:00:00.000Z"),
			entry,
			"2026-01-01T00:00:01.000Z",
		);

		const untrusted = await canRunAgent({ parsed, canonicalPath }, { projectTrusted: false, projectRoot: rootA, projectRegistry: registryA });
		assert.equal(untrusted.ok, false);
		assert.equal(untrusted.code, "project-untrusted");

		const allowed = await canRunAgent({ parsed, canonicalPath }, { projectTrusted: true, projectRoot: rootA, projectRegistry: registryA });
		assert.equal(allowed.ok, true);
		assert.equal(allowed.code, "allowed-registered-project");

		const wrongRoot = await canRunAgent({ parsed, canonicalPath }, { projectTrusted: true, projectRoot: rootB, projectRegistry: registryA });
		assert.equal(wrongRoot.ok, false);
		assert.equal(wrongRoot.code, "project-registry-root-mismatch");

		const pathsB = await getProjectRegistryPaths(rootB, path.join(temp, "home"));
		const registryB = emptyProjectRegistry(pathsB.projectRoot, pathsB.projectRootHash, "2026-01-01T00:00:00.000Z");
		const isolated = await canRunAgent({ parsed, canonicalPath }, { projectTrusted: true, projectRoot: rootB, projectRegistry: registryB });
		assert.equal(isolated.ok, false);
		assert.equal(isolated.code, "project-unregistered");
	});
}

async function testDangerousAndSavedEphemeralAreBlocked() {
	await withTempDir(async (temp) => {
		const dangerous = await parsedAgent(temp, "dangerous-helper", "user");
		const dangerousResult = await canRunAgent(
			{ parsed: dangerous, canonicalPath: dangerous.filePath, scannerRisk: "dangerous" },
			{ projectTrusted: false, userRegistry: emptyUserRegistry("2026-01-01T00:00:00.000Z") },
		);
		assert.equal(dangerousResult.ok, false);
		assert.equal(dangerousResult.code, "scanner-dangerous");

		const dangerousEntry = { ...(await createRegisteredAgentFromParsed(dangerous, { canonicalPath: dangerous.filePath })), scannerRisk: "dangerous" };
		const dangerousRegistry = addOrReplaceRegisteredAgent(emptyUserRegistry("2026-01-01T00:00:00.000Z"), dangerousEntry, "2026-01-01T00:00:01.000Z");
		const dangerousRegisteredResult = await canRunAgent(
			{ parsed: dangerous, canonicalPath: dangerous.filePath, scannerRisk: "safe" },
			{ projectTrusted: false, userRegistry: dangerousRegistry },
		);
		assert.equal(dangerousRegisteredResult.ok, false);
		assert.equal(dangerousRegisteredResult.code, "scanner-dangerous");

		const savedEphemeral = clone(getBuiltInAgentSpec("planner"));
		savedEphemeral.name = "saved-planner";
		savedEphemeral.source = "user";
		const savedResult = await canRunAgent(
			{ spec: savedEphemeral, canonicalPath: path.join(temp, "saved-planner.md"), rawBytesSha256: "a".repeat(64), scannerRisk: "safe" },
			{ projectTrusted: false, userRegistry: emptyUserRegistry("2026-01-01T00:00:00.000Z") },
		);
		assert.equal(savedResult.ok, false);
		assert.equal(savedResult.code, "user-unregistered");
	});
}

async function testDiskBackedRegistryGate() {
	await withTempDir(async (temp) => {
		const home = path.join(temp, "home");
		const project = path.join(temp, "project");
		await fs.mkdir(project, { recursive: true });

		const userParsed = await parsedAgent(temp, "disk-user", "user");
		const userEntry = await createRegisteredAgentFromParsed(userParsed, { canonicalPath: userParsed.filePath, approvedAt: "2026-01-01T00:00:00.000Z" });
		await writeUserRegistry(addOrReplaceRegisteredAgent(emptyUserRegistry("2026-01-01T00:00:00.000Z"), userEntry, "2026-01-01T00:00:01.000Z"), home);
		const userResult = await canRunAgent({ parsed: userParsed, canonicalPath: userParsed.filePath }, { projectTrusted: false, homeDir: home });
		assert.equal(userResult.ok, true);
		assert.equal(userResult.code, "allowed-registered-user");

		const projectParsed = await parsedAgent(project, "disk-project", "project");
		const paths = await getProjectRegistryPaths(project, home);
		const projectEntry = await createRegisteredAgentFromParsed(projectParsed, { canonicalPath: projectParsed.filePath, approvedAt: "2026-01-01T00:00:00.000Z" });
		const projectRegistry = addOrReplaceRegisteredAgent(
			emptyProjectRegistry(paths.projectRoot, paths.projectRootHash, "2026-01-01T00:00:00.000Z"),
			projectEntry,
			"2026-01-01T00:00:01.000Z",
		);
		await writeProjectRegistry(projectRegistry, project, home);
		const projectResult = await canRunAgent({ parsed: projectParsed, canonicalPath: projectParsed.filePath }, { projectTrusted: true, projectRoot: project, homeDir: home });
		assert.equal(projectResult.ok, true);
		assert.equal(projectResult.code, "allowed-registered-project");
	});
}

async function testEphemeralGate() {
	const ephemeral = clone(getBuiltInAgentSpec("reviewer"));
	ephemeral.name = "temp-reviewer";
	ephemeral.source = "ephemeral";
	assert.equal((await canRunAgent({ spec: ephemeral, scannerRisk: "safe" }, { projectTrusted: false })).code, "not-explicit-ephemeral");
	assert.equal((await canRunAgent({ spec: ephemeral, scannerRisk: "suspicious", explicitUserRequest: true }, { projectTrusted: false })).code, "ephemeral-suspicious-unconfirmed");
	assert.equal((await canRunAgent({ spec: ephemeral, scannerRisk: "suspicious", explicitUserRequest: true, suspiciousConfirmed: true }, { projectTrusted: false })).ok, true);
	ephemeral.tools = ["read", "bash"];
	assert.equal((await canRunAgent({ spec: ephemeral, scannerRisk: "safe", explicitUserRequest: true }, { projectTrusted: false })).code, "tools-not-readonly");
}

async function main() {
	await testRegistryPathsReadWriteAndRootMismatch();
	await testBuiltInsPassWithoutRegistry();
	await testUserRegistryExactHashGate();
	await testProjectRegistryTrustAndRootIsolation();
	await testDangerousAndSavedEphemeralAreBlocked();
	await testDiskBackedRegistryGate();
	await testEphemeralGate();
	console.log("agents registry/runtime gate tests passed");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
