// Persisted green-test ledger. Lives outside the repo (same pattern as
// permission-policy) so hashes/timestamps survive restart and compaction, and
// no repository data is written by the guard.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type GreenRecord = {
	/** Content hash of the package's changed files at the green run. */
	hash: string;
	/** Cheap path-set key, used only for the per-turn delta line. */
	changedKey: string;
	at: string;
};

export type WorkflowState = {
	version: 1;
	projectPath: string;
	/** Package glob -> last green run. */
	green: Record<string, GreenRecord>;
	updatedAt: string;
};

function projectKey(projectPath: string): string {
	return createHash("sha256").update(projectPath).digest("hex").slice(0, 24);
}

export function stateFile(projectPath: string): string {
	return path.join(os.homedir(), ".pi", "agent", "workflow", `${projectKey(projectPath)}.json`);
}

export function emptyState(projectPath: string): WorkflowState {
	return { version: 1, projectPath, green: {}, updatedAt: new Date().toISOString() };
}

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function loadState(projectPath: string): Promise<WorkflowState> {
	try {
		const raw = await fs.readFile(stateFile(projectPath), "utf8");
		const parsed = JSON.parse(raw) as Partial<WorkflowState>;
		if (parsed.version !== 1 || typeof parsed.green !== "object" || parsed.green === null) return emptyState(projectPath);
		const updated = Date.parse(parsed.updatedAt ?? "");
		if (Number.isFinite(updated) && Date.now() - updated > MAX_AGE_MS) return emptyState(projectPath);
		const green: Record<string, GreenRecord> = {};
		for (const [glob, record] of Object.entries(parsed.green)) {
			const item = record as Partial<GreenRecord>;
			if (typeof item?.hash === "string" && typeof item?.at === "string") {
				green[glob] = {
					hash: item.hash,
					changedKey: typeof item.changedKey === "string" ? item.changedKey : "",
					at: item.at,
				};
			}
		}
		return { version: 1, projectPath, green, updatedAt: parsed.updatedAt ?? new Date().toISOString() };
	} catch {
		return emptyState(projectPath);
	}
}

export async function saveState(state: WorkflowState): Promise<void> {
	const file = stateFile(state.projectPath);
	await fs.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	await fs.writeFile(tmp, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
	await fs.rename(tmp, file);
}

export function recordGreen(state: WorkflowState, glob: string, hash: string, changedKey: string): WorkflowState {
	return {
		...state,
		green: { ...state.green, [glob]: { hash, changedKey, at: new Date().toISOString() } },
	};
}
