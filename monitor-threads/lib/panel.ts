// monitor-threads/lib/panel.ts — expandable thread/cron panel (pi overlay).
//
// Rendered via ctx.ui.custom(..., { overlay: true }) so the panel OWNS input:
// ↑/↓ move the selection, ←/→ collapse/expand groups, enter pins a thread to
// the tail widget, t opens a scrollable history view, esc closes.
//
// Animated status glyphs: running threads spin through braille frames
// (~120ms); failed threads blink ✗/⚠ (~600ms) so a dead thread is noticed.
// The panel draws its own border box sized to the render width, and every
// line is width-clamped, so footer hints can never overlap the border.

import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { DoctorFinding } from "./doctor.ts";

// --- Data model ---

export type ThreadKind = "monitor" | "cron";
export type ThreadStatus = "running" | "exited" | "failed";

export type ThreadInfo = {
	name: string;
	kind: ThreadKind;
	status: ThreadStatus;
	cmd: string;
	/** Present for running monitors. */
	pid?: number;
	/** Present for crons (raw crontab schedule). */
	schedule?: string;
	/** Last output/exit time (Date.now() ms). */
	updatedAtMs: number;
};

export type ThreadDataProvider = {
	getData: () => ThreadInfo[];
	/** Full output history for a thread (newest last) — shown in the `t` view. */
	getHistory: (name: string) => string[];
	/** Optional doctor probes — powers the `d` diagnostics view and the error
	 *  hint in the footer. Absent → doctor view is unavailable. */
	runDoctor?: () => DoctorFinding[];
};

// --- Animation ---

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ERROR_FRAMES = ["✗", "⚠"];
const ANIM_INTERVAL_MS = 120;
/** Error blink advances every N animation ticks (~600ms). */
const ERROR_BLINK_EVERY = 5;

// --- Internal rows ---

type Row =
	| { type: "group"; kind: ThreadKind }
	| { type: "thread"; thread: ThreadInfo };

const GROUP_LABEL: Record<ThreadKind, string> = { monitor: "Monitoring threads", cron: "Crons" };
const STATUS_COLOR: Record<ThreadStatus, "success" | "dim" | "error"> = { running: "success", exited: "dim", failed: "error" };

const HISTORY_VIEWPORT = 14;

// --- Component ---

class MonitorPanel {
	// NOTE: explicit fields + assignments (not TS parameter properties) — keeps
	// the file erasable so node --experimental-strip-types can load it in tests.
	private tui: TUI;
	private theme: Theme;
	private data: ThreadDataProvider;
	private done: (picked: ThreadInfo | null) => void;
	private collapsed = new Set<ThreadKind>();
	private cursor = 0;
	private mode: "list" | "history" | "doctor" = "list";
	private historyName: string | null = null;
	private historyOffset = 0;
	private doctorFindings: DoctorFinding[] = [];
	private disposed = false;
	private frame = 0;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private animTimer: ReturnType<typeof setInterval> | undefined;
	private lastDataJson = "";

	constructor(tui: TUI, theme: Theme, data: ThreadDataProvider, done: (picked: ThreadInfo | null) => void) {
		this.tui = tui;
		this.theme = theme;
		this.data = data;
		this.done = done;
		// Data poll: picks up new/exited/dead threads.
		this.pollTimer = setInterval(() => this.pollTick(), 1_000);
		(this.pollTimer as { unref?: () => void }).unref?.();
		// Animation: spins/blinks status glyphs while any thread is animated.
		this.animTimer = setInterval(() => this.animTick(), ANIM_INTERVAL_MS);
		(this.animTimer as { unref?: () => void }).unref?.();
	}

	// -- lifecycle --

	private pollTick(): void {
		if (this.disposed) return;
		const json = JSON.stringify(this.data.getData());
		if (json !== this.lastDataJson) {
			this.lastDataJson = json;
			this.clampCursor();
			this.tui.requestRender();
		}
	}

	private animTick(): void {
		if (this.disposed) return;
		// Skip renders entirely when nothing is animated (all exited/collapsed).
		if (!this.hasAnimatedThread()) return;
		this.frame++;
		this.tui.requestRender();
	}

	private hasAnimatedThread(): boolean {
		// Only animate glyphs that are actually visible (collapsed groups render no rows).
		return this.data.getData().some((t) => {
			if (this.collapsed.has(t.kind)) return false;
			return t.status === "running" || t.status === "failed";
		});
	}

	private close(picked: ThreadInfo | null): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.pollTimer) clearInterval(this.pollTimer);
		if (this.animTimer) clearInterval(this.animTimer);
		this.done(picked);
	}

	invalidate(): void { /* state changes go through tui.requestRender() */ }

	// -- status glyphs --

	private statusGlyph(t: ThreadInfo): string {
		if (t.status === "running") return SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length];
		if (t.status === "failed") return ERROR_FRAMES[Math.floor(this.frame / ERROR_BLINK_EVERY) % ERROR_FRAMES.length];
		return "○";
	}

	// -- rows --

	private threads(kind: ThreadKind): ThreadInfo[] {
		return this.data.getData().filter((t) => t.kind === kind);
	}

	private rows(): Row[] {
		const out: Row[] = [];
		for (const kind of ["monitor", "cron"] as ThreadKind[]) {
			out.push({ type: "group", kind });
			if (this.collapsed.has(kind)) continue;
			for (const thread of this.threads(kind)) out.push({ type: "thread", thread });
		}
		return out;
	}

	private clampCursor(): void {
		const len = this.rows().length;
		if (len === 0) { this.cursor = 0; return; }
		this.cursor = Math.min(Math.max(this.cursor, 0), len - 1);
	}

	private toggleGroup(kind: ThreadKind): void {
		if (this.collapsed.has(kind)) this.collapsed.delete(kind);
		else this.collapsed.add(kind);
		this.clampCursor();
	}

	// -- input --

	handleInput(data: string): void {
		if (this.mode === "history") { this.handleHistoryInput(data); return; }
		if (this.mode === "doctor") { this.handleDoctorInput(data); return; }
		const rows = this.rows();
		if (matchesKey(data, "escape") || data === "q") { this.close(null); return; }
		if (matchesKey(data, "up")) {
			this.cursor = (this.cursor - 1 + rows.length) % Math.max(rows.length, 1);
		} else if (matchesKey(data, "down")) {
			this.cursor = (this.cursor + 1) % Math.max(rows.length, 1);
		} else if (matchesKey(data, "left") || matchesKey(data, "right")) {
			const row = rows[this.cursor];
			if (row) this.toggleGroup(row.type === "group" ? row.kind : row.thread.kind);
		} else if (matchesKey(data, "return")) {
			const row = rows[this.cursor];
			if (!row) return;
			if (row.type === "group") { this.toggleGroup(row.kind); return; }
			this.close(row.thread);
			return;
		} else if (data === "t") {
			const row = rows[this.cursor];
			if (row?.type === "thread") this.openHistory(row.thread.name);
		} else if (data === "d") {
			if (this.data.runDoctor) {
				this.doctorFindings = this.data.runDoctor();
				this.mode = "doctor";
			}
		}
		this.tui.requestRender();
	}

	private handleDoctorInput(data: string): void {
		// Doctor view is read-only: esc/left/q returns to the list.
		if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "left")) {
			this.mode = "list";
		}
		this.tui.requestRender();
	}

	private openHistory(name: string): void {
		this.mode = "history";
		this.historyName = name;
		this.historyOffset = Math.max(0, this.data.getHistory(name).length - HISTORY_VIEWPORT);
	}

	private handleHistoryInput(data: string): void {
		const lines = this.historyName ? this.data.getHistory(this.historyName) : [];
		const maxOffset = Math.max(0, lines.length - HISTORY_VIEWPORT);
		if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "left")) {
			this.mode = "list";
		} else if (matchesKey(data, "up")) {
			this.historyOffset = Math.max(0, this.historyOffset - 1);
		} else if (matchesKey(data, "down")) {
			this.historyOffset = Math.min(maxOffset, this.historyOffset + 1);
		} else if (matchesKey(data, "pageUp")) {
			this.historyOffset = Math.max(0, this.historyOffset - HISTORY_VIEWPORT);
		} else if (matchesKey(data, "pageDown")) {
			this.historyOffset = Math.min(maxOffset, this.historyOffset + HISTORY_VIEWPORT);
		}
		this.tui.requestRender();
	}

	// -- rendering --

	private fmtAgo(ms: number): string {
		const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
		if (s < 60) return `${s}s ago`;
		if (s < 3600) return `${Math.floor(s / 60)}m ago`;
		return `${Math.floor(s / 3600)}h ago`;
	}

	private statusDetail(t: ThreadInfo): string {
		if (t.kind === "cron") {
			// Cron rows render only when the Crons group is expanded — that's where
			// the schedule (and the computed next run) is surfaced.
			const next = t.schedule ? nextCronRun(t.schedule) : undefined;
			return next ? `${t.schedule} → next ${fmtHM(next)}` : t.schedule ?? "";
		}
		if (t.status === "running") return `pid ${t.pid ?? "?"}`;
		return this.fmtAgo(t.updatedAtMs);
	}

	/** Wrap content lines in a border box exactly `width` columns wide. Every
	 *  content line is padded/clamped to the inner width (ANSI-aware), so the
	 *  right border always lines up and hints can never overlap it. */
	private boxed(content: string[], width: number): string[] {
		const inner = Math.max(8, width - 4); // │ + padding + content + padding + │
		const out: string[] = [];
		const bar = "─".repeat(width - 2);
		out.push(`┌${bar}┐`);
		for (const line of content) out.push(`│ ${truncateToWidth(line, inner, undefined, true)} │`);
		out.push(`└${bar}┘`);
		return out;
	}

	render(width: number): string[] {
		const inner = width - 4;
		if (this.mode === "history") return this.boxed(this.renderHistoryLines(inner), width);
		if (this.mode === "doctor") return this.boxed(this.renderDoctorLines(inner), width);
		return this.boxed(this.renderListLines(inner), width);
	}

	private renderListLines(innerWidth: number): string[] {
		const { theme } = this;
		const threads = this.data.getData();
		const monitors = threads.filter((t) => t.kind === "monitor");
		const crons = threads.filter((t) => t.kind === "cron");
		const lines: string[] = [];

		// Header: counts per group; threads run in the background — this panel is
		// only a view, closing it never stops them.
		lines.push(theme.fg("accent", truncateToWidth(
			`Threads (background) — ${monitors.length} monitor(s) · ${crons.length} cron(s)`,
			innerWidth,
		)));

		const rows = this.rows();
		rows.forEach((row, i) => {
			const selected = i === this.cursor;
			const cursorGlyph = selected ? theme.fg("accent", "▌ ") : "  ";
			if (row.type === "group") {
				const glyph = this.collapsed.has(row.kind) ? "▸" : "▾";
				let label = `${glyph} ${GROUP_LABEL[row.kind]} (${this.threads(row.kind).length})`;
				// Collapsed crons still surface the next scheduled run.
				if (row.kind === "cron" && this.collapsed.has("cron")) {
					const next = nextRunSummary(this.threads("cron"));
					if (next) label += ` — next ${next}`;
				}
				lines.push(cursorGlyph + (selected ? theme.fg("accent", label) : theme.fg("muted", label)));
				return;
			}
			const t = row.thread;
			const glyph = theme.fg(STATUS_COLOR[t.status], this.statusGlyph(t));
			const name = selected ? theme.fg("accent", t.name) : t.name;
			const detail = theme.fg("dim", this.statusDetail(t));
			const left = `    ${glyph} ${name}`;
			const right = `  ${detail}`;
			// The cursor glyph is part of the row — count it, or rows overflow the
			// inner width by 2 and get clipped by the box wrapper.
			const pad = Math.max(1, innerWidth - visibleWidthSafe(cursorGlyph) - visibleWidthSafe(left) - visibleWidthSafe(right));
			lines.push(cursorGlyph + left + " ".repeat(pad) + right);
		});

		if (rows.filter((r) => r.type === "thread").length === 0) {
			lines.push(theme.fg("dim", "  (no threads — start one with /monitors start <script>)"));
		}

		// Footer hints — two short lines so they never collide with the border.
		lines.push("");
		const errors = this.data.runDoctor?.().filter((f) => f.severity === "error").length ?? 0;
		lines.push(theme.fg("dim", truncateToWidth(
			errors > 0 ? `↑↓ move   ←→ expand   enter pin   t history   d doctor (${errors} error${errors === 1 ? "" : "s"})` : "↑↓ move   ←→ expand   enter pin to tail   t history",
			innerWidth,
		)));
		lines.push(theme.fg("dim", truncateToWidth("esc close", innerWidth)));
		return lines;
	}

	private renderDoctorLines(innerWidth: number): string[] {
		const { theme } = this;
		const findings = this.doctorFindings;
		const errors = findings.filter((f) => f.severity === "error").length;
		const warns = findings.filter((f) => f.severity === "warn").length;
		const glyph: Record<DoctorFinding["severity"], { g: string; c: "success" | "dim" | "error" }> = {
			ok: { g: "✓", c: "success" }, warn: { g: "⚠", c: "dim" }, error: { g: "✗", c: "error" },
		};
		const lines: string[] = [];
		lines.push(theme.fg(errors > 0 ? "error" : warns > 0 ? "dim" : "success", truncateToWidth(
			`doctor — ${findings.length} finding(s): ${errors} error(s) · ${warns} warning(s)`,
			innerWidth,
		)));
		lines.push(theme.fg("dim", "─".repeat(Math.min(innerWidth, 60))));
		for (const f of findings) {
			const { g, c } = glyph[f.severity];
			lines.push(truncateToWidth(`${theme.fg(c, g)} [${f.check}] ${f.message}`, innerWidth));
			if (f.nextStep) lines.push(`      ${theme.fg("dim", `→ ${f.nextStep}`)}`);
		}
		lines.push("");
		lines.push(theme.fg("dim", truncateToWidth("esc back", innerWidth)));
		return lines;
	}

	private renderHistoryLines(innerWidth: number): string[] {
		const { theme } = this;
		const name = this.historyName ?? "";
		const all = this.data.getHistory(name);
		const window = all.slice(this.historyOffset, this.historyOffset + HISTORY_VIEWPORT);
		const lines: string[] = [];
		lines.push(theme.fg("accent", truncateToWidth(`history: ${name} (${all.length} lines)`, innerWidth)));
		lines.push(theme.fg("dim", "─".repeat(Math.min(innerWidth, 60))));
		if (window.length === 0) lines.push(theme.fg("dim", "(no output yet)"));
		for (const line of window) lines.push(truncateToWidth(line, innerWidth));
		lines.push(theme.fg("dim", "─".repeat(Math.min(innerWidth, 60))));
		const from = all.length === 0 ? 0 : Math.min(this.historyOffset + 1, all.length);
		const to = Math.min(this.historyOffset + HISTORY_VIEWPORT, all.length);
		lines.push(theme.fg("dim", truncateToWidth(`↑↓ scroll   pgUp/pgDn page   ${from}-${to}/${all.length}   esc back`, innerWidth)));
		return lines;
	}
}

function visibleWidthSafe(s: string): number {
	// strip ANSI escapes for width math on themed segments
	return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Approximate next-run preview for a standard 5-field cron expression.
 *  Supports minute/hour fields with star, step values (star-slash-5), lists
 *  (a,b) and ranges (a-b); dom/month/dow are treated as always-matching.
 *  Display-only: the real scheduler is crontab/launchd. Returns undefined
 *  for unsupported input. */
export function nextCronRun(schedule: string, from = new Date()): Date | undefined {
	const fields = schedule.trim().split(/\s+/);
	if (fields.length !== 5) return undefined;
	const [minF, hourF] = fields;
	const matchField = (field: string, value: number): boolean => {
		if (field === "*") return true;
		return field.split(",").some((part) => {
			const [range, step] = part.split("/");
			const stride = step ? parseInt(step, 10) : 1;
			let lo: number, hi: number;
			if (range === "*") { lo = 0; hi = 59; }
			else if (range.includes("-")) {
				const [a, b] = range.split("-").map((n) => parseInt(n, 10));
				lo = a; hi = b;
			} else { lo = hi = parseInt(range, 10); }
			if (!Number.isInteger(lo) || !Number.isInteger(hi) || stride < 1) return false;
			for (let v = lo; v <= hi; v += stride) if (v === value) return true;
			return false;
		});
	};
	const t = new Date(from);
	t.setSeconds(0, 0);
	t.setMinutes(t.getMinutes() + 1); // strictly in the future
	for (let i = 0; i < 60 * 24 * 2; i++) { // bound: 2 days of minutes
		if (matchField(minF, t.getMinutes()) && matchField(hourF, t.getHours())) return t;
		t.setMinutes(t.getMinutes() + 1);
	}
	return undefined;
}

function fmtHM(d: Date): string {
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function nextRunSummary(threads: ThreadInfo[]): string | undefined {
	const times = threads
		.map((t) => (t.schedule ? nextCronRun(t.schedule) : undefined))
		.filter((d): d is Date => d !== undefined)
		.sort((a, b) => a.getTime() - b.getTime());
	return times[0] ? fmtHM(times[0]) : undefined;
}

// --- Public API ---

/** Open the expandable threads/crons panel. Resolves with the pinned thread, or null on dismiss. */
export async function openMonitorPanel(ctx: ExtensionCommandContext, data: ThreadDataProvider): Promise<ThreadInfo | null> {
	return await ctx.ui.custom<ThreadInfo | null>(
		(tui, theme, _keybindings, done) => new MonitorPanel(tui, theme, data, done),
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: 64, maxHeight: "80%" },
		},
	);
}
