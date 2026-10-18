// Detect bash-mediated mutation of operator-owned steering paths. This is a
// conservative lexical check: it prefers asking over silently allowing, because
// the loader/prompt-shield chain treats runbooks and the contract as guidance.

import path from "node:path";
import { matchGlob, normalizePath } from "./glob.ts";

const IN_PLACE = [/\bsed\b[^;&|]*\s(?:-i\S*|--in-place\S*)/, /\bperl\b[^;&|]*\s-\w*i\w*\b/];
const SINK = [
	/\btee\b/,
	/\btruncate\b/,
	/\bdd\b[^;&|]*\bof=/,
	/\bpatch\b/,
	/\bfind\b[^;&|]*-delete\b/,
];
const GIT_MUTATION = /\bgit\b[^;&|]*\b(?:apply|checkout|restore|clean|rm)\b/;
const COPY = /\b(?:cp|install)\b/;
const MOVE = /\bmv\b/;
const REMOVE = /\b(?:rm|unlink)\b/;

function tokens(command: string): string[] {
	const matches = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	return matches.map((token) => token.replace(/^["']|["']$/g, ""));
}

export function toRepoRelative(candidate: string, cwd: string): string {
	const cleaned = candidate.replace(/^["']|["']$/g, "");
	if (!cleaned) return "";
	if (path.isAbsolute(cleaned)) {
		return normalizePath(path.relative(cwd, cleaned));
	}
	return normalizePath(path.posix.normalize(cleaned));
}

/** The matched protected repo-relative path, or null. */
export function matchProtectedPath(candidate: string, protectedPaths: string[], cwd: string): string | null {
	const relative = toRepoRelative(candidate, cwd);
	if (!relative) return null;
	// `cd sub && sed -i ../AGENTS.md` resolves to `../AGENTS.md`; compare the
	// portion after leading `../` segments as well. Only for relative escapes,
	// so an outside `/tmp/AGENTS.md` is not mistaken for the repo root file.
	const candidates = relative.startsWith("../") ? [relative.replace(/^(?:\.\.\/)+/, ""), relative] : [relative];
	for (const value of candidates) {
		const hit = protectedPaths.some(
			(pattern) => value === pattern || matchGlob(pattern, value) || (!pattern.includes("*") && value.endsWith(`/${pattern}`)),
		);
		if (hit) return value;
	}
	return null;
}

export function isProtectedPath(candidate: string, protectedPaths: string[], cwd: string): boolean {
	return matchProtectedPath(candidate, protectedPaths, cwd) !== null;
}

function protectedInToken(token: string, protectedPaths: string[], cwd: string): string | null {
	if (!token || token.startsWith("-")) return null;
	return matchProtectedPath(token, protectedPaths, cwd);
}

/**
 * Returns the protected repo-relative path a bash command would mutate, or null.
 * Read-only commands that merely mention a protected file (cat, grep, sed -n,
 * git diff) do not match.
 */
export function findProtectedMutation(command: string, protectedPaths: string[], cwd: string): string | null {
	const text = command.trim();
	if (!text) return null;

	// Redirect targets: `> AGENTS.md`, `>> .pi/runbooks/x.md`.
	const redirect = />>?\s*("[^"]+"|'[^']+'|[^\s;&|]+)/g;
	for (const match of text.matchAll(redirect)) {
		const target = protectedInToken(match[1], protectedPaths, cwd);
		if (target) return target;
	}

	if (IN_PLACE.some((pattern) => pattern.test(text))) {
		for (const token of tokens(text)) {
			const target = protectedInToken(token, protectedPaths, cwd);
			if (target) return target;
		}
	}

	if (SINK.some((pattern) => pattern.test(text)) || GIT_MUTATION.test(text)) {
		for (const token of tokens(text)) {
			const target = protectedInToken(token, protectedPaths, cwd);
			if (target) return target;
		}
	}

	if (MOVE.test(text)) {
		// Moving a protected file removes it from its original path.
		for (const token of tokens(text)) {
			const target = protectedInToken(token, protectedPaths, cwd);
			if (target) return target;
		}
	}

	if (COPY.test(text)) {
		// Only the destination (last operand) mutates; `cp AGENTS.md /tmp` is a read.
		const operands = tokens(text).filter((token) => !token.startsWith("-") && !/^(?:cp|install)$/.test(token));
		const destination = operands[operands.length - 1];
		const target = destination ? protectedInToken(destination, protectedPaths, cwd) : null;
		if (target) return target;
	}

	if (REMOVE.test(text)) {
		for (const token of tokens(text)) {
			const target = protectedInToken(token, protectedPaths, cwd);
			if (target) return target;
		}
	}

	return null;
}

/** Tool input path for write/edit, normalized against the project root. */
export function writeEditPath(input: Record<string, unknown>, cwd: string): string | null {
	const raw = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : "";
	if (!raw) return null;
	return toRepoRelative(raw, cwd);
}
