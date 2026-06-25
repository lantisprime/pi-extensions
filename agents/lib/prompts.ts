import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import path from "node:path";

export const PROMPT_FILES = { scout: "scout.md", planner: "planner.md", reviewer: "reviewer.md" };
export const MAX_METHOD_BYTES = 6 * 1024;
/** The only filenames the loader will ever read — never an arbitrary path. */
const ALLOWED_FILES = new Set(Object.values(PROMPT_FILES));

const cache = new Map(); // success-only cache, keyed by resolved file (REQ-A3)

/** Resolve the method file a spec carries: built-in by name, ephemeral by inherited instructionsFile.
 *  Returns "" when there is no (valid) method file — never an arbitrary path. */
export function methodFileForSpec(spec) {
	if (!spec || typeof spec !== "object") return "";
	if (spec.source === "built-in") return PROMPT_FILES[spec.name] || "";
	if (spec.source === "ephemeral" && typeof spec.instructionsFile === "string" && ALLOWED_FILES.has(spec.instructionsFile)) return spec.instructionsFile;
	return "";
}

/** Load an externalized method by built-in NAME or method FILE (both normalize to an allowlisted
 *  file). Returns "" for an unknown/empty key (never reads an arbitrary path). Throws for an
 *  ALLOWLISTED file that is missing/unreadable/oversize/parent-mismatch (REQ-A5). */
export async function loadAgentMethod(key, opts = {}) {
	const fresh = opts.fresh === true; // doctor uses fresh=true to bypass cache (REQ-A6)
	const file = PROMPT_FILES[key] || (ALLOWED_FILES.has(key) ? key : "");
	if (!file) return "";
	if (!fresh && cache.has(file)) return cache.get(file);
	const promptsDir = path.resolve(fileURLToPath(new URL("./prompts/", import.meta.url)));
	const p = fileURLToPath(new URL(`./prompts/${file}`, import.meta.url));
	if (path.dirname(p) !== promptsDir) throw new Error(`prompts: parent mismatch for ${file}`);
	const buf = await fs.readFile(p); // throws ENOENT etc → caller maps to spawn-error
	if (buf.byteLength > MAX_METHOD_BYTES) throw new Error(`prompts: ${file} exceeds ${MAX_METHOD_BYTES}`);
	const text = buf.toString("utf8").trim();
	cache.set(file, text); // cache success only
	return text;
}
