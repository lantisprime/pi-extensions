import { getBuiltInAgentSpec, isReservedBuiltInAgentName, isValidAgentName, type AgentSpec } from "./specs.ts";
import { canRunAgent } from "./can-run-agent.ts";
import { runChildAgent, formatChildAgentRunResult, type ChildAgentRunner } from "./child-runner.ts";
import { scanTextForAgentRisk, type RiskLevel } from "./security-scan.ts";
import { resolveExplicitToolContextLoaderPath } from "./run-resolver.ts";
import { startBackgroundRun, type BgRunUI } from "./bg-run.ts";
import path from "node:path";
import { promises as fs } from "node:fs";

/** Base roles supported by run-temp, drawing from built-in agent spec prompts. */
export const EPHEMERAL_BASE_ROLES = ["scout", "planner", "reviewer"] as const;
export type EphemeralBaseRole = (typeof EPHEMERAL_BASE_ROLES)[number];

/** Build an in-memory ephemeral AgentSpec cloned from a built-in base role. */
export function buildEphemeralSpec(baseRole: string): AgentSpec | undefined {
	const builtIn = getBuiltInAgentSpec(baseRole);
	if (!builtIn) return undefined;
	return { ...builtIn, name: "temp", source: "ephemeral" };
}

/** Parse /agents run-temp <base-role> <task> argv. */
export function parseEphemeralRunArgs(input: string): { ok: true; baseRole: EphemeralBaseRole; task: string } | { ok: false; message: string } {
	const trimmed = input.trim();
	if (!trimmed) return { ok: false, message: "Usage: /agents run-temp <scout|planner|reviewer> <task>" };
	const parts = trimmed.split(/\s+/);
	if (parts.length < 2) return { ok: false, message: "Usage: /agents run-temp <scout|planner|reviewer> <task>" };
	const role = parts[0];
	if (!(EPHEMERAL_BASE_ROLES as readonly string[]).includes(role)) {
		return { ok: false, message: `base-role must be one of: ${EPHEMERAL_BASE_ROLES.join(", ")}` };
	}
	const task = trimmed.slice(role.length).trim();
	if (!task) return { ok: false, message: "task must not be empty" };
	return { ok: true, baseRole: role as EphemeralBaseRole, task };
}

/** Parse /agents save-temp <name> argv. */
export function parseSaveTempArgs(input: string): { ok: true; name: string } | { ok: false; message: string } {
	const trimmed = input.trim();
	if (!trimmed) return { ok: false, message: "Usage: /agents save-temp <name>" };
	if (trimmed.split(/\s+/).length > 1) return { ok: false, message: "Usage: /agents save-temp <name>" };
	if (!isValidAgentName(trimmed)) return { ok: false, message: `name must match ^[a-z][a-z0-9_-]{0,63}$` };
	if (isReservedBuiltInAgentName(trimmed)) return { ok: false, message: `'${trimmed}' is a reserved built-in agent name` };
	return { ok: true, name: trimmed };
}

/** Render an ephemeral AgentSpec to Markdown with YAML frontmatter for save-temp. */
export function renderEphemeralSpecToMarkdown(spec: AgentSpec, name: string): string {
	const toolsYaml = `[${spec.tools.join(", ")}]`;
	const lines = ["---", `name: ${name}`, `description: ${spec.description}`, `tools: ${toolsYaml}`, "---", "", spec.prompt];
	return lines.join("\n");
}

export type EphemeralRunHandlerContext = {
	cwd?: string;
	hasUI?: boolean;
	agentsPiCommand?: string;
	agentsChildRunner?: ChildAgentRunner;
	explicitToolContextLoaderPath?: string;
	agentsLastEphemeralSpec?: { spec: AgentSpec; task: string };
	ui: {
		notify(message: string, level?: "info" | "warning" | "error" | string): void;
		confirm?(title: string, message: string): Promise<boolean> | boolean;
		setWidget?(key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
	};
};

export type EphemeralDiagnosticsLike = {
	projectTrusted: boolean;
	userAgentsDir: string;
};

function scanPromptForEphemeralRun(task: string): RiskLevel {
	return scanTextForAgentRisk(task, { source: "prompt" }).risk;
}

async function confirmSuspicious(
	scannerRisk: RiskLevel,
	ctx: EphemeralRunHandlerContext,
): Promise<{ suspiciousConfirmed: boolean; blocked: boolean }> {
	if (scannerRisk !== "suspicious") return { suspiciousConfirmed: false, blocked: false };
	if (!ctx.hasUI || !ctx.ui.confirm) {
		return { suspiciousConfirmed: false, blocked: true };
	}
	const confirmed = await ctx.ui.confirm("Run suspicious ephemeral agent?", `This task prompt is suspicious. Run anyway?`);
	return { suspiciousConfirmed: confirmed, blocked: !confirmed };
}

/** Full run-temp orchestrator: parse → build spec → scan → confirm → gate → stash → run.
 * Returns the stashed spec if the gate passed, undefined otherwise. */
export async function runEphemeralCommand(input: string, ctx: EphemeralRunHandlerContext): Promise<{ spec: AgentSpec; task: string } | undefined> {
	const args = parseEphemeralRunArgs(input);
	if (!args.ok) {
		ctx.ui.notify(args.message, "warning");
		return undefined;
	}
	const spec = buildEphemeralSpec(args.baseRole);
	if (!spec) {
		ctx.ui.notify(`Unknown base role '${args.baseRole}'. Use: ${EPHEMERAL_BASE_ROLES.join(", ")}`, "warning");
		return undefined;
	}
	const scannerRisk = scanPromptForEphemeralRun(args.task);
	const suspicious = await confirmSuspicious(scannerRisk, ctx);
	if (suspicious.blocked) {
		ctx.ui.notify("Ephemeral agent blocked: suspicious task requires interactive confirmation.", "warning");
		return undefined;
	}
	const gate = await canRunAgent(
		{ spec, scannerRisk, explicitUserRequest: true, suspiciousConfirmed: scannerRisk === "suspicious" ? suspicious.suspiciousConfirmed : undefined },
		{ projectTrusted: false },
	);
	if (!gate.ok) {
		ctx.ui.notify(`Ephemeral agent not runnable: ${gate.reason}`, "warning");
		return undefined;
	}
	const stashed = { spec, task: args.task };
	ctx.ui.notify(`Running ephemeral agent '${spec.name}' with base role '${args.baseRole}' and read-only tools.`, "info");
	// P8-3: run + format settle without notifying (so a background run can notify on completion).
	const runEphemeral = async (onProgress?: (line: string) => void) => {
		try {
			const explicitToolContextLoaderPath = resolveExplicitToolContextLoaderPath(ctx);
			const childOptions = {
				cwd: ctx.cwd,
				piCommand: ctx.agentsPiCommand,
				...(explicitToolContextLoaderPath ? { explicitToolContextLoaderPath } : {}),
				...(onProgress ? { onProgress } : {}),
			};
			const result = ctx.agentsChildRunner
				? await ctx.agentsChildRunner(spec, args.task, childOptions)
				: await runChildAgent(spec, args.task, childOptions);
			return { message: formatChildAgentRunResult(result), level: (result.status === "completed" ? "info" : "warning") as "info" | "warning" };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { message: `Ephemeral agent run failed: ${message}`, level: "error" as const };
		}
	};
	if (ctx.hasUI && typeof ctx.ui.setWidget === "function") {
		// Non-blocking: the stash is recorded immediately (below) so /agents save-temp still works.
		startBackgroundRun({ ui: ctx.ui as BgRunUI, label: `run-temp:${args.baseRole}`, run: (handle) => runEphemeral(handle.onProgress) });
	} else {
		const settle = await runEphemeral(undefined);
		ctx.ui.notify(settle.message, settle.level);
	}
	return stashed;
}

/** Full save-temp orchestrator: parse → require last spec → confirm → render → write. */
export async function saveTempCommand(
	input: string,
	ctx: EphemeralRunHandlerContext,
	diagnostics: EphemeralDiagnosticsLike,
): Promise<void> {
	const args = parseSaveTempArgs(input);
	if (!args.ok) {
		ctx.ui.notify(args.message, "warning");
		return;
	}
	if (!ctx.agentsLastEphemeralSpec) {
		ctx.ui.notify("No ephemeral agent to save. Run /agents run-temp first.", "warning");
		return;
	}
	if (!ctx.hasUI || !ctx.ui.confirm) {
		ctx.ui.notify("Save requires interactive confirmation. Run in TUI mode.", "warning");
		return;
	}
	const confirmed = await ctx.ui.confirm(
		"Save ephemeral agent?",
		`Save the most recent ephemeral agent as '${args.name}'?\n\nThis writes a Markdown spec file but does NOT register it. Run /agents register ${args.name} to enable execution.`,
	);
	if (!confirmed) {
		ctx.ui.notify(`Save cancelled for '${args.name}'.`, "info");
		return;
	}
	const filePath = path.join(diagnostics.userAgentsDir, `${args.name}.md`);
	await fs.mkdir(diagnostics.userAgentsDir, { recursive: true });
	const markdown = renderEphemeralSpecToMarkdown(ctx.agentsLastEphemeralSpec.spec, args.name);
	try {
		await fs.writeFile(filePath, markdown, { flag: "wx" });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if ((error as NodeJS.ErrnoException).code === "EEXIST" || message.includes("EEXIST") || message.includes("already exists") || message.includes("file already exists")) {
			ctx.ui.notify(`'${args.name}.md' already exists. Choose a different name or remove the existing file.`, "warning");
		} else {
			ctx.ui.notify(`Failed to save '${args.name}': ${message}`, "error");
		}
		return;
	}
	ctx.ui.notify(`Saved ${args.name}.md. Not registered — run /agents register ${args.name} to enable execution.`, "info");
}
