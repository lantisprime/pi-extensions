// MCP bridge extension for pi.
//
// Connects to Model Context Protocol servers and exposes their tools as native
// pi tools. Supports both transports:
//   - stdio: spawns the server process (stdio transport)
//   - http:  Streamable HTTP endpoint (remote servers)
//
// Servers are configured in `~/.pi/agent/mcp.json` (global) or `.pi/mcp.json`
// (project-local); see README.md for the format. Use `/mcp` in a session to
// inspect status or reconnect.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fsSync, { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpClient, type McpToolDefinition } from "./lib/client";
import { loadMcpConfig, type McpServerConfig } from "./lib/config";
import { mergeHeaders, runHeadersCommand } from "./lib/headers";
import { HttpTransport } from "./lib/http";
import { StdioTransport, type Transport } from "./lib/stdio";

const CLIENT_NAME = "pi-mcp-bridge";
const CLIENT_VERSION = "0.1.0";

type ServerStatus = "disabled" | "connecting" | "connected" | "error";

interface ServerState {
	name: string;
	config: McpServerConfig;
	status: ServerStatus;
	error?: string;
	client: McpClient | null;
	tools: McpToolDefinition[];
	/** Registered pi tool names for this server. */
	registered: Set<string>;
	connecting: Promise<void> | null;
}

interface McpContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	resource?: { uri?: string; mimeType?: string; text?: string; blob?: string };
	uri?: string;
	name?: string;
}

type OutputBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export default function mcpBridgeExtension(pi: ExtensionAPI) {
	const states = new Map<string, ServerState>();

	// --- Name handling -------------------------------------------------------

	const takenNames = new Set<string>();

	function sanitizePart(input: string): string {
		const cleaned = input
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "")
			.replace(/_{2,}/g, "_");
		return cleaned || "x";
	}

	function allocateToolName(server: string, tool: string): string {
		const base = `mcp_${sanitizePart(server)}_${sanitizePart(tool)}`.slice(0, 120).replace(/_+$/, "");
		let name = base;
		let counter = 2;
		while (takenNames.has(name)) {
			name = `${base}_${counter++}`;
		}
		takenNames.add(name);
		return name;
	}

	// --- Connection ----------------------------------------------------------

	async function connectServer(state: ServerState, ctx: ExtensionContext, quiet: boolean): Promise<void> {
		if (state.connecting) return state.connecting;
		if (state.config.enabled === false) {
			state.status = "disabled";
			return;
		}

		state.connecting = (async () => {
			state.status = "connecting";
			state.error = undefined;
			let transport: Transport | null = null;
			try {
				transport = await createTransport(state.config);
				const client = new McpClient(transport, {
					clientName: CLIENT_NAME,
					clientVersion: CLIENT_VERSION,
					requestTimeoutMs: state.config.timeout ?? 30_000,
					callTimeoutMs: state.config.callTimeout ?? 120_000,
					onNotification: (method) => {
						if (method === "notifications/tools/list_changed") {
							void refreshTools(state, ctx).catch(() => {});
						}
					},
					onClose: (error) => {
						if (state.status === "connected") {
							state.status = "error";
							state.error = error?.message ?? "connection closed";
							updateStatusWidget(ctx);
						}
					},
				});
				await client.connect();
				const tools = await client.listTools();
				state.client = client;
				state.tools = tools;
				state.status = "connected";

				for (const tool of tools) {
					registerServerTool(pi, state, tool);
				}
			} catch (error) {
				state.status = "error";
				state.error = (error as Error).message;
				try {
					await transport?.close();
				} catch {
					// ignore
				}
				if (!quiet) {
					ctx.ui.notify(`MCP "${state.name}" failed: ${state.error}`, "error");
				}
			} finally {
				state.connecting = null;
			}
		})();
		return state.connecting;
	}

	async function createTransport(config: McpServerConfig): Promise<Transport> {
		if (config.url) {
			const authCommand = config.headersCommand;
			let headers = config.headers;
			if (authCommand) {
				headers = mergeHeaders(headers, await runHeadersCommand(authCommand));
			}
			return new HttpTransport({
				url: config.url,
				headers,
				refreshHeaders: authCommand
					? async () => mergeHeaders(config.headers, await runHeadersCommand(authCommand))
					: undefined,
			});
		}
		if (config.command) {
			return new StdioTransport({
				command: config.command,
				args: config.args,
				env: config.env,
				cwd: config.cwd,
			});
		}
		throw new Error("server config has neither command nor url");
	}

	async function disconnectServer(state: ServerState): Promise<void> {
		const client = state.client;
		state.client = null;
		if (client) {
			try {
				await client.close();
			} catch {
				// ignore
			}
		}
	}

	async function refreshTools(state: ServerState, ctx: ExtensionContext): Promise<void> {
		if (state.status !== "connected" || !state.client) return;
		const tools = await state.client.listTools();
		state.tools = tools;
		for (const tool of tools) {
			registerServerTool(pi, state, tool);
		}
		updateStatusWidget(ctx);
	}

	// --- Tool registration ---------------------------------------------------

	function registerServerTool(pi: ExtensionAPI, state: ServerState, tool: McpToolDefinition): void {
		if (!tool.name || !/^[A-Za-z0-9_-]{1,128}$/.test(tool.name)) {
			return; // Skip tools with names we cannot represent safely.
		}
		const piName = allocateToolName(state.name, tool.name);
		if (state.registered.has(piName)) return;
		state.registered.add(piName);

		const description = buildToolDescription(state, tool);
		const parameters = toParameters(tool.inputSchema);

		pi.registerTool({
			name: piName,
			label: `${state.name}: ${tool.title ?? tool.name}`,
			description,
			parameters,
			async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
				const params = (rawParams ?? {}) as Record<string, unknown>;
				return executeServerTool(state, tool, piName, params, signal, ctx);
			},
		});
	}

	function buildToolDescription(state: ServerState, tool: McpToolDefinition): string {
		const parts: string[] = [];
		if (tool.description) parts.push(tool.description.trim());
		else if (tool.title) parts.push(tool.title);
		parts.push(`(MCP tool on server "${state.name}")`);
		return parts.join(" ");
	}

	function toParameters(inputSchema: unknown) {
		if (
			typeof inputSchema === "object" &&
			inputSchema !== null &&
			!Array.isArray(inputSchema) &&
			(inputSchema as Record<string, unknown>).type === "object"
		) {
			// TypeBox is JSON Schema at heart; wrap the server's schema verbatim.
			return Type.Unsafe(inputSchema as Record<string, unknown>);
		}
		return Type.Object({});
	}

	// --- Tool execution ------------------------------------------------------

	async function executeServerTool(
		state: ServerState,
		tool: McpToolDefinition,
		piName: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		ctx: ExtensionContext,
	) {
		// Reconnect once if the connection dropped since registration.
		if (state.status !== "connected" || !state.client) {
			await connectServer(state, ctx, true);
			if (state.status !== "connected" || !state.client) {
				throw new Error(`MCP server "${state.name}" is not connected: ${state.error ?? "unknown error"}`);
			}
		}

		let result: Record<string, unknown>;
		try {
			result = await state.client.callTool(tool.name, params, signal, state.config.callTimeout);
		} catch (error) {
			if (signal?.aborted) {
				throw new Error(`MCP call to ${piName} was cancelled`);
			}
			throw error;
		}

		return mapCallResult(state, tool, result);
	}

	function mapCallResult(
		state: ServerState,
		tool: McpToolDefinition,
		result: Record<string, unknown>,
	): { content: OutputBlock[]; details: Record<string, unknown> } {
		const rawContent = Array.isArray(result.content) ? (result.content as McpContentBlock[]) : [];
		const textParts: string[] = [];
		const imageBlocks: OutputBlock[] = [];

		for (const block of rawContent) {
			if (!block || typeof block !== "object") continue;
			switch (block.type) {
				case "text": {
					if (typeof block.text === "string" && block.text.length > 0) textParts.push(block.text);
					break;
				}
				case "image": {
					if (typeof block.data === "string" && typeof block.mimeType === "string") {
						imageBlocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
					}
					break;
				}
				case "audio": {
					textParts.push(`[audio content (${block.mimeType ?? "unknown type"}) not supported]`);
					break;
				}
				case "resource": {
					const resource = block.resource ?? {};
					if (typeof resource.text === "string" && resource.text.length > 0) {
						const header = resource.uri ? `[embedded resource ${resource.uri}]` : "[embedded resource]";
						textParts.push(`${header}\n${resource.text}`);
					} else if (typeof resource.blob === "string") {
						textParts.push(
							`[embedded binary resource ${resource.uri ?? ""} (${resource.mimeType ?? "unknown type"}) omitted]`,
						);
					}
					break;
				}
			case "resource_link": {
				textParts.push(`[resource link: ${block.name ?? ""} ${block.uri ?? ""}]`.trim());
				break;
			}
				default:
					break;
			}
		}

		let text = textParts.join("\n\n");
		if (!text && result.structuredContent !== undefined) {
			try {
				text = JSON.stringify(result.structuredContent, null, 2);
			} catch {
				text = "[unserializable structured content]";
			}
		}
		if (!text && imageBlocks.length === 0) {
			text = "(empty response)";
		}

		const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
		let finalText = truncation.content;
		if (truncation.truncated) {
			const snapshot = writeTempSnapshot(state.name, tool.name, text);
			finalText += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines.`;
			if (snapshot) finalText += ` Full output saved to: ${snapshot}`;
			finalText += "]";
		}

		const content: OutputBlock[] = [];
		if (finalText) content.push({ type: "text", text: finalText });
		for (const image of imageBlocks) content.push(image);

		const details = {
			server: state.name,
			tool: tool.name,
			contentBlocks: rawContent.length,
			structured: result.structuredContent !== undefined,
		};

		if (result.isError === true) {
			// The tool itself reported failure; surface as a pi tool error.
			throw new Error(finalText || `MCP tool "${tool.name}" reported an error`);
		}

		return { content, details };
	}

	function writeTempSnapshot(server: string, tool: string, text: string): string | null {
		try {
			const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "pi-mcp-"));
			const file = path.join(dir, `${sanitizePart(server)}-${sanitizePart(tool)}.txt`);
			fsSync.writeFileSync(file, text, "utf8");
			return file;
		} catch {
			return null;
		}
	}

	// --- Status UI -----------------------------------------------------------

	function updateStatusWidget(ctx: ExtensionContext): void {
		if (states.size === 0) return;
		const connected = [...states.values()].filter((s) => s.status === "connected").length;
		const total = [...states.values()].filter((s) => s.status !== "disabled").length;
		const tools = [...states.values()].reduce((sum, s) => (s.status === "connected" ? sum + s.tools.length : sum), 0);
		ctx.ui.setStatus("mcp", `MCP ${connected}/${total} servers · ${tools} tools`);
	}

	function formatStatus(statesMap: Map<string, ServerState>): string {
		if (statesMap.size === 0) return "No MCP servers configured.\nAdd servers to ~/.pi/agent/mcp.json or .pi/mcp.json";
		const icons: Record<ServerStatus, string> = {
			connected: "●",
			connecting: "◌",
			error: "✗",
			disabled: "○",
		};
		const lines: string[] = [];
		for (const state of statesMap.values()) {
			const transport = state.config.url ? "http" : "stdio";
			const target = state.config.url ?? `${state.config.command} ${(state.config.args ?? []).join(" ")}`.trim();
			let line = `${icons[state.status]} ${state.name} [${transport}] ${state.status}`;
			if (state.status === "connected") line += ` · ${state.tools.length} tools`;
			else if (state.error) line += ` — ${state.error}`;
			line += `\n    ${target}`;
			lines.push(line);
		}
		return lines.join("\n");
	}

	// --- Lifecycle -----------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		let config;
		try {
			// Project config can spawn arbitrary processes, so only honor it in
			// trusted projects. Global config is always honored.
			const includeProject = ctx.isProjectTrusted();
			config = await loadMcpConfig(ctx.cwd, includeProject);
		} catch (error) {
			ctx.ui.notify(`MCP config error: ${(error as Error).message}`, "error");
			return;
		}
		for (const warning of config.warnings) {
			ctx.ui.notify(`MCP config: ${warning}`, "warning");
		}

		states.clear();
		for (const [name, serverConfig] of Object.entries(config.servers)) {
			states.set(name, {
				name,
				config: serverConfig,
				status: serverConfig.enabled === false ? "disabled" : "connecting",
				client: null,
				tools: [],
				registered: new Set(),
				connecting: null,
			});
		}

		const enabled = [...states.values()].filter((s) => s.config.enabled !== false);
		if (enabled.length === 0) return;

		await Promise.allSettled(enabled.map((state) => connectServer(state, ctx, false)));
		updateStatusWidget(ctx);

		const failed = enabled.filter((s) => s.status === "error");
		if (failed.length > 0 && ctx.hasUI) {
			ctx.ui.notify(
				`MCP: ${enabled.length - failed.length}/${enabled.length} servers connected (${failed.map((s) => s.name).join(", ")} failed)`,
				"warning",
			);
		}
	});

	pi.on("session_shutdown", async () => {
		await Promise.allSettled([...states.values()].map(disconnectServer));
		states.clear();
	});

	pi.registerCommand("mcp", {
		description: "Show MCP server status; subcommands: reconnect <server>, tools [server]",
		handler: async (args, ctx) => {
			const [sub, target] = args.trim().split(/\s+/, 2);

			if (!sub) {
				ctx.ui.setWidget("mcp-status", formatStatus(states).split("\n"));
				return;
			}

			if (sub === "tools") {
				const selected = target ? states.get(target) : undefined;
				const list = selected ? [selected] : [...states.values()];
				const lines: string[] = [];
				for (const state of list) {
					lines.push(`${state.name} (${state.tools.length} tools):`);
					for (const tool of state.tools) {
						lines.push(`  - ${tool.name}${tool.description ? `: ${tool.description.slice(0, 100)}` : ""}`);
					}
				}
				ctx.ui.setWidget("mcp-status", lines.length ? lines : ["No tools."]);
				return;
			}

			if (sub === "reconnect") {
				const state = target ? states.get(target) : undefined;
				if (!state) {
					ctx.ui.notify(`Unknown MCP server: ${target ?? "(none)"}. Known: ${[...states.keys()].join(", ") || "none"}`, "warning");
					return;
				}
				await disconnectServer(state);
				state.status = "connecting";
				await connectServer(state, ctx, false);
				const finalStatus = state.status as ServerStatus;
				updateStatusWidget(ctx);
				ctx.ui.notify(
					finalStatus === "connected"
						? `MCP "${state.name}" connected (${state.tools.length} tools)`
						: `MCP "${state.name}" ${finalStatus}: ${state.error ?? ""}`,
					finalStatus === "connected" ? "info" : "error",
				);
				return;
			}

			ctx.ui.notify("Usage: /mcp | /mcp reconnect <server> | /mcp tools [server]", "warning");
		},
	});
}
