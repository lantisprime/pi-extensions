// Tasks extension for pi: a durable, harness-level task manager with
// Claude Code TaskCreate/TaskUpdate semantics.
//
// - Durable state: project-keyed JSON at ~/.pi/agent/tasks/projects/<hash>.json,
//   written through atomically (tmp + rename) on EVERY mutation, loaded on
//   session_start for the current folder/repo. Corrupt files are quarantined,
//   never crash the session.
// - Visible in context: before_agent_start injects a bounded <session-tasks>
//   block into every request, so the model always sees what is next and keeps
//   working autonomously. Full detail stays behind task_list (progressive
//   disclosure); the behavioral discipline lives in the tasks skill.
// - Human UI: widget above the editor + footer status + /tasks command.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fsSync, { promises as fs } from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
	allSettled,
	createTask,
	counts,
	isSettled,
	renderContextBlock,
	renderModelList,
	renderStatusLine,
	renderWidgetLines,
	sortTasks,
	updateTask,
	type Task,
} from "./lib/store";

const STATUS_PARAM = Type.Union([
	Type.Literal("pending"),
	Type.Literal("in_progress"),
	Type.Literal("completed"),
	Type.Literal("cancelled"),
]);

interface PersistedShape {
	projectPath: string;
	updatedAt: string;
	/** Operator consent state for deleting a fully-completed set. */
	cleanupState?: "pending" | "declined";
	tasks: Task[];
}

export default function tasksExtension(pi: ExtensionAPI) {
	let tasks: Task[] = [];
	let projectPath: string | null = null;
	let widgetExpanded = false;
	let cleanupState: "pending" | "declined" | undefined;

	// --- Durable store (atomic, project-keyed) ------------------------------

	function storeFile(cwd: string): string {
		const dir = path.join(
			process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"),
			"tasks",
			"projects",
		);
		const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 16);
		return path.join(dir, `${hash}.json`);
	}

	async function loadProject(cwd: string): Promise<void> {
		projectPath = cwd;
		tasks = [];
		const file = storeFile(cwd);
		let raw: string;
		try {
			raw = await fs.readFile(file, "utf8");
		} catch {
			return; // No saved tasks for this project.
		}
		try {
			const parsed = JSON.parse(raw) as PersistedShape;
			if (parsed.projectPath === cwd && Array.isArray(parsed.tasks)) {
				tasks = parsed.tasks.filter((t) => t && typeof t.id === "string" && typeof t.status === "string");
				cleanupState = parsed.cleanupState;
			}
		} catch {
			// Quarantine corrupt state instead of crashing or silently overwriting.
			try {
				await fs.rename(file, `${file}.corrupt-${Date.now()}`);
			} catch {
				// ignore
			}
		}
	}

	/** Write-through: atomic tmp+rename so a crash never leaves partial JSON. */
	async function persist(): Promise<void> {
		if (!projectPath) return;
		const file = storeFile(projectPath);
		const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
		try {
			await fs.mkdir(path.dirname(file), { recursive: true });
			const payload: PersistedShape = { projectPath, updatedAt: new Date().toISOString(), cleanupState, tasks };
			await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
			await fs.rename(tmp, file);
		} catch {
			try {
				await fs.unlink(tmp);
			} catch {
				// ignore
			}
		}
	}

	/** Delete the finished set — only ever with operator consent. */
	async function clearCompleted(_ctx: ExtensionContext): Promise<number> {
		const n = tasks.length;
		tasks = [];
		cleanupState = undefined;
		await persist();
		return n;
	}

	// --- UI -----------------------------------------------------------------

	function updateUI(ctx: ExtensionContext): void {
		const widget = renderWidgetLines(tasks, widgetExpanded);
		ctx.ui.setWidget("tasks", widget ?? []);
		if (!widget) {
			ctx.ui.setStatus("tasks", "");
			return;
		}
		const c = counts(tasks);
		const active = sortTasks(tasks.filter((t) => t.status === "in_progress"))[0];
		const activeText = active ? ` · ◐ ${active.id} ${active.activeForm ?? active.subject}` : "";
		ctx.ui.setStatus("tasks", `Tasks ${c.completed}/${c.total} done${activeText}`);
	}

	// --- Context injection (every turn) ----------------------------------------

	let lastInjectedBlock: string | null = null;
	/** Timestamp of the last observed non-bookkeeping tool result (activity proof). */
	let lastToolResultAt = 0;

	pi.on("before_agent_start", async (event) => {
		lastInjectedBlock = renderContextBlock(tasks, projectPath ?? "(unknown project)", { cleanupState });
		if (!lastInjectedBlock) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${lastInjectedBlock}` };
	});

	// Mid-turn freshness: after EVERY tool result, re-anchor task state. Full
	// block when it changed since the last injection; one-line status otherwise.
	pi.on("tool_result", async (event) => {
		if (typeof event.toolName === "string" && event.toolName.startsWith("task_")) return;
		lastToolResultAt = Date.now(); // real work observed — feeds the evidence gate
		if (tasks.length === 0) return;
		const block = renderContextBlock(tasks, projectPath ?? "(unknown project)", { cleanupState });
		if (!block) return;
		const text = block === lastInjectedBlock ? (renderStatusLine(tasks) ?? block) : block;
		lastInjectedBlock = block;
		const content = [...(event.content ?? [])];
		content.push({ type: "text", text: `\n\n${text}` });
		return { content };
	});

	// --- Lifecycle ------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		await loadProject(ctx.cwd);
		updateUI(ctx);
		// A fully-completed set from a previous session must not accumulate:
		// offer the operator cleanup directly.
		if (allSettled(tasks) && cleanupState === "pending" && ctx.hasUI) {
			const yes = await ctx.ui.confirm(
				"Tasks",
				`All ${tasks.length} tasks from last session are completed. Delete the completed set?`,
			);
			if (yes) {
				const n = await clearCompleted(ctx);
				ctx.ui.notify(`Cleared ${n} completed tasks`, "info");
			} else {
				cleanupState = "declined";
				await persist();
			}
			updateUI(ctx);
		}
	});

	// --- Tools ----------------------------------------------------------------

	function summarize(): string {
		const c = counts(tasks);
		return `${c.completed}/${c.total} completed · ${c.inProgress} in_progress · ${c.pending} pending`;
	}

	pi.registerTool({
		name: "task_create",
		label: "Tasks: create",
		description:
			"Create a session task (starts pending). Multi-step planning discipline lives in the tasks skill.",
		promptGuidelines: [
			"Use task_create when work has 3+ distinct steps, when the user provides multiple tasks, or asks to track tasks. Load the tasks skill for the full discipline.",
		],
		parameters: Type.Object({
			code: Type.String({
				description:
					"Short uppercase code YOU derive from the task theme (e.g. AUTH, MIGRATE, ATTEST-V2). Becomes the id prefix: CODE-1, CODE-2, …",
			}),
			subject: Type.String({ description: "Brief actionable title, imperative form (e.g. 'Fix flaky auth test')." }),
			description: Type.String({ description: "What needs to be done." }),
			activeForm: Type.Optional(
				Type.String({ description: "Present-continuous form shown while in progress (e.g. 'Fixing flaky auth test')." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const p = params as { code: string; subject: string; description: string; activeForm?: string };
			const result = createTask(tasks, p);
			if (result.error || !result.task) throw new Error(result.error ?? "task creation failed");
			tasks = result.tasks;
			await persist();
			updateUI(ctx);
			const notes = result.warnings.map((w) => `Note: ${w}`).join(" ");
			return {
				content: [
					{
						type: "text",
						text: `Created ${result.task.id} [pending] ${result.task.subject}. ${summarize()}${notes ? `\n${notes}` : ""}`,
					},
				],
				details: { taskId: result.task.id, ...counts(tasks) },
			};
		},
	});

	pi.registerTool({
		name: "task_get",
		label: "Tasks: get",
		description: "Fetch one task by id.",
		parameters: Type.Object({
			taskId: Type.String({ description: "Task id, e.g. ARCH-1." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const p = params as { taskId: string };
			const task = tasks.find((t) => t.id === p.taskId);
			if (!task) {
				throw new Error(`Unknown task id "${p.taskId}".\n${renderModelList(tasks)}`);
			}
			updateUI(ctx);
			return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }], details: { taskId: task.id } };
		},
	});

	pi.registerTool({
		name: "task_update",
		label: "Tasks: update",
		description:
			"Update a task's status or fields. Enforces exactly one in_progress; completing a task returns the next one so work continues without waiting.",
		promptGuidelines: [
			"Use task_update to mark a task in_progress BEFORE starting it and completed as soon as it is done; then continue to the returned next task without waiting for the user.",
		],
		parameters: Type.Object({
			taskId: Type.String({ description: "Task id, e.g. ARCH-1." }),
			status: Type.Optional(STATUS_PARAM),
			subject: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
			activeForm: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			owner: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task ids this task waits on." })),
		evidence: Type.Optional(
			Type.String({
				description:
					'REQUIRED to settle. completed: concrete proof (commands run, test results, files changed, commit; >= 20 chars). cancelled: reason for dropping the task. shelving a failing task with evidence records the failure.',
			}),
		),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const p = params as Parameters<typeof updateTask>[2] & { taskId: string };
			const target = tasks.find((t) => t.id === p.taskId);
			const observedActivity = target?.inProgressAt !== undefined && lastToolResultAt > target.inProgressAt;
			const result = updateTask(tasks, p.taskId, p, { now: Date.now(), observedActivity });
			if (result.error) throw new Error(result.error);
			tasks = result.tasks;
			if (allSettled(tasks)) cleanupState = "pending"; // offer operator cleanup
			await persist();
			updateUI(ctx);
			const t = result.task!;
			const lines = [`Updated ${t.id} [${t.status}] ${t.subject}. ${summarize()}`];
			for (const w of result.warnings) lines.push(w);
			return { content: [{ type: "text", text: lines.join("\n") }], details: { taskId: t.id, status: t.status } };
		},
	});

	pi.registerTool({
		name: "task_clear",
		label: "Tasks: clear finished set",
		// Low-risk by construction: only ever succeeds on a fully-completed set.
		description:
			'Delete the finished task set. Only works when EVERY task is settled (completed or cancelled). Ask the operator for permission before calling.',
		promptGuidelines: [
			"Use task_clear only after the operator agrees, and only once every task is completed — completed sets are deleted so context does not accumulate.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!allSettled(tasks)) {
				const open = tasks.filter((t) => !isSettled(t.status)).map((t) => t.id);
				throw new Error(
					`Refusing to clear: ${open.length} task(s) not completed (${open.join(", ")}). Finish them first; clearing requires operator consent and an all-completed set.`,
				);
			}
			const n = await clearCompleted(ctx);
			updateUI(ctx);
			return {
				content: [{ type: "text", text: `Cleared ${n} completed tasks with operator consent. Task list is now empty.` }],
				details: { cleared: n },
			};
		},
	});

	pi.registerTool({
		name: "task_list",
		label: "Tasks: list",
		description: "List all session tasks with full detail.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			updateUI(ctx);
			return { content: [{ type: "text", text: renderModelList(tasks) }], details: counts(tasks) };
		},
	});

	// --- Command ---------------------------------------------------------------

	pi.registerCommand("tasks", {
		description: "Session task list; subcommands: expand, compact, reload, clear",
		getArgumentCompletions: (prefix: string) => {
			const options = ["expand", "compact", "reload", "clear"];
			const filtered = options.filter((o) => o.startsWith(prefix.trim()));
			return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			if (sub === "clear") {
				tasks = [];
				await persist();
				widgetExpanded = false;
				updateUI(ctx);
				ctx.ui.notify("Tasks cleared", "info");
				return;
			}
			if (sub === "reload") {
				await loadProject(ctx.cwd);
				updateUI(ctx);
				ctx.ui.notify(`Tasks reloaded from disk (${summarize()})`, "info");
				return;
			}
			if (sub === "compact") {
				widgetExpanded = false;
				updateUI(ctx);
				return;
			}
			// Default and "expand": render the full widget.
			if (sub && sub !== "expand") {
				ctx.ui.notify("Usage: /tasks | /tasks expand | /tasks compact | /tasks reload | /tasks clear", "warning");
				return;
			}
			widgetExpanded = true;
			updateUI(ctx);
		},
	});

	// Keep sortTasks referenced for future list views (tree-shake guard).
	void sortTasks;
	void fsSync;
}
