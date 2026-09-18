// herdr-control: agent list/get over the herdr CLI.
import type { HerdrExecutor } from "./exec.ts";
import { HERDR_SHORT_TIMEOUT_MS } from "./constants.ts";
import { extractError, parseEnvelope } from "./json.ts";

export interface HerdrAgentInfo {
	agent?: string;
	agent_status?: string;
	pane_id?: string;
	tab_id?: string;
	workspace_id?: string;
	cwd?: string;
	foreground_cwd?: string;
	terminal_title_stripped?: string;
	focused?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function agentFromUnknown(value: unknown): HerdrAgentInfo | null {
	const record = asRecord(value);
	if (!record) return null;
	const info: HerdrAgentInfo = {};
	if (typeof record.agent === "string") info.agent = record.agent;
	if (typeof record.agent_status === "string") info.agent_status = record.agent_status;
	if (typeof record.pane_id === "string") info.pane_id = record.pane_id;
	if (typeof record.tab_id === "string") info.tab_id = record.tab_id;
	if (typeof record.workspace_id === "string") info.workspace_id = record.workspace_id;
	if (typeof record.cwd === "string") info.cwd = record.cwd;
	if (typeof record.foreground_cwd === "string") info.foreground_cwd = record.foreground_cwd;
	if (typeof record.terminal_title_stripped === "string") info.terminal_title_stripped = record.terminal_title_stripped;
	if (typeof record.focused === "boolean") info.focused = record.focused;
	return info;
}

export function agentsFromResult(result: unknown): HerdrAgentInfo[] {
	const record = asRecord(result);
	const list = record && Array.isArray(record.agents) ? record.agents : [];
	const agents: HerdrAgentInfo[] = [];
	for (const item of list) {
		const agent = agentFromUnknown(item);
		if (agent) agents.push(agent);
	}
	return agents;
}

export function agentFromGetResult(result: unknown): HerdrAgentInfo | null {
	const record = asRecord(result);
	return record ? agentFromUnknown(record.agent) : null;
}

export function formatAgent(agent: HerdrAgentInfo): string {
	const name = agent.agent ?? "(unnamed)";
	const status = agent.agent_status ?? "?";
	const pane = agent.pane_id ?? "?";
	const cwd = agent.cwd ?? "";
	const marker = agent.focused ? " *" : "";
	return `${name}  ${pane}  ${status}  ${cwd}${marker}`;
}

export type AgentsResult =
	| { ok: true; agents: HerdrAgentInfo[] }
	| { ok: false; error: string };

export async function listAgents(executor: HerdrExecutor): Promise<AgentsResult> {
	const result = await executor.exec(["agent", "list"], { timeoutMs: HERDR_SHORT_TIMEOUT_MS });
	if (!result.ok) {
		const err = extractError(result.stderr, result.exitCode);
		return { ok: false, error: err.message };
	}
	const parsed = parseEnvelope(result.stdout);
	if (!parsed.ok) return { ok: false, error: parsed.error };
	return { ok: true, agents: agentsFromResult(parsed.envelope.result) };
}

export type AgentResult =
	| { ok: true; agent: HerdrAgentInfo }
	| { ok: false; error: string };

export async function getAgent(executor: HerdrExecutor, target: string): Promise<AgentResult> {
	const result = await executor.exec(["agent", "get", target], { timeoutMs: HERDR_SHORT_TIMEOUT_MS });
	if (!result.ok) {
		const err = extractError(result.stderr, result.exitCode);
		return { ok: false, error: err.message };
	}
	const parsed = parseEnvelope(result.stdout);
	if (!parsed.ok) return { ok: false, error: parsed.error };
	const agent = agentFromGetResult(parsed.envelope.result);
	if (!agent) return { ok: false, error: `herdr agent get returned no agent for ${target}` };
	return { ok: true, agent };
}

export function findByName(agents: HerdrAgentInfo[], name: string): HerdrAgentInfo | undefined {
	return agents.find((a) => a.agent === name);
}
