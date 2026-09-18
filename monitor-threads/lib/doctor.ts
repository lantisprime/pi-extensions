// monitor-threads/lib/doctor.ts — troubleshoot background threads/crons.
//
// Pure checks over the thread registry plus optional environment probes
// (pid liveness, spool presence/size, crontab presence). Probes the caller
// cannot supply are skipped — the report only claims what it verified.
// Mirrors the /agents doctor convention in this repo: every finding carries
// a concrete next step.

import type { ThreadInfo } from "./panel.ts";

export type DoctorSeverity = "ok" | "warn" | "error";

export type DoctorFinding = {
	severity: DoctorSeverity;
	/** Short check id, e.g. "pid-liveness". */
	check: string;
	message: string;
	/** Concrete remediation hint shown under the finding. */
	nextStep?: string;
};

export type DoctorEnv = {
	/** Is the given OS pid alive? Absent → pid-liveness checks are skipped. */
	pidAlive?: (pid: number) => boolean;
	/** Does the thread's spool output file exist? Absent → capture checks skipped. */
	spoolFileExists?: (name: string) => boolean;
	/** Current spool file size in bytes, if known. */
	spoolBytes?: (name: string) => number | undefined;
	/** Does crontab still contain the marker entry for this cron? Absent → drift checks skipped. */
	crontabHasEntry?: (name: string) => boolean;
};

/** Spool files above this are considered non-rotating (10 MB). */
export const SPOOL_ROTATION_WARN_BYTES = 10 * 1024 * 1024;

export function runDoctor(threads: ThreadInfo[], env: DoctorEnv = {}): DoctorFinding[] {
	const findings: DoctorFinding[] = [];

	for (const t of threads) {
		// 1. Crashed threads (registry status failed).
		if (t.status === "failed") {
			findings.push({
				severity: "error",
				check: "thread-status",
				message: `thread '${t.name}' crashed (${t.cmd})`,
				nextStep: `restart it: /monitors start ${t.cmd}`,
			});
		}

		// 2. Stale pid: registry says running but the process is gone.
		if (t.status === "running" && t.pid !== undefined && env.pidAlive) {
			if (!env.pidAlive(t.pid)) {
				findings.push({
					severity: "error",
					check: "pid-liveness",
					message: `thread '${t.name}' reports pid ${t.pid} but the process is dead`,
					nextStep: `restart: /monitors start ${t.cmd} (registry is reconciled on restart)`,
				});
			}
		}

		// 3. Output capture: a running thread must have a spool file.
		if (t.status === "running" && env.spoolFileExists) {
			if (!env.spoolFileExists(t.name)) {
				findings.push({
					severity: "warn",
					check: "spool-capture",
					message: `thread '${t.name}' is running but its spool file is missing — output never reaches the agent`,
					nextStep: `check the monitor writes via 'monitor-emit ${t.name}' and spool dir permissions`,
				});
			}
		}

		// 4. Spool rotation.
		if (env.spoolBytes) {
			const bytes = env.spoolBytes(t.name);
			if (bytes !== undefined && bytes > SPOOL_ROTATION_WARN_BYTES) {
				findings.push({
					severity: "warn",
					check: "spool-rotation",
					message: `spool for '${t.name}' is ${Math.round(bytes / 1024 / 1024)} MB — rotation is not keeping up`,
					nextStep: "check the spool sweeper is running; lower the per-thread retention cap",
				});
			}
		}

		// 5. Cron drift: registry schedules a cron that crontab no longer has.
		if (t.kind === "cron" && env.crontabHasEntry) {
			if (!env.crontabHasEntry(t.name)) {
				findings.push({
					severity: "error",
					check: "cron-drift",
					message: `cron '${t.name}' is registered (${t.schedule ?? "?"}) but has no crontab entry`,
					nextStep: `re-register: /monitors cron add ${t.name}`,
				});
			}
		}
	}

	if (findings.length === 0) {
		findings.push({
			severity: "ok",
			check: "summary",
			message: `${threads.length} thread(s) checked — no issues found`,
		});
	}
	return findings;
}

const SEVERITY_GLYPH: Record<DoctorSeverity, string> = { ok: "✓", warn: "⚠", error: "✗" };

/** Plain-text report (one finding per pair of lines, nextStep dimmed). */
export function formatDoctorReport(findings: DoctorFinding[]): string[] {
	const lines: string[] = [];
	const errors = findings.filter((f) => f.severity === "error").length;
	const warns = findings.filter((f) => f.severity === "warn").length;
	lines.push(`doctor — ${findings.length} finding(s): ${errors} error(s) · ${warns} warning(s)`);
	for (const f of findings) {
		lines.push(`${SEVERITY_GLYPH[f.severity]} [${f.check}] ${f.message}`);
		if (f.nextStep) lines.push(`    → ${f.nextStep}`);
	}
	return lines;
}
