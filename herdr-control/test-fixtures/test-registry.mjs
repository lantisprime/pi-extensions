// herdr-control: registry event-sourcing tests.
import assert from "node:assert/strict";
import {
	SpawnRegistry,
	makeSpawnEvent,
	makeCloseEvent,
	isRegistryEvent,
} from "../lib/registry.ts";

const REC = (name, paneId, extra = {}) => ({
	name, paneId, kind: "pi", cwd: "/tmp/x", createdAt: 1, ...extra,
});

// spawn then close
{
	const reg = new SpawnRegistry();
	reg.spawn(REC("a", "w1:p2"));
	assert.equal(reg.get("a").paneId, "w1:p2");
	const closed = reg.close("a");
	assert.equal(closed.paneId, "w1:p2");
	assert.equal(reg.get("a"), undefined);
	assert.equal(reg.close("a"), null, "double close is a no-op");
}

// getByPane
{
	const reg = new SpawnRegistry();
	reg.spawn(REC("a", "w1:p2"));
	reg.spawn(REC("b", "w1:p3"));
	assert.equal(reg.getByPane("w1:p3").name, "b");
	assert.equal(reg.getByPane("w9:p9"), undefined);
}

// close event only removes matching pane (respawn under same name survives)
{
	const reg = new SpawnRegistry();
	reg.spawn(REC("a", "w1:p2"));
	reg.apply(makeCloseEvent("a", "w9:p9")); // stale close for an old pane
	assert.equal(reg.get("a").paneId, "w1:p2", "stale close must not evict a respawned record");
	reg.apply(makeCloseEvent("a", "w1:p2"));
	assert.equal(reg.get("a"), undefined);
}

// hydrate replays events in order
{
	const reg = new SpawnRegistry();
	const summary = reg.hydrate([
		makeSpawnEvent(REC("a", "w1:p2")),
		makeCloseEvent("a", "w1:p2"),
		makeSpawnEvent(REC("a", "w1:p7")),
		makeSpawnEvent(REC("b", "w2:p1")),
		{ garbage: true },
		null,
	]);
	assert.equal(summary.applied, 4);
	assert.equal(summary.skipped, 2);
	assert.equal(reg.get("a").paneId, "w1:p7");
	assert.equal(reg.list().length, 2);
}

// prune drops records whose pane is gone, returns them for persistence
{
	const reg = new SpawnRegistry();
	reg.spawn(REC("a", "w1:p2"));
	reg.spawn(REC("b", "w1:p3", { orphan: true }));
	const pruned = reg.prune(new Set(["w1:p3"]));
	assert.deepEqual(pruned.map((r) => r.name), ["a"]);
	assert.equal(reg.get("a"), undefined);
	assert.equal(reg.get("b").paneId, "w1:p3", "live pane kept even if orphaned");
}

// shape guards
assert.equal(isRegistryEvent(makeSpawnEvent(REC("a", "w1:p2"))), true);
assert.equal(isRegistryEvent(makeCloseEvent("a", "w1:p2")), true);
assert.equal(isRegistryEvent({ op: "spawn", record: { name: "a" } }), false, "incomplete record rejected");
assert.equal(isRegistryEvent({ op: "purge" }), false);
assert.equal(isRegistryEvent("spawn"), false);

console.log("test-registry: all tests passed");
