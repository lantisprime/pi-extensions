// herdr-control: plain terminal panes (no agent).
//
// herdr separates the *pane* primitive (raw terminal) from the *agent*
// primitive (recognized coding agent). Terminals are sibling shell panes by
// default (SKILL.md layout rules: split wide→right, tall→down, --no-focus,
// caller cwd preserved); new tab or new workspace only on explicit request.
// An optional command can be started in the new terminal via `pane run`
// (atomic text+Enter; the pane stays a shell — the command runs in the
// foreground of that terminal).
//
// Terminals are recorded in the spawn registry (kind "terminal") so
// herdr_close can clean them up and herdr_read can read their output via
// `pane read` (which — unlike agent read — works on panes without agents).
import type { HerdrExecutor } from "./exec.ts";
import { HERDR_SHORT_TIMEOUT_MS } from "./constants.ts";
import type { Direction } from "./launch.ts";
import { resolveDirection } from "./launch.ts";
import { extractError, parseEnvelope } from "./json.ts";
import { requirePaneRef } from "./safety.ts";
import { keepTail } from "./read.ts";

export interface TerminalRequest {
	cwd: string;
	direction: Direction | "auto";
	/** new tab in the caller's workspace (default: sibling pane split) */
	newTab?: boolean;
	/** brand-new workspace (default: sibling pane split) */
	newWorkspace?: boolean;
	/** optional human label (pane rename / workspace+tab label) */
	label?: string;
	/** optional command to start in the new terminal (pane stays a shell) */
	command?: string;
}

export type TerminalOutcome =
	| { ok: true; paneId: string; workspaceId?: string; tabId?: string }
	| { ok: false; stage: "layout" | "rename" | "run"; error: string; paneId?: string };

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

// Layout: sibling split (default), tab create, or workspace create. IDs are
// parsed from the JSON responses, never predicted.
export async function createTerminal(executor: HerdrExecutor, req: TerminalRequest): Promise<TerminalOutcome> {
	const direction = req.direction === "auto" ? await resolveDirection(executor) : req.direction;

	let args: string[];
	if (req.newWorkspace) {
		args = ["workspace", "create", "--cwd", req.cwd, "--no-focus"];
		if (req.label) args.push("--label", req.label);
	} else if (req.newTab) {
		args = ["tab", "create", "--cwd", req.cwd, "--no-focus"];
		if (process.env.HERDR_WORKSPACE_ID) args.push("--workspace", process.env.HERDR_WORKSPACE_ID);
		if (req.label) args.push("--label", req.label);
	} else {
		args = ["pane", "split", "--current", "--direction", direction, "--cwd", req.cwd, "--no-focus"];
	}

	const result = await executor.exec(args, { timeoutMs: HERDR_SHORT_TIMEOUT_MS });
	if (!result.ok) {
		const err = extractError(result.stderr, result.exitCode);
		return { ok: false, stage: "layout", error: `${args.join(" ")} failed: ${err.message}` };
	}
	const parsed = parseEnvelope(result.stdout);
	if (!parsed.ok) return { ok: false, stage: "layout", error: parsed.error };

	const paneId = req.newWorkspace || req.newTab
		? pickString(parsed.envelope.result, ["root_pane", "pane_id"])
		: pickString(parsed.envelope.result, ["pane", "pane_id"]);
	if (!paneId) return { ok: false, stage: "layout", error: "herdr layout response did not include a pane_id" };

	const workspaceId = req.newWorkspace
		? pickString(parsed.envelope.result, ["workspace", "id"])
		: pickString(parsed.envelope.result, ["pane", "workspace_id"]) ?? process.env.HERDR_WORKSPACE_ID;
	const tabId = req.newWorkspace || req.newTab
		? pickString(parsed.envelope.result, ["tab", "id"])
		: pickString(parsed.envelope.result, ["pane", "tab_id"]) ?? process.env.HERDR_TAB_ID;

	return { ok: true, paneId, workspaceId, tabId };
}

// Rename the pane so the herdr sidebar shows a meaningful title.
export async function renamePane(executor: HerdrExecutor, paneId: string, label: string): Promise<TerminalOutcome> {
	const ref = requirePaneRef(paneId);
	if (!ref.ok) return { ok: false, stage: "rename", error: ref.error };
	const result = await executor.exec(["pane", "rename", ref.ref, label], { timeoutMs: HERDR_SHORT_TIMEOUT_MS });
	if (!result.ok) {
		const err = extractError(result.stderr, result.exitCode);
		return { ok: false, stage: "rename", error: err.message, paneId };
	}
	return { ok: true, paneId };
}

// Start a command in the terminal (foreground of that pane's shell).
export async function runInPane(executor: HerdrExecutor, paneId: string, command: string): Promise<TerminalOutcome> {
	const ref = requirePaneRef(paneId);
	if (!ref.ok) return { ok: false, stage: "run", error: ref.error };
	if (!command.trim()) return { ok: false, stage: "run", error: "empty command" };
	// Single argv token: preserves quoting; herdr joins COMMAND... with spaces.
	const result = await executor.exec(["pane", "run", ref.ref, command.trim()], { timeoutMs: HERDR_SHORT_TIMEOUT_MS });
	if (!result.ok) {
		const err = extractError(result.stderr, result.exitCode);
		return { ok: false, stage: "run", error: err.message, paneId };
	}
	return { ok: true, paneId };
}

// Read terminal output. pane read prints PLAIN TEXT (not an envelope) and —
// unlike agent read — also works on panes with no recognized agent.
export type PaneReadOutcome =
	| { ok: true; text: string; truncated: boolean }
	| { ok: false; error: string };

export async function readPane(
	executor: HerdrExecutor,
	paneId: string,
	opts: { source?: string; lines?: number } = {},
): Promise<PaneReadOutcome> {
	const ref = requirePaneRef(paneId);
	if (!ref.ok) return { ok: false, error: ref.error };
	const source = opts.source ?? "recent-unwrapped";
	const lines = opts.lines ?? 200;
	const result = await executor.exec(
		["pane", "read", ref.ref, "--source", source, "--lines", String(lines)],
		{ timeoutMs: 30_000 },
	);
	if (!result.ok) {
		const err = extractError(result.stderr, result.exitCode);
		return { ok: false, error: err.message };
	}
	const kept = keepTail(result.stdout);
	return { ok: true, text: kept.text, truncated: kept.truncated };
}
