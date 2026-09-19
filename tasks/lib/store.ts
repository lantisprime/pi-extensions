// Pure task-store logic for the pi tasks extension. No pi runtime imports —
// unit-testable standalone. Claude Code TaskCreate/TaskUpdate semantics plus:
// explicit lifecycle state machine, evidence-gated settlement (anti-hallucination),
// one-in_progress rule, blockedBy gate, ID-order progression, forward nudges.

export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";

/**
 * Lifecycle state machine:
 *
 *   pending ── start ──▶ in_progress ── complete (evidence + observed work) ──▶ completed (terminal)
 *      │                     │
 *      │ shelve (◀─)         ├── cancel (evidence: reason) ──▶ cancelled (terminal)
 *      └────────◀────────────┘
 *      └──── cancel (evidence: reason) ───────────▶
 *
 * - Exactly one task may be in_progress at a time (forces honest completion).
 * - completed / cancelled are terminal; a settled task never re-opens.
 * - Settlement (completion OR cancellation) requires evidence; completion
 *   additionally requires tool activity observed by the harness since the
 *   task was marked in_progress — invented results are rejected.
 */
export const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
	pending: ["in_progress", "cancelled"],
	in_progress: ["completed", "cancelled", "pending"],
	completed: [],
	cancelled: [],
};

/** Statuses that count as "done enough" for list cleanup (operator consent still required). */
export const SETTLED: readonly TaskStatus[] = ["completed", "cancelled"];

export interface TaskEvidence {
	/** What kind of settlement this evidence supports. */
	kind: "completion" | "cancellation";
	/** Concrete proof (commands run, test results, files changed) or reason. */
	note: string;
	/** ISO timestamp of settlement. */
	at: string;
	/** True when the harness observed tool activity since in_progress. */
	observed: boolean;
}

export interface Task {
	id: string;
	subject: string;
	description: string;
	activeForm?: string;
	status: TaskStatus;
	owner?: string;
	blockedBy: string[];
	/** Set when the task is marked in_progress; anchors the activity check. */
	inProgressAt?: number;
	/** Set when the task settles (completed or cancelled). */
	settledAt?: number;
	evidence?: TaskEvidence;
	/** Times this task entered in_progress. */
	attempts?: number;
	/** Times this task was moved back to pending with a recorded failure. */
	failures?: number;
	/** Most recent recorded failure description (from evidence). */
	lastError?: string;
	createdAt: number;
}

export interface CreateInput {
	/** Short uppercase code derived by the LLM from the task theme (e.g. AUTH). */
	code: string;
	subject: string;
	description: string;
	activeForm?: string;
}

export interface UpdateInput {
	status?: TaskStatus;
	subject?: string;
	description?: string;
	activeForm?: string | null; // null clears
	owner?: string | null; // null clears
	addBlockedBy?: string[];
	/** Required when settling (completed/cancelled): concrete proof or reason. */
	evidence?: string;
}

/** Harness observations injected by the extension; keeps this module pure. */
export interface UpdateEnv {
	/** Current time (ms). */
	now: number;
	/** True when the harness observed at least one non-bookkeeping tool result since inProgressAt. */
	observedActivity: boolean;
}

export interface StoreResult {
	tasks: Task[];
	task?: Task;
	error?: string;
	warnings: string[];
}

export const STATUS_ICON: Record<TaskStatus, string> = {
	pending: "◻",
	in_progress: "◐",
	completed: "✓",
	cancelled: "✗",
};

const MAX_ID_BASE = 16;
const MIN_EVIDENCE = 20;

/** Hard cap so the list (and its per-turn context block) cannot grow unbounded. */
export const MAX_TASKS = 64;

/** Max times a task may enter in_progress before the harness blocks auto-retry. */
export const MAX_ATTEMPTS = 3;

// --- Predicates -----------------------------------------------------------

export function isSettled(status: TaskStatus): boolean {
	return SETTLED.includes(status);
}

/** True when there is at least one task and every task is settled. */
export function allSettled(tasks: Task[]): boolean {
	return tasks.length > 0 && tasks.every((t) => isSettled(t.status));
}

// --- Codes & IDs ----------------------------------------------------------

/** The LLM derives the code; the harness only sanitizes it. */
export function sanitizeCode(code: string): string {
	const cleaned = code
		.toUpperCase()
		.replace(/[^A-Z0-9-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned.slice(0, MAX_ID_BASE);
}

/** ARCH-1 -> ARCH. */
export function taskCode(id: string): string {
	const m = /^(.*)-(\d+)$/.exec(id);
	return m ? m[1]! : id;
}

export function nextId(tasks: Task[], code: string): string {
	let n = 1;
	const pattern = new RegExp(`^${code}-(\\d+)$`);
	for (const t of tasks) {
		const m = pattern.exec(t.id);
		if (m) n = Math.max(n, Number(m[1]) + 1);
	}
	return `${code}-${n}`;
}

function splitId(id: string): [string, number] {
	const m = /^(.*)-(\d+)$/.exec(id);
	return m ? [m[1]!, Number(m[2])] : [id, 0];
}

export function compareIds(a: string, b: string): number {
	const [pa, ia] = splitId(a);
	const [pb, ib] = splitId(b);
	if (pa === pb) return ia - ib;
	return pa < pb ? -1 : 1;
}

/**
 * Work order = creation order (the author sequenced tasks intentionally),
 * ids as tiebreak. "ID order" only governs numbering within one code.
 */
export function sortTasks(tasks: Task[]): Task[] {
	return [...tasks].sort((a, b) => a.createdAt - b.createdAt || compareIds(a.id, b.id));
}

// --- Mutations ------------------------------------------------------------

export function createTask(
	tasks: Task[],
	input: CreateInput,
): { tasks: Task[]; task?: Task; error?: string; warnings: string[] } {
	if (tasks.length >= MAX_TASKS) {
		return {
			tasks,
			error: `Task list is full (${MAX_TASKS}). Settle work and clear the finished set (with operator consent) before adding more.`,
			warnings: [],
		};
	}
	const code = sanitizeCode(input.code) || "TASK";
	// Monotonic creation clock: same-ms creates keep strict authoring order.
	const prev = tasks[tasks.length - 1];
	const createdAt = Math.max(Date.now(), prev ? prev.createdAt + 1 : 0);
	const task: Task = {
		id: nextId(tasks, code),
		subject: input.subject.trim(),
		description: input.description.trim(),
		status: "pending",
		blockedBy: [],
		createdAt,
	};
	if (input.activeForm && input.activeForm.trim()) task.activeForm = input.activeForm.trim();
	const warnings: string[] = [];
	const open = tasks.filter((t) => t.status === "in_progress");
	if (open.length > 0) {
		warnings.push(`${open.map((t) => t.id).join(", ")} still in_progress — mark ${task.id} in_progress only after settling them.`);
	}
	// Anti-gaming: creating a task under a code whose earlier tasks already
	// settled may be an attempt to dodge a burned retry budget. Visibility only —
	// the evidence gate still applies to completing it.
	const priorSameCode = tasks.filter((t) => taskCode(t.id) === code && isSettled(t.status));
	if (priorSameCode.length > 0) {
		warnings.push(
			`${code} already has settled task(s) (${priorSameCode.map((t) => t.id).join(", ")}). ` +
				`If this duplicates settled work, cancel it with evidence instead of re-running it.`,
		);
	}
	return { tasks: [...tasks, task], task, warnings };
}

function evidenceError(taskId: string, status: TaskStatus): string {
	if (status === "completed") {
		return (
			`Cannot complete ${taskId} without evidence: provide "evidence" describing concrete proof ` +
			`(commands run, test results, files changed, commit). Invented or vague claims are rejected.`
		);
	}
	return `Cannot cancel ${taskId} without evidence: provide "evidence" stating why this task is being dropped.`;
}

export function updateTask(tasks: Task[], id: string, patch: UpdateInput, env: UpdateEnv): StoreResult {
	const idx = tasks.findIndex((t) => t.id === id);
	if (idx === -1) {
		const known = sortTasks(tasks).map((t) => t.id).join(", ") || "(none)";
		return {
			tasks,
			error: `Unknown task id "${id}". Known ids: ${known}. Call task_list for the current list.`,
			warnings: [],
		};
	}
	const current = tasks[idx]!;
	const warnings: string[] = [];

	// Terminal states never re-open.
	if (isSettled(current.status)) {
		return {
			tasks,
			error: `${id} is already ${current.status} (terminal). Settled tasks never re-open; create a new task instead.`,
			warnings,
		};
	}

	const target = patch.status;

	// Idempotent re-start: in_progress → in_progress is a no-op success (e.g.
	// after a session resume the model re-affirms the active task).
	if (target === "in_progress" && current.status === "in_progress") {
		return {
			tasks,
			task: current,
			warnings: [`${id} is already in_progress — continue working on it.`],
		};
	}

	// Lifecycle table.
	if (target && !TRANSITIONS[current.status].includes(target)) {
		const allowed = TRANSITIONS[current.status].map((s) => `"${s}"`).join(", ");
		return {
			tasks,
			error: `Illegal transition ${current.status} → ${target} for ${id}. Allowed from ${current.status}: ${allowed}.`,
			warnings,
		};
	}

	// Start guard: attempt budget, exactly one in_progress, blockers settled.
	if (target === "in_progress") {
		const attempts = current.attempts ?? 0;
		if (attempts >= MAX_ATTEMPTS) {
			return {
				tasks,
				error:
					`Cannot start ${id}: attempt budget exhausted (${attempts}/${MAX_ATTEMPTS}, ${current.failures ?? 0} failures). ` +
					`Do not retry automatically — investigate the root cause, change approach, or ask the operator ` +
					`(or cancel the task with evidence explaining why it is unworkable).`,
				warnings,
			};
		}
		const others = tasks.filter((t) => t.status === "in_progress" && t.id !== id);
		if (others.length > 0) {
			return {
				tasks,
				error:
					`Cannot start ${id}: ${others.map((t) => t.id).join(", ")} still in_progress. ` +
					`Complete or cancel them first (both require evidence).`,
				warnings,
			};
		}
		const blockers = current.blockedBy.filter((b) => {
			const blocker = tasks.find((t) => t.id === b);
			return !blocker || !isSettled(blocker.status);
		});
		if (blockers.length > 0) {
			return {
				tasks,
				error: `Cannot start ${id}: blocked by ${blockers.join(", ")} (not settled). Settle or clear those blockers first.`,
				warnings,
			};
		}
	}

	// Settlement guards: evidence required for completed AND cancelled.
	const settling = target === "completed" || target === "cancelled";
	if (settling) {
		const kind: TaskEvidence["kind"] = target === "completed" ? "completion" : "cancellation";
		const note = patch.evidence?.trim() ?? "";
		if (note.length < MIN_EVIDENCE) {
			return { tasks, error: evidenceError(id, target!), warnings };
		}
		if (target === "completed") {
			if (!current.inProgressAt) {
				return {
					tasks,
					error: `Cannot complete ${id}: it was never marked in_progress. Mark it in_progress, do the work, then complete it with evidence.`,
					warnings,
				};
			}
			if (!env.observedActivity) {
				return {
					tasks,
					error:
						`Cannot complete ${id}: no tool activity was observed since it was marked in_progress. ` +
						`Do the actual work first (run commands, edit files), then complete it with real evidence — invented results are rejected.`,
					warnings,
				};
			}
		}
	}

	const updated: Task = { ...current, blockedBy: [...current.blockedBy] };
	if (patch.subject !== undefined) updated.subject = patch.subject.trim();
	if (patch.description !== undefined) updated.description = patch.description.trim();
	if (patch.activeForm !== undefined) {
		if (patch.activeForm === null) delete updated.activeForm;
		else if (patch.activeForm.trim()) updated.activeForm = patch.activeForm.trim();
		else delete updated.activeForm;
	}
	if (patch.owner !== undefined) {
		if (patch.owner === null) delete updated.owner;
		else if (patch.owner.trim()) updated.owner = patch.owner.trim();
		else delete updated.owner;
	}
	if (patch.addBlockedBy && patch.addBlockedBy.length > 0) {
		updated.blockedBy = [...new Set([...updated.blockedBy, ...patch.addBlockedBy.filter((b) => b && b !== id)])];
	}
	if (target === "in_progress") {
		updated.inProgressAt = env.now;
		updated.attempts = (current.attempts ?? 0) + 1;
		if ((current.failures ?? 0) > 0) {
			warnings.push(
				`Retry attempt ${updated.attempts}/${MAX_ATTEMPTS} for ${id}. Last error: ${current.lastError ?? "(unknown)"} — address the root cause, not the symptom.`,
			);
		}
	}
	if (target === "pending" && current.status === "in_progress") {
		// Shelve — with evidence this is a RECORDED FAILURE (retry budget consumed
		// on next start); without evidence it is a neutral unstart.
		const failureNote = patch.evidence?.trim() ?? "";
		if (failureNote.length >= MIN_EVIDENCE) {
			updated.failures = (current.failures ?? 0) + 1;
			updated.lastError = failureNote;
			delete updated.inProgressAt;
			warnings.push(
				`Failure recorded for ${id} (${updated.failures}/${MAX_ATTEMPTS}). Re-investigate before restarting; after ${MAX_ATTEMPTS} attempts the harness blocks auto-retry.`,
			);
		} else {
			delete updated.inProgressAt;
		}
	}
	if (settling) {
		updated.settledAt = env.now;
		updated.evidence = {
			kind: target === "completed" ? "completion" : "cancellation",
			note: patch.evidence!.trim(),
			at: new Date(env.now).toISOString(),
			observed: target === "completed" ? env.observedActivity : true,
		};
	}
	if (target !== undefined) updated.status = target;

	const tasksNext = [...tasks];
	tasksNext[idx] = updated;

	// Forward nudges keep the LLM moving without human involvement.
	const notes: string[] = [];
	if (target === "completed" || target === "cancelled") {
		const next = sortTasks(tasksNext.filter((t) => t.status === "pending"))[0];
		if (next) {
			notes.push(`Next: ${next.id} — ${next.subject}. Mark it in_progress and continue.`);
		} else if (allSettled(tasksNext)) {
			notes.push(
				`All ${tasksNext.length} tasks settled. Verify the work, then ask the operator for permission and call task_clear to delete the finished set.`,
			);
		}
	}
	if (target === "in_progress") {
		notes.push(`Mark ${id} completed via task_update as soon as it is done — do not wait for the user.`);
	}

	return { tasks: tasksNext, task: updated, warnings: [...warnings, ...notes] };
}

// --- Rendering ------------------------------------------------------------

export function counts(tasks: Task[]): {
	total: number;
	completed: number;
	cancelled: number;
	inProgress: number;
	pending: number;
} {
	return {
		total: tasks.length,
		completed: tasks.filter((t) => t.status === "completed").length,
		cancelled: tasks.filter((t) => t.status === "cancelled").length,
		inProgress: tasks.filter((t) => t.status === "in_progress").length,
		pending: tasks.filter((t) => t.status === "pending").length,
	};
}

function settledRef(tasks: Task[]): string {
	const done = tasks.filter((t) => t.status === "completed");
	const cancelled = tasks.filter((t) => t.status === "cancelled");
	const ids = [...done, ...cancelled].map((t) => t.id);
	const shown = ids.slice(0, 8).join(", ") + (ids.length > 8 ? `, +${ids.length - 8} more` : "");
	const parts = [`${done.length} completed`];
	if (cancelled.length > 0) parts.push(`${cancelled.length} cancelled`);
	return `${parts.join(", ")}: ${shown}`;
}

/** Compact human-facing widget. Null clears the widget. */
export function renderWidgetLines(tasks: Task[], expanded: boolean): string[] | null {
	if (tasks.length === 0) return null;
	const settled = tasks.filter((t) => isSettled(t.status));
	if (settled.length === tasks.length) {
		const c = counts(tasks);
		const detail = c.cancelled > 0 ? ` (${c.completed} completed, ${c.cancelled} cancelled)` : "";
		return [`✓ All ${tasks.length} tasks settled${detail} — /tasks clear (with operator consent)`];
	}
	const active = sortTasks(tasks.filter((t) => t.status === "in_progress"));
	const pending = sortTasks(tasks.filter((t) => t.status === "pending"));
	const ordered = [...active, ...pending];
	const cap = expanded ? 12 : 3;
	const codeCounts = new Map<string, number>();
	for (const t of ordered) {
		const c = taskCode(t.id);
		codeCounts.set(c, (codeCounts.get(c) ?? 0) + 1);
	}
	const lines = ordered.slice(0, cap).map((t) => {
		const code = taskCode(t.id);
		// Bare code when unique (ARCH: …), full id when a code has multiple tasks.
		const label = (codeCounts.get(code) ?? 0) > 1 ? t.id : code;
		return `${STATUS_ICON[t.status]} ${label}: ${t.description}`;
	});
	const hidden = ordered.length - lines.length;
	const c = counts(tasks);
	const tail = [`+${c.completed + c.cancelled} settled`];
	const tailText = c.cancelled > 0 ? `${c.completed} completed, ${c.cancelled} cancelled` : `${c.completed} completed`;
	if (hidden > 0) lines.push(` … +${hidden} pending, ${tailText}`);
	else if (settled.length > 0) lines.push(` … ${tailText}: ${settled.map((t) => t.id).slice(0, 8).join(", ")}${settled.length > 8 ? ", …" : ""}`);
	void tail;
	return lines;
}

export interface ContextBlockOptions {
	maxLines?: number;
	/** pending: operator has not yet decided on clearing the finished set. */
	cleanupState?: "pending" | "declined";
}

/**
 * Bounded per-request context injection — the model always sees the current
 * list, so it keeps moving without human prompting and cannot drift. Completed
 * and cancelled tasks appear as compact id references (never full rows). Full
 * detail stays behind task_list (progressive disclosure).
 */
export function renderContextBlock(tasks: Task[], projectPath: string, options: ContextBlockOptions = {}): string | null {
	if (tasks.length === 0) return null;
	const { maxLines = 14, cleanupState } = options;
	const sorted = sortTasks(tasks);

	if (allSettled(sorted)) {
		const ids = sorted.map((t) => t.id);
		const shown = ids.slice(0, 8).join(", ") + (ids.length > 8 ? `, +${ids.length - 8} more` : "");
		const lines = [`✓ All ${tasks.length} tasks settled (${shown}).`];
		if (cleanupState !== "declined") {
			lines.push("Ask the operator for permission, then call task_clear to delete the finished set so it does not accumulate.");
		}
		return `<session-tasks project="${projectPath}">\n${lines.join("\n")}\n</session-tasks>`;
	}

	const active = sorted.filter((t) => t.status === "in_progress");
	const pending = sorted.filter((t) => t.status === "pending");
	const settled = sorted.filter((t) => isSettled(t.status));
	const visible = [...active, ...pending].slice(0, maxLines);
	const lines = visible.map((t) => `${STATUS_ICON[t.status]} ${t.id} [${t.status}] ${t.subject} — ${t.description}`);
	const openTotal = active.length + pending.length;
	if (visible.length < openTotal) lines.push(`… +${openTotal - visible.length} more pending (task_list for the full list)`);
	if (settled.length > 0) lines.push(`✓ ${settledRef(sorted)}`);
	lines.push(
		"Work in listed order. Exactly one in_progress; settle with evidence when done; continue autonomously — do not stop to ask between tasks.",
	);
	return `<session-tasks project="${projectPath}">\n${lines.join("\n")}\n</session-tasks>`;
}

/** One-line per-turn status — cheap freshness anchor between full blocks. */
export function renderStatusLine(tasks: Task[]): string | null {
	if (tasks.length === 0) return null;
	if (allSettled(tasks)) return `[tasks] All ${tasks.length} settled — ask the operator, then task_clear.`;
	const c = counts(tasks);
	const active = sortTasks(tasks.filter((t) => t.status === "in_progress"))[0];
	const pending = sortTasks(tasks.filter((t) => t.status === "pending"))[0];
	const mid = active
		? `${active.id} in_progress`
		: pending
			? `next ${pending.id} — ${pending.subject}`
			: `${c.completed}/${c.total} done`;
	return `[tasks] ${c.completed}/${c.total} done · ${mid}`;
}

/** Full-detail list returned to the model by task_list. */
export function renderModelList(tasks: Task[]): string {
	if (tasks.length === 0) return "(no tasks)";
	const lines = sortTasks(tasks).map((t) => {
		let line = `${t.id} [${t.status}] ${t.subject}: ${t.description}`;
		if (t.activeForm) line += ` (active: ${t.activeForm})`;
		if (t.blockedBy.length > 0) line += ` blockedBy=${t.blockedBy.join(",")}`;
		if (t.owner) line += ` owner=${t.owner}`;
		if (t.evidence) line += `\n    evidence(${t.evidence.kind}, observed=${t.evidence.observed}): ${t.evidence.note}`;
		return line;
	});
	const c = counts(tasks);
	const tail = [`${c.completed} completed`, `${c.inProgress} in_progress`, `${c.pending} pending`];
	if (c.cancelled > 0) tail.splice(1, 0, `${c.cancelled} cancelled`);
	return `${lines.join("\n")}\n\n${c.total} total · ${tail.join(" · ")}`;
}
