// Jev availability: a cached, fail-safe reachability check.
//
// Why this exists: handing a child a `jev_ask` tool when the gateway is down
// wastes turns on a tool that cannot work. Availability is therefore decided
// BEFORE the tool is offered, and read synchronously (child-args resolution is
// sync) from a small status file the jev extension refreshes.
//
// Fail-safe direction: anything other than a fresh, positive probe counts as
// unavailable, so the default no-Jev behaviour is what you get when in doubt.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Where the probe result is cached. Read by other extensions without importing jev. */
export const JEV_STATUS_PATH_ENV = "JEV_STATUS_PATH";

/** Status file path. Overridable so tests (and alternate PI homes) stay hermetic. */
export function jevStatusPath(): string {
	const override = process.env[JEV_STATUS_PATH_ENV]?.trim();
	return override && override.length > 0
		? override
		: join(homedir(), ".pi", "agent", "jev-status.json");
}

/** A status older than this is treated as unknown -> unavailable. */
export const JEV_STATUS_TTL_MS = 5 * 60_000;

/** Short timeout: this is a liveness check, not a real request. */
export const JEV_PROBE_TIMEOUT_MS = 8_000;

export type JevStatus = {
	ok: boolean;
	checkedAt: number;
	endpoint: string;
	/** Populated when !ok, for diagnostics. */
	detail?: string;
};

export type JevAvailability = {
	available: boolean;
	/** "fresh" when a recent probe decided it; otherwise why we fell back. */
	reason: "fresh" | "no-status" | "stale" | "unreadable";
	status?: JevStatus;
};

export function defaultEndpoint(): string {
	return process.env.JEV_ENDPOINT?.trim() || "https://litellm.lab.znp.pw/typesafe/v1/systemone";
}

function resolveKey(): string | undefined {
	const fromEnv = process.env.JEV_API_KEY?.trim();
	if (fromEnv) return fromEnv;
	try {
		const parsed = JSON.parse(
			readFileSync(join(homedir(), ".pi", "agent", "models.json"), "utf8"),
		) as { providers?: Record<string, { apiKey?: string }> };
		return parsed.providers?.litellm?.apiKey;
	} catch {
		return undefined;
	}
}

/**
 * Read the cached availability synchronously. Fail-safe: a missing, stale, or
 * unreadable status means "not available", so callers fall back to the default
 * no-Jev behaviour rather than offering a tool that may not work.
 */
export function readJevAvailabilitySync(now = Date.now()): JevAvailability {
	let raw: string;
	try {
		raw = readFileSync(jevStatusPath(), "utf8");
	} catch {
		return { available: false, reason: "no-status" };
	}
	let status: JevStatus;
	try {
		status = JSON.parse(raw) as JevStatus;
	} catch {
		return { available: false, reason: "unreadable" };
	}
	if (typeof status?.checkedAt !== "number") return { available: false, reason: "unreadable" };
	if (now - status.checkedAt > JEV_STATUS_TTL_MS) return { available: false, reason: "stale", status };
	return { available: status.ok === true, reason: "fresh", status };
}

/** Persist a probe result. Best-effort: a failed write must not break the session. */
export function writeJevStatus(status: JevStatus): void {
	try {
		const target = jevStatusPath();
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, JSON.stringify(status), "utf8");
	} catch {
		// ignore — availability simply stays unknown, which is safe
	}
}

/**
 * Probe Jev with one minimal request. Cheap (a few hundredths of a cent) and
 * bounded by a short timeout. Returns the status and records it.
 */
export async function probeJev(options: { signal?: AbortSignal } = {}): Promise<JevStatus> {
	const endpoint = defaultEndpoint();
	const key = resolveKey();
	if (!key) {
		const status: JevStatus = { ok: false, checkedAt: Date.now(), endpoint, detail: "no credential" };
		writeJevStatus(status);
		return status;
	}

	const timeout = AbortSignal.timeout(JEV_PROBE_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

	let status: JevStatus;
	try {
		const res = await fetch(endpoint, {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				state: "ping",
				model: process.env.JEV_MODEL?.trim() || "jev-latest",
				questions: { ping: { type: "noul", instructions: "Is this a liveness check?" } },
			}),
			signal,
		});
		// 429/529 mean reachable-but-busy: the service IS available, just throttled.
		const ok = res.ok || res.status === 429 || res.status === 529;
		status = {
			ok,
			checkedAt: Date.now(),
			endpoint,
			...(ok ? {} : { detail: `HTTP ${res.status}` }),
		};
	} catch (err) {
		status = {
			ok: false,
			checkedAt: Date.now(),
			endpoint,
			detail: err instanceof Error ? err.message : String(err),
		};
	}
	writeJevStatus(status);
	return status;
}
