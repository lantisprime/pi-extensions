// herdr-control: classifier + watchdog tests (lib/classify.ts, lib/watchdog.ts).
// Grounding: herdr cannot reliably classify pi panes — the classifier fuses
// herdr's agent_status with pattern analysis of the detection buffer.
import assert from "node:assert/strict";
import { createFakeHerdr, okResult, errResult, okEnvelope } from "./fake-herdr.ts";
import { classifyDetectionText, fuseStatuses } from "../lib/classify.ts";
import { Watchdog, frameWatchEvent } from "../lib/watchdog.ts";

// detection patterns: pi idle prompt / blocked dialog / working / junk
{
	const idle = "some earlier answer text\nmore text\npi-herdr-x ❯";
	const v = classifyDetectionText(idle);
	assert.equal(v.status, "idle", JSON.stringify(v));
	assert.ok(v.evidence[0].includes("prompt marker"));
}
{
	// The REAL pi bash-permission dialog, live-captured from a herdr pane.
	const realDialog = [
		"─".repeat(40),
		" Permission required: Run bash commands",
		" Project:",
		" /Users/x/pi-extensions/herdr-control",
		" Command: touch /tmp/marker && ls -la /tmp/marker",
		" How should Pi handle this permission?",
		"",
		" → Allow once",
		"   Allow for current session",
		"   Deny once",
		"   Deny permanently for this project",
		"",
		" ↑↓ navigate  enter select  escape/ctrl+c cancel",
		"─".repeat(40),
	].join("\n");
	const v = classifyDetectionText(realDialog);
	assert.equal(v.status, "blocked", JSON.stringify(v.evidence));
	assert.equal(v.confidence, "high");
	assert.ok(v.evidence.some((e) => e.includes("pi permission dialog")));
}
{
	const blocked = "previous turn output\nAllow tool call? bash\n❯ [y/n]";
	const v = classifyDetectionText(blocked);
	assert.equal(v.status, "blocked");
	assert.ok(v.evidence.some((e) => e.includes("allow-dialog") || e.includes("y/n menu")));
}
{
	const blockedTrust = "...\nDo you trust the project /tmp/x? (yes/no)";
	const v = classifyDetectionText(blockedTrust);
	assert.equal(v.status, "blocked");
	assert.ok(v.evidence.some((e) => e.includes("trust")));
}
{
	const working = "analyzing the diff\n⠋ thinking…\nesc to interrupt";
	const v = classifyDetectionText(working);
	assert.equal(v.status, "working");
	assert.ok(v.evidence.length >= 1);
}
{
	const junk = "async function main() {\n  return 42;\n}";
	const v = classifyDetectionText(junk);
	assert.equal(v.status, "unknown");
	assert.equal(v.confidence, "low");
}

// fusion: dialog beats herdr; herdr authoritative on agree; contradiction surfaced
{
	const dialog = classifyDetectionText("Allow tool call? ❯ [y/n]");
	const fused = fuseStatuses("idle", dialog);
	assert.equal(fused.status, "blocked", "herdr idle + dialog → blocked");
	assert.equal(fused.confidence, "high");
	assert.equal(fused.source, "fused");
}
{
	// review BLOCKER regression: herdr-confirmed blocked is never downgraded
	const fused = fuseStatuses("blocked", classifyDetectionText("no markers here"));
	assert.equal(fused.status, "blocked");
	assert.equal(fused.confidence, "high");
	assert.equal(fused.source, "herdr");
}
{
	// review false-positive regressions: prose and bare `>` are not signals
	assert.equal(classifyDetectionText("The build is running. See docs >").status, "unknown", "prose/`>` must not read as working/idle");
	assert.equal(classifyDetectionText("done ❯").status, "idle", "❯ still means idle");
}
{
	const fused = fuseStatuses("unknown", classifyDetectionText("⠋ working…"));
	assert.equal(fused.status, "working");
	assert.equal(fused.source, "pattern");
}
{
	const fused = fuseStatuses("working", classifyDetectionText("ready ❯"));
	assert.equal(fused.status, "idle", "herdr working + parked prompt → idle");
	assert.ok(fused.evidence.some((e) => e.includes("contradiction")));
}
{
	const fused = fuseStatuses("done", classifyDetectionText("All checks passed.\n❯"));
	assert.equal(fused.status, "idle", "detection's concrete state names it; herdr done corroborates");
	assert.equal(fused.confidence, "high", "settled-family agreement is high confidence");
	assert.ok(!fused.evidence.some((e) => e.includes("contradiction")));
}
{
	const fused = fuseStatuses(null, classifyDetectionText("no markers here"));
	assert.equal(fused.status, "unknown");
	assert.equal(fused.source, "pattern");
}

// screen_detection_skipped panes (path-sourced pi): herdr's integration-
// tracked lifecycle is valid; only its dialog blindness is the problem.
{
	const idleBuf = classifyDetectionText("finished ❯");
	const skipped = fuseStatuses("idle", idleBuf, { herdrScreenSkipped: true });
	assert.equal(skipped.status, "idle");
	assert.equal(skipped.confidence, "high", "skipped rows trust integration lifecycle");
	// a dialog seen in the buffer STILL wins for skipped panes
	const dialog = classifyDetectionText("Permission required: Run bash commands\n→ Allow once");
	assert.equal(fuseStatuses("working", dialog, { herdrScreenSkipped: true }).status, "blocked");
	// detection failed + skipped → herdr lifecycle still usable
	const fusedFail = fuseStatuses("idle", { status: "unknown", confidence: "low", evidence: ["detection read failed"] }, { detectionFailed: true, herdrScreenSkipped: true });
	assert.equal(fusedFail.status, "idle", "failed read on skipped pane falls back to herdr lifecycle");
	assert.equal(fusedFail.confidence, "medium");
}

// mechanical lifecycle: registry lease/touch + reapable selection
{
	const { SpawnRegistry, makeSpawnEvent } = await import("../lib/registry.ts");
	const reg = new SpawnRegistry();
	reg.spawn(makeSpawnEvent({ name: "pi-herdr-a", paneId: "w1:pA", kind: "pi", cwd: "/x", lastActivityAt: Date.now() - 999_999 }).record);
	reg.spawn(makeSpawnEvent({ name: "pi-herdr-b", paneId: "w1:pB", kind: "pi", cwd: "/x", keep: true, lastActivityAt: Date.now() - 999_999 }).record);
	assert.deepEqual(reg.reapable(Date.now(), 600_000).map((r) => r.name), ["pi-herdr-a"], "keep excluded, expired lease selected");
	reg.touch("pi-herdr-a");
	assert.equal(reg.reapable(Date.now(), 600_000).length, 0, "touch renews the lease");
}

// watchdog reaper: settled + expired lease → closed; working → never
{
	const fake = createFakeHerdr();
	fake.onSubcommand("agent", (args) => {
		if (args[1] === "list") return okResult(okEnvelope({ agents: [{ agent: "pi-herdr-old", agent_status: "done", pane_id: "w1:pOld" }, { agent: "pi-herdr-work", agent_status: "working", pane_id: "w1:pW" }] }));
		if (args[1] === "get") return okResult(okEnvelope({ agent: { agent: args[2], agent_status: args[2] === "pi-herdr-work" ? "working" : "done" } }));
		if (args[1] === "read") return okResult(args[2] === "w1:pW" || args[2] === "pi-herdr-work" ? "⠋ busy" : "finished ❯");
		return errResult("unexpected", 1);
	});
	const closed = [];
	const reg = new (await import("../lib/registry.ts")).SpawnRegistry();
	reg.spawn({ name: "pi-herdr-old", paneId: "w1:pOld", kind: "pi", cwd: "/x", createdAt: Date.now() - 999_999, lastActivityAt: Date.now() - 999_999 });
	reg.spawn({ name: "pi-herdr-work", paneId: "w1:pW", kind: "pi", cwd: "/x", createdAt: Date.now() - 999_999, lastActivityAt: Date.now() - 999_999 });
	const dog = new Watchdog(fake.executor, { list: () => reg.list() }, () => {}, {
		reapIdleMs: 600_000,
		closePane: async (paneId) => { closed.push(paneId); return true; },
	});
	await dog.watchOnce();
	assert.deepEqual(closed, ["w1:pOld"], "settled expired pane reaped; working pane untouched");
	assert.ok(reg.get("pi-herdr-work"), "working pane survives");
	assert.ok(reg.get("pi-herdr-old"), "registry mutation is the caller's job (extension wrapper persists the close event) — the spy shim does not");
}

// classifyAgent: agent get fails (herdr name scoping) → list row fallback +
// pane-id detection read
{
	const fake = createFakeHerdr();
	fake.onSubcommand("agent", (args) => {
		if (args[1] === "get") return errResult(JSON.stringify({ error: { code: "agent_not_found", message: "agent target pi-herdr-x not found" } }), 1);
		if (args[1] === "list") return okResult(okEnvelope({ agents: [{ agent: "pi-herdr-x", agent_status: "working", pane_id: "w9:p8" }] }));
		if (args[1] === "read") {
			if (args[2] === "pi-herdr-x") return errResult("agent target pi-herdr-x not found", 1);
			if (args[2] === "w9:p8") return okResult("⠋ busy");
		}
		return errResult("unexpected", 1);
	});
	const { classifyAgent } = await import("../lib/classify.ts");
	const r = await classifyAgent(fake.executor, "pi-herdr-x");
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.equal(r.classification.status, "working", JSON.stringify(r.classification));
		assert.equal(r.classification.confidence, "high");
	}
}

// watchdog: pi-shaped rows (name key, no agent key) must not be skipped
{
	const fake = createFakeHerdr();
	fake.onSubcommand("agent", (args) => {
		if (args[1] === "list") return okResult(okEnvelope({ agents: [{ name: "pi-herdr-pirow", agent_status: "working", pane_id: "w9:pK", screen_detection_skipped: true }] }));
		if (args[1] === "get") return errResult(JSON.stringify({ error: { code: "agent_not_found", message: "agent target pi-herdr-pirow not found" } }), 1);
		if (args[1] === "read") return okResult("Permission required: Run bash commands\n→ Allow once\n  Deny once");
		return errResult("unexpected", 1);
	});
	const dogEvents = [];
	const dog2 = new Watchdog(fake.executor, { list: () => [{ name: "pi-herdr-pirow", paneId: "w9:pK", kind: "pi" }] }, (e) => dogEvents.push(e));
	const evs = await dog2.watchOnce();
	assert.ok(evs.some((e) => e.key === "pi-herdr-pirow" && e.to === "blocked"), `first-sighting blocked must fire for pi rows (${JSON.stringify(evs)})`);
	assert.ok(evs.every((e) => e.severity === "warning"));
}

// watchdog: transitions across ticks with a scripted executor + fake registry
{
	let detectionText = "⠋ working…";
	let herdrStatus = "working";
	let liveAgents = [{ agent: "pi-herdr-w", agent_status: "working", pane_id: "w9:p9" }];
	const fake = createFakeHerdr();
	fake.onSubcommand("agent", (args) => {
		if (args[1] === "list") return okResult(okEnvelope({ agents: liveAgents }));
		if (args[1] === "get") return okResult(okEnvelope({ agent: { agent: "pi-herdr-w", agent_status: herdrStatus, pane_id: "w9:p9" } }));
		if (args[1] === "read") return okResult(detectionText);
		return errResult("unexpected", 1);
	});
	const registryFake = { list: () => [{ name: "pi-herdr-w", paneId: "w9:p9", kind: "pi" }] };
	const notified = [];
	const dog = new Watchdog(fake.executor, registryFake, (event) => notified.push(event));

	// tick 1: first sighting, working — not surfaced
	let events = await dog.watchOnce();
	assert.equal(events.length, 0, "first sighting while working is not an event");
	assert.equal(dog.status().watched, 1);

	// tick 2: dialog appears — herdr still says working → warning blocked event
	detectionText = "Allow tool call? ❯ [y/n]";
	events = await dog.watchOnce();
	assert.equal(events.length, 1);
	assert.equal(events[0].to, "blocked");
	assert.equal(events[0].severity, "warning");
	assert.equal(notified.length, 1);
	assert.match(frameWatchEvent(events[0]), /BLOCKED/);
	assert.match(frameWatchEvent(events[0]), /herdr_send_keys/);

	// tick 3: task finishes (herdr done + idle prompt) → info event. The
	// detection buffer names the state (idle); herdr's done corroborates.
	detectionText = "All checks passed.\n❯";
	herdrStatus = "done";
	liveAgents = [{ agent: "pi-herdr-w", agent_status: "done", pane_id: "w9:p9" }];
	events = await dog.watchOnce();
	assert.equal(events.length, 1);
	assert.equal(events[0].from, "blocked");
	assert.equal(events[0].to, "idle");
	assert.equal(events[0].severity, "info");
	assert.match(frameWatchEvent(events[0]), /herdr_close/);

	// tick 4: agent vanished → gone event
	liveAgents = [];
	events = await dog.watchOnce();
	assert.equal(events.length, 1);
	assert.equal(events[0].to, "gone");
	assert.equal(dog.status().watched, 0);
	assert.equal(dog.status().recentEvents.length, 3);
}

console.log("test-watch-classify: all tests passed");
