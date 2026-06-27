// Regression: the bg-terminal.ts backend registry MUST be shared across
// DUPLICATE module instances of bg-terminal.ts.
//
// Bug (2026-06-27): "/agents bg" warned "No terminal backend installed" even
// though tmux-terminal was loaded. Root cause: the agents extension (deployed
// as a copy) and tmux-terminal (deployed as a symlink → repo) resolved
// bg-terminal.ts to DIFFERENT realpaths, so each got its own module-scoped
// `termBackend` singleton. tmux-terminal registered into one instance; the
// agents extension read the other → null. Fix: store the registry on
// globalThis via Symbol.for("pi.agents.bgTerminalBackend") so all instances
// share one slot.
//
// This test forces the split by importing two on-disk COPIES of bg-terminal.ts
// (distinct realpaths → distinct module instances) and asserting a backend
// registered via one is visible via the other.

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcBgTerminal = path.join(here, "..", "lib", "bg-terminal.ts");

function fakeBackend(name) {
	return {
		name,
		isAvailable: async () => true,
		launch: async () => ({ status: "ok", windowId: "w" }),
		kill: async () => ({ status: "ok", windowId: "w" }),
		isAlive: async () => true,
		list: async () => [],
	};
}

async function main() {
	console.log("bg-terminal dual-instance registry tests");

	// bg-terminal.ts has no runtime imports (only type-only interfaces + the
	// registry), so a standalone copy is self-contained and importable.
	const content = await fs.readFile(srcBgTerminal, "utf8");
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bgterm-dual-"));
	const aPath = path.join(root, "a", "bg-terminal.ts");
	const bPath = path.join(root, "b", "bg-terminal.ts");
	await fs.mkdir(path.dirname(aPath), { recursive: true });
	await fs.mkdir(path.dirname(bPath), { recursive: true });
	await fs.writeFile(aPath, content);
	await fs.writeFile(bPath, content);

	try {
		const A = await import(aPath);
		const B = await import(bPath);
		assert.notEqual(A, B, "sanity: the two copies must be DISTINCT module instances");

		// Reset any slot a prior run left in this process.
		A.__resetBgTerminalBackend();

		// THE REGRESSION: register via instance A, read via instance B.
		A.registerBgTerminalBackend(fakeBackend("tmux"));
		const seenByB = B.getBgTerminalBackend();
		assert.ok(seenByB, "backend registered via instance A MUST be visible via instance B (was the bug)");
		assert.equal(seenByB.name, "tmux", "the shared backend must be the one A registered");
		console.log("  ✓ backend registered in one module instance is visible in another");

		// First-wins still holds across instances.
		B.registerBgTerminalBackend(fakeBackend("zellij"));
		assert.equal(A.getBgTerminalBackend().name, "tmux", "first registration must win across instances");
		console.log("  ✓ first-wins semantics hold across instances");

		// __reset via either instance clears the shared slot.
		B.__resetBgTerminalBackend();
		assert.equal(A.getBgTerminalBackend(), null, "__reset via B must clear the slot seen by A");
		console.log("  ✓ __resetBgTerminalBackend clears the shared slot");
	} finally {
		await fs.rm(root, { recursive: true, force: true }).catch(() => {});
	}

	console.log("bg-terminal dual-instance registry tests passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
