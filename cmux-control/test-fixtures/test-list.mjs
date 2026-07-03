// P5d-S3: cmux-control list operation tests.
import assert from "node:assert/strict";
import { listPanes, listWorkspaces } from "../lib/list.ts";
import { FakeCmuxExecutor } from "./fake-cmux-executor.ts";

// ListWorkspacesParsesJson
{
	const fake = new FakeCmuxExecutor();
	fake.enqueueResponse({
		ok: true,
		stdout: JSON.stringify({
			workspaces: [
				{ id: 1, title: "pi-cmux-one", ref: "workspace:1", currentDirectory: "/Users/me/project" },
			],
		}),
	});

	const workspaces = await listWorkspaces(fake);
	assert.deepEqual(workspaces, [
		{ id: 1, title: "pi-cmux-one", ref: "workspace:1", currentDirectory: "/Users/me/project" },
	]);
	assert.deepEqual(fake.calls[0].args, ["workspace", "list", "--json"]);
}

// ListWorkspacesEmpty
{
	const fake = new FakeCmuxExecutor();
	fake.enqueueResponse({ ok: true, stdout: JSON.stringify({ workspaces: [] }) });

	const workspaces = await listWorkspaces(fake);
	assert.deepEqual(workspaces, []);
}

// ListPanesParsesJson
{
	const fake = new FakeCmuxExecutor();
	fake.enqueueResponse({
		ok: true,
		stdout: JSON.stringify({
			workspaces: [
				{
					id: 1,
					title: "pi-cmux-one",
					ref: "workspace:1",
					currentDirectory: "/Users/me/project",
					surfaces: [
						{ surfaceRef: "surface:1", title: "shell", isFocused: true },
						{ ref: "surface:2", title: "logs", focused: false },
					],
				},
			],
		}),
	});

	const panes = await listPanes(fake, "workspace:1");
	assert.deepEqual(panes, [
		{ surfaceRef: "surface:1", title: "shell", isFocused: true },
		{ surfaceRef: "surface:2", title: "logs", isFocused: false },
	]);
	assert.deepEqual(fake.calls[0].args, ["workspace", "list", "--json"]);
}

// ListExecutorError
{
	const fake = new FakeCmuxExecutor();
	fake.enqueueResponse({ ok: false, stderr: "socket missing", exitCode: 1 });

	await assert.rejects(() => listWorkspaces(fake), /socket missing/);
}
