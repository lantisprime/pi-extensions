// P5b-2: zellij-terminal extension entry. Mirrors the established terminal-extension pattern.
//
// Registers a zellij-backed TermBgBackend on session_start, after first
// locating the bg-worker file adjacent to bg-terminal.ts. If the worker is
// missing, registration is skipped silently (debug-logged).
//
// Differences from the other terminals: the factory is `createZellijBackend`
// (different CLI surface, two-step detached launch via `attach -b` + `run`),
// preference is `ZELLIJ_BACKEND_PREFERENCE` (0 — same as the default; the
// preference-10 backend still wins the automatic selector; the user picks
// zellij explicitly via `--backend zellij` per P5E1).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import os from "node:os";
import { registerBgTerminalBackend } from "../agents/lib/bg-terminal.ts";
import { resolveWorkerPath } from "./lib/resolve-worker-path.ts";
import { createZellijBackend } from "./lib/zellij-backend.ts";
import { defaultZellijExecutor, spawnAttachSession } from "./lib/exec.ts";
import { ZELLIJ_BACKEND_PREFERENCE } from "./lib/constants.ts";

export default function zellijTerminalExtension(pi: ExtensionAPI): void {
	if (typeof pi?.on !== "function") {
		console.debug("zellij-terminal: pi.on not available, skipping registration");
		return;
	}
	const workerPath = resolveWorkerPath();
	if (!workerPath) {
		console.debug("zellij-terminal: worker not found adjacent to bg-terminal.ts, skipping registration");
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
		registerBgTerminalBackend(createZellijBackend({
			executor: defaultZellijExecutor(),
			attachSpawner: spawnAttachSession,
			workerPath,
			bgStateDir,
			preference: ZELLIJ_BACKEND_PREFERENCE,
		}));
	});
}
