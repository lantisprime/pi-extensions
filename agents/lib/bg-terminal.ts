// P4-4: Pluggable terminal backend interface. The agents extension defines
// this interface and registry so it never imports tmux or any terminal-specific
// library. Terminal backends (tmux, zellij, wezterm, etc.) are separate
// extensions that implement TermBgBackend and call registerBgTerminalBackend
// at extension load.
//
// See P5_PLUGGABLE_TERMINAL_BACKEND.md for the tmux reference implementation.

/** Configuration passed to the terminal backend when launching a bg agent. */
export interface TermBgAgentConfig {
	/** Registered agent name (for window naming, never in shell commands). */
	agentName: string;
	/** Unique background run ID from bg-state.ts (e.g. bg-<timestamp>-<hex>). */
	runId: string;
	/** Absolute path to the signed manifest.json written by P4-2 preflight. */
	manifestPath: string;
	/** Working directory for the worker process (advisory, from manifest). */
	cwd: string;
}

/** Result returned by terminal backend operations. */
export interface TermBgResult {
	status: "launched" | "failed";
	error?: string;
	/** Opaque backend-specific window handle for kill/isAlive/list. */
	windowId?: string;
}

/** Pluggable terminal backend. Implementations live in separate extensions
 *  (e.g. tmux-terminal/). The agents extension only calls this interface. */
export interface TermBgBackend {
	/** Human-readable backend name for status display. */
	readonly name: string;

	/** Launch a background agent in a terminal window.
	 *  The backend MUST launch the worker (bg-worker.ts) with only the
	 *  manifestPath as its argument — no task text, agent names, model IDs,
	 *  tool lists, or other user-controlled data in the shell command. */
	launch(config: TermBgAgentConfig): Promise<TermBgResult>;

	/** Kill a running background agent by its opaque window handle.
	 *  Best-effort; the bg-state reaper cleans up orphaned reservations. */
	kill(windowId: string): Promise<TermBgResult>;

	/** Check whether a window handle is still alive.
	 *  Used by bg-status to merge disk state with live terminal state. */
	isAlive(windowId: string): Promise<boolean>;

	/** List all running agent windows from this backend.
	 *  Used by bg-status to discover windows that may not have disk state yet. */
	list(): Promise<string[]>;
}

// ── Backend registry ──────────────────────────────────────────────────────

let termBackend: TermBgBackend | null = null;

/** Register a terminal backend. First to register wins; subsequent calls
 *  are silently ignored (extensions load in command-line order). */
export function registerBgTerminalBackend(backend: TermBgBackend): void {
	if (!termBackend) termBackend = backend;
}

/** Get the currently registered terminal backend, or null if none is loaded.
 *  Callers must handle null gracefully — e.g. "/agents bg: no terminal
 *  backend installed". */
export function getBgTerminalBackend(): TermBgBackend | null {
	return termBackend;
}
