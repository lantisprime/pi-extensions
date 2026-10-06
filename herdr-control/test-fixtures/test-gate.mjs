// herdr-control: gate tests (env check + cached server probe).
import assert from "node:assert/strict";
import { ensureServer, checkInsideHerdr, resetGateCache } from "../lib/gate.ts";
import { createFakeHerdr, okResult, errResult, okEnvelope } from "./fake-herdr.ts";
import { HERDR_ENV_ORIGINAL } from "./env.ts";

// gate requires HERDR_ENV (explicitly clear it: the runner itself may run
// inside a herdr pane where HERDR_ENV=1)
process.env.HERDR_ENV = "";
resetGateCache();
const outside = await ensureServer(createFakeHerdr().executor);
assert.equal(outside.ok, false, "refuses when not inside herdr");
assert.match(outside.error, /HERDR_ENV/);
assert.equal(checkInsideHerdr().ok, false);

process.env.HERDR_ENV = "1";
resetGateCache();
const fake = createFakeHerdr();
fake.onSubcommand("status", () => okResult(okEnvelope({ ok: true })));

const first = await ensureServer(fake.executor);
assert.equal(first.ok, true);
// First gate pass probes twice: `status client` (reachability) +
// `status --json` (version compatibility). Both cached afterwards.
assert.equal(fake.calls.length, 2, "probed server twice (client + version) on first gate");

const second = await ensureServer(fake.executor);
assert.equal(second.ok, true);
assert.equal(fake.calls.length, 2, "positive result cached (no second probe)");

resetGateCache();
fake.onSubcommand("status", () => errResult("connection refused", 1));
const failing = await ensureServer(fake.executor);
assert.equal(failing.ok, false);
assert.match(failing.error, /herdr/);

const cachedFail = await ensureServer(fake.executor);
assert.equal(cachedFail.ok, false);
assert.equal(fake.callsTo("status").length, 3, "negative result cached briefly (no immediate reprobe; version probe skipped on unreachable server)");

// gate: version-incompatible server fails closed end-to-end (update hint)
{
	resetGateCache();
	const oldFake = createFakeHerdr();
	oldFake.onSubcommand("status", (args) =>
		args.includes("--json")
			? okResult(JSON.stringify({ client: { version: "0.8.4" }, server: { status: "running", running: true, version: "0.8.4" } }))
			: okResult(okEnvelope({ ok: true })),
	);
	const verdict = await ensureServer(oldFake.executor);
	assert.equal(verdict.ok, false, "0.8.x server must fail the gate");
	assert.match(verdict.ok ? "" : verdict.error, /herdr update/);
	// Regression (review BLOCKER): the immediate second call must NOT pass via
	// the cached-ok path — compatibility is decided before the ok stamp.
	const repeat = await ensureServer(oldFake.executor);
	assert.equal(repeat.ok, false, "incompatible server must stay failed (no poisoned ok cache)");
	resetGateCache();
}

// restore
if (HERDR_ENV_ORIGINAL === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = HERDR_ENV_ORIGINAL;
resetGateCache();
console.log("test-gate: all tests passed");
