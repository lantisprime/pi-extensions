// herdr-control: pi extension entry.
//
// Launch and coordinate subagents through herdr (https://herdr.dev) from
// inside pi. Follows the repo's cmux-control / tmux-control patterns and
// herdr's official automation best practices (herdr.dev/docs/agent-automation).
//
// Registers:
//   - 7 LLM tools: herdr_agents, herdr_spawn, herdr_prompt, herdr_read,
//                  herdr_send_keys, herdr_close, herdr_terminal
//   - 4 slash commands: /herdr-list, /herdr-spawn, /herdr-term, /herdr-config
//   - 1 input hook for high-confidence NL ("list herdr agents",
//     "herdr spawn <name> <task>")
//
// Safety model (see herdr-control/PLAN.md rev 2):
//   - refuses to act when pi is not running inside a herdr pane (HERDR_ENV)
//     or the herdr server is unreachable
//   - spawns default to a sibling pane (--no-focus, caller cwd preserved)
//   - never auto-answers blocked approval dialogs; herdr_send_keys always
//     confirms interactively
//   - herdr_close only closes panes recorded in the spawn registry (persisted
//     via pi.appendEntry so it survives /new, /resume, /fork, /reload)
//   - session_shutdown reports (never kills) still-running subagents
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_HERDR_PREFIX,
	DEFAULT_SPAWN_TIMEOUT_MS,
	HERDR_SHORT_TIMEOUT_MS,
	MAX_TRANSCRIPT_CHARS,
	PROMPT_MAX_TIMEOUT_MS,
	PROMPT_MIN_TIMEOUT_MS,
	SPAWN_REGISTRY_ENTRY_TYPE,
	HERDR_KINDS,
} from "./lib/constants.ts";
import { defaultHerdrExecutor, type HerdrExecutor } from "./lib/exec.ts";
import { ensureServer } from "./lib/gate.ts";
import { stringEnum, Type } from "./lib/string-enum.ts";
import { isValidAgentName, matchesPrefix, requirePaneRef, validateKeyTokens } from "./lib/safety.ts";
import { formatAgent, getAgent, listAgents, type HerdrAgentInfo } from "./lib/list.ts";
import { spawnAgent, type SpawnOutcome } from "./lib/launch.ts";
import { promptAgent } from "./lib/prompt.ts";
import { READ_SOURCES, readAgent } from "./lib/read.ts";
import { closePane } from "./lib/close.ts";
import { makeCloseEvent, makeSpawnEvent, SpawnRegistry, type SpawnRecord } from "./lib/registry.ts";
import { matchHerdrNlp } from "./lib/nlp.ts";
import { parseEnvelope } from "./lib/json.ts";
import { createTerminal, readPane, renamePane, runInPane } from "./lib/terminal.ts";

const TOOL_ERROR_STDERR_LEN = 1000;
const NOTIFY_TEXT_LEN = 1500;

// Session-scoped state (in-memory; registry events persisted to the session).
let currentPrefix = DEFAULT_HERDR_PREFIX;
const registry = new SpawnRegistry();

function truncate(s: string, n: number): string {
	if (s.length <= n) return s;
	return s.slice(0, n) + "...(truncated)";
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

function toolText(text: string, details: Record<string, unknown> = {}): ToolResult {
	return { content: [{ type: "text", text }], details };
}

// -- Shared helpers ---------------------------------------------------------

function persistEvent(pi: ExtensionAPI, event: ReturnType<typeof makeSpawnEvent> | ReturnType<typeof makeCloseEvent>): void {
	try {
		pi.appendEntry(SPAWN_REGISTRY_ENTRY_TYPE, event);
	} catch {
		// persistence is best-effort; in-memory registry still works
	}
}

async function ensureReady(executor: HerdrExecutor): Promise<void> {
	const inside = await ensureServer(executor);
	if (!inside.ok) throw new Error(inside.error);
}

function validateSpawnName(name: string): void {
	if (!isValidAgentName(name)) {
		throw new Error(`invalid agent name "${name}": must match [a-z][a-z0-9_-]{0,31}`);
	}
	if (!matchesPrefix(name, currentPrefix)) {
		throw new Error(`agent name must start with "${currentPrefix}" (change via /herdr-config prefix <value>)`);
	}
}

interface SpawnRunOptions {
	name: string;
	task: string;
	kind: string;
	cwd: string;
	direction: "right" | "down" | "auto";
	timeoutMs?: number;
	newWorkspace?: boolean;
}

function recordFromOutcome(outcome: Extract<SpawnOutcome, { ok: true }>, kind: string, cwd: string): SpawnRecord {
	return {
		name: outcome.name,
		paneId: outcome.paneId,
		workspaceId: outcome.workspaceId,
		tabId: outcome.tabId,
		kind,
		cwd,
	};
}

async function readForReport(
	executor: HerdrExecutor,
	target: string,
	source: (typeof READ_SOURCES)[number] = "recent-unwrapped",
): Promise<string> {
	const read = await readAgent(executor, target, { source });
	if (read.ok) {
		const note = read.truncated ? ` (tail kept, ${MAX_TRANSCRIPT_CHARS} char budget)` : "";
		return `--- transcript (${source}${note}) ---\n${read.text.trim()}\n--- end transcript ---`;
	}
	return `--- transcript unavailable: ${read.error} ---`;
}

// Full spawn pipeline shared by the tool, the command, and the input hook.
// Hard failures throw (isError: true); policy outcomes (blocked, stalled,
// timeout, orphaned pane) return normally with status in text + details.
async function runSpawn(
	pi: ExtensionAPI,
	executor: HerdrExecutor,
	opts: SpawnRunOptions,
	onUpdate?: (update: ToolResult) => void,
	signal?: AbortSignal,
): Promise<ToolResult> {
	await ensureReady(executor);
	validateSpawnName(opts.name);

	const report = (text: string, details: Record<string, unknown>): ToolResult => toolText(text, details);
	const checkAbort = (): void => {
		if (signal?.aborted) throw new Error("cancelled");
	};

	onUpdate?.(report(`creating ${opts.newWorkspace ? "workspace" : "sibling pane"} for "${opts.name}"...`, { stage: "layout" }));
	const outcome = await spawnAgent(executor, {
		name: opts.name,
		kind: opts.kind as typeof HERDR_KINDS[number],
		cwd: opts.cwd,
		direction: opts.direction,
		newWorkspace: opts.newWorkspace ?? false,
	});
	checkAbort();

	if (!outcome.ok) {
		if (outcome.stage === "collision" || outcome.stage === "layout") {
			throw new Error(`herdr_spawn failed at ${outcome.stage}: ${outcome.error}`);
		}
		// start/not-ready: the pane exists but no working agent. Record it as an
		// orphan so herdr_close can clean it up; never leak it silently.
		const orphan: SpawnRecord = {
			name: opts.name,
			paneId: outcome.paneId ?? "",
			kind: opts.kind,
			cwd: opts.cwd,
			orphan: true,
			createdAt: Date.now(),
		};
		if (orphan.paneId) {
			registry.spawn(orphan);
			persistEvent(pi, makeSpawnEvent(orphan));
		}
		return report(
			`herdr_spawn failed at ${outcome.stage}: ${outcome.error}\n` +
			(orphan.paneId ? `Shell pane ${orphan.paneId} was left behind and recorded; close it with herdr_close (agent "${opts.name}") or reuse it manually.` : ""),
			{ ok: false, stage: outcome.stage, orphanPaneId: orphan.paneId },
		);
	}

	const record = recordFromOutcome(outcome, opts.kind, opts.cwd);
	registry.spawn(record);
	persistEvent(pi, makeSpawnEvent(record));

	onUpdate?.(report(`subagent "${opts.name}" ready in ${outcome.paneId} (${outcome.status}); submitting task...`, { stage: "prompt", paneId: outcome.paneId }));
	const prompt = await promptAgent(executor, opts.name, opts.task, opts.timeoutMs);
	checkAbort();

	const base = { name: opts.name, paneId: outcome.paneId, kind: opts.kind, cwd: opts.cwd };

	if (prompt.ok) {
		const transcript = await readForReport(executor, opts.name);
		return report(
			`Spawned ${opts.kind} subagent "${opts.name}" in pane ${outcome.paneId} (cwd ${opts.cwd}).\n` +
			`Task delivered; agent settled with status: ${prompt.status}.\n${transcript}`,
			{ ...base, ok: true, status: prompt.status },
		);
	}

	if (prompt.kind === "blocked") {
		const transcript = await readForReport(executor, opts.name, "visible");
		return report(
			`Subagent "${opts.name}" (${outcome.paneId}) is BLOCKED at an approval/question dialog; herdr did NOT deliver the prompt.\n` +
			`Inspect the transcript below. If the user approves, respond deliberately with herdr_send_keys (e.g. "esc" or "enter") — never auto-answer.\n${transcript}`,
			{ ...base, ok: false, status: "blocked" },
		);
	}

	const detail = await getAgent(executor, opts.name);
	const status = detail.ok ? detail.agent.agent_status ?? "unknown" : "unknown";
	const transcript = await readForReport(executor, opts.name);

	if (prompt.kind === "stalled") {
		return report(
			`Prompt to "${opts.name}" produced no observed state change within 5s (agent_prompt_stalled). ` +
			`Current status: ${status}. Do not blind-retry: inspect the transcript and re-prompt deliberately with herdr_prompt if appropriate.\n${transcript}`,
			{ ...base, ok: false, status, kind: "stalled" },
		);
	}
	if (prompt.kind === "timeout") {
		return report(
			`Timed out waiting for "${opts.name}" to settle. Current status: ${status}. ` +
			`The agent may still be working — check herdr_agents, re-prompt with herdr_prompt, or wait and herdr_read again.\n${transcript}`,
			{ ...base, ok: false, status, kind: "timeout" },
		);
	}
	return report(
		`Prompt to "${opts.name}" failed (${prompt.kind}): ${prompt.error}. Current status: ${status}.\n${transcript}`,
		{ ...base, ok: false, status, kind: prompt.kind },
	);
}

// -- LLM tools --------------------------------------------------------------

function registerTools(pi: ExtensionAPI, executor: HerdrExecutor): void {
	pi.registerTool({
		name: "herdr_agents",
		label: "Herdr list agents",
		description:
			"List live herdr agents (name, kind, status, pane, cwd), or get detail for one agent. " +
			"Statuses: working, blocked, done, idle, unknown.",
		promptSnippet: "List live herdr agents or get one agent's detail",
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Optional agent name or pane id (e.g. w9:p2) for detail instead of listing all" })),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				await ensureReady(executor);
				if (params.agent) {
					const detail = await getAgent(executor, params.agent);
					if (!detail.ok) return toolText(`herdr agent get failed: ${detail.error}`, { ok: false });
					return toolText(formatAgent(detail.agent), { ok: true, agent: detail.agent });
				}
				const result = await listAgents(executor);
				if (!result.ok) return toolText(`herdr agent list failed: ${result.error}`, { ok: false });
				if (result.agents.length === 0) return toolText("(no live herdr agents)", { ok: true, count: 0 });
				return toolText(result.agents.map(formatAgent).join("\n"), { ok: true, count: result.agents.length, agents: result.agents });
			} catch (err) {
				return toolText(`herdr_agents failed: ${truncate(err instanceof Error ? err.message : String(err), TOOL_ERROR_STDERR_LEN)}`, { ok: false });
			}
		},
	});

	pi.registerTool({
		name: "herdr_spawn",
		label: "Herdr spawn subagent",
		description:
			"Launch a subagent in a herdr sibling pane and submit its task: pane split -> agent start -> " +
			"agent prompt --wait -> read transcript. Use for delegation that must run in a real terminal " +
			"and survive detach. Blocked approval dialogs are surfaced, never auto-answered.",
		promptSnippet: "Spawn a herdr subagent (pi/claude/codex/...) in a sibling pane and wait for its task to settle",
		promptGuidelines: [
			"Use herdr_spawn to delegate terminal-bound subagent work via herdr; agent names must start with the configured prefix (default pi-herdr-).",
		],
		parameters: Type.Object({
			name: Type.String({ description: `Agent name; must match [a-z][a-z0-9_-]{0,31} and start with "${currentPrefix}"` }),
			task: Type.String({ description: "Task prompt to submit to the subagent" }),
			kind: Type.Optional(stringEnum(HERDR_KINDS)),
			cwd: Type.Optional(Type.String({ description: "Working directory for the subagent (default: current cwd)" })),
			direction: Type.Optional(stringEnum(["right", "down", "auto"] as const)),
			timeout_ms: Type.Optional(Type.Integer({ description: `Prompt wait timeout in ms (${PROMPT_MIN_TIMEOUT_MS}..${PROMPT_MAX_TIMEOUT_MS}, default ${DEFAULT_SPAWN_TIMEOUT_MS})` })),
			new_workspace: Type.Optional(Type.Boolean({ description: "Create a separate workspace instead of a sibling pane (avoid unless needed)" })),
		}),
		async execute(_id, params, signal, onUpdate, _ctx) {
			try {
				return await runSpawn(
					pi,
					executor,
					{
						name: params.name,
						task: params.task,
						kind: params.kind ?? "pi",
						cwd: params.cwd ?? process.cwd(),
						direction: params.direction ?? "auto",
						timeoutMs: params.timeout_ms,
						newWorkspace: params.new_workspace,
					},
					onUpdate,
					signal,
				);
			} catch (err) {
				return toolText(`herdr_spawn failed: ${truncate(err instanceof Error ? err.message : String(err), TOOL_ERROR_STDERR_LEN)}`, { ok: false });
			}
		},
	});

	pi.registerTool({
		name: "herdr_prompt",
		label: "Herdr prompt agent",
		description:
			"Submit a follow-up prompt to a live herdr agent (one you spawned with herdr_spawn, or any agent) " +
			"and optionally wait for it to settle, then read its transcript.",
		promptSnippet: "Prompt a live herdr agent and wait for it to settle",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name or pane id (e.g. w9:p2)" }),
			task: Type.String({ description: "Prompt text to submit" }),
			wait: Type.Optional(Type.Boolean({ description: "Wait for settled idle/done/blocked state (default true)" })),
			timeout_ms: Type.Optional(Type.Integer({ description: `Wait timeout in ms (${PROMPT_MIN_TIMEOUT_MS}..${PROMPT_MAX_TIMEOUT_MS}, default 5 minutes)` })),
		}),
		async execute(_id, params, signal, onUpdate, _ctx) {
			try {
				await ensureReady(executor);
				const wait = params.wait !== false;
				onUpdate?.(toolText(wait ? "submitting prompt..." : "submitting prompt (no wait)...", { stage: "prompt" }));
				const prompt = await promptAgent(executor, params.agent, params.task, wait ? params.timeout_ms : undefined, wait);
				if (!wait) {
					const read = await readAgent(executor, params.agent);
					const transcript = read.ok ? read.text.trim() : `(transcript unavailable: ${read.error})`;
					return toolText(`Prompt delivered to ${params.agent} (no wait).\n${transcript}`, { ok: true, agent: params.agent, waited: false });
				}
				if (prompt.ok) {
					const transcript = await readForReport(executor, params.agent);
					return toolText(`Prompt settled; status: ${prompt.status}.\n${transcript}`, { ok: true, agent: params.agent, status: prompt.status });
				}
				const detail = await getAgent(executor, params.agent);
				const status = detail.ok ? detail.agent.agent_status ?? "unknown" : "unknown";
				const transcript = await readForReport(executor, params.agent);
				const hint = prompt.kind === "blocked"
					? "The agent is at an approval dialog; herdr did NOT deliver the prompt. Inspect and respond deliberately via herdr_send_keys."
					: "Inspect the transcript before retrying; do not blind-retry.";
				return toolText(`Prompt to ${params.agent} did not settle (${prompt.kind}): ${prompt.error}. Status: ${status}. ${hint}\n${transcript}`, { ok: false, agent: params.agent, status, kind: prompt.kind });
			} catch (err) {
				return toolText(`herdr_prompt failed: ${truncate(err instanceof Error ? err.message : String(err), TOOL_ERROR_STDERR_LEN)}`, { ok: false });
			}
		},
	});

	pi.registerTool({
		name: "herdr_read",
		label: "Herdr read agent output",
		description:
			"Read a herdr agent's terminal output, or a plain terminal pane's output. " +
			"Prefer source=recent-unwrapped for transcripts. Pane ids (w9:p2) and " +
			"terminals created via herdr_terminal are read via pane read.",
		promptSnippet: "Read a herdr agent's or terminal pane's output",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name or pane id" }),
			source: Type.Optional(stringEnum(READ_SOURCES)),
			lines: Type.Optional(Type.Integer({ description: "Lines to read (1..1000, default 200)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				await ensureReady(executor);
				const readOpts = { source: params.source, lines: params.lines };
				// Plain terminal panes — and any explicit pane id — go through
				// `pane read`, which also works without a recognized agent.
				const record = isPaneId(params.agent) ? registry.getByPane(params.agent) : registry.get(params.agent);
				if (isPaneId(params.agent) || record?.kind === "terminal") {
					const paneId = record?.paneId ?? params.agent;
					const pane = await readPane(executor, paneId, readOpts);
					if (!pane.ok) return toolText(`herdr read failed: ${pane.error}`, { ok: false });
					return toolText(pane.text, { ok: true, agent: params.agent, paneId, truncated: pane.truncated, paneRead: true });
				}
				const read = await readAgent(executor, params.agent, {
					source: params.source,
					lines: params.lines,
				});
				if (!read.ok) return toolText(`herdr read failed: ${read.error}`, { ok: false, kind: read.kind });
				return toolText(read.text, { ok: true, agent: params.agent, truncated: read.truncated });
			} catch (err) {
				return toolText(`herdr_read failed: ${truncate(err instanceof Error ? err.message : String(err), TOOL_ERROR_STDERR_LEN)}`, { ok: false });
			}
		},
	});

	pi.registerTool({
		name: "herdr_send_keys",
		label: "Herdr send keys",
		description:
			"Send logical keys (esc, enter, up, ctrl+c, ...) to a herdr agent's interactive UI. " +
			"Intended for rescuing BLOCKED agents from approval dialogs. Always asks the user for confirmation.",
		promptSnippet: "Send confirmation keys to a blocked herdr agent (user-confirmed)",
		promptGuidelines: [
			"Use herdr_send_keys only to resolve a blocked herdr agent after the user decides; never answer approval dialogs automatically.",
		],
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name or pane id" }),
			keys: Type.String({ description: "Whitespace-separated key names, e.g. \"esc\" or \"ctrl+c enter\" (max 8)" }),
			reason: Type.Optional(Type.String({ description: "Why these keys are being sent (shown in the confirmation dialog)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				await ensureReady(executor);
				const keys = validateKeyTokens(params.keys);
				if (!keys.ok) throw new Error(keys.error);
				if (!ctx.hasUI) throw new Error("refusing to send keys without interactive confirmation (no UI in this mode)");
				const confirmed = await ctx.ui.confirm(
					`Send keys to ${params.agent}?`,
					`Keys: ${keys.tokens.join(" ")}${params.reason ? `\nReason: ${params.reason}` : ""}`,
				);
				if (!confirmed) return toolText("User declined to send keys.", { ok: false, declined: true });
				const result = await executor.exec(["agent", "send-keys", params.agent, ...keys.tokens], { timeoutMs: HERDR_SHORT_TIMEOUT_MS });
				if (!result.ok) return toolText(`herdr send-keys failed: ${truncate(result.stderr, TOOL_ERROR_STDERR_LEN)}`, { ok: false });
				return toolText(`Sent ${keys.tokens.join(" ")} to ${params.agent}.`, { ok: true, agent: params.agent, keys: keys.tokens });
			} catch (err) {
				return toolText(`herdr_send_keys failed: ${truncate(err instanceof Error ? err.message : String(err), TOOL_ERROR_STDERR_LEN)}`, { ok: false });
			}
		},
	});

	pi.registerTool({
		name: "herdr_close",
		label: "Herdr close spawned pane",
		description:
			"Close a herdr pane created by herdr_spawn (kills its process). Only registry-recorded targets are " +
			"allowed; unregistered prefix-named agents require user confirmation; everything else is refused.",
		promptSnippet: "Close a herdr subagent pane this session spawned",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name or pane id recorded by herdr_spawn" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				await ensureReady(executor);
				let record = registry.get(params.agent);
				if (!record && isPaneId(params.agent)) record = registry.getByPane(params.agent);

				if (!record) {
					const prefixNamed = !isPaneId(params.agent) && matchesPrefix(params.agent, currentPrefix);
					if (!prefixNamed) {
						throw new Error(
							`refusing to close "${params.agent}": not recorded by this session's herdr_spawn ` +
							`(only herdr-spawned panes are closeable; close other panes manually in herdr)`,
						);
					}
					if (!ctx.hasUI) throw new Error(`"${params.agent}" is not in this session's registry and no UI is available to confirm`);
					const confirmed = await ctx.ui.confirm(
						"Close unregistered herdr agent?",
						`"${params.agent}" was not spawned by this session (or the session was replaced). Close its pane anyway?`,
					);
					if (!confirmed) return toolText("User declined to close.", { ok: false, declined: true });
					const ref = requirePaneRef(params.agent);
					const targetId = ref.ok ? ref.ref : params.agent;
					// Resolve a live agent name to its pane before closing.
					const detail = await getAgent(executor, targetId);
					const paneId = detail.ok ? detail.agent.pane_id : null;
					if (!paneId) return toolText(`Could not resolve "${params.agent}" to a live pane; nothing closed.`, { ok: false });
					const closed = await closePane(executor, paneId);
					if (!closed.ok) return toolText(`herdr close failed: ${closed.error}`, { ok: false });
					return toolText(`Closed ${paneId} ("${params.agent}", unregistered, user-confirmed).`, { ok: true, paneId });
				}

				const closed = await closePane(executor, record.paneId);
				if (!closed.ok) return toolText(`herdr close failed: ${closed.error}`, { ok: false });
				registry.apply(makeCloseEvent(record.name, record.paneId));
				persistEvent(pi, makeCloseEvent(record.name, record.paneId));
				return toolText(`Closed ${record.paneId} ("${record.name}").`, { ok: true, paneId: record.paneId, name: record.name });
			} catch (err) {
				return toolText(`herdr_close failed: ${truncate(err instanceof Error ? err.message : String(err), TOOL_ERROR_STDERR_LEN)}`, { ok: false });
			}
		},
	});

	pi.registerTool({
		name: "herdr_terminal",
		label: "Herdr open terminal",
		description:
			"Open a separate plain terminal (shell pane — no agent) in herdr: sibling split by default, " +
			"or a new tab/workspace on request. Optionally start a command in it and/or give it a sidebar label. " +
			"The pane is registry-tracked: close it later with herdr_close and read its output with herdr_read.",
		promptSnippet: "Open a separate shell terminal pane/tab in herdr (optionally run a command in it)",
		promptGuidelines: [
			"Use herdr_terminal for plain terminal work (dev servers, watches, shells) instead of herdr_spawn; herdr_spawn is for coding-agent subagents.",
		],
		parameters: Type.Object({
			cwd: Type.Optional(Type.String({ description: "Working directory for the terminal (default: current cwd)" })),
			direction: Type.Optional(stringEnum(["right", "down", "auto"] as const)),
			tab: Type.Optional(Type.Boolean({ description: "New tab in the current workspace instead of a sibling pane split" })),
			workspace: Type.Optional(Type.Boolean({ description: "Brand-new workspace instead of a split/tab (avoid unless needed)" })),
			command: Type.Optional(Type.String({ description: "Optional command to start in the new terminal (pane stays a shell; e.g. a dev server)" })),
			label: Type.Optional(Type.String({ description: "Optional sidebar label for the pane/tab/workspace" })),
		}),
		async execute(_id, params, signal, onUpdate, _ctx) {
			try {
				return await runTerminal(pi, executor, params, onUpdate, signal);
			} catch (err) {
				return toolText(`herdr_terminal failed: ${truncate(err instanceof Error ? err.message : String(err), TOOL_ERROR_STDERR_LEN)}`, { ok: false });
			}
		},
	});
}

function isPaneId(raw: string): boolean {
	return /^w\d+:p\d+$/.test(raw);
}

// Next free registry name for a plain terminal (not a herdr agent name —
// just our registry key): pi-herdr-term-1, -2, ...
function nextTerminalName(): string {
	let n = 1;
	while (registry.get(`pi-herdr-term-${n}`)) n += 1;
	return `pi-herdr-term-${n}`;
}

// Shared terminal-opening pipeline (tool + command). Hard failures throw;
// per-step rename/run failures are reported in the result text instead.
async function runTerminal(
	pi: ExtensionAPI,
	executor: HerdrExecutor,
	opts: { cwd?: string; direction?: "right" | "down" | "auto"; tab?: boolean; workspace?: boolean; command?: string; label?: string },
	onUpdate?: (update: ToolResult) => void,
	signal?: AbortSignal,
): Promise<ToolResult> {
	await ensureReady(executor);
	if (opts.tab && opts.workspace) throw new Error("tab and workspace are mutually exclusive");
	onUpdate?.(toolText("creating terminal...", { stage: "layout" }));
	const created = await createTerminal(executor, {
		cwd: opts.cwd ?? process.cwd(),
		direction: opts.direction ?? "auto",
		newTab: opts.tab,
		newWorkspace: opts.workspace,
		label: opts.label,
	});
	if (!created.ok) throw new Error(created.error);
	if (signal?.aborted) throw new Error("cancelled");

	const name = nextTerminalName();
	const record: SpawnRecord = {
		name,
		paneId: created.paneId,
		workspaceId: created.workspaceId,
		tabId: created.tabId,
		kind: "terminal",
		cwd: opts.cwd ?? process.cwd(),
		createdAt: Date.now(),
	};
	registry.spawn(record);
	persistEvent(pi, makeSpawnEvent(record));

	let renameNote = "";
	if (opts.label) {
		const renamed = await renamePane(executor, created.paneId, opts.label);
		renameNote = renamed.ok ? ` Labeled "${opts.label}".` : ` (label failed: ${renamed.error})`;
	}

	let runNote = "";
	if (opts.command) {
		onUpdate?.(toolText(`starting command in ${created.paneId}...`, { stage: "run" }));
		const ran = await runInPane(executor, created.paneId, opts.command);
		runNote = ran.ok
			? ` Command started: ${opts.command}`
			: ` Command failed to start: ${ran.error}`;
	}

	return toolText(
		`Opened terminal ${created.paneId}${created.tabId ? ` (tab ${created.tabId})` : ""}${created.workspaceId ? ` in workspace ${created.workspaceId}` : ""}, cwd ${record.cwd}.${renameNote}${runNote}\n` +
		`Registry name: ${name}. Read output: herdr_read(agent: "${name}"). Close: herdr_close(agent: "${name}").`,
		{ ok: true, name, paneId: created.paneId, workspaceId: created.workspaceId, tabId: created.tabId, kind: "terminal" },
	);
}

// -- Slash commands ---------------------------------------------------------

function parseSpawnArgs(args: string): SpawnRunOptions | { error: string } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { error: "usage: /herdr-spawn <name> [--kind k] [--cwd p] [--dir right|down] [--timeout ms] [--workspace] <task...>" };
	const name = tokens.shift()!;
	const opts: SpawnRunOptions = { name, task: "", kind: "pi", cwd: process.cwd(), direction: "auto" };
	const task: string[] = [];
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token === "--kind" && tokens[i + 1]) { opts.kind = tokens[++i]; }
		else if (token === "--cwd" && tokens[i + 1]) { opts.cwd = tokens[++i]; }
		else if (token === "--dir" && tokens[i + 1]) { opts.direction = tokens[++i] as SpawnRunOptions["direction"]; }
		else if (token === "--timeout" && tokens[i + 1]) { opts.timeoutMs = Number.parseInt(tokens[++i], 10); }
		else if (token === "--workspace") { opts.newWorkspace = true; }
		else { task.push(token); }
	}
	opts.task = task.join(" ").trim();
	if (!opts.task) return { error: "no task given; usage: /herdr-spawn <name> [flags] <task...>" };
	return opts;
}

function registerCommands(pi: ExtensionAPI, executor: HerdrExecutor): void {
	pi.registerCommand("herdr-list", {
		description: "List live herdr agents (name, pane, status, cwd).",
		handler: async (_args, ctx) => {
			try {
				await ensureReady(executor);
				const result = await listAgents(executor);
				if (!result.ok) return ctx.ui.notify(`herdr-list failed: ${result.error}`, "warning");
				if (result.agents.length === 0) return ctx.ui.notify("(no live herdr agents)", "info");
				ctx.ui.notify(`herdr agents (${result.agents.length}):\n${result.agents.map(formatAgent).join("\n")}`, "info");
			} catch (err) {
				ctx.ui.notify(`herdr-list failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
			}
		},
	});

	pi.registerCommand("herdr-spawn", {
		description: "Spawn a herdr subagent and submit its task. /herdr-spawn <name> [--kind k] [--cwd p] [--dir right|down] [--timeout ms] [--workspace] <task...>",
		handler: async (args, ctx) => {
			const parsed = parseSpawnArgs(args);
			if ("error" in parsed) return ctx.ui.notify(parsed.error, "warning");
			try {
				const result = await runSpawn(pi, executor, parsed);
				ctx.ui.notify(truncate(result.content[0].text, NOTIFY_TEXT_LEN), result.details.ok ? "info" : "warning");
			} catch (err) {
				ctx.ui.notify(`herdr-spawn failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
			}
		},
	});

	pi.registerCommand("herdr-term", {
		description: "Open a separate plain terminal in herdr. /herdr-term [--cwd p] [--dir right|down] [--tab] [--workspace] [--label text] [command...]",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const opts: { cwd?: string; direction?: "right" | "down" | "auto"; tab?: boolean; workspace?: boolean; command?: string; label?: string } = {};
			const command: string[] = [];
			let labelParts: string[] | null = null;
			for (let i = 0; i < tokens.length; i += 1) {
				const token = tokens[i];
				if (token === "--cwd" && tokens[i + 1]) opts.cwd = tokens[++i];
				else if (token === "--dir" && tokens[i + 1]) opts.direction = tokens[++i] as "right" | "down" | "auto";
				else if (token === "--tab") opts.tab = true;
				else if (token === "--workspace") opts.workspace = true;
				else if (token === "--label") labelParts = [];
				else if (labelParts && !token.startsWith("--")) labelParts.push(token);
				else if (labelParts) { labelParts = null; command.push(token); }
				else command.push(token);
			}
			if (labelParts && labelParts.length > 0) opts.label = labelParts.join(" ");
			if (command.length > 0) opts.command = command.join(" ");
			try {
				const result = await runTerminal(pi, executor, opts);
				ctx.ui.notify(truncate(result.content[0].text, NOTIFY_TEXT_LEN), result.details.ok ? "info" : "warning");
			} catch (err) {
				ctx.ui.notify(`herdr-term failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
			}
		},
	});

	pi.registerCommand("herdr-config", {
		description: "Configure herdr-control. Currently: 'prefix <value>' (session-only).",
		handler: async (args, ctx) => {
			const match = args.trim().match(/^prefix\s+["']?(.+?)["']?\s*$/);
			if (!match) return ctx.ui.notify("Usage: /herdr-config prefix <value>  (empty value disables the prefix gate)", "info");
			currentPrefix = match[1];
			ctx.ui.notify(`herdr-control: prefix set to "${currentPrefix}" (session-only).`, "info");
		},
	});
}

// -- NL input hook ----------------------------------------------------------

function registerInputHook(pi: ExtensionAPI, executor: HerdrExecutor): void {
	pi.on("input", async (event, ctx) => {
		const match = matchHerdrNlp(event.text ?? "");
		if (!match || match.confidence < 0.8) return { action: "continue" };

		if (match.action === "list") {
			try {
				await ensureReady(executor);
				const result = await listAgents(executor);
				ctx.ui.notify(
					result.ok
						? (result.agents.length === 0 ? "(no live herdr agents)" : `herdr agents (${result.agents.length}):\n${result.agents.map(formatAgent).join("\n")}`)
						: `herdr agent list failed: ${result.error}`,
					result.ok ? "info" : "warning",
				);
			} catch (err) {
				ctx.ui.notify(`herdr list failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
			}
			return { action: "handled" };
		}

		// spawn: "herdr spawn <name> <task...>"
		const tokens = match.rest.trim().split(/\s+/);
		const name = tokens.shift()!;
		const task = tokens.join(" ").trim();
		if (!task) {
			ctx.ui.notify("usage: herdr spawn <name> <task...>", "warning");
			return { action: "handled" };
		}
		try {
			const result = await runSpawn(pi, executor, { name, task, kind: "pi", cwd: process.cwd(), direction: "auto" });
			ctx.ui.notify(truncate(result.content[0].text, NOTIFY_TEXT_LEN), result.details.ok ? "info" : "warning");
		} catch (err) {
			ctx.ui.notify(`herdr spawn failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
		}
		return { action: "handled" };
	});
}

// -- Session lifecycle ------------------------------------------------------

function registerLifecycle(pi: ExtensionAPI, executor: HerdrExecutor): void {
	pi.on("session_start", async (_event, ctx) => {
		try {
			// Rehydrate the registry from persisted events (survives /new,
			// /resume, /fork, /reload), then prune dead panes.
			const events: unknown[] = [];
			for (const entry of ctx.sessionManager.getEntries()) {
				const e = entry as { type?: string; customType?: string; data?: unknown };
				if (e.type === "custom" && e.customType === SPAWN_REGISTRY_ENTRY_TYPE) events.push(e.data);
			}
			registry.hydrate(events);

			const live = await listAgents(executor);
			const paneIds = new Set<string>();
			if (live.ok) {
				for (const agent of live.agents) if (agent.pane_id) paneIds.add(agent.pane_id);
				// Also fetch all panes (the registry may hold orphan shell panes
				// with no live agent bound).
				const panes = await executor.exec(["pane", "list"], { timeoutMs: 10_000 });
				if (panes.ok) {
					try {
						const parsed = parseEnvelope(panes.stdout);
						if (parsed.ok) {
							const record = parsed.envelope.result as { panes?: Array<{ pane_id?: string }> } | null;
							if (record && Array.isArray(record.panes)) {
								for (const pane of record.panes) if (typeof pane.pane_id === "string") paneIds.add(pane.pane_id);
							}
						}
					} catch {
						// pane list shape unknown — agent panes above still count
					}
				}
			}
			const pruned = registry.prune(paneIds);
			for (const record of pruned) persistEvent(pi, makeCloseEvent(record.name, record.paneId));
		} catch {
			// hydration is best-effort
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			const records = registry.list();
			if (records.length === 0) return;
			const live = await listAgents(executor);
			const names = new Set(live.ok ? live.agents.map((a) => a.agent) : []);
			const stillRunning = records.filter((r) => !r.orphan && r.kind !== "terminal" && names.has(r.name));
			const openTerminals = records.filter((r) => r.kind === "terminal");
			if (ctx.hasUI) {
				if (stillRunning.length > 0) {
					const lines = stillRunning.map((r) => `${r.name} (${r.paneId}, ${r.kind})`);
					ctx.ui.notify(`herdr subagents still running: ${lines.join(", ")}. They keep working after exit; close with /herdr-close or herdr itself.`, "warning");
				}
				if (openTerminals.length > 0) {
					const lines = openTerminals.map((r) => `${r.name} (${r.paneId})`);
					ctx.ui.notify(`herdr terminals still open: ${lines.join(", ")}. They keep running after exit; close with /herdr-close or herdr itself.`, "info");
				}
			}
		} catch {
			// best-effort
		}
	});
}

// -- Entry ------------------------------------------------------------------

export default function herdrControlExtension(pi: ExtensionAPI): void {
	if (typeof pi?.on !== "function") return;
	if (typeof pi?.registerCommand !== "function") return;
	if (typeof pi?.registerTool !== "function") return;

	const executor = defaultHerdrExecutor();
	registerTools(pi, executor);
	registerCommands(pi, executor);
	registerInputHook(pi, executor);
	registerLifecycle(pi, executor);
}
