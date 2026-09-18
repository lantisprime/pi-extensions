// Configuration loading for the MCP bridge.
//
// Config files are JSON with a `mcpServers` map, compatible with the common
// `{ "mcpServers": { ... } }` shape used by other MCP clients:
//
// {
//   "mcpServers": {
//     "filesystem": {
//       "command": "npx",
//       "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
//       "env": { "KEY": "value" }
//     },
//     "remote": {
//       "url": "https://example.com/mcp",
//       "headers": { "Authorization": "Bearer ${MY_TOKEN}" }
//     }
//   }
// }
//
// Global config:  ~/.pi/agent/mcp.json
// Project config: <cwd>/.pi/mcp.json   (project entries override global ones)
//
// ${VAR} references in string values are expanded from the environment.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface McpServerConfig {
	/** Stdio transport: executable to spawn. */
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	/** HTTP (Streamable HTTP) transport: server URL. */
	url?: string;
	headers?: Record<string, string>;
	/**
	 * HTTP only: shell command whose stdout is a JSON headers object (e.g.
	 * {"Authorization": "Bearer ..."}). Evaluated at connect time and again
	 * after a 401 (fresh values override `headers`), for servers that need
	 * short-lived tokens minted per connection. Same contract as Claude
	 * Code's `headersHelper`.
	 */
	headersCommand?: string;
	/** Set false to skip this server. Default true. */
	enabled?: boolean;
	/** Connect/list timeout in ms. Default 30000. */
	timeout?: number;
	/** tools/call timeout in ms. Default 120000. Set 0 to disable. */
	callTimeout?: number;
}

export interface McpConfig {
	servers: Record<string, McpServerConfig>;
	/** Non-fatal problems encountered while loading (unknown fields, bad entries). */
	warnings: string[];
}

export function globalConfigPath(): string {
	// Respect pi's own config-dir override so bridge config follows pi installs.
	const configDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	return path.join(configDir, "mcp.json");
}

export function projectConfigPath(cwd: string): string {
	return path.join(cwd, ".pi", "mcp.json");
}

export async function loadMcpConfig(cwd: string, includeProject = true): Promise<McpConfig> {
	const warnings: string[] = [];
	const servers: Record<string, McpServerConfig> = {};

	const paths = includeProject ? [globalConfigPath(), projectConfigPath(cwd)] : [globalConfigPath()];
	for (const filePath of paths) {
		let raw: string;
		try {
			raw = await fs.readFile(filePath, "utf8");
		} catch {
			continue; // Missing file is fine.
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw new Error(`Malformed MCP config ${filePath}: ${(error as Error).message}`);
		}

		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			warnings.push(`${filePath}: expected a JSON object, ignoring file`);
			continue;
		}

		const mcpServers = (parsed as Record<string, unknown>).mcpServers;
		if (mcpServers === undefined) {
			warnings.push(`${filePath}: missing "mcpServers" key, ignoring file`);
			continue;
		}
		if (typeof mcpServers !== "object" || mcpServers === null || Array.isArray(mcpServers)) {
			warnings.push(`${filePath}: "mcpServers" must be an object, ignoring file`);
			continue;
		}

		for (const [name, value] of Object.entries(mcpServers as Record<string, unknown>)) {
			const expanded = expandEnvDeep(value) as Record<string, unknown>;
			const config = normalizeServerConfig(name, expanded, filePath, warnings);
			if (config) servers[name] = config; // Later files override earlier ones.
		}
	}

	return { servers, warnings };
}

function normalizeServerConfig(
	name: string,
	value: Record<string, unknown>,
	filePath: string,
	warnings: string[],
): McpServerConfig | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		warnings.push(`${filePath}: server "${name}" must be an object, skipping`);
		return null;
	}

	const config: McpServerConfig = {};
	const hasCommand = typeof value.command === "string" && value.command.trim().length > 0;
	const hasUrl = typeof value.url === "string" && value.url.trim().length > 0;

	if (hasCommand === hasUrl) {
		warnings.push(`${filePath}: server "${name}" needs exactly one of "command" (stdio) or "url" (http), skipping`);
		return null;
	}

	if (hasCommand) {
		config.command = (value.command as string).trim();
		if (value.args !== undefined) {
			if (!Array.isArray(value.args) || value.args.some((a) => typeof a !== "string")) {
				warnings.push(`${filePath}: server "${name}" has invalid "args" (must be string array), skipping`);
				return null;
			}
			config.args = value.args as string[];
		}
		if (value.env !== undefined) {
			if (!isStringRecord(value.env)) {
				warnings.push(`${filePath}: server "${name}" has invalid "env" (must be string map), skipping`);
				return null;
			}
			config.env = value.env;
		}
		if (value.cwd !== undefined) {
			if (typeof value.cwd !== "string") {
				warnings.push(`${filePath}: server "${name}" has invalid "cwd", skipping`);
				return null;
			}
			config.cwd = expandHome(value.cwd);
		}
		if (value.headersCommand !== undefined) {
			warnings.push(
				`${filePath}: server "${name}" has "headersCommand" but stdio servers cannot use it (http only), ignoring`,
			);
		}
	} else {
		config.url = (value.url as string).trim();
		if (value.headers !== undefined) {
			if (!isStringRecord(value.headers)) {
				warnings.push(`${filePath}: server "${name}" has invalid "headers" (must be string map), skipping`);
				return null;
			}
			config.headers = value.headers;
		}
		if (value.headersCommand !== undefined) {
			if (typeof value.headersCommand !== "string" || value.headersCommand.trim().length === 0) {
				warnings.push(
					`${filePath}: server "${name}" has invalid "headersCommand" (must be a non-empty string), ignoring`,
				);
			} else {
				config.headersCommand = value.headersCommand;
			}
		}
	}

	if (value.enabled !== undefined) {
		config.enabled = value.enabled === true;
	}
	config.timeout = parsePositiveNumber(value.timeout, filePath, name, "timeout", warnings) ?? 30_000;
	config.callTimeout = parsePositiveNumber(value.callTimeout, filePath, name, "callTimeout", warnings) ?? 120_000;
	return config;
}

function parsePositiveNumber(
	value: unknown,
	filePath: string,
	server: string,
	field: string,
	warnings: string[],
): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		warnings.push(`${filePath}: server "${server}" has invalid "${field}" (must be a non-negative number), using default`);
		return undefined;
	}
	return value;
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.values(value).every((v) => typeof v === "string")
	);
}

function expandHome(input: string): string {
	if (input === "~") return os.homedir();
	if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(os.homedir(), input.slice(2));
	return input;
}

/** Recursively expand ${VAR} (and $VAR) from process.env in all string values. */
export function expandEnvDeep(value: unknown): unknown {
	if (typeof value === "string") return expandEnvString(value);
	if (Array.isArray(value)) return value.map(expandEnvDeep);
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			out[key] = expandEnvDeep(item);
		}
		return out;
	}
	return value;
}

export function expandEnvString(input: string): string {
	// ${VAR} form (preferred); unmatched variables expand to "".
	let result = input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? "");
	// Bare $VAR form for compatibility; leave a lone "$" untouched.
	result = result.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => process.env[name] ?? "");
	return result;
}
