import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import path from "node:path";

export const PROMPT_FILES = { scout: "scout.md", planner: "planner.md", reviewer: "reviewer.md" };
export const MAX_METHOD_BYTES = 6 * 1024;

const cache = new Map(); // success-only cache (REQ-A3)

/** Load a built-in agent's externalized method text. Returns "" for a name with no mapping.
 *  Throws for a MAPPED name whose file is missing/unreadable/oversize/parent-mismatch (REQ-A5). */
export async function loadAgentMethod(name, opts = {}) {
	const fresh = opts.fresh === true; // doctor uses fresh=true to bypass cache (REQ-A6)
	const file = PROMPT_FILES[name];
	if (!file) return "";
	if (!fresh && cache.has(name)) return cache.get(name);
	const promptsDir = path.resolve(fileURLToPath(new URL("./prompts/", import.meta.url)));
	const p = fileURLToPath(new URL(`./prompts/${file}`, import.meta.url));
	if (path.dirname(p) !== promptsDir) throw new Error(`prompts: parent mismatch for ${name}`);
	const buf = await fs.readFile(p); // throws ENOENT etc → caller maps to spawn-error
	if (buf.byteLength > MAX_METHOD_BYTES) throw new Error(`prompts: ${name} exceeds ${MAX_METHOD_BYTES}`);
	const text = buf.toString("utf8").trim();
	cache.set(name, text); // cache success only
	return text;
}
