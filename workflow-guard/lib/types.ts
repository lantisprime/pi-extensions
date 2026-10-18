// Types and defaults for the workflow contract. The contract is the single
// machine-checkable source of truth; AGENTS.md stays the human narrative.

export type PackageSpec = {
	/** Repo-relative glob, e.g. "herdr-control/**". */
	glob: string;
	/** Exact command that makes this package green. Run it verbatim. */
	test: string;
};

export type GateConfig = { enabled?: boolean };

export type GateId = "protect-instructions" | "test-before-commit" | "plan-before-pr";

export type WorkflowContract = {
	version: 1;
	sources: string[];
	packages: PackageSpec[];
	docsOnly: string[];
	protectedPaths: string[];
	gates: Partial<Record<GateId, GateConfig>>;
};

export const DEFAULT_PROTECTED_PATHS = [
	"AGENTS.md",
	"MEMORY.md",
	".pi/runbooks/**",
	".pi/workflow.json",
];

export const DEFAULT_DOCS_ONLY = ["**/*.md", "docs/**", ".plans/**"];

export const DEFAULT_GATES: WorkflowContract["gates"] = {
	"protect-instructions": { enabled: true },
	"test-before-commit": { enabled: true },
	"plan-before-pr": { enabled: false },
};

export function isGateEnabled(contract: WorkflowContract, id: GateId): boolean {
	const gates = contract.gates?.[id];
	if (gates && typeof gates.enabled === "boolean") return gates.enabled;
	return DEFAULT_GATES[id]?.enabled === true;
}
