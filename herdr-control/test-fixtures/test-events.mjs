// herdr-control: socket event subscription tests (lib/events.ts) over a REAL
// local unix socket simulating herdr's framing (newline-delimited JSON).
import assert from "node:assert/strict";
import { createServer, connect } from "node:net";
import { rmSync } from "node:fs";
import { subscribePaneEvents } from "../lib/events.ts";

const sockPath = `/tmp/herdr-events-test-${process.pid}.sock`;
rmSync(sockPath, { force: true });

// Fake herdr: accepts connections, answers subscribe, then pushes
// an agent_status_changed event; records every subscribe it receives.
const subscribes = [];
const conns = new Set();
const server = createServer((socket) => {
	conns.add(socket);
	socket.on("close", () => conns.delete(socket));
	let buf = "";
	socket.on("data", (chunk) => {
		buf += chunk.toString();
		const lines = buf.split("\n");
		buf = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const req = JSON.parse(line);
				if (req.method === "events.subscribe") {
					subscribes.push(req.params.subscriptions.map((s) => `${s.type}@${s.pane_id}`));
					socket.write(JSON.stringify({ id: req.id, result: { type: "subscription_started" } }) + "\n");
					socket.write(JSON.stringify({
						event: "pane.agent_status_changed",
						pane_id: "w1:pX",
						agent_status: "blocked",
					}) + "\n");
				}
			} catch { /* ignore */ }
		}
	});
});

await new Promise((resolve) => server.listen(sockPath, resolve));

const events = [];
let downs = 0;
const subscriber = subscribePaneEvents(
	sockPath,
	["w1:pX"],
	(event) => events.push(event),
	{ onDown: () => { downs += 1; } },
);

// wait for the first connection cycle
await new Promise((r) => setTimeout(r, 700));

assert.equal(subscribes.length >= 1, true, "subscribe request sent");
assert.deepEqual(subscribes[0], ["pane.agent_status_changed@w1:pX"]);
assert.equal(events.length, 1, "event delivered");
assert.equal(events[0].kind, "pane.agent_status_changed");
assert.equal(events[0].paneId, "w1:pX");
assert.equal(events[0].agentStatus, "blocked");
assert.equal(subscriber.isActive(), true);

// server drops the client connection → client reconnects and resubscribes
server.close(); // stop accepting new connections
for (const c of conns) c.destroy(); // drop live client sockets

// Simulate a fresh server: recreate listener on the same path so the
// subscriber's reconnect lands.
await new Promise((resolve, reject) => server.once("close", resolve));
await new Promise((resolve) => server.listen(sockPath, resolve));
await new Promise((r) => setTimeout(r, 4000)); // reconnect backoff is 2s

assert.ok(subscribes.length >= 2, `resubscribed after disconnect (${subscribes.length})`);
subscriber.close();
for (const c of conns) c.destroy();
await new Promise((r) => setTimeout(r, 100));
server.close();
rmSync(sockPath, { force: true });

console.log("test-events: all tests passed");
process.exit(0);
