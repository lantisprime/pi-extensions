// cmux-control launch operations for workspaces and panes.
import type { CmuxExecutor } from "./exec.ts";
import { DEFAULT_CMUX_PREFIX, isValidWorkspaceName, matchesPrefix, requireCmuxRef } from "./safety.ts";

const CMUX_LAUNCH_TIMEOUT_MS = 10000;

export interface LaunchOptions {
	name: string;
	cwd: string;
	command: string;
	focus?: boolean;
}

function parseOkRef(stdout: string, expected: "workspace" | "surface"): string | null {
	const match = stdout.trim().match(/^OK\s+(\S+)\s*$/);
	if (!match) return null;

	const ref = requireCmuxRef(match[1], expected);
	if ("error" in ref) return null;
	return match[1];
}

export async function launchWorkspace(
	executor: CmuxExecutor,
	opts: LaunchOptions,
): Promise<{ ok: true; workspaceRef: string } | { ok: false; error: string }> {
	if (!isValidWorkspaceName(opts.name)) return { ok: false, error: "invalid workspace name" };
	if (!matchesPrefix(opts.name)) return { ok: false, error: `workspace name must start with ${DEFAULT_CMUX_PREFIX}` };

	const result = await executor.exec([
		"workspace", "create",
		"--name", opts.name,
		"--cwd", opts.cwd,
		"--command", opts.command,
		"--focus", String(opts.focus ?? false),
	], { timeoutMs: CMUX_LAUNCH_TIMEOUT_MS });
	if (!result.ok) return { ok: false, error: result.stderr || `cmux workspace create failed (exit ${result.exitCode})` };

	const workspaceRef = parseOkRef(result.stdout, "workspace");
	if (!workspaceRef) return { ok: false, error: "cmux workspace create did not return workspace ref" };
	return { ok: true, workspaceRef };
}

export async function launchPane(
	executor: CmuxExecutor,
	workspaceRef: string,
	opts: { direction?: "right" | "down"; focus?: boolean; type?: "terminal" } = {},
): Promise<{ ok: true; surfaceRef: string } | { ok: false; error: string }> {
	const ref = requireCmuxRef(workspaceRef, "workspace");
	if ("error" in ref) return { ok: false, error: ref.error };

	const result = await executor.exec([
		"new-pane",
		"--workspace", workspaceRef,
		"--type", opts.type ?? "terminal",
		"--direction", opts.direction ?? "right",
		"--focus", String(opts.focus ?? false),
	], { timeoutMs: CMUX_LAUNCH_TIMEOUT_MS });
	if (!result.ok) return { ok: false, error: result.stderr || `cmux new-pane failed (exit ${result.exitCode})` };

	const surfaceRef = parseOkRef(result.stdout, "surface");
	if (!surfaceRef) return { ok: false, error: "cmux new-pane did not return surface ref" };
	return { ok: true, surfaceRef };
}
