// End-to-end test for HttpTransport + McpClient (Streamable HTTP).
// Run: node --import tsx test/run-http-test.mjs  (starts its own server)

import assert from "node:assert";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient } from "../lib/client.ts";
import { HttpTransport } from "../lib/http.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8199;
const URL_BASE = `http://127.0.0.1:${PORT}/mcp`;

async function waitForServer(child) {
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("server start timeout")), 5000);
		child.stdout.on("data", (chunk) => {
			if (chunk.toString().includes(`on ${PORT}`)) {
				clearTimeout(timer);
				resolve();
			}
		});
	});
}

const server = spawn(process.execPath, [path.join(here, "test-mcp-server-http.mjs")], {
	env: { ...process.env, TEST_PORT: String(PORT) },
});
await waitForServer(server);

const transport = new HttpTransport({ url: URL_BASE });
const client = new McpClient(transport, {
	clientName: "pi-mcp-test",
	clientVersion: "0.0.1",
	requestTimeoutMs: 5000,
	callTimeoutMs: 5000,
});

let failed = 0;
async function check(name, fn) {
	try {
		await fn();
		console.log(`✓ ${name}`);
	} catch (error) {
		failed++;
		console.log(`✗ ${name}\n  ${error.message}`);
	}
}

await check("initialize handshake over HTTP", async () => {
	await client.connect();
	assert.equal(client.serverInfo.name, "test-http-server");
});

await check("tools/list over HTTP", async () => {
	const tools = await client.listTools();
	assert.equal(tools.length, 1);
	assert.equal(tools[0].name, "shout");
});

await check("tools/call over HTTP", async () => {
	const result = await client.callTool("shout", { text: "hello" });
	assert.equal(result.content[0].text, "SHOUT: HELLO");
});

await check("session is reused across requests", async () => {
	// Multiple sequential calls without re-initializing proves the header flows.
	const a = await client.callTool("shout", { text: "a" });
	const b = await client.callTool("shout", { text: "b" });
	assert.equal(a.content[0].text, "SHOUT: A");
	assert.equal(b.content[0].text, "SHOUT: B");
});

await client.close();
server.kill();

console.log(failed === 0 ? "\nAll HTTP tests passed" : `\n${failed} test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
