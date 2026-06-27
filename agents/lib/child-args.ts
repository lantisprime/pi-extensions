import { P3_FORBIDDEN_TOOLS, type AgentSpec } from "./specs.ts";
import { existsSync } from "node:fs";
import path from "node:path";

export type ChildPiArgsOptions = {
	piCommand?: string;
	systemPromptPath?: string;
	explicitToolContextLoaderPath?: string;
	disableContextFiles?: boolean;
	disableResourceDiscovery?: boolean;
	appendMethod?: string;
};

export type ChildPromptTransport = { kind: "stdin"; stdinText: string };

export type ChildPiInvocation = {
	command: string;
	argv: string[];
	promptTransport: ChildPromptTransport;
	systemPromptFile?: { path: string; fileText: string };
	argvPreview: string[];
};

const SAFE_CLI_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,127}$/;
const DEFAULT_PI_COMMAND = "pi";

export function buildChildPiArgs(spec: AgentSpec, task: string, options: ChildPiArgsOptions = {}): ChildPiInvocation {
	validateChildArgInputs(spec, task, options);
	const systemText = buildChildSystemText(spec) + (options.appendMethod ? `\n\nMethod:\n${options.appendMethod}` : "");
	const command = options.piCommand ?? DEFAULT_PI_COMMAND;
	const argv = ["--mode", "json", "--no-session"];
	if (options.disableResourceDiscovery !== false) argv.push("--no-approve", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes");
	if (options.disableContextFiles) argv.push("--no-context-files");
	if (spec.model) argv.push("--model", spec.model);
	if (spec.thinking) argv.push("--thinking", spec.thinking);
	if (options.explicitToolContextLoaderPath) argv.push("-e", options.explicitToolContextLoaderPath);
	argv.push("--tools", spec.tools.join(","));
	argv.push("--append-system-prompt", options.systemPromptPath!);
	argv.push("-p");
	const promptTransport = { kind: "stdin" as const, stdinText: task.trim() };
	const systemPromptFile = { path: options.systemPromptPath!, fileText: systemText };
	return { command, argv, promptTransport, systemPromptFile, argvPreview: redactChildPiArgv(argv) };
}

export function buildChildSystemText(spec: AgentSpec): string {
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
	].filter((line): line is string => line !== undefined).join("\n");
}

export function redactChildPiArgv(argv: readonly string[]): string[] {
	return argv.map((arg, i) => argv[i - 1] === "--append-system-prompt" ? "<system-prompt-file>" : arg);
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
	if (options.systemPromptPath !== undefined) {
		if (options.systemPromptPath.trim().length === 0) throw new Error("systemPromptPath is required when provided");
		if (hasUnsafePathControlChar(options.systemPromptPath)) throw new Error("systemPromptPath must not contain NUL or newline characters");
	}
}

function hasUnsafePathControlChar(value: string): boolean {
	return /[\0\r\n]/.test(value);
}

export function getPiInvocation(args: string[], piCommandOverride?: string, env?: { argv1?: string; execPath?: string }): { command: string; args: string[] } {
	if (piCommandOverride) return { command: piCommandOverride, args };
	const currentScript = env?.argv1 ?? process.argv[1];
	const execPath = env?.execPath ?? process.execPath;
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	// P5-fix: re-invoke the current script as pi only when its basename is "pi"
	// (the installed entrypoint — `which pi` resolves to .../bin/pi). The detached
	// bg-worker REACHES here with argv[1] = bg-worker.{ts,mjs,js} and relies on
	// this guard: without it the worker would re-run ITSELF as pi
	// (`node bg-worker.ts --mode json … -p`), read a flag as the manifest path,
	// and exit 1 — so the agent never runs. Any non-"pi" basename (the worker, a
	// test harness, any tool that calls the child runner) falls through to
	// DEFAULT_PI_COMMAND ("pi" on PATH). Tradeoff: a pi run from source as
	// `node <entry>.js` (basename ≠ "pi") with no `pi` on PATH would also fall
	// through and fail to spawn — accepted, because re-invoking argv[1] for the
	// worker/tools is the worse failure and an installed pi is always on PATH.
	const scriptBase = currentScript ? path.basename(currentScript).replace(/\.(c|m)?[jt]s$/i, "").toLowerCase() : "";
	if (currentScript && !isBunVirtualScript && scriptBase === "pi" && existsSync(currentScript)) return { command: execPath, args: [currentScript, ...args] };
	const execName = path.basename(execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: execPath, args };
	return { command: DEFAULT_PI_COMMAND, args };
}
