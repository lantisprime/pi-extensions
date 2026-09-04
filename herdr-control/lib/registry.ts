// herdr-control: spawn registry — what THIS extension created, and only that.
//
// `herdr_close` may only target panes this extension spawned. The registry is
// event-sourced so it survives session replacement (/new, /resume, /fork,
// /reload): index.ts appends each event to the session via
// pi.appendEntry(SPAWN_REGISTRY_ENTRY_TYPE, event) and rehydrates on
// session_start by replaying events in order. Records whose pane no longer
// appears in `agent list` / layout are pruned (herdr never reuses closed pane
// IDs, so a stale pane ID can never match a recycled terminal).

export interface SpawnRecord {
	name: string;
	paneId: string;
	workspaceId?: string;
	tabId?: string;
	kind: string;
	cwd: string;
	/** true when the agent failed to start but the shell pane was left behind */
	orphan?: boolean;
	createdAt: number;
}

export type RegistryEvent =
	| { op: "spawn"; record: SpawnRecord }
	| { op: "close"; name: string; paneId: string; closedAt: number };

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function makeSpawnEvent(record: Omit<SpawnRecord, "createdAt">): RegistryEvent {
	return { op: "spawn", record: { ...record, createdAt: Date.now() } };
}

export function makeCloseEvent(name: string, paneId: string): RegistryEvent {
	return { op: "close", name, paneId, closedAt: Date.now() };
}

// Defensive shape checks — session data from older versions must never crash
// hydration.
export function isSpawnRecord(value: unknown): value is SpawnRecord {
	const rec = asRecord(value);
	return !!rec
		&& typeof rec.name === "string"
		&& typeof rec.paneId === "string"
		&& typeof rec.kind === "string"
		&& typeof rec.cwd === "string"
		&& typeof rec.createdAt === "number";
}

export function isRegistryEvent(value: unknown): value is RegistryEvent {
	const rec = asRecord(value);
	if (!rec) return false;
	if (rec.op === "spawn") return isSpawnRecord(rec.record);
	if (rec.op === "close") {
		return typeof rec.name === "string" && typeof rec.paneId === "string";
	}
	return false;
}

export class SpawnRegistry {
	private records = new Map<string, SpawnRecord>();

	apply(event: RegistryEvent): void {
		if (event.op === "spawn") {
			this.records.set(event.record.name, event.record);
			return;
		}
		const existing = this.records.get(event.name);
		// Only remove when both name AND pane match — a respawn under the same
		// name must not be closed off by a stale close event.
		if (existing && existing.paneId === event.paneId) this.records.delete(event.name);
	}

	hydrate(events: unknown[]): { applied: number; skipped: number } {
		let applied = 0;
		let skipped = 0;
		for (const event of events) {
			if (isRegistryEvent(event)) {
				this.apply(event);
				applied += 1;
			} else {
				skipped += 1;
			}
		}
		return { applied, skipped };
	}

	spawn(record: SpawnRecord): void {
		this.records.set(record.name, record);
	}

	close(name: string): SpawnRecord | null {
		const record = this.records.get(name) ?? null;
		this.records.delete(name);
		return record;
	}

	get(name: string): SpawnRecord | undefined {
		return this.records.get(name);
	}

	getByPane(paneId: string): SpawnRecord | undefined {
		for (const record of this.records.values()) {
			if (record.paneId === paneId) return record;
		}
		return undefined;
	}

	list(): SpawnRecord[] {
		return [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt);
	}

	// Drop records whose pane is no longer live. Returns the pruned records so
	// the caller can persist close events for them.
	prune(livePaneIds: Set<string>): SpawnRecord[] {
		const pruned: SpawnRecord[] = [];
		for (const record of this.records.values()) {
			if (!livePaneIds.has(record.paneId)) pruned.push(record);
		}
		for (const record of pruned) this.records.delete(record.name);
		return pruned;
	}
}
