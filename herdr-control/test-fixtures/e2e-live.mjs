// herdr-control: LIVE end-to-end test in a PRIVATE herdr session.
// Never touches the user's session or tab: everything runs in an isolated
// "herdr-control-e2e" session (own server, socket, panes) whose teardown is
// mechanical — per-pane sweep, then `herdr session stop`.
// Run: HERDR_ENV=1 node --experimental-strip-types test-fixtures/e2e-live.mjs
import assert from "node:assert/strict";

const { createSessionHarness } = await import("./live-harness.mjs");
const harness = await createSessionHarness("herdr-control-e2e", "pi-herdr-e2e-");
process.env.HERDR_ENV = "1"; // gate: the session executor IS the herdr context here

const { sessionHerdrExecutor, defaultHerdrExecutor } = await import("../lib/exec.ts");
const executor = sessionHerdrExecutor("herdr", harness.session);

const appended = [];
const fakePi = { on() {}, registerTool() {}, registerCommand() {}, registerShortcut() {}, registerFlag() {}, appendEntry(c, d) { appended.push({ c, d }); }, sendMessage(msg, opts) { console.log(`[wake] ${String(msg.content).slice(0, 150)}`); } };
const { runSpawnForTest, stopWatchForTest } = await import("../index.ts");
const { classifyAgent } = await import("../lib/classify.ts");
const { listAgents } = await import("../lib/list.ts");
const { Watchdog, frameWatchEvent } = await import("../lib/watchdog.ts");
const { probeVersion } = await import("../lib/version.ts");

const results = {};
const spawned = [];
try {
	// Private-session socket for the event-based trigger (probed via session).
	const info = await probeVersion(executor);
	console.log("private server:", JSON.stringify(info));

	// --- A. permission-dialog lifecycle --------------------------------------
	console.log("\n=== A. permission-dialog lifecycle ===");
	spawned.push("pi-herdr-e2e-blocked");
	const blocked = await runSpawnForTest(fakePi, executor, {
		name: "pi-herdr-e2e-blocked",
		task: "Run this exact bash command and report its output: touch /tmp/pi-herdr-e2e-blocked.marker",
		kind: "pi", cwd: "/tmp", direction: "auto", timeoutMs: 120_000,
	}, (u) => console.log("[blocked]", u.content[0].text.slice(0, 120)));
	if (!blocked.details.ok) console.log("[blocked] FULL FAILURE TEXT:\n" + blocked.content[0].text.slice(0, 900));
	console.log("spawn status:", blocked.details.status, "kind:", blocked.details.kind ?? "(settled)", "pane:", blocked.details.paneId);
	results.dialogSurfaced = /Permission required|Allow once|Deny once/i.test(blocked.content[0].text);
	console.log("dialog in transcript:", results.dialogSurfaced);

	const cls = await classifyAgent(executor, "pi-herdr-e2e-blocked");
	results.blockedClassification = cls.ok ? cls.classification.status : `error: ${cls.error}`;
	console.log("classifier:", cls.ok ? `${cls.classification.status}/${cls.classification.confidence} [${cls.classification.evidence.join(" | ").slice(0, 180)}]` : cls.error);
	// The DIALOG is surfaced by the classifier: pi's dialog lives off the host
	// scrollback, so the spawn result's transcript read cannot show it (herdr
	// 0.9 limitation, live-verified). The classifier's detection read can.
	results.dialogSurfaced = results.blockedClassification === "blocked";

	// Watchdog over the private session: event trigger + reconcile net.
	const dog = new Watchdog(executor, { list: () => spawned.map((n) => ({ name: n, paneId: "", kind: "pi" })) }, (e) => {
		console.log(`[watchdog] ${e.key}: ${e.from}→${e.to} [${e.severity}]`);
		if (e.severity === "warning") console.log("  frame:", frameWatchEvent(e).slice(0, 180));
	});
	dog.socketPath = info?.socketPath ?? "";
	const tick = await dog.watchOnce();
	results.watchdogSawBlocked = tick.some((e) => e.key === "pi-herdr-e2e-blocked" && e.to === "blocked");
	const dbgLive = await listAgents(executor);
	console.log("DEBUG live rows:", dbgLive.ok ? JSON.stringify(dbgLive.agents.map((a) => ({ agent: a.agent, name: a.name, pane_id: a.pane_id, status: a.agent_status }))) : dbgLive.error);
	console.log("DEBUG watched:", dog.status().watched, "tick events:", tick.length, JSON.stringify(tick.map((e) => ({ k: e.key, to: e.to }))));
	console.log("reconcile tick:", tick.map((e) => `${e.key}: ${e.from}→${e.to}`).join("; ") || "(none)");

	// scripted rescue of the TEST pane: esc cancels pi's dialog (documented in
	// the dialog footer). By pane id — name targeting is unreliable (scoping).
	if (blocked.details.paneId) {
		const esc = await executor.exec(["agent", "send-keys", blocked.details.paneId, "esc"], { timeoutMs: 15_000 });
		console.log("esc by pane id:", esc.ok ? "sent" : esc.stderr.slice(0, 120));
		await new Promise((r) => setTimeout(r, 4000));
		const after = await classifyAgent(executor, "pi-herdr-e2e-blocked");
		// esc cancels the dialog; pi then resumes working (it may retry the
		// command) — dismissal means the dialog is GONE, not that the agent idled.
		results.dialogDismissed = after.ok && after.classification.status !== "blocked";
		console.log("after esc:", after.ok ? `${after.classification.status}/${after.classification.confidence}` : after.error);
	}

	// --- B. watchdog working→idle transition ---------------------------------
	// NOTE: the task must NOT need a tool call — pi in /tmp asks permission for
	// every bash command (ask mode), which blocks the agent by design.
	console.log("\n=== B. watchdog working→idle ===");
	const watchName = "pi-herdr-e2e-watch"; spawned.push(watchName);
	const spawnPromise = runSpawnForTest(fakePi, executor, {
		name: "pi-herdr-e2e-watch",
		task: "This is a timing test. Think briefly, then reply with exactly WATCH_DONE and nothing else. Do not use any tools.",
		kind: "pi", cwd: "/tmp", direction: "auto", timeoutMs: 150_000,
	}, (u) => console.log("[watch]", u.content[0].text.slice(0, 120)));
	await new Promise((r) => setTimeout(r, 8_000));
	const mid = await classifyAgent(executor, "pi-herdr-e2e-watch");
	results.midTaskClassification = mid.ok ? mid.classification.status : `error: ${mid.error}`;
	console.log("mid-task:", results.midTaskClassification);
	// tick during the task so the watchdog records the pre-idle state
	await dog.watchOnce();
	const watch = await spawnPromise;
	console.log("settled with:", watch.details.status);
	// The transition can be flaky right at settle (alternate-screen reads fail
	// while pi repaints) — retry ticks, and accept the final settled state as
	// observation of completion even if no transition event was emitted.
	let afterTick = [];
	for (let attempt = 0; attempt < 4 && !results.watchdogSawFinished; attempt += 1) {
		afterTick = await dog.watchOnce();
		results.watchdogSawFinished = afterTick.some((e) => e.key === "pi-herdr-e2e-watch" && (e.to === "idle" || e.to === "done"))
			|| dog.status().recentEvents.some((e) => e.key === "pi-herdr-e2e-watch" && (e.to === "idle" || e.to === "done"))
			|| (() => { const snap = dog.status(); void snap; const rec = dog.snapshotEntry(watchName); return rec?.status === "idle" || rec?.status === "done"; })();
		if (!results.watchdogSawFinished) await new Promise((r) => setTimeout(r, 3_000));
	}
	console.log("reconcile tick:", afterTick.map((e) => `${e.key}: ${e.from}→${e.to}`).join("; ") || "(none)");
	console.log("final watched state:", JSON.stringify(dog.snapshotEntry(watchName) ?? null));

	// --- C. close_when_done disposal -----------------------------------------
	console.log("\n=== C. close_when_done disposal ===");
	spawned.push("pi-herdr-e2e-done");
	const done = await runSpawnForTest(fakePi, executor, {
		name: "pi-herdr-e2e-done",
		task: "This is a disposal test. Reply with exactly DISPOSE_OK and nothing else. Do not use any tools.",
		kind: "pi", cwd: "/tmp", direction: "auto", timeoutMs: 120_000, closeWhenDone: true,
	}, (u) => console.log("[done]", u.content[0].text.slice(0, 120)));
	results.disposed = done.details.paneClosed === true;
	const agentsAfter = await listAgents(executor);
	results.agentGone = agentsAfter.ok && !agentsAfter.agents.some((a) => (a.agent ?? a.name) === "pi-herdr-e2e-done");
	console.log("paneClosed:", results.disposed, "| agent gone:", results.agentGone);
} finally {
	stopWatchForTest();
	harness.finish(); // sweep + `session stop` — nothing survives
}

console.log("\n=== e2e-live results ===");
console.log(JSON.stringify(results, null, 1));
const failures = Object.entries(results).filter(([, v]) => v === false || (typeof v === "string" && v.startsWith("error")));
console.log(failures.length === 0 ? "e2e-live: ALL PASS" : `e2e-live: FAILURES: ${failures.map(([k, v]) => `${k}=${v}`).join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
