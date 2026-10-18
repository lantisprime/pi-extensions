// Minimal, deterministic glob matching. Deliberately not a full glob engine:
// the contract only needs package prefixes and a few docs patterns, and a
// smaller matcher is easier to reason about in a gate.

function escapeRe(value: string): string {
	return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizePath(value: string): string {
	return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function matchGlob(glob: string, file: string): boolean {
	const g = normalizePath(glob);
	const f = normalizePath(file);
	if (!g) return false;
	if (g === f) return true;

	// "dir/**" matches the directory itself and everything below it.
	if (g.endsWith("/**")) {
		const prefix = g.slice(0, -3);
		return f === prefix || f.startsWith(`${prefix}/`);
	}

	// "**/*.md" matches any depth; "*.md" matches only the repo root.
	if (g.startsWith("**/")) {
		const tail = g.slice(3);
		if (!tail.includes("*")) return f === tail || f.endsWith(`/${tail}`);
		const re = new RegExp(`(^|/)${tail.split("*").map(escapeRe).join("[^/]*")}$`);
		return re.test(f);
	}

	if (g.includes("*")) {
		const re = new RegExp(`^${g.split("*").map(escapeRe).join("[^/]*")}$`);
		return re.test(f);
	}

	return false;
}

export function matchesAny(globs: string[], file: string): boolean {
	return globs.some((glob) => matchGlob(glob, file));
}

export function isDocsOnly(globs: string[], files: string[]): boolean {
	return files.length > 0 && files.every((file) => matchesAny(globs, file));
}
