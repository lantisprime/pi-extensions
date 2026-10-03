// chain-runner unit tests: relay handoff budgeting (M1), untrusted framing +
// per-step cap (M2), per-step timeout + abort (M3/M4), partial results.
//
// These were gaps the adversarial review flagged: the only chain coverage lived
// in the agents_run wiring tests, which fake runChain entirely — so the relay's
// own context handling had NO test at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	MAX_ACCUMULATED_HANDOFF_CHARS,
	MAX_CHAIN_LENGTH,
	MAX_HANDOFF_SEGMENT_BYTES,
	appendHandoffSegment,
	partialFindings,
	runChain,
	truncateToUtf8Bytes,
} from "../lib/chain-runner.ts";

const builtIn = (name) => ({ name, source: "built-in", spec: name });
const bytes = (s) => Buffer.byteLength(s, "utf8");

test("truncateToUtf8Bytes respects the byte budget on multibyte text", () => {
	// The bug: `text.slice(0, maxBytes)` counts UTF-16 code units, so a 3-byte
	// CJK summary passed ~3x the budget it was measured against.
	const cjk = "漢".repeat(500);
	const out = truncateToUtf8Bytes(cjk, 100);
	assert.ok(bytes(out.text) <= 100, `cut must be within budget, got ${bytes(out.text)}`);
	assert.equal(out.truncated, true);
	assert.ok(!out.text.includes("\uFFFD"), "must not split a multi-byte sequence into mojibake");
	// Every surviving char is intact (no partial sequence).
	assert.equal([...out.text].every((ch) => ch === "漢"), true);

	// Emoji (surrogate pairs, 4 bytes) must not be cut in half.
	const emoji = "🙂".repeat(200);
	const emojiOut = truncateToUtf8Bytes(emoji, 101);
	assert.ok(bytes(emojiOut.text) <= 101);
	assert.ok(!emojiOut.text.includes("\uFFFD"), "must not emit a lone surrogate");

	// Under budget: untouched, not marked truncated.
	assert.deepEqual(truncateToUtf8Bytes("hello", 100), { text: "hello", truncated: false });
	// Degenerate budget: empty, still honest about truncation.
	assert.deepEqual(truncateToUtf8Bytes("hello", 0), { text: "", truncated: true });
});

test("appendHandoffSegment stays inside the aggregate byte budget", () => {
	let handoff = "";
	// Three steps, each deliberately huge: the aggregate cap must hold.
	for (let step = 1; step <= 3; step++) {
		handoff = appendHandoffSegment(handoff, step, `agent-${step}`, "漢".repeat(20_000));
		assert.ok(
			bytes(handoff) <= MAX_ACCUMULATED_HANDOFF_CHARS,
			`after step ${step}: ${bytes(handoff)} bytes must be <= ${MAX_ACCUMULATED_HANDOFF_CHARS}`,
		);
	}
	// A later step must be told that earlier ones were cut, not silently vanish.
	assert.match(handoff, /omitted: relay byte cap reached/);
	// Each step's own segment is capped so one verbose step can't eat the budget.
	const single = appendHandoffSegment("", 1, "verbose", "x".repeat(MAX_HANDOFF_SEGMENT_BYTES * 2));
	assert.ok(bytes(single) <= MAX_ACCUMULATED_HANDOFF_CHARS);
	assert.ok(single.includes("[step 1 — verbose]"), "segments are labelled with origin");
});

test("appendHandoffSegment labels and fits a small relay exactly", () => {
	const handoff = appendHandoffSegment("", 1, "scout", "found a bug");
	assert.equal(handoff, "[step 1 — scout]\nfound a bug");
	assert.equal(appendHandoffSegment(handoff, 2, "planner", "plan ready").includes("[step 2 — planner]"), true);
});

test("runChain relays prior summaries as framed untrusted data", async () => {
	const seen = [];
	const outcome = await runChain([builtIn("scout"), builtIn("planner")], "do the thing", {
		agentsChildRunner: async (agent, task, options) => {
			seen.push({ agent, task, options });
			return {
				status: "completed",
				durationMs: 1,
				timedOut: false,
				outputLimitExceeded: false,
				summary: { summaryText: `FINDING-FROM-${agent}`, toolCalls: [] },
			};
		},
	});
	assert.equal(outcome.ok, true);
	assert.equal(seen.length, 2);

	// Step 1 gets the bare task — nothing to relay yet.
	assert.ok(!seen[0].task.includes("FINDING-FROM-scout"));
	// Step 2 carries step 1's summary, inside the untrusted boundary.
	assert.match(seen[1].task, /FINDING-FROM-scout/, "prior finding is relayed");
	assert.match(seen[1].task, /UNTRUSTED SUBAGENT OUTPUT/, "relay is framed as untrusted");
	assert.match(seen[1].task, /\[step 1 — scout\]/, "relay is attributed to its step");
	// The real task must survive alongside the relay.
	assert.ok(seen[1].task.includes("do the thing"));
});

test("runChain applies timeout_s per step", async () => {
	const optionsSeen = [];
	await runChain([builtIn("scout"), builtIn("planner")], "t", {
		timeoutMs: 45_000,
		agentsChildRunner: async (_agent, _task, options) => {
			optionsSeen.push(options);
			return { status: "completed", durationMs: 1, timedOut: false, outputLimitExceeded: false, summary: { summaryText: "ok", toolCalls: [] } };
		},
	});
	assert.equal(optionsSeen.length, 2, "both steps ran");
	for (const o of optionsSeen) assert.equal(o.timeoutMs, 45_000, "every step carries the timeout");

	// No timeout_s → the child runner keeps its own default (no key injected).
	const bare = [];
	await runChain([builtIn("scout"), builtIn("planner")], "t", {
		agentsChildRunner: async (_agent, _task, options) => {
			bare.push(options);
			return { status: "completed", durationMs: 1, timedOut: false, outputLimitExceeded: false, summary: { summaryText: "ok", toolCalls: [] } };
		},
	});
	assert.equal("timeoutMs" in bare[0], false);
});

test("runChain stops on abort and keeps the completed step", async () => {
	const controller = new AbortController();
	const ran = [];
	const outcome = await runChain([builtIn("scout"), builtIn("planner")], "t", {
		signal: controller.signal,
		agentsChildRunner: async (agent, _task, options) => {
			ran.push(agent);
			// The child-runner seam is handed the signal so it can kill the child.
			assert.ok(options.signal instanceof AbortSignal, "signal reaches the child runner");
			if (agent === "scout") controller.abort();
			return { status: "completed", durationMs: 1, timedOut: false, outputLimitExceeded: false, summary: { summaryText: "first", toolCalls: [] } };
		},
	});
	assert.equal(outcome.ok, false);
	assert.equal(outcome.code, "aborted");
	assert.deepEqual(ran, ["scout"], "the chain must not spawn the next step after an abort");
	assert.equal(outcome.results.length, 1, "the completed step is not lost");
	assert.equal(outcome.results[0].agentName, "scout");
});

test("runChain returns completed steps when a later step fails", async () => {
	const outcome = await runChain([builtIn("scout"), builtIn("planner")], "t", {
		agentsChildRunner: async (agent) => {
			if (agent === "scout") return { status: "completed", durationMs: 1, timedOut: false, outputLimitExceeded: false, summary: { summaryText: "good work", toolCalls: [] } };
			return { status: "timeout", durationMs: 2, timedOut: true, outputLimitExceeded: false, summary: { summaryText: "", toolCalls: [] } };
		},
	});
	assert.equal(outcome.ok, false);
	assert.equal(outcome.code, "timeout");
	// Both steps are retained: the one that completed, and the one that failed
	// (pushed before the status check, so the caller can see where it stopped).
	assert.equal(outcome.results.length, 2);
	assert.deepEqual(outcome.results.map((r) => `${r.agentName}:${r.status}`), ["scout:completed", "planner:timeout"]);
	assert.match(partialFindings(outcome.results, 200), /good work/);
});

test("cap and partial-findings helpers agree with the runner", () => {
	assert.equal(MAX_CHAIN_LENGTH, 3);
	assert.equal(partialFindings([]), "", "no findings renders nothing rather than an empty header");
	assert.match(partialFindings([{ agentName: "scout", status: "completed", summaryText: "abc", durationMs: 1 }]), /- scout \(completed\): abc/);
});
