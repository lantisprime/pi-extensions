import path from "node:path";
import { parseAgentMarkdownFile, type MarkdownAgentSource, type ParsedAgentMarkdown } from "./agent-markdown.ts";
import {
	addOrReplaceRegisteredAgent,
	canonicalizePath,
	createRegisteredAgentFromParsed,
	writeProjectRegistry,
	writeUserRegistry,
	type RegisteredAgent,
} from "./registry.ts";
import { collectAgentDiagnostics, type AgentDiagnosticRecord, type AgentDiagnostics } from "./diagnostics.ts";

export type RegistrationDecision = "confirmed" | "cancelled" | "not-interactive";
export type RegistrationResultStatus = "registered" | "unregistered" | "blocked" | "cancelled" | "skipped";

export type RegistrationPrompt = {
	confirm(title: string, message: string): Promise<boolean> | boolean;
};

export type RegisterAgentOptions = {
	cwd?: string;
	homeDir?: string;
	projectTrusted: boolean;
	hasUI: boolean;
	ui?: RegistrationPrompt;
	now?: string;
	diagnostics?: AgentDiagnostics;
};

export type RegisterProjectAgentsOptions = RegisterAgentOptions & {
	allSafe?: boolean;
};

export type UnregisterAgentOptions = RegisterAgentOptions;

export type RegistrationResult = {
	status: RegistrationResultStatus;
	message: string;
	entry?: RegisteredAgent;
	reason?: string;
};

export type RegistrationBatchResult = {
	status: RegistrationResultStatus;
	message: string;
	registered: RegisteredAgent[];
	blocked: RegistrationResult[];
	skipped: RegistrationResult[];
	cancelled: RegistrationResult[];
};

export type ResolvedRegistrationTarget = {
	source: MarkdownAgentSource;
	filePath: string;
	canonicalPath: string;
	record?: AgentDiagnosticRecord;
};

const EXACT_HASH_NOTICE = "Registration approves this exact agent spec hash only. It does not sandbox the project or trust arbitrary repository content.";

export async function registerAgent(target: string, options: RegisterAgentOptions): Promise<RegistrationResult> {
	const diagnostics = options.diagnostics ?? await collectAgentDiagnostics({ cwd: options.cwd, homeDir: options.homeDir, projectTrusted: options.projectTrusted });
	const resolved = await resolveRegistrationTarget(target, diagnostics);
	if ("status" in resolved) return resolved;
	return registerResolvedTarget(resolved, diagnostics, options);
}

export async function registerProjectAgents(options: RegisterProjectAgentsOptions): Promise<RegistrationBatchResult> {
	const diagnostics = options.diagnostics ?? await collectAgentDiagnostics({ cwd: options.cwd, homeDir: options.homeDir, projectTrusted: options.projectTrusted });
	if (!options.projectTrusted) {
		return batch("blocked", "Project trust is inactive. Run /trust, then /agents register-project.", [], [{ status: "blocked", message: "project trust inactive", reason: "project-untrusted" }], [], []);
	}
	if (!diagnostics.projectRegistryRootOk) {
		return batch("blocked", `Project registry root mismatch: ${diagnostics.projectRegistryRootIssues.join(", ")}. Run /agents doctor.`, [], [{ status: "blocked", message: "project registry root mismatch", reason: "project-registry-root-mismatch" }], [], []);
	}
	const projectRecords = diagnostics.records.filter((record) => record.source === "project");
	if (projectRecords.length === 0) return batch("skipped", "No project agent specs found in .pi/agents/*.md.", [], [], [{ status: "skipped", message: "no project specs found" }], []);

	let projectRegistry = diagnostics.projectRegistry;
	const registered: RegisteredAgent[] = [];
	const blockedResults: RegistrationResult[] = [];
	const skipped: RegistrationResult[] = [];
	const cancelled: RegistrationResult[] = [];

	for (const record of projectRecords) {
		if (!record.filePath || !record.canonicalPath) {
			blockedResults.push({ status: "blocked", message: `${record.name}: missing project spec path`, reason: "missing-path" });
			continue;
		}
		const parsed = await parseAgentMarkdownFile(record.filePath, { source: "project" });
		const eligibility = registrationEligibility(parsed);
		if (!eligibility.ok) {
			blockedResults.push({ status: "blocked", message: `${record.name}: ${eligibility.reason}`, reason: eligibility.code });
			continue;
		}
		if (options.allSafe && parsed.scannerRisk !== "safe") {
			skipped.push({ status: "skipped", message: `${record.name}: skipped by --all-safe because risk=${parsed.scannerRisk}`, reason: "all-safe-excludes-suspicious" });
			continue;
		}
		const decision = await confirmRegistration({ parsed, canonicalPath: record.canonicalPath, record, options, projectBatch: true });
		if (decision === "not-interactive") {
			return batch("blocked", nonInteractiveMessage("register-project"), registered, [{ status: "blocked", message: nonInteractiveMessage("register-project"), reason: "non-interactive" }], skipped, cancelled);
		}
		if (decision === "cancelled") {
			cancelled.push({ status: "cancelled", message: `${record.name}: registration cancelled`, reason: "cancelled" });
			continue;
		}
		const entry = await createRegisteredAgentFromParsed(parsed, { canonicalPath: record.canonicalPath, approvedAt: options.now });
		projectRegistry = addOrReplaceRegisteredAgent(projectRegistry, entry, options.now);
		registered.push(entry);
	}

	if (registered.length > 0) await writeProjectRegistry(projectRegistry, diagnostics.projectRoot, options.homeDir);
	const status = registered.length > 0 ? "registered" : blockedResults.length > 0 ? "blocked" : cancelled.length > 0 ? "cancelled" : "skipped";
	return batch(status, projectBatchMessage(registered, blockedResults, skipped, cancelled), registered, blockedResults, skipped, cancelled);
}

export async function unregisterAgent(name: string, options: UnregisterAgentOptions): Promise<RegistrationBatchResult> {
	const diagnostics = options.diagnostics ?? await collectAgentDiagnostics({ cwd: options.cwd, homeDir: options.homeDir, projectTrusted: options.projectTrusted });
	const trimmed = name.trim();
	if (!trimmed) return batch("blocked", "Usage: /agents unregister <name>", [], [{ status: "blocked", message: "missing agent name", reason: "missing-name" }], [], []);
	const userMatches = diagnostics.userRegistry.agents.filter((entry) => entry.name === trimmed);
	const projectMatches = diagnostics.projectRegistry.agents.filter((entry) => entry.name === trimmed);
	const matches = [...userMatches, ...projectMatches];
	if (matches.length === 0) return batch("skipped", `No registry entries found for '${trimmed}'.`, [], [], [{ status: "skipped", message: `no entries for ${trimmed}` }], []);
	const decision = await confirmAction(options, "Unregister agent?", `Remove ${matches.length} registry entr${matches.length === 1 ? "y" : "ies"} for '${trimmed}'?\nThis does not delete Markdown spec files.`);
	if (decision === "not-interactive") return batch("blocked", nonInteractiveMessage("unregister"), [], [{ status: "blocked", message: nonInteractiveMessage("unregister"), reason: "non-interactive" }], [], []);
	if (decision === "cancelled") return batch("cancelled", `Unregister cancelled for '${trimmed}'.`, [], [], [], [{ status: "cancelled", message: "cancelled", reason: "cancelled" }]);

	if (userMatches.length > 0) await writeUserRegistry({ ...diagnostics.userRegistry, updatedAt: options.now ?? new Date().toISOString(), agents: diagnostics.userRegistry.agents.filter((entry) => entry.name !== trimmed) }, options.homeDir);
	if (projectMatches.length > 0) await writeProjectRegistry({ ...diagnostics.projectRegistry, updatedAt: options.now ?? new Date().toISOString(), agents: diagnostics.projectRegistry.agents.filter((entry) => entry.name !== trimmed) }, diagnostics.projectRoot, options.homeDir);
	return batch("unregistered", `Unregistered ${matches.length} entr${matches.length === 1 ? "y" : "ies"} for '${trimmed}'.`, [], [], [], []);
}

export async function resolveRegistrationTarget(target: string, diagnostics: AgentDiagnostics): Promise<ResolvedRegistrationTarget | RegistrationResult> {
	const trimmed = target.trim();
	if (!trimmed) return { status: "blocked", message: "Usage: /agents register <path-or-name>", reason: "missing-target" };
	const nonBuiltIn = diagnostics.records.filter((record) => record.source === "user" || record.source === "project");
	const byName = nonBuiltIn.filter((record) => record.name === trimmed);
	if (byName.length === 1 && byName[0].filePath && byName[0].canonicalPath) {
		return { source: byName[0].source as MarkdownAgentSource, filePath: byName[0].filePath, canonicalPath: byName[0].canonicalPath, record: byName[0] };
	}
	if (byName.length > 1) {
		return { status: "blocked", message: `Agent name '${trimmed}' is ambiguous. Use an exact spec path.`, reason: "ambiguous-name" };
	}
	if (!looksLikePath(trimmed)) return { status: "blocked", message: `No discovered user/project agent named '${trimmed}'.`, reason: "not-found" };

	const canonicalPath = await canonicalizePath(path.resolve(diagnostics.cwd, trimmed));
	const source = await sourceForPath(canonicalPath, diagnostics);
	if (!source) {
		return { status: "blocked", message: "Agent specs must live under the user agents directory or trusted project .pi/agents directory.", reason: "path-outside-agent-dirs" };
	}
	if (source === "project" && !diagnostics.projectTrusted) {
		return { status: "blocked", message: "Project trust is inactive. Run /trust before registering project agents.", reason: "project-untrusted" };
	}
	const record = nonBuiltIn.find((entry) => entry.canonicalPath === canonicalPath && entry.source === source);
	return { source, filePath: canonicalPath, canonicalPath, record };
}

export function formatRegistrationReview(parsed: ParsedAgentMarkdown, canonicalPath: string, record?: AgentDiagnosticRecord): string {
	const spec = parsed.spec;
	return [
		`Agent: ${spec?.name ?? String(parsed.metadata.name ?? "unknown")}`,
		`Source: ${parsed.source}`,
		`Path: ${canonicalPath}`,
		`Raw-bytes SHA-256: ${parsed.rawBytesSha256}`,
		`Risk: ${parsed.scannerRisk}`,
		`Tools: ${spec?.tools.join(", ") ?? "invalid"}`,
		`Model: ${spec?.model ?? "default"}`,
		`Thinking: ${spec?.thinking ?? "default"}`,
		`Evals: ${record?.evalStatus ?? (spec && spec.evals.length > 0 ? "present" : "missing")}`,
		`Runnable after approval: ${parsed.status === "eligible" || parsed.scannerRisk === "suspicious" ? "yes" : "no"}`,
		EXACT_HASH_NOTICE,
	].join("\n");
}

async function registerResolvedTarget(target: ResolvedRegistrationTarget, diagnostics: AgentDiagnostics, options: RegisterAgentOptions): Promise<RegistrationResult> {
	if (target.source === "project" && !diagnostics.projectRegistryRootOk) {
		return { status: "blocked", message: `Project registry root mismatch: ${diagnostics.projectRegistryRootIssues.join(", ")}. Run /agents doctor.`, reason: "project-registry-root-mismatch" };
	}
	const parsed = await parseAgentMarkdownFile(target.filePath, { source: target.source });
	const eligibility = registrationEligibility(parsed);
	if (!eligibility.ok) return { status: "blocked", message: `${parsed.spec?.name ?? target.filePath}: ${eligibility.reason}`, reason: eligibility.code };
	const decision = await confirmRegistration({ parsed, canonicalPath: target.canonicalPath, record: target.record, options });
	if (decision === "not-interactive") return { status: "blocked", message: nonInteractiveMessage("register"), reason: "non-interactive" };
	if (decision === "cancelled") return { status: "cancelled", message: `Registration cancelled for '${parsed.spec?.name ?? target.filePath}'.`, reason: "cancelled" };

	const entry = await createRegisteredAgentFromParsed(parsed, { canonicalPath: target.canonicalPath, approvedAt: options.now });
	if (target.source === "user") {
		await writeUserRegistry(addOrReplaceRegisteredAgent(diagnostics.userRegistry, entry, options.now), options.homeDir);
	} else {
		await writeProjectRegistry(addOrReplaceRegisteredAgent(diagnostics.projectRegistry, entry, options.now), diagnostics.projectRoot, options.homeDir);
	}
	return { status: "registered", message: `Registered ${entry.name}. Run: /agents run ${entry.name} <task>`, entry };
}

function registrationEligibility(parsed: ParsedAgentMarkdown): { ok: true } | { ok: false; code: string; reason: string } {
	if (!parsed.spec) return { ok: false, code: "invalid", reason: "spec is invalid and cannot be registered" };
	if (parsed.status === "dangerous" || parsed.scannerRisk === "dangerous") return { ok: false, code: "dangerous", reason: "dangerous specs cannot register" };
	if (parsed.status === "invalid") return { ok: false, code: "invalid", reason: `invalid spec: ${parsed.issues[0]?.message ?? "validation failed"}` };
	if (parsed.status === "shadowed" || parsed.shadowedReservedName) return { ok: false, code: "shadowed", reason: "spec shadows a reserved built-in name" };
	return { ok: true };
}

async function confirmRegistration(input: { parsed: ParsedAgentMarkdown; canonicalPath: string; record?: AgentDiagnosticRecord; options: RegisterAgentOptions; projectBatch?: boolean }): Promise<RegistrationDecision> {
	const title = input.parsed.scannerRisk === "suspicious" ? "Register suspicious agent?" : input.projectBatch ? "Register project agent?" : "Register agent?";
	const riskLine = input.parsed.scannerRisk === "suspicious" ? "\n\nThis agent is suspicious and requires explicit per-spec confirmation." : "";
	return confirmAction(input.options, title, `${formatRegistrationReview(input.parsed, input.canonicalPath, input.record)}${riskLine}`);
}

async function confirmAction(options: RegisterAgentOptions, title: string, message: string): Promise<RegistrationDecision> {
	if (!options.hasUI || !options.ui?.confirm) return "not-interactive";
	return await options.ui.confirm(title, message) ? "confirmed" : "cancelled";
}

function nonInteractiveMessage(command: "register" | "register-project" | "unregister"): string {
	return `Registration changes require interactive confirmation. Run in TUI mode: /agents ${command}${command === "register" ? " <name>" : command === "unregister" ? " <name>" : ""}`;
}

function projectBatchMessage(registered: RegisteredAgent[], blocked: RegistrationResult[], skipped: RegistrationResult[], cancelled: RegistrationResult[]): string {
	const lines = [`Project registration: ${registered.length} registered, ${blocked.length} blocked, ${skipped.length} skipped, ${cancelled.length} cancelled.`];
	for (const entry of registered) lines.push(`Registered ${entry.name}. Run: /agents run ${entry.name} <task>`);
	for (const item of blocked) lines.push(`Blocked: ${item.message}`);
	for (const item of skipped) lines.push(`Skipped: ${item.message}`);
	for (const item of cancelled) lines.push(`Cancelled: ${item.message}`);
	return lines.join("\n");
}

function batch(status: RegistrationResultStatus, message: string, registered: RegisteredAgent[], blocked: RegistrationResult[], skipped: RegistrationResult[], cancelled: RegistrationResult[]): RegistrationBatchResult {
	return { status, message, registered, blocked, skipped, cancelled };
}

function looksLikePath(input: string): boolean {
	return input.includes("/") || input.endsWith(".md") || input.startsWith(".") || path.isAbsolute(input);
}

async function sourceForPath(canonicalPath: string, diagnostics: AgentDiagnostics): Promise<MarkdownAgentSource | undefined> {
	if (isWithin(canonicalPath, await canonicalizePath(diagnostics.userAgentsDir))) return "user";
	if (isWithin(canonicalPath, await canonicalizePath(diagnostics.projectAgentsDir))) return "project";
	return undefined;
}

function isWithin(candidate: string, root: string): boolean {
	const relative = path.relative(path.resolve(root), candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
