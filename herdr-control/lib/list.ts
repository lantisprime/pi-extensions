// herdr-control: agent list/get over the herdr CLI. Rows are validated
// against HerdrAgentSchema (lib/schema.ts) — the single source of truth for
// herdr's agent data structure.
import type { HerdrExecutor } from "./exec.ts";
import { HERDR_SHORT_TIMEOUT_MS } from "./constants.ts";
import { extractError, parseEnvelope } from "./json.ts";
import { schemaParse, AgentListResultSchema, AgentGetResultSchema, HerdrAgentSchema } from "./schema.ts";

export interface HerdrAgentInfo {
	agent?: string;
	/** Pane-assigned name (pi rows carry `name` instead of `agent`). */
	name?: string;
	agent_status?: string;
	pane_id?: string;
	tab_id?: string;
	workspace_id?: string;
	cwd?: string;
	foreground_cwd?: string;
	terminal_title_stripped?: string;
	focused?: boolean;
	/** herdr is not reading this pane's screen — its status is unreliable. */
	screen_detection_skipped?: boolean;
}

function agentFromUnknown(value: unknown): HerdrAgentInfo | null {
	const parsed = schemaParse<HerdrAgentInfo>(HerdrAgentSchema, value);
	return parsed.ok ? parsed.value : null;
}

/** Resolve an agent's lookup/display name from either row shape.
 * LIVE FINDING (herdr 0.9.3, path-sourced pi rows): `agent` holds the
 * detection KIND label ("pi"), `name` holds the pane-assigned label, and
 * NEITHER is necessarily a command-accepted target — target pane ids for
 * commands; use this only for matching against the name we spawned. */
export function agentRowName(agent: HerdrAgentInfo): string | undefined {
	return agent.name ?? agent.agent;
}

export function agentsFromResult(result: unknown): HerdrAgentInfo[] {
	const parsed = schemaParse<{ agents: unknown[] }>(AgentListResultSchema, result);
	if (!parsed.ok) return [];
	const agents: HerdrAgentInfo[] = [];
	for (const item of parsed.value.agents) {
		const agent = agentFromUnknown(item);
		if (agent) agents.push(agent);
	}
	return agents;
}

export function agentFromGetResult(result: unknown): HerdrAgentInfo | null {
	const parsed = schemaParse<{ agent: unknown }>(AgentGetResultSchema, result);
	return parsed.ok ? agentFromUnknown(parsed.value.agent) : null;
}

export function formatAgent(agent: HerdrAgentInfo): string {
	const name = agentRowName(agent) ?? "(unnamed)";
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
	return agents.find((a) => agentRowName(a) === name);
}
