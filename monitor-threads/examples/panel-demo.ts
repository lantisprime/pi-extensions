// monitor-threads/examples/panel-demo.ts — try the expandable panel + 8-line tail.
//
// Run:   pi --extension ./monitor-threads/examples/panel-demo.ts
// Then:  /monitor-panel
//
// The demo fakes two monitoring threads and two crons (one "crashed") with a
// live log, so the panel's grouping, expand/collapse, history view, and the
// pinned 8-line tail widget can be exercised without any real scripts.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openMonitorPanel, type ThreadInfo } from "../lib/panel.ts";
import { runDoctor, formatDoctorReport, type DoctorEnv } from "../lib/doctor.ts";

// --- Fake thread state (replace with the real supervisor's registry) ---

const startedAt = Date.now();

const threads: ThreadInfo[] = [
	{ name: "disk-watch", kind: "monitor", status: "running", cmd: "./scripts/disk-watch.sh", pid: 4242, updatedAtMs: startedAt },
	{ name: "error-tail", kind: "monitor", status: "failed", cmd: "tail -f /var/log/app.log", pid: 9999, updatedAtMs: Date.now() - 7 * 60_000 },
	{ name: "backup", kind: "cron", status: "exited", cmd: "./scripts/backup.sh", schedule: "0 3 * * *", updatedAtMs: Date.now() - 11 * 3600_000 },
	{ name: "health-ping", kind: "cron", status: "exited", cmd: "./scripts/ping.sh", schedule: "*/5 * * * *", updatedAtMs: Date.now() - 3 * 60_000 },
];

const history = new Map<string, string[]>([
	["disk-watch", [
		"[12:00:01] scan started (/)",
		"[12:00:02] /: 61% used (412G free)",
		"[12:05:02] /: 61% used (412G free)",
		"[12:10:03] /: 62% used (409G free)",
		"[12:15:03] /: 62% used (409G free)",
		"[12:20:04] /: 63% used (405G free)",
		"[12:25:04] WARN: growth +1% in 10m",
		"[12:30:05] /: 63% used (405G free)",
	]],
	["error-tail", [
		"[11:58:10] tail: cannot open '/var/log/app.log': No such file or directory",
		"[11:58:10] exit 1 — restart policy: none (3 failures)",
	]],
	["backup", [
		"[03:00:01] backup started → /Volumes/nas",
		"[03:41:22] 1,204 files, 8.1G",
		"[03:41:22] backup OK",
	]],
	["health-ping", [
		"[12:25:00] ping https://internal.local/health → 200 (38ms)",
		"[12:30:00] ping https://internal.local/health → 200 (41ms)",
		"[12:35:00] ping https://internal.local/health → 200 (36ms)",
	]],
]);

export default function (pi: ExtensionAPI) {
	let pinned: string | null = null;
	let scrollback = 0; // lines back from the end (0 = follow)
	let lastUi: { ui: ExtensionAPI["ui"]; hasUI: boolean } | null = null;

	// --- 8-line tail widget (above editor). ctx.ui.setWidget — pi has no setWidget. ---
	function renderTail(): void {
		if (!lastUi?.hasUI) return;
		if (!pinned) { lastUi.ui.setWidget("monitor-tail", undefined); return; }
		const all = history.get(pinned) ?? [];
		const end = all.length - scrollback;
		const start = Math.max(0, end - 8);
		const window = all.slice(start, end);
		const header = `⛏ ${pinned}  (${scrollback > 0 ? `${scrollback}↑` : "live"})`;
		lastUi.ui.setWidget("monitor-tail", [
			header,
			...window.map((l) => `  ${l}`),
		], { placement: "aboveEditor" });
	}

	// Remember the freshest ctx so timers/shortcuts can re-render after the
	// originating command returned (same re-attach pattern the agents extension uses).
	function track(ctx: { hasUI?: boolean; ui: ExtensionAPI["ui"] }): void {
		lastUi = { ui: ctx.ui, hasUI: ctx.hasUI ?? false };
	}

	pi.registerCommand("monitor-panel", {
		description: "Show monitoring threads and crons (expandable panel)",
		handler: async (_args, ctx) => {
			track(ctx);
			const picked = await openMonitorPanel(ctx, {
				getData: () => threads,
				getHistory: (name) => history.get(name) ?? [],
				runDoctor: doctor,
			});
			if (!picked) {
				ctx.ui.notify("Panel closed — nothing pinned.", "info");
				renderTail();
				return;
			}
			pinned = picked.name;
			scrollback = 0;
			renderTail();
			ctx.ui.notify(`Pinned '${picked.name}' to the tail widget (ctrl+↑/ctrl+↓ to scroll).`, "info");
		},
	});

	// Fake environment probes for the doctor. The real impl reads /proc, the
	// spool dir, and crontab — stubbed here to demonstrate the findings.
	const doctorEnv: DoctorEnv = {
		pidAlive: (pid) => pid !== 9999, // pretend error-tail's pid is stale
		spoolFileExists: (name) => name !== "error-tail",
		spoolBytes: (name) => (name === "disk-watch" ? 512 * 1024 : undefined),
		crontabHasEntry: () => true,
	};
	const doctor = () => runDoctor(threads, doctorEnv);

	// Standalone doctor command (same findings the panel's `d` view shows).
	pi.registerCommand("monitor-doctor", {
		description: "Troubleshoot monitoring threads and crons",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatDoctorReport(doctor()).join("\n"), "info");
		},
	});

	// Scroll the 8-line tail when unmodified arrows are owned by the editor.
	pi.registerShortcut("ctrl+up", {
		description: "Scroll monitor tail up",
		handler: async (ctx) => { track(ctx); scrollback += 1; renderTail(); },
	});
	pi.registerShortcut("ctrl+down", {
		description: "Scroll monitor tail down",
		handler: async (ctx) => { track(ctx); scrollback = Math.max(0, scrollback - 1); renderTail(); },
	});

	// Simulate a live thread: append a disk-watch line every 5s and refresh the tail.
	setInterval(() => {
		const log = history.get("disk-watch");
		if (log) {
			const free = (400 + Math.random() * 12).toFixed(0);
			log.push(`[${new Date().toTimeString().slice(0, 8)}] /: 6x% used (${free}G free)`);
			if (log.length > 200) log.shift();
			threads[0].updatedAtMs = Date.now();
		}
		renderTail();
	}, 5_000).unref?.();
}
