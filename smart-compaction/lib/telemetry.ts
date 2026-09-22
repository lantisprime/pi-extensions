// smart-compaction/lib/telemetry.ts — JSONL decision log (AC-9).
//
// One line per decision point: profile id/mode, reason, estimates, gate
// output. Estimates are marked as estimates. Failures to write are swallowed
// (telemetry must never break the session).

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TelemetryRecord {
	ts: string;
	sessionId?: string;
	event: string;
	modelKey?: string;
	profileSource?: string;
	mode?: string;
	decision: string;
	why?: string;
	estimates?: Record<string, number | string | boolean | null>;
	gate?: { probability: number; source: string; action: string };
}

export class Telemetry {
	private path: string;
	private broken = false;

	constructor(sessionId?: string) {
		const dir = join(homedir(), ".pi", "agent", "cache", "smart-compaction");
		this.path = join(dir, `telemetry${sessionId ? "-" + sessionId : ""}.jsonl`);
	}

	log(rec: TelemetryRecord): void {
		if (this.broken) return;
		try {
			mkdirSync(join(this.path, ".."), { recursive: true });
			appendFileSync(this.path, `${JSON.stringify(rec)}\n`);
		} catch {
			this.broken = true;
		}
	}

	get filePath(): string {
		return this.path;
	}
}
