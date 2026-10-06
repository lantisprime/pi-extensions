// herdr-control: task-brief composition.
//
// Standing operator rule (2026-10-06): every brief submitted to a herdr pane
// must include cleanup guidance — delegated agents have repeatedly left
// orphaned git worktrees behind (e.g. e2e/compact-request-contract). The
// footer is appended by the extension on every herdr_spawn / herdr_prompt
// submission and must be echoed in any manually-composed brief.
//
// Pane closure is NOT delegated to the subagent (it cannot close the pane it
// is answering from); the caller disposes the pane via herdr_close or the
// close_when_done pipeline option.

export const CLEANUP_GUIDANCE_HEADER = "## Cleanup (mandatory)";

export const CLEANUP_GUIDANCE = [
	CLEANUP_GUIDANCE_HEADER,
	"- Dispose of every git worktree you created: `git worktree remove <path> (--force if needed)` and delete branches you created for it. Do not leave orphaned worktrees.",
	"- Delete temp files/dirs you created; stop background processes/servers you started.",
	"- Finish with a one-line report of what you cleaned up (worktrees removed, files deleted, processes stopped).",
].join("\n");

export interface BriefOptions {
	/** false = caller explicitly opted out of the cleanup footer */
	cleanupGuidance?: boolean;
}

// Append the cleanup footer. Idempotent: a brief that already carries the
// header (e.g. a follow-up prompt quoting an earlier brief) is unchanged.
export function withCleanupGuidance(task: string, opts: BriefOptions = {}): string {
	if (opts.cleanupGuidance === false) return task;
	if (task.includes(CLEANUP_GUIDANCE_HEADER)) return task;
	const trimmed = task.trimEnd();
	return `${trimmed}\n\n${CLEANUP_GUIDANCE}`;
}

// close_when_done policy: dispose the pane only when the task actually
// settled. blocked/timeout/stalled outcomes keep the pane alive — the caller
// needs it to inspect the transcript, rescue the agent, or re-prompt.
export function shouldDisposeOnSettle(
	prompt: { ok: boolean },
	closeWhenDone: boolean | undefined,
): boolean {
	return closeWhenDone === true && prompt.ok;
}
