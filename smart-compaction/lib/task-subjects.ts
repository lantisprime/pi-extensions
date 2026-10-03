// smart-compaction/lib/task-subjects.ts — parse the tasks extension's context
// block out of the system prompt.
//
// WHY THIS EXISTS (bug, 2026-10-03): the relevance gate is the safety net that
// stops smart-compaction from summarizing away the context the current work
// needs. It only ever asks when it has task "subjects". The old code scraped
// the prompt for per-task rows of the form `CODE-N [status] subject` and, on
// finding none, concluded "no active tasks" — returning p=0.5, which maps to
// `focused` (proceed) because 0.5 sits between aggressiveBelow 0.35 and
// deferAbove 0.7.
//
// But the tasks renderer emits a COMPLETELY DIFFERENT shape when every task is
// settled:
//
//   <session-tasks project="...">
//   ✓ All 1 tasks settled (HERDR-1).
//   Ask the operator for permission, then call task_clear ...
//   </session-tasks>
//
// There are no `[status]` rows in that form at all. So the moment a task board
// went all-settled, subject extraction returned [] and the gate silently
// authorized compaction of exactly the context describing the just-finished,
// not-yet-cleared work. Observed live: 3 compactions in 8 minutes, every gate
// call reporting `p=0.5 source=default` ("no active tasks") — Jev was never
// even consulted.
//
// The fix is to distinguish three states instead of collapsing them into
// "no subjects":
//
//   none     — no <session-tasks> block at all. Genuinely no task context;
//              preserving the documented p=0.5 proceed behaviour is correct.
//   active   — the board has non-settled rows; use their subjects (unchanged).
//   settled  — the block is present but has no active rows. The board is
//              awaiting task_clear, so the conversation IS the work. This must
//              NOT be treated as "no tasks".

export type TaskBoardState = "none" | "active" | "settled";

export interface TaskBoard {
	state: TaskBoardState;
	/** Subjects of non-settled (pending / in_progress) tasks, bounded. */
	activeSubjects: string[];
	/** How many settled tasks the board reports. */
	settledCount: number;
}

const BLOCK_OPEN = /<session-tasks\b[^>]*>/i;
const BLOCK_CLOSE = /<\/session-tasks>/i;
// `◐ HERDR-1 [in_progress] Fix the herdr pane-ref parser` — the icon is a
// non-word glyph, hence `[^\w\n]*` rather than a literal.
const TASK_ROW = /^[^\w\n]*([A-Z][A-Z0-9]*-\d+)\s+\[([^\]]+)\]\s+(.+)$/gm;
// `✓ All 1 tasks settled (HERDR-1, HERDR-2).` — the collapsed form, used when
// EVERY task is settled and there are therefore no per-task rows to count.
const ALL_SETTLED = /✓\s*All\s+(\d+)\s+tasks?\s+settled/i;
// `✓ 1 completed, 2 cancelled: A-1, B-2` — settledRef() on a board that still
// has active rows. Settled work gets no per-task row in this form, so the count
// has to come from here.
const SETTLED_SUMMARY = /✓\s*(\d+)\s+completed(?:,\s*(\d+)\s+cancelled)?\s*:/i;
const MAX_SUBJECTS = 8;

/** Extract the `<session-tasks>` block body, or null when absent. */
function blockBody(prompt: string): string | null {
	const open = BLOCK_OPEN.exec(prompt);
	if (!open) return null;
	const after = prompt.slice(open.index + open[0].length);
	const close = BLOCK_CLOSE.exec(after);
	return close ? after.slice(0, close.index) : after;
}

/**
 * Scan `text` for task rows. Returns the non-settled subjects plus a settled
 * row count. `hasRows` distinguishes "found no rows" from "found rows, all of
 * them settled" — that distinction is the whole point of this module.
 */
function scanRows(text: string): { subjects: string[]; settled: number; hasRows: boolean } {
	const subjects: string[] = [];
	let settled = 0;
	let hasRows = false;

	TASK_ROW.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = TASK_ROW.exec(text)) !== null) {
		hasRows = true;
		const [, , status, subject] = m;
		if (status === "completed" || status === "cancelled") settled++;
		else if (subjects.length < MAX_SUBJECTS) subjects.push(subject.trim());
	}
	return { subjects, settled, hasRows };
}

export function parseTaskBoard(prompt: string): TaskBoard {
	const text = prompt ?? "";
	const body = blockBody(text);

	// No <session-tasks> wrapper. A task row can still appear bare in the prompt
	// (the wiring suite renders one exactly that way, and nothing guarantees the
	// wrapper is present in every configuration), so fall back to scanning the
	// whole prompt — the pre-fix behaviour. Without this fallback, requiring the
	// block would silently drop every subject in those setups.
	if (body === null) {
		const loose = scanRows(text);
		if (loose.hasRows) {
			return { state: "active", activeSubjects: loose.subjects, settledCount: loose.settled };
		}
		return { state: "none", activeSubjects: [], settledCount: 0 };
	}

	const { subjects: activeSubjects, settled: settledRows } = scanRows(body);
	// Counted rows are authoritative. Otherwise the renderer used a collapsed
	// form, and the count has to come from a summary line.
	let settled = settledRows;
	if (settled === 0) {
		const all = ALL_SETTLED.exec(body);
		if (all) {
			settled = Number(all[1]) || 0;
		} else {
			const sum = SETTLED_SUMMARY.exec(body);
			if (sum) settled = (Number(sum[1]) || 0) + (Number(sum[2]) || 0);
		}
	}

	if (activeSubjects.length > 0) return { state: "active", activeSubjects, settledCount: settled };
	// Rows existed but every one was settled, OR the block carried only the
	// collapsed all-settled summary. Either way the board is present and has
	// nothing active — which is NOT the same as having no board at all.
	return { state: "settled", activeSubjects: [], settledCount: settled };
}
