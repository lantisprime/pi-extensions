// P8-2: in-process (NOT P4-worker) background-run registry + a display-only progress widget.
//
// Makes /agents do|run|chain|run-temp non-blocking: a command handler fires the child run here
// and returns immediately, so pi's composer stays live and pi's NATIVE queueing handles any
// follow-up prompts the user types. We render ONLY via setWidget + notify — never custom() or
// onTerminalInput — so input/queueing stays pi's, not ours (REQ-2). P4 is untouched: this module
// imports nothing from bg-state.ts and owns its own concurrency constant.

export const BG_RUN_MAX_CONCURRENT = 5;
export const MAX_TAIL_LINE_CHARS = 200;
export const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const; // user's "rotating circle"
export const SPINNER_INTERVAL_MS = 120;
export const WIDGET_KEY = "agents:bg-runs";
export const BG_RUN_CAP_MESSAGE = `Too many background agent runs (${BG_RUN_MAX_CONCURRENT}). Wait for one to finish.`;

/** Minimal UI surface bg-run is allowed to touch — display + notify ONLY. Deliberately omits
 *  custom()/onTerminalInput so the composer stays entirely pi's (REQ-2). */
export type BgRunUI = {
	setWidget(key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
	notify(message: string, level?: "info" | "warning" | "error" | string): void;
};

export type BgRunHandle = { onProgress(line: string): void };

export type BgRunSettle = { message: string; level: "info" | "warning" | "error" };

type Timer = ReturnType<typeof setInterval>;
type RunEntry = { id: number; label: string; startedAt: number; tail: string[] };
type Deps = { now: () => number; setIntervalFn: typeof setInterval; clearIntervalFn: typeof clearInterval };

const DEFAULT_DEPS: Deps = { now: Date.now, setIntervalFn: setInterval, clearIntervalFn: clearInterval };

const registry = new Map<number, RunEntry>();
let idCounter = 0;
let frameIndex = 0;
let timer: Timer | undefined;
let activeUI: BgRunUI | undefined;
let deps: Deps = DEFAULT_DEPS;

/** Strip C0 (\x00-\x1f), DEL (\x7f) and C1 (\x80-\x9f) controls — the latter catches the 1-byte
 *  CSI \x9b that a C0-only strip would miss — then truncate. Lines arrive already newline-split
 *  and UTF-8-decoded (child-runner P8-1), so a split multi-byte/CSI sequence can't reach here. */
export function sanitizeProgressLine(raw: string): string {
	// eslint-disable-next-line no-control-regex
	const stripped = raw.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
	return stripped.length > MAX_TAIL_LINE_CHARS ? stripped.slice(0, MAX_TAIL_LINE_CHARS) : stripped;
}

/** Best-effort: reduce a JSONL stdout line to a short activity string. Never throws. */
export function summarizeProgressLine(raw: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		const s = sanitizeProgressLine(raw);
		return s.length ? s : undefined;
	}
	if (parsed && typeof parsed === "object") {
		const obj = parsed as Record<string, unknown>;
		if (typeof obj.toolName === "string") {
			const args = obj.args !== undefined ? sanitizeProgressLine(JSON.stringify(obj.args)).slice(0, 60) : "";
			return sanitizeProgressLine(`→ ${obj.toolName} ${args}`.trim());
		}
		const message = obj.message as { content?: unknown } | undefined;
		if (obj.type === "message_end" && message && typeof message.content === "string") {
			const s = sanitizeProgressLine(message.content.replace(/\n/g, " "));
			return s.length ? s : undefined;
		}
	}
	const s = sanitizeProgressLine(raw);
	return s.length ? s : undefined;
}

function render(): void {
	if (!activeUI || typeof activeUI.setWidget !== "function") return;
	if (registry.size === 0) {
		try { activeUI.setWidget(WIDGET_KEY, undefined); } catch { /* detached/closed UI context */ }
		return;
	}
	const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
	const lines: string[] = [];
	for (const entry of registry.values()) {
		const elapsed = Math.max(0, Math.floor((deps.now() - entry.startedAt) / 1000));
		lines.push(`${frame} ${entry.label} · ${elapsed}s`);
		for (const t of entry.tail) lines.push(`   ${t}`);
	}
	try { activeUI.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" }); } catch { /* detached/closed UI context */ }
}

function ensureTimer(): void {
	if (timer !== undefined) return;
	timer = deps.setIntervalFn(() => { frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length; render(); }, SPINNER_INTERVAL_MS);
	(timer as { unref?: () => void })?.unref?.();
}

function stopTimerIfIdle(): void {
	if (registry.size === 0 && timer !== undefined) {
		deps.clearIntervalFn(timer);
		timer = undefined;
	}
}

/** Fire-and-forget. Returns void synchronously (REQ-1). `run` receives a progress handle and
 *  resolves to the message+level to notify on settle. Deregister + widget-clear happen in a
 *  `finally`, so EVERY settle path (resolve, reject, throw-before-spawn) frees the slot and
 *  clears the widget when the registry empties (adversarial B3). */
export function startBackgroundRun(args: {
	ui: BgRunUI;
	label: string;
	run: (handle: BgRunHandle) => Promise<BgRunSettle>;
	now?: () => number;
	setInterval?: typeof setInterval;
	clearInterval?: typeof clearInterval;
}): void {
	const { ui, label, run } = args;
	deps = {
		now: args.now ?? deps.now ?? DEFAULT_DEPS.now,
		setIntervalFn: args.setInterval ?? deps.setIntervalFn ?? DEFAULT_DEPS.setIntervalFn,
		clearIntervalFn: args.clearInterval ?? deps.clearIntervalFn ?? DEFAULT_DEPS.clearIntervalFn,
	};
	activeUI = ui;

	if (registry.size >= BG_RUN_MAX_CONCURRENT) {
		ui.notify(BG_RUN_CAP_MESSAGE, "warning");
		return;
	}

	const entry: RunEntry = { id: ++idCounter, label, startedAt: deps.now(), tail: [] };
	registry.set(entry.id, entry);
	ensureTimer();
	render();

	const handle: BgRunHandle = {
		onProgress(line: string) {
			const summary = summarizeProgressLine(line);
			if (!summary) return;
			entry.tail.push(summary);
			if (entry.tail.length > 2) entry.tail = entry.tail.slice(-2);
			render();
		},
	};

	Promise.resolve()
		.then(() => run(handle))
		.then((settle) => { ui.notify(settle.message, settle.level); })
		.catch((err) => { ui.notify(`Background agent run failed: ${err instanceof Error ? err.message : String(err)}`, "error"); })
		.finally(() => {
			registry.delete(entry.id);
			render();
			stopTimerIfIdle();
		});
}

/** Registered on session_shutdown — clears the timer and the widget so nothing leaks (REQ-11). */
export function disposeBackgroundRuns(ui: Pick<BgRunUI, "setWidget">): void {
	if (timer !== undefined) { deps.clearIntervalFn(timer); timer = undefined; }
	registry.clear();
	frameIndex = 0;
	if (ui && typeof ui.setWidget === "function") {
		try { ui.setWidget(WIDGET_KEY, undefined); } catch { /* detached/closed UI context */ }
	}
	activeUI = undefined;
}

/** Test-only: reset module singleton state between cases. */
export function __resetBackgroundRuns(): void {
	if (timer !== undefined) { try { deps.clearIntervalFn(timer); } catch { /* ignore */ } timer = undefined; }
	registry.clear();
	idCounter = 0;
	frameIndex = 0;
	activeUI = undefined;
	deps = DEFAULT_DEPS;
}
