// cmux-control: pi extension entry.
//
// Registers:
//   - 6 slash commands: /cmux-list, /cmux-capture, /cmux-send,
//                        /cmux-launch, /cmux-focus, /cmux-config
//   - 5 LLM-callable tools: cmux_list, cmux_capture, cmux_send,
//                            cmux_launch, cmux_resolve
//   - 1 input hook for NL activation (for example, "list cmux workspaces",
//     "tail surface:1", "send 'hi' to surface:1")
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defaultCmuxExecutor } from "./lib/exec.ts";
import type { CmuxExecutor } from "./lib/exec.ts";
import { DEFAULT_CMUX_PREFIX, requireCmuxRef } from "./lib/safety.ts";
import { checkFocusOp, type FocusOp } from "./lib/focus-ops.ts";
import { listPanes, listWorkspaces, type CmuxWorkspace } from "./lib/list.ts";
import { captureSurface } from "./lib/capture.ts";
import { sendKey, sendText } from "./lib/send.ts";
import { launchWorkspace } from "./lib/launch.ts";

type TypeBoxType = {
	Object(properties: Record<string, unknown>, options?: Record<string, unknown>): unknown;
	String(options?: Record<string, unknown>): unknown;
	Integer(options?: Record<string, unknown>): unknown;
	Boolean(options?: Record<string, unknown>): unknown;
	Optional(schema: unknown): unknown;
};

const { Type } = await import("typebox").catch(() => ({
	Type: {
		Object: (properties: Record<string, unknown>, options: Record<string, unknown> = {}) => ({ type: "object", properties, ...options }),
		String: (options: Record<string, unknown> = {}) => ({ type: "string", ...options }),
		Integer: (options: Record<string, unknown> = {}) => ({ type: "integer", ...options }),
		Boolean: (options: Record<string, unknown> = {}) => ({ type: "boolean", ...options }),
		Optional: (schema: unknown) => schema,
	} satisfies TypeBoxType,
}));

const DEFAULT_CAPTURE_LINES = 50;
const MAX_CAPTURE_LINES = 5000;
const TOOL_ERROR_STDERR_LEN = 1000;
const FOCUS_TIMEOUT_MS = 5000;
const FOCUS_OPS = new Set<FocusOp>(["select-workspace", "focus-pane", "focus-panel", "tab-action"]);

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
};

type NlpMatch =
	| { action: "list"; confidence: number }
	| { action: "capture"; confidence: number; surfaceRef: string; lines?: number }
	| { action: "send"; confidence: number; surfaceRef: string; text: string };

// Session-scoped config (in-memory only).
let currentPrefix = DEFAULT_CMUX_PREFIX;
let s4NlpLoaded = false;
let s4NlpMatcher: ((text: string) => NlpMatch | null) | null = null;
let s4ResolveLoaded = false;
let s4ResolveRunId: ((runId: string, executor: CmuxExecutor, opts?: { prefix?: string }) => Promise<unknown>) | null = null;

function truncate(s: string, n: number): string {
	if (s.length <= n) return s;
	return s.slice(0, n) + "...(truncated)";
}

function toolText(text: string, details: Record<string, unknown> = {}): ToolResult {
	return { content: [{ type: "text", text }], details };
}

function errorText(prefix: string, err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return `${prefix}: ${truncate(message, TOOL_ERROR_STDERR_LEN)}`;
}

function formatWorkspace(workspace: CmuxWorkspace): string {
	return `${workspace.id}  ${workspace.ref}  ${workspace.title}`.trimEnd();
}

function visibleWorkspaces(workspaces: CmuxWorkspace[]): CmuxWorkspace[] {
	return workspaces.filter((workspace) => !currentPrefix || workspace.title.startsWith(currentPrefix));
}

function parseLines(tokens: string[], fallback = DEFAULT_CAPTURE_LINES): number {
	const linesIdx = tokens.indexOf("-N");
	if (linesIdx >= 0 && tokens[linesIdx + 1]) return Number.parseInt(tokens[linesIdx + 1], 10);
	const longIdx = tokens.indexOf("--lines");
	if (longIdx >= 0 && tokens[longIdx + 1]) return Number.parseInt(tokens[longIdx + 1], 10);
	const explicit = tokens.find((token) => /^\d+$/.test(token));
	return explicit ? Number.parseInt(explicit, 10) : fallback;
}

function validateLines(lines: number): string | null {
	if (!Number.isInteger(lines) || lines < 1 || lines > MAX_CAPTURE_LINES) {
		return `lines must be 1..${MAX_CAPTURE_LINES}`;
	}
	return null;
}

function parseLaunchArgs(args: string): { name?: string; cwd: string; command: string; focus: boolean } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const name = tokens.shift();
	let cwd = process.cwd();
	let focus = false;
	const command: string[] = [];

	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token === "--cwd" && tokens[i + 1]) {
			cwd = tokens[i + 1];
			i += 1;
		} else if (token === "--focus") {
			focus = true;
		} else if (token === "--") {
			command.push(tokens.slice(i + 1).join(" "));
			break;
		} else {
			command.push(token);
		}
	}

	return { name, cwd, command: command.join(" ").trim(), focus };
}

function parseFocusOp(raw: string | undefined): FocusOp | null {
	if (!raw) return null;
	return FOCUS_OPS.has(raw as FocusOp) ? raw as FocusOp : null;
}

function parseFocusArgs(args: string): { op?: FocusOp; rawOp?: string; ref?: string; iMeanFocus: boolean; rest: string[] } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const iMeanFocus = tokens.includes("--i-mean-focus");
	const filtered = tokens.filter((token) => token !== "--i-mean-focus");
	return {
		op: parseFocusOp(filtered[0]) ?? undefined,
		rawOp: filtered[0],
		ref: filtered[1],
		iMeanFocus,
		rest: filtered.slice(2),
	};
}

async function runFocusOp(executor: CmuxExecutor, op: FocusOp, ref: string, rest: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
	const expected = op === "select-workspace" || op === "tab-action" ? "workspace" : "surface";
	const parsed = requireCmuxRef(ref, expected);
	if ("error" in parsed) return { ok: false, error: parsed.error };

	const args = op === "select-workspace"
		? ["select-workspace", "--workspace", ref]
		: op === "focus-pane"
			? ["focus-pane", "--surface", ref]
			: op === "focus-panel"
				? ["focus-panel", "--surface", ref]
				: ["tab-action", "--workspace", ref, ...rest];
	const result = await executor.exec(args, { timeoutMs: FOCUS_TIMEOUT_MS });
	if (!result.ok) return { ok: false, error: result.stderr || `cmux ${op} failed (exit ${result.exitCode})` };
	return { ok: true };
}

async function loadS4NlpMatcher(): Promise<((text: string) => NlpMatch | null) | null> {
	if (s4NlpLoaded) return s4NlpMatcher;
	s4NlpLoaded = true;
	try {
		const mod = await import("./lib/nlp.ts");
		s4NlpMatcher = typeof mod.matchNlp === "function" ? mod.matchNlp : null;
	} catch {
		s4NlpMatcher = null;
	}
	return s4NlpMatcher;
}

async function loadS4Resolver(): Promise<((runId: string, executor: CmuxExecutor, opts?: { prefix?: string }) => Promise<unknown>) | null> {
	if (s4ResolveLoaded) return s4ResolveRunId;
	s4ResolveLoaded = true;
	try {
		// Optional S4 bridge; requires the feat/p5d-s4-resolve-nlp branch.
		const mod = await import("./lib/resolve.ts");
		s4ResolveRunId = typeof mod.resolveRunId === "function" ? mod.resolveRunId : null;
	} catch {
		s4ResolveRunId = null;
	}
	return s4ResolveRunId;
}

function fallbackMatchNlp(text: string): NlpMatch | null {
	const trimmed = text.trim();
	if (/^list\s+cmux\s+workspaces\b/i.test(trimmed)) return { action: "list", confidence: 0.95 };

	const capture = /^(?:tail|capture)\s+(surface:\d+)(?:\s+(?:-N\s+|--lines\s+)?(\d+))?\s*$/i.exec(trimmed);
	if (capture) {
		return {
			action: "capture",
			confidence: 0.9,
			surfaceRef: capture[1],
			lines: capture[2] ? Number.parseInt(capture[2], 10) : undefined,
		};
	}

	const send = /^send\s+(?:"([^"]*)"|'([^']*)'|(.+?))\s+to\s+(surface:\d+)\s*$/i.exec(trimmed);
	if (send) {
		return {
			action: "send",
			confidence: 0.9,
			text: send[1] ?? send[2] ?? send[3] ?? "",
			surfaceRef: send[4],
		};
	}

	return null;
}

async function matchNlpInput(text: string): Promise<NlpMatch | null> {
	const matcher = await loadS4NlpMatcher();
	return matcher?.(text) ?? fallbackMatchNlp(text);
}

async function resolveRunId(executor: CmuxExecutor, runId: string): Promise<{ ok: true; workspace: CmuxWorkspace; source: string } | { ok: false; error: string }> {
	const resolver = await loadS4Resolver();
	if (resolver) {
		const resolved = await resolver(runId, executor, { prefix: currentPrefix }) as any;
		if (resolved?.ok && resolved.workspace) return { ok: true, workspace: resolved.workspace, source: resolved.source ?? "resolve.ts" };
		if (resolved?.ok && resolved.workspaceRef) {
			return {
				ok: true,
				workspace: {
					id: Number(String(resolved.workspaceRef).replace(/^workspace:/, "")),
					ref: String(resolved.workspaceRef),
					title: String(resolved.title ?? resolved.runId ?? runId),
					currentDirectory: String(resolved.currentDirectory ?? ""),
				},
				source: resolved.source ?? "resolve.ts",
			};
		}
		if (resolved?.error) return { ok: false, error: String(resolved.error) };
	}

	const workspaces = visibleWorkspaces(await listWorkspaces(executor));
	const exactTitle = workspaces.find((workspace) => workspace.title === runId || workspace.title === `${currentPrefix}${runId}`);
	if (exactTitle) return { ok: true, workspace: exactTitle, source: "workspace-list" };

	const containsRunId = workspaces.find((workspace) => workspace.title.includes(runId));
	if (containsRunId) return { ok: true, workspace: containsRunId, source: "workspace-list" };

	return { ok: false, error: `runId not found: ${runId}` };
}

// -- Slash commands --------------------------------------------------------

function registerCommands(pi: ExtensionAPI): void {
	const executor = defaultCmuxExecutor();

	pi.registerCommand("cmux-list", {
		description: "List cmux workspaces, showing id/ref/title.",
		handler: async (_args, ctx) => {
			try {
				const workspaces = visibleWorkspaces(await listWorkspaces(executor));
				if (workspaces.length === 0) return ctx.ui.notify(`No cmux workspaces match prefix "${currentPrefix}".`, "info");
				ctx.ui.notify(`cmux workspaces (${workspaces.length}):\n${workspaces.map(formatWorkspace).join("\n")}`, "info");
			} catch (err) {
				ctx.ui.notify(errorText("cmux-list failed", err), "warning");
			}
		},
	});

	pi.registerCommand("cmux-capture", {
		description: "Capture last N lines of a cmux surface. /cmux-capture surface:N [-N lines]",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const surfaceRef = tokens[0];
			if (!surfaceRef) return ctx.ui.notify("Usage: /cmux-capture <surface:N> [-N lines]", "warning");
			const lines = parseLines(tokens);
			const linesError = validateLines(lines);
			if (linesError) return ctx.ui.notify(linesError, "warning");

			const result = await captureSurface(executor, surfaceRef, lines);
			if (!result.ok) return ctx.ui.notify(`capture failed: ${result.error}`, "warning");
			ctx.ui.notify(`Surface ${surfaceRef} (last ${lines} lines):\n\n${truncate(result.output, 8000)}`, "info");
		},
	});

	pi.registerCommand("cmux-send", {
		description: "Send literal text or keys to a cmux surface. /cmux-send surface:N [--key] <text>",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const firstSpace = trimmed.indexOf(" ");
			if (!trimmed || firstSpace < 0) return ctx.ui.notify("Usage: /cmux-send <surface:N> [--key] <text>", "warning");
			const surfaceRef = trimmed.slice(0, firstSpace);
			const rest = trimmed.slice(firstSpace + 1).trim();
			if (!rest) return ctx.ui.notify("Usage: /cmux-send <surface:N> [--key] <text>", "warning");

			const keyMode = rest.startsWith("--key ");
			const noEnter = /\s--no-enter$/.test(rest);
			const payload = (keyMode ? rest.slice("--key ".length) : rest).replace(/\s--no-enter$/, "");
			const confirmed = await ctx.ui.confirm(`Send to ${surfaceRef}?`, keyMode ? `Keys: ${payload}` : `Text: ${payload}`);
			if (!confirmed) return;

			const result = keyMode
				? await sendKey(executor, surfaceRef, payload)
				: await sendText(executor, surfaceRef, payload, { pressEnter: !noEnter });
			if (!result.ok) return ctx.ui.notify(`send failed: ${result.error}`, "warning");
			ctx.ui.notify(`Sent to ${surfaceRef}.`, "info");
		},
	});

	pi.registerCommand("cmux-launch", {
		description: "Create a cmux workspace. Name must start with pi-cmux-.",
		handler: async (args, ctx) => {
			const parsed = parseLaunchArgs(args);
			if (!parsed.name) return ctx.ui.notify("Usage: /cmux-launch <pi-cmux-name> [--cwd path] [command]", "warning");
			const result = await launchWorkspace(executor, {
				name: parsed.name,
				cwd: parsed.cwd,
				command: parsed.command || process.env.SHELL || "zsh",
				focus: parsed.focus,
			});
			if (!result.ok) return ctx.ui.notify(`launch failed: ${result.error}`, "warning");
			ctx.ui.notify(`Created cmux workspace ${result.workspaceRef} (${parsed.name}).`, "info");
		},
	});

	pi.registerCommand("cmux-focus", {
		description: "Run focus/select operations. Requires --i-mean-focus.",
		handler: async (args, ctx) => {
			const parsed = parseFocusArgs(args);
			if (!parsed.op || !parsed.ref) {
				if (parsed.rawOp && !parsed.op) {
					return ctx.ui.notify(`Unknown focus operation "${parsed.rawOp}". Expected one of: ${[...FOCUS_OPS].join(", ")}.`, "warning");
				}
				return ctx.ui.notify("Usage: /cmux-focus <select-workspace|focus-pane|focus-panel|tab-action> <ref> --i-mean-focus", "warning");
			}
			const guard = checkFocusOp(parsed.op, { iMeanFocus: parsed.iMeanFocus });
			if (!("allowed" in guard && guard.allowed)) {
				return ctx.ui.notify("Focus operation requires --i-mean-focus.", "warning");
			}
			const result = await runFocusOp(executor, parsed.op, parsed.ref, parsed.rest);
			if (!result.ok) return ctx.ui.notify(`focus failed: ${result.error}`, "warning");
			ctx.ui.notify(`Ran ${parsed.op} for ${parsed.ref}.`, "info");
		},
	});

	pi.registerCommand("cmux-config", {
		description: "Configure cmux-control. Currently: 'prefix <value>' (session-only).",
		handler: async (args, ctx) => {
			const match = args.trim().match(/^prefix\s+["']?(.+?)["']?\s*$/);
			if (!match) return ctx.ui.notify("Usage: /cmux-config prefix <value>  (empty value disables the prefix gate)", "info");
			currentPrefix = match[1];
			ctx.ui.notify(`cmux-control: prefix set to "${currentPrefix}" (session-only).`, "info");
		},
	});
}

// -- LLM-callable tools ----------------------------------------------------

function registerTools(pi: ExtensionAPI): void {
	const executor = defaultCmuxExecutor();

	pi.registerTool({
		name: "cmux_list",
		label: "Cmux list workspaces",
		description: "List cmux workspaces matching the configured prefix.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, _ctx) {
			try {
				const workspaces = visibleWorkspaces(await listWorkspaces(executor));
				if (workspaces.length === 0) return toolText(`(no cmux workspaces match prefix "${currentPrefix}")`, { count: 0 });
				return toolText(workspaces.map(formatWorkspace).join("\n"), { count: workspaces.length });
			} catch (err) {
				return toolText(errorText("cmux_list failed", err), { ok: false });
			}
		},
	});

	pi.registerTool({
		name: "cmux_capture",
		label: "Cmux capture surface",
		description: "Capture the last N lines of a cmux surface ref such as surface:1.",
		parameters: Type.Object({
			surface: Type.String({ description: "Surface ref, e.g. surface:1" }),
			lines: Type.Optional(Type.Integer({ description: `Number of lines to capture (1..${MAX_CAPTURE_LINES})`, minimum: 1, maximum: MAX_CAPTURE_LINES })),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const lines = params.lines ?? DEFAULT_CAPTURE_LINES;
			const linesError = validateLines(lines);
			if (linesError) return toolText(linesError, { ok: false });
			const result = await captureSurface(executor, params.surface, lines);
			if (!result.ok) return toolText(`capture failed: ${result.error}`, { ok: false });
			return toolText(result.output, { ok: true, surface: params.surface, lines });
		},
	});

	pi.registerTool({
		name: "cmux_send",
		label: "Cmux send text or keys",
		description: "Send literal text or key names to a cmux surface ref such as surface:1.",
		parameters: Type.Object({
			surface: Type.String({ description: "Surface ref, e.g. surface:1" }),
			text: Type.String({ description: "Text to send, or whitespace-separated keys when mode is keys" }),
			pressEnter: Type.Optional(Type.Boolean({ description: "Send Enter after literal text (default true)" })),
			mode: Type.Optional(Type.String({ description: "Send mode", enum: ["literal", "keys"] })),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const mode = params.mode ?? "literal";
			if (mode === "keys") {
				for (const key of params.text.trim().split(/\s+/).filter(Boolean)) {
					const result = await sendKey(executor, params.surface, key);
					if (!result.ok) return toolText(`send failed: ${result.error}`, { ok: false });
				}
				return toolText(`Sent keys to ${params.surface}.`, { ok: true, surface: params.surface, mode });
			}

			const result = await sendText(executor, params.surface, params.text, { pressEnter: params.pressEnter !== false });
			if (!result.ok) return toolText(`send failed: ${result.error}`, { ok: false });
			return toolText(`Sent text to ${params.surface}${params.pressEnter === false ? "" : " + Enter"}.`, { ok: true, surface: params.surface, mode });
		},
	});

	pi.registerTool({
		name: "cmux_launch",
		label: "Cmux launch workspace",
		description: "Create a cmux workspace. Workspace name must start with pi-cmux-.",
		parameters: Type.Object({
			name: Type.String({ description: "Workspace name; must start with pi-cmux-" }),
			cwd: Type.String({ description: "Working directory for the workspace" }),
			command: Type.String({ description: "Command to run in the workspace" }),
			focus: Type.Optional(Type.Boolean({ description: "Whether cmux should focus the new workspace (default false)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const result = await launchWorkspace(executor, {
				name: params.name,
				cwd: params.cwd,
				command: params.command,
				focus: params.focus,
			});
			if (!result.ok) return toolText(`launch failed: ${result.error}`, { ok: false });
			return toolText(`Created cmux workspace ${result.workspaceRef} (${params.name}).`, { ok: true, workspaceRef: result.workspaceRef });
		},
	});

	pi.registerTool({
		name: "cmux_resolve",
		label: "Cmux resolve runId",
		description: "Resolve a runId to a cmux workspace.",
		parameters: Type.Object({
			runId: Type.String({ description: "Run id to resolve to a cmux workspace" }),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			try {
				const result = await resolveRunId(executor, params.runId);
				if (!result.ok) return toolText(result.error, { ok: false });
				return toolText(formatWorkspace(result.workspace), { ok: true, source: result.source, workspaceRef: result.workspace.ref });
			} catch (err) {
				return toolText(errorText("cmux_resolve failed", err), { ok: false });
			}
		},
	});
}

// -- NLP input hook --------------------------------------------------------

function registerInputHook(pi: ExtensionAPI): void {
	const executor = defaultCmuxExecutor();

	pi.on("input", async (event, ctx) => {
		const match = await matchNlpInput(event.text ?? "");
		if (!match || match.confidence < 0.7) return { action: "continue" };

		switch (match.action) {
			case "list": {
				try {
					const workspaces = visibleWorkspaces(await listWorkspaces(executor));
					ctx.ui.notify(workspaces.length === 0
						? `(no cmux workspaces match prefix "${currentPrefix}")`
						: `cmux workspaces (${workspaces.length}):\n${workspaces.map(formatWorkspace).join("\n")}`, "info");
				} catch (err) {
					ctx.ui.notify(errorText("cmux list failed", err), "warning");
				}
				return { action: "handled" };
			}
			case "capture": {
				const lines = match.lines ?? DEFAULT_CAPTURE_LINES;
				const result = await captureSurface(executor, match.surfaceRef, lines);
				ctx.ui.notify(result.ok ? `${match.surfaceRef} (last ${lines} lines):\n\n${truncate(result.output, 8000)}` : `capture failed: ${result.error}`, result.ok ? "info" : "warning");
				return { action: "handled" };
			}
			case "send": {
				const result = await sendText(executor, match.surfaceRef, match.text, { pressEnter: true });
				ctx.ui.notify(result.ok ? `Sent to ${match.surfaceRef}.` : `send failed: ${result.error}`, result.ok ? "info" : "warning");
				return { action: "handled" };
			}
			default:
				return { action: "continue" };
		}
	});
}

// -- Entry ----------------------------------------------------------------

export default function cmuxControlExtension(pi: ExtensionAPI): void {
	if (typeof pi?.on !== "function") return;
	if (typeof pi?.registerCommand !== "function") return;
	if (typeof pi?.registerTool !== "function") return;

	pi.on("session_start", () => {
		registerCommands(pi);
		registerTools(pi);
		registerInputHook(pi);
	});
}
