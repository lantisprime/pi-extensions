// Minimal MCP client speaking JSON-RPC 2.0 over a Transport.
//
// Implements the parts of the MCP spec pi needs:
// - initialize handshake + initialized notification
// - tools/list (with cursor pagination)
// - tools/call
// - server -> client `ping` requests
// - notifications/tools/list_changed forwarding

import { SessionExpiredError } from "./errors";
import {
	ErrorCodes,
	formatRpcError,
	isNotification,
	isRequest,
	isResponse,
	makeErrorResponse,
	makeNotification,
	makeRequest,
	makeResultResponse,
	type JsonRpcId,
	type JsonRpcMessage,
} from "./jsonrpc";
import type { Transport } from "./stdio";

export const LATEST_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export interface McpToolDefinition {
	name: string;
	title?: string;
	description?: string;
	inputSchema?: unknown;
	outputSchema?: unknown;
}

export interface McpServerInfo {
	name?: string;
	version?: string;
}

export interface McpClientOptions {
	clientName: string;
	clientVersion: string;
	/** Timeout for initialize/tools-list requests. Default 30000. */
	requestTimeoutMs?: number;
	/** Timeout for tools/call. Default 120000. Set 0 to disable. */
	callTimeoutMs?: number;
	/** Called for server-initiated notifications (e.g. tools/list_changed). */
	onNotification?: (method: string, params: unknown) => void;
	/** Called when the transport closes unexpectedly. */
	onClose?: (error?: Error) => void;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout> | null;
	onSettled?: () => void;
}

export class McpClient {
	private transport: Transport;
	private options: Required<Pick<McpClientOptions, "clientName" | "clientVersion" | "requestTimeoutMs" | "callTimeoutMs">> &
		McpClientOptions;
	private nextId = 1;
	private pending = new Map<JsonRpcId, PendingRequest>();
	private initialized = false;
	private closing = false;
	protocolVersion: string | null = null;
	serverInfo: McpServerInfo = {};
	serverCapabilities: Record<string, unknown> = {};

	constructor(transport: Transport, options: McpClientOptions) {
		this.transport = transport;
		this.options = {
			requestTimeoutMs: 30_000,
			callTimeoutMs: 120_000,
			...options,
		};
		transport.onMessage((message) => this.handleMessage(message));
		transport.onClose((error) => {
			this.failPending(new Error(error ? error.message : "MCP connection closed"));
			if (!this.closing) this.options.onClose?.(error);
		});
		transport.onError((error) => {
			this.options.onNotification?.("__transport_error", error.message);
		});
	}

	get isInitialized(): boolean {
		return this.initialized;
	}

	/** Start the transport and perform the initialize handshake. */
	async connect(): Promise<void> {
		await this.transport.start();
		const timeoutMs = this.options.requestTimeoutMs;
		let result: Record<string, unknown>;
		try {
			result = (await this.request(
				"initialize",
				{
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: {
						// No client capabilities: no sampling, roots, or experimental features.
					},
					clientInfo: { name: this.options.clientName, version: this.options.clientVersion },
				},
				{ timeoutMs },
			)) as Record<string, unknown>;
		} catch (error) {
			// One retry if the server expired a reused HTTP session between runs.
			if (error instanceof SessionExpiredError) {
				result = (await this.request("initialize", {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: this.options.clientName, version: this.options.clientVersion },
				}, { timeoutMs })) as Record<string, unknown>;
			} else {
				throw error;
			}
		}

		const requestedVersion = typeof result.protocolVersion === "string" ? result.protocolVersion : "";
		if (!SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)) {
			// Per spec the client may disconnect on mismatch; pi only needs
			// tools/*, which is stable across these versions, so we proceed.
			this.protocolVersion = LATEST_PROTOCOL_VERSION;
		} else {
			this.protocolVersion = requestedVersion;
		}
		this.transport.setProtocolVersion?.(this.protocolVersion);
		this.serverInfo = (result.serverInfo as McpServerInfo) ?? {};
		this.serverCapabilities = (result.capabilities as Record<string, unknown>) ?? {};

		await this.transport.send(makeNotification("notifications/initialized"));
		this.initialized = true;
	}

	/** List all tools, following cursor pagination. */
	async listTools(signal?: AbortSignal): Promise<McpToolDefinition[]> {
		const tools: McpToolDefinition[] = [];
		let cursor: string | undefined;
		let pages = 0;
		do {
			const params: Record<string, unknown> = {};
			if (cursor !== undefined) params.cursor = cursor;
			const result = (await this.requestWithSessionRetry("tools/list", params, {
				timeoutMs: this.options.requestTimeoutMs,
				signal,
			})) as { tools?: McpToolDefinition[]; nextCursor?: string };
			tools.push(...(result.tools ?? []));
			cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
			pages += 1;
		} while (cursor !== undefined && pages < 100);
		return tools;
	}

	/** Call a tool. Returns the raw CallToolResult. */
	async callTool(
		name: string,
		toolArguments: Record<string, unknown> | undefined,
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<Record<string, unknown>> {
		return (await this.requestWithSessionRetry(
			"tools/call",
			{ name, arguments: toolArguments ?? {} },
			{ timeoutMs: timeoutMs ?? this.options.callTimeoutMs, signal },
		)) as Record<string, unknown>;
	}

	async ping(signal?: AbortSignal): Promise<void> {
		await this.requestWithSessionRetry("ping", {}, { timeoutMs: Math.min(this.options.requestTimeoutMs, 10_000), signal });
	}

	/** Send a cancellation notification for a previously issued request id. */
	cancelRequest(requestId: JsonRpcId, reason: string): void {
		void this.transport
			.send(makeNotification("notifications/cancelled", { requestId, reason }))
			.catch(() => {
				// Best effort; connection may already be gone.
			});
	}

	async close(): Promise<void> {
		this.closing = true;
		this.initialized = false;
		this.failPending(new Error("MCP client closed"));
		try {
			await this.transport.close();
		} catch {
			// Ignore transport close failures.
		}
	}

	private async requestWithSessionRetry(
		method: string,
		params: unknown,
		options: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<unknown> {
		try {
			return await this.request(method, params, options);
		} catch (error) {
			if (error instanceof SessionExpiredError && this.initialized) {
				// Re-run the handshake, then retry the request exactly once.
				this.initialized = false;
				const result = (await this.request("initialize", {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: this.options.clientName, version: this.options.clientVersion },
				}, { timeoutMs: this.options.requestTimeoutMs, signal: options.signal })) as Record<string, unknown>;
				this.protocolVersion =
					typeof result.protocolVersion === "string" ? result.protocolVersion : LATEST_PROTOCOL_VERSION;
				this.transport.setProtocolVersion?.(this.protocolVersion);
				this.serverInfo = (result.serverInfo as McpServerInfo) ?? {};
				this.serverCapabilities = (result.capabilities as Record<string, unknown>) ?? {};
				await this.transport.send(makeNotification("notifications/initialized"));
				this.initialized = true;
				return await this.request(method, params, options);
			}
			throw error;
		}
	}

	private request(
		method: string,
		params: unknown,
		options: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<unknown> {
		const id = this.nextId++;
		const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs;
		return new Promise<unknown>((resolve, reject) => {
			const pending: PendingRequest = { resolve, reject, timer: null };
			const finish = (settlement: { ok: true; value?: unknown } | { ok: false; error: Error }) => {
				if (!this.pending.has(id)) return;
				this.pending.delete(id);
				if (pending.timer) clearTimeout(pending.timer);
				if (options.signal) options.signal.removeEventListener("abort", onAbort);
				if (settlement.ok) pending.resolve(settlement.value);
				else pending.reject(settlement.error);
			};
			pending.onSettled = () => {
				if (options.signal) options.signal.removeEventListener("abort", onAbort);
			};

			if (timeoutMs > 0) {
				pending.timer = setTimeout(() => {
					finish({ ok: false, error: new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`) });
				}, timeoutMs);
			}
			this.pending.set(id, pending);

			const onAbort = () => {
				finish({ ok: false, error: new Error(`MCP request "${method}" cancelled`) });
				this.cancelRequest(id, "Cancelled by user");
			};
			if (options.signal) {
				if (options.signal.aborted) {
					onAbort();
					return;
				}
				options.signal.addEventListener("abort", onAbort, { once: true });
			}

			this.transport.send(makeRequest(id, method, params)).catch((error) => {
				finish({
					ok: false,
					error: error instanceof SessionExpiredError ? error : new Error(error.message),
				});
			});
		});
	}

	private handleMessage(message: unknown): void {
		if (isResponse(message)) {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (pending.timer) clearTimeout(pending.timer);
			pending.onSettled?.();
			if (message.error) {
				pending.reject(new Error(formatRpcError(message.error)));
			} else {
				pending.resolve(message.result);
			}
			return;
		}

		if (isRequest(message)) {
			// Server -> client requests. We only answer pings; everything else
			// (sampling, roots, elicitation) is declined.
			if (message.method === "ping") {
				void this.transport.send(makeResultResponse(message.id, {})).catch(() => {});
			} else {
				void this.transport
					.send(
						makeErrorResponse(
							message.id,
							ErrorCodes.METHOD_NOT_FOUND,
							`pi MCP bridge does not support "${message.method}"`,
						),
					)
					.catch(() => {});
			}
			return;
		}

		if (isNotification(message)) {
			this.options.onNotification?.(message.method, message.params);
		}
	}

	private failPending(error: Error): void {
		for (const [, pending] of this.pending) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.onSettled?.();
			pending.reject(error);
		}
		this.pending.clear();
	}
}

export type { JsonRpcMessage };
