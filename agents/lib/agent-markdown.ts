import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
	DEFAULT_INPUT_CONTRACT,
	DEFAULT_LIMITS,
	DEFAULT_MAX_SUMMARY_CHARS,
	DEFAULT_OBSERVABILITY,
	DEFAULT_SAFETY,
	P3_FORBIDDEN_TOOLS,
	type AgentSource,
	type AgentSpec,
	type AgentValidationIssue,
	isReservedBuiltInAgentName,
	validateAgentSpec,
} from "./specs.ts";
import { scanTextForAgentRisk, type AgentRiskScanResult, type RiskLevel, type ScanProvenance } from "./security-scan.ts";

export const AGENT_MARKDOWN_ACCEPTED_KEYS = ["name", "description", "tools", "model", "thinking", "profile"] as const;
export const DEFAULT_AGENT_PARSER_LIMITS: AgentParserLimits = Object.freeze({
	maxFileBytes: 64 * 1024,
	maxFrontmatterBytes: 8 * 1024,
	maxPromptBytes: 32 * 1024,
});

export type MarkdownAgentSource = Extract<AgentSource, "user" | "project">;
export type UnknownFrontmatterKeyPolicy = "warn" | "reject";
export type MarkdownAgentStatus = "eligible" | "invalid" | "shadowed" | "dangerous";

export type AgentParserLimits = {
	maxFileBytes: number;
	maxFrontmatterBytes: number;
	maxPromptBytes: number;
};

export type AgentMarkdownParseOptions = {
	source: MarkdownAgentSource;
	filePath?: string;
	limits?: Partial<AgentParserLimits>;
	unknownKeyPolicy?: UnknownFrontmatterKeyPolicy;
};

export type AgentMarkdownFileScanOptions = Omit<AgentMarkdownParseOptions, "filePath">;

export type ParsedFrontmatter = {
	metadata: Record<string, unknown>;
	unknownKeys: string[];
	frontmatter: string;
	body: string;
	bodyStartOffset: number;
};

export type ParsedAgentMarkdown = {
	status: MarkdownAgentStatus;
	eligible: boolean;
	source: MarkdownAgentSource;
	filePath?: string;
	rawBytesSha256: string;
	metadata: Record<string, unknown>;
	prompt: string;
	spec?: AgentSpec;
	scannerRisk: RiskLevel;
	scan: AgentRiskScanResult;
	warnings: string[];
	issues: AgentValidationIssue[];
	unknownKeys: string[];
	shadowedReservedName: boolean;
};

export async function parseAgentMarkdownFile(filePath: string, options: AgentMarkdownFileScanOptions): Promise<ParsedAgentMarkdown> {
	const raw = await fs.readFile(filePath);
	return parseAgentMarkdown(raw, { ...options, filePath });
}

export async function scanAgentMarkdownDirectory(dir: string, options: AgentMarkdownFileScanOptions): Promise<ParsedAgentMarkdown[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return [];
		throw error;
	}
	const markdown = entries.filter((entry) => entry.endsWith(".md")).sort((a, b) => a.localeCompare(b));
	const results: ParsedAgentMarkdown[] = [];
	for (const entry of markdown) {
		const filePath = path.join(dir, entry);
		const stat = await fs.lstat(filePath);
		if (!stat.isFile()) continue;
		results.push(await parseAgentMarkdownFile(filePath, options));
	}
	return results;
}

export function parseAgentMarkdown(rawInput: string | Uint8Array, options: AgentMarkdownParseOptions): ParsedAgentMarkdown {
	const limits = normalizeLimits(options.limits);
	const rawBytes = toBytes(rawInput);
	const rawBytesSha256 = sha256Hex(rawBytes);
	const source = options.source;
	const baseResult = (overrides: Partial<ParsedAgentMarkdown>): ParsedAgentMarkdown => ({
		status: "invalid",
		eligible: false,
		source,
		filePath: options.filePath,
		rawBytesSha256,
		metadata: {},
		prompt: "",
		scannerRisk: "safe",
		scan: { risk: "safe", score: 0, findings: [] },
		warnings: [],
		issues: [],
		unknownKeys: [],
		shadowedReservedName: false,
		...overrides,
	});

	if (rawBytes.byteLength > limits.maxFileBytes) {
		return baseResult({ issues: [{ field: "file", code: "file-too-large", message: `agent spec file exceeds ${limits.maxFileBytes} bytes` }] });
	}

	const text = new TextDecoder("utf8", { fatal: false }).decode(rawBytes);
	const split = splitFrontmatter(text);
	if (!split.ok) {
		return baseResult({ issues: [{ field: "frontmatter", code: split.code, message: split.message }] });
	}

	const frontmatterBytes = byteLength(split.frontmatter);
	if (frontmatterBytes > limits.maxFrontmatterBytes) {
		return baseResult({ issues: [{ field: "frontmatter", code: "frontmatter-too-large", message: `agent spec frontmatter exceeds ${limits.maxFrontmatterBytes} bytes` }] });
	}

	const prompt = stripSingleLeadingNewline(split.body);
	const promptBytes = byteLength(prompt);
	if (promptBytes > limits.maxPromptBytes) {
		return baseResult({ issues: [{ field: "prompt", code: "prompt-too-large", message: `agent prompt exceeds ${limits.maxPromptBytes} bytes` }] });
	}

	const warnings: string[] = [];
	const issues: AgentValidationIssue[] = [];
	const frontmatter = parseFrontmatterBlock(split.frontmatter);
	for (const issue of frontmatter.issues) issues.push(issue);
	for (const key of frontmatter.unknownKeys) {
		const message = `unknown frontmatter key '${key}' ignored`;
		if ((options.unknownKeyPolicy ?? "warn") === "reject") issues.push({ field: key, code: "unknown-frontmatter-key", message });
		else warnings.push(message);
	}

	const metadata = frontmatter.metadata;
	const spec = buildSpecFromMetadata(metadata, prompt, source, issues);
	if (spec) {
		for (const issue of validateAgentSpec(spec).issues) issues.push(issue);
	}

	const scan = scanTextForAgentRisk(text, { source: "prompt", provenance: sourceToProvenance(source) });
	const shadowedReservedName = typeof metadata.name === "string" && isReservedBuiltInAgentName(metadata.name);
	if (shadowedReservedName) {
		warnings.push(`agent '${metadata.name}' is shadowed by a reserved built-in agent`);
	}
	if (scan.risk === "dangerous") {
		issues.push({ field: "prompt", code: "scanner-dangerous", message: "deterministic scanner classified this agent spec as dangerous" });
	}

	const status: MarkdownAgentStatus = scan.risk === "dangerous"
		? "dangerous"
		: issues.length > 0
			? "invalid"
			: shadowedReservedName
				? "shadowed"
				: "eligible";

	return baseResult({
		status,
		eligible: status === "eligible",
		metadata,
		prompt,
		spec,
		scannerRisk: scan.risk,
		scan,
		warnings,
		issues,
		unknownKeys: frontmatter.unknownKeys,
		shadowedReservedName,
	});
}

export function sha256Hex(input: string | Uint8Array): string {
	return createHash("sha256").update(toBytes(input)).digest("hex");
}

export function splitFrontmatter(text: string):
	| ({ ok: true } & ParsedFrontmatter)
	| { ok: false; code: string; message: string } {
	const firstLineEnd = text.indexOf("\n");
	if (firstLineEnd < 0 || text.slice(0, firstLineEnd).replace(/\r$/, "") !== "---") {
		return { ok: false, code: "frontmatter-missing", message: "agent Markdown spec must start with frontmatter delimiter '---'" };
	}

	let cursor = firstLineEnd + 1;
	while (cursor <= text.length) {
		const nextNewline = text.indexOf("\n", cursor);
		const lineEnd = nextNewline < 0 ? text.length : nextNewline;
		const line = text.slice(cursor, lineEnd).replace(/\r$/, "");
		if (line.trim() === "---") {
			return {
				ok: true,
				metadata: {},
				unknownKeys: [],
				frontmatter: text.slice(firstLineEnd + 1, cursor),
				body: nextNewline < 0 ? "" : text.slice(nextNewline + 1),
				bodyStartOffset: nextNewline < 0 ? lineEnd : nextNewline + 1,
			};
		}
		if (nextNewline < 0) break;
		cursor = nextNewline + 1;
	}

	return { ok: false, code: "frontmatter-unclosed", message: "agent Markdown frontmatter must end with delimiter '---' on its own line" };
}

export function parseFrontmatterBlock(frontmatter: string): { metadata: Record<string, unknown>; unknownKeys: string[]; issues: AgentValidationIssue[] } {
	const metadata: Record<string, unknown> = {};
	const unknownKeys: string[] = [];
	const issues: AgentValidationIssue[] = [];
	const accepted = new Set<string>(AGENT_MARKDOWN_ACCEPTED_KEYS);
	const seen = new Set<string>();
	const lines = frontmatter.split(/\r?\n/);

	lines.forEach((line, index) => {
		const lineNumber = index + 2;
		if (line.trim().length === 0 || line.trimStart().startsWith("#")) return;
		if (/^\s/.test(line)) {
			issues.push({ field: `frontmatter:${lineNumber}`, code: "frontmatter-nested-unsupported", message: "nested or indented frontmatter is not supported" });
			return;
		}
		const colon = line.indexOf(":");
		if (colon <= 0) {
			issues.push({ field: `frontmatter:${lineNumber}`, code: "frontmatter-line-invalid", message: "frontmatter lines must use 'key: value'" });
			return;
		}
		const key = line.slice(0, colon).trim();
		const rawValue = line.slice(colon + 1).trim();
		if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) {
			issues.push({ field: `frontmatter:${lineNumber}`, code: "frontmatter-key-invalid", message: `invalid frontmatter key '${key}'` });
			return;
		}
		if (seen.has(key)) {
			issues.push({ field: key, code: "frontmatter-key-duplicate", message: `duplicate frontmatter key '${key}'` });
			return;
		}
		seen.add(key);
		if (!accepted.has(key)) {
			unknownKeys.push(key);
			return;
		}
		metadata[key] = parseFrontmatterValue(rawValue);
	});

	return { metadata, unknownKeys, issues };
}

export function parseFrontmatterValue(rawValue: string): unknown {
	const value = rawValue.trim();
	if (value.startsWith("[") && value.endsWith("]")) {
		const inner = value.slice(1, -1).trim();
		if (!inner) return [];
		return inner.split(",").map((item) => stripQuotes(item.trim()));
	}
	return stripQuotes(value);
}

function buildSpecFromMetadata(metadata: Record<string, unknown>, prompt: string, source: MarkdownAgentSource, issues: AgentValidationIssue[]): AgentSpec | undefined {
	if (typeof metadata.name !== "string" || metadata.name.trim().length === 0) {
		issues.push({ field: "name", code: "name-required", message: "Markdown agent specs require a non-empty name" });
	}
	if (typeof metadata.description !== "string" || metadata.description.trim().length === 0) {
		issues.push({ field: "description", code: "description-required", message: "Markdown agent specs require a non-empty description" });
	}
	if (!Array.isArray(metadata.tools)) {
		issues.push({ field: "tools", code: "tools-required", message: "Markdown agent specs require tools: [read, ...]" });
	}
	if (metadata.model !== undefined && typeof metadata.model !== "string") {
		issues.push({ field: "model", code: "model-invalid", message: "model must be a string when provided" });
	}
	if (metadata.thinking !== undefined && typeof metadata.thinking !== "string") {
		issues.push({ field: "thinking", code: "thinking-invalid", message: "thinking must be a string when provided" });
	}
	if (metadata.profile !== undefined && typeof metadata.profile !== "string") {
		issues.push({ field: "profile", code: "profile-invalid", message: "profile must be a string when provided" });
	}
	if (issues.length > 0) return undefined;

	return {
		name: metadata.name as string,
		description: metadata.description as string,
		source,
		tools: metadata.tools as string[],
		...(metadata.model ? { model: metadata.model as string } : {}),
		...(metadata.thinking ? { thinking: metadata.thinking as AgentSpec["thinking"] } : {}),
		...(metadata.profile ? { profile: metadata.profile as string } : {}),
		prompt,
		inputContract: { ...DEFAULT_INPUT_CONTRACT },
		outputContract: {
			requiredSections: ["Summary"],
			maxSummaryChars: DEFAULT_MAX_SUMMARY_CHARS,
		},
		evals: [],
		limits: { ...DEFAULT_LIMITS },
		observability: { ...DEFAULT_OBSERVABILITY },
		safety: { ...DEFAULT_SAFETY, forbiddenTools: [...P3_FORBIDDEN_TOOLS] },
	};
}

function sourceToProvenance(source: MarkdownAgentSource): ScanProvenance {
	return source === "project" ? "project" : "global";
}

function normalizeLimits(limits: Partial<AgentParserLimits> | undefined): AgentParserLimits {
	return { ...DEFAULT_AGENT_PARSER_LIMITS, ...(limits ?? {}) };
}

function stripSingleLeadingNewline(value: string): string {
	return value.replace(/^\r?\n/, "");
}

function stripQuotes(value: string): string {
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		return value.slice(1, -1);
	}
	return value;
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function toBytes(input: string | Uint8Array): Uint8Array {
	return typeof input === "string" ? new TextEncoder().encode(input) : input;
}
