// monitor-threads end-to-end test — real child processes, real spool files,
// real registry persistence, and the model-facing tool executed for real.
//
//   1. supervisor: start a real detached thread → running, pid alive, tail works
//   2. wake policy: plain output does NOT wake; ERROR output does; frame is
//      bounded + carries the untrusted preamble and tool orientation
//   3. watermark: drained lines are not re-injected; offsets persist across
//      supervisor reload
//   4. reconcile: a thread whose process dies flips to exited
//   5. stop: SIGTERM kills the process, registry records stopped
//   6. cron: registerCron + pure crontab line build/remove round-trip
//   7. tool: prompt surfaces present; execute list/start/tail/doctor/stop for
//      real against the supervisor
//   8. prompt section: orientation text present
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { Supervisor, drainBuffer, frameMonitorEvent, pidAlive, groupAlive, terminateProcessTree, MAX_WAKE_LINES } from "../lib/supervisor.ts";
import { buildCronLine, removeCronLines, managedCronNames } from "../lib/cron.ts";
import { registerThreadsTool, threadsPromptSection } from "../lib/threads-tool.ts";
import { runDoctor } from "../lib/doctor.ts";
import { computeUsageStats, buildFooterSegments, bandFor, shortModelName, formatWindow } from "../lib/telemetry.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const home = await fs.mkdtemp("/tmp/monitors-e2e-");
const supervisor = new Supervisor({ homeDir: home });
await supervisor.load();
const sleepMs = (ms: number) => sleep(ms);

// --- 1. start a real detached thread ---
const startMsg = await supervisor.start("disk-watch", "echo hello; echo boot done; sleep 30", { cwd: home, notify: "error" });
assert.match(startMsg, /started 'disk-watch' \(pid \d+\)/);
await sleepMs(300); // let the child flush

const rows = supervisor.list();
assert.equal(rows.length, 1);
assert.equal(rows[0].name, "disk-watch");
assert.equal(rows[0].status, "running");
assert.ok(rows[0].pid && pidAlive(rows[0].pid), "pid should be alive");
const tail = await supervisor.tail("disk-watch");
assert.ok(tail.includes("hello") && tail.includes("boot done"), `tail should show output: ${tail}`);

// --- 2. wake policy: plain lines don't wake; errors do ---
const quiet = await supervisor.drain("disk-watch");
assert.equal(quiet.notable, false, "plain output must not wake (notify=error)");
// Notable line appended by an external writer (cron-style direct spool write).
await fs.appendFile(supervisor.spoolPath("disk-watch"), `ERROR disk 95% full\n`);
await sleepMs(50);
const hot = await supervisor.drain("disk-watch");
assert.equal(hot.notable, true, "ERROR line must wake");
assert.ok(hot.lines.some((l) => l.includes("disk 95%")), `lines should include the error: ${JSON.stringify(hot.lines)}`);
const frame = frameMonitorEvent(hot.record!, hot.lines);
assert.ok(frame.includes("BEGIN MONITOR EVENT") && frame.includes("END MONITOR EVENT"), "frame boundaries");
assert.ok(frame.includes("untrusted data"), "untrusted preamble");
assert.ok(frame.includes("monitor_threads tool"), "tool orientation in frame");
assert.ok(frame.includes("thread: disk-watch"), "thread header");

// --- 3. watermark: no re-injection; offsets persist across reload ---
const reDrain = await supervisor.drain("disk-watch");
assert.equal(reDrain.lines.length, 0, "already-drained lines must not re-inject");
const reloaded = new Supervisor({ homeDir: home });
await reloaded.load();
const reDrain2 = await reloaded.drain("disk-watch");
assert.equal(reDrain2.lines.length, 0, "offset must persist across supervisor reload");

// --- drainBuffer edge cases (pure) ---
const capped = drainBuffer(Array.from({ length: MAX_WAKE_LINES + 5 }, (_, i) => `line-${i}`).join("\n") + "\n", 0, "always");
assert.equal(capped.lines.length, MAX_WAKE_LINES + 1, "cap + suppression note");
assert.ok(capped.lines[0].includes("suppressed"));
const partial = drainBuffer("complete line\npartial-without-newline", 0, "always");
assert.equal(partial.lines.length, 1, "partial trailing line must wait");
assert.ok(partial.newOffset <= "complete line\n".length, "offset must not pass the partial line");

// --- 4. reconcile: process dies → exited ---
await supervisor.start("mayfly", "echo bye", { cwd: home });
await sleepMs(400); // echo exits, pid goes away
const reconciled = supervisor.list();
const mayfly = reconciled.find((r) => r.name === "mayfly")!;
assert.equal(mayfly.status, "exited", `dead pid must reconcile to exited: ${mayfly.status}`);

// --- 5. stop: SIGTERM ---
const stopMsg = await supervisor.stop("disk-watch");
assert.match(stopMsg, /stopped 'disk-watch'/);
await sleepMs(200);
assert.equal(pidAlive(rows[0].pid!), false, "SIGTERM must kill the sleep");
assert.equal(supervisor.list().find((r) => r.name === "disk-watch")!.status, "stopped");

// --- 6. cron registry + pure crontab round-trip ---
await supervisor.registerCron("backup", "0 3 * * *", "/usr/local/bin/backup.sh");
const cronLine = buildCronLine("backup", "0 3 * * *", "/usr/local/bin/backup.sh");
assert.ok(cronLine.includes("# pi-monitor: backup"));
const crontab = `SHELL=/bin/bash\n${cronLine}\n# unrelated\n`;
const { kept, removedCount } = removeCronLines(crontab, "backup");
assert.equal(removedCount, 1);
assert.ok(!kept.includes("pi-monitor: backup") && kept.includes("SHELL=") && kept.includes("unrelated"));
assert.deepEqual(managedCronNames(crontab), ["backup"]);
const reloaded2 = new Supervisor({ homeDir: home }); // fresh load sees the cron
await reloaded2.load();
assert.ok(reloaded2.list().find((r) => r.name === "backup")?.schedule === "0 3 * * *");

// --- 7. tool: surfaces + real execution ---
let capturedDef: any = null;
const fakePi = { registerTool: (def: any) => { capturedDef = def; } };
registerThreadsTool(fakePi as any, { supervisor });

assert.equal(capturedDef.name, "monitor_threads");
assert.ok(capturedDef.description.includes("cron"), "tool description advertises crons");
assert.ok(capturedDef.promptSnippet.includes("monitor"), "promptSnippet present");
assert.equal(capturedDef.promptGuidelines.length, 3);
for (const g of capturedDef.promptGuidelines) assert.ok(g.includes("monitor_threads"), `guideline must self-name the tool: ${g}`);

const exec = (params: any) => capturedDef.execute("t1", params, undefined, undefined, { cwd: home });

const listResult = await exec({ action: "list" });
const listText = listResult.content[0].text;
assert.ok(listText.includes("disk-watch") && listText.includes("stopped"), `list shows threads: ${listText}`);
assert.ok(listText.includes("backup") && listText.includes("0 3 * * *"), "list shows cron schedule");

const startResult = await exec({ action: "start", name: "tool-spawned", script: "echo from-the-model; sleep 10", notify: "always" });
assert.match(startResult.content[0].text, /started 'tool-spawned'/);
await sleepMs(200);
const tailResult = await exec({ action: "tail", name: "tool-spawned" });
assert.ok(tailResult.content[0].text.includes("from-the-model"));
const awake = await supervisor.drain("tool-spawned");
assert.equal(awake.notable, true, "notify=always wakes on plain lines");

const doctorResult = await exec({ action: "doctor" });
assert.ok(doctorResult.content[0].text.startsWith("doctor —"), `doctor report: ${doctorResult.content[0].text}`);

const stopResult = await exec({ action: "stop", name: "tool-spawned" });
assert.match(stopResult.content[0].text, /stopped 'tool-spawned'/);
await sleepMs(150);
assert.equal(pidAlive(supervisor.list().find((r) => r.name === "tool-spawned")!.pid!), false);

// doctor with the real probes flags the crashed mayfly
const realDoctor = runDoctor(supervisor.list(), {
	pidAlive: (pid) => pidAlive(pid),
	spoolFileExists: (name) => true,
	crontabHasEntry: () => true,
});
const mayflyFinding = realDoctor.find((f) => f.message.includes("mayfly"));
// mayfly reconciled to exited (not failed) — no crash finding; that's correct:
assert.equal(mayflyFinding, undefined, "reconciled-exited threads are not crash findings");

// --- 8. prompt section ---
const section = threadsPromptSection();
assert.ok(section.includes("## Background threads"));
assert.ok(section.includes("monitor_threads"));
assert.ok(section.includes("untrusted"));

// --- 8.5 footer layout: usage stats, segments, bands ---
const usageEntries = [
	{ type: "message", message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 700, cacheWrite: 200, totalTokens: 1050, cost: { total: 0.01 } } } },
	{ type: "message", message: { role: "assistant", usage: { input: 50, output: 30, cacheRead: 1000, cacheWrite: 0, totalTokens: 1080, cost: { total: 0.02 } } } },
];
const stats = computeUsageStats(usageEntries);
assert.equal(stats.cacheHitPct, Math.round(100 * 1700 / 2050), "cache hit = reads/(reads+writes+input)");
assert.ok(Math.abs(stats.costTotal - 0.03) < 1e-9);
const noCache = computeUsageStats([{ type: "message", message: { role: "assistant", usage: { input: 500, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 520, cost: { total: 0.004 } } } }]);
assert.equal(noCache.cacheHitPct, null, "no cache tokens reported -> hide ratio");
assert.equal(shortModelName("anthropic/claude-sonnet-4-5"), "claude-sonnet-4-5");
assert.equal(shortModelName("pi/minimax"), "minimax");
assert.equal(formatWindow(200000), "200k");
assert.equal(formatWindow(1000000), "1m");
assert.equal(bandFor(90, true), "error");
assert.equal(bandFor(30, true), "success");
assert.equal(bandFor(85, false), "success");
assert.equal(bandFor(30, false), "error");
const segs = buildFooterSegments({
	project: "pi-extensions", branch: "main", modelId: "litellm/glm-5.3-flash", thinking: "high",
	ctxPercent: 57, cacheHitPct: 83, costTotal: 0.31, monitorsRunning: 1, crons: 0,
});
const line = segs.map((s2) => s2.text).join("");
for (const expect of ["pi-extensions", "⎇ main", "glm-5.3-flash \u00b7 high", "ctx 57%", "cache 83%", "$0.31", "⛏ 1 mon · 0 cron", " \u2502 "]) {
	assert.ok(line.includes(expect), `footer line missing "${expect}": ${line}`);
}
assert.ok(!line.includes("5h") && !line.includes("7d"), "no 5h/7d cost windows");
const ctxSeg = segs.find((s2) => s2.text === "ctx 57%");
assert.equal(ctxSeg?.color, "accent", "ctx 57% is warm band");
// With a known context window the ctx segment carries the total: `ctx N%/1m`.
const segsWin = buildFooterSegments({
	project: "pi-extensions", branch: "main", modelId: "litellm/glm-5.3-flash", thinking: "high",
	ctxPercent: 57, contextWindow: 1_000_000, cacheHitPct: 83, costTotal: 0.31, monitorsRunning: 1, crons: 0,
});
const lineWin = segsWin.map((s2) => s2.text).join("");
assert.ok(lineWin.includes("ctx 57%/1m"), `footer line missing "ctx 57%/1m": ${lineWin}`);
assert.equal(segsWin.find((s2) => s2.text === "ctx 57%/1m")?.color, "accent", "ctx total segment keeps warm band");
// 1MiB-style windows still render compactly (1048576 -> "1049k").
assert.equal(formatWindow(1_048_576), "1049k");
const cacheSeg = segs.find((s2) => s2.text === "cache 83%");
assert.equal(cacheSeg?.color, "success", "cache 83% is good band");
console.log("[ok] footer layout: project/branch/model+think/ctx/cache/$/monitors, color bands, no 5h/7d");

// --- 9. process-group stop: piped threads die entirely (regression: tail|grep orphans) ---
const groupMembers = (pgid: number): number[] => {
	try {
		return execFileSync("pgrep", ["-g", String(pgid)], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number);
	} catch { return []; }
};
await supervisor.start("piped", "echo piped-ready; sleep 30 | grep hello", { cwd: home });
await sleepMs(250);
const pipeRow = supervisor.list().find((r) => r.name === "piped")!;
assert.ok(pipeRow.pid, "piped thread must have a pid");
const membersBefore = groupMembers(pipeRow.pid!);
assert.ok(membersBefore.length >= 3, `pipeline needs ≥3 group members (bash + sleep + grep), got ${membersBefore.length}`);
await supervisor.stop("piped");
await sleepMs(150);
assert.equal(pidAlive(pipeRow.pid!), false, "wrapper must be dead after stop");
const membersAfter = groupMembers(pipeRow.pid!);
assert.equal(membersAfter.length, 0, `ALL group members must be dead after stop, left: ${membersAfter}`);
console.log(`[ok] group stop: ${membersBefore.length} members SIGTERMed, 0 remain`);

// --- 10. orphan reconcile: wrapper killed manually → group reaped on next list() ---
await supervisor.start("orphan", "sleep 30 | grep orphans", { cwd: home });
await sleepMs(250);
const orphanRow = supervisor.list().find((r) => r.name === "orphan")!;
assert.ok(orphanRow.pid);
assert.ok(groupAlive(orphanRow.pid!), "orphan group should be alive before wrapper kill");
process.kill(orphanRow.pid!, "SIGKILL"); // recreate the old bug's leftover state: wrapper dead, children alive
await sleepMs(120);
assert.ok(groupAlive(orphanRow.pid!), "children must still be alive right after wrapper SIGKILL");
const afterOrphan = supervisor.list().find((r) => r.name === "orphan")!;
assert.equal(afterOrphan.status, "exited", "dead wrapper reconciles to exited");
await sleepMs(1_600); // give the fire-and-forget reaper its grace period
const membersLeft = groupMembers(orphanRow.pid!);
assert.equal(membersLeft.length, 0, `orphaned group must be reaped by reconcile, left: ${membersLeft}`);
console.log("[ok] orphan reconcile: dead wrapper → exited + group reaped in background");

// cleanup: make sure no stray processes survive the test
for (const r of supervisor.list()) if (r.status === "running" && r.pid) await terminateProcessTree(r.pid);
await fs.rm(home, { recursive: true, force: true });
console.log("E2E PASSED: threads start/run/wake/stop through supervisor, spool, and tool");
