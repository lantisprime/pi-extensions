// P5: FakeTmuxExecutor — records calls and replays scripted responses for tests.
import type { TmuxExecutor, TmuxExecResult } from "../lib/exec.ts";

type ScriptedResponse = {
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	ok?: boolean;
	simulateTimeout?: boolean;
};

export class FakeTmuxExecutor implements TmuxExecutor {
	public calls: Array<{ args: string[]; opts: { timeoutMs: number } }> = [];
	private responses: ScriptedResponse[] = [];
	private defaultResponse: ScriptedResponse = { ok: true, stdout: "", stderr: "", exitCode: 0 };

	public enqueueResponse(response: ScriptedResponse): void {
		this.responses.push(response);
	}

	public setDefaultResponse(response: ScriptedResponse): void {
		this.defaultResponse = response;
	}

	public reset(): void {
		this.calls = [];
		this.responses = [];
		this.defaultResponse = { ok: true, stdout: "", stderr: "", exitCode: 0 };
	}

	async exec(args: string[], opts: { timeoutMs: number }): Promise<TmuxExecResult> {
		this.calls.push({ args, opts });
		const scripted = this.responses.shift() ?? this.defaultResponse;
		if (scripted.simulateTimeout) {
			const err: any = new Error("timeout");
			err.killed = true;
			err.signal = "SIGTERM";
			throw err;
		}
		if (scripted.ok) return { ok: true, stdout: scripted.stdout ?? "", stderr: scripted.stderr ?? "", exitCode: 0 };
		return { ok: false, stdout: scripted.stdout ?? "", stderr: scripted.stderr ?? "", exitCode: scripted.exitCode ?? 1 };
	}
}