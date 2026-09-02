// Streamable HTTP transport for MCP (protocol 2025-03-26 and later).
//
// Every JSON-RPC message is POSTed to the server URL. Responses come back as
// either a single application/json body or a text/event-stream whose `data:`
// payloads are JSON-RPC messages (progress notifications may precede the final
// response for the posted request).

import { SessionExpiredError } from "./errors";
import { mergeHeaders } from "./headers";
import type { Transport } from "./stdio";

export interface HttpTransportOptions {
	url: string;
	headers?: Record<string, string>;
	/**
	 * Produces fresh headers, merged over `headers` and used for the rest of
	 * the session. Invoked once automatically after a 401 response (retry).
	 */
	refreshHeaders?: () => Promise<Record<string, string>>;
	/** Milliseconds for the underlying fetch; 0 disables. Default 30000. */
	fetchTimeoutMs?: number;
}

const DEFAULT_FETCH_TIMEOUT = 30_000;
const SESSION_HEADER = "mcp-session-id";
const PROTOCOL_VERSION = "2025-06-18";

export class HttpTransport implements Transport {
	private options: HttpTransportOptions;
	private messageHandler: ((message: unknown) => void) | null = null;
	private errorHandler: ((error: Error) => void) | null = null;
	private closeHandler: ((error?: Error) => void) | null = null;
	private sessionId: string | null = null;
	private protocolVersion: string | null = null;
	private started = false;
	private closed = false;
	/** Static headers from config; the base for every refresh. */
	private staticHeaders: Record<string, string>;
	/** Headers actually sent (static + freshest minted auth headers). */
	private authHeaders: Record<string, string>;

	constructor(options: HttpTransportOptions) {
		this.options = options;
		this.staticHeaders = options.headers ?? {};
		this.authHeaders = { ...this.staticHeaders };
	}

	describe(): string {
		return `http: ${this.options.url}`;
	}

	onMessage(handler: (message: unknown) => void): void {
		this.messageHandler = handler;
	}

	onError(handler: (error: Error) => void): void {
		this.errorHandler = handler;
	}

	onClose(handler: (error?: Error) => void): void {
		this.closeHandler = handler;
	}

	async start(): Promise<void> {
		this.started = true;
	}

	/** Record negotiated protocol version after a successful initialize. */
	setProtocolVersion(version: string | null): void {
		this.protocolVersion = version;
	}

	/** Clear session state so the next request starts a fresh session. */
	resetSession(): void {
		this.sessionId = null;
		this.protocolVersion = null;
	}

	async send(message: unknown): Promise<void> {
		if (!this.started) await this.start();
		if (this.closed) throw new Error("HTTP transport is closed");
		return this.doSend(message, true);
	}

	private async doSend(message: unknown, allowAuthRetry: boolean): Promise<void> {
		const hasId =
			typeof message === "object" && message !== null && "id" in (message as Record<string, unknown>);
		const body = JSON.stringify(message);
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...this.authHeaders,
		};
		if (this.sessionId) headers[SESSION_HEADER] = this.sessionId;
		if (this.protocolVersion) headers["MCP-Protocol-Version"] = this.protocolVersion;

		const controller = new AbortController();
		const timeoutMs = this.options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT;
		const timer =
			timeoutMs > 0
				? setTimeout(() => controller.abort(new Error("HTTP request timed out")), timeoutMs)
				: null;

		let response: Response;
		try {
			response = await fetch(this.options.url, {
				method: "POST",
				headers,
				body,
				signal: controller.signal,
			});
		} catch (error) {
			if (timer) clearTimeout(timer);
			throw new Error(`MCP HTTP request failed: ${(error as Error).message}`);
		}

		// Track session id from any response that carries it.
		const sessionHeader = response.headers.get(SESSION_HEADER);
		if (sessionHeader) this.sessionId = sessionHeader;

		if (response.status === 404 && this.sessionId) {
			if (timer) clearTimeout(timer);
			this.resetSession();
			throw new SessionExpiredError("MCP HTTP session expired (404); re-initialization required");
		}

		if (response.status === 401) {
			if (timer) clearTimeout(timer);
			if (this.options.refreshHeaders && allowAuthRetry) {
				// Minted token likely expired: refresh once and retry the same
				// message on a clean request (session id may be stale too).
				const fresh = await this.options.refreshHeaders();
				this.authHeaders = mergeHeaders(this.staticHeaders, fresh);
				this.resetSession();
				return this.doSend(message, false);
			}
			const text = await safeReadText(response);
			throw new Error(`MCP HTTP error 401 ${response.statusText}${text ? `: ${text}` : ""}`);
		}

		if (!response.ok) {
			if (timer) clearTimeout(timer);
			const text = await safeReadText(response);
			throw new Error(`MCP HTTP error ${response.status} ${response.statusText}${text ? `: ${text}` : ""}`);
		}

		// Notifications and responses are answered with 202 and no body.
		if (!hasId) {
			if (timer) clearTimeout(timer);
			return;
		}

		const contentType = (response.headers.get("Content-Type") ?? "").split(";")[0].trim();
		try {
			if (contentType === "text/event-stream") {
				await this.consumeSseResponse(response, controller, (parsed) => {
					const id = (parsed as { id?: unknown })?.id;
					return hasId && id === (message as { id: unknown }).id;
				});
			} else {
				const text = await response.text();
				if (text.trim()) {
					this.dispatchText(text);
				}
			}
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		// Best-effort DELETE of the session per the Streamable HTTP spec.
		if (this.sessionId) {
			const headers: Record<string, string> = { ...this.authHeaders };
			headers[SESSION_HEADER] = this.sessionId;
			if (this.protocolVersion) headers["MCP-Protocol-Version"] = this.protocolVersion;
			try {
				await fetch(this.options.url, { method: "DELETE", headers });
			} catch {
				// Ignore; session will expire server-side.
			}
		}
		this.closeHandler?.();
	}

	/**
	 * Read an SSE stream, dispatching every message. Resolves once a message
	 * matching `isTerminal` arrives or the stream ends.
	 */
	private async consumeSseResponse(
		response: Response,
		controller: AbortController,
		isTerminal: (message: unknown) => boolean,
	): Promise<void> {
		const body = response.body;
		if (!body) return;
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let done = false;
		try {
			while (!done) {
				const read = await reader.read();
				if (read.done) break;
				buffer += decoder.decode(read.value, { stream: true });
				let boundary: number;
				while ((boundary = buffer.indexOf("\n\n")) !== -1) {
					const block = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					const data = parseSseBlock(block);
					if (data === null) continue;
					const parsed = this.dispatchText(data);
					if (parsed !== undefined && isTerminal(parsed)) {
						done = true;
						break;
					}
				}
			}
		} catch (error) {
			if (!done) {
				this.errorHandler?.(new Error(`SSE stream error: ${(error as Error).message}`));
			}
		} finally {
			// The response for this request has been delivered; stop reading.
			try {
				await reader.cancel();
			} catch {
				// Already closed.
			}
			controller.abort();
		}
	}

	private dispatchText(text: string): unknown {
		const trimmed = text.trim();
		if (!trimmed) return undefined;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			this.errorHandler?.(new Error("Invalid JSON payload from MCP HTTP server"));
			return undefined;
		}
		// Some servers wrap batches in an array.
		if (Array.isArray(parsed)) {
			for (const item of parsed) this.messageHandler?.(item);
			return undefined;
		}
		this.messageHandler?.(parsed);
		return parsed;
	}
}

function parseSseBlock(block: string): string | null {
	const dataLines: string[] = [];
	for (const rawLine of block.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
	}
	if (dataLines.length === 0) return null;
	return dataLines.join("\n");
}

async function safeReadText(response: Response): Promise<string> {
	try {
		const text = await response.text();
		return text.slice(0, 500);
	} catch {
		return "";
	}
}
