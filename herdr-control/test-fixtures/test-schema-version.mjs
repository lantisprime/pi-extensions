// herdr-control: schema + version tests (lib/schema.ts, lib/version.ts).
// The schema module is the single source of truth for herdr data structures;
// these tests pin the validator and the version gate behavior.
import assert from "node:assert/strict";
import { createFakeHerdr, okResult, errResult } from "./fake-herdr.ts";
import {
	validateSchema,
	schemaParse,
	S,
	HerdrEnvelopeSchema,
	AgentListResultSchema,
	PaneSplitResultSchema,
	PaneLayoutResultSchema,
	HerdrStatusSchema,
} from "../lib/schema.ts";
import {
	parseVersion,
	compareVersions,
	probeVersion,
	checkVersionCompatibility,
	resetVersionCache,
	MIN_SUPPORTED_LABEL,
} from "../lib/version.ts";

// validator: accepts valid shapes
{
	const good = { id: "cli:x", result: { anything: true } };
	assert.equal(validateSchema(HerdrEnvelopeSchema, good).ok, true);
	assert.equal(validateSchema(HerdrEnvelopeSchema, { id: "cli:x" }).ok, false, "missing result");
	assert.equal(validateSchema(HerdrEnvelopeSchema, { result: {} }).ok, false, "missing id");
}

// validator: agents list (optional fields, type checks, extra fields allowed)
{
	const parsed = schemaParse(AgentListResultSchema, {
		agents: [{ agent: "pi", agent_status: "unknown", pane_id: "wH:pV", future_field: 42 }, true],
	});
	assert.equal(parsed.ok, false, "bad row rejected");
	assert.match(parsed.ok ? "" : parsed.error, /agents\[1\]/);

	// extra/unknown fields on valid rows are allowed (herdr adds fields freely)
	const extra = schemaParse(AgentListResultSchema, { agents: [{ agent: "pi", future_field: 42 }] });
	assert.equal(extra.ok, true);

	const parsed2 = schemaParse(AgentListResultSchema, { agents: [] });
	assert.equal(parsed2.ok, true, "empty list ok");
}

// validator: pane split + layout
{
	assert.equal(schemaParse(PaneSplitResultSchema, { pane: { pane_id: "w2:pV" } }).ok, true);
	const bad = schemaParse(PaneSplitResultSchema, { pane: { pane_id: 7 } });
	assert.equal(bad.ok, false);
	const layout = schemaParse(PaneLayoutResultSchema, {
		layout: { panes: [{ pane_id: "w9:p1", focused: true, rect: { width: 157, height: 56 } }] },
	});
	assert.equal(layout.ok, true);
}

// validator: status (all optional, wrong types still rejected)
{
	assert.equal(schemaParse(HerdrStatusSchema, { client: { version: "0.9.3", protocol: 22 }, server: { version: "0.9.3", running: true } }).ok, true);
	assert.equal(schemaParse(HerdrStatusSchema, { client: { version: 9 } }).ok, false);
}

// validator: S.any matches anything; enum enforced
{
	assert.equal(validateSchema(S.any, { deep: ["x"] }).ok, true);
	const e = S.string({ enum: ["a", "b"] });
	assert.equal(validateSchema(e, "a").ok, true);
	assert.equal(validateSchema(e, "c").ok, false);
}

// version parsing + comparison
{
	assert.deepEqual(parseVersion("0.9.3"), { major: 0, minor: 9, patch: 3 });
	assert.deepEqual(parseVersion("v1.2.0-rc1"), { major: 1, minor: 2, patch: 0 });
	assert.equal(parseVersion("garbage"), null);
	assert.equal(compareVersions({ major: 0, minor: 9, patch: 3 }, { major: 0, minor: 9, patch: 0 }), 3);
	assert.equal(compareVersions({ major: 0, minor: 8, patch: 9 }, { major: 0, minor: 9, patch: 0 }) < 0, true);
}

// probeVersion: raw JSON (no envelope) parses; result cached
{
	resetVersionCache();
	const fake = createFakeHerdr();
	const statusJson = JSON.stringify({
		client: { version: "0.9.3", channel: "stable", protocol: 22 },
		server: { status: "running", running: true, version: "0.9.3", protocol: 22, compatible: true },
	});
	fake.onSubcommand("status", () => okResult(statusJson));
	const info = await probeVersion(fake.executor);
	assert.equal(info?.serverVersion, "0.9.3");
	assert.equal(info?.serverRunning, true);
	assert.equal(fake.callsTo("status").length, 1, "cached probe not repeated");
	const again = await probeVersion(fake.executor);
	assert.equal(fake.callsTo("status").length, 1, "cache hit");
	assert.equal(again?.serverVersion, "0.9.3");
	resetVersionCache();
}

// probeVersion: envelope-wrapped status also accepted
{
	resetVersionCache();
	const fake = createFakeHerdr();
	const wrapped = JSON.stringify({
		id: "cli:status",
		result: { client: { version: "0.9.3" }, server: { version: "0.9.3", running: true } },
	});
	fake.onSubcommand("status", () => okResult(wrapped));
	const info = await probeVersion(fake.executor);
	assert.equal(info?.serverVersion, "0.9.3");
	resetVersionCache();
}

// checkVersionCompatibility: old server fails closed with update hint
{
	resetVersionCache();
	const fake = createFakeHerdr();
	fake.onSubcommand("status", () => okResult(JSON.stringify({
		client: { version: "0.8.4" },
		server: { status: "running", running: true, version: "0.8.4" },
	})));
	const verdict = await checkVersionCompatibility(fake.executor);
	assert.equal(verdict.compatible, false);
	if (!verdict.compatible) assert.match(verdict.error, new RegExp(MIN_SUPPORTED_LABEL));
	resetVersionCache();
}

// checkVersionCompatibility: unknown/unparseable warns but proceeds
{
	resetVersionCache();
	const fake = createFakeHerdr();
	fake.onSubcommand("status", () => errResult("socket gone", 1));
	const verdict = await checkVersionCompatibility(fake.executor);
	assert.equal(verdict.compatible, true, "probe failure must not brick the gate");
	if (verdict.compatible) assert.match(verdict.warning, /unknown/);
	resetVersionCache();
}

// checkVersionCompatibility: current server passes clean
{
	resetVersionCache();
	const fake = createFakeHerdr();
	fake.onSubcommand("status", () => okResult(JSON.stringify({
		client: { version: "0.9.3" },
		server: { status: "running", running: true, version: "0.9.3", compatible: true },
	})));
	const verdict = await checkVersionCompatibility(fake.executor);
	assert.equal(verdict.compatible, true);
	assert.equal("warning" in verdict, false, "no warning for current version");
	resetVersionCache();
}

console.log("test-schema-version: all tests passed");
