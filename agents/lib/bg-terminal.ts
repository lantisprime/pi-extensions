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
	/** Working directory for the worker process. Carried here so the backend
	 *  can set the terminal's initial cwd for user convenience when switching
	 *  to the agent window. The worker itself reads cwd from the manifest. */
	cwd: string;
}

/** Successful backend operation. */
export interface TermBgOkResult {
	status: "ok";
	/** Opaque backend-specific window handle for kill/isAlive/list.
	 *  MUST be non-empty and suitable for exact-match comparisons.
	 *  Consumers treat this as an opaque token — never substring-match. */
	windowId?: string;
}

/** Failed backend operation. */
export interface TermBgFailedResult {
	status: "failed";
	/** Human-readable error message. */
	error: string;
}

/** Discriminated union: success or failure. Illegal states
 *  (failed without error, ok with error) are unrepresentable. */
export type TermBgResult = TermBgOkResult | TermBgFailedResult;

/** Structured entry returned by list(). Carries enough context for
 *  P4-5/P4-6 to correlate windows with disk-state run directories
 *  without lossy substring parsing. */
export interface TermBgWindowEntry {
	/** Opaque window handle. MUST be non-empty and exact-matchable.
	 *  This is the same value accepted by kill() and isAlive(). */
	windowId: string;
	/** Background run ID, if the backend can recover it. */
	runId?: string;
	/** Agent name, if the backend can recover it. */
	agentName?: string;
}

/** Pluggable terminal backend. Implementations live in separate extensions
 *  (e.g. tmux-terminal/). The agents extension only calls this interface. */
export interface TermBgBackend {
	/** Human-readable backend name for status display. */
	readonly name: string;

	/** Optional pre-flight probe. Returns true if the terminal
	 *  system is installed and usable. P4-5 calls this before
	 *  preflight to give a clean "no terminal backend installed"
	 *  message rather than failing at launch time. */
	isAvailable?(): Promise<boolean>;

	/** Launch a background agent in a terminal window.
	 *
	 *  The backend MUST launch the worker (bg-worker.ts) with only the
	 *  manifestPath as its argument — no task text, agent names, model IDs,
	 *  tool lists, or other user-controlled data in the shell command.
	 *
	 *  Returns a windowId that can be passed to kill()/isAlive(). */
	launch(config: TermBgAgentConfig): Promise<TermBgResult>;

	/** Kill a running background agent by its opaque window handle.
	 *
	 *  Best-effort; the bg-state reaper cleans up orphaned reservations.
	 *  The windowId MUST be compared with exact-match semantics — backends
	 *  MUST NOT use substring/includes matching, which causes false
	 *  positives when window names overlap.
	 *
	 *  Returns ok on success, failed with error if the window was not
	 *  found or could not be killed. */
	kill(windowId: string): Promise<TermBgResult>;

	/** Check whether a window handle is still alive.
	 *
	 *  Used by bg-status to merge disk state with live terminal state.
	 *  The windowId MUST be compared with exact-match semantics.
	 *  Backends MUST NOT use substring/includes matching.
	 *
	 *  Returns false for empty strings, foreign handles, or dead windows. */
	isAlive(windowId: string): Promise<boolean>;

	/** List all running agent windows from this backend.
	 *
	 *  Used by bg-status to discover windows that may not have disk state
	 *  yet. Each entry carries enough context for P4-5/P4-6 to correlate
	 *  windows with bg-state run directories. Returns an empty array when
	 *  no agent windows exist — never throws or returns undefined. */
	list(): Promise<TermBgWindowEntry[]>;
}

// ── Backend registry ──────────────────────────────────────────────────────
//
// The registry is stored on the process-global object under a shared Symbol so
// the singleton survives `bg-terminal.ts` being loaded as MORE THAN ONE module
// instance. That happens whenever the agents extension and a backend extension
// (e.g. tmux-terminal) resolve this file to different realpaths — one deployed
// as a copy and the other as a symlink, installed from separate sources, or
// pinned to different versions. A plain module-scoped `let` gives each instance
// its own variable, so a backend registered by one extension is invisible to
// the other (getBgTerminalBackend() → null → "No terminal backend installed").
// `Symbol.for` uses the cross-module global symbol registry, so every instance
// shares one slot, and a backend extension can register without importing this
// exact module instance. Regression: test-bg-terminal-dual-instance.mjs.

const REGISTRY_SLOT = Symbol.for("pi.agents.bgTerminalBackend");

function registrySlot(): { backend: TermBgBackend | null } {
	const g = globalThis as unknown as Record<symbol, { backend: TermBgBackend | null } | undefined>;
	return (g[REGISTRY_SLOT] ??= { backend: null });
}

/** Register a terminal backend. First to register wins; subsequent calls
 *  emit a debug diagnostic so "pi -e a -e b" doesn't silently drop the
 *  second backend. Extensions load in command-line order.
 *
 *  Stored in the process-global registry (see above) so registration is
 *  visible across duplicate module instances of this file. */
export function registerBgTerminalBackend(backend: TermBgBackend): void {
	const slot = registrySlot();
	if (!slot.backend) {
		slot.backend = backend;
		return;
	}
	console.debug(
		`bg-terminal: ignoring backend "${backend.name}" — "${slot.backend.name}" already registered (first registration wins)`,
	);
}

/** Get the currently registered terminal backend, or null if none is loaded.
 *  Callers must handle null gracefully — e.g. "/agents bg: no terminal
 *  backend installed". */
export function getBgTerminalBackend(): TermBgBackend | null {
	return registrySlot().backend;
}

/** TEST-ONLY: reset the registered backend to null. Never call in production
 *  — only for test fixtures that need independent registration state. */
export function __resetBgTerminalBackend(): void {
	registrySlot().backend = null;
}
