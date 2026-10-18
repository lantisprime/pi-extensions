// Pure gate decisions. Inputs are snapshots computed by the caller; no fs, no
// model, no clock. `null` means "allow".

import { isDocsOnly, matchGlob } from "./glob.ts";
import { gateReason, protectedReason } from "./steering.ts";
import { findProtectedMutation, isProtectedPath, writeEditPath } from "./bash.ts";
import type { PackageSpec, WorkflowContract } from "./types.ts";
import { isGateEnabled } from "./types.ts";

const GIT_OPTIONS_WITH_VALUE = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--exec-path",
	"--namespace",
	"--config-env",
]);

/** The git subcommand, skipping global options and their values. */
export function gitSubcommand(segment: string): string | null {
	const tokens = segment.split(/\s+/).filter(Boolean);
	const start = tokens.findIndex((token) => token === "git" || token.endsWith("/git"));
	if (start < 0) return null;
	let index = start + 1;
	while (index < tokens.length) {
		const token = tokens[index];
		if (token.startsWith("-")) {
			index += GIT_OPTIONS_WITH_VALUE.has(token) ? 2 : 1;
			continue;
		}
		return token;
	}
	return null;
}

export function isCommitLikeCommand(command: string): boolean {
	const segments = command
		.split(/\n|&&|\|\||;|\|/)
		.map((segment) => segment.trim())
		.filter(Boolean);
	return segments.some((segment) => {
		const subcommand = gitSubcommand(segment);
		if (subcommand === "commit" || subcommand === "push") return true;
		// `gh pr create|merge`, `tea pr create|merge` (forgejo), `glab mr|pr`.
		return (
			/\bgh\b[^;&|]*\bpr\s+(?:create|merge)\b/.test(segment) ||
			/\btea\b[^;&|]*\bpr\s+(?:create|merge)\b/.test(segment) ||
			/\bglab\b[^;&|]*\b(?:mr|pr)\s+(?:create|merge)\b/.test(segment)
		);
	});
}

export type ProtectedHit = { path: string; reason: string };

export function protectedHit(
	toolName: string,
	input: Record<string, unknown>,
	contract: WorkflowContract,
	cwd: string,
): ProtectedHit | null {
	if (!isGateEnabled(contract, "protect-instructions")) return null;
	if (toolName === "write" || toolName === "edit") {
		const target = writeEditPath(input, cwd);
		if (target && isProtectedPath(target, contract.protectedPaths, cwd)) {
			return { path: target, reason: protectedReason(target) };
		}
		return null;
	}
	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		const target = findProtectedMutation(command, contract.protectedPaths, cwd);
		if (target) return { path: target, reason: protectedReason(target) };
	}
	return null;
}

export function packagesTouched(contract: WorkflowContract, changed: string[]): PackageSpec[] {
	return contract.packages.filter((pkg) => changed.some((file) => matchGlob(pkg.glob, file)));
}

export type CommitGateInput = {
	contract: WorkflowContract;
	enforcing: boolean;
	command: string;
	changed: string[];
	/** glob -> current content hash, or null when it could not be computed. */
	hashes: Map<string, string | null>;
	green: Record<string, { hash: string }>;
};

export function evaluateCommitGate(input: CommitGateInput): { block: true; reason: string } | null {
	const { contract, enforcing, command, changed, hashes, green } = input;
	if (!enforcing || !isGateEnabled(contract, "test-before-commit")) return null;
	if (!isCommitLikeCommand(command)) return null;
	if (changed.length === 0) return null;
	if (isDocsOnly(contract.docsOnly, changed)) return null;

	const touched = packagesTouched(contract, changed);
	const dirty = touched.filter((pkg) => {
		const current = hashes.get(pkg.glob) ?? null;
		if (current === null) return true; // cannot prove -> fail closed
		return green[pkg.glob]?.hash !== current;
	});

	if (dirty.length === 0) return null;
	return { block: true, reason: gateReason(dirty) };
}

/** G3 is intentionally not implemented yet; it is off by default. */
export function planGateActive(contract: WorkflowContract): boolean {
	return isGateEnabled(contract, "plan-before-pr");
}
