// Unit tests for permission-policy's herdr:blocked dialog reporting.
//
// herdr's pi integration (~/.pi/agent/extensions/herdr-agent-state.ts, managed
// by herdr) listens on the pi event bus channel "herdr:blocked" and marks the
// pane "blocked" while the reported state is active. These tests load the REAL
// extension module with a fake pi ExtensionAPI / ExtensionContext and assert
// that ensurePermission and confirmYoloMode emit exactly one active:true before
// the dialog opens and exactly one active:false after it settles — including
// when the dialog throws or is cancelled — and that emitting stays harmless
// when no herdr integration is listening.
//
// Run: npx --yes tsx permission-policy/test-fixtures/test-herdr-blocked.ts

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "..", "..");

// Filled in by main() after the dynamic import below.
let permissionPolicyExtension: (api: never) => void;

// ---------------------------------------------------------------------------
// Bootstrap. index.ts imports @earendil-works/pi-ai at runtime (complete) and
// resolves ~/.pi paths from os.homedir() at module load. The repo ships no
// node_modules, so write a minimal gitignored stub before importing, and point
// HOME at a throwaway directory so tests never read or write the real
// ~/.pi/agent permission-policy or prompt-shield state.
// ---------------------------------------------------------------------------

type RecordedEmit = { channel: string; data: unknown };

type Harness = {
	emissions: RecordedEmit[];
	toolCall: (event: { toolName: string; input: Record<string, unknown> }, ctx: unknown) => Promise<unknown>;
	command: (name: string) => ((args: string, ctx: unknown) => Promise<unknown>) | undefined;
};

function loadExtension(fakeEvents: unknown, omitEvents = false): Harness {
	const emissions: RecordedEmit[] = [];
	const eventHandlers = new Map<string, (event: never, ctx: never) => unknown>();
	const commandHandlers = new Map<string, (args: string, ctx: never) => unknown>();
	const api: Record<string, unknown> = {
		on(name: string, handler: (event: never, ctx: never) => unknown) {
			eventHandlers.set(name, handler);
		},
		registerFlag() {},
		registerShortcut() {},
		registerCommand(name: string, def: { handler: (args: string, ctx: never) => unknown }) {
			commandHandlers.set(name, def.handler);
		},
		getFlag() {
			return undefined;
		},
	};
	if (!omitEvents) {
		api.events = fakeEvents ?? {
			emit(channel: string, data: unknown) {
				emissions.push({ channel, data });
			},
		};
	}
	permissionPolicyExtension(api as never);
	const toolCall = eventHandlers.get("tool_call");
	if (!toolCall) throw new Error("extension did not register a tool_call handler");
	return {
		emissions,
		toolCall: (event, ctx) => toolCall(event, ctx) as Promise<unknown>,
		command: (name) => commandHandlers.get(name),
	};
}

function makeCtx(projectDir: string, ui: Record<string, unknown> = {}, hasUI = true) {
	return {
		cwd: projectDir,
		hasUI,
		ui: {
			select: async () => "Deny once",
			confirm: async () => false,
			notify() {},
			setStatus() {},
			...ui,
		},
	};
}

function freshProjectDir(): string {
	// Fresh dir per test so SESSION_PERMISSIONS (keyed by realpath) never leaks.
	return mkdtempSync(path.join(os.tmpdir(), "permfix-project-"));
}

// A plain pi run with no herdr integration emits into a bus with zero
// listeners; node's EventEmitter (pi's EventBus wraps one) must not throw.
function silentEventBus(): EventEmitter {
	return new EventEmitter();
}

// ---------------------------------------------------------------------------
// Runner (same idiom as test-classification.ts)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void>) {
	try {
		await fn();
		passed++;
		console.log(`ok - ${name}`);
	} catch (error) {
		failed++;
		console.error(`FAIL - ${name}`);
		console.error(error);
	}
}

async function main() {
	// Redirect HOME BEFORE importing index.ts: its module-level POLICY_DIR and
	// PROMPT_SHIELD_STATE_PATH constants are computed from os.homedir() at load.
	const fakeHome = mkdtempSync(path.join(os.tmpdir(), "permfix-home-"));
	process.env.HOME = fakeHome;

	// index.ts imports @earendil-works/pi-ai at runtime; the repo ships no
	// node_modules, so write a minimal gitignored stub it can resolve. A6:
	// removed again in the finally below, but only when this run created it.
	const stubDir = path.join(REPO_ROOT, "node_modules", "@earendil-works", "pi-ai");
	const createdStub = !existsSync(stubDir);
	try {
		await runSuite(stubDir);
	} finally {
		if (createdStub) rmSync(stubDir, { recursive: true, force: true });
	}

	// Reported after the finally above so a failing run still cleans the stub.
	console.log(`\n${passed} passed, ${failed} failed out of ${passed + failed} scenarios`);
	if (failed > 0) process.exit(1);
}

async function runSuite(stubDir: string): Promise<void> {
	mkdirSync(stubDir, { recursive: true });
	writeFileSync(
		path.join(stubDir, "package.json"),
		JSON.stringify({ name: "@earendil-works/pi-ai", version: "0.0.0-test-stub", type: "module", main: "index.js" }, null, "\t"),
	);
	writeFileSync(
		path.join(stubDir, "index.js"),
		"export function complete() { throw new Error('stubbed: complete() is not used by these tests'); }\n",
	);

	const imported = await import("../index.ts");
	permissionPolicyExtension = imported.default as (api: never) => void;

	// ---------------------------------------------------------------------------
	// Tests
	// ---------------------------------------------------------------------------

	await check("select resolves: exactly one active:true then one active:false, label carries the request title", async () => {
		const harness = loadExtension(undefined);
		const ctx = makeCtx(freshProjectDir());
		const result = (await harness.toolCall({ toolName: "bash", input: { command: "echo herdr-probe" } }, ctx)) as {
			block?: boolean;
			reason?: string;
		};

		assert.equal(harness.emissions.length, 2, `expected exactly 2 emits, got ${JSON.stringify(harness.emissions)}`);
		assert.equal(harness.emissions[0].channel, "herdr:blocked");
		assert.deepEqual(harness.emissions[0].data, { active: true, label: "Permission required: Run bash commands" });
		assert.match((harness.emissions[0].data as { label?: string }).label || "", /Run bash commands/);
		assert.equal(harness.emissions[1].channel, "herdr:blocked");
		assert.deepEqual(harness.emissions[1].data, { active: false });
		assert.deepEqual(result, { block: true, reason: "Permission denied: Run bash commands" });
	});

	await check("select rejects: active:false is still emitted after the throw", async () => {
		const harness = loadExtension(undefined);
		const ctx = makeCtx(freshProjectDir(), {
			select: async () => {
				throw new Error("simulated dialog crash");
			},
		});

		await assert.rejects(harness.toolCall({ toolName: "bash", input: { command: "echo herdr-probe" } }, ctx), /simulated dialog crash/);

		assert.equal(harness.emissions.length, 2, `expected the finally to still emit, got ${JSON.stringify(harness.emissions)}`);
		assert.deepEqual(harness.emissions[0].data, { active: true, label: "Permission required: Run bash commands" });
		assert.deepEqual(harness.emissions[1].data, { active: false });
	});

	await check("select resolves undefined (cancel): active:false is still emitted and the request is denied", async () => {
		const harness = loadExtension(undefined);
		const ctx = makeCtx(freshProjectDir(), { select: async () => undefined });

		const result = (await harness.toolCall({ toolName: "bash", input: { command: "echo herdr-probe" } }, ctx)) as {
			block?: boolean;
		};

		assert.equal(result.block, true);
		assert.equal(harness.emissions.length, 2, `expected 2 emits on cancel, got ${JSON.stringify(harness.emissions)}`);
		assert.deepEqual(harness.emissions[0].data, { active: true, label: "Permission required: Run bash commands" });
		assert.deepEqual(harness.emissions[1].data, { active: false });
	});

	await check("hasUI false: no emits at all (dialog never shown)", async () => {
		const harness = loadExtension(undefined);
		const ctx = makeCtx(freshProjectDir(), {}, false);

		const result = (await harness.toolCall({ toolName: "bash", input: { command: "echo herdr-probe" } }, ctx)) as {
			block?: boolean;
		};

		assert.equal(result.block, true, "no-UI runs must fail closed");
		assert.equal(harness.emissions.length, 0, `expected no emits, got ${JSON.stringify(harness.emissions)}`);
	});

	await check("plain EventEmitter with no listener (no herdr integration): no exception", async () => {
		const harness = loadExtension(silentEventBus());
		const ctx = makeCtx(freshProjectDir());

		const result = (await harness.toolCall({ toolName: "bash", input: { command: "echo herdr-probe" } }, ctx)) as {
			block?: boolean;
		};

		assert.equal(result.block, true);
	});

	await check("no-op emit function (herdr integration absent): no exception", async () => {
		const harness = loadExtension({ emit() {}, on() {} });
		const ctx = makeCtx(freshProjectDir());

		const result = (await harness.toolCall({ toolName: "bash", input: { command: "echo herdr-probe" } }, ctx)) as {
			block?: boolean;
		};

		assert.equal(result.block, true);
	});

	await check("api without an events bus at all: no exception, permission flow unaffected", async () => {
		const harness = loadExtension(undefined, true); // api.events === undefined
		const ctx = makeCtx(freshProjectDir());

		const result = (await harness.toolCall({ toolName: "bash", input: { command: "echo herdr-probe" } }, ctx)) as {
			block?: boolean;
		};

		assert.equal(result.block, true);
		assert.equal(harness.emissions.length, 0);
	});

	await check("YOLO confirm resolves false: active:true with label then active:false", async () => {
		const harness = loadExtension(undefined);
		const ctx = makeCtx(freshProjectDir());
		const permissions = harness.command("permissions");
		if (!permissions) throw new Error("extension did not register the permissions command");

		await permissions("mode yolo", ctx);

		assert.equal(harness.emissions.length, 2, `expected 2 emits, got ${JSON.stringify(harness.emissions)}`);
		assert.deepEqual(harness.emissions[0].data, { active: true, label: "Permission required: Enable YOLO permission mode?" });
		assert.deepEqual(harness.emissions[1].data, { active: false });
	});

	await check("YOLO confirm rejects: active:false is still emitted after the throw", async () => {
		const harness = loadExtension(undefined);
		const ctx = makeCtx(freshProjectDir(), {
			confirm: async () => {
				throw new Error("simulated confirm crash");
			},
		});
		const permissions = harness.command("permissions");
		if (!permissions) throw new Error("extension did not register the permissions command");

		await assert.rejects(permissions("mode yolo", ctx), /simulated confirm crash/);

		assert.equal(harness.emissions.length, 2, `expected the finally to still emit, got ${JSON.stringify(harness.emissions)}`);
		assert.deepEqual(harness.emissions[0].data, { active: true, label: "Permission required: Enable YOLO permission mode?" });
		assert.deepEqual(harness.emissions[1].data, { active: false });
	});
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
