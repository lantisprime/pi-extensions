// P3d-2 chain-runner: parse, preflight, and execute /agents chain commands.

import { parseAgentMarkdownFile } from "./agent-markdown.ts";
import { canRunAgent } from "./can-run-agent.ts";
import { runBuiltInChildAgent, runChildAgent, type ChildAgentRunResult, type ChildAgentRunner } from "./child-runner.ts";
import {
	type AgentDiagnostics,
} from "./diagnostics.ts";
import { buildChildRunOptions, nextStepForRunBlock, resolveRegisteredRunTarget } from "./run-resolver.ts";
import { startBackgroundRun, type BgRunUI } from "./bg-run.ts";
import { isReservedBuiltInAgentName } from "./specs.ts";

export const MAX_CHAIN_LENGTH = 3;
export const MAX_ACCUMULATED_HANDOFF_CHARS = 24_000;

// --- Types ---

export type ParsedChainArgs =
	| { ok: true; agents: string[]; task: string }
	| { ok: false; message: string };

export type ResolvedChainAgent = {
	name: string;
	source: "built-in" | "user" | "project";
	spec: import("./specs.ts").AgentSpec;
};

export type ChainPreflightResult =
	| { ok: true; resolved: ResolvedChainAgent[] }
	| { ok: false; agentName: string; code: string; message: string; nextStep?: string };

export type ChainStepResult = {
	agentName: string;
	status: string;
	summaryText: string;
	durationMs: number;
};

export type ChainRunOutcome =
	| { ok: true; results: ChainStepResult[] }
	| { ok: false; agentName: string; code: string; message: string; nextStep?: string };

// --- Argument parsing ---

export function parseChainArgs(input: string): ParsedChainArgs {
	const trimmed = input.trim();
	if (!trimmed) return { ok: false, message: "Usage: /agents chain <agent>,<agent>[,<agent>] <task>" };

	const firstSpace = trimmed.search(/\s/);
	if (firstSpace < 0) return { ok: false, message: "Usage: /agents chain <agent>,<agent>[,<agent>] <task>" };

	const agentList = trimmed.slice(0, firstSpace);
	const task = trimmed.slice(firstSpace + 1).trim();
	if (!task) return { ok: false, message: "task must not be empty" };

	const agents = agentList.split(",").map((name) => name.trim()).filter(Boolean);
	if (agents.length < 2) return { ok: false, message: "Chain requires at least 2 comma-separated agent names. Use /agents run for single agent." };
	if (agents.length > MAX_CHAIN_LENGTH) return { ok: false, message: `Chain length capped at ${MAX_CHAIN_LENGTH} agents. Got ${agents.length}.` };

	for (const agent of agents) {
		if (/[\s\x00-\x1f\x7f"'`$]/.test(agent)) {
			return { ok: false, message: `agent name '${agent}' contains unsafe characters. Use [a-z][a-z0-9._-]* names.` };
		}
	}

	return { ok: true, agents, task };
}

// --- Preflight ---

export async function preflightChain(
	agents: string[],
	diagnostics: AgentDiagnostics,
): Promise<ChainPreflightResult> {
	const resolved: ResolvedChainAgent[] = [];

	for (const name of agents) {
		if (isReservedBuiltInAgentName(name)) {
			resolved.push({ name, source: "built-in", spec: name as unknown as import("./specs.ts").AgentSpec });
			continue;
		}

		const resolvedAgent = await resolveRegisteredRunTarget(name, diagnostics);
		if (!resolvedAgent.ok) {
			const code = resolvedAgent.message.includes("ambiguous") ? "ambiguous-name" : "agent-not-found";
			return { ok: false, agentName: name, code, message: resolvedAgent.message, nextStep: `/agents list` };
		}
		const record = resolvedAgent.record;

		let currentParsed: Awaited<ReturnType<typeof parseAgentMarkdownFile>>;
		try {
			currentParsed = await parseAgentMarkdownFile(record.filePath, { source: record.source });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, agentName: name, code: "missing-spec", message: `failed to re-read current spec bytes: ${message}`, nextStep: `/agents inspect ${name}` };
		}

		if (!currentParsed.spec || currentParsed.status === "invalid" || currentParsed.status === "dangerous" || currentParsed.status === "shadowed") {
			return { ok: false, agentName: name, code: currentParsed.status || "invalid", message: `current spec status=${currentParsed.status}`, nextStep: `/agents inspect ${name}` };
		}

		const gate = await canRunAgent(
			{ parsed: currentParsed, canonicalPath: record.canonicalPath },
			{
				projectTrusted: diagnostics.projectTrusted,
				projectRoot: diagnostics.projectRoot,
				userRegistry: diagnostics.userRegistry,
				projectRegistry: diagnostics.projectRegistry,
			},
		);

		if (!gate.ok) {
			return {
				ok: false,
				agentName: name,
				code: gate.code,
				message: gate.reason,
				nextStep: nextStepForRunBlock(record, gate.code),
			};
		}

		resolved.push({ name, source: record.source, spec: currentParsed.spec });
	}

	return { ok: true, resolved };
}

// --- Chain execution ---
//
// SECURITY: runChain() accepts only ResolvedChainAgent[] produced by preflightChain().
// Do NOT call runChain() with un-preflighted agent data. Only runChainCommand() should
// call runChain() in production. Exported for test coverage.
export function runChain(
	agents: ResolvedChainAgent[],
	task: string,
	ctx: {
		cwd?: string;
		agentsPiCommand?: string;
		agentsChildRunner?: ChildAgentRunner;
		explicitToolContextLoaderPath?: string;
		profileLibrary?: import("./profiles.ts").ModelProfileLibrary;
		/** P8-3 (N2): per-line progress sink, applied to every step's child run. */
		onProgress?: (line: string) => void;
	},
): Promise<ChainRunOutcome> {
	const childOptions = buildChildRunOptions(ctx);
	const stepOptions = ctx.onProgress ? { ...childOptions, onProgress: ctx.onProgress } : childOptions;
	const results: ChainStepResult[] = [];
	let accumulatedHandoff = "";

	return (async () => {
		for (let i = 0; i < agents.length; i++) {
			const agent = agents[i];

			let promptTask = task;
			if (accumulatedHandoff) {
				promptTask = `${task}\n\nPrior agent summaries:\n${accumulatedHandoff}`;
			}

			let result: ChildAgentRunResult;
			try {
				if (ctx.agentsChildRunner) {
					const childAgent = agent.source === "built-in" ? agent.name : agent.spec;
					result = await ctx.agentsChildRunner(childAgent, promptTask, stepOptions);
				} else if (agent.source === "built-in") {
					result = await runBuiltInChildAgent(agent.name, promptTask, stepOptions, ctx.profileLibrary);
				} else {
					result = await runChildAgent(agent.spec, promptTask, stepOptions, ctx.profileLibrary);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, agentName: agent.name, code: "spawn-error", message: `child execution failed: ${message}` };
			}

			const summaryText = result.summary.summaryText || "";
			results.push({
				agentName: agent.name,
				status: result.status,
				summaryText,
				durationMs: result.durationMs,
			});

			if (result.status !== "completed") {
				let code = "spawn-error";
				if (result.timedOut) code = "timeout";
				else if (result.outputLimitExceeded) code = "limit-exceeded";
				return {
					ok: false,
					agentName: agent.name,
					code,
					message: `agent '${agent.name}' failed with status ${result.status}`,
				};
			}

			// Accumulate handoff for next agent
			if (i < agents.length - 1 && summaryText) {
				const remaining = MAX_ACCUMULATED_HANDOFF_CHARS - Buffer.byteLength(accumulatedHandoff, "utf8");
				if (remaining > 0) {
					const truncated = Buffer.byteLength(summaryText, "utf8") > remaining
						? summaryText.slice(0, remaining) + "…"
						: summaryText;
					accumulatedHandoff = accumulatedHandoff ? `${accumulatedHandoff}\n\n${truncated}` : truncated;
				}
			}
		}

		return { ok: true, results };
	})();
}

// --- Chain command handler (only entry point that calls runChain) ---

export async function runChainCommand(
	input: string,
	ctx: {
		cwd?: string;
		agentsPiCommand?: string;
		agentsChildRunner?: ChildAgentRunner;
		explicitToolContextLoaderPath?: string;
		profileLibrary?: import("./profiles.ts").ModelProfileLibrary;
		hasUI?: boolean;
		ui: {
			notify(message: string, level?: "info" | "warning" | "error" | string): void;
			confirm?(title: string, message: string): Promise<boolean> | boolean;
			setWidget?(key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
		};
		deliverResult?: (content: string) => void;
	},
	diagnostics: AgentDiagnostics,
): Promise<void> {
	const parsed = parseChainArgs(input);
	if (!parsed.ok) {
		ctx.ui.notify(parsed.message, "warning");
		return;
	}

	// Preflight stays inline (blocking) — it must complete before any run; the chain run itself
	// is what backgrounds (N2). Preflight notifications fire before the background run starts.
	ctx.ui.notify(`Chain preflight: checking ${parsed.agents.length} agents...`, "info");
	const preflight = await preflightChain(parsed.agents, diagnostics);
	if (!preflight.ok) {
		const next = preflight.nextStep ? ` Next: ${preflight.nextStep}` : "";
		ctx.ui.notify(`Chain blocked: agent '${preflight.agentName}' (${preflight.code}): ${preflight.message}.${next}`, "warning");
		return;
	}

	ctx.ui.notify(`Chain preflight passed: ${preflight.resolved.map((a) => a.name).join(", ")}. Running ${parsed.agents[0]}...`, "info");

	// Map a chain outcome to a settle message+level (used by both the bg and sync paths).
	const settleFor = (outcome: ChainRunOutcome) => {
		if (outcome.ok) {
			const lines = [
				"Chain complete:",
				...outcome.results.map((r) =>
					`- ${r.agentName}: ${r.status} (${r.durationMs}ms) — ${r.summaryText.slice(0, 200)}${r.summaryText.length > 200 ? "…" : ""}`,
				),
			];
			return { message: lines.join("\n"), level: "info" as const };
		}
		return { message: `Chain failed at agent '${outcome.agentName}' (${outcome.code}): ${outcome.message}`, level: "warning" as const };
	};

	// P8-followup: on success, feed the per-step findings into pi's conversation (best-effort).
	const handleOutcome = (outcome: ChainRunOutcome) => {
		if (typeof ctx.deliverResult === "function") {
			const chainName = preflight.resolved.map((a) => a.name).join(" → ");
			const lines = outcome.ok
				? [
						`The agent chain (${chainName}) finished. Use its findings to help with my task.`,
						...outcome.results.map((r) => `\n[${r.agentName}] ${r.status}:\n${r.summaryText || "(no summary)"}`),
					]
				: [
						`The agent chain (${chainName}) FAILED at '${outcome.agentName}' (${outcome.code}). In plain language, explain what likely went wrong and recommend the single best next step.`,
						"",
						`Error: ${outcome.message}`,
					];
			try { ctx.deliverResult(lines.join("\n")); } catch { /* best-effort */ }
		}
		return settleFor(outcome);
	};

	if (ctx.hasUI && typeof ctx.ui.setWidget === "function") {
		startBackgroundRun({
			ui: ctx.ui as BgRunUI,
			label: `chain:${preflight.resolved.map((a) => a.name).join("→")}`,
			run: async (handle) => handleOutcome(await runChain(preflight.resolved, parsed.task, { ...ctx, onProgress: handle.onProgress })),
		});
		return;
	}

	const settle = handleOutcome(await runChain(preflight.resolved, parsed.task, ctx));
	ctx.ui.notify(settle.message, settle.level);
}
