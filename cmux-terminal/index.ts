// P5b-1: cmux-terminal extension entry. Registers a cmux-backed TermBgBackend
// on session_start, after first locating the bg-worker file adjacent to
// bg-terminal.ts. If the worker is missing, registration is skipped silently
// (debug-logged).
//
// Mirrors tmux-terminal/index.ts 1:1 — same worker-resolution strategy, same
// bg-state-dir derivation, same first-wins registration contract (handled by
// agents/lib/bg-terminal.ts). The only difference is which backend factory is
// registered.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import os from "node:os";
import { registerBgTerminalBackend } from "../agents/lib/bg-terminal.ts";
import { resolveWorkerPath } from "./lib/resolve-worker-path.ts";
import { createCmuxBackend } from "./lib/cmux-backend.ts";
import { defaultCmuxExecutor } from "./lib/exec.ts";

export default function cmuxTerminalExtension(pi: ExtensionAPI): void {
	if (typeof pi?.on !== "function") {
		console.debug("cmux-terminal: pi.on not available, skipping registration");
		return;
	}
	const workerPath = resolveWorkerPath();
	if (!workerPath) {
		console.debug("cmux-terminal: worker not found adjacent to bg-terminal.ts, skipping registration");
		return;
	}
	// Must match the agents extension's bg-state root (bg-state.ts getBgStateDir:
	// `<resolveTrustedHome()>/.pi/agent/bg`). resolveTrustedHome() is
	// os.userInfo().homedir (immune to $HOME), and the path is `.pi/agent/bg`,
	// NOT `.pi/bg-state`. We can't import getBgStateDir (REQ-13: no agents/lib
	// imports outside bg-terminal.ts), so this is kept in sync by hand + the
	// integration test. A mismatch makes launch reject every manifest as
	// "invalid manifest path".
	const bgStateDir = path.join(os.userInfo().homedir, ".pi", "agent", "bg");
	pi.on("session_start", () => {
		registerBgTerminalBackend(createCmuxBackend({
			executor: defaultCmuxExecutor(),
			workerPath,
			bgStateDir,
		}));
	});
}
