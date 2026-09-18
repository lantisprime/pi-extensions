// End-to-end test: StdioTransport + McpClient against test-mcp-server.mjs.
// Run: node test/run-client-test.mjs

import assert from "node:assert";
import { McpClient } from "../lib/client.ts";
import { StdioTransport } from "../lib/stdio.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "test-mcp-server.mjs");

const results = [];
function check(name, fn) {
	results.push({ name, fn });
}

const transport = new StdioTransport({ command: process.execPath, args: [serverPath] });
const client = new McpClient(transport, {
	clientName: "pi-mcp-test",
	clientVersion: "0.0.1",
	requestTimeoutMs: 10_000,
	callTimeoutMs: 15_000,
});

check("initialize handshake", async () => {
	await client.connect();
	assert.equal(client.isInitialized, true);
	assert.equal(client.serverInfo.name, "test-server");
	assert.ok(client.protocolVersion);
	console.log(`  protocol=${client.protocolVersion} server=${client.serverInfo.name} v${client.serverInfo.version}`);
});

check("tools/list returns 5 tools", async () => {
	const tools = await client.listTools();
	assert.equal(tools.length, 5);
	assert.deepEqual(
		tools.map((t) => t.name).sort(),
		["add", "echo", "fail", "png", "slow"],
	);
	assert.equal(tools.find((t) => t.name === "echo").inputSchema.type, "object");
});

check("tools/call echo", async () => {
	const result = await client.callTool("echo", { text: "hello pi" });
	assert.equal(result.isError ?? false, false);
	assert.equal(result.content[0].text, "echo: hello pi");
});

check("tools/call add with structuredContent", async () => {
	const result = await client.callTool("add", { a: 2, b: 40 });
	assert.equal(result.content[0].text, "2 + 40 = 42");
	assert.equal(result.structuredContent.sum, 42);
});

check("tools/call fail sets isError", async () => {
	const result = await client.callTool("fail", {});
	assert.equal(result.isError, true);
	assert.equal(result.content[0].text, "intentional failure");
});

check("tools/call png returns image content", async () => {
	const result = await client.callTool("png", {});
	assert.equal(result.content[0].type, "image");
	assert.equal(result.content[0].mimeType, "image/png");
	assert.ok(result.content[0].data.length > 50);
});

check("unknown tool yields JSON-RPC error", async () => {
	await assert.rejects(() => client.callTool("nonexistent", {}), /Unknown tool/);
});

check("cancellation aborts slow call", async () => {
	const controller = new AbortController();
	const started = Date.now();
	const promise = client.callTool("slow", {}, controller.signal, 30_000);
	setTimeout(() => controller.abort(), 300);
	await assert.rejects(promise, /cancelled/);
	const elapsed = Date.now() - started;
	assert.ok(elapsed < 2000, `expected fast cancel, took ${elapsed}ms`);
});

check("ping round-trip", async () => {
	await client.ping();
});

let failed = 0;
for (const { name, fn } of results) {
	try {
		await fn();
		console.log(`✓ ${name}`);
	} catch (error) {
		failed++;
		console.log(`✗ ${name}\n  ${error.message}`);
	}
}

await client.close();
console.log(failed === 0 ? "\nAll tests passed" : `\n${failed} test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
