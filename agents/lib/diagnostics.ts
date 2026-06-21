import path from "node:path";
import { promises as fs } from "node:fs";
import { parseAgentMarkdownFile, type MarkdownAgentSource, type ParsedAgentMarkdown } from "./agent-markdown.ts";
import { canRunAgent, type CanRunAgentCode } from "./can-run-agent.ts";
import {
	canonicalizePath,
	canonicalizeProjectRoot,
	findMatchingRegisteredAgent,
	getAgentsHomeDir,
	getProjectRegistryPaths,
	getUserRegistryPath,
	readProjectRegistry,
	readUserRegistry,
	validateProjectRegistryRoot,
	type AgentRegistry,
	type ProjectAgentRegistry,
	type RegisteredAgent,
} from "./registry.ts";
import { listBuiltInAgentSpecs, type AgentSource, type AgentSpec, type AgentValidationIssue } from "./specs.ts";
import type { RiskLevel } from "./security-scan.ts";
import { BUILT_IN_PROFILES } from "./profiles.ts";
import { type IntentCandidate } from "./intent-router.ts";

export const DEFAULT_DIAGNOSTIC_LIMITS = Object.freeze({
	maxAgentsPerSource: 50,
	maxRegistryEntries: 100,
	maxLines: 120,
});

export type AgentDiagnosticStatus = "runnable" | "blocked" | "warning";

export type AgentDiagnosticRecord = {
	name: string;
	source: AgentSource;
	status: AgentDiagnosticStatus;
	runnable: boolean;
	registered: boolean;
	reason: string;
	nextStep: string;
	tools: string[];
	evalStatus: "present" | "missing" | "unknown";
	scannerRisk: RiskLevel;
	filePath?: string;
	canonicalPath?: string;
	rawBytesSha256?: string;
	hashMismatch: boolean;
	shadowedReservedName: boolean;
	issues: AgentValidationIssue[];
	warnings: string[];
	runCode?: CanRunAgentCode;
	registryEntry?: RegisteredAgent;
	spec?: AgentSpec;
};

export type AgentDiagnosticSummary = {
	total: number;
	runnable: number;
	blocked: number;
	warnings: number;
	unregistered: number;
	hashMismatched: number;
	dangerous: number;
	suspicious: number;
	invalid: number;
	shadowed: number;
	missingEvals: number;
};

export type AgentDiagnostics = {
	cwd: string;
	projectRoot: string;
	projectTrusted: boolean;
	userAgentsDir: string;
	projectAgentsDir: string;
	userRegistryPath: string;
	projectRegistryPath: string;
	projectRegistryRootOk: boolean;
	projectRegistryRootIssues: string[];
	userRegistry: AgentRegistry;
	projectRegistry: ProjectAgentRegistry;
	records: AgentDiagnosticRecord[];
	registryOnlyEntries: RegisteredAgent[];
	summary: AgentDiagnosticSummary;
};

export type CollectAgentDiagnosticsOptions = {
	cwd?: string;
	homeDir?: string;
	projectTrusted: boolean;
	maxAgentsPerSource?: number;
};

export async function collectAgentDiagnostics(options: CollectAgentDiagnosticsOptions): Promise<AgentDiagnostics> {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const projectRoot = await canonicalizeProjectRoot(cwd);
	const homeDir = options.homeDir;
	const maxAgentsPerSource = options.maxAgentsPerSource ?? DEFAULT_DIAGNOSTIC_LIMITS.maxAgentsPerSource;
	const userAgentsDir = getAgentsHomeDir(homeDir);
	const projectAgentsDir = path.join(projectRoot, ".pi", "agents");
	const userRegistryPath = getUserRegistryPath(homeDir);
	const projectPaths = await getProjectRegistryPaths(projectRoot, homeDir);
	const userRegistry = await readUserRegistry(homeDir);
	const projectRegistry = await readProjectRegistry(projectRoot, homeDir);
	const rootCheck = validateProjectRegistryRoot(projectRegistry, projectRoot);

	const builtInRecords = listBuiltInAgentSpecs().map(builtInRecord);
	const userParsed = await scanAgentDirectoryBounded(userAgentsDir, "user", maxAgentsPerSource);
	const projectParsed = options.projectTrusted ? await scanAgentDirectoryBounded(projectAgentsDir, "project", maxAgentsPerSource) : [];
	const userRecords = await Promise.all(userParsed.map((parsed) => parsedRecord(parsed, userRegistry, projectRegistry, options.projectTrusted, projectRoot)));
	const projectRecords = await Promise.all(projectParsed.map((parsed) => parsedRecord(parsed, userRegistry, projectRegistry, options.projectTrusted, projectRoot)));
	const records = [...builtInRecords, ...userRecords, ...projectRecords].sort(compareRecords);
	const registryOnlyEntries = registryOnly(userRegistry, projectRegistry, records).slice(0, DEFAULT_DIAGNOSTIC_LIMITS.maxRegistryEntries);

	return {
		cwd,
		projectRoot,
		projectTrusted: options.projectTrusted,
		userAgentsDir,
		projectAgentsDir,
		userRegistryPath,
		projectRegistryPath: projectPaths.registryPath,
		projectRegistryRootOk: rootCheck.ok,
		projectRegistryRootIssues: rootCheck.issues,
		userRegistry,
		projectRegistry,
		records,
		registryOnlyEntries,
		summary: summarize(records),
	};
}

export function formatAgentsList(diagnostics: AgentDiagnostics): string {
	const lines = [
		"Agents:",
		`projectTrust: ${diagnostics.projectTrusted ? "active" : "inactive"}`,
		...diagnostics.records.map((record) => {
			const modelPart = record.spec?.model ? ` model=${record.spec.model}` : "";
			const thinkingPart = record.spec?.thinking ? ` thinking=${record.spec.thinking}` : "";
			const profilePart = record.spec?.profile ? ` profile=${record.spec.profile}` : "";
			return `- ${record.name} [${record.source}] ${statusLabel(record)}; tools=${record.tools.join(",")}${modelPart}${thinkingPart}${profilePart}; evals=${record.evalStatus}; risk=${record.scannerRisk}${record.nextStep ? `; next=${record.nextStep}` : ""}`;
		}),
	];
	if (!diagnostics.projectTrusted) lines.push("Project agents are not scanned until project trust is active.");
	return boundLines(lines);
}

export function formatAgentsConfig(diagnostics: AgentDiagnostics): string {
	return boundLines([
		"Agents config:",
		`cwd: ${diagnostics.cwd}`,
		`projectRoot: ${diagnostics.projectRoot}`,
		`projectTrust: ${diagnostics.projectTrusted ? "active" : "inactive"}`,
		`userAgentsDir: ${diagnostics.userAgentsDir}`,
		`projectAgentsDir: ${diagnostics.projectAgentsDir}`,
		`projectDiscovery: ${diagnostics.projectTrusted ? "enabled" : "disabled until project trust is active"}`,
		`userRegistry: ${diagnostics.userRegistryPath}`,
		`projectRegistry: ${diagnostics.projectRegistryPath}`,
		`projectRegistryRoot: ${diagnostics.projectRegistryRootOk ? "ok" : `mismatch (${diagnostics.projectRegistryRootIssues.join(", ")})`}`,
		"Child execution: /agents run scout|planner|reviewer <task> or /agents run <registered-user-or-project-agent> <task>",
		"Registered user/project execution requires exact-hash registration and the runtime canRunAgent gate.",
	]);
}

export function formatAgentsRegistry(diagnostics: AgentDiagnostics): string {
	const lines = ["Agents registry:", `userRegistry: ${diagnostics.userRegistryPath}`, `projectRegistry: ${diagnostics.projectRegistryPath}`];
	for (const entry of [...diagnostics.userRegistry.agents, ...diagnostics.projectRegistry.agents].sort(compareRegistryEntries)) {
		lines.push(`- ${entry.name} [${entry.source}] ${entry.rawBytesSha256.slice(0, 12)} ${entry.canonicalPath} risk=${entry.scannerRisk} evals=${entry.evalStatus}`);
	}
	if (diagnostics.userRegistry.agents.length + diagnostics.projectRegistry.agents.length === 0) lines.push("No registered user/project agents.");
	if (diagnostics.registryOnlyEntries.length > 0) {
		lines.push("Registry entries without matching discovered files:");
		for (const entry of diagnostics.registryOnlyEntries) lines.push(`- ${entry.name} [${entry.source}] ${entry.canonicalPath}`);
	}
	return boundLines(lines);
}

export function formatAgentsVerify(diagnostics: AgentDiagnostics): string {
	const issues = diagnosticIssues(diagnostics);
	const lines = ["Agents verify:", summaryLine(diagnostics.summary)];
	if (issues.length === 0) lines.push("No diagnostic issues found for discovered agents.");
	else for (const issue of issues) lines.push(`- ${issue}`);
	return boundLines(lines);
}

export function formatAgentsDoctor(diagnostics: AgentDiagnostics): string {
	const lines = ["Agents doctor:", summaryLine(diagnostics.summary), `projectTrust: ${diagnostics.projectTrusted ? "active" : "inactive"}`];
	if (!diagnostics.projectRegistryRootOk) lines.push(`1. Project registry root mismatch: ${diagnostics.projectRegistryRootIssues.join(", ")}. Recreate the project registry after confirming the project root.`);
	let index = lines.filter((line) => /^\d+\./.test(line)).length + 1;
	for (const issue of diagnosticIssues(diagnostics)) lines.push(`${index++}. ${issue}`);
	if (index === 1) lines.push("No remediation needed before registered-agent execution.");
	lines.push("Built-in and registered user/project child execution is available via /agents run.");
	return boundLines(lines);
}

export function formatAgentInspect(diagnostics: AgentDiagnostics, name: string): string {
	const matches = diagnostics.records.filter((record) => record.name === name);
	if (matches.length === 0) return `Agent '${name}' was not found. Next: /agents list`;
	const lines = [`Agent inspect: ${name}`];
	for (const record of matches) {
		lines.push(`[${record.source}] ${statusLabel(record)}`);
		lines.push(`description: ${record.spec?.description ?? "built-in or invalid spec"}`);
		if (record.filePath) lines.push(`path: ${record.filePath}`);
		if (record.rawBytesSha256) lines.push(`sha256: ${record.rawBytesSha256}`);
		lines.push(`tools: ${record.tools.join(",")}`);
		if (record.spec?.model) lines.push(`model: ${record.spec.model}`);
		if (record.spec?.thinking) lines.push(`thinking: ${record.spec.thinking}`);
		if (record.spec?.profile) lines.push(`profile: ${record.spec.profile}${record.spec.profile && !BUILT_IN_PROFILES[record.spec.profile] ? " (unresolved in built-in profiles)" : ""}`);
		lines.push(`risk: ${record.scannerRisk}`);
		lines.push(`evals: ${record.evalStatus}`);
		lines.push(`registered: ${record.registered ? "yes" : "no"}${record.hashMismatch ? " (hash changed)" : ""}`);
		for (const issue of record.issues.slice(0, 5)) lines.push(`issue: ${issue.field}: ${issue.message}`);
		for (const warning of record.warnings.slice(0, 5)) lines.push(`warning: ${warning}`);
		if (record.nextStep) lines.push(`next: ${record.nextStep}`);
	}
	return boundLines(lines);
}

export function buildProjectAgentRecommendation(diagnostics: AgentDiagnostics): { key: string; message: string } | undefined {
	const projectRecords = diagnostics.records.filter((record) => record.source === "project");
	if (!diagnostics.projectTrusted || projectRecords.length === 0) return undefined;
	const actionable = projectRecords.filter((record) => !record.runnable || record.hashMismatch || record.scannerRisk !== "safe" || record.evalStatus === "missing");
	if (actionable.length === 0) return undefined;
	const unregistered = projectRecords.filter((record) => !record.registered && !record.hashMismatch && record.issues.length === 0 && !record.shadowedReservedName).length;
	const hashChanged = projectRecords.filter((record) => record.hashMismatch).length;
	const invalid = projectRecords.filter((record) => record.issues.length > 0 || record.shadowedReservedName).length;
	const suspicious = projectRecords.filter((record) => record.scannerRisk === "suspicious").length;
	const missingEvals = projectRecords.filter((record) => record.evalStatus === "missing").length;
	const aggregate = projectRecords.map((record) => `${record.name}:${record.rawBytesSha256}:${record.status}:${record.registered}:${record.hashMismatch}`).join("|");
	const parts = [`Project agents found: ${projectRecords.length} total`];
	if (unregistered) parts.push(`${unregistered} unregistered`);
	if (hashChanged) parts.push(`${hashChanged} hash changed`);
	if (invalid) parts.push(`${invalid} invalid/shadowed`);
	if (suspicious) parts.push(`${suspicious} suspicious`);
	if (missingEvals) parts.push(`${missingEvals} missing evals`);
	return {
		key: `${diagnostics.projectRoot}\0${aggregate}`,
		message: `${parts.join(", ")}. Next: /agents doctor or /agents register-project`,
	};
}

async function scanAgentDirectoryBounded(dir: string, source: MarkdownAgentSource, maxAgents: number): Promise<ParsedAgentMarkdown[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return [];
		throw error;
	}
	const markdown = entries.filter((entry) => entry.endsWith(".md")).sort((a, b) => a.localeCompare(b)).slice(0, maxAgents);
	const results: ParsedAgentMarkdown[] = [];
	for (const entry of markdown) results.push(await parseAgentMarkdownFile(path.join(dir, entry), { source }));
	return results;
}

function builtInRecord(spec: AgentSpec): AgentDiagnosticRecord {
	return {
		name: spec.name,
		source: "built-in",
		status: "runnable",
		runnable: true,
		registered: true,
		reason: "built-in agents are trusted as installed extension code",
		nextStep: "",
		tools: [...spec.tools],
		evalStatus: evalStatusForSpec(spec),
		scannerRisk: "safe",
		hashMismatch: false,
		shadowedReservedName: false,
		issues: [],
		warnings: [],
		runCode: "allowed-built-in",
		spec,
	};
}

async function parsedRecord(parsed: ParsedAgentMarkdown, userRegistry: AgentRegistry, projectRegistry: ProjectAgentRegistry, projectTrusted: boolean, projectRoot: string): Promise<AgentDiagnosticRecord> {
	const source = parsed.source;
	const registry = source === "user" ? userRegistry : projectRegistry;
	const spec = parsed.spec;
	const name = spec?.name ?? String(parsed.metadata.name ?? path.basename(parsed.filePath ?? "unknown", ".md"));
	const canonicalPath = parsed.filePath ? await canonicalizePath(parsed.filePath) : undefined;
	const registeredEntry = spec && canonicalPath ? findMatchingRegisteredAgent(registry, { name: spec.name, source, canonicalPath, rawBytesSha256: parsed.rawBytesSha256 }) : undefined;
	const samePathEntry = canonicalPath ? registry.agents.find((entry) => entry.name === name && entry.source === source && entry.canonicalPath === canonicalPath) : undefined;
	const hashMismatch = Boolean(samePathEntry && samePathEntry.rawBytesSha256 !== parsed.rawBytesSha256);
	const evalStatus = spec ? evalStatusForSpec(spec) : "unknown";
	const base = {
		name,
		source,
		registered: Boolean(registeredEntry),
		tools: spec ? [...spec.tools] : [],
		evalStatus,
		scannerRisk: parsed.scannerRisk,
		filePath: parsed.filePath,
		canonicalPath,
		rawBytesSha256: parsed.rawBytesSha256,
		hashMismatch,
		shadowedReservedName: parsed.shadowedReservedName,
		issues: [...parsed.issues],
		warnings: [...parsed.warnings],
		registryEntry: registeredEntry,
		spec,
	};
	if (!spec || parsed.status === "invalid") return blocked(base, "spec is invalid", "Fix the Markdown spec, then run /agents verify");
	if (parsed.status === "dangerous") return blocked(base, "deterministic scanner classified this spec as dangerous", "Remove dangerous instructions; dangerous specs cannot register or run");
	if (parsed.status === "shadowed") return blocked(base, "spec name is reserved by a built-in agent", "Rename this spec before registering it");
	const gate = await canRunAgent({ parsed, canonicalPath }, { projectTrusted, projectRoot, userRegistry, projectRegistry });
	if (gate.ok) {
		return {
			...base,
			status: evalStatus === "missing" ? "warning" : "runnable",
			runnable: true,
			reason: gate.reason,
			nextStep: evalStatus === "missing" ? "Add eval metadata before relying on this reusable agent" : "",
			runCode: gate.code,
			registryEntry: gate.registryEntry,
		};
	}
	return blocked(base, gate.reason, nextStepForGate(gate.code, source, hashMismatch));
}

function blocked(base: Omit<AgentDiagnosticRecord, "status" | "runnable" | "reason" | "nextStep">, reason: string, nextStep: string): AgentDiagnosticRecord {
	return { ...base, status: "blocked", runnable: false, reason, nextStep };
}

function nextStepForGate(code: CanRunAgentCode, source: MarkdownAgentSource, hashMismatch: boolean): string {
	if (hashMismatch) return source === "project" ? "/agents register-project after reviewing the changed spec" : "/agents register <name> after reviewing the changed spec";
	if (code === "project-untrusted") return "Activate project trust, then run /agents doctor or /agents register-project";
	if (code === "project-registry-root-mismatch") return "Recreate the project registry for the current project root";
	if (source === "project") return "/agents register-project";
	return "/agents register <name>";
}

function registryOnly(userRegistry: AgentRegistry, projectRegistry: ProjectAgentRegistry, records: AgentDiagnosticRecord[]): RegisteredAgent[] {
	const discovered = new Set(records.filter((record) => record.canonicalPath).map((record) => `${record.source}\0${record.name}\0${record.canonicalPath}`));
	return [...userRegistry.agents, ...projectRegistry.agents]
		.filter((entry) => !discovered.has(`${entry.source}\0${entry.name}\0${entry.canonicalPath}`))
		.sort(compareRegistryEntries);
}

function diagnosticIssues(diagnostics: AgentDiagnostics): string[] {
	const issues: string[] = [];
	for (const record of diagnostics.records) {
		if (record.source === "built-in") continue;
		if (record.hashMismatch) issues.push(`${record.name} [${record.source}] hash changed. Next: ${record.nextStep}`);
		else if (record.issues.length > 0) issues.push(`${record.name} [${record.source}] invalid/dangerous: ${record.issues[0].message}. Next: ${record.nextStep}`);
		else if (record.shadowedReservedName) issues.push(`${record.name} [${record.source}] shadows a built-in. Next: ${record.nextStep}`);
		else if (!record.registered) issues.push(`${record.name} [${record.source}] is unregistered. Next: ${record.nextStep}`);
		if (record.scannerRisk === "suspicious") issues.push(`${record.name} [${record.source}] is suspicious and will require explicit confirmation during registration.`);
		if (record.evalStatus === "missing") issues.push(`${record.name} [${record.source}] is missing eval metadata.`);
		if (record.spec?.profile && !BUILT_IN_PROFILES[record.spec.profile]) {
			issues.push(`${record.name} [${record.source}] profile '${record.spec.profile}' is not a known built-in profile. The agent will fail at runtime.`);
		}
	}
	for (const entry of diagnostics.registryOnlyEntries) issues.push(`${entry.name} [${entry.source}] registry entry has no matching discovered file: ${entry.canonicalPath}`);
	if (!diagnostics.projectTrusted) issues.push("Project trust inactive; project-local agent discovery is disabled.");
	return issues.slice(0, 50);
}

function summarize(records: AgentDiagnosticRecord[]): AgentDiagnosticSummary {
	return {
		total: records.length,
		runnable: records.filter((record) => record.runnable).length,
		blocked: records.filter((record) => !record.runnable).length,
		warnings: records.filter((record) => record.status === "warning" || record.warnings.length > 0).length,
		unregistered: records.filter((record) => record.source !== "built-in" && !record.registered && !record.hashMismatch && record.issues.length === 0 && !record.shadowedReservedName).length,
		hashMismatched: records.filter((record) => record.hashMismatch).length,
		dangerous: records.filter((record) => record.scannerRisk === "dangerous").length,
		suspicious: records.filter((record) => record.scannerRisk === "suspicious").length,
		invalid: records.filter((record) => record.issues.length > 0).length,
		shadowed: records.filter((record) => record.shadowedReservedName).length,
		missingEvals: records.filter((record) => record.evalStatus === "missing").length,
	};
}

function evalStatusForSpec(spec: AgentSpec): "present" | "missing" | "unknown" {
	if (spec.evals.length === 0) return "missing";
	return spec.evals.every((entry) => entry.required) ? "present" : "unknown";
}

function statusLabel(record: AgentDiagnosticRecord): string {
	if (record.runnable) return record.status === "warning" ? "runnable-with-warnings" : "runnable";
	if (record.hashMismatch) return "blocked-hash-mismatch";
	if (record.scannerRisk === "dangerous") return "blocked-dangerous";
	if (record.shadowedReservedName) return "blocked-shadowed";
	return "blocked";
}

function summaryLine(summary: AgentDiagnosticSummary): string {
	return `summary: total=${summary.total}, runnable=${summary.runnable}, blocked=${summary.blocked}, unregistered=${summary.unregistered}, hashMismatched=${summary.hashMismatched}, dangerous=${summary.dangerous}, suspicious=${summary.suspicious}, missingEvals=${summary.missingEvals}`;
}

function boundLines(lines: string[], maxLines = DEFAULT_DIAGNOSTIC_LIMITS.maxLines): string {
	if (lines.length <= maxLines) return lines.join("\n");
	return [...lines.slice(0, maxLines - 1), `... truncated ${lines.length - maxLines + 1} lines`].join("\n");
}

function compareRecords(left: AgentDiagnosticRecord, right: AgentDiagnosticRecord): number {
	return `${sourceRank(left.source)}\0${left.name}\0${left.filePath ?? ""}`.localeCompare(`${sourceRank(right.source)}\0${right.name}\0${right.filePath ?? ""}`);
}

function compareRegistryEntries(left: RegisteredAgent, right: RegisteredAgent): number {
	return `${sourceRank(left.source)}\0${left.name}\0${left.canonicalPath}`.localeCompare(`${sourceRank(right.source)}\0${right.name}\0${right.canonicalPath}`);
}

function sourceRank(source: AgentSource): string {
	return source === "built-in" ? "0" : source === "user" ? "1" : source === "project" ? "2" : "3";
}

/** P6-3b: build the candidate set for intent routing — built-in agents + runnable registered records. */
export function buildIntentCandidates(d: AgentDiagnostics): IntentCandidate[] {
	const builtIns = listBuiltInAgentSpecs().map((spec) => ({
		name: spec.name,
		source: "built-in" as const,
		description: spec.description,
		role: spec.name as "scout" | "planner" | "reviewer",
	}));
	const registered = d.records
		.filter((r) => r.runnable && r.source !== "built-in")
		.map((r) => ({
			name: r.name,
			source: (r.source === "user" ? "user" : "project") as "user" | "project",
			description: (r.spec?.description ?? "").slice(0, 200),
		}));
	return [...builtIns, ...registered];
}
