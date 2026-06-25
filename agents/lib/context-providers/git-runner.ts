import { spawn as nodeSpawn } from "node:child_process";

/** P9: read-only git access for the parent-side context-provider layer.
 *  The TRUSTED parent shells git (sandboxed children never get git/bash — P3_FORBIDDEN_TOOLS).
 *  Runner is injectable so tests pass canned output with no real repo. */

export type GitResult = {
	/** true iff git exited 0. */
	ok: boolean;
	stdout: string;
	stderr: string;
	code: number | null;
};

export type GitRunner = (args: readonly string[], opts: { cwd: string; maxBytes?: number }) => Promise<GitResult>;

/** Git ref / token guard. Refs come from git's own output (merge-base, branch names) or a
 *  code-owned default, never from the diff content — but we still fail-closed on anything that
 *  could be argv option-injection (leading '-') or shell-ish. Mirrors child-args' SAFE_CLI_TOKEN_RE
 *  intent: first char must be alnum, so '--upload-pack=…' and '-O' are rejected. */
const SAFE_GIT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/@^~-]{0,255}$/;

export function isSafeGitRef(ref: string): boolean {
	return typeof ref === "string" && SAFE_GIT_REF_RE.test(ref);
}

/** Throw on an unsafe ref so a caller can fail-soft. Pathspecs are always passed after a literal
 *  "--" separator by callers, so a filename can never be read as an option. */
export function assertSafeGitRef(ref: string): string {
	if (!isSafeGitRef(ref)) throw new Error(`unsafe git ref: ${JSON.stringify(ref)}`);
	return ref;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB safety cap on a single git invocation's stdout

/** Default runner: spawn git with an argv ARRAY (never a shell string), capture stdout up to a
 *  byte cap, and resolve a structured result. NEVER rejects — a spawn failure (git missing) or a
 *  non-zero exit is reported via {ok:false}, so providers degrade soft (N3) instead of throwing
 *  out of best-effort dispatch. */
export const defaultGitRunner: GitRunner = (args, opts) => {
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	return new Promise<GitResult>((resolve) => {
		let child: ReturnType<typeof nodeSpawn>;
		try {
			child = nodeSpawn("git", ["--no-pager", ...args], { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			resolve({ ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error), code: null });
			return;
		}
		const outChunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		let outBytes = 0;
		let truncated = false;
		child.stdout?.on("data", (chunk: Buffer) => {
			if (truncated) return;
			if (outBytes + chunk.length > maxBytes) {
				outChunks.push(chunk.subarray(0, Math.max(0, maxBytes - outBytes)));
				truncated = true;
				try { child.kill("SIGKILL"); } catch { /* already gone */ }
				return;
			}
			outBytes += chunk.length;
			outChunks.push(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => { if (errChunks.length < 64) errChunks.push(chunk); });
		child.on("error", (error: Error) => {
			resolve({ ok: false, stdout: Buffer.concat(outChunks).toString("utf8"), stderr: error.message, code: null });
		});
		child.on("close", (code: number | null) => {
			resolve({
				ok: code === 0 && !truncated,
				stdout: Buffer.concat(outChunks).toString("utf8"),
				stderr: Buffer.concat(errChunks).toString("utf8"),
				code,
			});
		});
	});
};
