// P5d-S1: macOS cmux 0.64.17+ workspace/surface identity detection.
// Tries `cmux identify --json` first, then $CMUX_WORKSPACE_ID/$CMUX_SURFACE_ID.
import type { CmuxExecutor } from "./exec.ts";
import { CMUX_EXEC_TIMEOUT_MS } from "./exec.ts";

export interface CmuxIdentity {
	workspaceId: string | null;
	surfaceId: string | null;
	workspaceRef: string | null;
	surfaceRef: string | null;
}

const NULL_IDENTITY: CmuxIdentity = {
	workspaceId: null,
	surfaceId: null,
	workspaceRef: null,
	surfaceRef: null,
};

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function parseIdentity(stdout: string): CmuxIdentity | null {
	try {
		const parsed = JSON.parse(stdout) as Record<string, unknown>;
		return {
			workspaceId: stringOrNull(parsed.workspaceId),
			surfaceId: stringOrNull(parsed.surfaceId),
			workspaceRef: stringOrNull(parsed.workspaceRef),
			surfaceRef: stringOrNull(parsed.surfaceRef),
		};
	} catch {
		return null;
	}
}

function identifyFromEnv(): CmuxIdentity | null {
	const workspaceId = stringOrNull(process.env.CMUX_WORKSPACE_ID);
	const surfaceId = stringOrNull(process.env.CMUX_SURFACE_ID);
	if (!workspaceId && !surfaceId) return null;
	return {
		workspaceId,
		surfaceId,
		workspaceRef: null,
		surfaceRef: null,
	};
}

export async function identify(executor: CmuxExecutor): Promise<CmuxIdentity> {
	try {
		const result = await executor.exec(["identify", "--json"], { timeoutMs: CMUX_EXEC_TIMEOUT_MS });
		if (result.ok) {
			const identity = parseIdentity(result.stdout);
			if (identity) return identity;
		}
	} catch {
		// Treat executor failures as "cmux not reachable"; callers handle null fields.
	}

	return identifyFromEnv() ?? { ...NULL_IDENTITY };
}
