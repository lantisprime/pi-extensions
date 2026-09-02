// headersCommand + HTTP 401-refresh tests. Run: node test/run-headers-test.mjs

import assert from "node:assert";
import http from "node:http";
import { mergeHeaders, runHeadersCommand } from "../lib/headers.ts";
import { HttpTransport } from "../lib/http.ts";
import { McpClient } from "../lib/client.ts";

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

// --- runHeadersCommand -----------------------------------------------------

await check("runHeadersCommand parses JSON stdout", async () => {
	const h = await runHeadersCommand(`printf '{"Authorization":"Bearer tok-1"}'`);
	assert.equal(h.Authorization, "Bearer tok-1");
});

await check("runHeadersCommand rejects invalid JSON", async () => {
	await assert.rejects(() => runHeadersCommand("echo not-json"), /not valid JSON/);
});

await check("runHeadersCommand rejects non-string values", async () => {
	await assert.rejects(() => runHeadersCommand(`printf '{"a":1}'`), /string values/);
});

await check("runHeadersCommand surfaces command failure with stderr tail", async () => {
	await assert.rejects(
		() => runHeadersCommand("echo mint failed >&2; exit 3"),
		/headersCommand failed: mint failed/,
	);
});

await check("mergeHeaders: fresh values win over base", () => {
	assert.deepEqual(mergeHeaders({ A: "1", B: "2" }, { B: "3", C: "4" }), { A: "1", B: "3", C: "4" });
});

// --- 401 refresh flow over a live HTTP server -------------------------------

const state = { token: "tok-1", refreshes: 0 };
const server = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => (raw += chunk));
	req.on("end", () => {
		const message = JSON.parse(raw);
		if (req.headers.authorization !== `Bearer ${state.token}`) {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "unauthorized" }));
			return;
		}
		const reply = (result) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		};
		switch (message.method) {
			case "initialize":
				reply({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "auth-server", version: "1" } });
				break;
			case "notifications/initialized":
				res.writeHead(202);
				res.end();
				break;
			case "tools/list":
				reply({ tools: [{ name: "echo", description: "echo", inputSchema: { type: "object" } }] });
				break;
			case "tools/call":
				reply({ content: [{ type: "text", text: "ok" }] });
				break;
			default:
				res.writeHead(400);
				res.end();
		}
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/mcp`;

const transport = new HttpTransport({
	url,
	refreshHeaders: async () => {
		state.refreshes++;
		return { Authorization: `Bearer ${state.token}` };
	},
});
const client = new McpClient(transport, {
	clientName: "headers-test",
	clientVersion: "0.0.1",
	requestTimeoutMs: 3000,
	callTimeoutMs: 3000,
});

await check("initialize 401 refreshes once, then connects", async () => {
	await client.connect();
	assert.equal(client.serverInfo.name, "auth-server");
	assert.equal(state.refreshes, 1);
});

await check("subsequent calls reuse refreshed headers (no extra refresh)", async () => {
	const tools = await client.listTools();
	assert.equal(tools.length, 1);
	assert.equal(state.refreshes, 1);
});

await check("mid-session 401 re-mints and retries transparently", async () => {
	state.token = "tok-2"; // simulate token expiry server-side
	const result = await client.callTool("echo", {});
	assert.equal(result.content[0].text, "ok");
	assert.equal(state.refreshes, 2);
});

await check("401 without refreshHeaders surfaces as error", async () => {
	const plain = new HttpTransport({ url, headers: { Authorization: "Bearer wrong" } });
	const plainClient = new McpClient(plain, {
		clientName: "headers-test",
		clientVersion: "0.0.1",
		requestTimeoutMs: 3000,
	});
	await assert.rejects(() => plainClient.connect(), /401/);
	await plainClient.close();
});

await client.close();
server.close();

console.log(failed === 0 ? "\nAll headers tests passed" : `\n${failed} test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
