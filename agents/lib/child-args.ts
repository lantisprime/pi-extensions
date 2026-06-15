import { P3_FORBIDDEN_TOOLS, type AgentSpec } from "./specs.ts";

export type PromptTransportKind = "stdin" | "private-temp-file";

export type ChildPiArgsOptions = {
	piCommand?: string;
	promptTransport?: PromptTransportKind;
	tempPromptPath?: string;
	explicitToolContextLoaderPath?: string;
	disableContextFiles?: boolean;
};

export type ChildPromptTransport =
	| { kind: "stdin"; stdinText: string }
	| { kind: "private-temp-file"; path: string; fileText: string; cleanup: true };

export type ChildPiInvocation = {
	command: string;
	argv: string[];
	promptTransport: ChildPromptTransport;
	argvPreview: string[];
};

const SAFE_CLI_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,127}$/;
const DEFAULT_PI_COMMAND = "pi";

export function buildChildPiArgs(spec: AgentSpec, task: string, options: ChildPiArgsOptions = {}): ChildPiInvocation {
	validateChildArgInputs(spec, task, options);
	const promptText = buildChildPromptText(spec, task);
	const command = options.piCommand ?? DEFAULT_PI_COMMAND;
	const argv = ["--mode", "json", "--no-session"];
	if (options.disableContextFiles) argv.push("--no-context-files");
	if (spec.model) argv.push("--model", spec.model);
	if (spec.thinking) argv.push("--thinking", spec.thinking);
	if (options.explicitToolContextLoaderPath) argv.push("-e", options.explicitToolContextLoaderPath);
	argv.push("--tools", spec.tools.join(","));

	const promptTransport = buildPromptTransport(promptText, options);
	argv.push("-p");
	if (promptTransport.kind === "private-temp-file") argv.push(`@${promptTransport.path}`);
	return { command, argv, promptTransport, argvPreview: redactChildPiArgv(argv) };
}

export function buildChildPromptText(spec: AgentSpec, task: string): string {
	const trimmedTask = task.trim();
	return [
		`Agent: ${spec.name}`,
		`Source: ${spec.source}`,
		"",
		"Role prompt:",
		spec.prompt.trim(),
		"",
		"Allowed tools:",
		spec.tools.join(", "),
		"",
		"Output contract:",
		`Required sections: ${spec.outputContract.requiredSections.join(", ")}`,
		`Maximum summary characters: ${spec.outputContract.maxSummaryChars}`,
		spec.outputContract.verdicts ? `Allowed verdicts: ${spec.outputContract.verdicts.join(", ")}` : undefined,
		"",
		"Delegated task:",
		trimmedTask,
	].filter((line): line is string => line !== undefined).join("\n");
}

export function redactChildPiArgv(argv: readonly string[]): string[] {
	return argv.map((arg) => arg.startsWith("@") ? "@<prompt-file>" : arg);
}

function buildPromptTransport(promptText: string, options: ChildPiArgsOptions): ChildPromptTransport {
	const kind = options.promptTransport ?? "stdin";
	if (kind === "stdin") return { kind, stdinText: promptText };
	if (kind !== "private-temp-file") throw new Error(`unsupported promptTransport '${String(kind)}'`);
	if (!options.tempPromptPath || options.tempPromptPath.trim().length === 0) {
		throw new Error("tempPromptPath is required when promptTransport is private-temp-file");
	}
	if (hasUnsafePathControlChar(options.tempPromptPath)) throw new Error("tempPromptPath must not contain NUL or newline characters");
	return { kind, path: options.tempPromptPath, fileText: promptText, cleanup: true };
}

function validateChildArgInputs(spec: AgentSpec, task: string, options: ChildPiArgsOptions): void {
	if (!spec || typeof spec !== "object") throw new Error("agent spec is required");
	if (typeof spec.name !== "string" || spec.name.length === 0) throw new Error("agent spec name is required");
	if (typeof task !== "string" || task.trim().length === 0) throw new Error("task must be a non-empty string");
	const maxTaskChars = spec.inputContract?.maxTaskChars ?? spec.limits?.maxTaskChars;
	if (Number.isInteger(maxTaskChars) && task.length > maxTaskChars) throw new Error(`task exceeds maxTaskChars (${maxTaskChars})`);
	if (!Array.isArray(spec.tools) || spec.tools.length === 0) throw new Error("agent spec must include at least one tool");
	const forbidden = new Set(P3_FORBIDDEN_TOOLS);
	for (const tool of spec.tools) {
		if (typeof tool !== "string" || !SAFE_CLI_TOKEN_RE.test(tool)) throw new Error(`unsafe tool name '${String(tool)}'`);
		if (forbidden.has(tool)) throw new Error(`forbidden child tool '${tool}'`);
	}
	for (const [field, value] of [["model", spec.model], ["thinking", spec.thinking], ["piCommand", options.piCommand]] as const) {
		if (value !== undefined && (typeof value !== "string" || !SAFE_CLI_TOKEN_RE.test(value))) throw new Error(`${field} must be a safe argv token`);
	}
	if (options.explicitToolContextLoaderPath !== undefined) {
		if (options.explicitToolContextLoaderPath.trim().length === 0) throw new Error("explicitToolContextLoaderPath must be non-empty when provided");
		if (hasUnsafePathControlChar(options.explicitToolContextLoaderPath)) throw new Error("explicitToolContextLoaderPath must not contain NUL or newline characters");
	}
}

function hasUnsafePathControlChar(value: string): boolean {
	return /[\0\r\n]/.test(value);
}
