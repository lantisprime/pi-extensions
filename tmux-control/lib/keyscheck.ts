// tmux-control: extended-keys check (P5c-2-S4).
//
// Warn-only diagnostic: checks that tmux >= 3.5 and extended-keys-format is
// set to "csi-u". Returns {ok:false} with a warning message when either
// condition fails. Never mutates tmux options, never throws.
//
// Why it matters:
//   Without extended-keys-format=csi-u, modern TUIs cannot distinguish
//   Enter from Shift+Enter, Tab from C-i, or modified arrow keys. The
//   keys-mode feature (S5) depends on this disambiguation.
//
// The check is fire-and-forget at session_start — it does not block
// command/tool/hook registration (REQ-14).
//
// Argv-only: both tmux invocations use the executor's execFile interface
// (no shell, no string concatenation).
import type { TmuxExecutor } from "./exec.ts";
import { TMUX_INVOCATION_TIMEOUT_MS } from "./constants.ts";

export interface KeysCheckResult {
	ok: boolean;
	/** extended-keys-format value ("csi-u", "xterm-keys", etc.), if read successfully. */
	format?: string;
	/** tmux version string as reported by `tmux -V` (e.g. "tmux 3.6a"). */
	version?: string;
	/** Human-readable warning when check fails. Omitted on success. */
	warning?: string;
}

/**
 * Parse "tmux 3.6a" → {major: 3, minor: 6} or null on failure.
 * Handles leading "tmux " prefix, trailing suffixes like "a", and
 * "next-" / "openbsd-" prefixes.
 */
function parseVersion(versionStr: string): { major: number; minor: number } | null {
	// Strip "tmux " prefix if present, then strip known release prefixes
	// ("next-", "openbsd-") that appear between "tmux" and the version number.
	let trimmed = versionStr.replace(/^tmux\s+/i, "");
	trimmed = trimmed.replace(/^(next|openbsd)-/, "");
	trimmed = trimmed.trim();
	const m = trimmed.match(/^(\d+)\.(\d+)/);
	if (!m) return null;
	return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10) };
}

/**
 * Check that tmux >= 3.5 and extended-keys-format === "csi-u".
 *
 * Makes two executor calls:
 *   1. `tmux -V` — version check (no socket needed; `-V` works without a server).
 *   2. `tmux show-option -gv extended-keys-format` — queries the server's
 *      global option through the provided socket prefix.
 *
 * Both calls are bounded by TMUX_INVOCATION_TIMEOUT_MS.
 *
 * Returns {ok:true} only when version >= 3.5 AND format === "csi-u".
 * Returns {ok:false, warning} with a descriptive message on any failure path.
 */
export async function checkExtendedKeys(
	executor: TmuxExecutor,
	socketPrefix: string[],
): Promise<KeysCheckResult> {
	// Step 1: tmux -V (no socket required — version query works offline).
	let vExec;
	try {
		vExec = await executor.exec(["-V"], {
			timeoutMs: TMUX_INVOCATION_TIMEOUT_MS,
		});
	} catch (err: any) {
		return {
			ok: false,
			warning: `tmux version check threw: ${err?.message || String(err)}`,
		};
	}

	if (!vExec.ok) {
		return {
			ok: false,
			warning: `tmux version check failed: ${vExec.stderr || `exit ${vExec.exitCode}`}`,
		};
	}

	const versionStr = vExec.stdout.trim();
	const version = parseVersion(versionStr);
	if (!version) {
		return {
			ok: false,
			version: versionStr,
			warning: `could not parse tmux version from "${versionStr}"`,
		};
	}

	// extended-keys-format requires tmux >= 3.5.
	if (version.major < 3 || (version.major === 3 && version.minor < 5)) {
		return {
			ok: false,
			version: versionStr,
			warning:
				`tmux ${version.major}.${version.minor} does not support extended-keys-format (need >= 3.5). ` +
				"Modified key chords (C-c, S-Enter, etc.) may be silently mangled.",
		};
	}

	// Step 2: read extended-keys-format global option.
	let optExec;
	try {
		optExec = await executor.exec(
			[...socketPrefix, "show-option", "-gv", "extended-keys-format"],
			{ timeoutMs: TMUX_INVOCATION_TIMEOUT_MS },
		);
	} catch (err: any) {
		return {
			ok: false,
			version: versionStr,
			warning:
				`could not read extended-keys-format option: ${err?.message || String(err)}`,
		};
	}

	if (!optExec.ok) {
		return {
			ok: false,
			version: versionStr,
			warning:
				`could not read extended-keys-format option: ${optExec.stderr || `exit ${optExec.exitCode}`}`,
		};
	}

	const format = optExec.stdout.trim();
	if (format === "csi-u") {
		return { ok: true, format, version: versionStr };
	}

	return {
		ok: false,
		format,
		version: versionStr,
		warning:
			`tmux extended-keys-format is "${format}" (expected "csi-u"). ` +
			"Modified key chords (C-c, S-Enter, etc.) may be silently mangled. " +
			"Set with: tmux set-option -g extended-keys-format csi-u",
	};
}
