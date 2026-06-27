// P5: tmux-terminal extension entry. Registers a tmux-backed TermBgBackend on
// session_start, after first locating the bg-worker file adjacent to bg-terminal.ts.
// If the worker is missing, registration is skipped silently (debug-logged).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import os from "node:os";
import { registerBgTerminalBackend } from "../agents/lib/bg-terminal.ts";
import { resolveWorkerPath } from "./lib/resolve-worker-path.ts";
import { createTmuxBackend } from "./lib/tmux-backend.ts";
import { defaultTmuxExecutor } from "./lib/exec.ts";

export default function tmuxTerminalExtension(pi: ExtensionAPI): void {
	if (typeof pi?.on !== "function") {
		console.debug("tmux-terminal: pi.on not available, skipping registration");
		return;
	}
	const workerPath = resolveWorkerPath();
	if (!workerPath) {
		console.debug("tmux-terminal: worker not found adjacent to bg-terminal.ts, skipping registration");
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
		registerBgTerminalBackend(createTmuxBackend({
			executor: defaultTmuxExecutor(),
			workerPath,
			bgStateDir,
		}));
	});
}