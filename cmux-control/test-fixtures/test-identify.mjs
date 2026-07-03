// P5d-S1: macOS cmux 0.64.17+ identify tests.
import assert from "node:assert/strict";
import { identify } from "../lib/identify.ts";
import { FakeCmuxExecutor } from "./fake-cmux-executor.ts";

async function withEnv(env, fn) {
	const previousWorkspace = process.env.CMUX_WORKSPACE_ID;
	const previousSurface = process.env.CMUX_SURFACE_ID;
	if ("CMUX_WORKSPACE_ID" in env) process.env.CMUX_WORKSPACE_ID = env.CMUX_WORKSPACE_ID;
	else delete process.env.CMUX_WORKSPACE_ID;
	if ("CMUX_SURFACE_ID" in env) process.env.CMUX_SURFACE_ID = env.CMUX_SURFACE_ID;
	else delete process.env.CMUX_SURFACE_ID;
	try {
		return await fn();
	} finally {
		if (previousWorkspace === undefined) delete process.env.CMUX_WORKSPACE_ID;
		else process.env.CMUX_WORKSPACE_ID = previousWorkspace;
		if (previousSurface === undefined) delete process.env.CMUX_SURFACE_ID;
		else process.env.CMUX_SURFACE_ID = previousSurface;
	}
}

// IdentifyParsesJson: fake returns valid JSON, assert all fields parsed.
{
	const fake = new FakeCmuxExecutor();
	fake.enqueueResponse({
		ok: true,
		stdout: JSON.stringify({
			workspaceId: "w1",
			surfaceId: "s1",
			workspaceRef: "workspace:1",
			surfaceRef: "surface:1",
		}),
	});
	const identity = await identify(fake);
	assert.deepEqual(identity, {
		workspaceId: "w1",
		surfaceId: "s1",
		workspaceRef: "workspace:1",
		surfaceRef: "surface:1",
	});
	assert.deepEqual(fake.calls[0].args, ["identify", "--json"]);
}

// IdentifyCLIFailureFallsBackToEnv: CLI fails, CMUX_WORKSPACE_ID + CMUX_SURFACE_ID set, assert env values used.
{
	const fake = new FakeCmuxExecutor();
	fake.enqueueResponse({ ok: false, stderr: "cmux unavailable", exitCode: 1 });
	const identity = await withEnv({ CMUX_WORKSPACE_ID: "env-workspace", CMUX_SURFACE_ID: "env-surface" }, () => identify(fake));
	assert.deepEqual(identity, {
		workspaceId: "env-workspace",
		surfaceId: "env-surface",
		workspaceRef: null,
		surfaceRef: null,
	});
}

// IdentifyBothFailReturnsNull: both CLI and env fail, assert all fields null.
{
	const fake = new FakeCmuxExecutor();
	fake.enqueueResponse({ ok: false, stderr: "cmux unavailable", exitCode: 1 });
	const identity = await withEnv({}, () => identify(fake));
	assert.deepEqual(identity, {
		workspaceId: null,
		surfaceId: null,
		workspaceRef: null,
		surfaceRef: null,
	});
}
