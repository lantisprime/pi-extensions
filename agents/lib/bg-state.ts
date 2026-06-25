import { randomBytes as cryptoRandomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";

export const BG_STATE_VERSION = 1;
export const DEFAULT_BG_MAX_CONCURRENT_RUNS = 5;
export const DEFAULT_BG_KEEP_RECENT_RUNS = 20;
export const BG_SESSION_MAC_BYTES = 32;
export const BG_REAP_GRACE_MS = 30_000;
export const BG_MAX_TASK_BYTES = 64_000;
export const BG_MAX_DURATION_SEC = 86_400;

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const SESSION_MAC_FILE = ".session.mac";
const RESERVATION_FILE = ".reserved";
const DONE_FILE = "done";
const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW;

// N1: getpwuid-based home — ignores $HOME, unlike os.homedir().
export function resolveTrustedHome(): string {
	return os.userInfo().homedir;
}

export function assertManifestIdentityMatchesRuntime(m: BgRunManifest, trusted: { homeDir: string }): void {
	if (m.options.homeDir !== trusted.homeDir) throw new Error("manifest homeDir does not match trusted runtime");
	// cwd is advisory identity only — NOT compared (N6).
}

export type BgRunStatus = "reserved" | "running" | "completed" | "failed" | "timed-out" | "stopped" | "unknown";
const VALID_BG_RUN_STATUSES = new Set<BgRunStatus>(["reserved", "running", "completed", "failed", "timed-out", "stopped", "unknown"]);

export type BgAgentIdentity = {
	agentName: string;
	canonicalPath: string;
	expectedHash: string;
};

export type BgRunManifest = {
	version: 1;
	runId: string;
	identity: BgAgentIdentity;
	task: string;
	options: {
		maxDurationSec?: number;
		cwd: string;
		homeDir: string;
	};
	mac: string;
	keyGenId: string;
};

export type BgRunResult = {
	version: 1;
	runId: string;
	status: BgRunStatus;
	agentName?: string;
	startedAt?: string;
	finishedAt?: string;
	resultText?: string;
	error?: string;
};

export type BgRunPaths = {
	runId: string;
	stateDir: string;
	runDir: string;
	manifestPath: string;
	resultPath: string;
	eventsPath: string;
	donePath: string;
	reservationPath: string;
};

export type BgRunSummary = BgRunPaths & {
	createdAtMs: number;
	updatedAtMs: number;
	reserved: boolean;
	done: boolean;
	status: BgRunStatus;
	quarantined?: boolean;
};

export type BgReservation = {
	pid: number;
	ownerHandle?: string;
	startedAtMs: number;
	effectiveTimeoutSec: number;
	keyGenId: string;
};

export type CreateBgRunOptions = {
	homeDir?: string;
	runId?: string;
	generateRunId?: () => string;
	maxConcurrentRuns?: number;
	maxAttempts?: number;
	ownerHandle?: string;
	effectiveTimeoutSec?: number; // optional-with-default: missing ⇒ BG_MAX_DURATION_SEC (REQ-5)
};

export type CleanupBgStateOptions = {
	homeDir?: string;
	keepRecentRuns?: number;
	removePromptFiles?: boolean;
	removeEventFiles?: boolean;
};

export function getBgStateDir(homeDir = resolveTrustedHome()): string {
	return path.join(homeDir, ".pi", "agent", "bg");
}

export function getBgSessionMacPath(homeDir = resolveTrustedHome()): string {
	return path.join(getBgStateDir(homeDir), SESSION_MAC_FILE);
}

export function getBgRunPaths(runId: string, homeDir = resolveTrustedHome()): BgRunPaths {
	assertValidRunId(runId);
	const stateDir = getBgStateDir(homeDir);
	const runDir = path.join(stateDir, runId);
	return {
		runId,
		stateDir,
		runDir,
		manifestPath: path.join(runDir, "manifest.json"),
		resultPath: path.join(runDir, "result.json"),
		eventsPath: path.join(runDir, "events.jsonl"),
		donePath: path.join(runDir, DONE_FILE),
		reservationPath: path.join(runDir, RESERVATION_FILE),
	};
}

export async function ensureBgStateDir(homeDir = resolveTrustedHome()): Promise<string> {
	const stateDir = getBgStateDir(homeDir);
	await fs.mkdir(homeDir, { recursive: true, mode: 0o700 });
	await ensureDirectoryNoSymlink(path.join(homeDir, ".pi"), 0o700);
	await ensureDirectoryNoSymlink(path.join(homeDir, ".pi", "agent"), 0o700);
	await ensureDirectoryNoSymlink(stateDir, 0o700);
	return stateDir;
}

export async function readOrCreateSessionMacKey(homeDir = resolveTrustedHome(), randomBytes: (size: number) => Buffer = cryptoRandomBytes): Promise<Buffer> {
	await ensureBgStateDir(homeDir);
	await assertBgStateRootSafe(getBgStateDir(homeDir));
	const keyPath = getBgSessionMacPath(homeDir);
	try {
		return parseSessionMac(await readUtf8FileNoSymlink(keyPath, "session MAC key", { requirePrivate: true }), keyPath);
	} catch (error) {
		if ((error as { code?: string }).code !== "ENOENT") throw error;
	}

	const key = randomBytes(BG_SESSION_MAC_BYTES);
	const text = `${key.toString("hex")}\n`;
	try {
		await fs.writeFile(keyPath, text, { mode: 0o600, flag: "wx" });
		return key;
	} catch (error) {
		if ((error as { code?: string }).code === "EEXIST") {
			return parseSessionMac(await readUtf8FileNoSymlink(keyPath, "session MAC key", { requirePrivate: true }), keyPath);
		}
		throw error;
	}
}

export async function readSessionMacKey(homeDir = resolveTrustedHome()): Promise<Buffer> {
	await assertBgStateRootSafe(getBgStateDir(homeDir));
	const keyPath = getBgSessionMacPath(homeDir);
	return parseSessionMac(await readUtf8FileNoSymlink(keyPath, "session MAC key", { requirePrivate: true }), keyPath);
}

export async function deleteSessionMacKey(homeDir = resolveTrustedHome()): Promise<void> {
	await assertBgStateRootSafe(getBgStateDir(homeDir));
	const keyPath = getBgSessionMacPath(homeDir);
	await assertNoSymlink(keyPath, "session MAC key");
	await fs.rm(keyPath, { force: true });
}

export function signBgPayload(payload: unknown, key: Buffer): string {
	return createHmac("sha256", key).update(canonicalJson(payload)).digest("hex");
}

export function verifyBgPayloadMac(payload: unknown, key: Buffer, mac: string): boolean {
	if (!/^[0-9a-f]{64}$/i.test(mac)) return false;
	const expected = Buffer.from(signBgPayload(payload, key), "hex");
	const actual = Buffer.from(mac, "hex");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function keyGenIdFromKey(key: Buffer): string {
	return createHmac("sha256", key).update("keygen").digest("hex").slice(0, 8);
}

export function signBgManifest(m: Omit<BgRunManifest, "mac">, key: Buffer): string {
	return signBgPayload(m, key);
}

export function verifyBgManifest(m: BgRunManifest, key: Buffer): boolean {
	const copy = { ...m, mac: undefined };
	return verifyBgPayloadMac(copy, key, m.mac) && m.keyGenId === keyGenIdFromKey(key);
}

export function generateBgRunId(randomBytes: (size: number) => Buffer = cryptoRandomBytes): string {
	return `bg-${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
}

export async function createBgRunState(options: CreateBgRunOptions = {}): Promise<BgRunPaths> {
	const homeDir = options.homeDir ?? resolveTrustedHome();
	await ensureBgStateDir(homeDir);
	const maxConcurrentRuns = options.maxConcurrentRuns ?? DEFAULT_BG_MAX_CONCURRENT_RUNS;
	const maxAttempts = options.maxAttempts ?? 16;
	if (!Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1) throw new Error("maxConcurrentRuns must be a positive integer");
	if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts must be a positive integer");

	const activeBefore = await countActiveBgRuns(homeDir);
	if (activeBefore >= maxConcurrentRuns) {
		throw new Error(`background agent concurrency limit reached (${maxConcurrentRuns})`);
	}

	let lastError: unknown;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const runId = options.runId ?? options.generateRunId?.() ?? generateBgRunId();
		const paths = getBgRunPaths(runId, homeDir);
		try {
			await assertBgStateRootSafe(paths.stateDir);
			await fs.mkdir(paths.runDir, { mode: 0o700 });
			const reservation: BgReservation = {
				pid: process.pid,
				ownerHandle: options.ownerHandle,
				startedAtMs: Date.now(),
				effectiveTimeoutSec: options.effectiveTimeoutSec ?? BG_MAX_DURATION_SEC,
				keyGenId: keyGenIdFromKey(await readOrCreateSessionMacKey(homeDir)),
			};
			await fs.writeFile(paths.reservationPath, `${JSON.stringify(reservation)}\n`, { mode: 0o600, flag: "wx" });
			const activeAfter = await countActiveBgRuns(homeDir);
			if (activeAfter > maxConcurrentRuns) {
				await fs.rm(paths.runDir, { recursive: true, force: true });
				throw new Error(`background agent concurrency limit reached (${maxConcurrentRuns})`);
			}
			return paths;
		} catch (error) {
			lastError = error;
			if ((error as { code?: string }).code === "EEXIST") {
				await assertExistingRunPathIsNotSymlink(paths.runDir);
				if (options.runId) throw error;
				continue;
			}
			throw error;
		}
	}
	throw new Error(`could not allocate background run id after ${maxAttempts} attempts: ${String(lastError)}`);
}

async function readReservation(paths: BgRunPaths): Promise<BgReservation> {
	const fallback: BgReservation = { pid: 0, startedAtMs: Date.now(), effectiveTimeoutSec: BG_MAX_DURATION_SEC, keyGenId: "" };
	let raw: string;
	try {
		raw = await readUtf8FileNoSymlink(paths.reservationPath, "reservation file");
	} catch (error) {
		void error;
		return fallback;
	}
	let r: Record<string, unknown>;
	try {
		r = JSON.parse(raw);
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		return fallback;
	}
	const startedAtMs = (typeof r.startedAtMs === "number" && Number.isFinite(r.startedAtMs) && r.startedAtMs <= Date.now())
		? r.startedAtMs : Date.now();
	const effectiveTimeoutSec = (Number.isInteger(r.effectiveTimeoutSec) && (r.effectiveTimeoutSec as number) > 0)
		? (r.effectiveTimeoutSec as number) : BG_MAX_DURATION_SEC;
	return {
		pid: typeof r.pid === "number" ? r.pid : 0,
		ownerHandle: typeof r.ownerHandle === "string" ? r.ownerHandle : undefined,
		startedAtMs,
		effectiveTimeoutSec,
		keyGenId: typeof r.keyGenId === "string" ? r.keyGenId : "",
	};
}

function isReservationExpired(r: BgReservation): boolean {
	return Date.now() - r.startedAtMs > r.effectiveTimeoutSec * 1000 + BG_REAP_GRACE_MS;
}

export async function listBgRuns(homeDir = resolveTrustedHome()): Promise<BgRunSummary[]> {
	const stateDir = await ensureBgStateDir(homeDir);
	let entries: string[];
	try {
		entries = await fs.readdir(stateDir);
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return [];
		throw error;
	}
	const runs: BgRunSummary[] = [];
	for (const entry of entries.sort()) {
		if (entry.startsWith(".")) continue;
		if (!RUN_ID_PATTERN.test(entry)) continue;
		const paths = getBgRunPaths(entry, homeDir);
		let stat;
		try {
			stat = await fs.lstat(paths.runDir);
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") continue;
			throw error;
		}
		if (stat.isSymbolicLink()) {
			runs.push({ ...paths, createdAtMs: 0, updatedAtMs: 0, reserved: true, done: false, status: "unknown", quarantined: true });
			continue;
		}
		if (!stat.isDirectory()) continue;
		const reserved = await existsRegularFileNoSymlink(paths.reservationPath);
		const done = await existsRegularFileNoSymlink(paths.donePath);
		runs.push({
			...paths,
			createdAtMs: stat.birthtimeMs,
			updatedAtMs: stat.mtimeMs,
			reserved,
			done,
			status: done ? await readResultStatus(paths.resultPath) : reserved ? "reserved" : "unknown",
		});
	}
	return runs.sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.runId.localeCompare(b.runId));
}

export async function countActiveBgRuns(homeDir = resolveTrustedHome()): Promise<number> {
	const runs = await listBgRuns(homeDir);
	const active = await Promise.all(runs.map(async (run) => {
		if (run.done) return false;
		if (run.quarantined) return true;            // active-unless-proven-done (REQ-7)
		if (!run.reserved) return false;
		return !isReservationExpired(await readReservation(getBgRunPaths(run.runId, homeDir)));
	}));
	return active.filter(Boolean).length;
}

export async function reapStaleBgRuns(
	homeDir = resolveTrustedHome(),
	opts?: { isAlive?: (h: string) => boolean },
): Promise<{ reapedRunIds: string[] }> {
	const reapedRunIds: string[] = [];
	for (const run of await listBgRuns(homeDir)) {
		if (run.done || !run.reserved) continue;
		const paths = getBgRunPaths(run.runId, homeDir);
		const r = await readReservation(paths);
		const expired = isReservationExpired(r);
		const dead = opts?.isAlive && r.ownerHandle ? !opts.isAlive(r.ownerHandle) : false;
		if (!expired && !dead) continue;
		try {
			await writeBgResult(paths, { version: 1, runId: run.runId, status: expired ? "timed-out" : "stopped" });
			await markBgRunDone(paths);
			reapedRunIds.push(run.runId);
		} catch (error) {
			const code = (error as { code?: string }).code;
			if (code === "ENOENT" || code === "EEXIST" || /already done|not reserved/.test(String((error as Error).message))) continue;
			throw error;
		}
	}
	return { reapedRunIds };
}

export async function retireSessionMacKeyIfFullyIdle(homeDir = resolveTrustedHome()): Promise<boolean> {
	const runs = await listBgRuns(homeDir);
	for (const run of runs) {
		if (run.quarantined) return false;
		if (run.reserved && !run.done) return false;
	}
	await deleteSessionMacKey(homeDir);
	return true;
}

export async function writeBgManifest(paths: BgRunPaths, manifest: BgRunManifest): Promise<void> {
	assertSameRun(paths, manifest.runId);
	await assertWritableReservedRun(paths);
	await writeJsonAtomic(paths.manifestPath, manifest, 0o600);
}

const ALLOWED_MANIFEST_KEYS = new Set(["version", "runId", "identity", "task", "options", "mac", "keyGenId"]);
const ALLOWED_OPTIONS_KEYS = new Set(["cwd", "homeDir", "maxDurationSec"]);
const IDENTITY_KEYS = new Set(["agentName", "canonicalPath", "expectedHash"]);
const HEX64_RE = /^[0-9a-f]{64}$/;
const HEX8_RE = /^[0-9a-f]{8}$/;

export async function readBgManifest(paths: BgRunPaths): Promise<BgRunManifest> {
	const raw = await readUtf8FileNoSymlink(paths.manifestPath, "manifest");
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("manifest is not valid JSON");
	}
	if (typeof parsed !== "object" || parsed === null) throw new Error("manifest is not an object");

	for (const key of Object.keys(parsed)) {
		if (!ALLOWED_MANIFEST_KEYS.has(key)) throw new Error(`unknown manifest key: ${key}`);
	}

	if (parsed.version !== 1) throw new Error("manifest version must be 1");
	if (typeof parsed.runId !== "string" || parsed.runId !== paths.runId) throw new Error("manifest runId mismatch");

	const identity = parsed.identity as Record<string, unknown> | undefined;
	if (typeof identity !== "object" || identity === null) throw new Error("manifest identity must be an object");
	for (const k of Object.keys(identity)) {
		if (!IDENTITY_KEYS.has(k)) throw new Error(`unknown manifest identity key: ${k}`);
	}
	if (typeof identity.agentName !== "string" || !identity.agentName) throw new Error("manifest identity.agentName must be a non-empty string");
	if (typeof identity.canonicalPath !== "string" || !identity.canonicalPath) throw new Error("manifest identity.canonicalPath must be a non-empty string");
	if (typeof identity.expectedHash !== "string" || !/^[0-9a-f]{64}$/.test(identity.expectedHash)) throw new Error("manifest identity.expectedHash must be a 64-char hex string");

	if (typeof parsed.task !== "string") throw new Error("manifest task must be a string");
	if (Buffer.byteLength(parsed.task, "utf8") > BG_MAX_TASK_BYTES) throw new Error("manifest task exceeds max bytes");

	const options = parsed.options as Record<string, unknown> | undefined;
	if (typeof options !== "object" || options === null) throw new Error("manifest options must be an object");
	for (const k of Object.keys(options)) {
		if (!ALLOWED_OPTIONS_KEYS.has(k)) throw new Error(`unknown manifest options key: ${k}`);
	}
	if (typeof options.cwd !== "string") throw new Error("manifest options.cwd must be a string");
	if (typeof options.homeDir !== "string") throw new Error("manifest options.homeDir must be a string");
	if (options.maxDurationSec !== undefined && options.maxDurationSec !== null) {
		if (!Number.isInteger(options.maxDurationSec) || (options.maxDurationSec as number) < 1 || (options.maxDurationSec as number) > BG_MAX_DURATION_SEC) {
			throw new Error("manifest options.maxDurationSec must be an integer between 1 and BG_MAX_DURATION_SEC");
		}
	}

	if (typeof parsed.mac !== "string" || !HEX64_RE.test(parsed.mac)) throw new Error("manifest mac must be a 64-char hex string");
	if (typeof parsed.keyGenId !== "string" || !HEX8_RE.test(parsed.keyGenId)) throw new Error("manifest keyGenId must be an 8-char hex string");

	return parsed as unknown as BgRunManifest;
}

export async function writeBgResult(paths: BgRunPaths, result: BgRunResult): Promise<void> {
	assertSameRun(paths, result.runId);
	await assertWritableReservedRun(paths);
	await writeJsonAtomic(paths.resultPath, result, 0o600);
}

/** Read the result file for a completed/failed/stopped bg run.
 *  Returns undefined if the result file does not exist (e.g. run still in progress). */
export async function readBgResult(paths: BgRunPaths): Promise<BgRunResult | undefined> {
	try {
		const raw = await readUtf8FileNoSymlink(paths.resultPath, "result file");
		return JSON.parse(raw) as BgRunResult;
	} catch {
		return undefined;
	}
}

export async function appendBgEvent(paths: BgRunPaths, event: unknown): Promise<void> {
	await assertWritableReservedRun(paths);
	await appendUtf8FileNoSymlink(paths.eventsPath, `${JSON.stringify(event)}\n`, 0o600, "events file");
}

export async function markBgRunDone(paths: BgRunPaths): Promise<void> {
	await assertReservedRun(paths);
	await createEmptyFileNoSymlink(paths.donePath, 0o600, "done sentinel");
	await fs.rm(paths.reservationPath, { force: true });
}

async function writeJsonAtomic(filePath: string, value: unknown, mode = 0o600): Promise<void> {
	await assertDirectorySafe(path.dirname(filePath), "atomic write directory");
	await assertNoSymlink(filePath, "atomic write target");
	const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${cryptoRandomBytes(4).toString("hex")}.tmp`);
	try {
		await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: "wx" });
		await fs.rename(tempPath, filePath);
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

export async function cleanupBgStateOnSessionStart(options: CleanupBgStateOptions = {}): Promise<{ prunedRunIds: string[]; removedPromptFiles: string[]; removedEventFiles: string[] }> {
	const homeDir = options.homeDir ?? resolveTrustedHome();
	const keepRecentRuns = options.keepRecentRuns ?? DEFAULT_BG_KEEP_RECENT_RUNS;
	if (!Number.isInteger(keepRecentRuns) || keepRecentRuns < 0) throw new Error("keepRecentRuns must be a non-negative integer");
	const removePromptFiles = options.removePromptFiles ?? true;
	await reapStaleBgRuns(homeDir);
	const runs = await listBgRuns(homeDir);
	const completed = runs.filter((run) => run.done).sort((a, b) => b.updatedAtMs - a.updatedAtMs);
	const prunedRunIds: string[] = [];
	const removedPromptFiles: string[] = [];
	const removedEventFiles: string[] = [];

	for (const run of completed.slice(Math.max(0, keepRecentRuns))) {
		await fs.rm(run.runDir, { recursive: true, force: true });
		prunedRunIds.push(run.runId);
	}

	for (const run of runs.filter((run) => !prunedRunIds.includes(run.runId))) {
		if (removePromptFiles) {
			const promptPath = path.join(run.runDir, "prompt.txt");
			if (await existsRegularFileNoSymlink(promptPath)) {
				await fs.rm(promptPath, { force: true });
				removedPromptFiles.push(promptPath);
			}
		}
		// P4R-6: events.jsonl is retained for kept runs; pruned runs already lose it
	// with their whole dir.
	}

	await retireSessionMacKeyIfFullyIdle(homeDir);
	return { prunedRunIds, removedPromptFiles, removedEventFiles };
}

function assertValidRunId(runId: string): void {
	if (!RUN_ID_PATTERN.test(runId)) {
		throw new Error(`invalid background run id: ${runId}`);
	}
}

async function ensureDirectoryNoSymlink(dirPath: string, mode: number): Promise<void> {
	try {
		const stat = await fs.lstat(dirPath);
		if (stat.isSymbolicLink()) throw new Error(`refusing symlinked directory: ${dirPath}`);
		if (!stat.isDirectory()) throw new Error(`path is not a directory: ${dirPath}`);
		await fs.chmod(dirPath, mode);
		await assertPrivateDirectorySafe(dirPath, "state directory");
		return;
	} catch (error) {
		if ((error as { code?: string }).code !== "ENOENT") throw error;
	}
	await fs.mkdir(dirPath, { mode });
	await assertPrivateDirectorySafe(dirPath, "state directory");
}

async function assertNoSymlink(targetPath: string, label: string): Promise<void> {
	try {
		const stat = await fs.lstat(targetPath);
		if (stat.isSymbolicLink()) throw new Error(`refusing symlinked ${label}: ${targetPath}`);
	} catch (error) {
		if ((error as { code?: string }).code !== "ENOENT") throw error;
	}
}

async function assertRunDirSafe(runDir: string): Promise<void> {
	await assertPrivateDirectorySafe(runDir, "background run directory");
}

async function assertDirectorySafe(dirPath: string, label: string): Promise<void> {
	const stat = await fs.lstat(dirPath);
	if (stat.isSymbolicLink()) throw new Error(`refusing symlinked ${label}: ${dirPath}`);
	if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${dirPath}`);
}

async function assertPrivateDirectorySafe(dirPath: string, label: string): Promise<void> {
	const stat = await fs.lstat(dirPath);
	if (stat.isSymbolicLink()) throw new Error(`refusing symlinked ${label}: ${dirPath}`);
	if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${dirPath}`);
	if ((stat.mode & 0o077) !== 0) throw new Error(`${label} must not be accessible by group or others: ${dirPath}`);
}

async function assertBgStateRootSafe(stateDir: string): Promise<void> {
	const agentDir = path.dirname(stateDir);
	const piDir = path.dirname(agentDir);
	await assertPrivateDirectorySafe(piDir, "state .pi directory");
	await assertPrivateDirectorySafe(agentDir, "state agent directory");
	await assertPrivateDirectorySafe(stateDir, "background state directory");
}

async function assertReservedRun(paths: BgRunPaths): Promise<void> {
	assertCanonicalRunPaths(paths);
	await assertBgStateRootSafe(paths.stateDir);
	await assertRunDirSafe(paths.runDir);
	if (!(await existsRegularFileNoSymlink(paths.reservationPath))) {
		throw new Error(`background run is not reserved: ${paths.runId}`);
	}
}

function assertCanonicalRunPaths(paths: BgRunPaths): void {
	assertValidRunId(paths.runId);
	const agentDir = path.dirname(paths.stateDir);
	const piDir = path.dirname(agentDir);
	if (path.basename(paths.stateDir) !== "bg" || path.basename(agentDir) !== "agent" || path.basename(piDir) !== ".pi") {
		throw new Error(`non-canonical background state directory: ${paths.stateDir}`);
	}
	const expectedRunDir = path.join(paths.stateDir, paths.runId);
	const expected: BgRunPaths = {
		runId: paths.runId,
		stateDir: paths.stateDir,
		runDir: expectedRunDir,
		manifestPath: path.join(expectedRunDir, "manifest.json"),
		resultPath: path.join(expectedRunDir, "result.json"),
		eventsPath: path.join(expectedRunDir, "events.jsonl"),
		donePath: path.join(expectedRunDir, DONE_FILE),
		reservationPath: path.join(expectedRunDir, RESERVATION_FILE),
	};
	for (const key of ["stateDir", "runDir", "manifestPath", "resultPath", "eventsPath", "donePath", "reservationPath"] as const) {
		if (path.resolve(paths[key]) !== path.resolve(expected[key])) {
			throw new Error(`non-canonical background run path '${key}' for ${paths.runId}`);
		}
	}
}

async function assertWritableReservedRun(paths: BgRunPaths): Promise<void> {
	await assertReservedRun(paths);
	if (await existsAnyNoSymlink(paths.donePath)) {
		throw new Error(`background run is already done: ${paths.runId}`);
	}
}

async function assertExistingRunPathIsNotSymlink(runDir: string): Promise<void> {
	try {
		await assertRunDirSafe(runDir);
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return;
		throw error;
	}
}

async function existsRegularFileNoSymlink(targetPath: string): Promise<boolean> {
	try {
		const stat = await fs.lstat(targetPath);
		if (stat.isSymbolicLink()) throw new Error(`refusing symlinked state path: ${targetPath}`);
		return stat.isFile();
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return false;
		throw error;
	}
}

async function existsAnyNoSymlink(targetPath: string): Promise<boolean> {
	try {
		const stat = await fs.lstat(targetPath);
		if (stat.isSymbolicLink()) throw new Error(`refusing symlinked state path: ${targetPath}`);
		return Boolean(stat);
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return false;
		throw error;
	}
}

async function readResultStatus(resultPath: string): Promise<BgRunStatus> {
	try {
		if (!(await existsRegularFileNoSymlink(resultPath))) return "unknown";
		const raw = await readUtf8FileNoSymlink(resultPath, "result file");
		const parsed = JSON.parse(raw) as { status?: unknown };
		return isBgRunStatus(parsed.status) ? parsed.status : "unknown";
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return "unknown";
		if (error instanceof SyntaxError) return "unknown";
		throw error;
	}
}

function isBgRunStatus(value: unknown): value is BgRunStatus {
	return typeof value === "string" && VALID_BG_RUN_STATUSES.has(value as BgRunStatus);
}

async function readUtf8FileNoSymlink(filePath: string, label: string, options: { requirePrivate?: boolean } = {}): Promise<string> {
	const handle = await openNoFollow(filePath, fsConstants.O_RDONLY, label);
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${filePath}`);
		if (options.requirePrivate && (stat.mode & 0o077) !== 0) {
			throw new Error(`${label} must not be readable by group or others: ${filePath}`);
		}
		return await handle.readFile({ encoding: "utf8" });
	} finally {
		await handle.close();
	}
}

async function appendUtf8FileNoSymlink(filePath: string, text: string, mode: number, label: string): Promise<void> {
	const handle = await openNoFollow(filePath, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY, label, mode);
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${filePath}`);
		await handle.writeFile(text);
	} finally {
		await handle.close();
	}
}

async function createEmptyFileNoSymlink(filePath: string, mode: number, label: string): Promise<void> {
	let handle;
	try {
		handle = await openNoFollow(filePath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, label, mode);
		const stat = await handle.stat();
		if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${filePath}`);
	} catch (error) {
		if ((error as { code?: string }).code === "EEXIST" && await existsRegularFileNoSymlink(filePath)) return;
		throw error;
	} finally {
		await handle?.close();
	}
}

async function openNoFollow(filePath: string, flags: number, label: string, mode?: number) {
	if (typeof O_NOFOLLOW !== "number") throw new Error("O_NOFOLLOW is not available; refusing to open state path");
	try {
		return await fs.open(filePath, flags | O_NOFOLLOW, mode);
	} catch (error) {
		if ((error as { code?: string }).code === "ELOOP") throw new Error(`refusing symlinked ${label}: ${filePath}`);
		throw error;
	}
}

function parseSessionMac(text: string, keyPath: string): Buffer {
	const trimmed = text.trim();
	if (!/^[0-9a-f]{64}$/i.test(trimmed)) throw new Error(`invalid background session MAC key: ${keyPath}`);
	return Buffer.from(trimmed, "hex");
}

function assertSameRun(paths: BgRunPaths, runId: string): void {
	if (paths.runId !== runId) throw new Error(`run id mismatch: expected ${paths.runId}, got ${runId}`);
}

function canonicalJson(value: unknown): string {
	if (value === undefined) return "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("non-finite number in signed payload");
		return JSON.stringify(value);
	}
	if (typeof value === "string" || typeof value === "boolean" || value === null) return JSON.stringify(value);
	throw new Error("unsupported type in signed payload: " + typeof value);
}
