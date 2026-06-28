// tmux-control: pi extension entry.
//
// Registers:
//   - 6 slash commands: /tmux-list, /tmux-capture, /tmux-send, /tmux-tail,
//                        /tmux-launch, /tmux-config
//   - 4 LLM-callable tools: tmux_list, tmux_capture, tmux_send, tmux_launch
//   - 1 input hook for NL activation (consume NL like "tail bg-abc123")
//
// All tmux operations use argv-only execFile (never a shell), are bounded
// by a hard 5s timeout, and are gated by a window-name prefix check
// (default "pi-agent-"; for /tmux-launch the check is by session name).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { defaultTmuxExecutor } from "./lib/exec.ts";
import { discoverMainServerPrefix } from "./lib/socket.ts";
import { listAgentWindows } from "./lib/list.ts";
import { captureWindow } from "./lib/capture.ts";
import { sendText } from "./lib/send.ts";
import { pasteText } from "./lib/paste.ts";
import { launchSession } from "./lib/launch.ts";
import { resolveRunId } from "./lib/resolve.ts";
import { resolveTarget } from "./lib/safety.ts";
import { matchNlp } from "./lib/nlp.ts";
import {
	DEFAULT_WINDOW_PREFIX,
	DEFAULT_CAPTURE_LINES,
	MAX_CAPTURE_LINES,
	MAX_ERROR_STDERR_LEN,
} from "./lib/constants.ts";

function truncate(s: string, n: number): string {
	if (s.length <= n) return s;
	return s.slice(0, n) + "…(truncated)";
}

// Session-scoped config (in-memory only).
let currentPrefix = DEFAULT_WINDOW_PREFIX;

function getSocketPrefix(): string[] | null {
	return discoverMainServerPrefix();
}

function notConfiguredMsg(): string {
	return "tmux server not running (no $TMUX socket and no default socket at /tmp/tmux-<uid>/default). Start tmux first.";
}

// ── Slash commands ──────────────────────────────────────────────────────

function registerCommands(pi: ExtensionAPI): void {
	const executor = defaultTmuxExecutor();

	pi.registerCommand("tmux-list", {
		description: "List pi-agent-* windows in the user's main tmux server",
		handler: async (_args, ctx) => {
			const sock = getSocketPrefix();
			if (!sock) return ctx.ui.notify(notConfiguredMsg(), "warning");
			const wins = await listAgentWindows(executor, sock, currentPrefix);
			if (wins.length === 0) return ctx.ui.notify(`No windows match prefix "${currentPrefix}".`, "info");
			const lines = wins.map((w) => `  ${w.sessionName}:${w.windowIndex}  ${w.windowName}  ${w.runId ?? ""}  ${w.agentName ?? ""}`.trimEnd());
			ctx.ui.notify(`tmux windows (${wins.length}):\n${lines.join("\n")}`, "info");
		},
	});

	pi.registerCommand("tmux-capture", {
		description: "Capture last N lines of a window (default 200). Confirms whether to inject into context.",
		handler: async (args, ctx) => {
			const sock = getSocketPrefix();
			if (!sock) return ctx.ui.notify(notConfiguredMsg(), "warning");
			const tokens = args.trim().split(/\s+/);
			const id = tokens[0];
			let lines = DEFAULT_CAPTURE_LINES;
			const linesIdx = tokens.indexOf("-N");
			if (linesIdx >= 0 && tokens[linesIdx + 1]) lines = parseInt(tokens[linesIdx + 1], 10);
			const explicitLines = tokens.find((t) => /^\d+$/.test(t));
			if (explicitLines && linesIdx < 0) lines = parseInt(explicitLines, 10);
			if (!Number.isInteger(lines) || lines < 1 || lines > MAX_CAPTURE_LINES) {
				return ctx.ui.notify(`lines must be 1..${MAX_CAPTURE_LINES}`, "warning");
			}
			if (!id) return ctx.ui.notify("Usage: /tmux-capture <window-or-runId> [-N lines]", "warning");

			const wins = await listAgentWindows(executor, sock, currentPrefix);
			const resolved = resolveTarget(id, wins, { prefix: currentPrefix });
			if ("error" in resolved) return ctx.ui.notify(resolved.error, "warning");

			const result = await captureWindow(executor, sock, resolved.target, { lines });
			if (!result.ok) return ctx.ui.notify(`capture failed: ${result.error}`, "warning");

			const truncated = truncate(result.output ?? "", 8000);
			const header = `Window "${resolved.target.windowName}" (session ${resolved.target.sessionName}, last ${lines} lines):`;

			const choice = await ctx.ui.confirm(
				"tmux-capture output",
				`${header}\n\n${truncated}\n\n[yes] Inject into conversation context\n[no]  Show as popup only`,
			);
			if (choice) {
				ctx.ui.notify(`${header}\n\n${truncated}`, "info");
				ctx.ui.notify("(Tip: ask the LLM to call tmux_capture if you want this in conversation context.)", "info");
			} else {
				ctx.ui.notify(truncated, "info");
			}
		},
	});

	pi.registerCommand("tmux-send", {
		description: "Send literal text + Enter to a window. Refuses non-prefixed windows.",
		handler: async (args, ctx) => {
			const sock = getSocketPrefix();
			if (!sock) return ctx.ui.notify(notConfiguredMsg(), "warning");
			const trimmed = args.trim();
			if (!trimmed) return ctx.ui.notify("Usage: /tmux-send <window-or-runId> <text>", "warning");
			const firstSpace = trimmed.indexOf(" ");
			if (firstSpace < 0) return ctx.ui.notify("Usage: /tmux-send <window-or-runId> <text>", "warning");
			const id = trimmed.slice(0, firstSpace);
			const text = trimmed.slice(firstSpace + 1);

			const wins = await listAgentWindows(executor, sock, currentPrefix);
			const resolved = resolveTarget(id, wins, { prefix: currentPrefix });
			if ("error" in resolved) return ctx.ui.notify(resolved.error, "warning");

			const confirmed = await ctx.ui.confirm(
				`Send to "${resolved.target.windowName}"?`,
				`Text: ${text}\n\nPress Enter after sending? (default: yes)`,
			);
			if (!confirmed) return;

			const result = await sendText(executor, sock, resolved.target, text, { pressEnter: true });
			if (!result.ok) return ctx.ui.notify(`send failed: ${result.error}`, "warning");
			ctx.ui.notify(`Sent ${result.sentBytes} bytes + Enter to "${resolved.target.windowName}".`, "info");
		},
	});

	pi.registerCommand("tmux-tail", {
		description: "Capture a run's output by runId (resolves via bg-terminal backend if available).",
		handler: async (args, ctx) => {
			const sock = getSocketPrefix();
			if (!sock) return ctx.ui.notify(notConfiguredMsg(), "warning");
			const tokens = args.trim().split(/\s+/);
			const runId = tokens[0];
			if (!runId) return ctx.ui.notify("Usage: /tmux-tail <runId> [-N lines]", "warning");
			const numStr = tokens.find((t) => /^\d+$/.test(t));
			const lines = numStr ? Math.min(parseInt(numStr, 10), MAX_CAPTURE_LINES) : DEFAULT_CAPTURE_LINES;

			const resolved = await resolveRunId(runId, executor, sock, { prefix: currentPrefix });
			if (!resolved.ok) return ctx.ui.notify(resolved.error, "warning");

			// For backend-sourced targets, we don't have sessionName/windowIndex
			// (the backend's windowId is opaque). Fall back to list-windows lookup.
			let target = resolved.window;
			if (target.sessionName === "?") {
				const wins = await listAgentWindows(executor, sock, currentPrefix);
				const exact = wins.find((w) => w.windowName === target.windowName);
				if (!exact) return ctx.ui.notify(`backend windowId "${target.windowName}" not found in tmux`, "warning");
				target = exact;
			}

			const cap = await captureWindow(executor, sock, target, { lines });
			if (!cap.ok) return ctx.ui.notify(`capture failed: ${cap.error}`, "warning");
			ctx.ui.notify(
				`runId ${runId} → window "${target.windowName}" (via ${resolved.window.source}, last ${lines} lines):\n\n${truncate(cap.output ?? "", 8000)}`,
				"info",
			);
		},
	});

	pi.registerCommand("tmux-launch", {
		description: "Spawn a tmux session (general-purpose, not for agents). /tmux-launch <name> [command]",
		handler: async (args, ctx) => {
			const sock = getSocketPrefix();
			if (!sock) return ctx.ui.notify(notConfiguredMsg(), "warning");
			const tokens = args.trim().split(/\s+/);
			const name = tokens[0];
			const command = tokens.slice(1).join(" ") || undefined;
			if (!name) return ctx.ui.notify("Usage: /tmux-launch <name> [command]", "warning");
			const result = await launchSession(executor, sock, name, command);
			if (!result.ok) return ctx.ui.notify(`launch failed: ${result.error}`, "warning");
			ctx.ui.notify(`Spawned tmux session "${result.sessionName}"${command ? ` running: ${command}` : ""}.`, "info");
		},
	});

	pi.registerCommand("tmux-paste", {
		description: "Paste multi-line text into a window via bracketed paste (no premature submit).",
		handler: async (args, ctx) => {
			const sock = getSocketPrefix();
			if (!sock) return ctx.ui.notify(notConfiguredMsg(), "warning");
			const trimmed = args.trim();
			if (!trimmed) return ctx.ui.notify("Usage: /tmux-paste <window-or-runId> <multi-line-text>", "warning");
			const firstSpace = trimmed.indexOf(" ");
			if (firstSpace < 0) return ctx.ui.notify("Usage: /tmux-paste <window-or-runId> <multi-line-text>", "warning");
			const id = trimmed.slice(0, firstSpace);
			const text = trimmed.slice(firstSpace + 1);

			const wins = await listAgentWindows(executor, sock, currentPrefix);
			const resolved = resolveTarget(id, wins, { prefix: currentPrefix });
			if ("error" in resolved) return ctx.ui.notify(resolved.error, "warning");

			const confirmed = await ctx.ui.confirm(
				`Paste ${text.length} bytes into "${resolved.target.windowName}"?`,
				`Preview:\n${text.slice(0, 400)}${text.length > 400 ? "\n…(truncated)" : ""}`,
			);
			if (!confirmed) return;

			const result = await pasteText(executor, sock, resolved.target, text, { pressEnter: true });
			if (!result.ok) return ctx.ui.notify(`paste failed: ${result.error}`, "warning");
			ctx.ui.notify(`Pasted ${result.sentBytes} bytes + Enter into "${resolved.target.windowName}".`, "info");
		},
	});

	pi.registerCommand("tmux-config", {
		description: "Configure tmux-control. Currently: 'prefix <value>' (session-only).",
		handler: async (args, ctx) => {
			const m = args.trim().match(/^prefix\s+["']?(.+?)["']?\s*$/);
			if (!m) return ctx.ui.notify("Usage: /tmux-config prefix <value>  (empty value disables the prefix gate)", "info");
			currentPrefix = m[1];
			ctx.ui.notify(`tmux-control: prefix set to "${currentPrefix}" (session-only).`, "info");
		},
	});
}

// ── LLM-callable tools ──────────────────────────────────────────────────

function registerTools(pi: ExtensionAPI): void {
	const executor = defaultTmuxExecutor();

	pi.registerTool({
		name: "tmux_list",
		label: "Tmux list agent windows",
		description: "List all tmux windows matching the configured prefix in the user's main tmux server.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, _ctx) {
			const sock = getSocketPrefix();
			if (!sock) return { content: [{ type: "text", text: notConfiguredMsg() }], details: {} };
			const wins = await listAgentWindows(executor, sock, currentPrefix);
			if (wins.length === 0) return { content: [{ type: "text", text: `(no windows match prefix "${currentPrefix}")` }], details: {} };
			const text = wins.map((w) => `${w.sessionName}:${w.windowIndex}  ${w.windowName}  runId=${w.runId ?? ""}  agent=${w.agentName ?? ""}`).join("\n");
			return { content: [{ type: "text", text }], details: { count: wins.length } };
		},
	});

	pi.registerTool({
		name: "tmux_capture",
		label: "Tmux capture window",
		description: "Capture the last N lines of a tmux window. Window name or runId.",
		parameters: Type.Object({
			window: Type.String({ description: "Window name (e.g. pi-agent-bg-abc) or runId (e.g. bg-abc)" }),
			lines: Type.Optional(Type.Integer({ description: `Number of lines to capture (1..${MAX_CAPTURE_LINES})`, minimum: 1, maximum: MAX_CAPTURE_LINES })),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const sock = getSocketPrefix();
			if (!sock) return { content: [{ type: "text", text: notConfiguredMsg() }], details: { ok: false } };
			const wins = await listAgentWindows(executor, sock, currentPrefix);
			const resolved = resolveTarget(params.window, wins, { prefix: currentPrefix });
			if ("error" in resolved) return { content: [{ type: "text", text: resolved.error }], details: { ok: false } };
			const cap = await captureWindow(executor, sock, resolved.target, { lines: params.lines });
			if (!cap.ok) return { content: [{ type: "text", text: `capture failed: ${truncate(cap.error ?? "", MAX_ERROR_STDERR_LEN)}` }], details: { ok: false } };
			return { content: [{ type: "text", text: cap.output ?? "" }], details: { ok: true, lines: params.lines ?? DEFAULT_CAPTURE_LINES, target: `${resolved.target.sessionName}:${resolved.target.windowIndex}` } };
		},
	});

	pi.registerTool({
		name: "tmux_send",
		label: "Tmux send text",
		description: "Send literal text (+ Enter by default) to a tmux window. Refuses non-prefixed windows. Multi-line text is auto-routed via bracketed paste.",
		parameters: Type.Object({
			window: Type.String({ description: "Window name or runId" }),
			text: Type.String({ description: "Text to send (max 4000 bytes). Multi-line is delivered as one bracketed paste event." }),
			pressEnter: Type.Optional(Type.Boolean({ description: "Send Enter after text (default true)" })),
			pressEnterCount: Type.Optional(Type.Integer({
				description: "Number of separate Enter invocations after text (default 1, clamped 0..10). Ignored when pressEnter is false. Applied on both the literal (single-line) and bracketed-paste (multi-line) paths.",
				minimum: 0,
				maximum: 10,
			})),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const sock = getSocketPrefix();
			if (!sock) return { content: [{ type: "text", text: notConfiguredMsg() }], details: { ok: false } };
			const wins = await listAgentWindows(executor, sock, currentPrefix);
			const resolved = resolveTarget(params.window, wins, { prefix: currentPrefix });
			if ("error" in resolved) return { content: [{ type: "text", text: resolved.error }], details: { ok: false } };
			const r = await sendText(executor, sock, resolved.target, params.text, { pressEnter: params.pressEnter, pressEnterCount: params.pressEnterCount });
			if (!r.ok) return { content: [{ type: "text", text: `send failed: ${r.error}` }], details: { ok: false } };
			// Use sendText's reported effective count (post-clamp) for the displayed message;
			// falls back to params-based inference if the field is missing (defensive, e.g. older sendText).
			const enterCount = r.effectiveEnterCount ?? (params.pressEnter === false ? 0 : (params.pressEnterCount ?? 1));
			const enterSuffix = enterCount === 0 ? "" : enterCount === 1 ? " + Enter" : ` + ${enterCount}x Enter`;
			return { content: [{ type: "text", text: `Sent ${r.sentBytes} bytes${enterSuffix} to "${resolved.target.windowName}"${r.routedViaPaste ? " (via bracketed paste)" : ""}.` }], details: { ok: true, target: `${resolved.target.sessionName}:${resolved.target.windowIndex}`, sentBytes: r.sentBytes, routedViaPaste: r.routedViaPaste ?? false, pressEnterCount: enterCount } };
		},
	});

	pi.registerTool({
		name: "tmux_paste",
		label: "Tmux paste multi-line text",
		description: "Deliver multi-line text via bracketed paste (single paste event, no premature submit). Use for code blocks, heredocs, or any prompt containing newlines. Refuses non-prefixed windows.",
		parameters: Type.Object({
			window: Type.String({ description: "Window name or runId" }),
			text: Type.String({ description: "Multi-line text to paste (max 4000 bytes)" }),
			pressEnter: Type.Optional(Type.Boolean({ description: "Send Enter after paste (default true)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const sock = getSocketPrefix();
			if (!sock) return { content: [{ type: "text", text: notConfiguredMsg() }], details: { ok: false } };
			const wins = await listAgentWindows(executor, sock, currentPrefix);
			const resolved = resolveTarget(params.window, wins, { prefix: currentPrefix });
			if ("error" in resolved) return { content: [{ type: "text", text: resolved.error }], details: { ok: false } };
			const r = await pasteText(executor, sock, resolved.target, params.text, { pressEnter: params.pressEnter });
			if (!r.ok) return { content: [{ type: "text", text: `paste failed: ${r.error}` }], details: { ok: false } };
			return { content: [{ type: "text", text: `Pasted ${r.sentBytes} bytes${params.pressEnter !== false ? " + Enter" : ""} into "${resolved.target.windowName}" (bracketed paste).` }], details: { ok: true, target: `${resolved.target.sessionName}:${resolved.target.windowIndex}`, sentBytes: r.sentBytes } };
		},
	});

	pi.registerTool({
		name: "tmux_launch",
		label: "Tmux launch session",
		description: "Spawn a new detached tmux session. Distinct from /agents bg — this is general-purpose tmux launching, not an agent.",
		parameters: Type.Object({
			name: Type.String({ description: "Session name (alphanumeric, dots, dashes)" }),
			command: Type.Optional(Type.String({ description: "Optional command to run in the session" })),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const sock = getSocketPrefix();
			if (!sock) return { content: [{ type: "text", text: notConfiguredMsg() }], details: { ok: false } };
			const r = await launchSession(executor, sock, params.name, params.command);
			if (!r.ok) return { content: [{ type: "text", text: `launch failed: ${r.error}` }], details: { ok: false } };
			return { content: [{ type: "text", text: `Spawned tmux session "${r.sessionName}"${params.command ? ` running: ${params.command}` : ""}.` }], details: { ok: true, sessionName: r.sessionName } };
		},
	});
}

// ── NLP input hook ──────────────────────────────────────────────────────

function registerInputHook(pi: ExtensionAPI): void {
	const executor = defaultTmuxExecutor();

	pi.on("input", async (event, ctx) => {
		const text = event.text ?? "";
		const match = matchNlp(text);
		if (!match) return { action: "continue" };
		if (match.confidence < 0.7) return { action: "continue" };

		const sock = getSocketPrefix();
		if (!sock) {
			ctx.ui.notify(notConfiguredMsg(), "warning");
			return { action: "handled" };
		}

		switch (match.action) {
			case "list": {
				const wins = await listAgentWindows(executor, sock, currentPrefix);
				if (wins.length === 0) {
					ctx.ui.notify(`(no windows match prefix "${currentPrefix}")`, "info");
				} else {
					const lines = wins.map((w) => `  ${w.sessionName}:${w.windowIndex}  ${w.windowName}  ${w.runId ?? ""}  ${w.agentName ?? ""}`.trimEnd());
					ctx.ui.notify(`tmux windows (${wins.length}):\n${lines.join("\n")}`, "info");
				}
				return { action: "handled" };
			}
			case "capture": {
				const runId = match.runId!;
				const resolved = await resolveRunId(runId, executor, sock, { prefix: currentPrefix });
				if (!resolved.ok) {
					ctx.ui.notify(resolved.error, "warning");
					return { action: "handled" };
				}
				let target = resolved.window;
				if (target.sessionName === "?") {
					const wins = await listAgentWindows(executor, sock, currentPrefix);
					const exact = wins.find((w) => w.windowName === target.windowName);
					if (!exact) {
						ctx.ui.notify(`backend windowId "${target.windowName}" not found in tmux`, "warning");
						return { action: "handled" };
					}
					target = exact;
				}
				const cap = await captureWindow(executor, sock, target, { lines: match.lines });
				if (!cap.ok) {
					ctx.ui.notify(`capture failed: ${cap.error}`, "warning");
					return { action: "handled" };
				}
				ctx.ui.notify(`${runId} (window ${target.windowName}, last ${match.lines ?? DEFAULT_CAPTURE_LINES} lines):\n\n${truncate(cap.output ?? "", 8000)}`, "info");
				return { action: "handled" };
			}
			case "send": {
				const runId = match.runId!;
				const text2 = match.text!;
				const resolved = await resolveRunId(runId, executor, sock, { prefix: currentPrefix });
				if (!resolved.ok) {
					ctx.ui.notify(resolved.error, "warning");
					return { action: "handled" };
				}
				let target = resolved.window;
				if (target.sessionName === "?") {
					const wins = await listAgentWindows(executor, sock, currentPrefix);
					const exact = wins.find((w) => w.windowName === target.windowName);
					if (!exact) {
						ctx.ui.notify(`backend windowId "${target.windowName}" not found in tmux`, "warning");
						return { action: "handled" };
					}
					target = exact;
				}
				const r = await sendText(executor, sock, target, text2, { pressEnter: true });
				if (!r.ok) {
					ctx.ui.notify(`send failed: ${r.error}`, "warning");
					return { action: "handled" };
				}
				ctx.ui.notify(`Sent ${r.sentBytes} bytes + Enter to ${runId} (window "${target.windowName}").`, "info");
				return { action: "handled" };
			}
			case "launch": {
				const r = await launchSession(executor, sock, match.sessionName!, match.command);
				if (!r.ok) {
					ctx.ui.notify(`launch failed: ${r.error}`, "warning");
					return { action: "handled" };
				}
				ctx.ui.notify(`Spawned tmux session "${r.sessionName}"${match.command ? ` running: ${match.command}` : ""}.`, "info");
				return { action: "handled" };
			}
			default:
				return { action: "continue" };
		}
	});
}

// ── Entry ───────────────────────────────────────────────────────────────

export default function tmuxControlExtension(pi: ExtensionAPI): void {
	if (typeof pi?.on !== "function") return;
	if (typeof pi?.registerCommand !== "function") return;
	if (typeof pi?.registerTool !== "function") return;

	pi.on("session_start", () => {
		registerCommands(pi);
		registerTools(pi);
		registerInputHook(pi);
	});
}