// P5: Path validation helpers. Used to fail-closed on attacker-controlled or
// accidental misconfiguration before invoking tmux.
import path from "node:path";
import fs from "node:fs";

/** True iff `p` is a non-empty absolute path with no `..` segments. */
export function isAbsoluteNoDotDot(p: string): boolean {
	if (!p || typeof p !== "string") return false;
	if (!path.isAbsolute(p)) return false;
	const segments = p.split(path.sep);
	return !segments.includes("..");
}

/** True iff realpath(childPath) is the same as or inside realpath(parentDir). */
export function isUnderDir(childPath: string, parentDir: string): boolean {
	try {
		const realChild = fs.realpathSync(childPath);
		const realParent = fs.realpathSync(parentDir);
		const rel = path.relative(realParent, realChild);
		return !rel.startsWith("..") && !path.isAbsolute(rel);
	} catch {
		return false;
	}
}