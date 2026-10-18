// Read-only git snapshots and content hashes. Everything here is bounded:
// short timeout, capped output, capped file reads. A failure returns null and
// the caller fails closed.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const GIT_TIMEOUT_MS = 2_000;
const GIT_MAX_BUFFER = 1_000_000;
const MAX_HASH_BYTES = 5_000_000;
const MAX_CONTENT_HASH_FILES = 500;
const MAX_PATHS = 5_000;

export type Snapshot = { root: string; changed: string[]; truncated: boolean };

function git(cwd: string, args: string[]): Promise<string | null> {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER }, (error, stdout) => {
			if (error) return resolve(null);
			resolve(stdout);
		});
	});
}

/**
 * Parse `git status --porcelain -z -uall`. NUL separation avoids git's C-style
 * quoting, so spaces and newlines in paths cannot escape a package glob.
 * Rename/copy records carry the original path as the next field.
 */
export function parsePorcelain(text: string): { changed: string[]; truncated: boolean } {
	const changed = new Set<string>();
	let truncated = false;
	const parts = text.split("\0").filter(Boolean);
	for (let index = 0; index < parts.length; index += 1) {
		const entry = parts[index];
		if (entry.length < 4) continue;
		const status = entry.slice(0, 2);
		const file = entry.slice(3).replace(/\\/g, "/");
		if (!file) continue;
		if (changed.size >= MAX_PATHS) {
			truncated = true;
			break;
		}
		changed.add(file);
		if (/[RC]/.test(status) && parts[index + 1]) {
			const original = parts[index + 1].replace(/\\/g, "/");
			if (original && changed.size < MAX_PATHS) changed.add(original);
			index += 1;
		}
	}
	return { changed: [...changed].sort(), truncated };
}

export async function readSnapshot(cwd: string): Promise<Snapshot | null> {
	const root = (await git(cwd, ["rev-parse", "--show-toplevel"]))?.trim();
	if (!root) return null;
	const status = await git(root, ["status", "--porcelain", "-z", "-uall"]);
	if (status === null) return null;
	const { changed, truncated } = parsePorcelain(status);
	return { root, changed, truncated };
}

/**
 * Content hash for a package's changed files. Deletions and symlinks are
 * hashed by marker, and oversized/overflow files by metadata, so a deletion
 * cannot deadlock the gate (green must remain recordable). Only a failed
 * `lstat`/`readFile` on a still-existing file produces a marker too: the test
 * run itself is the proof, the hash is a change detector.
 */
export async function hashChangedFiles(root: string, files: string[]): Promise<string> {
	const hash = createHash("sha256");
	const sorted = [...files].sort();
	for (let index = 0; index < sorted.length; index += 1) {
		const file = sorted[index];
		const absolute = path.join(root, file);
		let stat: Awaited<ReturnType<typeof fs.lstat>>;
		try {
			stat = await fs.lstat(absolute);
		} catch {
			hash.update(`${file}\0deleted\n`);
			continue;
		}
		if (stat.isSymbolicLink()) {
			const target = await fs.readlink(absolute).catch(() => "unreadable");
			hash.update(`${file}\0link:${target}\n`);
			continue;
		}
		if (!stat.isFile()) {
			hash.update(`${file}\0special:${stat.size}:${stat.mtimeMs}\n`);
			continue;
		}
		if (stat.size > MAX_HASH_BYTES || index >= MAX_CONTENT_HASH_FILES) {
			hash.update(`${file}\0meta:${stat.size}:${stat.mtimeMs}\n`);
			continue;
		}
		try {
			const content = await fs.readFile(absolute);
			hash.update(`${file}\0`);
			hash.update(content);
			hash.update("\n");
		} catch {
			hash.update(`${file}\0unreadable:${stat.size}:${stat.mtimeMs}\n`);
		}
	}
	return hash.digest("hex");
}
