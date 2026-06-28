// P5b-1: FakeCmuxExecutor — records calls and replays scripted responses for
// tests. Mirrors tmux-terminal/test-fixtures/fake-tmux.ts.
import type { CmuxExecutor, CmuxExecResult } from "../lib/exec.ts";

type ScriptedResponse = {
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	ok?: boolean;
	simulateTimeout?: boolean;
};

export class FakeCmuxExecutor implements CmuxExecutor {
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

	async exec(args: string[], opts: { timeoutMs: number }): Promise<CmuxExecResult> {
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
