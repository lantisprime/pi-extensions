import { Buffer } from "node:buffer";

export type ChildToolCallSummary = {
	id: string;
	name: string;
	argsPreview: string;
	resultPreview?: string;
	isError?: boolean;
};

export type ChildJsonlTruncation = {
	stdoutBytesTruncated: boolean;
	jsonLineBytesTruncated: boolean;
	summaryCharsTruncated: boolean;
	toolArgsCharsTruncated: boolean;
	toolResultCharsTruncated: boolean;
	toolCallsTruncated: boolean;
};

export type ChildJsonlSummary = {
	session?: { id?: string; version?: number; timestamp?: string; cwd?: string };
	eventsSeen: number;
	malformedLines: number;
	toolCalls: ChildToolCallSummary[];
	summaryText: string;
	usage?: unknown;
	cost?: unknown;
	stopReason?: string;
	model?: string;
	provider?: string;
	truncation: ChildJsonlTruncation;
	errors: string[];
};

export type ChildJsonlReduceOptions = {
	maxStdoutBytes?: number;
	maxJsonLineBytes?: number;
	maxSummaryChars?: number;
	maxToolCalls?: number;
	maxToolArgsChars?: number;
	maxToolResultChars?: number;
};

const DEFAULT_OPTIONS: Required<ChildJsonlReduceOptions> = Object.freeze({
	maxStdoutBytes: 1_048_576,
	maxJsonLineBytes: 262_144,
	maxSummaryChars: 12_000,
	maxToolCalls: 50,
	maxToolArgsChars: 500,
	maxToolResultChars: 500,
});

export function reduceChildJsonl(stdout: string | readonly string[], options: ChildJsonlReduceOptions = {}): ChildJsonlSummary {
	const limits = validateReduceOptions({ ...DEFAULT_OPTIONS, ...options });
	const truncation: ChildJsonlTruncation = {
		stdoutBytesTruncated: false,
		jsonLineBytesTruncated: false,
		summaryCharsTruncated: false,
		toolArgsCharsTruncated: false,
		toolResultCharsTruncated: false,
		toolCallsTruncated: false,
	};
	const errors: string[] = [];
	const text = normalizeStdout(stdout);
	const boundedText = boundUtf8(text, limits.maxStdoutBytes);
	if (boundedText.truncated) truncation.stdoutBytesTruncated = true;

	let session: ChildJsonlSummary["session"];
	let eventsSeen = 0;
	let malformedLines = 0;
	let latestAssistantText = "";
	let streamingAssistantText = "";
	let usage: unknown;
	let cost: unknown;
	let stopReason: string | undefined;
	let model: string | undefined;
	let provider: string | undefined;
	const toolCalls: ChildToolCallSummary[] = [];
	const toolIndex = new Map<string, ChildToolCallSummary>();

	boundedText.value.split(/\r?\n/).forEach((line, index) => {
		if (!line.trim()) return;
		if (Buffer.byteLength(line, "utf8") > limits.maxJsonLineBytes) {
			truncation.jsonLineBytesTruncated = true;
			errors.push(`line ${index + 1} exceeds maxJsonLineBytes`);
			return;
		}
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			malformedLines += 1;
			errors.push(`line ${index + 1} is not valid JSON`);
			return;
		}
		if (!isRecord(event)) return;
		eventsSeen += 1;
		const type = stringField(event.type);
		if (type === "session") session = extractSession(event);
		if (type === "message_update") {
			const delta = textDelta(event.assistantMessageEvent);
			if (delta) streamingAssistantText = appendBounded(streamingAssistantText, delta, limits.maxSummaryChars * 2).value;
		}
		if (type === "message_end" || type === "turn_end") {
			const text = extractAssistantText(event.message);
			if (text) latestAssistantText = text;
		}
		if (type === "agent_end") {
			const text = extractLastAssistantText(event.messages);
			if (text) latestAssistantText = text;
		}
		if (type === "tool_execution_start") {
			const id = stringField(event.toolCallId) ?? `tool-${toolCalls.length + 1}`;
			const name = stringField(event.toolName) ?? "unknown";
			const args = preview(event.args, limits.maxToolArgsChars);
			if (args.truncated) truncation.toolArgsCharsTruncated = true;
			const summary: ChildToolCallSummary = { id, name, argsPreview: args.value };
			rememberTool(summary, toolCalls, toolIndex, limits, truncation);
		}
		if (type === "tool_execution_end") {
			const id = stringField(event.toolCallId) ?? `tool-${toolCalls.length + 1}`;
			let summary = toolIndex.get(id);
			if (!summary) {
				summary = { id, name: stringField(event.toolName) ?? "unknown", argsPreview: "" };
				rememberTool(summary, toolCalls, toolIndex, limits, truncation);
			}
			if (summary) {
				const result = preview(event.result, limits.maxToolResultChars);
				if (result.truncated) truncation.toolResultCharsTruncated = true;
				summary.resultPreview = result.value;
				summary.isError = Boolean(event.isError);
			}
		}
		const metadata = extractMetadata(event);
		usage ??= metadata.usage;
		cost ??= metadata.cost;
		stopReason ??= metadata.stopReason;
		model ??= metadata.model;
		provider ??= metadata.provider;
	});

	const summary = truncateChars(latestAssistantText || streamingAssistantText, limits.maxSummaryChars);
	if (summary.truncated) truncation.summaryCharsTruncated = true;
	return {
		...(session ? { session } : {}),
		eventsSeen,
		malformedLines,
		toolCalls,
		summaryText: summary.value,
		...(usage !== undefined ? { usage } : {}),
		...(cost !== undefined ? { cost } : {}),
		...(stopReason ? { stopReason } : {}),
		...(model ? { model } : {}),
		...(provider ? { provider } : {}),
		truncation,
		errors,
	};
}

export function parseChildJsonlLine(line: string): { ok: true; event: unknown } | { ok: false; error: string } {
	try {
		return { ok: true, event: JSON.parse(line) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : "invalid JSON" };
	}
}

function validateReduceOptions(options: Required<ChildJsonlReduceOptions>): Required<ChildJsonlReduceOptions> {
	for (const [key, value] of Object.entries(options)) {
		if (!Number.isInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
	}
	return options;
}

function rememberTool(summary: ChildToolCallSummary, toolCalls: ChildToolCallSummary[], toolIndex: Map<string, ChildToolCallSummary>, limits: Required<ChildJsonlReduceOptions>, truncation: ChildJsonlTruncation): void {
	if (!toolIndex.has(summary.id)) {
		if (toolCalls.length >= limits.maxToolCalls) {
			truncation.toolCallsTruncated = true;
			return;
		}
		toolCalls.push(summary);
		toolIndex.set(summary.id, summary);
	}
}

function normalizeStdout(stdout: string | readonly string[]): string {
	return Array.isArray(stdout) ? stdout.join("\n") : stdout;
}

function boundUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
	const bytes = Buffer.byteLength(value, "utf8");
	if (bytes <= maxBytes) return { value, truncated: false };
	return { value: Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8"), truncated: true };
}

function preview(value: unknown, maxChars: number): { value: string; truncated: boolean } {
	const text = typeof value === "string" ? value : stableJson(value);
	return truncateChars(text, maxChars);
}

function stableJson(value: unknown): string {
	try {
		return JSON.stringify(value, sortKeys);
	} catch {
		return String(value);
	}
}

function sortKeys(_key: string, value: unknown): unknown {
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
}

function truncateChars(value: string, maxChars: number): { value: string; truncated: boolean } {
	if (value.length <= maxChars) return { value, truncated: false };
	return { value: value.slice(0, Math.max(0, maxChars)), truncated: true };
}

function appendBounded(left: string, right: string, maxChars: number): { value: string; truncated: boolean } {
	return truncateChars(`${left}${right}`, maxChars);
}

function textDelta(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	if (value.type !== "text_delta") return undefined;
	return typeof value.delta === "string" ? value.delta : undefined;
}

function extractSession(event: Record<string, unknown>): ChildJsonlSummary["session"] {
	return {
		...(typeof event.id === "string" ? { id: event.id } : {}),
		...(typeof event.version === "number" ? { version: event.version } : {}),
		...(typeof event.timestamp === "string" ? { timestamp: event.timestamp } : {}),
		...(typeof event.cwd === "string" ? { cwd: event.cwd } : {}),
	};
}

function extractAssistantText(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "assistant") return undefined;
	return extractContentText(message.content);
}

function extractLastAssistantText(messages: unknown): string | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const text = extractAssistantText(messages[index]);
		if (text) return text;
	}
	return undefined;
}

function extractContentText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part === "string") {
			parts.push(part);
			continue;
		}
		if (!isRecord(part)) continue;
		const type = stringField(part.type);
		if (type && type.includes("thinking")) continue;
		if (type === "text" && typeof part.text === "string") parts.push(part.text);
		else if (!type && typeof part.text === "string") parts.push(part.text);
	}
	return parts.length > 0 ? parts.join("") : undefined;
}

function extractMetadata(event: Record<string, unknown>): { usage?: unknown; cost?: unknown; stopReason?: string; model?: string; provider?: string } {
	const message = isRecord(event.message) ? event.message : undefined;
	return {
		usage: event.usage ?? message?.usage ?? message?.tokenUsage,
		cost: event.cost ?? event.costUsd ?? event.costUSD ?? message?.cost ?? message?.costUsd ?? message?.costUSD,
		stopReason: stringField(event.stopReason) ?? stringField(event.stop_reason) ?? stringField(event.finishReason) ?? stringField(event.finish_reason) ?? stringField(message?.stopReason) ?? stringField(message?.stop_reason) ?? stringField(message?.finishReason) ?? stringField(message?.finish_reason),
		model: stringField(event.model) ?? stringField(message?.model),
		provider: stringField(event.provider) ?? stringField(message?.provider),
	};
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
