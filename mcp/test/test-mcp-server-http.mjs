// Minimal MCP server over Streamable HTTP for testing the pi MCP bridge.
// Endpoints: POST /mcp (JSON-RPC), supports sessions via mcp-session-id.
// Sending an unknown session id gets a 404 (session expired).

import http from "node:http";

const PROTOCOL_VERSION = "2025-06-18";
const PORT = Number(process.env.TEST_PORT || 8123);
const validSessions = new Set();

const TOOLS = [
	{
		name: "shout",
		description: "Uppercase the input",
		inputSchema: {
			type: "object",
			properties: { text: { type: "string" } },
			required: ["text"],
		},
	},
];

function send(res, status, body, headers = {}) {
	const payload = body === null ? "" : JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json", ...headers });
	res.end(payload);
}

const server = http.createServer((req, res) => {
	if (req.method !== "POST" || req.url !== "/mcp") {
		send(res, 404, { error: "not found" });
		return;
	}

	let raw = "";
	req.on("data", (chunk) => (raw += chunk));
	req.on("end", () => {
		let message;
		try {
			message = JSON.parse(raw);
		} catch {
			send(res, 400, { error: "bad json" });
			return;
		}

		const sessionHeader = req.headers["mcp-session-id"];
		const method = message.method || "";

		// initialize creates a session; everything else requires a valid one.
		if (method === "initialize") {
			const sessionId = `sess-${Math.random().toString(36).slice(2, 10)}`;
			validSessions.add(sessionId);
			send(
				res,
				200,
				{
					jsonrpc: "2.0",
					id: message.id,
					result: {
						protocolVersion: message.params?.protocolVersion ?? PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: "test-http-server", version: "1.0.0" },
					},
				},
				{ "mcp-session-id": sessionId },
			);
			return;
		}

		// Notifications/responses (no id) get 202.
		if (message.id === undefined) {
			if (sessionHeader && !validSessions.has(sessionHeader)) {
				send(res, 404, null);
				return;
			}
			res.writeHead(202);
			res.end();
			return;
		}

		if (!sessionHeader || !validSessions.has(sessionHeader)) {
			send(res, 404, null);
			return;
		}

		if (method === "tools/list") {
			send(res, 200, { jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
		} else if (method === "tools/call") {
			send(res, 200, {
				jsonrpc: "2.0",
				id: message.id,
				result: { content: [{ type: "text", text: `SHOUT: ${(message.params?.arguments?.text ?? "").toUpperCase()}` }] },
			});
		} else if (method === "ping") {
			send(res, 200, { jsonrpc: "2.0", id: message.id, result: {} });
		} else {
			send(res, 200, {
				jsonrpc: "2.0",
				id: message.id,
				error: { code: -32601, message: `Method not found: ${method}` },
			});
		}
	});
});

server.listen(PORT, () => console.log(`test http server on ${PORT}`));
