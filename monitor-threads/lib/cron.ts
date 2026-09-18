// monitor-threads/lib/cron.ts — crontab glue for monitor-managed crons.
//
// Crons are standard crontab entries tagged with a marker comment so the
// registry and crontab can be reconciled (the doctor's cron-drift check).
// Pure line-building/removal is exported for tests; the exec wrappers shell
// out to `crontab`.

import { execFile } from "node:child_process";

export const CRON_MARKER_PREFIX = "# pi-monitor:";

/** Build one crontab line for a managed cron: `<schedule> <cmd>  <marker> <name>`. */
export function buildCronLine(name: string, schedule: string, cmd: string): string {
	return `${schedule} ${cmd}  ${CRON_MARKER_PREFIX} ${name}`;
}

/** Remove all lines tagged for `name`; returns {kept, removedCount}. Pure. */
export function removeCronLines(crontab: string, name: string): { kept: string; removedCount: number } {
	const marker = `${CRON_MARKER_PREFIX} ${name}`;
	const lines = crontab.split("\n");
	const kept = lines.filter((l) => !l.includes(marker));
	return { kept: kept.join("\n"), removedCount: lines.length - kept.length };
}

/** Extract managed cron names from a crontab. Pure. */
export function managedCronNames(crontab: string): string[] {
	const names: string[] = [];
	for (const line of crontab.split("\n")) {
		const idx = line.indexOf(CRON_MARKER_PREFIX);
		if (idx !== -1) {
			const name = line.slice(idx + CRON_MARKER_PREFIX.length).trim();
			if (name) names.push(name);
		}
	}
	return names;
}

function execFileText(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, (err, stdout, stderr) => {
			if (err) {
				// crontab -l exits 1 with "no crontab for <user>" — treat as empty.
				if (cmd === "crontab" && args[0] === "-l" && /no crontab/i.test(String(stderr))) resolve("");
				else reject(err);
				return;
			}
			resolve(String(stdout));
		});
	});
}

async function currentCrontab(): Promise<string> {
	return await execFileText("crontab", ["-l"]);
}

/** Does crontab contain the marker entry for `name`? */
export async function crontabHasEntry(name: string): Promise<boolean> {
	const tab = await currentCrontab();
	return tab.split("\n").some((l) => l.includes(`${CRON_MARKER_PREFIX} ${name}`));
}

/** Add a managed crontab entry (idempotent per name). */
export async function crontabAdd(name: string, schedule: string, cmd: string): Promise<void> {
	const tab = await currentCrontab();
	if (tab.split("\n").some((l) => l.includes(`${CRON_MARKER_PREFIX} ${name}`))) return;
	const next = tab.endsWith("\n") || tab === "" ? tab + buildCronLine(name, schedule, cmd) + "\n" : tab + "\n" + buildCronLine(name, schedule, cmd) + "\n";
	await new Promise<void>((resolve, reject) => {
		const proc = execFile("crontab", ["-"], (err) => (err ? reject(err) : resolve()));
		proc.stdin?.end(next);
	});
}

/** Remove the managed crontab entry for `name` (no-op if absent). */
export async function crontabRemove(name: string): Promise<void> {
	const tab = await currentCrontab();
	const { kept, removedCount } = removeCronLines(tab, name);
	if (removedCount === 0) return;
	await new Promise<void>((resolve, reject) => {
		const proc = execFile("crontab", ["-"], (err) => (err ? reject(err) : resolve()));
		proc.stdin?.end(kept);
	});
}
