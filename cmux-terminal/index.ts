// P5b-1: cmux-terminal extension entry. Registers a cmux-backed TermBgBackend
// on session_start, after first locating the bg-worker file adjacent to
// bg-terminal.ts. If the worker is missing, registration is skipped silently
// (debug-logged).
//
// Mirrors tmux-terminal/index.ts 1:1 — same worker-resolution strategy, same
// bg-state-dir derivation, same append-only registration contract (handled by
// agents/lib/bg-terminal.ts; the selector probes in preference order, highest
// wins). The only difference is which backend factory is registered and that
// cmux sets preference: CMUX_BACKEND_PREFERENCE (10) to win over default-0
// backends like tmux-terminal.
//
// P5b-1-S4 (REQ-T5): also exports `cmuxTerminalTools` for the tool-extension
// wiring. The tools are independent of the bg backend — they target cmux
// surfaces directly via the cmux CLI, so callers can use them without
// triggering a bg backend lookup. The factory binds the tool functions to a
// CmuxExecutor (default: `defaultCmuxExecutor()`) so callers get the
// `cmuxPaste(opts)` / `cmuxWaitFor(opts)` / `cmuxSendKeys(opts)` shape
// described in the S4 spec, with no executor argument.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import os from "node:os";
import { registerBgTerminalBackend } from "../agents/lib/bg-terminal.ts";
import { resolveWorkerPath } from "./lib/resolve-worker-path.ts";
import { createCmuxBackend } from "./lib/cmux-backend.ts";
import { defaultCmuxExecutor, type CmuxExecutor } from "./lib/exec.ts";
import {
	cmuxPaste,
	cmuxWaitFor,
	cmuxSendKeys,
	type PasteOpts,
	type WaitOpts,
	type SendOpts,
	type PasteResult,
	type WaitResult,
	type SendResult,
} from "./lib/tools.ts";
import { CMUX_BACKEND_PREFERENCE } from "./lib/constants.ts";

/**
 * Public tool surface for the cmuxTerminalTools factory (REQ-T5). Each
 * function takes only its `Opts` payload — the CmuxExecutor is bound at
 * factory time. The underlying functions (e.g. `cmuxPaste(executor, opts)`)
 * are also exported from `./lib/tools.ts` for testability.
 */
export interface CmuxTerminalTools {
	cmuxPaste: (opts: PasteOpts) => Promise<PasteResult>;
	cmuxWaitFor: (opts: WaitOpts) => Promise<WaitResult>;
	cmuxSendKeys: (opts: SendOpts) => Promise<SendResult>;
}

/**
 * Bind the cmux tool surface (cmuxPaste / cmuxWaitFor / cmuxSendKeys) to a
 * CmuxExecutor. Defaults to the production `defaultCmuxExecutor()`; tests
 * (and callers that want a custom executor, e.g. for tracing) inject one.
 *
 * The tools are independent of the bg backend: they call `cmux send` /
 * `cmux send-key` / `cmux read-screen` directly against a surface ref, so
 * callers don't need to look up a TermBgBackend. The executor is the only
 * seam. The tools are NOT registered as a TermBgBackend — that is the role
 * of `cmux-terminal/lib/cmux-backend.ts`, registered by the default
 * extension below.
 */
export function cmuxTerminalTools(executor: CmuxExecutor = defaultCmuxExecutor()): CmuxTerminalTools {
	return {
		cmuxPaste: (opts) => cmuxPaste(executor, opts),
		cmuxWaitFor: (opts) => cmuxWaitFor(executor, opts),
		cmuxSendKeys: (opts) => cmuxSendKeys(executor, opts),
	};
}

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
			preference: CMUX_BACKEND_PREFERENCE,
		}));
	});
}
