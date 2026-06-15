import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import { formatChildAgentRunResult, runBuiltInChildAgent } from "../lib/child-runner.ts";

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
	let child;
	const result = await runBuiltInChildAgent("scout", "task", {
		maxStdoutBytes: 30,
		spawn: () => {
			child = new FakeChild();
			queueMicrotask(() => {
				child.stdout.emit("data", Buffer.from("x".repeat(80)));
			});
			return child;
		},
	});
	assert.equal(result.status, "output-limit-exceeded");
	assert.equal(result.outputLimitExceeded, true);
	assert.equal(result.summary.truncation.stdoutBytesTruncated, true);
	assert.deepEqual(child.kills, ["SIGTERM"]);
}

async function testSpawnErrorAndInvalidLimits() {
	const result = await runBuiltInChildAgent("scout", "task", {
		spawn: () => {
			throw new Error("missing pi");
		},
	});
	assert.equal(result.status, "spawn-error");
	assert.match(result.error, /missing pi/);
	await assert.rejects(() => runBuiltInChildAgent("scout", "task", { timeoutMs: 0, spawn: () => new FakeChild() }), /timeoutMs must be a positive integer/);
	await assert.rejects(() => runBuiltInChildAgent("scout", "task", { forceKillAfterMs: 0, spawn: () => new FakeChild() }), /forceKillAfterMs must be a positive integer/);
}

async function main() {
	await testCompletedBuiltInRunUsesSafeArgvAndStdin();
	await testRejectsNonBuiltInAgentsBeforeSpawn();
	await testNonZeroExitIsFailedAndFormatsCompactResult();
	await testTimeoutKillsChild();
	await testOutputLimitKillsChildAndBoundsStdout();
	await testSpawnErrorAndInvalidLimits();
	console.log("agents child runner tests passed");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
