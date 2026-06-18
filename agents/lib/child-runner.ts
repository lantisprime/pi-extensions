import { spawn as nodeSpawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { Buffer } from "node:buffer";
import { buildChildPiArgs, type ChildPiArgsOptions, type ChildPiInvocation } from "./child-args.ts";
import { reduceChildJsonl, type ChildJsonlSummary } from "./jsonl-monitor.ts";
import { getBuiltInAgentSpec, isReservedBuiltInAgentName, type AgentSpec } from "./specs.ts";
import { resolveSpecProfile, type ModelProfileLibrary } from "./profiles.ts";
import { profileTrustCheck } from "./profile-discovery.ts";
import type { ProjectAgentRegistry } from "./registry.ts";

export type ChildAgentRunStatus = "completed" | "failed" | "timed-out" | "output-limit-exceeded" | "spawn-error";

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
};

export type RunChildAgentOptions = RunBuiltInChildAgentOptions;

export type ChildAgentRunner = (agent: string | AgentSpec, task: string, options?: RunChildAgentOptions) => Promise<ChildAgentRunResult>;

const DEFAULT_KILL_SIGNAL: NodeJS.Signals = "SIGTERM";
const DEFAULT_FORCE_KILL_AFTER_MS = 1_000;

export async function runBuiltInChildAgent(agentName: string, task: string, options: RunBuiltInChildAgentOptions = {}, profiles?: ModelProfileLibrary): Promise<ChildAgentRunResult> {
	if (!isReservedBuiltInAgentName(agentName)) throw new Error(`P3c-2 only supports built-in agents: scout, planner, reviewer`);
	const spec = getBuiltInAgentSpec(agentName);
	if (!spec || spec.source !== "built-in") throw new Error(`built-in agent '${agentName}' was not found`);
	return runChildAgent(spec, task, options, profiles);
}

export async function runChildAgent(spec: AgentSpec, task: string, options: RunChildAgentOptions = {}, profiles?: ModelProfileLibrary): Promise<ChildAgentRunResult> {
	let effectiveSpec = spec;
	let resolvedProfile: string | undefined;
	let resolvedModel: string | undefined;
	let resolvedThinking: string | undefined;
	if (profiles && spec.profile) {
		const result = resolveSpecProfile({ model: spec.model, thinking: spec.thinking, profile: spec.profile }, profiles);
		if (!result.resolved) {
			return spawnErrorResult(spec.name, buildChildPiArgs(spec, task, options), new Error(result.error.message));
		}
		// P3f-3: Profile trust check for project-source profiles
		if (result.profileSourceOrigin === "project") {
			const trustCheck = profileTrustCheck(
				result.profileName!,
				result.profileCanonicalPath,
				result.profileRawBytesSha256 ?? "",
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
		effectiveSpec = { ...spec, model: resolvedModel, thinking: resolvedThinking };
	}
	const invocation = buildChildPiArgs(effectiveSpec, task, options);
	const stdoutLimit = options.maxStdoutBytes ?? spec.limits.maxStdoutBytes;
	const stderrLimit = options.maxStderrChars ?? spec.limits.maxStderrChars;
	const timeoutMs = options.timeoutMs ?? spec.limits.timeoutMs;
	const killSignal = options.killSignal ?? DEFAULT_KILL_SIGNAL;
	const forceKillAfterMs = options.forceKillAfterMs ?? DEFAULT_FORCE_KILL_AFTER_MS;
	let promptFileCreated = false;

	try {
		if (invocation.promptTransport.kind === "private-temp-file") {
			await fs.writeFile(invocation.promptTransport.path, invocation.promptTransport.fileText, { mode: 0o600, flag: "wx" });
			promptFileCreated = true;
		}
		return await spawnAndCollect(effectiveSpec.name, invocation, {
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
		});
	} finally {
		if (promptFileCreated && invocation.promptTransport.kind === "private-temp-file" && invocation.promptTransport.cleanup) {
			await fs.rm(invocation.promptTransport.path, { force: true });
		}
	}
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
	lines.push("summary:");
	lines.push(result.summary.summaryText || "(no assistant summary captured)");
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
}): Promise<ChildAgentRunResult> {
	validatePositiveInteger("maxStdoutBytes", options.stdoutLimit);
	validatePositiveInteger("maxStderrChars", options.stderrLimit);
	validatePositiveInteger("timeoutMs", options.timeoutMs);
	validatePositiveInteger("maxJsonLineBytes", options.maxJsonLineBytes);
	validatePositiveInteger("maxResultChars", options.maxResultChars);
	validatePositiveInteger("forceKillAfterMs", options.forceKillAfterMs);

	const startedAt = options.now();
	let child: ChildProcessLike;
	try {
		child = options.spawn(invocation.command, invocation.argv, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
	} catch (error) {
		return spawnErrorResult(agentName, invocation, error);
	}

	const stdoutChunks: Buffer[] = [];
	let stdoutBytes = 0;
	let stderrPreview = "";
	let timedOut = false;
	let outputLimitExceeded = false;
	let closed = false;
	let killIssued = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

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
		const remaining = options.stdoutLimit - byteLength(stdoutChunks);
		if (remaining > 0) stdoutChunks.push(buffer.subarray(0, remaining));
		if (stdoutBytes > options.stdoutLimit) {
			outputLimitExceeded = true;
			killChild();
		}
	});
	child.stderr?.on("data", (chunk) => {
		const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
		if (stderrPreview.length < options.stderrLimit) stderrPreview = `${stderrPreview}${text}`.slice(0, options.stderrLimit);
	});
	return await new Promise<ChildAgentRunResult>((resolve) => {
		const finish = (status: ChildAgentRunStatus, details: { code?: number | null; signal?: string | null; error?: string } = {}) => {
			if (closed) return;
			closed = true;
			if (timer) clearTimeout(timer);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			const stdoutText = Buffer.concat(stdoutChunks).toString("utf8");
			const summary = reduceChildJsonl(stdoutText, {
				maxStdoutBytes: options.stdoutLimit,
				maxJsonLineBytes: options.maxJsonLineBytes,
				maxSummaryChars: options.maxResultChars,
			});
			if (outputLimitExceeded) summary.truncation.stdoutBytesTruncated = true;
			resolve({
				agentName,
				status,
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
		if (invocation.promptTransport.kind === "stdin") child.stdin?.end(invocation.promptTransport.stdinText);
		else child.stdin?.end();
	});
}

function defaultSpawner(command: string, argv: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] }): ChildProcessLike {
	return nodeSpawn(command, [...argv], options);
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

function byteLength(buffers: readonly Buffer[]): number {
	return buffers.reduce((total, buffer) => total + buffer.length, 0);
}

function validatePositiveInteger(name: string, value: number): void {
	if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
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
