// Contract loading and validation. The contract is read only from a trusted
// project; an untrusted project gets no steering and no gates.

import { promises as fs } from "node:fs";
import path from "node:path";
import {
	DEFAULT_DOCS_ONLY,
	DEFAULT_GATES,
	DEFAULT_PROTECTED_PATHS,
	type GateId,
	type PackageSpec,
	type WorkflowContract,
} from "./types.ts";

export const CONTRACT_RELATIVE_PATH = ".pi/workflow.json";

export type ContractLoad = { contract: WorkflowContract; error?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return fallback;
	const strings = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	return strings.length > 0 ? strings : fallback;
}

function packages(value: unknown): PackageSpec[] {
	if (!Array.isArray(value)) return [];
	const result: PackageSpec[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		const glob = typeof item.glob === "string" ? item.glob.trim() : "";
		const test = typeof item.test === "string" ? item.test.trim() : "";
		if (glob && test) result.push({ glob, test });
	}
	return result;
}

function gates(value: unknown): WorkflowContract["gates"] {
	const result: WorkflowContract["gates"] = { ...DEFAULT_GATES };
	if (!isRecord(value)) return result;
	for (const id of Object.keys(DEFAULT_GATES) as GateId[]) {
		const entry = value[id];
		if (isRecord(entry) && typeof entry.enabled === "boolean") result[id] = { enabled: entry.enabled };
	}
	return result;
}

export function normalizeContract(value: unknown): WorkflowContract | null {
	if (!isRecord(value)) return null;
	return {
		version: 1,
		sources: stringArray(value.sources, []),
		packages: packages(value.packages),
		docsOnly: stringArray(value.docsOnly, DEFAULT_DOCS_ONLY),
		protectedPaths: stringArray(value.protectedPaths, DEFAULT_PROTECTED_PATHS),
		gates: gates(value.gates),
	};
}

export async function loadContract(cwd: string, trusted: boolean): Promise<ContractLoad | null> {
	if (!trusted) return null;
	const file = path.join(cwd, CONTRACT_RELATIVE_PATH);
	let raw: string;
	try {
		raw = await fs.readFile(file, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return null;
		return { contract: normalizeContract({}) as WorkflowContract, error: `cannot read ${CONTRACT_RELATIVE_PATH}` };
	}
	try {
		const parsed = normalizeContract(JSON.parse(raw));
		if (!parsed) return { contract: normalizeContract({}) as WorkflowContract, error: "contract is not an object" };
		return { contract: parsed };
	} catch {
		return { contract: normalizeContract({}) as WorkflowContract, error: "contract is not valid JSON" };
	}
}
