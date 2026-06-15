import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_SPEC_VERSION, type AgentSpec, type ThinkingLevel } from "./specs.ts";
import { sha256Hex, type ParsedAgentMarkdown } from "./agent-markdown.ts";
import type { RiskLevel } from "./security-scan.ts";

export const AGENT_REGISTRY_VERSION = 1;

export type RegisteredAgentSource = "user" | "project";
export type AgentEvalStatus = "present" | "missing" | "unknown";

export type RegisteredAgent = {
	name: string;
	source: RegisteredAgentSource;
	canonicalPath: string;
	rawBytesSha256: string;
	approvedAt: string;
	approvedBy: "user";
	specVersion: 1;
	tools: string[];
	model?: string;
	thinking?: ThinkingLevel;
	evalStatus: AgentEvalStatus;
	scannerRisk: RiskLevel;
};

export type AgentRegistry = {
	version: 1;
	updatedAt: string;
	agents: RegisteredAgent[];
};

export type ProjectAgentRegistry = AgentRegistry & {
	projectRoot: string;
	projectRootHash: string;
};

export type CreateRegisteredAgentOptions = {
	canonicalPath?: string;
	approvedAt?: string;
	evalStatus?: AgentEvalStatus;
};

export type ProjectRegistryPaths = {
	projectRoot: string;
	projectRootHash: string;
	registryPath: string;
};

export async function canonicalizePath(inputPath: string): Promise<string> {
	const resolved = path.resolve(inputPath);
	try {
		return await fs.realpath(resolved);
	} catch {
		return resolved;
	}
}

export async function canonicalizeProjectRoot(projectRoot: string): Promise<string> {
	return canonicalizePath(projectRoot);
}

export function hashProjectRoot(canonicalProjectRoot: string): string {
	return sha256Hex(canonicalProjectRoot);
}

export function getAgentsHomeDir(homeDir = os.homedir()): string {
	return path.join(homeDir, ".pi", "agent", "agents");
}

export function getUserRegistryPath(homeDir = os.homedir()): string {
	return path.join(getAgentsHomeDir(homeDir), "registry.json");
}

export async function getProjectRegistryPaths(projectRoot: string, homeDir = os.homedir()): Promise<ProjectRegistryPaths> {
	const canonicalRoot = await canonicalizeProjectRoot(projectRoot);
	const projectRootHash = hashProjectRoot(canonicalRoot);
	return {
		projectRoot: canonicalRoot,
		projectRootHash,
		registryPath: path.join(getAgentsHomeDir(homeDir), "projects", `${projectRootHash}.json`),
	};
}

export function emptyUserRegistry(now = new Date().toISOString()): AgentRegistry {
	return { version: AGENT_REGISTRY_VERSION, updatedAt: now, agents: [] };
}

export function emptyProjectRegistry(projectRoot: string, projectRootHash: string, now = new Date().toISOString()): ProjectAgentRegistry {
	return { ...emptyUserRegistry(now), projectRoot, projectRootHash };
}

export async function readUserRegistry(homeDir = os.homedir()): Promise<AgentRegistry> {
	return readRegistryFile(getUserRegistryPath(homeDir), emptyUserRegistry());
}

export async function writeUserRegistry(registry: AgentRegistry, homeDir = os.homedir()): Promise<void> {
	await writeRegistryFile(getUserRegistryPath(homeDir), normalizeUserRegistry(registry));
}

export async function readProjectRegistry(projectRoot: string, homeDir = os.homedir()): Promise<ProjectAgentRegistry> {
	const paths = await getProjectRegistryPaths(projectRoot, homeDir);
	return readRegistryFile(paths.registryPath, emptyProjectRegistry(paths.projectRoot, paths.projectRootHash));
}

export async function writeProjectRegistry(registry: ProjectAgentRegistry, projectRoot: string, homeDir = os.homedir()): Promise<void> {
	const paths = await getProjectRegistryPaths(projectRoot, homeDir);
	await writeRegistryFile(paths.registryPath, normalizeProjectRegistry(registry));
}

export function addOrReplaceRegisteredAgent<T extends AgentRegistry>(registry: T, entry: RegisteredAgent, now = new Date().toISOString()): T {
	return {
		...registry,
		updatedAt: now,
		agents: [
			...registry.agents.filter((agent) => !(agent.source === entry.source && agent.name === entry.name && agent.canonicalPath === entry.canonicalPath)),
			entry,
		].sort(compareRegisteredAgents),
	};
}

export async function createRegisteredAgentFromParsed(parsed: ParsedAgentMarkdown, options: CreateRegisteredAgentOptions = {}): Promise<RegisteredAgent> {
	if (!parsed.spec) throw new Error("cannot register parsed agent without a normalized spec");
	if (parsed.source !== "user" && parsed.source !== "project") throw new Error(`cannot register source '${parsed.source}'`);
	if (!parsed.filePath && !options.canonicalPath) throw new Error("canonicalPath or parsed.filePath is required");
	const canonicalPath = options.canonicalPath ?? await canonicalizePath(parsed.filePath as string);
	return createRegisteredAgent(parsed.spec, {
		canonicalPath,
		rawBytesSha256: parsed.rawBytesSha256,
		scannerRisk: parsed.scannerRisk,
		evalStatus: options.evalStatus ?? evalStatusForSpec(parsed.spec),
		approvedAt: options.approvedAt,
	});
}

export function createRegisteredAgent(spec: AgentSpec, options: {
	canonicalPath: string;
	rawBytesSha256: string;
	scannerRisk: RiskLevel;
	evalStatus?: AgentEvalStatus;
	approvedAt?: string;
}): RegisteredAgent {
	if (spec.source !== "user" && spec.source !== "project") {
		throw new Error(`registered agents must have user or project source, got '${spec.source}'`);
	}
	return {
		name: spec.name,
		source: spec.source,
		canonicalPath: options.canonicalPath,
		rawBytesSha256: options.rawBytesSha256,
		approvedAt: options.approvedAt ?? new Date().toISOString(),
		approvedBy: "user",
		specVersion: AGENT_SPEC_VERSION,
		tools: [...spec.tools],
		...(spec.model ? { model: spec.model } : {}),
		...(spec.thinking ? { thinking: spec.thinking } : {}),
		evalStatus: options.evalStatus ?? evalStatusForSpec(spec),
		scannerRisk: options.scannerRisk,
	};
}

export function findMatchingRegisteredAgent(registry: AgentRegistry, candidate: {
	name: string;
	source: RegisteredAgentSource;
	canonicalPath: string;
	rawBytesSha256: string;
}): RegisteredAgent | undefined {
	return registry.agents.find((agent) =>
		agent.name === candidate.name &&
		agent.source === candidate.source &&
		agent.canonicalPath === candidate.canonicalPath &&
		agent.rawBytesSha256 === candidate.rawBytesSha256,
	);
}

export function validateProjectRegistryRoot(registry: ProjectAgentRegistry, canonicalProjectRoot: string): { ok: boolean; expectedHash: string; issues: string[] } {
	const expectedHash = hashProjectRoot(canonicalProjectRoot);
	const issues: string[] = [];
	if (registry.projectRoot !== canonicalProjectRoot) issues.push("project root mismatch");
	if (registry.projectRootHash !== expectedHash) issues.push("project root hash mismatch");
	return { ok: issues.length === 0, expectedHash, issues };
}

function evalStatusForSpec(spec: AgentSpec): AgentEvalStatus {
	if (spec.evals.length === 0) return "missing";
	return spec.evals.every((entry) => entry.required) ? "present" : "unknown";
}

async function readRegistryFile<T extends AgentRegistry>(registryPath: string, fallback: T): Promise<T> {
	let text: string;
	try {
		text = await fs.readFile(registryPath, "utf8");
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return fallback;
		throw error;
	}
	const parsed = JSON.parse(text) as T;
	if (!parsed || parsed.version !== AGENT_REGISTRY_VERSION || !Array.isArray(parsed.agents)) {
		throw new Error(`invalid agent registry: ${registryPath}`);
	}
	return parsed;
}

async function writeRegistryFile(registryPath: string, registry: AgentRegistry): Promise<void> {
	await fs.mkdir(path.dirname(registryPath), { recursive: true });
	const tempPath = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
	await fs.writeFile(tempPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
	await fs.rename(tempPath, registryPath);
}

function normalizeUserRegistry(registry: AgentRegistry): AgentRegistry {
	return {
		version: AGENT_REGISTRY_VERSION,
		updatedAt: registry.updatedAt ?? new Date().toISOString(),
		agents: [...(registry.agents ?? [])].sort(compareRegisteredAgents),
	};
}

function normalizeProjectRegistry(registry: ProjectAgentRegistry): ProjectAgentRegistry {
	return {
		...normalizeUserRegistry(registry),
		projectRoot: registry.projectRoot,
		projectRootHash: registry.projectRootHash,
	};
}

function compareRegisteredAgents(left: RegisteredAgent, right: RegisteredAgent): number {
	return `${left.source}\0${left.name}\0${left.canonicalPath}`.localeCompare(`${right.source}\0${right.name}\0${right.canonicalPath}`);
}
