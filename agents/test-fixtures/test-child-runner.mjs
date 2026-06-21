import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import { formatChildAgentRunResult, formatAgentResultForContext, suggestNextAction, runBuiltInChildAgent, runChildAgent } from "../lib/child-runner.ts";

function jsonLine(value) {
	return `${JSON.stringify(value)}\n`;
}

class FakeChild extends EventEmitter {
	constructor() {
		super();
		this.pid = 1234;
		this.stdout = new EventEmitter();
		this.stderr = new EventEmitter();
		this.stdinText = "";
		this.kills = [];
		this.closed = false;
		this.stdin = {
			end: (text = "") => {
				this.stdinText += text;
			},
		};
	}

	kill(signal) {
		this.kills.push(signal);
		if (!this.closed) {
			this.closed = true;
			queueMicrotask(() => this.emit("close", null, signal ?? null));
		}
		return true;
	}

	close(code = 0, signal = null) {
		if (this.closed) return;
		this.closed = true;
		this.emit("close", code, signal);
	}
}

async function testCompletedBuiltInRunUsesSafeArgvAndStdin() {
	let command;
	let argv;
	let options;
	let child;
	const result = await runBuiltInChildAgent("scout", "inspect the repo", {
		cwd: "/tmp/project",
		piCommand: "pi-test",
		spawn: (cmd, args, spawnOptions) => {
			command = cmd;
			argv = [...args];
			options = spawnOptions;
			child = new FakeChild();
			queueMicrotask(() => {
				child.stdout.emit("data", Buffer.from(jsonLine({ type: "session", id: "s1", version: 3, cwd: "/tmp/project" })));
				child.stdout.emit("data", Buffer.from(jsonLine({ type: "message_end", message: { role: "assistant", content: "Files/paths inspected\nREADME.md\n\nConcise findings\nLooks good." }, usage: { input: 1, output: 2 }, costUsd: 0.01, stopReason: "end_turn", model: "m", provider: "p" })));
				child.close(0, null);
			});
			return child;
		},
	});

	assert.equal(command, "pi-test");
	assert.deepEqual(options, { cwd: "/tmp/project", env: undefined, stdio: ["pipe", "pipe", "pipe"] });
	assert.deepEqual(argv.slice(0, 3), ["--mode", "json", "--no-session"]);
	assert.equal(argv.includes("--no-approve"), true);
	assert.equal(argv.includes("--no-extensions"), true);
	assert.equal(argv.includes("--approve"), false);
	assert.equal(argv.join(" ").includes("inspect the repo"), false);
	assert.equal(argv.join(" ").includes("run_subagent"), false);
	assert.ok(argv.includes("--tools"));
	assert.equal(child.stdinText.includes("inspect the repo"), true);
	assert.equal(result.status, "completed");
	assert.equal(result.summary.session.id, "s1");
	assert.match(result.summary.summaryText, /Concise findings/);
	assert.deepEqual(result.summary.usage, { input: 1, output: 2 });
	assert.equal(result.summary.cost, 0.01);
	assert.equal(result.summary.stopReason, "end_turn");
	assert.equal(result.summary.model, "m");
	assert.equal(result.summary.provider, "p");
}

async function testRejectsNonBuiltInAgentsBeforeSpawn() {
	let spawned = false;
	await assert.rejects(
		() => runBuiltInChildAgent("user-helper", "task", { spawn: () => { spawned = true; return new FakeChild(); } }),
		/P3c-2 only supports built-in agents/,
	);
	assert.equal(spawned, false);
}

function registeredSpec(overrides = {}) {
	return {
		name: "user-helper",
		description: "helper",
		source: "user",
		tools: ["read", "grep"],
		prompt: "Read only helper prompt.",
		inputContract: { kind: "task-string", maxTaskChars: 100, emptyTask: "reject" },
		outputContract: { requiredSections: ["Summary"], maxSummaryChars: 500 },
		evals: [],
		limits: { timeoutMs: 1000, maxStdoutBytes: 1000, maxStderrChars: 200, maxResultChars: 500, maxJsonLineBytes: 500, maxTaskChars: 100, maxChildProcesses: 1, maxChainLength: 3 },
		observability: { retainInMemoryRuns: 20, persistByDefault: false, includeToolTrajectory: true, storeFullPrompt: false, storeFullTask: false, storeFullToolResults: false, storeThinkingText: false },
		safety: { approveProjectByDefault: false, projectSpecsRequireTrustAndRegistration: true, allowRecursiveSubagents: false, promptTransport: "stdin-or-private-tempfile", forbiddenTools: ["write", "edit", "bash", "run_subagent"], redactDisplayedCommand: true },
		...overrides,
	};
}

async function testGenericRegisteredRunUsesSpecPromptAndLimits() {
	let child;
	const spec = registeredSpec();
	const result = await runChildAgent(spec, "inspect registered files", {
		piCommand: "pi-test",
		spawn: (_cmd, argv) => {
			child = new FakeChild();
			assert.equal(argv.includes("--no-approve"), true);
			assert.equal(argv.includes("--approve"), false);
			assert.equal(argv.includes("run_subagent"), false);
			assert.equal(argv.join(" ").includes("inspect registered files"), false);
			queueMicrotask(() => {
				child.stdout.emit("data", jsonLine({ type: "message_end", message: { role: "assistant", content: "Summary\nDone" } }));
				child.close(0, null);
			});
			return child;
		},
	});
	assert.equal(child.stdinText, "inspect registered files");
	assert.match(result.invocation.systemPromptFile.fileText, /Agent: user-helper/);
	assert.match(result.invocation.systemPromptFile.fileText, /Source: user/);
	assert.equal(result.agentName, "user-helper");
	assert.equal(result.status, "completed");
}

async function testRegisteredRunRejectsOversizedTaskBeforeSpawn() {
	let spawned = false;
	const spec = registeredSpec();
	await assert.rejects(
		() => runChildAgent(spec, "x".repeat(spec.inputContract.maxTaskChars + 1), { spawn: () => { spawned = true; return new FakeChild(); } }),
		/maxTaskChars/,
	);
	assert.equal(spawned, false);
}

async function testRegisteredRunRejectsForbiddenToolsBeforeSpawn() {
	let spawned = false;
	await assert.rejects(
		() => runChildAgent(registeredSpec({ tools: ["read", "run_subagent"] }), "task", { spawn: () => { spawned = true; return new FakeChild(); } }),
		/forbidden child tool 'run_subagent'/,
	);
	assert.equal(spawned, false);
}

async function testNonZeroExitIsFailedAndFormatsCompactResult() {
	const result = await runBuiltInChildAgent("reviewer", "review this", {
		spawn: () => {
			const child = new FakeChild();
			queueMicrotask(() => {
				child.stdout.emit("data", jsonLine({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "README.md" } }));
				child.stdout.emit("data", jsonLine({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: { content: "ok" }, isError: false }));
				child.stderr.emit("data", "bad things happened");
				child.close(2, null);
			});
			return child;
		},
	});
	assert.equal(result.status, "failed");
	assert.equal(result.exitCode, 2);
	assert.match(result.stderrPreview, /bad things/);
	const formatted = formatChildAgentRunResult(result);
	assert.match(formatted, /Agent run: reviewer/);
	assert.match(formatted, /status: failed exit=2/);
	assert.match(formatted, /tool calls \(1\):/);
	assert.match(formatted, /summary:/);
}

async function testTimeoutKillsChild() {
	let child;
	const result = await runBuiltInChildAgent("planner", "plan", {
		timeoutMs: 1,
		spawn: () => {
			child = new FakeChild();
			return child;
		},
	});
	assert.equal(result.status, "timed-out");
	assert.equal(result.timedOut, true);
	assert.deepEqual(child.kills, ["SIGTERM"]);
}

async function testOutputLimitKillsChildAndBoundsStdout() {
	// P3f-4: stdout no longer kills at maxStdoutBytes; it spills to a temp file and
	// only kills at the safety watermark (50× maxStdoutBytes). Emit enough to exceed it.
	let child;
	const result = await runBuiltInChildAgent("scout", "task", {
		maxStdoutBytes: 30, // safety watermark = 50 * 30 = 1500
		spawn: () => {
			child = new FakeChild();
			queueMicrotask(() => {
				child.stdout.emit("data", Buffer.from("x".repeat(1600))); // exceeds 1500
			});
			return child;
		},
	});
	assert.equal(result.status, "output-limit-exceeded");
	assert.equal(result.outputLimitExceeded, true);
	assert.equal(result.summary.truncation.stdoutBytesTruncated, true);
	assert.deepEqual(child.kills, ["SIGTERM"]);
	// P3f-4: temp file is kept on safety-kill and path is surfaced
	assert.ok(result.stdoutTmpPath, "spill path should be surfaced on safety kill");
}

async function testStdoutBelowSafetyWatermarkDoesNotKill() {
	// P3f-4: stdout between maxStdoutBytes and the safety watermark must NOT kill.
	// The process completes normally; the spill file captures the full stdout.
	let child;
	const result = await runBuiltInChildAgent("scout", "task", {
		maxStdoutBytes: 30, // safety watermark = 1500
		spawn: () => {
			child = new FakeChild();
			queueMicrotask(() => {
				child.stdout.emit("data", Buffer.from("x".repeat(80))); // below 1500
				child.close(0, null);
			});
			return child;
		},
	});
	assert.equal(result.status, "completed");
	assert.equal(result.outputLimitExceeded, false);
	assert.deepEqual(child.kills, []);
	assert.equal(result.stdoutTmpPath, undefined, "spill file cleaned up on success");
}

async function testSpawnErrorAndInvalidLimits() {
	const result = await runBuiltInChildAgent("scout", "task", {
		spawn: () => {
			throw new Error("missing pi");
		},
	});
	assert.equal(result.status, "spawn-error");
	assert.match(result.error, /missing pi/);
	await assert.rejects(() => runBuiltInChildAgent("scout", "task", { timeoutMs: 0, spawn: () => new FakeChild() }), /timeoutMs must be a finite positive integer/);
	await assert.rejects(() => runBuiltInChildAgent("scout", "task", { forceKillAfterMs: 0, spawn: () => new FakeChild() }), /forceKillAfterMs must be a finite positive integer/);
}

// P8-1: onProgress fires once per complete (newline-delimited) stdout line; partial lines
// buffered across chunks; multi-byte UTF-8 split across chunks reassembled (REQ-6).
async function testOnProgressLineBuffering() {
	const lines = [];
	const result = await runBuiltInChildAgent("scout", "task", {
		onProgress: (line) => lines.push(line),
		spawn: () => {
			const child = new FakeChild();
			queueMicrotask(() => {
				child.stdout.emit("data", Buffer.from("a\nb"));
				child.stdout.emit("data", Buffer.from("c\n"));
				child.close(0, null);
			});
			return child;
		},
	});
	assert.equal(result.status, "completed");
	assert.deepEqual(lines, ["a", "bc"], "complete lines emitted once each; partial buffered across chunks");

	// Multi-byte UTF-8 (€ = e2 82 ac) split across two chunks must reassemble via StringDecoder.
	const mb = [];
	const euro = Buffer.from("€\n", "utf8");
	await runBuiltInChildAgent("scout", "task", {
		onProgress: (line) => mb.push(line),
		spawn: () => {
			const child = new FakeChild();
			queueMicrotask(() => {
				child.stdout.emit("data", euro.subarray(0, 2));
				child.stdout.emit("data", euro.subarray(2));
				child.close(0, null);
			});
			return child;
		},
	});
	assert.deepEqual(mb, ["€"], "multi-byte char split across chunks reassembled");
}

// P8-1 / N3: a trailing partial line (no final newline) is flushed on close, not dropped (EC2).
async function testTrailingPartialLineFlushedOnClose() {
	const lines = [];
	const result = await runBuiltInChildAgent("scout", "task", {
		onProgress: (line) => lines.push(line),
		spawn: () => {
			const child = new FakeChild();
			queueMicrotask(() => {
				child.stdout.emit("data", Buffer.from("abc")); // no trailing newline
				child.close(0, null);
			});
			return child;
		},
	});
	assert.equal(result.status, "completed");
	assert.deepEqual(lines, ["abc"], "trailing partial line flushed on close, not dropped");
}

// P8-1 / N3 / REQ-12: onProgress must not perturb stdoutBytes or truncation accounting.
async function testOnProgressDoesNotChangeStdoutBytes() {
	const stdoutSeq = [
		Buffer.from(jsonLine({ type: "session", id: "s1", version: 3, cwd: "/tmp" })),
		Buffer.from(jsonLine({ type: "message_end", message: { role: "assistant", content: "Summary\nDone" } })),
	];
	const run = (onProgress) => runBuiltInChildAgent("scout", "task", {
		...(onProgress ? { onProgress } : {}),
		spawn: () => {
			const child = new FakeChild();
			queueMicrotask(() => {
				for (const b of stdoutSeq) child.stdout.emit("data", b);
				child.close(0, null);
			});
			return child;
		},
	});
	const without = await run(undefined);
	const captured = [];
	const withCb = await run((line) => captured.push(line));
	assert.equal(withCb.stdoutBytes, without.stdoutBytes, "stdoutBytes identical with/without onProgress");
	assert.deepEqual(withCb.summary.truncation, without.summary.truncation, "truncation identical with/without onProgress");
	assert.ok(captured.length >= 2, "onProgress still fired for the JSONL lines");
}

// P8-followup: formatAgentResultForContext = NL summary + compact tool list, for pi's context.
async function testFormatAgentResultForContext() {
	const base = {
		agentName: "scout", status: "completed", durationMs: 1, stdoutBytes: 0, stderrPreview: "",
		invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin", stdinText: "" } },
		summary: { summaryText: "Found the bug in foo.ts", toolCalls: [{ name: "read", argsPreview: '{"path":"foo.ts"}' }, { name: "grep", argsPreview: "bug" }], errors: [], truncation: {} },
		timedOut: false, outputLimitExceeded: false,
	};
	const out = formatAgentResultForContext(base);
	assert.match(out, /`scout` subagent finished/);
	assert.match(out, /Found the bug in foo\.ts/);
	assert.match(out, /Tool calls \(2\):/);
	assert.match(out, /- read: \{"path":"foo\.ts"\}/);
	// empty summary → explicit placeholder (not silently blank)
	const empty = formatAgentResultForContext({ ...base, summary: { ...base.summary, summaryText: "" } });
	assert.match(empty, /no natural-language summary/);
}

// P8-followup: failed runs surface a concrete next-best-action.
async function testSuggestNextAction() {
	const base = { agentName: "x", status: "spawn-error", durationMs: 0, stdoutBytes: 0, stderrPreview: "", invocation: { command: "pi", argv: [], argvPreview: [], promptTransport: { kind: "stdin", stdinText: "" } }, summary: { summaryText: "", toolCalls: [], errors: [], truncation: {} }, timedOut: false, outputLimitExceeded: false };
	assert.match(suggestNextAction({ ...base, error: "project trust is not active; project profiles cannot be used" }), /activate project trust/);
	assert.match(suggestNextAction({ ...base, error: "profile 'plan-review' requested but no profile library is available" }), /profile library unavailable/);
	assert.match(suggestNextAction({ ...base, status: "timed-out", timedOut: true, durationMs: 120000 }), /timed out after 120000ms/);
	assert.match(suggestNextAction({ ...base, status: "failed", exitCode: 2 }), /exit 2/);
	assert.equal(suggestNextAction({ ...base, status: "completed" }), undefined, "no suggestion on a clean run");
	// the formatted result includes the → next line on failure
	assert.match(formatChildAgentRunResult({ ...base, error: "project trust is not active" }), /→ next: activate project trust/);
}

async function main() {
	await testCompletedBuiltInRunUsesSafeArgvAndStdin();
	await testFormatAgentResultForContext();
	await testSuggestNextAction();
	await testRejectsNonBuiltInAgentsBeforeSpawn();
	await testGenericRegisteredRunUsesSpecPromptAndLimits();
	await testRegisteredRunRejectsOversizedTaskBeforeSpawn();
	await testRegisteredRunRejectsForbiddenToolsBeforeSpawn();
	await testNonZeroExitIsFailedAndFormatsCompactResult();
	await testTimeoutKillsChild();
	await testOutputLimitKillsChildAndBoundsStdout();
	await testStdoutBelowSafetyWatermarkDoesNotKill();
	await testSpawnErrorAndInvalidLimits();
	await testOnProgressLineBuffering();
	await testTrailingPartialLineFlushedOnClose();
	await testOnProgressDoesNotChangeStdoutBytes();
	console.log("agents child runner tests passed");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
