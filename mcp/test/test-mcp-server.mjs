// Minimal MCP server over stdio for testing the pi MCP bridge.
// Tools: echo (text), add (structured args), fail (isError result),
//        png (returns a tiny image), slow (delays, for cancellation).

import readline from "node:readline";

const PROTOCOL_VERSION = "2025-06-18";

const TOOLS = [
	{
		name: "echo",
		description: "Echo back the input text",
		inputSchema: {
			type: "object",
			properties: { text: { type: "string", description: "Text to echo" } },
			required: ["text"],
		},
	},
	{
		name: "add",
		description: "Add two numbers",
		inputSchema: {
			type: "object",
			properties: { a: { type: "number" }, b: { type: "number" } },
			required: ["a", "b"],
		},
	},
	{
		name: "fail",
		description: "Always returns a tool error",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "png",
		description: "Returns a 1x1 red PNG",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "slow",
		description: "Waits 5 seconds then returns",
		inputSchema: { type: "object", properties: {} },
	},
];

// 1x1 red PNG
const PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function respond(id, result) {
	writeLine(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function respondError(id, code, message) {
	writeLine(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
}

function writeLine(line) {
	process.stdout.write(line + "\n");
}

async function handleRequest(message) {
	const { id, method, params } = message;
	switch (method) {
		case "initialize":
			respond(id, {
				protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "test-server", version: "1.0.0" },
			});
			break;
		case "tools/list":
			respond(id, { tools: TOOLS });
			break;
		case "tools/call": {
			const name = params?.name;
			const args = params?.arguments ?? {};
			if (name === "echo") {
				respond(id, { content: [{ type: "text", text: `echo: ${args.text}` }] });
			} else if (name === "add") {
				respond(id, {
					content: [{ type: "text", text: `${args.a} + ${args.b} = ${args.a + args.b}` }],
					structuredContent: { sum: args.a + args.b },
				});
			} else if (name === "fail") {
				respond(id, { content: [{ type: "text", text: "intentional failure" }], isError: true });
			} else if (name === "png") {
				respond(id, { content: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }] });
			} else if (name === "slow") {
				await new Promise((resolve) => setTimeout(resolve, 5000));
				if (!process.stdout.writableEnded) respond(id, { content: [{ type: "text", text: "finally done" }] });
			} else {
				respondError(id, -32602, `Unknown tool: ${name}`);
			}
			break;
		}
		case "ping":
			respond(id, {});
			break;
		default:
			respondError(id, -32601, `Method not found: ${method}`);
	}
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
	const trimmed = line.trim();
	if (!trimmed) return;
	let message;
	try {
		message = JSON.parse(trimmed);
	} catch {
		return;
	}
	if (message.id === undefined) return; // notification: ignore
	handleRequest(message).catch((error) => respondError(message.id, -32603, error.message));
});

process.on("SIGTERM", () => process.exit(0));
