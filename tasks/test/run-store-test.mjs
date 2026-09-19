// Unit tests for the pure task-store logic. Run:
//   npm exec -y --package=tsx -- tsx test/run-store-test.mjs
import assert from "node:assert/strict";
import {
	allSettled,
	compareIds,
	createTask,
	MAX_ATTEMPTS,
	MAX_TASKS,
	renderContextBlock,
	renderModelList,
	renderStatusLine,
	renderWidgetLines,
	sanitizeCode,
	taskCode,
	TRANSITIONS,
	updateTask,
} from "../lib/store.ts";

let pass = 0;
async function check(name, fn) {
	await fn();
	pass += 1;
	console.log(`✓ ${name}`);
}

const ENV = (now = 1000, observed = true) => ({ now, observedActivity: observed });

// --- codes & ids -----------------------------------------------------------

await check("sanitizeCode uppercases, strips, bounds", () => {
	assert.equal(sanitizeCode("brain launch"), "BRAIN-LAUNCH");
	assert.equal(sanitizeCode("  attest--v2! "), "ATTEST-V2");
	assert.equal(sanitizeCode("a".repeat(30)), "A".repeat(16));
	assert.equal(sanitizeCode("!!!"), "");
});

await check("taskCode strips numeric suffix", () => {
	assert.equal(taskCode("ARCH-1"), "ARCH");
	assert.equal(taskCode("BRAIN-LAUNCH-12"), "BRAIN-LAUNCH");
});

await check("compareIds sorts numerically within a code", () => {
	const ids = ["ARCH-10", "ARCH-2", "BRAIN-1", "ARCH-1"];
	assert.deepEqual(ids.sort(compareIds), ["ARCH-1", "ARCH-2", "ARCH-10", "BRAIN-1"]);
});

await check("lifecycle table: terminal states have no exits", () => {
	assert.deepEqual(TRANSITIONS.completed, []);
	assert.deepEqual(TRANSITIONS.cancelled, []);
	assert.ok(TRANSITIONS.pending.includes("in_progress"));
	assert.ok(TRANSITIONS.pending.includes("cancelled"));
	assert.ok(TRANSITIONS.in_progress.includes("completed"));
	assert.ok(TRANSITIONS.in_progress.includes("cancelled"));
	assert.ok(TRANSITIONS.in_progress.includes("pending"));
});

// --- create ----------------------------------------------------------------

await check("createTask derives id from LLM-provided code", () => {
	const r1 = createTask([], { code: "arch", subject: "Architect slices", description: "Slice ARCH-1..4" });
	assert.equal(r1.task.id, "ARCH-1");
	assert.equal(r1.task.status, "pending");
	const r2 = createTask(r1.tasks, { code: "ARCH", subject: "Second slice", description: "d" });
	assert.equal(r2.task.id, "ARCH-2");
	const r3 = createTask(r2.tasks, { code: "BRAIN-LAUNCH", subject: "flip posture", description: "d" });
	assert.equal(r3.task.id, "BRAIN-LAUNCH-1");
});

await check("createTask warns on in_progress work and duplicate settled codes", () => {
	let tasks = createTask([], { code: "Z", subject: "z", description: "d" }).tasks;
	tasks = updateTask(tasks, "Z-1", { status: "in_progress" }, ENV()).tasks;
	const withOpen = createTask(tasks, { code: "B", subject: "y", description: "d" });
	assert.match(withOpen.warnings.join(" "), /Z-1 still in_progress/);

	const settled = updateTask(tasks, "Z-1", { status: "completed", evidence: "ran the full suite, 34/34 green, commit abc1234" }, ENV(2000)).tasks;
	const dup = createTask(settled, { code: "Z", subject: "z again", description: "d" });
	assert.match(dup.warnings.join(" "), /already has settled task/);
});

await check("createTask enforces MAX_TASKS", () => {
	let tasks = [];
	for (let i = 0; i < MAX_TASKS; i++) tasks = createTask(tasks, { code: "T", subject: `t${i}`, description: "d" }).tasks;
	const full = createTask(tasks, { code: "T", subject: "one too many", description: "d" });
	assert.match(full.error, /Task list is full/);
	assert.equal(full.task, undefined);
});

// --- update: lifecycle & guards --------------------------------------------

function seedPair() {
	let tasks = createTask([], { code: "A", subject: "a", description: "d" }).tasks;
	tasks = createTask(tasks, { code: "B", subject: "b", description: "d" }).tasks;
	return tasks;
}

await check("complete requires in_progress first (lifecycle table)", () => {
	const tasks = seedPair();
	const r = updateTask(tasks, "A-1", { status: "completed", evidence: "did the thing end to end, tests pass" }, ENV());
	assert.match(r.error, /Illegal transition pending → completed/);
	// The inProgressAt guard backs it up for direct in_progress→completed calls.
	let t2 = updateTask(tasks, "A-1", { status: "in_progress" }, ENV(1000)).tasks;
	t2[0] = { ...t2[0], inProgressAt: undefined }; // simulate corrupted state
	const r2 = updateTask(t2, "A-1", { status: "completed", evidence: "claims completion with zero observed work" }, ENV(2000, true));
	assert.match(r2.error, /never marked in_progress/);
});

await check("complete requires observed tool activity (anti-hallucination)", () => {
	let tasks = seedPair();
	tasks = updateTask(tasks, "A-1", { status: "in_progress" }, ENV(1000)).tasks;
	const r = updateTask(tasks, "A-1", { status: "completed", evidence: "claims victory without doing anything at all" }, ENV(2000, false));
	assert.match(r.error, /no tool activity was observed/);
	assert.equal(r.tasks.find((t) => t.id === "A-1").status, "in_progress");
});

await check("complete with evidence + observed activity works", () => {
	let tasks = seedPair();
	tasks = updateTask(tasks, "A-1", { status: "in_progress" }, ENV(1000)).tasks;
	const r = updateTask(tasks, "A-1", { status: "completed", evidence: "ran npm test: 34/34 pass; fixed src/auth.ts race" }, ENV(2000, true));
	assert.equal(r.error, undefined);
	assert.equal(r.task.status, "completed");
	assert.equal(r.task.evidence.kind, "completion");
	assert.equal(r.task.evidence.observed, true);
	assert.match(r.warnings.join(" "), /Next: B-1/);
});

await check("complete/cancel reject short or missing evidence", () => {
	let tasks = seedPair();
	tasks = updateTask(tasks, "A-1", { status: "in_progress" }, ENV(1000, true)).tasks;
	for (const evidence of [undefined, "", "too short"]) {
		const r = updateTask(tasks, "A-1", { status: "completed", evidence }, ENV(2000));
		assert.match(r.error, /without evidence/);
	}
	const c = updateTask(tasks, "A-1", { status: "cancelled" }, ENV(2000));
	assert.match(c.error, /Cannot cancel A-1 without evidence/);
});

await check("cancel records evidence and settles", () => {
	let tasks = seedPair();
	tasks = updateTask(tasks, "A-1", { status: "cancelled", evidence: "operator asked to drop this approach entirely" }, ENV()).tasks;
	assert.equal(tasks[0].status, "cancelled");
	assert.equal(tasks[0].evidence.kind, "cancellation");
	assert.ok(allSettled(tasks) === false); // B-1 still pending
	assert.ok(tasks[0].settledAt > 0);
});

await check("terminal states never re-open", () => {
	let tasks = seedPair();
	tasks = updateTask(tasks, "A-1", { status: "cancelled", evidence: "dropped on purpose, superseded by plan B" }, ENV()).tasks;
	for (const status of ["pending", "in_progress"]) {
		const r = updateTask(tasks, "A-1", { status }, ENV());
		assert.match(r.error, /terminal/);
	}
});

await check("only one in_progress at a time", () => {
	let tasks = seedPair();
	tasks = updateTask(tasks, "A-1", { status: "in_progress" }, ENV()).tasks;
	const r = updateTask(tasks, "B-1", { status: "in_progress" }, ENV());
	assert.match(r.error, /A-1 still in_progress/);
});

await check("blockedBy gate on start", () => {
	let tasks = seedPair();
	tasks = updateTask(tasks, "B-1", { addBlockedBy: ["A-1"] }).tasks;
	const r = updateTask(tasks, "B-1", { status: "in_progress" }, ENV());
	assert.match(r.error, /blocked by A-1/);
	// settle the blocker → start allowed
	tasks = updateTask(tasks, "A-1", { status: "in_progress" }, ENV(1000)).tasks;
	tasks = updateTask(tasks, "A-1", { status: "completed", evidence: "blocker done, suite green, commit def5678" }, ENV(2000)).tasks;
	const ok = updateTask(tasks, "B-1", { status: "in_progress" }, ENV(3000));
	assert.equal(ok.error, undefined);
});

// --- retry machinery ---------------------------------------------------------

await check("retry: shelve with evidence records failure; budget exhausts", () => {
	let tasks = seedPair();
	// attempt 1
	tasks = updateTask(tasks, "A-1", { status: "in_progress" }, ENV(1000)).tasks;
	let shelve = updateTask(tasks, "A-1", { status: "pending", evidence: "npm test fails: ECONNREFUSED on db, retried twice" }, ENV(2000));
	tasks = shelve.tasks;
	assert.equal(tasks[0].failures, 1);
	assert.match(tasks[0].lastError, /ECONNREFUSED/);
	assert.match(shelve.warnings.join(" "), /Failure recorded/);
	// attempt 2
	tasks = updateTask(tasks, "A-1", { status: "in_progress" }, ENV(3000)).tasks;
	assert.match(shelve.tasks === tasks ? "" : "", /|/); // no-op assert
	assert.equal(tasks[0].attempts, 2);
	tasks = updateTask(tasks, "A-1", { status: "pending", evidence: "still failing: same ECONNREFUSED, infra down" }, ENV(4000)).tasks;
	// attempt 3
	tasks = updateTask(tasks, "A-1", { status: "in_progress" }, ENV(5000)).tasks;
	assert.equal(tasks[0].attempts, MAX_ATTEMPTS);
	tasks = updateTask(tasks, "A-1", { status: "pending", evidence: "third failure, root cause unclear" }, ENV(6000)).tasks;
	// budget exhausted
	const blocked = updateTask(tasks, "A-1", { status: "in_progress" }, ENV(7000));
	assert.match(blocked.error, /attempt budget exhausted/);
	assert.match(blocked.error, /ask the operator/);
});

await check("retry: neutral shelve (no evidence) still burns attempts", () => {
	let tasks = seedPair();
	for (let i = 0; i < MAX_ATTEMPTS; i++) {
		tasks = updateTask(tasks, "A-1", { status: "in_progress" }, ENV(i * 1000)).tasks;
		if (i < MAX_ATTEMPTS - 1) tasks = updateTask(tasks, "A-1", { status: "pending" }, ENV(i * 1000 + 100)).tasks;
	}
	assert.equal(tasks[0].attempts, MAX_ATTEMPTS);
	// shelve the running attempt, then the budget is exhausted
	tasks = updateTask(tasks, "A-1", { status: "pending" }, ENV(9000)).tasks;
	const blocked = updateTask(tasks, "A-1", { status: "in_progress" }, ENV(9999));
	assert.match(blocked.error, /attempt budget exhausted/);
	assert.ok(!tasks[0].failures); // neutral shelve never records a failure
});

// --- rendering -------------------------------------------------------------

await check("widget matches Claude Code collapsed sample format", () => {
	let tasks = [];
	const seeds = [
		["ARCH", "Architect agent slices ARCH-1..4"],
		["BRAIN-LAUNCH", "flip brain-launch posture"],
		["ATTEST-V2", "attest self-competition workdir v2"],
		["D", "d4"],
		["E", "d5"],
		["F", "d6"],
		["G", "d7"],
		["H", "d8"],
		["I", "d9"],
	];
	for (const [code, description] of seeds) tasks = createTask(tasks, { code, subject: description, description }).tasks;
	for (const id of ["D-1", "E-1"]) {
		tasks = updateTask(tasks, id, { status: "in_progress" }, ENV(900, true)).tasks;
		tasks = updateTask(tasks, id, { status: "completed", evidence: "verified end to end, all checks pass, commit aaa111" }, ENV(1000, true)).tasks;
	}
	const lines = renderWidgetLines(tasks, false);
	assert.deepEqual(lines.slice(0, 3), [
		"◻ ARCH: Architect agent slices ARCH-1..4",
		"◻ BRAIN-LAUNCH: flip brain-launch posture",
		"◻ ATTEST-V2: attest self-competition workdir v2",
	]);
	assert.match(lines[3], /^ … \+4 pending, 2 completed$/);
});

await check("widget suffixes codes shared by multiple tasks", () => {
	let tasks = createTask([], { code: "ARCH", subject: "s1", description: "first slice" }).tasks;
	tasks = createTask(tasks, { code: "ARCH", subject: "s2", description: "second slice" }).tasks;
	const lines = renderWidgetLines(tasks, false);
	assert.equal(lines[0], "◻ ARCH-1: first slice");
	assert.equal(lines[1], "◻ ARCH-2: second slice");
});

await check("widget all-settled line mentions cancelled", () => {
	let tasks = seedPair();
	tasks = updateTask(tasks, "A-1", { status: "in_progress" }, ENV(1000)).tasks;
	tasks = updateTask(tasks, "A-1", { status: "completed", evidence: "did it, tests green, commit ccc3333" }, ENV(2000)).tasks;
	tasks = updateTask(tasks, "B-1", { status: "cancelled", evidence: "no longer needed after A-1 solved it" }, ENV()).tasks;
	const lines = renderWidgetLines(tasks, false);
	assert.match(lines[0], /All 2 tasks settled \(1 completed, 1 cancelled\)/);
});

await check("context block: open tasks + settled references + drift rule", () => {
	let tasks = createTask([], { code: "ARCH", subject: "Architect slices", description: "slice work" }).tasks;
	tasks = createTask(tasks, { code: "BRAIN-LAUNCH", subject: "flip posture", description: "flip it" }).tasks;
	// BRAIN-LAUNCH-1 runs and settles BEFORE ARCH-1 starts (one-in-progress rule).
	tasks = updateTask(tasks, "BRAIN-LAUNCH-1", { status: "in_progress" }, ENV(1000, true)).tasks;
	tasks = updateTask(tasks, "BRAIN-LAUNCH-1", { status: "completed", evidence: "flipped, verified via probe, commit ddd4444" }, ENV(2000, true)).tasks;
	tasks = updateTask(tasks, "ARCH-1", { status: "in_progress" }, ENV(3000, true)).tasks;
	const block = renderContextBlock(tasks, "/repo");
	assert.match(block, /<session-tasks project="\/repo">/);
	assert.match(block, /◐ ARCH-1 \[in_progress\] Architect slices — slice work/);
	assert.match(block, /✓ 1 completed: BRAIN-LAUNCH-1/);
	assert.match(block, /continue autonomously/);
	assert.ok(!/Ask the operator/.test(block));
});

await check("context block: all-settled is compact and asks once", () => {
	let tasks = seedPair();
	tasks = updateTask(tasks, "A-1", { status: "in_progress" }, ENV(1000)).tasks;
	tasks = updateTask(tasks, "A-1", { status: "completed", evidence: "done with full suite, commit eee5555" }, ENV(2000)).tasks;
	tasks = updateTask(tasks, "B-1", { status: "cancelled", evidence: "obsolete — fully superseded by the A-1 result" }, ENV()).tasks;
	assert.ok(tasks[0].evidence.note.length >= 20);
	const pendingAsk = renderContextBlock(tasks, "/repo", { cleanupState: "pending" });
	assert.match(pendingAsk, /✓ All 2 tasks settled \(A-1, B-1\)\./);
	assert.match(pendingAsk, /Ask the operator/);
	const declined = renderContextBlock(tasks, "/repo", { cleanupState: "declined" });
	assert.match(declined, /✓ All 2 tasks settled/);
	assert.ok(!/Ask the operator/.test(declined));
});

await check("status line is a one-liner", () => {
	let tasks = seedPair();
	tasks = updateTask(tasks, "A-1", { status: "in_progress" }, ENV()).tasks;
	assert.equal(renderStatusLine(tasks), "[tasks] 0/2 done · A-1 in_progress");
	assert.equal(renderStatusLine([]), null);
});

await check("model list renders ids, evidence, counts", () => {
	let tasks = seedPair();
	tasks = updateTask(tasks, "A-1", { status: "in_progress" }, ENV(1000)).tasks;
	tasks = updateTask(tasks, "A-1", { status: "completed", evidence: "implemented feature x, all tests pass, commit fff6666" }, ENV(2000)).tasks;
	const list = renderModelList(tasks);
	assert.match(list, /A-1 \[completed\] a: d/);
	assert.match(list, /evidence\(completion, observed=true\): implemented feature x/);
	assert.match(list, /2 total · 1 completed · 0 in_progress · 1 pending/);
});

console.log(`\nAll ${pass} store tests passed`);
