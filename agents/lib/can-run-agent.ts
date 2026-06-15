import { P3_READONLY_TOOLS, type AgentSpec } from "./specs.ts";
import type { ParsedAgentMarkdown } from "./agent-markdown.ts";
import type { RiskLevel } from "./security-scan.ts";
import {
	canonicalizePath,
	canonicalizeProjectRoot,
	findMatchingRegisteredAgent,
	readProjectRegistry,
	readUserRegistry,
	validateProjectRegistryRoot,
	type AgentRegistry,
	type ProjectAgentRegistry,
	type RegisteredAgent,
} from "./registry.ts";

export type CanRunAgentCode =
	| "allowed-built-in"
	| "allowed-ephemeral"
	| "allowed-registered-user"
	| "allowed-registered-project"
	| "missing-spec"
	| "invalid-source"
	| "not-explicit-ephemeral"
	| "ephemeral-dangerous"
	| "ephemeral-suspicious-unconfirmed"
	| "tools-not-readonly"
	| "missing-trust-material"
	| "scanner-dangerous"
	| "user-unregistered"
	| "project-untrusted"
	| "project-registry-root-mismatch"
	| "project-unregistered";

export type AgentRunCandidate = {
	spec?: AgentSpec;
	parsed?: ParsedAgentMarkdown;
	canonicalPath?: string;
	rawBytesSha256?: string;
	scannerRisk?: RiskLevel;
	explicitUserRequest?: boolean;
	suspiciousConfirmed?: boolean;
};

export type CanRunAgentContext = {
	homeDir?: string;
	cwd?: string;
	projectRoot?: string;
	projectTrusted: boolean;
	userRegistry?: AgentRegistry;
	projectRegistry?: ProjectAgentRegistry;
};

export type CanRunAgentResult = {
	ok: boolean;
	code: CanRunAgentCode;
	reason: string;
	registryEntry?: RegisteredAgent;
};

export async function canRunAgent(candidate: AgentRunCandidate, context: CanRunAgentContext): Promise<CanRunAgentResult> {
	const spec = candidate.spec ?? candidate.parsed?.spec;
	if (!spec) return deny("missing-spec", "no normalized agent spec was provided");

	const scannerRisk = candidate.scannerRisk ?? candidate.parsed?.scannerRisk ?? "safe";

	if (spec.source === "built-in") {
		return allow("allowed-built-in", "built-in agents are trusted as installed extension code");
	}

	if (spec.source === "ephemeral") {
		return canRunEphemeral(spec, scannerRisk, candidate);
	}

	if (spec.source === "user") {
		return canRunRegisteredUser(spec, scannerRisk, candidate, context);
	}

	if (spec.source === "project") {
		return canRunRegisteredProject(spec, scannerRisk, candidate, context);
	}

	return deny("invalid-source", `unsupported agent source '${String(spec.source)}'`);
}

async function canRunRegisteredUser(spec: AgentSpec, scannerRisk: RiskLevel, candidate: AgentRunCandidate, context: CanRunAgentContext): Promise<CanRunAgentResult> {
	if (scannerRisk === "dangerous") return deny("scanner-dangerous", "dangerous user agent specs cannot run");
	const trust = await resolveTrustMaterial(candidate);
	if (!trust) return deny("missing-trust-material", "user agent requires canonical path and raw-byte SHA-256 trust material");
	const registry = context.userRegistry ?? await readUserRegistry(context.homeDir);
	const entry = findMatchingRegisteredAgent(registry, {
		name: spec.name,
		source: "user",
		canonicalPath: trust.canonicalPath,
		rawBytesSha256: trust.rawBytesSha256,
	});
	if (!entry) return deny("user-unregistered", "user agent is not registered for this exact path and raw-byte hash");
	if (entry.scannerRisk === "dangerous") return deny("scanner-dangerous", "registered user agent has dangerous scanner risk");
	return allow("allowed-registered-user", "user agent is registered by exact path and raw-byte hash", entry);
}

async function canRunRegisteredProject(spec: AgentSpec, scannerRisk: RiskLevel, candidate: AgentRunCandidate, context: CanRunAgentContext): Promise<CanRunAgentResult> {
	if (!context.projectTrusted) return deny("project-untrusted", "project agents require active project trust");
	if (scannerRisk === "dangerous") return deny("scanner-dangerous", "dangerous project agent specs cannot run");
	const trust = await resolveTrustMaterial(candidate);
	if (!trust) return deny("missing-trust-material", "project agent requires canonical path and raw-byte SHA-256 trust material");
	const projectRoot = context.projectRoot ?? context.cwd;
	if (!projectRoot) return deny("missing-trust-material", "project agent requires a current project root or cwd");
	const canonicalRoot = await canonicalizeProjectRoot(projectRoot);
	const registry = context.projectRegistry ?? await readProjectRegistry(canonicalRoot, context.homeDir);
	const rootCheck = validateProjectRegistryRoot(registry, canonicalRoot);
	if (!rootCheck.ok) return deny("project-registry-root-mismatch", `project registry root mismatch: ${rootCheck.issues.join(", ")}`);
	const entry = findMatchingRegisteredAgent(registry, {
		name: spec.name,
		source: "project",
		canonicalPath: trust.canonicalPath,
		rawBytesSha256: trust.rawBytesSha256,
	});
	if (!entry) return deny("project-unregistered", "project agent is not registered in this project's exact-hash registry");
	if (entry.scannerRisk === "dangerous") return deny("scanner-dangerous", "registered project agent has dangerous scanner risk");
	return allow("allowed-registered-project", "project agent is registered for this project by exact path and raw-byte hash", entry);
}

function canRunEphemeral(spec: AgentSpec, scannerRisk: RiskLevel, candidate: AgentRunCandidate): CanRunAgentResult {
	if (!candidate.explicitUserRequest) return deny("not-explicit-ephemeral", "ephemeral agents require an explicit slash/user request");
	if (!toolsAreReadonly(spec.tools)) return deny("tools-not-readonly", "ephemeral agents must use only P3 read-only tools");
	if (scannerRisk === "dangerous") return deny("ephemeral-dangerous", "dangerous ephemeral prompts cannot run");
	if (scannerRisk === "suspicious" && !candidate.suspiciousConfirmed) {
		return deny("ephemeral-suspicious-unconfirmed", "suspicious ephemeral prompts require explicit confirmation");
	}
	return allow("allowed-ephemeral", "ephemeral agent was explicitly requested and passed P3 safety checks");
}

async function resolveTrustMaterial(candidate: AgentRunCandidate): Promise<{ canonicalPath: string; rawBytesSha256: string } | undefined> {
	const sourcePath = candidate.canonicalPath ?? candidate.parsed?.filePath;
	const rawBytesSha256 = candidate.rawBytesSha256 ?? candidate.parsed?.rawBytesSha256;
	if (!sourcePath || !rawBytesSha256) return undefined;
	return { canonicalPath: candidate.canonicalPath ?? await canonicalizePath(sourcePath), rawBytesSha256 };
}

function toolsAreReadonly(tools: string[]): boolean {
	const readonly = new Set<string>(P3_READONLY_TOOLS);
	return tools.length > 0 && tools.every((tool) => readonly.has(tool));
}

function allow(code: CanRunAgentCode, reason: string, registryEntry?: RegisteredAgent): CanRunAgentResult {
	return { ok: true, code, reason, ...(registryEntry ? { registryEntry } : {}) };
}

function deny(code: CanRunAgentCode, reason: string): CanRunAgentResult {
	return { ok: false, code, reason };
}
