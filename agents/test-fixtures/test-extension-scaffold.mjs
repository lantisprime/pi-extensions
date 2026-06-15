import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as extensionModule from "../index.ts";

const agentsExtension = typeof extensionModule.default === "function" ? extensionModule.default : extensionModule.default.default;

async function makeHarness() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "agents-ext-"));
	const commands = new Map();
	const events = new Map();
	const notifications = [];
	const confirmations = [];
	const confirmCalls = [];
	const pi = {
		registerCommand(name, definition) {
			commands.set(name, definition);
		},
		on(name, handler) {
			events.set(name, handler);
		},
	};
	const ctx = {
		cwd: path.join(root, "project"),
		agentsHomeDir: path.join(root, "home"),
		hasUI: true,
		isProjectTrusted: () => false,
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
			async confirm(title, message) {
				confirmCalls.push({ title, message });
				return confirmations.shift() ?? false;
			},
		},
	};
	await fs.mkdir(ctx.cwd, { recursive: true });
	return { commands, events, notifications, confirmations, confirmCalls, pi, ctx, root };
}

async function cleanup(harness) {
	await fs.rm(harness.root, { recursive: true, force: true });
}

async function invoke(command, args, ctx) {
	await command.handler(args, ctx);
}

async function testCommandRegistrationAndListPath() {
	const harness = await makeHarness();
	try {
		agentsExtension(harness.pi);
		assert.equal(harness.commands.size, 1);
		assert.equal(harness.commands.has("agents"), true);
		assert.equal(harness.events.has("session_start"), true);

		await invoke(harness.commands.get("agents"), "", harness.ctx);
		assert.equal(harness.notifications.length, 1);
		assert.equal(harness.notifications[0].level, "info");
		assert.match(harness.notifications[0].message, /child execution is not implemented yet/);
		assert.match(harness.notifications[0].message, /scout \[built-in\] runnable/);
		assert.match(harness.notifications[0].message, /planner \[built-in\] runnable/);
		assert.match(harness.notifications[0].message, /reviewer \[built-in\] runnable/);
	} finally {
		await cleanup(harness);
	}
}

async function testDiagnosticsCommands() {
	const harness = await makeHarness();
	try {
		agentsExtension(harness.pi);
		await invoke(harness.commands.get("agents"), "config", harness.ctx);
		await invoke(harness.commands.get("agents"), "registry", harness.ctx);
		await invoke(harness.commands.get("agents"), "doctor", harness.ctx);
		await invoke(harness.commands.get("agents"), "inspect scout", harness.ctx);
		assert.equal(harness.notifications.length, 4);
		assert.match(harness.notifications[0].message, /Agents config:/);
		assert.match(harness.notifications[1].message, /Agents registry:/);
		assert.match(harness.notifications[2].message, /Agents doctor:/);
		assert.match(harness.notifications[3].message, /Agent inspect: scout/);
	} finally {
		await cleanup(harness);
	}
}

async function testVerifyPath() {
	const harness = await makeHarness();
	try {
		agentsExtension(harness.pi);
		await invoke(harness.commands.get("agents"), "verify", harness.ctx);
		assert.equal(harness.notifications.length, 1);
		assert.equal(harness.notifications[0].level, "info");
		assert.match(harness.notifications[0].message, /Built-in specs: valid/);
		assert.match(harness.notifications[0].message, /Agents verify:/);
	} finally {
		await cleanup(harness);
	}
}

async function testNegativeUnsupportedRunDoesNotExecute() {
	const harness = await makeHarness();
	try {
		agentsExtension(harness.pi);
		await invoke(harness.commands.get("agents"), "run scout inspect the repo", harness.ctx);
		assert.equal(harness.notifications.length, 1);
		assert.equal(harness.notifications[0].level, "warning");
		assert.match(harness.notifications[0].message, /Agents do not run until later P3 slices/);
	} finally {
		await cleanup(harness);
	}
}

async function testRegistrationCommands() {
	const harness = await makeHarness();
	try {
		agentsExtension(harness.pi);
		const userDir = path.join(harness.ctx.agentsHomeDir, ".pi", "agent", "agents");
		await fs.mkdir(userDir, { recursive: true });
		await fs.writeFile(path.join(userDir, "helper.md"), "---\nname: user-helper\ndescription: helper\ntools: [read, grep, find, ls]\n---\nRead files.\n");
		harness.confirmations.push(true);
		await invoke(harness.commands.get("agents"), "register user-helper", harness.ctx);
		assert.equal(harness.notifications.at(-1).level, "info");
		assert.match(harness.notifications.at(-1).message, /Registered user-helper/);
		assert.equal(harness.confirmCalls.length, 1);
		assert.match(harness.confirmCalls[0].message, /Registration approves this exact agent spec hash only/);

		harness.confirmations.push(true);
		await invoke(harness.commands.get("agents"), "unregister user-helper", harness.ctx);
		assert.equal(harness.notifications.at(-1).level, "info");
		assert.match(harness.notifications.at(-1).message, /Unregistered 1 entry/);
	} finally {
		await cleanup(harness);
	}
}

async function testRegistrationNonTuiFailsClosedFromCommand() {
	const harness = await makeHarness();
	try {
		harness.ctx.hasUI = false;
		agentsExtension(harness.pi);
		const userDir = path.join(harness.ctx.agentsHomeDir, ".pi", "agent", "agents");
		await fs.mkdir(userDir, { recursive: true });
		await fs.writeFile(path.join(userDir, "helper.md"), "---\nname: user-helper\ndescription: helper\ntools: [read, grep, find, ls]\n---\nRead files.\n");
		await invoke(harness.commands.get("agents"), "register user-helper", harness.ctx);
		assert.equal(harness.notifications.at(-1).level, "warning");
		assert.match(harness.notifications.at(-1).message, /interactive confirmation/);
		assert.equal(harness.confirmCalls.length, 0);
	} finally {
		await cleanup(harness);
	}
}

async function testProactiveProjectRecommendationDedupe() {
	const harness = await makeHarness();
	try {
		harness.ctx.isProjectTrusted = () => true;
		const projectAgentsDir = path.join(harness.ctx.cwd, ".pi", "agents");
		await fs.mkdir(projectAgentsDir, { recursive: true });
		await fs.writeFile(path.join(projectAgentsDir, "helper.md"), "---\nname: project-helper\ndescription: helper\ntools: [read, grep, find, ls]\n---\nRead files.\n");
		agentsExtension(harness.pi);
		await harness.events.get("session_start")({}, harness.ctx);
		await harness.events.get("session_start")({}, harness.ctx);
		assert.equal(harness.notifications.length, 1);
		assert.match(harness.notifications[0].message, /Project agents found: 1 total/);
		await invoke(harness.commands.get("agents"), "list", harness.ctx);
		assert.equal(harness.notifications.length, 3);
		assert.match(harness.notifications[1].message, /Project agents found: 1 total/);
		assert.match(harness.notifications[2].message, /project-helper \[project\]/);
	} finally {
		await cleanup(harness);
	}
}

async function main() {
	await testCommandRegistrationAndListPath();
	await testDiagnosticsCommands();
	await testVerifyPath();
	await testNegativeUnsupportedRunDoesNotExecute();
	await testRegistrationCommands();
	await testRegistrationNonTuiFailsClosedFromCommand();
	await testProactiveProjectRecommendationDedupe();
	console.log("agents extension scaffold e2e tests passed");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
