/**
 * P3f-3: Profile file discovery and frontmatter-only parsing.
 *
 * Reuses splitFrontmatter + parseFrontmatterBlock from agent-markdown.ts
 * for bounded frontmatter parsing. Profiles are frontmatter-only — no body.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256Hex, splitFrontmatter, parseFrontmatterBlock, parseFrontmatterValue, type AgentParserLimits, DEFAULT_AGENT_PARSER_LIMITS } from "./agent-markdown.ts";
import { validateProfile, type ModelProfile } from "./profiles.ts";
import type { AgentValidationIssue } from "./specs.ts";
import type { ProjectAgentRegistry } from "./registry.ts";

export const DEFAULT_PROFILE_DISCOVERY_LIMITS = Object.freeze({
	maxFilesPerSource: 50,
	maxFileBytes: 64 * 1024,
	maxFrontmatterBytes: 8 * 1024,
});

export type ParsedProfile = {
	filePath: string;
	canonicalPath?: string;
	rawBytesSha256: string;
	profile?: ModelProfile;
	source: "user" | "project";
	issues: AgentValidationIssue[];
	warnings: string[];
	unknownKeys: string[];
};

export type ProfileDiscoveryOptions = {
	maxFiles?: number;
	maxFileBytes?: number;
	maxFrontmatterBytes?: number;
};

/**
 * Parse a single profile Markdown file.
 *
 * Profiles are frontmatter-only. Body content after frontmatter is warned
 * but not included in the ModelProfile. Unknown frontmatter keys are warned.
 * Files exceeding size limits or missing frontmatter are rejected.
 *
 * Never throws — returns ParsedProfile with issues populated on error.
 */
export async function parseProfileFile(
	filePath: string,
	source: "user" | "project",
	options: ProfileDiscoveryOptions = {},
): Promise<ParsedProfile> {
	const maxFileBytes = options.maxFileBytes ?? DEFAULT_PROFILE_DISCOVERY_LIMITS.maxFileBytes;
	const maxFrontmatterBytes = options.maxFrontmatterBytes ?? DEFAULT_PROFILE_DISCOVERY_LIMITS.maxFrontmatterBytes;

	const baseResult = (overrides: Partial<ParsedProfile>): ParsedProfile => ({
		filePath,
		source,
		rawBytesSha256: "",
		issues: [],
		warnings: [],
		unknownKeys: [],
		...overrides,
	});

	// Read file
	let rawBytes: Uint8Array;
	try {
		rawBytes = await fs.readFile(filePath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return baseResult({
			issues: [{ field: "file", code: "file-read-error", message }],
		});
	}

	const rawBytesSha256 = sha256Hex(rawBytes);

	// Check file size
	if (rawBytes.byteLength > maxFileBytes) {
		return baseResult({
			rawBytesSha256,
			issues: [{ field: "file", code: "file-too-large", message: `profile file exceeds ${maxFileBytes} bytes` }],
		});
	}

	const text = new TextDecoder("utf8", { fatal: false }).decode(rawBytes);
	const split = splitFrontmatter(text);
	if (!split.ok) {
		return baseResult({
			rawBytesSha256,
			issues: [{ field: "frontmatter", code: split.code, message: split.message }],
		});
	}

	const frontmatterBytes = new TextEncoder().encode(split.frontmatter).byteLength;
	if (frontmatterBytes > maxFrontmatterBytes) {
		return baseResult({
			rawBytesSha256,
			issues: [{ field: "frontmatter", code: "frontmatter-too-large", message: `profile frontmatter exceeds ${maxFrontmatterBytes} bytes` }],
		});
	}

	// Parse frontmatter — parseFrontmatterBlock only accepts agent keys
	// We also need profile-specific keys like 'purpose'
	const frontmatter = parseFrontmatterBlock(split.frontmatter);
	const issues: AgentValidationIssue[] = [];
	const warnings: string[] = [];
	const profileKeys = new Set(["name", "model", "thinking", "purpose"]);

	for (const issue of frontmatter.issues) issues.push(issue);

	// Extract all key: value pairs from raw frontmatter (not just agent keys)
	const rawMetadata: Record<string, unknown> = {};
	const rawUnknownKeys: string[] = [];
	for (const line of split.frontmatter.split(/\r?\n/)) {
		if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		const key = line.slice(0, colon).trim();
		if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) continue;
		if (key in rawMetadata) continue; // first occurrence wins
		const rawValue = line.slice(colon + 1).trim();
		rawMetadata[key] = parseFrontmatterValue(rawValue);
		if (!profileKeys.has(key) && !(key in frontmatter.metadata)) {
			rawUnknownKeys.push(key);
			warnings.push(`unknown profile frontmatter key '${key}' ignored`);
		}
	}

	// Merge agent-accepted keys from frontmatter.metadata with profile-specific keys from rawMetadata
	const mergedMetadata: Record<string, unknown> = { ...frontmatter.metadata };
	for (const key of profileKeys) {
		if (key in rawMetadata && !(key in mergedMetadata)) {
			mergedMetadata[key] = rawMetadata[key];
		}
	}

	// Warn if body content exists after frontmatter
	const body = split.body.trim();
	if (body.length > 0) {
		warnings.push("profile body content after frontmatter is ignored");
	}

	// Validate via validateProfile
	const validation = validateProfile(mergedMetadata);
	for (const issue of validation.issues) issues.push(issue);

	if (!validation.ok) {
		return baseResult({ rawBytesSha256, issues, warnings, unknownKeys: rawUnknownKeys });
	}

	// Build ModelProfile from merged metadata
	const profile: ModelProfile = {
		name: mergedMetadata.name as string,
		...(mergedMetadata.model !== undefined ? { model: mergedMetadata.model as string } : {}),
		...(mergedMetadata.thinking !== undefined ? { thinking: mergedMetadata.thinking as ModelProfile["thinking"] } : {}),
		...(mergedMetadata.purpose !== undefined ? { purpose: mergedMetadata.purpose as string } : {}),
		sourceOrigin: source,
		rawBytesSha256,
	};

	return baseResult({ rawBytesSha256, profile, issues, warnings, unknownKeys: rawUnknownKeys });
}

/**
 * Discover and parse profile files from a directory.
 *
 * Scans for *.md files, parses each, returns sorted results.
 * Returns [] for missing directories (ENOENT) or filesystem errors.
 * Respects maxFiles bound.
 */
export async function discoverProfiles(
	dir: string,
	source: "user" | "project",
	options: ProfileDiscoveryOptions = {},
): Promise<ParsedProfile[]> {
	const maxFiles = options.maxFiles ?? DEFAULT_PROFILE_DISCOVERY_LIMITS.maxFilesPerSource;

	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return [];
		return []; // Other filesystem errors: silently skip
	}

	const markdown = entries
		.filter((entry) => entry.endsWith(".md"))
		.sort((a, b) => a.localeCompare(b))
		.slice(0, maxFiles);

	const results: ParsedProfile[] = [];
	for (const entry of markdown) {
		const filePath = path.join(dir, entry);

		// Check for symlinks outside the source root
		try {
			const resolved = await fs.realpath(filePath);
			const resolvedDir = await fs.realpath(dir);
			if (!resolved.startsWith(resolvedDir + path.sep) && resolved !== resolvedDir) {
				results.push({
					filePath,
					source,
					rawBytesSha256: "",
					issues: [{ field: "file", code: "symlink-outside-root", message: "profile symlink points outside source directory root" }],
					warnings: [],
					unknownKeys: [],
				});
				continue;
			}
		} catch {
			// If realpath fails, still try to parse (file may be readable)
		}

		results.push(await parseProfileFile(filePath, source, options));
	}

	return results;
}

/**
 * Reject profiles with duplicate names within the same source.
 * Returns the list with duplicates removed and issues added.
 */
export function rejectDuplicateProfileNames(profiles: ParsedProfile[]): ParsedProfile[] {
	const seen = new Map<string, number>(); // name -> first index
	const result: ParsedProfile[] = [];

	for (const parsed of profiles) {
		const name = parsed.profile?.name;
		if (!name) {
			result.push(parsed);
			continue;
		}
		if (seen.has(name)) {
			result.push({
				...parsed,
				profile: undefined,
				issues: [
					...parsed.issues,
					{ field: "name", code: "profile-duplicate-name", message: `duplicate profile name '${name}' in same source` },
				],
			});
			// Also mark the first occurrence
			const firstIdx = seen.get(name)!;
			const first = result[firstIdx];
			result[firstIdx] = {
				...first,
				profile: undefined,
				issues: [
					...first.issues,
					{ field: "name", code: "profile-duplicate-name", message: `duplicate profile name '${name}' in same source` },
				],
			};
		} else {
			seen.set(name, result.length);
			result.push(parsed);
		}
	}

	return result;
}

// ── P3f-3: Runtime profile trust check ───────────────────────────────────

/** Result of a profile trust check at runtime. */
export type ProfileTrustCheck =
	| { ok: true }
	| { ok: false; code: string; message: string };

/** Built-in profile names — profiles that skip the trust check. */
const BUILT_IN_PROFILE_NAMES = new Set(["fast-local", "reasoning-deep", "adversarial-review"]);

/**
 * Verify that a resolved project profile's identity matches its registry entry.
 *
 * Checks:
 * 1. Profile name is not a built-in (built-ins skip trust check)
 * 2. Project trust is active (if not, all project profiles denied)
 * 3. Registry contains an entry matching (name + canonicalPath + rawBytesSha256)
 *
 * Returns { ok: true } only if all checks pass.
 * Any failure returns { ok: false } with a code and message — the caller
 * must HARD DENY child execution.
 */
export function profileTrustCheck(
	profileName: string,
	canonicalPath: string | undefined,
	cachedRawBytesSha256: string,
	projectRegistry: ProjectAgentRegistry | undefined,
	projectTrusted: boolean,
): ProfileTrustCheck {
	// Built-in profiles are always trusted
	if (BUILT_IN_PROFILE_NAMES.has(profileName)) {
		return { ok: true };
	}

	// If project trust is not active, deny project profiles
	if (!projectTrusted) {
		return { ok: false, code: "profile-trust-inactive", message: "project trust is not active; project profiles cannot be used" };
	}

	// No registry available — can't verify
	if (!projectRegistry) {
		return { ok: false, code: "profile-unregistered", message: "no project registry available for profile trust check" };
	}

	const profiles = projectRegistry.profiles ?? [];
	if (!Array.isArray(profiles)) {
		return { ok: false, code: "profile-registry-corrupt", message: "project registry profiles field is malformed" };
	}

	// Validate each entry is well-formed
	for (let i = 0; i < profiles.length; i++) {
		const entry = profiles[i];
		if (!entry || typeof entry !== "object") {
			return { ok: false, code: "profile-registry-corrupt", message: `project registry profile entry ${i} is not an object` };
		}
		if (typeof entry.name !== "string" || entry.name.length === 0) {
			return { ok: false, code: "profile-registry-corrupt", message: `project registry profile entry ${i} has invalid name` };
		}
		if (typeof entry.canonicalPath !== "string" || entry.canonicalPath.length === 0) {
			return { ok: false, code: "profile-registry-corrupt", message: `project registry profile entry ${i} has invalid canonicalPath` };
		}
		if (typeof entry.rawBytesSha256 !== "string" || entry.rawBytesSha256.length === 0) {
			return { ok: false, code: "profile-registry-corrupt", message: `project registry profile entry ${i} has invalid rawBytesSha256` };
		}
	}

	// Find matching entry by name + canonicalPath + hash
	const match = profiles.find((p) =>
		p.name === profileName &&
		p.canonicalPath === canonicalPath &&
		p.rawBytesSha256 === cachedRawBytesSha256,
	);

	if (match) {
		return { ok: true };
	}

	// Check for specific failure modes
	const nameMatch = profiles.find((p) => p.name === profileName);
	if (!nameMatch) {
		return { ok: false, code: "profile-unregistered", message: `profile '${profileName}' is not registered in the project registry` };
	}

	if (nameMatch.canonicalPath !== canonicalPath) {
		return { ok: false, code: "profile-path-mismatch", message: `profile '${profileName}' registered at different path: ${nameMatch.canonicalPath}` };
	}

	return { ok: false, code: "profile-hash-mismatch", message: `profile '${profileName}' hash changed since registration; re-register the profile` };
}
