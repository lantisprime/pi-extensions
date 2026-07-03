// cmux-control workspace and pane list operations.
import type { CmuxExecutor } from "./exec.ts";
import { requireCmuxRef } from "./safety.ts";

const CMUX_LIST_TIMEOUT_MS = 5000;

export interface CmuxWorkspace {
	id: number;
	title: string;
	ref: string;
	currentDirectory: string;
}

export interface CmuxPane {
	surfaceRef: string;
	title: string;
	isFocused: boolean;
}

function errorFromResult(prefix: string, result: { stderr: string; exitCode: number }): Error {
	return new Error(result.stderr || `${prefix} failed (exit ${result.exitCode})`);
}

function workspacesFromJson(stdout: string): any[] {
	const parsed = JSON.parse(stdout);
	if (Array.isArray(parsed?.workspaces)) return parsed.workspaces;
	if (Array.isArray(parsed)) return parsed;
	return [];
}

function workspaceRefOf(raw: any): string {
	if (typeof raw?.ref === "string") return raw.ref;
	if (typeof raw?.workspaceRef === "string") return raw.workspaceRef;
	if (Number.isSafeInteger(Number(raw?.id))) return `workspace:${Number(raw.id)}`;
	return "";
}

function panesFromWorkspace(raw: any): any[] {
	for (const key of ["panes", "surfaces", "surfaceList"]) {
		if (Array.isArray(raw?.[key])) return raw[key];
	}
	return [];
}

export async function listWorkspaces(executor: CmuxExecutor): Promise<CmuxWorkspace[]> {
	const result = await executor.exec(["workspace", "list", "--json"], { timeoutMs: CMUX_LIST_TIMEOUT_MS });
	if (!result.ok) throw errorFromResult("cmux workspace list", result);

	return workspacesFromJson(result.stdout).map((workspace) => ({
		id: Number(workspace?.id),
		title: String(workspace?.title ?? workspace?.name ?? ""),
		ref: workspaceRefOf(workspace),
		currentDirectory: String(workspace?.currentDirectory ?? workspace?.cwd ?? workspace?.current_directory ?? ""),
	}));
}

export async function listPanes(executor: CmuxExecutor, workspaceRef: string): Promise<CmuxPane[]> {
	const ref = requireCmuxRef(workspaceRef, "workspace");
	if ("error" in ref) throw new Error(ref.error);

	const result = await executor.exec(["workspace", "list", "--json"], { timeoutMs: CMUX_LIST_TIMEOUT_MS });
	if (!result.ok) throw errorFromResult("cmux workspace list", result);

	const workspace = workspacesFromJson(result.stdout).find((candidate) => workspaceRefOf(candidate) === workspaceRef);
	if (!workspace) return [];

	return panesFromWorkspace(workspace).map((pane) => ({
		surfaceRef: String(pane?.surfaceRef ?? pane?.surface ?? pane?.ref ?? ""),
		title: String(pane?.title ?? pane?.name ?? ""),
		isFocused: Boolean(pane?.isFocused ?? pane?.focused ?? pane?.active ?? false),
	}));
}
