// herdr-control: JSON envelope parsing and herdr error classification.
//
// herdr control commands print {"id":"cli:...","result":{...},"type":"..."}
// on stdout. Server errors print JSON on stderr with exit 1; usage errors
// exit 2. The exact stderr error shape is not fully documented, so
// extractError() defensively supports several shapes and falls back to raw
// text. Error codes are matched against the documented set:
//   agent_blocked, agent_prompt_stalled, agent_not_ready, agent_not_running,
//   agent_not_idle, timeout.

export interface HerdrEnvelope<T = unknown> {
	id: string;
	result: T;
	type?: string;
}

export type EnvelopeParse =
	| { ok: true; envelope: HerdrEnvelope }
	| { ok: false; error: string };

export interface HerdrError {
	code: string | null;
	message: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function parseEnvelope(stdout: string): EnvelopeParse {
	const trimmed = stdout.trim();
	if (!trimmed) return { ok: false, error: "herdr returned empty output" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { ok: false, error: `herdr returned non-JSON output: ${trimmed.slice(0, 200)}` };
	}
	const record = asRecord(parsed);
	if (!record || typeof record.id !== "string" || !("result" in record)) {
		return { ok: false, error: `herdr returned unexpected JSON shape: ${trimmed.slice(0, 200)}` };
	}
	return { ok: true, envelope: record as unknown as HerdrEnvelope };
}

export function extractError(stderr: string, exitCode: number): HerdrError {
	const trimmed = stderr.trim();
	if (trimmed) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			const record = asRecord(parsed);
			if (record) {
				// Shapes: {error:{code,message}} | {code,message} | {error:"..."} | {message:"..."}
				const nested = asRecord(record.error);
				if (nested && typeof nested.code === "string") {
					return { code: nested.code, message: typeof nested.message === "string" ? nested.message : trimmed };
				}
				if (typeof record.code === "string") {
					return { code: record.code, message: typeof record.message === "string" ? record.message : trimmed };
				}
				if (typeof record.error === "string") {
					return { code: null, message: record.error };
				}
				if (typeof record.message === "string") {
					return { code: null, message: record.message };
				}
			}
		} catch {
			// not JSON — fall through to raw text
		}
		return { code: null, message: trimmed };
	}
	return { code: null, message: `herdr exited with code ${exitCode}` };
}

// Documented herdr error codes we classify on.
export const HERDR_ERROR_CODES = [
	"agent_blocked",
	"agent_prompt_stalled",
	"agent_not_ready",
	"agent_not_running",
	"agent_not_idle",
	"timeout",
] as const;

export type HerdrErrorCode = (typeof HERDR_ERROR_CODES)[number];

export function isHerdrErrorCode(code: string | null): code is HerdrErrorCode {
	return code !== null && (HERDR_ERROR_CODES as readonly string[]).includes(code);
}

// Match a code against an extracted herdr error. Falls back to substring
// matching in the message because the exact stderr shape may vary.
export function errorCodeIs(err: HerdrError, code: HerdrErrorCode): boolean {
	if (err.code === code) return true;
	return !err.code && err.message.toLowerCase().includes(code.toLowerCase());
}
