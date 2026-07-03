// P5d-S1: macOS cmux 0.64.17+ Unix socket client tests.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createCmuxSocketClient } from "../lib/socket.ts";

function socketPath(name) {
	return path.join(os.tmpdir(), `cmux-control-${process.pid}-${name}.sock`);
}

async function startUnixServer(name, onConnection) {
	const file = socketPath(name);
	fs.rmSync(file, { force: true });
	const sockets = new Set();
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		onConnection(socket);
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(file, () => {
			server.off("error", reject);
			resolve();
		});
	});
	return { file, server, sockets };
}

async function closeUnixServer(handle) {
	for (const socket of handle.sockets) socket.destroy();
	await new Promise((resolve, reject) => {
		handle.server.close((err) => err ? reject(err) : resolve());
	});
	fs.rmSync(handle.file, { force: true });
}

function respondToJsonLine(socket, buildResponse) {
	socket.setEncoding("utf8");
	let buffer = "";
	socket.on("data", (chunk) => {
		buffer += chunk;
		for (;;) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) break;
			const raw = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);
			if (!raw) continue;
			const request = JSON.parse(raw);
			socket.write(JSON.stringify(buildResponse(request)) + "\n");
		}
	});
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// connect sends request and receives response.
{
	let received = null;
	const handle = await startUnixServer("connect", (socket) => {
		respondToJsonLine(socket, (request) => {
			received = request;
			return { id: request.id, ok: true, saw: request.command };
		});
	});
	const client = createCmuxSocketClient(handle.file);

	const response = await client.send({ id: "connect-1", command: "identify" });

	assert.deepEqual(received, { id: "connect-1", command: "identify" });
	assert.deepEqual(response, { id: "connect-1", ok: true, saw: "identify" });
	client.close();
	await closeUnixServer(handle);
}

// reconnect after server close.
{
	const first = await startUnixServer("reconnect", (socket) => {
		respondToJsonLine(socket, (request) => ({ id: request.id, phase: "first" }));
	});
	const client = createCmuxSocketClient(first.file);

	assert.deepEqual(await client.send({ id: "reconnect-1" }), { id: "reconnect-1", phase: "first" });
	await closeUnixServer(first);
	await delay(25);

	const second = await startUnixServer("reconnect", (socket) => {
		respondToJsonLine(socket, (request) => ({ id: request.id, phase: "second" }));
	});
	assert.deepEqual(await client.send({ id: "reconnect-2" }), { id: "reconnect-2", phase: "second" });

	client.close();
	await closeUnixServer(second);
}

// timeout on unresponsive socket.
{
	const handle = await startUnixServer("timeout", (socket) => {
		socket.resume();
	});
	const client = createCmuxSocketClient(handle.file);

	await assert.rejects(
		client.send({ id: "timeout-1" }),
		/cmux socket request timed out after 5000ms/,
	);

	client.close();
	await closeUnixServer(handle);
}
