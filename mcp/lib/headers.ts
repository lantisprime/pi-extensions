// headersCommand support: run a shell command that prints a JSON object of
// HTTP headers (e.g. {"Authorization": "Bearer ..."}), for MCP servers that
// require short-lived tokens minted at connect time. Mirrors Claude Code's
// `headersHelper` contract: the command's stdout is the headers JSON; secrets
// never appear in argv, URLs, or error messages.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const COMMAND_TIMEOUT_MS = 15_000;
const MAX_STDOUT_BYTES = 64 * 1024;

/**
 * Run `sh -c <command>` and parse its stdout as a JSON object of string
 * header values. Throws with a secret-free message on failure.
 */
export async function runHeadersCommand(command: string): Promise<Record<string, string>> {
	let stdout: string;
	try {
		({ stdout } = await execFileP("/bin/sh", ["-c", command], {
			timeout: COMMAND_TIMEOUT_MS,
			maxBuffer: MAX_STDOUT_BYTES,
		}));
	} catch (error) {
		// Never include err.message or stderr: both can embed the command text
		// or the secret it fetches. Exit code / signal only.
		throw new Error(`headersCommand failed (${describeFailure(error)})`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error("headersCommand stdout is not valid JSON");
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed) ||
		!Object.values(parsed).every((v) => typeof v === "string")
	) {
		throw new Error("headersCommand stdout must be a JSON object with string values");
	}
	return parsed as Record<string, string>;
}

/** Merge a static header map with freshly minted headers (fresh wins). */
export function mergeHeaders(
	base: Record<string, string> | undefined,
	fresh: Record<string, string>,
): Record<string, string> {
	return { ...(base ?? {}), ...fresh };
}

/**
 * Resolve pi's built-in-style dynamic header values: a value starting with
 * "!" is a shell command (`sh -c`) whose entire stdout becomes the header
 * value (the `!command` contract in pi's mcp.json). Static values pass
 * through. Evaluated at connect time and again after a 401. Throws with a
 * secret-free message on failure.
 */
export async function resolveInlineHeaders(
	headers: Record<string, string> | undefined,
): Promise<Record<string, string> | undefined> {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		resolved[key] = value.startsWith("!") ? await runValueCommand(value.slice(1), "header") : value;
	}
	return resolved;
}

/**
 * Resolve "!cmd" env values (same contract as headers, applied to a stdio
 * server's env map). Other values pass through unchanged; ${VAR} expansion
 * is the config loader's job and has already happened by this point.
 */
export async function resolveEnvCommands(
	env: Record<string, string> | undefined,
): Promise<Record<string, string> | undefined> {
	if (!env) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		resolved[key] = value.startsWith("!") ? await runValueCommand(value.slice(1), "env") : value;
	}
	return resolved;
}

/** Run one dynamic-value command (`!cmd`): the trimmed stdout is the whole value. */
async function runValueCommand(command: string, what: "header" | "env"): Promise<string> {
	let stdout: string;
	try {
		({ stdout } = await execFileP("/bin/sh", ["-c", command], {
			timeout: COMMAND_TIMEOUT_MS,
			maxBuffer: MAX_STDOUT_BYTES,
		}));
	} catch (error) {
		// Same secret discipline as runHeadersCommand: no err.message, no stderr.
		throw new Error(`${what} command failed (${describeFailure(error)})`);
	}
	const value = stdout.trim();
	if (!value) throw new Error(`${what} command produced empty output`);
	return value;
}

/** Exit code / signal summary for a failed child_process call — secret-free by construction. */
function describeFailure(error: unknown): string {
	const err = error as { code?: number | string; signal?: string; killed?: boolean };
	if (err.killed || err.signal) return `killed by signal ${err.signal ?? "unknown"}`;
	if (typeof err.code === "number") return `exit code ${err.code}`;
	if (err.code === "ENOENT") return "command not found";
	return "non-zero exit";
}
