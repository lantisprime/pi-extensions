#!/usr/bin/env node
// task-subjects.test.ts — regression for "the context is always compacting".
//
// Live symptom (2026-10-03, session 01a100fc): three compactions in eight
// minutes at 61k / 61k / 45k tokens of a 200k window, and every single gate
// call reported `p=0.5 source=default` — the "no active tasks" branch. Jev was
// never consulted, and the relevance gate that exists to protect task context
// could not intervene.
//
// Cause: the tasks extension renders a DIFFERENT block shape once every task
// is settled (which is exactly the state this session was in — HERDR-1 settled,
// awaiting task_clear). That form has no `CODE-N [status] subject` rows, so
// subject extraction returned [], "no active tasks" was concluded, p=0.5 was
// returned, and 0.5 maps to `focused` (proceed) because it sits between
// aggressiveBelow 0.35 and deferAbove 0.7.
//
// The blocks below are byte-for-byte the renderContextBlock output from
// ~/.pi/agent/extensions/tasks/lib (STATUS_ICON: pending ◻, in_progress ◐,
// completed ✓, cancelled ✗).
//
// Run: node --experimental-strip-types smart-compaction/test/task-subjects.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { parseTaskBoard } from "../lib/task-subjects.ts";
import { relevanceGate, mapAction } from "../lib/gate.ts";

const GATE = { enabled: true, aggressiveBelow: 0.35, deferAbove: 0.7 };

const ALL_SETTLED = [
	'<session-tasks project="/Users/charltonho/Developer/projects/pi-extensions">',
	"✓ All 1 tasks settled (HERDR-1).",
	"Ask the operator for permission, then call task_clear to delete the finished set so it does not accumulate.",
	"</session-tasks>",
].join("\n");

const MIXED = [
	'<session-tasks project="/x">',
	"◐ HERDR-1 [in_progress] Fix the herdr pane-ref parser",
	"◻ HERDR-2 [pending] Add regression tests",
	"✓ 1 completed: HERDR-0",
	"Work in listed order. Exactly one in_progress; settle with evidence when done.",
	"</session-tasks>",
].join("\n");

// ---------------------------------------------------------------------------

test("no task block at all -> state none", () => {
	const b = parseTaskBoard("You are a helpful assistant.\nNo tasks here.");
	assert.equal(b.state, "none");
	assert.deepEqual(b.activeSubjects, []);
});

test("active rows -> subjects extracted, state active", () => {
	const b = parseTaskBoard(MIXED);
	assert.equal(b.state, "active");
	assert.deepEqual(b.activeSubjects, ["Fix the herdr pane-ref parser", "Add regression tests"]);
	assert.equal(b.settledCount, 1);
});

test("THE BUG: all-settled board is not 'no tasks' — state settled", () => {
	const b = parseTaskBoard(ALL_SETTLED);
	// Before the fix this returned [] and the gate said "no active tasks".
	assert.equal(b.state, "settled");
	assert.deepEqual(b.activeSubjects, []);
	assert.equal(b.settledCount, 1);
});

test("bare task row with no <session-tasks> wrapper still parses (pre-fix behaviour)", () => {
	// The wiring suite renders exactly this shape. Requiring the wrapper would
	// silently drop every subject in that configuration — that was a real
	// regression caught by test/wiring.test.ts, not a hypothetical.
	const b = parseTaskBoard("◐ TEST-1 [in_progress] alpha beta gamma delta");
	assert.equal(b.state, "active");
	assert.deepEqual(b.activeSubjects, ["alpha beta gamma delta"]);
});

test("the 0.5 default resolves to proceed — why the old path authorized compaction", () => {
	// Documents the exact chain that caused the bug, so a future change to the
	// thresholds has to confront it.
	assert.equal(mapAction(0.5, GATE), "focused");
});

// The behavioural guarantee: an all-settled board must NOT authorize a
// compaction, and must not fabricate a probability for a judgment it never made.
test("all-settled board defers, claiming no probability", async () => {
	const b = parseTaskBoard(ALL_SETTLED);
	const g = await relevanceGate(b.activeSubjects, "some long conversation excerpt", GATE, undefined, b);
	assert.equal(g.action, "defer", "must not compact the completed work's own context");
	assert.equal(g.source, "task-board");
	assert.equal(g.probability, undefined, "a policy defer must not claim a judgment");
	assert.match(g.detail ?? "", /awaiting task_clear/);
});

test("no board at all keeps the documented proceed default (no regression)", async () => {
	const b = parseTaskBoard("plain prompt, no tasks");
	const g = await relevanceGate(b.activeSubjects, "excerpt", GATE, undefined, b);
	assert.equal(g.action, "focused");
	assert.equal(g.source, "default");
	assert.equal(g.probability, 0.5);
});

test("active board still reaches the Jev/heuristic path with real subjects", async () => {
	const b = parseTaskBoard(MIXED);
	assert.equal(b.state, "active");
	// Heuristic path (no API key in tests) must not short-circuit to "default".
	const g = await relevanceGate(b.activeSubjects, "the herdr pane ref parser fix", GATE, undefined, b);
	assert.notEqual(g.source, "default");
	assert.notEqual(g.source, "task-board");
});

test("cancelled and completed rows never become subjects", () => {
	const b = parseTaskBoard(
		[
			"<session-tasks project=\"/x\">",
			"✓ DONE-1 [completed] Already shipped",
			"✗ DEAD-1 [cancelled] Abandoned approach",
			"◻ NEXT-1 [pending] Real work",
			"</session-tasks>",
		].join("\n"),
	);
	assert.deepEqual(b.activeSubjects, ["Real work"]);
	assert.equal(b.settledCount, 2);
});

test("subject list is bounded at 8", () => {
	const rows = Array.from({ length: 20 }, (_, i) => `◻ T-${i} [pending] Task number ${i}`);
	const b = parseTaskBoard(["<session-tasks>", ...rows, "</session-tasks>"].join("\n"));
	assert.equal(b.activeSubjects.length, 8);
});

test("unterminated block is still parsed, not treated as absent", () => {
	const b = parseTaskBoard("<session-tasks project=\"/x\">\n◐ HERDR-1 [in_progress] Truncated render");
	assert.equal(b.state, "active");
	assert.deepEqual(b.activeSubjects, ["Truncated render"]);
});
