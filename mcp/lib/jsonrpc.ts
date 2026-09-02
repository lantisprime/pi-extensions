// Minimal JSON-RPC 2.0 message types and helpers used by the MCP transports.

export const JSONRPC_VERSION = "2.0";

export const ErrorCodes = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
} as const;

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: unknown;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result?: unknown;
	error?: JsonRpcError;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export function isRequest(message: unknown): message is JsonRpcRequest {
	if (typeof message !== "object" || message === null) return false;
	const record = message as Record<string, unknown>;
	return record.jsonrpc === JSONRPC_VERSION && record.id !== undefined && typeof record.method === "string";
}

export function isNotification(message: unknown): message is JsonRpcNotification {
	if (typeof message !== "object" || message === null) return false;
	const record = message as Record<string, unknown>;
	return record.jsonrpc === JSONRPC_VERSION && record.id === undefined && typeof record.method === "string";
}

export function isResponse(message: unknown): message is JsonRpcResponse {
	if (typeof message !== "object" || message === null) return false;
	const record = message as Record<string, unknown>;
	return (
		record.jsonrpc === JSONRPC_VERSION && record.id !== undefined && ("result" in record || "error" in record)
	);
}

export function makeRequest(id: JsonRpcId, method: string, params?: unknown): JsonRpcRequest {
	const request: JsonRpcRequest = { jsonrpc: JSONRPC_VERSION, id, method };
	if (params !== undefined) request.params = params;
	return request;
}

export function makeNotification(method: string, params?: unknown): JsonRpcNotification {
	const notification: JsonRpcNotification = { jsonrpc: JSONRPC_VERSION, method };
	if (params !== undefined) notification.params = params;
	return notification;
}

export function makeErrorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
	const error: JsonRpcError = { code, message };
	if (data !== undefined) error.data = data;
	return { jsonrpc: JSONRPC_VERSION, id, error };
}

export function makeResultResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
	return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function formatRpcError(error: JsonRpcError): string {
	let text = `${error.message} (code ${error.code})`;
	if (error.data !== undefined && error.data !== null) {
		const data = typeof error.data === "string" ? error.data : JSON.stringify(error.data);
		if (data) text += `: ${data}`;
	}
	return text;
}
