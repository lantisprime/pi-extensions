// Shared run-resolution helpers extracted from index.ts so /agents run and run_subagent
// share the same gated path. P3d-1 Step 1: pure move with zero logic changes.

import { parseAgentMarkdownFile } from "./agent-markdown.ts";
import { canRunAgent } from "./can-run-agent.ts";
import {
	type AgentDiagnosticRecord,
	type AgentDiagnostics,
} from "./diagnostics.ts";
import { formatChildAgentRunResult, runBuiltInChildAgent, runChildAgent, type ChildAgentRunner } from "./child-runner.ts";
import { isReservedBuiltInAgentName } from "./specs.ts";
import type { ModelProfileLibrary } from "./profiles.ts";

export type AgentsContextLike = {
	cwd?: string;
	hasUI?: boolean;
	agentsHomeDir?: string;
	agentsPiCommand?: string;
	agentsChildRunner?: ChildAgentRunner;
	explicitToolContextLoaderPath?: string;
	profileLibrary?: ModelProfileLibrary;
	isProjectTrusted?: () => boolean;
	ui: {
		notify(message: string, level?: "info" | "warning" | "error" | string): void;
		confirm?(title: string, message: string): Promise<boolean> | boolean;
	};
};

export type RunnableRegisteredRecord = AgentDiagnosticRecord & {
	source: "user" | "project";
	spec: NonNullable<AgentDiagnosticRecord["spec"]>;
	canonicalPath: string;
	rawBytesSha256: string;
	filePath: string;
};

export const TOOL_CONTEXT_LOADER_PATH_ENV = "PI_AGENTS_TOOL_CONTEXT_LOADER_PATH";

export function resolveExplicitToolContextLoaderPath(ctx?: { explicitToolContextLoaderPath?: string }): string | undefined {
	return ctx?.explicitToolContextLoaderPath || process.env[TOOL_CONTEXT_LOADER_PATH_ENV];
}

export function buildChildRunOptions(ctx: { cwd?: string; agentsPiCommand?: string; explicitToolContextLoaderPath?: string }) {
	const explicitToolContextLoaderPath = resolveExplicitToolContextLoaderPath(ctx);
	return {
		cwd: ctx.cwd,
		piCommand: ctx.agentsPiCommand,
		...(explicitToolContextLoaderPath ? { explicitToolContextLoaderPath } : {}),
	};
}

export async function resolveRegisteredRunTarget(name: string, diagnostics: AgentDiagnostics): Promise<{ ok: true; record: RunnableRegisteredRecord } | { ok: false; message: string }> {
	const matches = diagnostics.records.filter((record) => record.source !== "built-in" && record.name === name);
	if (matches.length === 0) {
		const trustHint = diagnostics.projectTrusted ? "" : " If this is a project agent, activate project trust first.";
		return { ok: false, message: `No discovered registered user/project agent named '${name}'. Next: /agents list or /agents register <name>.${trustHint}` };
	}
	if (matches.length > 1) {
		return { ok: false, message: `Agent name '${name}' is ambiguous across discovered user/project specs. Rename one spec before running.` };
	}
	const record = matches[0];
	if (!record.spec || !record.canonicalPath || !record.rawBytesSha256 || !record.filePath || (record.source !== "user" && record.source !== "project")) {
		return { ok: false, message: `Agent '${name}' cannot run because its spec or trust material is missing. Next: /agents inspect ${name}` };
	}
	if (!record.runnable) {
		return { ok: false, message: `Agent '${name}' is not runnable: ${record.reason}. Next: ${record.nextStep || `/agents inspect ${name}`}` };
	}
	return { ok: true, record: record as RunnableRegisteredRecord };
}

export function nextStepForRunBlock(record: AgentDiagnosticRecord, code: string): string {
	if (record.nextStep) return record.nextStep;
	if (code === "project-untrusted") return "Activate project trust, then run /agents register-project";
	if (code === "project-registry-root-mismatch") return "Run /agents doctor";
	return `/agents inspect ${record.name}`;
}

export async function executeChildRun(agent: Parameters<ChildAgentRunner>[0], task: string, ctx: AgentsContextLike, source: string): Promise<void> {
	try {
		const childOptions = buildChildRunOptions(ctx);
		const profiles = ctx.profileLibrary;
		const result = ctx.agentsChildRunner
			? await ctx.agentsChildRunner(agent, task, childOptions)
			: typeof agent === "string"
				? await runBuiltInChildAgent(agent, task, childOptions, profiles)
				: await runChildAgent(agent, task, childOptions, profiles);
		ctx.ui.notify(formatChildAgentRunResult(result), result.status === "completed" ? "info" : "warning");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Agent run failed before ${source} child execution completed: ${message}`, "error");
	}
}

export async function runAgentCommand(input: string, ctx: AgentsContextLike, diagnostics: AgentDiagnostics): Promise<void> {
	const parsed = parseRunArgs(input);
	if (!parsed.ok) {
		ctx.ui.notify(parsed.message, "warning");
		return;
	}
	if (isReservedBuiltInAgentName(parsed.name)) {
		ctx.ui.notify(`Running built-in agent '${parsed.name}' with read-only tools.`, "info");
		await executeChildRun(parsed.name, parsed.task, ctx, "built-in");
		return;
	}

	const resolved = await resolveRegisteredRunTarget(parsed.name, diagnostics);
	if (!resolved.ok) {
		ctx.ui.notify(resolved.message, "warning");
		return;
	}
	const record = resolved.record;
	let currentParsed: Awaited<ReturnType<typeof parseAgentMarkdownFile>>;
	try {
		currentParsed = await parseAgentMarkdownFile(record.filePath, { source: record.source });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Agent '${parsed.name}' is not runnable: failed to re-read current spec bytes: ${message}. Next: /agents inspect ${parsed.name}`, "warning");
		return;
	}
	if (!currentParsed.spec || currentParsed.status === "invalid" || currentParsed.status === "dangerous" || currentParsed.status === "shadowed") {
		ctx.ui.notify(`Agent '${parsed.name}' is not runnable: current spec status=${currentParsed.status}. Next: /agents inspect ${parsed.name}`, "warning");
		return;
	}
	const gate = await canRunAgent(
		{ parsed: currentParsed, canonicalPath: record.canonicalPath },
		{ projectTrusted: diagnostics.projectTrusted, projectRoot: diagnostics.projectRoot, userRegistry: diagnostics.userRegistry, projectRegistry: diagnostics.projectRegistry, homeDir: ctx.agentsHomeDir },
	);
	if (!gate.ok) {
		ctx.ui.notify(`Agent '${parsed.name}' is not runnable: ${gate.reason}. Next: ${nextStepForRunBlock(record, gate.code)}`, "warning");
		return;
	}
	ctx.ui.notify(`Running registered ${record.source} agent '${currentParsed.spec.name}' with read-only tools.`, "info");
	await executeChildRun(currentParsed.spec, parsed.task, ctx, record.source);
}

export function parseRunArgs(input: string): { ok: true; name: string; task: string } | { ok: false; message: string } {
	const trimmed = input.trim();
	if (!trimmed) return { ok: false, message: "Usage: /agents run <agent> <task>" };
	const match = trimmed.match(/^(\S+)\s+([\s\S]+)$/);
	if (!match) return { ok: false, message: "Usage: /agents run <agent> <task>" };
	const name = match[1];
	const task = match[2].trim();
	if (!task) return { ok: false, message: "Usage: /agents run <agent> <task>" };
	return { ok: true, name, task };
}
