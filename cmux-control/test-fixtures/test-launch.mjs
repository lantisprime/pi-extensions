// P5d-S3: cmux-control launch operation tests.
import assert from "node:assert/strict";
import { launchPane, launchWorkspace } from "../lib/launch.ts";
import { FakeCmuxExecutor } from "./fake-cmux-executor.ts";

const workspaceOpts = {
	name: "pi-cmux-one",
	cwd: "/Users/me/project",
	command: "'npm' 'test'",
};

// LaunchWorkspaceParsesRef
{
	const fake = new FakeCmuxExecutor();
	fake.enqueueResponse({ ok: true, stdout: "OK workspace:7\n" });

	const result = await launchWorkspace(fake, workspaceOpts);
	assert.deepEqual(result, { ok: true, workspaceRef: "workspace:7" });
}

// LaunchWorkspaceNoFocus
{
	const fake = new FakeCmuxExecutor();
	fake.enqueueResponse({ ok: true, stdout: "OK workspace:7\n" });

	const result = await launchWorkspace(fake, workspaceOpts);
	assert.equal(result.ok, true);
	assert.deepEqual(fake.calls[0].args, [
		"workspace", "create",
		"--name", "pi-cmux-one",
		"--cwd", "/Users/me/project",
		"--command", "'npm' 'test'",
		"--focus", "false",
	]);
}

// LaunchPaneDefaults
{
	const fake = new FakeCmuxExecutor();
	fake.enqueueResponse({ ok: true, stdout: "OK surface:9\n" });

	const result = await launchPane(fake, "workspace:7");
	assert.deepEqual(result, { ok: true, surfaceRef: "surface:9" });
	assert.deepEqual(fake.calls[0].args, [
		"new-pane",
		"--workspace", "workspace:7",
		"--type", "terminal",
		"--direction", "right",
		"--focus", "false",
	]);
}

// LaunchError
{
	const fake = new FakeCmuxExecutor();
	fake.enqueueResponse({ ok: false, stderr: "launch failed", exitCode: 1 });

	const result = await launchWorkspace(fake, workspaceOpts);
	assert.deepEqual(result, { ok: false, error: "launch failed" });

	const invalidNameFake = new FakeCmuxExecutor();
	const invalidNameResult = await launchWorkspace(invalidNameFake, { ...workspaceOpts, name: "pi-cmux bad" });
	assert.deepEqual(invalidNameResult, { ok: false, error: "invalid workspace name" });
	assert.equal(invalidNameFake.calls.length, 0);

	const wrongPrefixFake = new FakeCmuxExecutor();
	const wrongPrefixResult = await launchWorkspace(wrongPrefixFake, { ...workspaceOpts, name: "other-prefix" });
	assert.deepEqual(wrongPrefixResult, { ok: false, error: "workspace name must start with pi-cmux-" });
	assert.equal(wrongPrefixFake.calls.length, 0);
}
