// herdr-control: herdr:blocked dialog wiring tests (lib/dialog.ts + tool call sites).
//
// The mid-turn dialogs (herdr_send_keys / herdr_close) used to open
// ctx.ui.confirm without reporting state, so a pane stuck on one looked
// "working" to supervisors. This suite pins the contract: every dialog emits
// herdr:blocked true (with a label) on open and false on close — including
// via finally when the dialog throws or is cancelled.
import assert from "node:assert/strict";
import { emitDialogBlocked, confirmWithBlocked } from "../lib/dialog.ts";

function makeBus() {
	const emissions = [];
	return { emissions, emit(name, payload) { emissions.push({ name, payload }); } };
}

// emitDialogBlocked: true carries the label, false clears
{
	const bus = makeBus();
	emitDialogBlocked(bus, true, "herdr: send keys to pi-herdr-x");
	emitDialogBlocked(bus, false);
	assert.deepEqual(bus.emissions, [
		{ name: "herdr:blocked", payload: { active: true, label: "herdr: send keys to pi-herdr-x" } },
		{ name: "herdr:blocked", payload: { active: false } },
	]);
}

// no bus / throwing bus: blocked-state reporting never breaks the caller
{
	assert.doesNotThrow(() => emitDialogBlocked(undefined, true, "x"));
	const throwing = { emit() { throw new Error("bus down"); } };
	assert.doesNotThrow(() => emitDialogBlocked(throwing, true, "x"));
}

// confirmWithBlocked: wraps confirm in blocked true/false
{
	const bus = makeBus();
	const seen = [];
	const ctx = { ui: { confirm: async (title, message) => { seen.push({ title, message }); return false; } } };
	const ok = await confirmWithBlocked(ctx, bus, "Send keys?", "Keys: enter", "herdr: send keys");
	assert.equal(ok, false);
	assert.equal(seen.length, 1);
	assert.deepEqual(bus.emissions, [
		{ name: "herdr:blocked", payload: { active: true, label: "herdr: send keys" } },
		{ name: "herdr:blocked", payload: { active: false } },
	]);
}

// confirmWithBlocked: ALWAYS clears, even when the dialog throws
{
	const bus = makeBus();
	const ctx = { ui: { confirm: async () => { throw new Error("tui exploded"); } } };
	await assert.rejects(() => confirmWithBlocked(ctx, bus, "t", "m", "herdr: x"), /tui exploded/);
	assert.deepEqual(bus.emissions.map((e) => e.payload.active), [true, false], "finally clears despite throw");
}

// -- end-to-end: herdr_send_keys mid-turn dialog reports blocked state --------
{
	const { resetGateCache } = await import("../lib/gate.ts");
	resetGateCache();

	// Stub `herdr` binary on PATH: satisfies the gate probes (status client +
	// status --json with a current version); anything else exits 0.
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-dialog-stub-"));
	const stub = path.join(stubDir, "herdr");
	fs.writeFileSync(stub, [
		"#!/bin/sh",
		'if [ "$1" = "status" ] && [ "$2" = "--json" ]; then',
		'  printf \'{"client":{"version":"0.9.3"},"server":{"status":"running","running":true,"version":"0.9.3"}}\'',
		"  exit 0",
		"fi",
		"exit 0",
		"",
	].join("\n"));
	fs.chmodSync(stub, 0o755);

	const savedPath = process.env.PATH;
	const savedHerdrEnv = process.env.HERDR_ENV;
	process.env.PATH = stubDir;
	process.env.HERDR_ENV = "1";

	try {
		const bus = makeBus();
		const tools = new Map();
		const fakePi = {
			events: bus,
			on() {},
			registerTool(def) { tools.set(def.name, def); },
			registerCommand() {},
			registerShortcut() {},
			registerFlag() {},
			appendEntry() {},
		};
		const extension = (await import("../index.ts")).default;
		extension(fakePi);
		assert.ok(tools.has("herdr_send_keys"), "send_keys tool registered");

		const dialogs = [];
		const ctx = {
			hasUI: true,
			cwd: "/tmp",
			ui: { confirm: async (title, message) => { dialogs.push({ title, message }); return false; } },
		};
		const out = await tools.get("herdr_send_keys").execute("t1", { agent: "pi-herdr-x", keys: "enter" }, undefined, undefined, ctx);
		assert.equal(dialogs.length, 1, "interactive confirm shown before sending keys");
		assert.deepEqual(
			bus.emissions.map((e) => `${e.name}:${e.payload.active}`),
			["herdr:blocked:true", "herdr:blocked:false"],
			"blocked reported on open, always cleared on close",
		);
		assert.match(dialogs[0].title, /pi-herdr-x/);
		const text = out.content?.[0]?.text ?? "";
		assert.match(text, /declined/i, "declining short-circuits before send-keys");
	} finally {
		if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
		if (savedHerdrEnv === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = savedHerdrEnv;
		fs.rmSync(stubDir, { recursive: true, force: true });
	}
}

console.log("test-dialog: all tests passed");
