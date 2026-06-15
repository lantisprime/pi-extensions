import assert from "node:assert/strict";
import * as extensionModule from "../index.ts";

const agentsExtension = typeof extensionModule.default === "function" ? extensionModule.default : extensionModule.default.default;

function makeHarness() {
	const commands = new Map();
	const notifications = [];
	const pi = {
		registerCommand(name, definition) {
			commands.set(name, definition);
		},
	};
	const ctx = {
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
		},
	};
	return { commands, notifications, pi, ctx };
}

async function invoke(command, args, ctx) {
	await command.handler(args, ctx);
}

async function testCommandRegistrationAndListPath() {
	const harness = makeHarness();
	agentsExtension(harness.pi);
	assert.equal(harness.commands.size, 1);
	assert.equal(harness.commands.has("agents"), true);

	await invoke(harness.commands.get("agents"), "", harness.ctx);
	assert.equal(harness.notifications.length, 1);
	assert.equal(harness.notifications[0].level, "info");
	assert.match(harness.notifications[0].message, /built-ins only; child execution is not implemented yet/);
	assert.match(harness.notifications[0].message, /scout:/);
	assert.match(harness.notifications[0].message, /planner:/);
	assert.match(harness.notifications[0].message, /reviewer:/);
}

async function testVerifyPath() {
	const harness = makeHarness();
	agentsExtension(harness.pi);
	await invoke(harness.commands.get("agents"), "verify", harness.ctx);
	assert.deepEqual(harness.notifications, [
		{ message: "P3 built-in agent specs are valid.", level: "info" },
	]);
}

async function testNegativeUnsupportedRunDoesNotExecute() {
	const harness = makeHarness();
	agentsExtension(harness.pi);
	await invoke(harness.commands.get("agents"), "run scout inspect the repo", harness.ctx);
	assert.equal(harness.notifications.length, 1);
	assert.equal(harness.notifications[0].level, "warning");
	assert.match(harness.notifications[0].message, /does not run agents yet/);
}

async function main() {
	await testCommandRegistrationAndListPath();
	await testVerifyPath();
	await testNegativeUnsupportedRunDoesNotExecute();
	console.log("agents extension scaffold e2e tests passed");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
