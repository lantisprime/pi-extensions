// herdr-control: proactive pane-state watchdog.
//
// Polls the panes this session spawned (or all live agents) on a timer,
// classifies each pane via lib/classify.ts, and surfaces TRANSITIONS:
//   - → blocked  : permission dialog needs a human decision (wakes the
//                  session via pi.sendMessage steer, like monitor-threads)
//   - → done/idle: task finished — candidate for herdr_close per the
//                  cleanup rule (surface only, no turn trigger)
//   - → unknown  : agent exited, crashed, or herdr lost track (surface)
//   - gone       : a watched agent vanished from `agent list` (surface)
//
// The poller is deliberately dumb: one in-flight tick at a time, all herdr
// calls short-timeout, every tick failure swallowed (the next tick retries).
// Never blind-retries prompts and never answers dialogs — that stays with
// herdr_send_keys + the user (see index.ts).

import { listAgents, agentRowName } from "./list.ts";
import { classifyAgent, type Classification } from "./classify.ts";
import { subscribePaneEvents, type PaneEventSubscriber } from "./events.ts";

export const WATCH_EVENT_ENTRY_TYPE = "herdr-control/watch-event";

export const DEFAULT_WATCH_INTERVAL_MS = 20_000;
export const MIN_WATCH_INTERVAL_MS = 5_000;
export const MAX_WATCH_INTERVAL_MS = 300_000;

// Mechanical pane lifecycle: a watched pane whose lease (lastActivityAt ??
// createdAt) expired this long ago AND whose live status is settled (idle/
// done) gets closed automatically. Working/blocked panes are NEVER reaped —
// working is productive, blocked needs a human. 0 disables.
export const DEFAULT_REAP_IDLE_MS = 600_000;

export interface WatchedPane {
	key: string; // agent name, or pane id for unrecognized panes
	paneId?: string;
	kind: string;
	status: ClassifiedStatus;
	classifiedAt: number;
}

export interface WatchEvent {
	key: string;
	paneId?: string;
	kind: string;
	from: Classification["status"] | "new";
	to: Classification["status"] | "gone";
	evidence: string[];
	severity: "warning" | "info";
}

export interface WatchSnapshot {
	running: boolean;
	intervalMs: number;
	targets: "registry" | "all";
	watched: number;
	lastTickAt: number | null;
	lastError: string | null;
	recentEvents: WatchEvent[];
}

type RegistryRecord = {
	name: string;
	paneId: string;
	kind: string;
	orphan?: boolean;
	keep?: boolean;
	lastActivityAt?: number;
	createdAt?: number;
};

type RegistryLike = {
	list(): RegistryRecord[];
};

export class Watchdog {
	private readonly executor: Parameters<typeof listAgents>[0];
	private readonly registry: RegistryLike;
	private readonly notify: (event: WatchEvent) => void;
	private timer: ReturnType<typeof setInterval> | null = null;
	private ticking = false;
	private pendingEvent: { paneId: string } | null = null;
	private snapshot = new Map<string, WatchedPane>();
	private events: WatchEvent[] = [];
	private lastTickAt: number | null = null;
	private lastError: string | null = null;
	intervalMs = DEFAULT_WATCH_INTERVAL_MS;
	targets: "registry" | "all" = "registry";
	/** mechanical idle-pane reaper window (ms); 0 = off */
	reapIdleMs = 0;
	/** herdr socket path — event-based triggers require it; empty = poll only */
	socketPath = "";
	private readonly closePane?: (paneId: string) => Promise<boolean>;
	private subscriber: PaneEventSubscriber | null = null;

	constructor(
		executor: Parameters<typeof listAgents>[0],
		registry: RegistryLike,
		notify: (event: WatchEvent) => void,
		opts: { reapIdleMs?: number; closePane?: (paneId: string) => Promise<boolean> } = {},
	) {
		this.executor = executor;
		this.registry = registry;
		this.notify = notify;
		this.reapIdleMs = opts.reapIdleMs ?? 0;
		this.closePane = opts.closePane;
	}

	get isRunning(): boolean {
		return this.timer !== null;
	}

	start(opts: { intervalMs?: number; targets?: "registry" | "all" } = {}): void {
		if (this.timer) this.stop();
		if (opts.intervalMs !== undefined) {
			this.intervalMs = Math.min(Math.max(Math.trunc(opts.intervalMs), MIN_WATCH_INTERVAL_MS), MAX_WATCH_INTERVAL_MS);
		}
		if (opts.targets) this.targets = opts.targets;
		// Event-based trigger: herdr pushes pane lifecycle events over its socket;
		// the interval becomes a slow reconcile net (re-subscribe, catch events
		// lost during disconnects, GC).
		if (this.socketPath) this.openSubscription();
		this.timer = setInterval(() => {
			void this.tick();
		}, this.intervalMs);
		// A background poller must never hold the host process open (same as
		// monitor-threads' watcher): unref so pi/test processes can exit.
		(this.timer as { unref?: () => void }).unref?.();
		// First tick immediately so the snapshot exists without waiting a full interval.
		void this.tick();
	}

	private openSubscription(): void {
		this.subscriber?.close();
		const paneIds = () => this.registry.list().filter((r) => !r.keep).map((r) => r.paneId);
		const ids = paneIds();
		if (ids.length === 0) return;
		this.subscriber = subscribePaneEvents(this.socketPath, ids, (event) => {
			void this.onPaneEvent(event);
		}, {
			onDown: (why) => {
				this.lastError = `event subscription down: ${why} (reconcile will resubscribe)`;
			},
		});
	}

	// Event-based trigger: herdr told us a pane changed — classify it NOW and
	// run the same transition/reap diff as a reconcile tick, but only for the
	// one pane (cheap, immediate, no 20s latency on blocked dialogs). If a
	// reconcile tick is in flight, the event is QUEUED for a trailing pass —
	// never dropped (review BLOCKER: a dropped blocked event delays the wake).
	private async onPaneEvent(event: { paneId: string }): Promise<void> {
		if (this.ticking) {
			this.pendingEvent = event;
			return;
		}
		this.ticking = true;
		try {
			const record = this.registry.getByPane(event.paneId) ?? this.registry.list().find((r) => r.paneId === event.paneId);
			if (!record) return;
			const previous = this.snapshot.get(record.name);
			// Pane id is the reliable target for pi rows (no command-accepted name).
			const result = await classifyAgent(this.executor, record.paneId || record.name);
			if (!result.ok) return;
			const classification = result.classification;
			this.snapshot.set(record.name, {
				key: record.name,
				paneId: event.paneId,
				kind: record.kind,
				status: classification.status,
				classifiedAt: Date.now(),
			});
			if (!previous || previous.status === classification.status) return;
			const watchEvent = {
				key: record.name,
				paneId: event.paneId,
				kind: record.kind,
				from: previous.status,
				to: classification.status,
				evidence: classification.evidence,
				severity: (classification.status === "blocked" || classification.status === "unknown" ? "warning" : "info") as "warning" | "info",
			};
			this.events.push(watchEvent);
			if (this.events.length > 200) this.events = this.events.slice(-200);
			this.notify(watchEvent);
		} catch {
			// event-triggered classification is best-effort; reconcile covers misses
		} finally {
			this.ticking = false;
			if (this.pendingEvent) {
				const queued = this.pendingEvent;
				this.pendingEvent = null;
				const rerun = setTimeout(() => void this.onPaneEvent(queued), 50);
				(rerun as { unref?: () => void }).unref?.();
			}
		}
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		this.subscriber?.close();
		this.subscriber = null;
	}

	status(): WatchSnapshot {
		return {
			running: this.isRunning,
			intervalMs: this.intervalMs,
			targets: this.targets,
			watched: this.snapshot.size,
			lastTickAt: this.lastTickAt,
			lastError: this.lastError,
			recentEvents: this.events.slice(-20),
		};
	}

	// Test/inspection hook: current watched entry for one key.
	snapshotEntry(key: string): WatchedPane | undefined {
		return this.snapshot.get(key);
	}

	async watchOnce(): Promise<WatchEvent[]> {
		const live = await listAgents(this.executor);
		// Key by EITHER row shape: integration rows use `agent`, path-sourced pi
		// rows use `name` (live-verified — filtering on `agent` alone silently
		// excluded every spawned pi pane).
		const byName = new Map(live.ok ? live.agents.map((a) => [agentRowName(a), a]).filter(([n]) => !!n) : []);

		let keys: Array<{ key: string; paneId?: string; kind: string }>;
		if (this.targets === "registry") {
			keys = this.registry
				.list()
				.filter((r) => !r.orphan && r.kind !== "terminal")
				.map((r) => ({ key: r.name, paneId: r.paneId, kind: r.kind }));
		} else {
			keys = [...byName.keys()].map((name) => ({
				key: name,
				paneId: byName.get(name)?.pane_id,
				kind: "agent",
			}));
		}

		const events: WatchEvent[] = [];
		const next = new Map<string, WatchedPane>();
		const handled = new Set<string>();

		for (const { key, paneId, kind } of keys) {
			handled.add(key);
			const previous = this.snapshot.get(key);
			// Registry-scope agents that vanished from `agent list` are gone — do
			// not classify a ghost (get/read would only misreport stale state).
			if (!byName.has(key)) {
				if (previous) {
					events.push({
						key,
						paneId: previous.paneId,
						kind,
						from: previous.status,
						to: "gone",
						evidence: ["agent no longer in `agent list`"],
						severity: "info",
					});
				}
				continue;
			}
		// Classify by PANE ID (always a valid target for any agent — path-sourced
		// pi rows have NO command-accepted name; live-verified). Pane id comes
		// from the live row when present, else the registry record.
		const target = byName.get(key)?.pane_id || paneId || key;
		let classification: Classification;
		try {
			const result = await classifyAgent(this.executor, target);
			if (!result.ok) continue;
			classification = result.classification;
		} catch {
			continue;
		}
			next.set(key, { key, paneId: paneId ?? byName.get(key)?.pane_id, kind, status: classification.status, classifiedAt: Date.now() });

			if (previous && previous.status !== classification.status) {
				const event: WatchEvent = {
					key,
					paneId: next.get(key)?.paneId,
					kind,
					from: previous.status,
					to: classification.status,
					evidence: classification.evidence,
					severity: classification.status === "blocked" || classification.status === "unknown" ? "warning" : "info",
				};
				events.push(event);
			} else if (!previous) {
				// First sighting: only surface it if it already needs attention.
				if (classification.status === "blocked") {
					events.push({
						key,
						paneId: next.get(key)?.paneId,
						kind,
						from: "new",
						to: "blocked",
						evidence: classification.evidence,
						severity: "warning",
					});
				}
			}
		}

		// Watched agents that vanished without passing the main loop (only
		// possible in "all" scope, where keys come from `agent list` itself):
		for (const [key, watched] of this.snapshot) {
			if (next.has(key) || handled.has(key)) continue;
			const event: WatchEvent = {
				key,
				paneId: watched.paneId,
				kind: watched.kind,
				from: watched.status,
				to: "gone",
				evidence: ["agent no longer in `agent list`"],
				severity: "info",
			};
			events.push(event);
		}

		this.snapshot = next;
		this.lastTickAt = Date.now();
		if (live.ok) this.lastError = null;
		else this.lastError = live.error;

		// Mechanical idle reaper: settled panes past their lease get closed —
		// whether or not anyone remembers to do it. Working/blocked never reaped.
		if (this.reapIdleMs > 0 && this.closePane) {
			const now = Date.now();
			for (const [key, watched] of next) {
				if (watched.status !== "idle" && watched.status !== "done") continue;
				const record = this.registry.list().find((r) => r.name === key);
				if (!record || record.keep) continue;
				const lease = record.lastActivityAt ?? record.createdAt;
				if (typeof lease !== "number" || now - lease < this.reapIdleMs) continue;
				const paneId = watched.paneId ?? record.paneId;
				const ok = await this.closePane(paneId).catch(() => false);
				const event: WatchEvent = {
					key,
					paneId,
					kind: watched.kind,
					from: watched.status,
					to: ok ? "gone" : watched.status,
					evidence: [ok ? `reaped: settled beyond ${this.reapIdleMs}ms lease (mechanical cleanup)` : `reap failed for ${paneId}`],
					severity: "info",
				};
				events.push(event);
				if (ok) next.delete(key);
			}
		}

		if (events.length > 0) {
			this.events.push(...events);
			if (this.events.length > 200) this.events = this.events.slice(-200);
			for (const event of events) this.notify(event);
		}
		return events;
	}

	private async tick(): Promise<void> {
		if (this.ticking) return; // one in-flight tick at a time
		this.ticking = true;
		try {
			await this.watchOnce();
		} catch (err) {
			this.lastError = err instanceof Error ? err.message : String(err);
		} finally {
			this.ticking = false;
		}
	}
}

export function frameWatchEvent(event: WatchEvent): string {
	const head =
		event.to === "blocked"
			? `herdr WATCH: "${event.key}" (${event.paneId ?? "?"}) is BLOCKED at a dialog — decide, then respond deliberately with herdr_send_keys. Never auto-answer.`
			: event.to === "gone"
				? `herdr WATCH: "${event.key}" (${event.paneId ?? "?"}) is gone from agent list.`
				: event.to === "unknown"
					? `herdr WATCH: "${event.key}" (${event.paneId ?? "?"}) state is unknown/unclassifiable.`
					: `herdr WATCH: "${event.key}" (${event.paneId ?? "?"}) ${event.from} → ${event.to}. ${event.to === "done" || event.to === "idle" ? "Task finished — if nothing else is queued, close the pane with herdr_close (cleanup rule)." : ""}`;
	const evidence = event.evidence.length > 0 ? `\nEvidence: ${event.evidence.join("; ").slice(0, 400)}` : "";
	return `${head}${evidence}`;
}
