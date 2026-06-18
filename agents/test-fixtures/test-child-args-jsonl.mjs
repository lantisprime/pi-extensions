import assert from "node:assert/strict";
import { buildChildPiArgs, buildChildPromptText, redactChildPiArgv } from "../lib/child-args.ts";
import { parseChildJsonlLine, reduceChildJsonl } from "../lib/jsonl-monitor.ts";
import { getBuiltInAgentSpec } from "../lib/specs.ts";

const scout = getBuiltInAgentSpec("scout");
const secretTask = "FULL_DELEGATED_PROMPT should stay out of argv. Inspect src only.";

function argvText(invocation) {
	return [invocation.command, ...invocation.argv].join(" ");
}

function testChildArgsDefaultStdinTransport() {
	const invocation = buildChildPiArgs(scout, secretTask);
	assert.equal(invocation.command, "pi");
	assert.deepEqual(invocation.argv.slice(0, 3), ["--mode", "json", "--no-session"]);
	assert.equal(invocation.argv.includes("--no-approve"), true);
	assert.equal(invocation.argv.includes("--no-extensions"), true);
	assert.equal(invocation.argv.includes("--no-skills"), true);
	assert.equal(invocation.argv.includes("--no-prompt-templates"), true);
	assert.equal(invocation.argv.includes("--no-themes"), true);
	assert.equal(invocation.argv.includes("--tools"), true);
	assert.equal(invocation.argv[invocation.argv.indexOf("--tools") + 1], "read,grep,find,ls");
	assert.equal(invocation.argv.includes("-p"), true);
	assert.equal(invocation.promptTransport.kind, "stdin");
	assert.match(invocation.promptTransport.stdinText, /Role prompt:/);
	assert.match(invocation.promptTransport.stdinText, /Delegated task:/);
	assert.match(invocation.promptTransport.stdinText, /FULL_DELEGATED_PROMPT/);
	assert.equal(argvText(invocation).includes("FULL_DELEGATED_PROMPT"), false, "delegated task must not appear in argv");
	assert.equal(argvText(invocation).includes(scout.prompt.slice(0, 30)), false, "role prompt must not appear in argv");
	assert.equal(invocation.argv.includes("--approve"), false);
	assert.equal(invocation.argv.includes("-a"), false);
	assert.equal(invocation.argv.join(",").includes("run_subagent"), false);
}

function testChildArgsPrivateTempTransportAndPreview() {
	const invocation = buildChildPiArgs(scout, secretTask, {
		promptTransport: "private-temp-file",
		tempPromptPath: "/private/tmp/pi-agent-abc/prompt.md",
		explicitToolContextLoaderPath: "/Users/test/.pi/agent/extensions/tool-context-loader/index.ts",
		disableContextFiles: true,
	});
	assert.equal(invocation.promptTransport.kind, "private-temp-file");
	assert.equal(invocation.promptTransport.cleanup, true);
	assert.match(invocation.promptTransport.fileText, /FULL_DELEGATED_PROMPT/);
	assert.equal(invocation.argv.includes("@/private/tmp/pi-agent-abc/prompt.md"), true);
	assert.equal(argvText(invocation).includes("FULL_DELEGATED_PROMPT"), false);
	assert.deepEqual(redactChildPiArgv(invocation.argv).filter((arg) => arg.startsWith("@")), ["@<prompt-file>"]);
	assert.equal(invocation.argv.filter((arg) => arg === "-e").length, 1);
	assert.equal(invocation.argv[invocation.argv.indexOf("-e") + 1], "/Users/test/.pi/agent/extensions/tool-context-loader/index.ts");
	assert.equal(invocation.argv.includes("--no-extensions"), true, "explicit loader path must not re-enable broad extension discovery");
	assert.equal(invocation.argv.includes("--no-context-files"), true);
	assert.equal(buildChildPiArgs(scout, secretTask, { disableResourceDiscovery: false }).argv.includes("--no-extensions"), false);
}

function testChildArgsRejectsUnsafeInputs() {
	assert.throws(() => buildChildPiArgs(scout, "   "), /non-empty/);
	assert.throws(() => buildChildPiArgs(scout, "x".repeat(scout.inputContract.maxTaskChars + 1)), /maxTaskChars/);
	assert.throws(() => buildChildPiArgs({ ...scout, tools: ["read", "run_subagent"] }, "task"), /forbidden child tool 'run_subagent'/);
	assert.throws(() => buildChildPiArgs({ ...scout, tools: ["read", "bash"] }, "task"), /forbidden child tool 'bash'/);
	assert.throws(() => buildChildPiArgs({ ...scout, tools: ["read files"] }, "task"), /unsafe tool name/);
	assert.throws(() => buildChildPiArgs({ ...scout, model: "bad model" }, "task"), /model must be a safe argv token/);
	assert.throws(() => buildChildPiArgs(scout, "task", { promptTransport: "private-temp-file" }), /tempPromptPath is required/);
	assert.throws(() => buildChildPiArgs(scout, "task", { promptTransport: "bogus" }), /unsupported promptTransport/);
	assert.throws(() => buildChildPiArgs(scout, "task", { promptTransport: "private-temp-file", tempPromptPath: "/tmp/bad\npath.md" }), /tempPromptPath must not contain/);
	assert.throws(() => buildChildPiArgs(scout, "task", { explicitToolContextLoaderPath: "/tmp/bad\npath.ts" }), /explicitToolContextLoaderPath must not contain/);
}

function testPromptTextIsDeterministicAndBoundedByTaskValidation() {
	const prompt = buildChildPromptText(scout, "Inspect only README.");
	assert.match(prompt, /^Agent: scout/);
	assert.match(prompt, /Required sections: Files\/paths inspected, Concise findings, Unknowns\/follow-up questions/);
	assert.match(prompt, /Delegated task:\nInspect only README\./);
}

function fakeLine(event) {
	return JSON.stringify(event);
}

function testJsonlReductionExtractsSummaryToolsAndMetadata() {
	const jsonl = [
		fakeLine({ type: "session", version: 3, id: "session-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/repo" }),
		fakeLine({ type: "agent_start" }),
		fakeLine({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "README.md", other: "x" } }),
		fakeLine({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "read", result: { content: "A".repeat(80) }, isError: false }),
		fakeLine({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "streaming fallback" } }),
		fakeLine({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", text: "THINKING_DELTA_SENTINEL" }, { type: "text", text: "Final answer" }], usage: { inputTokens: 10, outputTokens: 4 }, costUsd: 0.001, stopReason: "end_turn", model: "sonnet", provider: "anthropic" } }),
		fakeLine({ type: "agent_end", messages: [{ role: "user", content: "ignore" }, { role: "assistant", content: [{ type: "text", text: "Agent end answer" }] }] }),
	].join("\n");
	const summary = reduceChildJsonl(jsonl, { maxToolResultChars: 20 });
	assert.equal(summary.session.id, "session-1");
	assert.equal(summary.eventsSeen, 7);
	assert.equal(summary.malformedLines, 0);
	assert.equal(summary.summaryText, "Agent end answer");
	assert.equal(summary.summaryText.includes("THINKING_DELTA_SENTINEL"), false);
	assert.equal(summary.toolCalls.length, 1);
	assert.equal(summary.toolCalls[0].name, "read");
	assert.equal(summary.toolCalls[0].argsPreview, '{"other":"x","path":"README.md"}');
	assert.equal(summary.toolCalls[0].resultPreview.length, 20);
	assert.equal(summary.toolCalls[0].isError, false);
	assert.equal(summary.truncation.toolResultCharsTruncated, true);
	assert.deepEqual(summary.usage, { inputTokens: 10, outputTokens: 4 });
	assert.equal(summary.cost, 0.001);
	assert.equal(summary.stopReason, "end_turn");
	assert.equal(summary.model, "sonnet");
	assert.equal(summary.provider, "anthropic");
}

function testJsonlReductionHandlesMalformedOversizedAndFallback() {
	const longLine = fakeLine({ type: "message_end", message: { role: "assistant", content: "this line is deliberately long ".repeat(20) } });
	const summary = reduceChildJsonl([
		fakeLine({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "THINKING_DELTA_SENTINEL" } }),
		fakeLine({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello " } }),
		fakeLine({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } }),
		"{bad json",
		longLine,
	], { maxJsonLineBytes: 120, maxSummaryChars: 8 });
	assert.equal(summary.summaryText, "Hello wo");
	assert.equal(summary.summaryText.includes("THINKING_DELTA_SENTINEL"), false);
	assert.equal(summary.malformedLines, 1);
	assert.equal(summary.truncation.jsonLineBytesTruncated, true);
	assert.equal(summary.truncation.summaryCharsTruncated, true);
	assert.equal(summary.errors.some((error) => /not valid JSON/.test(error)), true);
	assert.equal(summary.errors.some((error) => /maxJsonLineBytes/.test(error)), true);
}

function testJsonlReductionRejectsInvalidLimits() {
	assert.throws(() => reduceChildJsonl("", { maxStdoutBytes: 0 }), /maxStdoutBytes must be a positive integer/);
	assert.throws(() => reduceChildJsonl("", { maxJsonLineBytes: -1 }), /maxJsonLineBytes must be a positive integer/);
	assert.throws(() => reduceChildJsonl("", { maxSummaryChars: 1.5 }), /maxSummaryChars must be a positive integer/);
}

function testJsonlReductionStdoutAndToolCountTruncation() {
	const lines = [
		fakeLine({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "a" } }),
		fakeLine({ type: "tool_execution_start", toolCallId: "2", toolName: "grep", args: { pattern: "needle" } }),
		fakeLine({ type: "message_end", message: { role: "assistant", content: "Done" } }),
	];
	const toolLimited = reduceChildJsonl(lines, { maxToolCalls: 1 });
	assert.equal(toolLimited.toolCalls.length, 1);
	assert.equal(toolLimited.truncation.toolCallsTruncated, true);
	const stdoutLimited = reduceChildJsonl(lines.join("\n"), { maxStdoutBytes: 60 });
	assert.equal(stdoutLimited.truncation.stdoutBytesTruncated, true);
}

function testParseLine() {
	assert.equal(parseChildJsonlLine('{"type":"agent_start"}').ok, true);
	assert.equal(parseChildJsonlLine('{bad').ok, false);
}

function main() {
	testChildArgsDefaultStdinTransport();
	testChildArgsPrivateTempTransportAndPreview();
	testChildArgsRejectsUnsafeInputs();
	testPromptTextIsDeterministicAndBoundedByTaskValidation();
	testJsonlReductionExtractsSummaryToolsAndMetadata();
	testJsonlReductionHandlesMalformedOversizedAndFallback();
	testJsonlReductionRejectsInvalidLimits();
	testJsonlReductionStdoutAndToolCountTruncation();
	testParseLine();
	console.log("agents child args/jsonl tests passed");
}

main();
