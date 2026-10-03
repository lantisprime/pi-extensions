import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import path from "node:path";

export const PROMPT_FILES = { scout: "scout.md", planner: "planner.md", reviewer: "reviewer.md", architect: "architect.md", builder: "builder.md", orchestrator: "orchestrator.md", "test-architect": "test-architect.md", researcher: "researcher.md" } as const;

/** Built-in agent name whose method file this is. */
export type PromptName = keyof typeof PROMPT_FILES;

/** Lookup a method file by built-in name from an UNTRUSTED (unknown-typed) name.
 *  Returns "" for anything that is not one of the eight built-ins. One honest
 *  widening lives here instead of an index-signature cast at every call site:
 *  the values really are all strings, but the key can arrive as any string. */
export function promptFileForName(name: string): string {
	return (PROMPT_FILES as Record<string, string>)[name] ?? "";
}
export const MAX_METHOD_BYTES = 6 * 1024;
/** The only filenames the loader will ever read — never an arbitrary path. */
const ALLOWED_FILES = new Set<string>(Object.values(PROMPT_FILES));

const cache = new Map<string, string>(); // success-only cache, keyed by resolved file (REQ-A3)

/** The subset of AgentSpec this resolver reads. Structural rather than an import of
 *  AgentSpec so prompts.ts stays a leaf module (specs.ts imports PROMPT_FILES from
 *  here, so importing back would be a cycle). */
type SpecLike = { source?: string; name?: string; instructionsFile?: unknown };

/** Resolve the method file a spec carries: built-in by name, ephemeral by inherited instructionsFile.
 *  Returns "" when there is no (valid) method file — never an arbitrary path. */
export function methodFileForSpec(spec: SpecLike | null | undefined): string {
	if (!spec || typeof spec !== "object") return "";
	if (spec.source === "built-in") return promptFileForName(spec.name ?? "");
	if (spec.source === "ephemeral" && typeof spec.instructionsFile === "string" && ALLOWED_FILES.has(spec.instructionsFile)) return spec.instructionsFile;
	return "";
}

/** Load an externalized method by built-in NAME or method FILE (both normalize to an allowlisted
 *  file). Returns "" for an unknown/empty key (never reads an arbitrary path). Throws for an
 *  ALLOWLISTED file that is missing/unreadable/oversize/parent-mismatch (REQ-A5). */
export async function loadAgentMethod(key: string, opts: { fresh?: boolean } = {}): Promise<string> {
	const fresh = opts.fresh === true; // doctor uses fresh=true to bypass cache (REQ-A6)
	const file = promptFileForName(key) || (ALLOWED_FILES.has(key) ? key : "");
	if (!file) return "";
	// Re-read the Map after the `has` check rather than returning `get` blind: Set/Map
	// lookups come back `T | undefined`, and an empty-string fallback would be
	// indistinguishable from a real cache hit on a legitimately empty method file.
	const cached = fresh ? undefined : cache.get(file);
	if (cached !== undefined) return cached;
	const promptsDir = path.resolve(fileURLToPath(new URL("./prompts/", import.meta.url)));
	const p = fileURLToPath(new URL(`./prompts/${file}`, import.meta.url));
	if (path.dirname(p) !== promptsDir) throw new Error(`prompts: parent mismatch for ${file}`);
	const buf = await fs.readFile(p); // throws ENOENT etc → caller maps to spawn-error
	if (buf.byteLength > MAX_METHOD_BYTES) throw new Error(`prompts: ${file} exceeds ${MAX_METHOD_BYTES}`);
	const text = buf.toString("utf8").trim();
	cache.set(file, text); // cache success only
	return text;
}
