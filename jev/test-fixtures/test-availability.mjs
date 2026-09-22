// Tests: Jev availability gating.
//
// Requirement: if Jev is not available, do not use it — fall back to the default
// behaviour (no jev tool, no jev_ask in a child's allowlist).
//
// Hermetic: JEV_STATUS_PATH points at a temp file so the real status is untouched.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	jevStatusPath,
	JEV_STATUS_PATH_ENV,
	JEV_STATUS_TTL_MS,
	readJevAvailabilitySync,
} from "../../jev/lib/availability.ts";
import {
	buildChildRunOptions,
	jevIsAvailableSync,
	JEV_EXTENSION_PATH_ENV,
	resolveExplicitJevExtensionPath,
} from "../../agents/lib/run-resolver.ts";
import { buildChildPiArgs, JEV_TOOL_NAME } from "../../agents/lib/child-args.ts";
import { getBuiltInAgentSpec } from "../../agents/lib/specs.ts";
import { JEV_STANDING_RULE_TEXT, standingRuleAppend } from "../../jev/lib/standing-rule.ts";

const spec = getBuiltInAgentSpec("scout");
assert.ok(spec, "scout spec must exist");

const tmp = mkdtempSync(path.join(os.tmpdir(), "jev-status-"));
const statusPath = path.join(tmp, "jev-status.json");
const prevStatusPath = process.env[JEV_STATUS_PATH_ENV];
const prevJevPath = process.env[JEV_EXTENSION_PATH_ENV];
process.env[JEV_STATUS_PATH_ENV] = statusPath;
delete process.env[JEV_EXTENSION_PATH_ENV];

function writeStatus(body, { ageMs = 0 } = {}) {
	const payload =
		typeof body === "string" ? body : JSON.stringify({ ...body, checkedAt: Date.now() - ageMs });
	writeFileSync(statusPath, payload);
}

function toolsOf(argv) {
	const i = argv.indexOf("--tools");
	return i >= 0 ? (argv[i + 1] ?? "") : "";
}

try {
	assert.equal(jevStatusPath(), statusPath, "env override must drive the status path");

	// 1. No status file at all -> unavailable (the default no-Jev behaviour).
	const cleared = path.join(tmp, "absent.json");
	process.env[JEV_STATUS_PATH_ENV] = cleared;
	let r = readJevAvailabilitySync();
	assert.equal(r.available, false);
	assert.equal(r.reason, "no-status", "missing status must read as no-status");
	assert.equal(jevIsAvailableSync(), false);
	assert.equal(resolveExplicitJevExtensionPath(), undefined, "no status -> no jev for children");
	process.env[JEV_STATUS_PATH_ENV] = statusPath;

	// 2. Fresh, positive probe -> available.
	writeStatus({ ok: true, endpoint: "https://example.invalid" });
	r = readJevAvailabilitySync();
	assert.equal(r.available, true);
	assert.equal(r.reason, "fresh");
	assert.equal(jevIsAvailableSync(), true);
	assert.ok(resolveExplicitJevExtensionPath(), "available -> jev path resolved");

	// 3. Fresh, negative probe -> unavailable.
	writeStatus({ ok: false, endpoint: "https://example.invalid", detail: "HTTP 403" });
	r = readJevAvailabilitySync();
	assert.equal(r.available, false);
	assert.equal(r.reason, "fresh", "a fresh negative is still a decision, not a fallback");
	assert.equal(jevIsAvailableSync(), false);

	// 4. Stale positive -> unavailable (do not trust an old success).
	writeStatus({ ok: true, endpoint: "https://example.invalid" }, { ageMs: JEV_STATUS_TTL_MS + 1000 });
	r = readJevAvailabilitySync();
	assert.equal(r.available, false);
	assert.equal(r.reason, "stale");

	// 5. Unreadable / malformed -> unavailable.
	for (const bad of ["not json at all", JSON.stringify({ ok: true }), JSON.stringify({ checkedAt: "soon", ok: true })]) {
		writeStatus(bad);
		r = readJevAvailabilitySync();
		assert.equal(r.available, false, `malformed status ${bad} must be unavailable`);
		assert.equal(jevIsAvailableSync(), false);
	}

	// 6. Negative status -> child argv carries neither -e jev nor jev_ask.
	writeStatus({ ok: false, endpoint: "https://example.invalid", detail: "HTTP 403" });
	process.env[JEV_EXTENSION_PATH_ENV] = "/trusted/jev/index.ts";
	let inv = buildChildPiArgs(spec, "task", {
		...buildChildRunOptions({ cwd: "/tmp/project" }),
		systemPromptPath: "/tmp/sp.txt",
	});
	assert.equal(inv.argv.includes("/trusted/jev/index.ts"), false, "unavailable -> no -e jev");
	assert.equal(toolsOf(inv.argv).includes(JEV_TOOL_NAME), false, "unavailable -> no jev_ask");

	// 7. Positive status -> child argv carries both.
	writeStatus({ ok: true, endpoint: "https://example.invalid" });
	inv = buildChildPiArgs(spec, "task", {
		...buildChildRunOptions({ cwd: "/tmp/project" }),
		systemPromptPath: "/tmp/sp.txt",
	});
	assert.ok(inv.argv.includes("/trusted/jev/index.ts"), "available -> -e jev present");
	assert.ok(toolsOf(inv.argv).split(",").includes(JEV_TOOL_NAME), "available -> jev_ask present");

	// 8. Explicit disable still wins even when Jev is available.
	for (const v of ["off", "0", "false", "none", "OFF"]) {
		process.env[JEV_EXTENSION_PATH_ENV] = v;
		assert.equal(
			resolveExplicitJevExtensionPath(),
			undefined,
			`explicit '${v}' must disable jev even when available`,
		);
	}

	// 9. Standing rule follows availability exactly (the chain-of-thought hook).
	assert.ok(JEV_STANDING_RULE_TEXT.length < 300, `rule too long: ${JEV_STANDING_RULE_TEXT.length}`);
	assert.match(JEV_STANDING_RULE_TEXT, /jev_ask/, "rule must name the tool");
	writeStatus({ ok: true, endpoint: "https://example.invalid" });
	assert.equal(
		standingRuleAppend(readJevAvailabilitySync()),
		JEV_STANDING_RULE_TEXT,
		"available -> standing rule is appended",
	);
	writeStatus({ ok: false, endpoint: "https://example.invalid", detail: "HTTP 503" });
	assert.equal(
		standingRuleAppend(readJevAvailabilitySync()),
		undefined,
		"fresh negative -> no rule (never advertise a dead tool)",
	);
	process.env[JEV_STATUS_PATH_ENV] = path.join(tmp, "absent-again.json");
	assert.equal(standingRuleAppend(readJevAvailabilitySync()), undefined, "no status -> no rule");
	process.env[JEV_STATUS_PATH_ENV] = statusPath;

	console.log("test-availability: all assertions passed");
} finally {
	if (prevStatusPath === undefined) delete process.env[JEV_STATUS_PATH_ENV];
	else process.env[JEV_STATUS_PATH_ENV] = prevStatusPath;
	if (prevJevPath === undefined) delete process.env[JEV_EXTENSION_PATH_ENV];
	else process.env[JEV_EXTENSION_PATH_ENV] = prevJevPath;
}
