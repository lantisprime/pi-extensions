// monitor-threads — background non-LLM threads (shell monitors + crons).
//
// Architecture:
//   - Supervisor runs detached child processes; stdout/stderr append to spool
//     files under ~/.pi/agent/monitors/spool/<name>.log.
//   - A wake watcher drains each spool past a persisted watermark every 2s.
//     When a thread's policy says the lines matter (errors, or everything),
//     they are framed as untrusted MONITOR EVENT data and injected with
//     pi.sendMessage({ triggerTurn: true }) — waking this session.
//   - The model drives threads through the monitor_threads tool; humans get
//     /monitors (expandable panel), /monitor-doctor, and an 8-line tail widget.
//   - before_agent_start appends a short "Background threads" section so the
//     model is oriented even before its first tool call.

import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Supervisor, frameMonitorEvent, formatTailHeader, type ThreadRecord } from "./lib/supervisor.ts";
import { crontabHasEntry } from "./lib/cron.ts";
import { runDoctor, formatDoctorReport } from "./lib/doctor.ts";
import { registerThreadsTool, threadsPromptSection } from "./lib/threads-tool.ts";
import { openMonitorPanel, type ThreadInfo } from "./lib/panel.ts";

const WAKE_POLL_MS = 2_000;
const TAIL_LINES = 8;

export default function (pi: ExtensionAPI) {
	const supervisor = new Supervisor();
	let watcher: ReturnType<typeof setInterval> | undefined;
	let pinned: string | null = null;
	let lastUi: { ui: ExtensionAPI["ui"]; hasUI: boolean } | null = null;
	let piApi: ExtensionAPI = pi;

	function track(ctx: { hasUI?: boolean; ui: ExtensionAPI["ui"] } | null | undefined): void {
		if (ctx?.ui) lastUi = { ui: ctx.ui, hasUI: ctx.hasUI ?? false };
	}

	// --- 8-line tail widget (ctx.ui.setWidget — pi has no setWidget) ---
	function renderTail(): void {
		if (!lastUi?.hasUI) return;
		if (!pinned) { lastUi.ui.setWidget("monitor-tail", undefined); return; }
		// Status-aware: a stopped/exited thread shows its status in the header
		// (it can't masquerade as an active monitor), an unregistered thread
		// auto-unpins, and every non-running render carries the unpin hint.
		const rec = supervisor.list().find((r) => r.name === pinned);
		if (!rec) { pinned = null; lastUi.ui.setWidget("monitor-tail", undefined); return; }
		void supervisor.tail(rec.name, TAIL_LINES).then((output) => {
			if (!lastUi?.hasUI || pinned === null) return;
			const lines = output.split("\n").map((l) => `  ${l}`);
			if (rec.status !== "running") lines.push("  (no new lines — the thread has ended)");
			lastUi.ui.setWidget("monitor-tail", [
				formatTailHeader(rec.name, rec.status, rec.pid),
				...lines,
			], { placement: "aboveEditor" });
		}).catch(() => { /* tail is best-effort */ });
	}

	// --- Footer status: grouped counts ---
	function renderStatus(): void {
		if (!lastUi?.hasUI) return;
		const rows = supervisor.list();
		const mon = rows.filter((r) => r.kind === "monitor" && r.status === "running").length;
		const cron = rows.filter((r) => r.kind === "cron").length;
		const errors = rows.filter((r) => r.status === "failed").length;
		lastUi.ui.setStatus("monitor-threads",
			`⛏ mon ${mon} · cron ${cron}${errors > 0 ? ` · ✗ ${errors}` : ""}`);
	}

	// --- Wake watcher: drain spools, inject notable lines ---
	async function wakeTick(): Promise<void> {
		for (const t of supervisor.list()) {
			if (t.status !== "running" && t.kind === "monitor") continue;
			let drained;
			try {
				drained = await supervisor.drain(t.name);
			} catch { continue; }
			if (!drained.notable || drained.lines.length === 0 || !drained.record) continue;
			const frame = frameMonitorEvent(drained.record, drained.lines);
			try {
				pi.sendMessage(
					{ customType: "monitor-event", content: frame, display: true },
					{ triggerTurn: true, deliverAs: "steer" },
				);
			} catch { /* sendMessage unavailable (e.g. print mode) — lines stay tailed */ }
		}
		renderTail();
		renderStatus();
	}

	// --- Panel data provider backed by the real supervisor ---
	function panelProvider() {
		const toPanelThread = (r: ThreadRecord): ThreadInfo => ({
			name: r.name,
			kind: r.kind,
			// panel understands running/exited/failed; map stopped→exited
			status: r.status === "stopped" ? "exited" : r.status,
			cmd: r.cmd,
			pid: r.pid,
			schedule: r.schedule,
			updatedAtMs: r.updatedAtMs,
		});
		return {
			getData: (): ThreadInfo[] => supervisor.list().map(toPanelThread),
			getHistory: (name: string): string[] => {
				// Synchronous contract; serve the last snapshot from the spool via
				// node's sync read (small files — tail view is bounded anyway).
				try {
					const buf = readFileSync(supervisor.spoolPath(name), "utf8");
					return buf.split("\n").filter((l) => l.length > 0).slice(-200);
				} catch { return []; }
			},
			runDoctor: () => runDoctor(supervisor.list(), {
				pidAlive: (pid: number) => process.kill(pid, 0),
				spoolFileExists: (name: string) => existsSpool(name),
				crontabHasEntry,
			}),
		};
	}

	function existsSpool(name: string): boolean {
		try { return existsSync(supervisor.spoolPath(name)); } catch { return false; }
	}

	// --- Lifecycle ---

	pi.on("session_start", async (_event, ctx) => {
		track(ctx);
		await supervisor.load();
		renderStatus();
		if (!watcher) {
			watcher = setInterval(() => { void wakeTick(); }, WAKE_POLL_MS);
			(watcher as { unref?: () => void }).unref?.();
		}
	});

	pi.on("session_shutdown", async () => {
		if (watcher) { clearInterval(watcher); watcher = undefined; }
	});

	// The optional: orient the model via the system prompt every turn.
	pi.on("before_agent_start", async (event) => {
		return { systemPrompt: event.systemPrompt + "\n\n" + threadsPromptSection() };
	});

	// --- Model surface ---
	registerThreadsTool(pi, { supervisor });

	// --- Human surface ---
	pi.registerCommand("monitors", {
		description: "Show monitoring threads and crons (expandable panel)",
		handler: async (_args, ctx) => {
			track(ctx);
			const picked = await openMonitorPanel(ctx, panelProvider());
			if (!picked) { renderTail(); return; }
			pinned = picked.name;
			renderTail();
			ctx.ui.notify(`Pinned '${picked.name}' to the tail widget (ctrl+↑/ctrl+↓ to scroll).`, "info");
		},
	});

	pi.registerCommand("monitor-unpin", {
		description: "Clear the pinned monitor tail widget",
		handler: async (_args, ctx) => {
			track(ctx);
			pinned = null;
			renderTail(); // clears the widget
			ctx.ui.notify("Monitor tail unpinned.", "info");
		},
	});

	pi.registerCommand("monitor-doctor", {
		description: "Troubleshoot monitoring threads and crons",
		handler: async (_args, ctx) => {
			track(ctx);
			const provider = panelProvider();
			ctx.ui.notify(formatDoctorReport(provider.runDoctor!()).join("\n"), "info");
		},
	});

	pi.registerShortcut("ctrl+up", {
		description: "Scroll monitor tail up",
		handler: async (ctx) => { track(ctx); renderTail(); },
	});
}
