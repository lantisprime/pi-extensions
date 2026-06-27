// Test seam: programmable TmuxExecutor for unit tests.
//
// Mirrors the real defaultTmuxExecutor's return shape but lets each test
// configure per-call responses (ok/err, stdout/stderr, exit code, delay).
import type { TmuxExecutor, TmuxExecResult } from "../lib/exec.ts";

export interface FakeTmuxCall {
	args: string[];
	result: TmuxExecResult | (() => Promise<TmuxExecResult> | TmuxExecResult);
	delayMs?: number;
}

export interface FakeTmux extends TmuxExecutor {
	calls: FakeTmuxCall[];
	program(responses: Array<FakeTmuxCall | TmuxExecResult | (() => TmuxExecResult)>): void;
	reset(): void;
}

export function createFakeTmux(): FakeTmux {
	const calls: FakeTmuxCall[] = [];
	let queue: Array<FakeTmuxCall | TmuxExecResult | (() => TmuxExecResult)> = [];

	function resolve(r: FakeTmuxCall | TmuxExecResult | (() => TmuxExecResult), args: string[]): FakeTmuxCall {
		if (typeof r === "function") {
			const out = r();
			return { args, result: out };
		}
		if ("ok" in r) {
			return { args, result: r };
		}
		return r;
	}

	const executor: FakeTmux = {
		calls,
		program(responses) {
			queue = [...responses];
		},
		reset() {
			calls.length = 0;
			queue = [];
		},
		async exec(args, opts) {
			const next = queue.shift();
			if (!next) {
				return { ok: false, stdout: "", stderr: "fake-tmux: no programmed response", exitCode: -1 };
			}
			const resolved = resolve(next, args);
			if (resolved.delayMs) await new Promise((r) => setTimeout(r, resolved.delayMs));
			void opts;
			calls.push(resolved);
			return typeof resolved.result === "function"
				? await (resolved.result as () => Promise<TmuxExecResult>)()
				: resolved.result;
		},
	};

	return executor;
}

export function okResult(stdout = "", stderr = ""): TmuxExecResult {
	return { ok: true, stdout, stderr, exitCode: 0 };
}

export function errResult(stderr = "tmux error", exitCode = 1, stdout = ""): TmuxExecResult {
	return { ok: false, stdout, stderr, exitCode };
}