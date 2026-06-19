import { randomBytes as cryptoRandomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";

export const BG_STATE_VERSION = 1;
export const DEFAULT_BG_MAX_CONCURRENT_RUNS = 5;
export const DEFAULT_BG_KEEP_RECENT_RUNS = 20;
export const BG_SESSION_MAC_BYTES = 32;

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const SESSION_MAC_FILE = ".session.mac";
const RESERVATION_FILE = ".reserved";
const DONE_FILE = "done";
const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW;

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
};

export type CreateBgRunOptions = {
	homeDir?: string;
	runId?: string;
	generateRunId?: () => string;
	maxConcurrentRuns?: number;
	maxAttempts?: number;
};

export type CleanupBgStateOptions = {
	homeDir?: string;
	keepRecentRuns?: number;
	removePromptFiles?: boolean;
	removeEventFiles?: boolean;
};

export function getBgStateDir(homeDir = os.homedir()): string {
	return path.join(homeDir, ".pi", "agent", "bg");
}

export function getBgSessionMacPath(homeDir = os.homedir()): string {
	return path.join(getBgStateDir(homeDir), SESSION_MAC_FILE);
}

export function getBgRunPaths(runId: string, homeDir = os.homedir()): BgRunPaths {
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

export async function ensureBgStateDir(homeDir = os.homedir()): Promise<string> {
	const stateDir = getBgStateDir(homeDir);
	await fs.mkdir(homeDir, { recursive: true, mode: 0o700 });
	await ensureDirectoryNoSymlink(path.join(homeDir, ".pi"), 0o700);
	await ensureDirectoryNoSymlink(path.join(homeDir, ".pi", "agent"), 0o700);
	await ensureDirectoryNoSymlink(stateDir, 0o700);
	return stateDir;
}

export async function readOrCreateSessionMacKey(homeDir = os.homedir(), randomBytes: (size: number) => Buffer = cryptoRandomBytes): Promise<Buffer> {
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

export async function readSessionMacKey(homeDir = os.homedir()): Promise<Buffer> {
	await assertBgStateRootSafe(getBgStateDir(homeDir));
	const keyPath = getBgSessionMacPath(homeDir);
	return parseSessionMac(await readUtf8FileNoSymlink(keyPath, "session MAC key", { requirePrivate: true }), keyPath);
}

export async function deleteSessionMacKey(homeDir = os.homedir()): Promise<void> {
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

export function generateBgRunId(randomBytes: (size: number) => Buffer = cryptoRandomBytes): string {
	return `bg-${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
}

export async function createBgRunState(options: CreateBgRunOptions = {}): Promise<BgRunPaths> {
	const homeDir = options.homeDir ?? os.homedir();
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
			await fs.writeFile(paths.reservationPath, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
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

export async function listBgRuns(homeDir = os.homedir()): Promise<BgRunSummary[]> {
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
		if (stat.isSymbolicLink()) throw new Error(`refusing symlinked background run directory: ${paths.runDir}`);
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

export async function countActiveBgRuns(homeDir = os.homedir()): Promise<number> {
	const runs = await listBgRuns(homeDir);
	return runs.filter((run) => run.reserved && !run.done).length;
}

export async function writeBgManifest(paths: BgRunPaths, manifest: BgRunManifest): Promise<void> {
	assertSameRun(paths, manifest.runId);
	await assertWritableReservedRun(paths);
	await writeJsonAtomic(paths.manifestPath, manifest, 0o600);
}

export async function writeBgResult(paths: BgRunPaths, result: BgRunResult): Promise<void> {
	assertSameRun(paths, result.runId);
	await assertWritableReservedRun(paths);
	await writeJsonAtomic(paths.resultPath, result, 0o600);
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
	const homeDir = options.homeDir ?? os.homedir();
	const keepRecentRuns = options.keepRecentRuns ?? DEFAULT_BG_KEEP_RECENT_RUNS;
	if (!Number.isInteger(keepRecentRuns) || keepRecentRuns < 0) throw new Error("keepRecentRuns must be a non-negative integer");
	const removePromptFiles = options.removePromptFiles ?? true;
	const removeEventFiles = options.removeEventFiles ?? true;
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
		if (removeEventFiles && run.done) {
			if (await existsRegularFileNoSymlink(run.eventsPath)) {
				await fs.rm(run.eventsPath, { force: true });
				removedEventFiles.push(run.eventsPath);
			}
		}
	}

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
	return JSON.stringify(value);
}
