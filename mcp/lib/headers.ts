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
		const err = error as { stderr?: string; message: string };
		const stderrTail = (err.stderr ?? "").trim().split("\n").slice(-3).join("; ");
		throw new Error(`headersCommand failed: ${stderrTail || err.message}`);
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
