import assert from "node:assert/strict";
import { parseMcpBody, manifestFingerprint, McpGatewayClient, type McpToolInfo } from "../lib/mcp-client";

function testParseMcpBodyPlainJson() {
	const result = parseMcpBody('{"jsonrpc":"2.0","result":{"tools":[]}}');
	assert.deepEqual(result, { jsonrpc: "2.0", result: { tools: [] } });
}

function testParseMcpBodySseMultiLine() {
	const sse = `event: message
data: {"jsonrpc":"2.0","id":"1"}
data: {"jsonrpc":"2.0","result":{"ok":true}}

event: done
data: {"jsonrpc":"2.0","result":{"done":true}}`;
	const result = parseMcpBody(sse);
	// Should take the LAST data: line
	assert.deepEqual(result, { jsonrpc: "2.0", result: { done: true } });
}

function testParseMcpBodyEmpty() {
	const result = parseMcpBody("");
	assert.equal(result, null);
}

function testParseMcpBodyWhitespace() {
	const result = parseMcpBody("   \n\t  ");
	assert.equal(result, null);
}

function testParseMcpBodyMalformedThrows() {
	assert.throws(() => parseMcpBody("not valid json {"), /invalid MCP response body/);
}

function testManifestFingerprintStableUnderReordering() {
	const tools: McpToolInfo[] = [
		{ name: "zebra", description: "animal z" },
		{ name: "alpha", description: "animal a" },
		{ name: "beta", description: "animal b" },
	];

	const fp1 = manifestFingerprint(tools);
	const fp2 = manifestFingerprint([...tools].reverse());
	assert.equal(fp1, fp2, "fingerprint should be stable regardless of input order");
}

function testManifestFingerprintStableUnderKeyReorder() {
	// Test stable stringify: same tools but inputSchema keys in different order
	const tools1: McpToolInfo[] = [
		{ name: "tool", description: "desc", inputSchema: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } } },
	];
	const tools2: McpToolInfo[] = [
		{ name: "tool", description: "desc", inputSchema: { type: "object", properties: { b: { type: "number" }, a: { type: "string" } } } },
	];

	const fp1 = manifestFingerprint(tools1);
	const fp2 = manifestFingerprint(tools2);
	assert.equal(fp1, fp2, "fingerprint should be stable under inputSchema key reordering");
}

function testManifestFingerprintChangesOnDescriptionChange() {
	const tools1: McpToolInfo[] = [{ name: "tool", description: "desc v1" }];
	const tools2: McpToolInfo[] = [{ name: "tool", description: "desc v2" }];

	const fp1 = manifestFingerprint(tools1);
	const fp2 = manifestFingerprint(tools2);
	assert.notEqual(fp1, fp2, "fingerprint should change when description changes");
}

function testMcpGatewayClientConstructorThrowsOnHttpUrl() {
	assert.throws(
		() =>
			new McpGatewayClient({
				gatewayUrl: "http://example.com/mcp",
				server: "test",
				apiKey: "key",
			}),
		/gateway URL must be https/,
	);
}

async function testMcpGatewayClientHappyPath() {
	const headers: Array<Record<string, string>> = [];
	const requestBodies: string[] = [];
	let callCount = 0;

	const fetchImpl = async (url: string, init?: RequestInit) => {
		const body = init?.body as string;
		requestBodies.push(body);
		const reqHeaders: Record<string, string> = {};
		if (init?.headers) {
			for (const [k, v] of Object.entries(init.headers)) {
				reqHeaders[k] = v as string;
			}
		}
		headers.push(reqHeaders);
		callCount++;

		// First call: initialize (should have id)
		if (callCount === 1) {
			assert.ok(reqHeaders.Authorization === "Bearer test-key", "Authorization header should be present");
			assert.ok(!reqHeaders["mcp-session-id"], "No session ID on initialize request");
			// Verify initialize request HAS id field
			const rpc = JSON.parse(body);
			assert.ok(rpc.id, "initialize request should have id");
			return new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: "1",
					result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "test-server" } },
				}),
				{ status: 200, headers: { "mcp-session-id": "session-123" } },
			);
		}

		// Second call: initialized notification - should have no id (true notification)
		if (callCount === 2) {
			assert.ok(reqHeaders["mcp-session-id"] === "session-123", "Session ID should be echoed on initialized notification");
			// Verify notification has NO id field
			const rpc = JSON.parse(body);
			assert.ok(!rpc.id, "notifications/initialized should have NO id (true notification)");
			assert.equal(rpc.method, "notifications/initialized", "Method should be notifications/initialized");
			// Return 202 with empty body - should be tolerated
			return new Response("", { status: 202 });
		}

		// Third call: tools/list (session ID expected)
		if (callCount === 3) {
			assert.ok(reqHeaders["mcp-session-id"] === "session-123", "Session ID should be echoed on tools/list");
			return new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: "3",
					result: { tools: [{ name: "echo", description: "echoes input" }] },
				}),
				{ status: 200 },
			);
		}

		// Fourth call: tools/call (session ID expected)
		if (callCount === 4) {
			assert.ok(reqHeaders["mcp-session-id"] === "session-123", "Session ID should be echoed on tools/call");
			return new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: "4",
					result: { content: [{ type: "text", text: "hello" }] },
				}),
				{ status: 200 },
			);
		}

		throw new Error(`unexpected call: ${callCount}`);
	};

	const client = new McpGatewayClient({
		gatewayUrl: "https://gateway.example.com",
		server: "server1",
		apiKey: "test-key",
		fetchImpl,
	});

	const initResult = await client.initialize();
	assert.ok(initResult.serverInfo);
	assert.equal(callCount, 2, "initialize should make 2 calls: initialize + initialized notification");

	const tools = await client.listTools();
	assert.equal(tools.length, 1);
	assert.equal(tools[0].name, "echo");
	assert.equal(callCount, 3, "listTools should make 1 more call");

	const callResult = await client.callTool("echo", { message: "hello" });
	assert.deepEqual(callResult.content, [{ type: "text", text: "hello" }]);
	assert.equal(callCount, 4, "callTool should make 1 more call");
}

async function testMcpGatewayClientNotificationEmptyBodyTolerated() {
	let callCount = 0;

	const fetchImpl = async (_url: string, init?: RequestInit) => {
		callCount++;
		if (callCount === 1) {
			// Initialize response
			return new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: "1",
					result: { protocolVersion: "2025-03-26", capabilities: {} },
				}),
				{ status: 200, headers: { "mcp-session-id": "session-123" } },
			);
		}
		if (callCount === 2) {
			// Notification returns empty body - should be tolerated
			return new Response("", { status: 200 });
		}
		// Third call: tools/list
		return new Response(JSON.stringify({ jsonrpc: "2.0", id: "3", result: { tools: [] } }), { status: 200 });
	};

	const client = new McpGatewayClient({
		gatewayUrl: "https://gateway.example.com",
		server: "server1",
		apiKey: "test-key",
		fetchImpl,
	});

	// Should not throw on empty notification response
	const tools = await client.listTools();
	assert.equal(tools.length, 0, "Should return empty tools list");
}

async function testMcpGatewayClientJsonRpcErrorThrows() {
	const fetchImpl = async (_url: string, _init?: RequestInit) => {
		return new Response(
			JSON.stringify({
				jsonrpc: "2.0",
				id: "1",
				error: { code: -32601, message: "Method not found" },
			}),
			{ status: 200 },
		);
	};

	const client = new McpGatewayClient({
		gatewayUrl: "https://gateway.example.com",
		server: "server1",
		apiKey: "test-key",
		fetchImpl,
	});

	await assert.rejects(client.initialize(), /MCP error -32601: Method not found/);
}

async function testMcpGatewayClient3xxThrows() {
	const fetchImpl = async (_url: string, _init?: RequestInit) => {
		return new Response("", { status: 302, headers: { location: "https://elsewhere.com" } });
	};

	const client = new McpGatewayClient({
		gatewayUrl: "https://gateway.example.com",
		server: "server1",
		apiKey: "test-key",
		fetchImpl,
	});

	await assert.rejects(client.initialize(), /unexpected redirect from gateway/);
}

async function testMcpGatewayClientOversizedBodyThrows() {
	const largeBody = "x".repeat(2_000_001);
	const fetchImpl = async (_url: string, _init?: RequestInit) => {
		return new Response(largeBody, { status: 200 });
	};

	const client = new McpGatewayClient({
		gatewayUrl: "https://gateway.example.com",
		server: "server1",
		apiKey: "test-key",
		fetchImpl,
	});

	await assert.rejects(client.initialize(), /response too large/);
}

async function testMcpGatewayClientNotificationRedirectThrows() {
	// Amendment 13: any 3xx on notifications/initialized must reject
	// initialize() — redirect tolerance is NEVER permitted for notifications.
	let callCount = 0;

	const fetchImpl = async (_url: string, _init?: RequestInit) => {
		callCount++;
		if (callCount === 1) {
			// Initialize response (id + session)
			return new Response(
				JSON.stringify({ jsonrpc: "2.0", id: "1", result: { protocolVersion: "2025-03-26" } }),
				{ status: 200, headers: { "mcp-session-id": "session-123" } },
			);
		}
		if (callCount === 2) {
			// Notification receives a 302 redirect -> initialize() must reject
			return new Response("", { status: 302, headers: { location: "https://elsewhere.example.com" } });
		}
		throw new Error(`unexpected call: ${callCount}`);
	};

	const client = new McpGatewayClient({
		gatewayUrl: "https://gateway.example.com",
		server: "server1",
		apiKey: "test-key",
		fetchImpl,
	});

	await assert.rejects(client.initialize(), /unexpected redirect from gateway/);
}

async function main() {
	testParseMcpBodyPlainJson();
	testParseMcpBodySseMultiLine();
	testParseMcpBodyEmpty();
	testParseMcpBodyWhitespace();
	testParseMcpBodyMalformedThrows();
	testManifestFingerprintStableUnderReordering();
	testManifestFingerprintStableUnderKeyReorder();
	testManifestFingerprintChangesOnDescriptionChange();
	testMcpGatewayClientConstructorThrowsOnHttpUrl();

	await testMcpGatewayClientHappyPath();
	await testMcpGatewayClientNotificationEmptyBodyTolerated();
	await testMcpGatewayClientJsonRpcErrorThrows();
	await testMcpGatewayClient3xxThrows();
	await testMcpGatewayClientOversizedBodyThrows();
	await testMcpGatewayClientNotificationRedirectThrows();

	console.log("mcp-client tests passed");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
