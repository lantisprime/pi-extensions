// herdr-control: LIVE multi-dialog test in a PRIVATE herdr session.
// One real pi agent, THREE sequential tasks — each triggers its own bash
// permission dialog (pi ask mode in /tmp). The script approves each dialog
// ("Allow once" = enter, the pre-selected option) and the watchdog/classifier
// must record EVERY blocked episode with working/idle transitions between.
// Run: HERDR_ENV=1 node --experimental-strip-types test-fixtures/e2e-multi-dialog-live.mjs
import assert from "node:assert/strict";

const { createSessionHarness } = await import("./live-harness.mjs");
const harness = await createSessionHarness("herdr-control-e2e", "pi-herdr-e2e-");
process.env.HERDR_ENV = "1";

const { sessionHerdrExecutor } = await import("../lib/exec.ts");
const executor = sessionHerdrExecutor("herdr", harness.session);
const appended = [];
const fakePi = { on() {}, registerTool() {}, registerCommand() {}, registerShortcut() {}, registerFlag() {}, appendEntry(c, d) { appended.push({ c, d }); }, sendMessage(msg) { console.log(`[wake] ${String(msg.content).slice(0, 140)}`); } };
const { runSpawnForTest, stopWatchForTest } = await import("../index.ts");
const { classifyAgent } = await import("../lib/classify.ts");
const { promptAgent } = await import("../lib/prompt.ts");
const { Watchdog } = await import("../lib/watchdog.ts");

const NAME = "pi-herdr-e2e-multi";
// One bash command per task, nothing else — pi asks permission for each.
const TASKS = [
	{ file: "/tmp/e2e-m1.marker", text: "Run this exact bash command: touch /tmp/e2e-m1.marker. Run no other commands. When it succeeds reply exactly DONE1." },
	{ file: "/tmp/e2e-m2.marker", text: "Run this exact bash command: touch /tmp/e2e-m2.marker. Run no other commands. When it succeeds reply exactly DONE2." },
	{ file: "/tmp/e2e-m3.marker", text: "Run this exact bash command: touch /tmp/e2e-m3.marker. Run no other commands. When it succeeds reply exactly DONE3." },
];

const results = { blockedEpisodes: 0, dialogsApproved: 0, markers: 0, settledIdle: false, transitions: [] };
const dogEvents = [];
try {
	// Stale markers from earlier runs would short-circuit the waits.
	const { unlinkSync } = await import("node:fs");
	for (const t of TASKS) { try { unlinkSync(t.file); } catch {} }
	const spawnResult = await runSpawnForTest(fakePi, executor, {
		name: NAME,
		task: TASKS[0].text,
		kind: "pi", cwd: "/tmp", direction: "auto", timeoutMs: 150_000,
	}, (u) => console.log("[multi]", u.content[0].text.slice(0, 110)));
	harness.spawned.push(NAME);
	console.log("spawn settled with:", spawnResult.details.status ?? spawnResult.details.kind);

	const dog = new Watchdog(executor, { list: () => [{ name: NAME, paneId: "", kind: "pi" }] }, (e) => {
		dogEvents.push(e);
		console.log(`[watchdog] ${e.key}: ${e.from}→${e.to} [${e.severity}]`);
	});
	dog.socketPath = (await (await import("../lib/version.ts")).probeVersion(executor))?.socketPath ?? "";

	async function classify() {
		const r = await classifyAgent(executor, NAME);
		return r.ok ? r.classification.status : "unknown";
	}

	async function approveDialog(paneId) {
		// "Allow once" is the pre-selected (→) option: enter selects it.
		const sent = await executor.exec(["agent", "send-keys", paneId, "enter"], { timeoutMs: 15_000 });
		if (!sent.ok) console.log("  [approve] send failed:", sent.stderr.slice(0, 100));
		await new Promise((r) => setTimeout(r, 2500));
	}

	// Task 1's dialog is already pending from the spawn; tasks 2-3 via prompts.
	const paneId = spawnResult.details.paneId;
	const { existsSync } = await import("node:fs");
	for (let i = 0; i < TASKS.length; i += 1) {
		const task = TASKS[i];
		console.log(`\n--- task ${i + 1}: ${task.file}`);
		if (i > 0) {
			// Deliver the prompt; herdr REJECTS prompts to blocked agents
			// (agent_blocked) — approve first, then retry.
			let delivered = false;
			for (let attempt = 0; attempt < 10 && !delivered; attempt += 1) {
				const status = await classify();
				if (status === "blocked") {
					results.blockedEpisodes += 1;
					await dog.watchOnce();
					console.log(`  dialog ${results.blockedEpisodes}: BLOCKED — approving`);
					await approveDialog(paneId);
					results.dialogsApproved += 1;
					await new Promise((r) => setTimeout(r, 1500));
					continue;
				}
				const prompt = await promptAgent(executor, NAME, task.text, undefined, false);
				if (prompt.ok) {
					delivered = true;
				} else if (prompt.kind === "blocked") {
					await approveDialog(paneId); // herdr refused: dialog appeared
				} else {
					console.log("  prompt error:", prompt.error.slice(0, 100));
					await new Promise((r) => setTimeout(r, 2000));
				}
			}
			assert.equal(delivered, true, `task ${i + 1} prompt never delivered`);
		}

		// Approve every dialog until this task's marker file exists.
		const deadline = Date.now() + 90_000;
		while (!existsSync(task.file) && Date.now() < deadline) {
			const status = await classify();
			if (status === "blocked") {
				results.blockedEpisodes += 1;
				await dog.watchOnce();
				console.log(`  dialog ${results.blockedEpisodes}: BLOCKED — approving`);
				await approveDialog(paneId);
				results.dialogsApproved += 1;
			} else {
				await dog.watchOnce();
				await new Promise((r) => setTimeout(r, 2000));
			}
		}
		console.log(`  marker ${task.file}: ${existsSync(task.file) ? "created" : "MISSING"}`);
		if (existsSync(task.file)) results.markers += 1;
		await dog.watchOnce();
	}

	// settle: wait until the agent is idle (all tasks answered)
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if ((await classify()) === "idle") { results.settledIdle = true; break; }
		await dog.watchOnce();
		await new Promise((r) => setTimeout(r, 3000));
	}
	await dog.watchOnce();
	results.transitions = dogEvents.map((e) => `${e.from}→${e.to}`);
	console.log("\nwatchdog transitions:", results.transitions.join(", ") || "(none)");
} finally {
	stopWatchForTest();
	harness.finish();
}

console.log("\n=== multi-dialog results ===");
console.log(JSON.stringify(results, null, 1));
const pass = results.blockedEpisodes >= 3 && results.dialogsApproved >= 3 && results.markers === 3 && results.settledIdle
	&& results.transitions.filter((t) => t.endsWith("blocked")).length >= 3;
console.log(pass ? "multi-dialog: ALL PASS" : "multi-dialog: FAIL");
process.exit(pass ? 0 : 1);
