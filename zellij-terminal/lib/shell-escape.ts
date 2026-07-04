// P5: POSIX shell single-quote escape. Defensive only — we pass argv arrays
// to execFile rather than shell strings, but we surface shell-escaped forms
// for any test seam that stringifies the argv for assertion.
export function shellEscape(s: string): string {
	if (s === "") return "''";
	return "'" + s.replace(/'/g, "'\\''") + "'";
}