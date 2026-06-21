import { spawn as nodeSpawn } from "node:child_process";
import { promises as fs, createWriteStream, type WriteStream } from "node:fs";
import { Buffer } from "node:buffer";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import os from "node:os";
import { buildChildPiArgs, getPiInvocation, type ChildPiArgsOptions, type ChildPiInvocation } from "./child-args.ts";
import { reduceChildJsonl, type ChildJsonlSummary } from "./jsonl-monitor.ts";
import { getBuiltInAgentSpec, isReservedBuiltInAgentName, type AgentSpec } from "./specs.ts";
import { resolveSpecProfile, type ModelProfileLibrary } from "./profiles.ts";
import { profileTrustCheck } from "./profile-discovery.ts";
import type { ProjectAgentRegistry } from "./registry.ts";

export type ChildAgentRunStatus = "completed" | "failed" | "timed-out" | "output-limit-exceeded" | "spawn-error" | "spill-error";

export type ChildAgentRunResult = {
	agentName: string;
	status: ChildAgentRunStatus;
	exitCode?: number | null;
	signal?: string | null;
	pid?: number;
	durationMs: number;
	stdoutBytes: number;
	stderrPreview: string;
	invocation: ChildPiInvocation;
	summary: ChildJsonlSummary;
	timedOut: boolean;
	outputLimitExceeded: boolean;
	/** P3f-4: spill write stream errored mid-run (disjoint from outputLimitExceeded). */
	spillWriteError?: boolean;
	/** P3f-4: path to the kept spill file (only when non-completed). */
	stdoutTmpPath?: string;
	error?: string;
	resolvedProfile?: string;
	resolvedModel?: string;
	resolvedThinking?: string;
};

export type ChildProcessLike = {
	pid?: number;
	stdout?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
	stderr?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
	stdin?: { end(data?: string): unknown };
	on: ((event: "close", listener: (code: number | null, signal: string | null) => void) => unknown) & ((event: "error", listener: (error: Error) => void) => unknown);
	kill(signal?: NodeJS.Signals | string): boolean;
};

export type ChildProcessSpawner = (command: string, argv: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] }) => ChildProcessLike;

export type RunBuiltInChildAgentOptions = ChildPiArgsOptions & {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	spawn?: ChildProcessSpawner;
	now?: () => number;
	timeoutMs?: number;
	maxStdoutBytes?: number;
	maxStderrChars?: number;
	maxJsonLineBytes?: number;
	maxResultChars?: number;
	killSignal?: NodeJS.Signals | string;
	forceKillAfterMs?: number;
	projectTrusted?: boolean;
	projectRegistry?: ProjectAgentRegistry;
	/** P3f-4: override the spill temp directory (default os.tmpdir()). */
	stdoutTmpDir?: string;
	/** P3f-4: runtime profile override (used when no positional profileOverride is passed). */
	profileOverride?: string;
	/** P8-1: called once per complete stdout line (newline-delimited) as the child streams.
	 *  Display-only progress sink; default undefined = strict no-op (zero behavior change). */
	onProgress?: (line: string) => void;
};

export type RunChildAgentOptions = RunBuiltInChildAgentOptions;

export type ChildAgentRunner = (agent: string | AgentSpec, task: string, options?: RunChildAgentOptions) => Promise<ChildAgentRunResult>;

const DEFAULT_KILL_SIGNAL: NodeJS.Signals = "SIGTERM";
const DEFAULT_FORCE_KILL_AFTER_MS = 1_000;

export async function runBuiltInChildAgent(agentName: string, task: string, options: RunBuiltInChildAgentOptions = {}, profiles?: ModelProfileLibrary, profileOverride?: string): Promise<ChildAgentRunResult> {
	if (!isReservedBuiltInAgentName(agentName)) throw new Error(`P3c-2 only supports built-in agents: scout, planner, reviewer`);
	const spec = getBuiltInAgentSpec(agentName);
	if (!spec || spec.source !== "built-in") throw new Error(`built-in agent '${agentName}' was not found`);
	return runChildAgent(spec, task, options, profiles, profileOverride);
}

export async function runChildAgent(spec: AgentSpec, task: string, options: RunChildAgentOptions = {}, profiles?: ModelProfileLibrary, profileOverride?: string): Promise<ChildAgentRunResult> {
	let resolvedProfile: string | undefined;
	let resolvedModel: string | undefined;
	let resolvedThinking: string | undefined;
	// P3f-4: positional profileOverride wins; fall back to options.profileOverride (custom-runner path)
	const effectiveProfile = profileOverride ?? options.profileOverride ?? spec.profile;
	if (effectiveProfile) {
		// Fail-closed: profile requested but no library available to resolve it
		if (!profiles || !Array.isArray(profiles.profiles) || profiles.profiles.length === 0) {
			return spawnErrorResult(spec.name, { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin" as const, stdinText: "" } }, new Error(`profile '${effectiveProfile}' requested but no profile library is available`));
		}
		const result = resolveSpecProfile({ model: spec.model, thinking: spec.thinking, profile: effectiveProfile }, profiles);
		if (!result.resolved) {
			return spawnErrorResult(spec.name, { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin" as const, stdinText: "" } }, new Error(result.error.message));
		}
		// P3f-3: Profile trust check for project-source profiles
		if (result.profileSourceOrigin === "project") {
			if (!result.profileCanonicalPath || !result.profileRawBytesSha256) {
				return {
					agentName: spec.name,
					status: "spawn-error" as const,
					durationMs: 0, stdoutBytes: 0, stderrPreview: "",
					invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin" as const, stdinText: "" } },
					summary: { summaryText: "", toolCalls: [], errors: [], usage: undefined, cost: undefined, stopReason: undefined, model: undefined, provider: undefined, truncation: {} },
					timedOut: false, outputLimitExceeded: false,
					error: "project profile missing canonicalPath or rawBytesSha256 metadata",
				};
			}
			const trustCheck = profileTrustCheck(
				result.profileName!,
				result.profileCanonicalPath!,
				result.profileRawBytesSha256!,
				options.projectRegistry,
				options.projectTrusted ?? false,
			);
			if (!trustCheck.ok) {
				// Deny without calling buildChildPiArgs — trust check failed before profile was applied
				return {
					agentName: spec.name,
					status: "spawn-error" as const,
					durationMs: 0,
					stdoutBytes: 0,
					stderrPreview: "",
					invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin" as const, stdinText: "" } },
					summary: { summaryText: "", toolCalls: [], errors: [], usage: undefined, cost: undefined, stopReason: undefined, model: undefined, provider: undefined, truncation: {} },
					timedOut: false,
					outputLimitExceeded: false,
					error: trustCheck.message,
				};
			}
		}
		resolvedProfile = result.profileName;
		resolvedModel = result.effectiveModel;
		resolvedThinking = result.effectiveThinking;
	}
	// childArgSpec omits the profile field: the resolved model/thinking are applied,
	// but the profile NAME never reaches buildChildPiArgs or child argv.
	const childArgSpec: AgentSpec = { ...spec, model: resolvedModel ?? spec.model, thinking: resolvedThinking ?? spec.thinking };
	delete (childArgSpec as { profile?: string }).profile;
	let sysDir: string | undefined;
	try {
		sysDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-sys-"));
		await fs.chmod(sysDir, 0o700);
		const systemPromptPath = path.join(sysDir, "system.md");
		const invocation = buildChildPiArgs(childArgSpec, task, { ...options, systemPromptPath });
		const stdoutLimit = options.maxStdoutBytes ?? spec.limits.maxStdoutBytes;
		const stderrLimit = options.maxStderrChars ?? spec.limits.maxStderrChars;
		const timeoutMs = options.timeoutMs ?? spec.limits.timeoutMs;
		const killSignal = options.killSignal ?? DEFAULT_KILL_SIGNAL;
		const forceKillAfterMs = options.forceKillAfterMs ?? DEFAULT_FORCE_KILL_AFTER_MS;
		if (invocation.systemPromptFile) {
			await fs.writeFile(invocation.systemPromptFile.path, invocation.systemPromptFile.fileText, { mode: 0o600, flag: "wx" });
		}
		return await spawnAndCollect(spec.name, invocation, {
			cwd: options.cwd,
			env: options.env,
			spawn: options.spawn ?? defaultSpawner,
			now: options.now ?? Date.now,
			stdoutLimit,
			stderrLimit,
			timeoutMs,
			maxJsonLineBytes: options.maxJsonLineBytes ?? spec.limits.maxJsonLineBytes,
			maxResultChars: options.maxResultChars ?? spec.limits.maxResultChars,
			killSignal,
			forceKillAfterMs,
			resolvedProfile,
			resolvedModel,
			resolvedThinking,
			stdoutTmpDir: options.stdoutTmpDir,
			onProgress: options.onProgress,
		});
	} finally {
		if (sysDir) await fs.rm(sysDir, { recursive: true, force: true });
	}
}

/** Map a non-completed run to a concrete next step the user can take. Best-effort, pattern-based;
 *  returns undefined for a clean completed run. Shown as a `→ next:` line in the result. */
export function suggestNextAction(result: ChildAgentRunResult): string | undefined {
	if (result.status === "completed") return undefined;
	const err = (result.error || "").toLowerCase();
	if (err.includes("project trust is not active")) return "activate project trust (trust the project / run /agents register-project), then rerun.";
	if (err.includes("no profile library is available")) return "profile library unavailable — reload the session, or run /agents profiles to verify.";
	if (err.includes("profile") && (err.includes("not found") || err.includes("unknown") || err.includes("no matching"))) return "profile not found — run /agents profiles to list profiles, or check .pi/profiles/.";
	if (err.includes("not registered") || err.includes("unregistered")) return "register it first — /agents register <name> (or /agents register-project).";
	if (err.includes("hash") || err.includes("re-read") || err.includes("changed")) return "the spec changed on disk — /agents inspect <name>, then re-register.";
	if (result.timedOut) return `timed out after ${result.durationMs}ms — narrow the task or raise the agent's timeoutMs.`;
	if (result.outputLimitExceeded) return "output exceeded limits — narrow the task or raise maxStdoutBytes.";
	if (result.status === "spawn-error") return "could not spawn the child — ensure the 'pi' CLI is on PATH and the spec/profile is valid; /agents doctor.";
	if (result.status === "failed") return `child exited non-zero${result.exitCode !== undefined ? ` (exit ${result.exitCode})` : ""} — check the stderr/tool output above and rerun with a narrower task.`;
	return "run /agents inspect <name> and /agents doctor to diagnose.";
}

export function formatChildAgentRunResult(result: ChildAgentRunResult): string {
	const lines = [
		`Agent run: ${result.agentName}`,
		`status: ${result.status}${result.exitCode !== undefined ? ` exit=${result.exitCode}` : ""}${result.signal ? ` signal=${result.signal}` : ""} durationMs=${result.durationMs}`,
		`command: ${[result.invocation.command, ...result.invocation.argvPreview].join(" ")}`,
	];
	if (result.resolvedProfile) lines.push(`resolvedProfile: ${result.resolvedProfile}${result.resolvedModel ? ` model=${result.resolvedModel}` : ""}${result.resolvedThinking ? ` thinking=${result.resolvedThinking}` : ""}`);
	if (result.error) lines.push(`error: ${result.error}`);
	if (result.stderrPreview) lines.push(`stderr: ${result.stderrPreview}`);
	if (result.summary.errors.length > 0) lines.push(`jsonl warnings: ${result.summary.errors.slice(0, 5).join("; ")}`);
	if (hasTruncation(result.summary) || result.outputLimitExceeded || result.timedOut) lines.push(`truncation: ${formatTruncation(result)}`);
	if (result.summary.toolCalls.length > 0) {
		lines.push(`tool calls (${result.summary.toolCalls.length}${result.summary.truncation.toolCallsTruncated ? "+" : ""}):`);
		for (const tool of result.summary.toolCalls.slice(0, 8)) {
			const resultPreview = tool.resultPreview ? ` => ${tool.resultPreview}` : "";
			lines.push(`- ${tool.name}${tool.isError ? " error" : ""}: ${tool.argsPreview}${resultPreview}`);
		}
	}
	if (result.summary.usage !== undefined) lines.push(`usage: ${stableJson(result.summary.usage)}`);
	if (result.summary.cost !== undefined) lines.push(`cost: ${stableJson(result.summary.cost)}`);
	if (result.summary.stopReason) lines.push(`stopReason: ${result.summary.stopReason}`);
	if (result.summary.model || result.summary.provider) lines.push(`model: ${[result.summary.provider, result.summary.model].filter(Boolean).join("/")}`);
	const next = suggestNextAction(result);
	if (next) lines.push(`→ next: ${next}`);
	lines.push("summary:");
	lines.push(result.summary.summaryText || "(no assistant summary captured)");
	return lines.join("\n");
}

/** P8-followup: format a completed subagent run for injection into pi's conversation context
 *  (NL summary + a compact tool list). Distinct from formatChildAgentRunResult, which is the
 *  verbose operator toast. Kept short so it doesn't flood the parent agent's context budget. */
export function formatAgentResultForContext(result: ChildAgentRunResult): string {
	const summary = result.summary.summaryText?.trim();
	const lines = [
		`The \`${result.agentName}\` subagent finished (status: ${result.status}). Use its findings to help with my task.`,
		"",
		"Summary:",
		summary && summary.length > 0 ? summary : "(the subagent produced no natural-language summary)",
	];
	if (result.summary.toolCalls.length > 0) {
		lines.push("", `Tool calls (${result.summary.toolCalls.length}):`);
		for (const tool of result.summary.toolCalls.slice(0, 20)) {
			lines.push(`- ${tool.name}: ${tool.argsPreview}`.trimEnd());
		}
		if (result.summary.toolCalls.length > 20) lines.push(`- … +${result.summary.toolCalls.length - 20} more`);
	}
	return lines.join("\n");
}

async function spawnAndCollect(agentName: string, invocation: ChildPiInvocation, options: {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	spawn: ChildProcessSpawner;
	now: () => number;
	stdoutLimit: number;
	stderrLimit: number;
	timeoutMs: number;
	maxJsonLineBytes: number;
	maxResultChars: number;
	killSignal: NodeJS.Signals | string;
	forceKillAfterMs: number;
	stdoutTmpDir?: string;
	/** P8-1: per-complete-stdout-line progress sink (display-only); default undefined = no-op. */
	onProgress?: (line: string) => void;
}): Promise<ChildAgentRunResult> {
	// P3f-4: validate limits are finite positive integers (reject NaN/Infinity/non-positive)
	const validateFinitePositive = (name: string, value: number) => {
		if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
			throw new Error(`${name} must be a finite positive integer`);
		}
	};
	validateFinitePositive("maxStdoutBytes", options.stdoutLimit);
	validateFinitePositive("maxStderrChars", options.stderrLimit);
	validateFinitePositive("timeoutMs", options.timeoutMs);
	validateFinitePositive("maxJsonLineBytes", options.maxJsonLineBytes);
	validateFinitePositive("maxResultChars", options.maxResultChars);
	validateFinitePositive("forceKillAfterMs", options.forceKillAfterMs);

	// P3f-4: safety watermark — 50× stdoutLimit, clamped to a global max (256 MB)
	const STDOUT_SAFETY_MULTIPLIER = 50;
	const STDOUT_SAFETY_GLOBAL_MAX = 256 * 1024 * 1024;
	const stdoutSafetyBytes = Math.min(options.stdoutLimit * STDOUT_SAFETY_MULTIPLIER, STDOUT_SAFETY_GLOBAL_MAX);
	const tmpDir = options.stdoutTmpDir ?? os.tmpdir();

	const startedAt = options.now();
	let spillWriteError = false;

	// P3f-4: create secure spill file via mkdtemp (dir 0700) + stdout.jsonl (wx, 0600).
	// We await the stream's 'open' event so the file is confirmed open (and exclusive-create
	// enforced) BEFORE we spawn the child. The error listener is attached synchronously so
	// async open/write errors never crash the parent.
	let spillDir: string | undefined;
	let spillFilePath: string | undefined;
	let spillStream: WriteStream | undefined;
	try {
		spillDir = await fs.mkdtemp(path.join(tmpDir, "pi-agent-"));
		await fs.chmod(spillDir, 0o700);
		spillFilePath = path.join(spillDir, "stdout.jsonl");
		// Exclusive open (wx) refuses to overwrite a preexisting file/symlink.
		spillStream = createWriteStream(spillFilePath, { flags: "wx", mode: 0o600 });
		// Attach error listener immediately so async write errors never crash the parent.
		spillStream.on("error", () => { spillWriteError = true; });
		// Await the open so a failure here (EACCES, EEXIST, ENOSPC) is caught before spawn.
		await new Promise<void>((resolveOpen, rejectOpen) => {
			spillStream!.once("open", () => resolveOpen());
			spillStream!.once("error", (err) => rejectOpen(err));
		});
	} catch (error) {
		// Fail-closed: cannot open spill → do not spawn. Clean up any partial dir.
		if (spillStream) spillStream.destroy();
		if (spillDir) await cleanupSpill(spillDir, spillFilePath ?? "").catch(() => {});
		const message = error instanceof Error ? error.message : String(error);
		return spawnErrorResult(agentName, invocation, new Error(`spill file setup failed: ${message}`));
	}
	const spillStreamFinal: WriteStream = spillStream;
	const spillDirFinal: string = spillDir!;
	const spillFilePathFinal: string = spillFilePath!;

	let child: ChildProcessLike;
	try {
		child = options.spawn(invocation.command, invocation.argv, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
	} catch (error) {
		spillStreamFinal.destroy();
		await cleanupSpill(spillDirFinal, spillFilePathFinal);
		return spawnErrorResult(agentName, invocation, error);
	}

	let stdoutBytes = 0;
	let stderrPreview = "";
	let timedOut = false;
	let outputLimitExceeded = false;
	let closed = false;
	let killIssued = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

	// P8-1: progress line buffering — wholly separate from stdoutBytes/spill/watermark so it
	// cannot perturb byte accounting or truncation (REQ-12). StringDecoder handles multi-byte
	// UTF-8 split across chunk boundaries; only complete (newline-delimited) lines are emitted,
	// with the trailing partial flushed on close (REQ-6 / N3).
	const progressDecoder = options.onProgress ? new StringDecoder("utf8") : undefined;
	let progressLineBuf = "";
	const emitProgress = (buffer: Buffer) => {
		if (!options.onProgress || !progressDecoder) return;
		progressLineBuf += progressDecoder.write(buffer);
		let nl = progressLineBuf.indexOf("\n");
		while (nl !== -1) {
			options.onProgress(progressLineBuf.slice(0, nl));
			progressLineBuf = progressLineBuf.slice(nl + 1);
			nl = progressLineBuf.indexOf("\n");
		}
	};
	const flushProgress = () => {
		if (!options.onProgress || !progressDecoder) return;
		progressLineBuf += progressDecoder.end();
		if (progressLineBuf.length > 0) {
			options.onProgress(progressLineBuf);
			progressLineBuf = "";
		}
	};

	const killChild = () => {
		if (killIssued || closed) return;
		killIssued = true;
		try {
			child.kill(options.killSignal);
		} catch {
			// Process may already be gone; close/error handling resolves the run.
		}
		forceKillTimer = setTimeout(() => {
			if (closed) return;
			try {
				child.kill("SIGKILL");
			} catch {
				// Best-effort cleanup; close/error handling resolves when available.
			}
		}, options.forceKillAfterMs);
	};

	child.stdout?.on("data", (chunk) => {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
		stdoutBytes += buffer.length;
		// P3f-4: spill to file (best-effort)
		if (!spillStreamFinal.destroyed && !spillStreamFinal.writableEnded && !closed) {
			spillStreamFinal.write(buffer);
		}
		// P8-1: emit complete lines to the progress sink (no-op when onProgress absent).
		emitProgress(buffer);
		// Safety watermark: kill runaway at stdoutSafetyBytes (50× limit, clamped to 256MB)
		if (stdoutBytes > stdoutSafetyBytes) {
			outputLimitExceeded = true;
			killChild();
		}
	});
	child.stderr?.on("data", (chunk) => {
		const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
		if (stderrPreview.length < options.stderrLimit) stderrPreview = `${stderrPreview}${text}`.slice(0, options.stderrLimit);
	});
	return await new Promise<ChildAgentRunResult>((resolve) => {
		const finish = async (status: ChildAgentRunStatus, details: { code?: number | null; signal?: string | null; error?: string } = {}) => {
			if (closed) return;
			closed = true;
			// P8-1: flush any trailing partial line (no final newline) to the progress sink (REQ-6).
			flushProgress();
			if (timer) clearTimeout(timer);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			// P3f-4: end the spill stream and await its finish/close before reading
			await new Promise<void>((resolveStream) => {
				if (spillStreamFinal.destroyed) { resolveStream(); return; }
				let done = false;
				let safetyTimer: ReturnType<typeof setTimeout> | undefined;
				const finish = () => { if (!done) { done = true; if (safetyTimer) clearTimeout(safetyTimer); resolveStream(); } };
				spillStreamFinal.once("finish", finish);
				spillStreamFinal.once("close", finish);
				spillStreamFinal.once("error", finish);
				try { spillStreamFinal.end(); } catch { finish(); }
				// Safety: do not hang forever waiting on the stream. unref so it never keeps the process alive.
				safetyTimer = setTimeout(finish, 5000);
				safetyTimer.unref?.();
			});
			// Read spill file as the sole source of truth for summarization
			let stdoutText = "";
			try {
				stdoutText = await fs.readFile(spillFilePathFinal, "utf8");
			} catch {
				// Spill read failed — treat as spill write error
				spillWriteError = true;
			}
			const summary = reduceChildJsonl(stdoutText, {
				maxStdoutBytes: options.stdoutLimit,
				maxJsonLineBytes: options.maxJsonLineBytes,
				maxSummaryChars: options.maxResultChars,
			});
			if (outputLimitExceeded) summary.truncation.stdoutBytesTruncated = true;
			// P3f-4: cleanup temp file+dir on success (completed, no spill error); keep otherwise
			const keepSpill = status !== "completed" || spillWriteError;
			if (!keepSpill) {
				await cleanupSpill(spillDirFinal, spillFilePathFinal).catch(() => {});
			}
			// P3f-4: spillWriteError forces non-completed status in ALL paths (no false success)
			const finalStatus: ChildAgentRunStatus = spillWriteError ? "spill-error" : status;
			resolve({
				agentName,
				status: finalStatus,
				...(details.code !== undefined ? { exitCode: details.code } : {}),
				...(details.signal !== undefined ? { signal: details.signal } : {}),
				...(child.pid !== undefined ? { pid: child.pid } : {}),
				durationMs: Math.max(0, options.now() - startedAt),
				stdoutBytes,
				stderrPreview,
				invocation,
				summary,
				timedOut,
				outputLimitExceeded,
				...(spillWriteError ? { spillWriteError: true } : {}),
				...(keepSpill || spillWriteError ? { stdoutTmpPath: spillFilePathFinal } : {}),
				...(details.error ? { error: details.error } : {}),
				...(options.resolvedProfile ? { resolvedProfile: options.resolvedProfile } : {}),
				...(options.resolvedModel ? { resolvedModel: options.resolvedModel } : {}),
				...(options.resolvedThinking ? { resolvedThinking: options.resolvedThinking } : {}),
			});
		};
		timer = setTimeout(() => {
			timedOut = true;
			killChild();
		}, options.timeoutMs);
		child.on("error", (error) => finish("spawn-error", { error: error.message }));
		child.on("close", (code, signal) => {
			const status = timedOut ? "timed-out" : outputLimitExceeded ? "output-limit-exceeded" : code === 0 ? "completed" : "failed";
			finish(status, { code, signal });
		});
		child.stdin?.end(invocation.promptTransport.stdinText);
	});
}

function defaultSpawner(command: string, argv: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] }): ChildProcessLike {
	const inv = command === "pi" ? getPiInvocation([...argv]) : { command, args: [...argv] };
	return nodeSpawn(inv.command, inv.args, options);
}

function spawnErrorResult(agentName: string, invocation: ChildPiInvocation, error: unknown): ChildAgentRunResult {
	const message = error instanceof Error ? error.message : String(error);
	return {
		agentName,
		status: "spawn-error",
		durationMs: 0,
		stdoutBytes: 0,
		stderrPreview: "",
		invocation,
		summary: reduceChildJsonl(""),
		timedOut: false,
		outputLimitExceeded: false,
		error: message,
	};
}

/** P3f-4: remove the spill file and its mkdtemp directory (best-effort). */
async function cleanupSpill(spillDir: string, spillFilePath: string): Promise<void> {
	try { await fs.unlink(spillFilePath); } catch { /* best-effort */ }
	try { await fs.rmdir(spillDir); } catch { /* best-effort */ }
}

function hasTruncation(summary: ChildJsonlSummary): boolean {
	return Object.values(summary.truncation).some(Boolean);
}

function formatTruncation(result: ChildAgentRunResult): string {
	const flags = Object.entries(result.summary.truncation).filter(([, value]) => value).map(([key]) => key);
	if (result.timedOut) flags.push("timedOut");
	if (result.outputLimitExceeded) flags.push("outputLimitExceeded");
	return flags.length > 0 ? flags.join(",") : "none";
}

function stableJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/** P6-2: thin exported wrapper over spawnAndCollect for the LLM classifier child.
 *  Owns the spawn/now defaults so callers pass only limits. */
export function collectChildProcess(invocation: ChildPiInvocation, limits: Omit<Parameters<typeof spawnAndCollect>[2], "spawn" | "now" | "cwd" | "env" | "stdoutTmpDir">): Promise<ChildAgentRunResult> {
	return spawnAndCollect("intent-classifier", invocation, { ...limits, spawn: defaultSpawner, now: Date.now });
}
