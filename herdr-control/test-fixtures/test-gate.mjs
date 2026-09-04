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
assert.equal(fake.calls.length, 1, "probed server once");

const second = await ensureServer(fake.executor);
assert.equal(second.ok, true);
assert.equal(fake.calls.length, 1, "positive result cached (no second probe)");

resetGateCache();
fake.onSubcommand("status", () => errResult("connection refused", 1));
const failing = await ensureServer(fake.executor);
assert.equal(failing.ok, false);
assert.match(failing.error, /herdr/);

const cachedFail = await ensureServer(fake.executor);
assert.equal(cachedFail.ok, false);
assert.equal(fake.callsTo("status").length, 2, "negative result cached briefly (no immediate reprobe)");

// restore
if (HERDR_ENV_ORIGINAL === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = HERDR_ENV_ORIGINAL;
resetGateCache();
console.log("test-gate: all tests passed");
