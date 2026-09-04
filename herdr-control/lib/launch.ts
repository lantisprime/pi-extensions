// herdr-control: subagent spawn pipeline.
//
// Best-practice sequence (herdr.dev/docs/agent-automation + SKILL.md):
//   1. name-collision pre-check via `agent list`
//   2. layout: `pane split --current --direction D --cwd C --no-focus`
//      (sibling pane default) or `workspace create` when explicitly requested
//   3. `agent start NAME --kind K --pane ID` — returns only once herdr
//      detects the agent and considers it ready; on agent_not_ready fall
//      back to a single `agent wait --until idle`
//   4. caller then submits work via prompt.ts
//
// herdr never reuses closed pane IDs, and layout commands print the IDs we
// must use next (.result.pane.pane_id / .result.root_pane.pane_id) — we parse
// them from the envelope, never predict them.
import type { HerdrExecutor } from "./exec.ts";
import {
	AGENT_START_MAX_TIMEOUT_MS,
	AGENT_START_MIN_TIMEOUT_MS,
	AGENT_START_TIMEOUT_MS,
	HERDR_SHORT_TIMEOUT_MS,
	type HerdrKind,
} from "./constants.ts";
import { errorCodeIs, extractError, parseEnvelope } from "./json.ts";
import { findByName, listAgents } from "./list.ts";

export type Direction = "right" | "down";

export interface SpawnRequest {
	name: string;
	kind: HerdrKind;
	cwd: string;
	direction: Direction | "auto";
	newWorkspace: boolean;
	startTimeoutMs?: number;
}

export type SpawnStage = "collision" | "layout" | "start" | "not-ready";

export type SpawnOutcome =
	| { ok: true; name: string; paneId: string; workspaceId?: string; tabId?: string; status: string }
	| { ok: false; stage: SpawnStage; error: string; paneId?: string };

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function pickString(record: unknown, path: string[]): string | undefined {
	let current: unknown = record;
	for (const key of path) {
		const rec = asRecord(current);
		if (!rec) return undefined;
		current = rec[key];
	}
	return typeof current === "string" ? current : undefined;
}

// Auto direction: split a wide pane right, a narrow/tall pane down. Caller
// pane geometry comes from `pane layout --current`; any failure defaults to
// "right" (the SKILL.md sibling default).
export async function resolveDirection(executor: HerdrExecutor): Promise<Direction> {
	try {
		const result = await executor.exec(["pane", "layout", "--current"], { timeoutMs: HERDR_SHORT_TIMEOUT_MS });
		if (!result.ok) return "right";
		const parsed = parseEnvelope(result.stdout);
		if (!parsed.ok) return "right";
		const record = asRecord(parsed.envelope.result);
		const layout = asRecord(record?.layout);
		const panes = Array.isArray(layout?.panes) ? layout!.panes : [];
		const caller = process.env.HERDR_PANE_ID;
		let chosen: unknown = panes[0];
		for (const pane of panes) {
			const rec = asRecord(pane);
			if (!rec) continue;
			if (rec.focused === true || (caller && rec.pane_id === caller)) chosen = pane;
		}
		const rect = asRecord(asRecord(chosen)?.rect);
		const width = typeof rect?.width === "number" ? rect.width : 0;
		const height = typeof rect?.height === "number" ? rect.height : 0;
		return width >= height ? "right" : "down";
	} catch {
		return "right";
	}
}

function clampStartTimeout(ms: number | undefined): number {
	if (ms === undefined || !Number.isFinite(ms)) return AGENT_START_TIMEOUT_MS;
	return Math.min(Math.max(Math.trunc(ms), AGENT_START_MIN_TIMEOUT_MS), AGENT_START_MAX_TIMEOUT_MS);
}

export type LayoutOutcome =
	| { ok: true; paneId: string; workspaceId?: string; tabId?: string }
	| { ok: false; error: string };

// Step 2: create the terminal location. Sibling pane via `pane split
// --current ... --no-focus` keeps the user's focus and cwd; new workspace
// only when explicitly requested. Returns parsed IDs — never predicted.
export async function createPane(
	executor: HerdrExecutor,
	req: SpawnRequest,
	direction: Direction,
): Promise<LayoutOutcome> {
	const args = req.newWorkspace
		? ["workspace", "create", "--cwd", req.cwd, "--label", req.name, "--no-focus"]
		: ["pane", "split", "--current", "--direction", direction, "--cwd", req.cwd, "--no-focus"];
	const result = await executor.exec(args, { timeoutMs: HERDR_SHORT_TIMEOUT_MS });
	if (!result.ok) {
		const err = extractError(result.stderr, result.exitCode);
		return { ok: false, error: `${args.join(" ")} failed: ${err.message}` };
	}
	const parsed = parseEnvelope(result.stdout);
	if (!parsed.ok) return { ok: false, error: parsed.error };

	const paneId = req.newWorkspace
		? pickString(parsed.envelope.result, ["root_pane", "pane_id"])
		: pickString(parsed.envelope.result, ["pane", "pane_id"]);
	if (!paneId) return { ok: false, error: "herdr layout response did not include a pane_id" };

	return {
		ok: true,
		paneId,
		workspaceId: pickString(parsed.envelope.result, ["workspace", "id"]) ?? process.env.HERDR_WORKSPACE_ID,
		tabId: req.newWorkspace ? pickString(parsed.envelope.result, ["tab", "id"]) : process.env.HERDR_TAB_ID,
	};
}

export type StartOutcome =
	| { ok: true; status: string }
	| { ok: false; stage: "start" | "not-ready"; error: string };

// Step 3: start the agent in the pane. `agent start` succeeds only once herdr
// detects the expected agent and considers it ready for input. If detection
// reports blocked during startup it fails fast with agent_not_ready while the
// name stays bound; we then wait once for idle before giving up.
export async function startAgent(executor: HerdrExecutor, req: SpawnRequest, paneId: string): Promise<StartOutcome> {
	const timeoutMs = clampStartTimeout(req.startTimeoutMs);
	const result = await executor.exec(
		["agent", "start", req.name, "--kind", req.kind, "--pane", paneId, "--timeout", String(timeoutMs)],
		{ timeoutMs: timeoutMs + 10_000 },
	);
	if (result.ok) {
		const parsed = parseEnvelope(result.stdout);
		const status = parsed.ok ? pickString(parsed.envelope.result, ["agent", "agent_status"]) : undefined;
		return { ok: true, status: status ?? "ready" };
	}

	const err = extractError(result.stderr, result.exitCode);
	if (errorCodeIs(err, "agent_not_ready")) {
		const wait = await executor.exec(
			["agent", "wait", req.name, "--until", "idle", "--timeout", String(timeoutMs)],
			{ timeoutMs: timeoutMs + 10_000 },
		);
		if (wait.ok) return { ok: true, status: "idle" };
		const waitErr = extractError(wait.stderr, wait.exitCode);
		return { ok: false, stage: "not-ready", error: `agent started but never became idle: ${waitErr.message}` };
	}
	return { ok: false, stage: "start", error: `agent start failed: ${err.message}` };
}

// Full pipeline. On start/not-ready failures the pane has already been
// created — the outcome carries `paneId` so the caller can record it as
// orphaned (cleanable via herdr_close) instead of leaking it silently.
export async function spawnAgent(executor: HerdrExecutor, req: SpawnRequest): Promise<SpawnOutcome> {
	const existing = await listAgents(executor);
	if (existing.ok && findByName(existing.agents, req.name)) {
		return { ok: false, stage: "collision", error: `agent name "${req.name}" is already live; pick another name or prompt the existing agent` };
	}

	const direction = req.direction === "auto" ? await resolveDirection(executor) : req.direction;
	const layout = await createPane(executor, req, direction);
	if (!layout.ok) return { ok: false, stage: "layout", error: layout.error };

	const start = await startAgent(executor, req, layout.paneId);
	if (!start.ok) {
		return { ok: false, stage: start.stage, error: start.error, paneId: layout.paneId };
	}
	return {
		ok: true,
		name: req.name,
		paneId: layout.paneId,
		workspaceId: layout.workspaceId,
		tabId: layout.tabId,
		status: start.status,
	};
}
