// herdr-control: live herdr version probe + compatibility gate.
//
// herdr-control is written against the herdr 0.9.x API (base-36 pane refs,
// 0.9 kinds, `agent start` args after `--`). The live server is the
// authority: we probe `herdr status --json` (schema-validated in schema.ts),
// cache like the entry gate, and fail closed only when the server version is
// *positively known* to be older than MIN_SUPPORTED — a future 1.x or an
// unparseable version warns but proceeds, because our calls are all
// long-stable surface (agent/pane/status verbs unchanged in 0.9.2/0.9.3).
import type { HerdrExecutor } from "./exec.ts";
import { HERDR_SHORT_TIMEOUT_MS, SERVER_STATUS_CACHE_MS, SERVER_STATUS_FAIL_CACHE_MS } from "./constants.ts";
import { schemaParse, HerdrStatusSchema } from "./schema.ts";

export interface HerdrSemanticVersion {
	major: number;
	minor: number;
	patch: number;
}

// First release with the API surface herdr-control assumes end to end:
// base-36 workspace/pane counters (w2:pV), the 0.9 agent-kind list, and
// `agent start ... -- [AGENT_ARG]...`.
export const MIN_SUPPORTED_HERDR: HerdrSemanticVersion = { major: 0, minor: 9, patch: 0 };
export const MIN_SUPPORTED_LABEL = `${MIN_SUPPORTED_HERDR.major}.${MIN_SUPPORTED_HERDR.minor}.${MIN_SUPPORTED_HERDR.patch}`;

export interface HerdrVersionInfo {
	serverVersion: string | null;
	clientVersion: string | null;
	serverRunning: boolean;
	protocol: number | null;
	/** Unix socket path for event subscriptions (server.socket). */
	socketPath: string | null;
}

export function parseVersion(raw: string): HerdrSemanticVersion | null {
	const match = raw.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
	if (!match) return null;
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareVersions(a: HerdrSemanticVersion, b: HerdrSemanticVersion): number {
	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	return a.patch - b.patch;
}

let lastOkAt = 0;
let lastFailAt = 0;
let lastInfo: HerdrVersionInfo | null = null;
let lastFailError = "";

export function resetVersionCache(): void {
	lastOkAt = 0;
	lastFailAt = 0;
	lastInfo = null;
	lastFailError = "";
}

export function lastVersionInfo(): HerdrVersionInfo | null {
	return lastInfo;
}

// Probe `herdr status --json`. Returns info even when the server is down
// (client version still flows); `null` only when herdr itself is unusable.
// Staleness bound: a cached probe result (including a version that has since
// been upgraded) is trusted for up to SERVER_STATUS_CACHE_MS — a freshly
// upgraded server may fail the gate for at most that window before the next
// probe observes the new version. Accepted trade-off, mirrors the gate's own
// reachability cache.
export async function probeVersion(executor: HerdrExecutor): Promise<HerdrVersionInfo | null> {
	const now = Date.now();
	if (lastInfo && now - lastOkAt < SERVER_STATUS_CACHE_MS) return lastInfo;
	if (now - lastFailAt < SERVER_STATUS_FAIL_CACHE_MS) return null;

	const result = await executor.exec(["status", "--json"], { timeoutMs: HERDR_SHORT_TIMEOUT_MS });
	if (!result.ok) {
		lastFailAt = Date.now();
		lastFailError = extractShort(result.stderr);
		return null;
	}
	const status = parseStatusJson(result.stdout);
	if (!status.ok) {
		// Shape drift: don't hard-fail the extension over a version probe.
		lastFailAt = Date.now();
		lastFailError = status.error;
		return null;
	}
	const record = status.value;
	const client = record.client as { version?: string; protocol?: number } | undefined;
	const server = record.server as { version?: string; running?: boolean; protocol?: number } | undefined;
	lastInfo = {
		clientVersion: typeof client?.version === "string" ? client.version : null,
		serverVersion: typeof server?.version === "string" ? server.version : null,
		serverRunning: server?.running === true,
		protocol: typeof server?.protocol === "number" ? server.protocol : typeof client?.protocol === "number" ? client.protocol : null,
		socketPath: typeof server?.socket === "string" ? server.socket : null,
	};
	lastOkAt = Date.now();
	return lastInfo;
}

export type Compatibility =
	| { compatible: true; info: HerdrVersionInfo }
	| { compatible: false; error: string }
	| { compatible: true; warning: string }; // unknown version: warn, proceed

// Fail closed only on a positively-identified older server. Unknown/newer
// versions pass with (possibly empty) guidance.
export async function checkVersionCompatibility(executor: HerdrExecutor): Promise<Compatibility> {
	const info = await probeVersion(executor);
	if (!info) return { compatible: true, warning: `herdr version unknown (${lastFailError}); continuing against the installed CLI.` };

	const raw = info.serverVersion ?? info.clientVersion;
	if (!raw) return { compatible: true, warning: "herdr did not report a version; continuing." };
	const version = parseVersion(raw);
	if (!version) return { compatible: true, warning: `herdr version "${raw}" not recognized; continuing.` };

	if (compareVersions(version, MIN_SUPPORTED_HERDR) < 0) {
		return {
			compatible: false,
			error:
				`herdr ${raw} is older than the minimum this extension supports (${MIN_SUPPORTED_LABEL}). ` +
				`herdr-control targets the 0.9.x CLI (base-36 pane refs, current agent kinds, agent start args). ` +
				`Run 'herdr update' and restart the herdr server, then retry.`,
		};
	}
	return { compatible: true, info };
}

function extractShort(stderr: string): string {
	const line = stderr.trim().split("\n").find((l) => l.trim());
	return truncate(line ?? `exit status non-zero`, 160);
}

function truncate(s: string, n: number): string {
	return s.length <= n ? s : s.slice(0, n) + "...";
}

// `herdr status --json` prints the status object directly (no {id,result}
// envelope). Accept both shapes defensively; validate with HerdrStatusSchema.
function parseStatusJson(stdout: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
	const trimmed = stdout.trim();
	if (!trimmed) return { ok: false, error: "herdr status returned empty output" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { ok: false, error: `herdr status returned non-JSON output: ${truncate(trimmed, 160)}` };
	}
	const record = parsed as Record<string, unknown> | null;
	if (record && typeof record === "object" && "id" in record && "result" in record) {
		parsed = record.result; // envelope-wrapped variant
	}
	return schemaParse<Record<string, unknown>>(HerdrStatusSchema, parsed);
}
