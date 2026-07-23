import crypto from "node:crypto";

export type McpToolInfo = { name: string; description: string; inputSchema?: unknown };
export type McpContent = { type: string; text?: string };
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 2_000_000;

export function parseMcpBody(raw: string): unknown {
	const trimmed = raw.trim();
	if (!trimmed) return null;

	// Check for SSE format (look for data: lines)
	const lines = raw.split("\n");
	let lastDataLine: string | null = null;
	for (const line of lines) {
		const trimmedLine = line.trim();
		if (trimmedLine.startsWith("data:")) {
			const data = trimmedLine.slice(5).trim();
			if (data) lastDataLine = data;
		}
	}

	// If we found SSE data lines, use the last one
	if (lastDataLine) {
		try {
			return JSON.parse(lastDataLine);
		} catch {
			throw new Error("invalid MCP response body");
		}
	}

	// Try parsing as plain JSON
	try {
		return JSON.parse(trimmed);
	} catch {
		throw new Error("invalid MCP response body");
	}
}

// Stable stringify: recursively sort object keys for deterministic JSON
function stableStringify(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
	if (typeof value === "object") {
		const keys = Object.keys(value as Record<string, unknown>).sort();
		const pairs = keys.map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k]));
		return "{" + pairs.join(",") + "}";
	}
	return "null";
}

export function manifestFingerprint(tools: McpToolInfo[]): string {
	const normalized = [...tools].sort((a, b) => a.name.localeCompare(b.name)).map((tool) => [
		tool.name,
		tool.description ?? "",
		stableStringify(tool.inputSchema ?? null),
	]);
	return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export class McpGatewayClient {
	private readonly gatewayUrl: string;
	private readonly server: string;
	private readonly apiKey: string;
	private readonly fetchImpl: FetchLike;
	private readonly timeoutMs: number;
	private readonly baseUrl: string;
	private sessionId: string | null = null;
	private initialized = false;

	constructor(opts: { gatewayUrl: string; server: string; apiKey: string; fetchImpl?: FetchLike; timeoutMs?: number }) {
		const parsedUrl = new URL(opts.gatewayUrl);
		if (parsedUrl.protocol !== "https:") {
			throw new Error("gateway URL must be https");
		}
		this.gatewayUrl = opts.gatewayUrl;
		this.server = opts.server;
		this.apiKey = opts.apiKey;
		this.fetchImpl = opts.fetchImpl ?? fetch;
		this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
		this.baseUrl = `${parsedUrl.origin}/mcp/${opts.server}`;
	}

	async initialize(): Promise<{ serverInfo?: unknown }> {
		const response = await this.doRequest("initialize", {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "pi-mcp-gateway", version: "0.1" },
		});

		this.sessionId = response.headers.get("mcp-session-id");
		this.initialized = true;

		// Send notifications/initialized as a TRUE JSON-RPC notification (no id field)
		await this.doNotification("notifications/initialized", {});

		const result = response.data as { serverInfo?: unknown } | null;
		return { serverInfo: result?.serverInfo };
	}

	async listTools(): Promise<McpToolInfo[]> {
		if (!this.initialized) {
			await this.initialize();
		}

		const response = await this.doRequest("tools/list", {});
		const result = response.data as { tools?: McpToolInfo[] } | null;
		return result?.tools ?? [];
	}

	async callTool(name: string, args: unknown): Promise<{ content: McpContent[]; isError?: boolean }> {
		if (!this.initialized) {
			await this.initialize();
		}

		const response = await this.doRequest("tools/call", { name, arguments: args });
		const result = response.data as { content?: McpContent[]; isError?: boolean } | null;
		return {
			content: result?.content ?? [],
			isError: result?.isError,
		};
	}

	private async doNotification(method: string, params: unknown): Promise<void> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

		// TRUE notification: method name only, NO id field
		const rpc = {
			jsonrpc: "2.0",
			method,
			params,
		};

		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.apiKey}`,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};

		if (this.sessionId) {
			headers["mcp-session-id"] = this.sessionId;
		}

		let response: Response;
		try {
			response = await this.fetchImpl(this.baseUrl, {
				method: "POST",
				headers,
				body: JSON.stringify(rpc),
				signal: controller.signal,
				redirect: "manual",
			});
		} finally {
			clearTimeout(timeout);
		}

		// Absolute transport rule: ANY 3xx -> throw (never tolerate).
		if (response.status >= 300 && response.status < 400) {
			throw new Error("unexpected redirect from gateway");
		}
		// HTTP >= 400 -> throw (never swallow).
		if (response.status >= 400) {
			throw new Error(`gateway HTTP ${response.status}`);
		}
		// Tolerate any 2xx regardless of body (and body-parse failures).
		if (response.status >= 200 && response.status < 300) {
			try {
				const text = await response.text();
				if (text.length > MAX_RESPONSE_BYTES) {
					throw new Error(`response too large: ${text.length} bytes`);
				}
			} catch {
				// body read/parse failure on a 2xx is tolerated for notifications
			}
			return;
		}
	}

	private async doRequest(method: string, params: unknown): Promise<{ headers: Headers; data: unknown }> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

		const rpc = {
			jsonrpc: "2.0",
			id: crypto.randomUUID(),
			method,
			params,
		};

		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.apiKey}`,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};

		if (this.sessionId) {
			headers["mcp-session-id"] = this.sessionId;
		}

		try {
			const response = await this.fetchImpl(this.baseUrl, {
				method: "POST",
				headers,
				body: JSON.stringify(rpc),
				signal: controller.signal,
				redirect: "manual",
			});

			// Handle redirects
			if (response.status >= 300 && response.status < 400) {
				throw new Error("unexpected redirect from gateway");
			}

			// Handle HTTP errors
			if (response.status >= 400) {
				throw new Error(`gateway HTTP ${response.status}`);
			}

			// Read and check response size
			const text = await response.text();
			if (text.length > MAX_RESPONSE_BYTES) {
				throw new Error(`response too large: ${text.length} bytes`);
			}

			// Parse JSON-RPC response with null-guards
			const parsed = parseMcpBody(text) as Record<string, unknown> | null;
			if (!parsed) {
				throw new Error("invalid MCP response body");
			}

			// Check for error field with null-guard
			const error = parsed.error as { code: number; message: string } | undefined;
			if (error) {
				throw new Error(`MCP error ${error.code}: ${error.message}`);
			}

			// Get result field with null-guard
			const result = parsed.result as unknown;

			return { headers: response.headers, data: result };
		} finally {
			clearTimeout(timeout);
		}
	}
}
