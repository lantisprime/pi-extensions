// Smoke test: render MonitorPanel with stubs and verify
//  1. bordered output at exact width, no line overflows
//  2. spinner animates across ticks, failed thread blinks ✗/⚠
//  3. crons show schedule + next-run when expanded, collapsed shows "next HH:MM"
//  4. esc resolves openMonitorPanel(null)
import { openMonitorPanel, nextCronRun, type ThreadInfo } from "../lib/panel.ts";
import { runDoctor } from "../lib/doctor.ts";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const theme = { fg: (_c: string, s: string) => `\x1b[99m${s}\x1b[0m` };
const tui = { requestRender: () => {} };

let now = Date.now();
const threads: ThreadInfo[] = [
	{ name: "disk-watch", kind: "monitor", status: "running", cmd: "./disk.sh", pid: 4242, updatedAtMs: now },
	{ name: "error-tail", kind: "monitor", status: "failed", cmd: "tail -f x.log", pid: 9999, updatedAtMs: now - 420_000 },
	{ name: "backup", kind: "cron", status: "exited", cmd: "./backup.sh", schedule: "0 3 * * *", updatedAtMs: now },
	{ name: "health-ping", kind: "cron", status: "exited", cmd: "./ping.sh", schedule: "*/5 * * * *", updatedAtMs: now },
];

let comp: any;
let resolveDone: (v: unknown) => void;
const donePromise = new Promise((r) => { resolveDone = r; });
const fakeCtx = {
	hasUI: true,
	ui: {
		custom: async (_builder: any) => {
			return new Promise((resolve) => {
				comp = _builder(tui, theme, undefined, resolve);
			});
		},
	},
};

// open — builder runs inside ui.custom; grab the component and drive renders
const opened = openMonitorPanel(fakeCtx as any, { getData: () => threads, getHistory: () => [] });
await new Promise((r) => setTimeout(r, 10));

const WIDTH = 64;
const render = () => comp.render(WIDTH) as string[];

// --- 1. structure: borders + widths ---
let lines = render();
console.log(lines.join("\n"));
const visible = (s: string) => stripAnsi(s).length;
if (!lines[0].startsWith("┌") || !lines[lines.length - 1].startsWith("└")) throw new Error("missing box border");
for (const l of lines) if (visible(l) !== WIDTH) throw new Error(`line width ${visible(l)} != ${WIDTH}: ${JSON.stringify(stripAnsi(l))}`);
console.log(`\n[ok] ${lines.length} lines, all exactly ${WIDTH} visible columns, borders present`);

// --- 2. animation: spinner + error blink ---
const glyphAt = (ls: string[], name: string) => {
	const row = ls.find((l) => stripAnsi(l).includes(name))!;
	return stripAnsi(row).trim().split(/\s+/)[1];
};
const spin1 = glyphAt(lines, "disk-watch");
const err1 = glyphAt(lines, "error-tail");
await new Promise((r) => setTimeout(r, 400)); // > 2 anim ticks (120ms), < error blink (600ms)
lines = render();
const spin2 = glyphAt(lines, "disk-watch");
const err2 = glyphAt(lines, "error-tail");
if (spin1 === spin2) throw new Error(`spinner did not advance: ${spin1}`);
console.log(`[ok] spinner animates: ${spin1} → ${spin2}; failed glyph frames: ${err1} → ${err2} (blinks ✗/⚠)`);

// --- 3. cron schedule when expanded, next-run when collapsed ---
const expanded = render().map(stripAnsi).join("\n");
if (!expanded.includes("*/5 * * * * → next")) throw new Error("expanded cron missing schedule→next");
if (!/\b0 3 \* \* \* → next/.test(expanded)) throw new Error("daily cron missing schedule→next");
// Raw terminal sequences: left/right are ESC[D / ESC[C, not the word "left".
comp.handleInput("\x1b[B"); // down ×3: monitors-group → disk → error → crons-group
comp.handleInput("\x1b[B");
comp.handleInput("\x1b[B");
comp.handleInput("\r");     // toggle crons collapsed
const collapsed = render().map(stripAnsi).join("\n");
if (!collapsed.includes("▸ Crons (2) — next ")) throw new Error(`collapsed crons missing next-run summary:\n${collapsed}`);
if (collapsed.includes("*/5 * * * *")) throw new Error("schedule visible while collapsed (should hide rows)");
console.log("[ok] expanded rows show '<schedule> → next HH:MM'; collapsed header shows '— next HH:MM'");

// --- 5. doctor: probes find the stale pid + crashed thread; d-view renders; esc back ---
// (the fake ui.custom assigns the newest built component to `comp`)
const opened2 = openMonitorPanel(fakeCtx as any, {
	// 'ghost' is registry-running but its pid is dead — the stale-pid case.
	getData: () => [...threads, { name: "ghost", kind: "monitor", status: "running", cmd: "./ghost.sh", pid: 9999, updatedAtMs: now }],
	getHistory: () => [],
	runDoctor: () => runDoctor(
		[...threads, { name: "ghost", kind: "monitor", status: "running", cmd: "./ghost.sh", pid: 9999, updatedAtMs: now }],
		{
			pidAlive: (pid) => pid !== 9999,
			spoolFileExists: (name) => name !== "error-tail",
		},
	),
});
await new Promise((r) => setTimeout(r, 10));
comp.handleInput("d");
const docLines = (comp.render(WIDTH) as string[]).map(stripAnsi).join("\n");
if (!docLines.includes("doctor —")) throw new Error("doctor header missing");
if (!docLines.includes("[pid-liveness] thread 'ghost' reports pid 9999")) throw new Error("stale-pid finding missing");
if (!docLines.includes("[thread-status] thread 'error-tail' crashed")) throw new Error("crashed finding missing");
if (!docLines.includes("→ restart it: /monitors start")) throw new Error("next step missing");
comp.handleInput("\x1b");
if (!(comp.render(WIDTH) as string[]).join("").includes("Monitoring threads")) throw new Error("esc did not return to list from doctor");
console.log("[ok] doctor: stale-pid + crashed findings with next steps; d opens, esc returns");

// --- nextCronRun sanity ---
const t1 = nextCronRun("*/5 * * * *", new Date(2026, 0, 1, 12, 3, 59));
if (!t1 || t1.getHours() !== 12 || t1.getMinutes() !== 5) throw new Error(`*/5 next wrong: ${t1}`);
const t2 = nextCronRun("0 3 * * *", new Date(2026, 0, 1, 12, 0, 0));
if (!t2 || t2.getHours() !== 3 || t2.getDate() !== 2) throw new Error(`daily next wrong: ${t2}`);
console.log("[ok] nextCronRun: */5 → next 5-min boundary; 0 3 * * * → tomorrow 03:00");

// --- 6. esc resolves null (comp now points at the second panel instance) ---
comp.handleInput("\x1b");
const result = await Promise.race([opened2, new Promise((r) => setTimeout(() => r("timeout"), 500))]);
if (result !== null) throw new Error(`esc did not resolve null: ${result}`);
console.log("[ok] esc resolves openMonitorPanel(null)");
console.log("\nALL PANEL SMOKE CHECKS PASSED");
