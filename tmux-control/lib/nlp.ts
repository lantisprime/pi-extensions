// tmux-control: natural-language pattern matcher for the `input` event hook.
//
// Conservative patterns — only match if the input clearly looks like a
// tmux-control directive. False positives would silently swallow user
// prompts meant for the LLM.
//
// Triggers:
//   - Must contain either:
//       (a) a runId-style token `bg-<8+ alphanumeric/dash chars>`, OR
//       (b) an explicit `tmux` keyword
//   - Must match one of the action patterns below.
//
// Patterns (case-insensitive):
//   tail/capture/show/peek/view  → capture
//       "tail bg-abc123"
//       "tail bg-abc123 last 50"
//       "show me bg-abc123"
//       "show me the last 50 lines of bg-abc123"
//       "what is bg-abc123 doing"
//
//   list → list
//       "tmux list"
//       "list agents"
//       "list tmux windows"
//
//   send/tell → send
//       `send "hello" to bg-abc123`
//       `send 'continue' to bg-abc123`
//       `tell bg-abc123 'try again'`
export interface NlpMatch {
	action: "capture" | "list" | "send" | "launch";
	runId?: string;
	lines?: number;
	text?: string;
	sessionName?: string;
	command?: string;
	confidence: number; // 0..1; handlers may ignore below a threshold
}

const RUN_ID_RE = /bg-[A-Za-z0-9_-]{6,80}/;

// Helper: extract first runId token.
function extractRunId(text: string): string | null {
	const m = text.match(RUN_ID_RE);
	return m ? m[0] : null;
}

function hasTmuxKeyword(text: string): boolean {
	return /\btmux\b/i.test(text);
}

/** Decide whether the input is even a candidate for tmux-control NL. */
export function isCandidate(text: string): boolean {
	const t = text.trim();
	if (!t) return false;
	if (t.startsWith("/")) return false; // explicit slash commands route elsewhere
	if (t.length > 500) return false; // LLM prompts are usually longer; bail
	// Accept if the text matches any action pattern. This lets "list agents"
	// (no runId, no tmux keyword) still qualify as a candidate.
	if (RUN_ID_RE.test(t)) return true;
	if (hasTmuxKeyword(t)) return true;
	for (const re of SEND_PATTERNS) if (re.test(t)) return true;
	for (const re of CAPTURE_PATTERNS) if (re.test(t)) return true;
	for (const re of LIST_PATTERNS) if (re.test(t)) return true;
	for (const re of LAUNCH_PATTERNS) if (re.test(t)) return true;
	return false;
}

const SEND_PATTERNS: RegExp[] = [
	/^send\s+["']([^"']+)["']\s+to\s+(bg-[A-Za-z0-9_-]+)\s*$/i,
	/^tell\s+(bg-[A-Za-z0-9_-]+)\s+["']([^"']+)["']\s*$/i,
	/^tmux[ -]?send\s+["']([^"']+)["']\s+to\s+(bg-[A-Za-z0-9_-]+)\s*$/i,
];

const CAPTURE_PATTERNS: RegExp[] = [
	// "tail bg-abc", "tail bg-abc last 50", "capture bg-abc", "view bg-abc"
	/^(?:tmux[ -]?)?(?:tail|capture|peek|view)\s+(?:me\s+)?(?:the\s+)?(bg-[A-Za-z0-9_-]+)(?:\s+(?:last\s+)?(\d+))?\s*$/i,
	// "show me bg-abc", "show me the output of bg-abc"
	/^(?:tmux[ -]?)?show\s+(?:me\s+)?(?:the\s+)?(?:output\s+of\s+)?(bg-[A-Za-z0-9_-]+)\s*$/i,
	// "what is bg-abc doing"
	/^(?:tmux[ -]?)?what(?:'s|\s+is)\s+(bg-[A-Za-z0-9_-]+)\s+doing\s*\??$/i,
	// "tail/capture last 50 lines of/from bg-abc"
	/^(?:tmux[ -]?)?(?:tail|capture)\s+(?:the\s+)?(?:last\s+)?(\d+)\s+lines?\s+(?:of|from)\s+(bg-[A-Za-z0-9_-]+)\s*$/i,
];

const LIST_PATTERNS: RegExp[] = [
	/^(?:tmux[ -]?)?list(?:\s+tmux)?(?:\s+(?:agents?|runs?|windows?|bg))?\s*$/i,
];

// Launch: spawn a tmux session. Distinct from /agents bg — this is the
// general-purpose launcher. Patterns:
//   "launch tmux session named dev"
//   "start a tmux session for npm run dev"
//   "spawn tmux window for tailing logs"
//   "spawn tmux" — bare form, session name auto-generated
const LAUNCH_PATTERNS: RegExp[] = [
	/^(?:tmux[ -]?)?(?:launch|start|spawn|open|create)\s+(?:a\s+)?tmux\s+(?:session|window)(?:\s+(?:named|called)\s+["']?([\w.-]+)["']?)?(?:\s+(?:running|for|with|to\s+run)\s+["']?(.+?)["']?)?\s*$/i,
	/^(?:tmux[ -]?)?(?:launch|start|spawn)\s+(?:a\s+)?(?:new\s+)?(?:tmux\s+)?session\s+["']([^"']+)["'](?:\s+(?:running|with|to\s+run)\s+["']?(.+?)["']?)?\s*$/i,
	/^(?:tmux[ -]?)?(?:launch|start|spawn)\s+(?:a\s+)?tmux\s*$/i,
];

export function matchNlp(text: string): NlpMatch | null {
	const t = text.trim();
	if (!isCandidate(t)) return null;

	// Send first (most specific) — quotes are a strong signal.
	for (const re of SEND_PATTERNS) {
		const m = t.match(re);
		if (m) {
			// Two of three patterns put text first, runId second; one (the second) reverses them.
			// Heuristic: the bg-… token is always the runId.
			const groups = m.slice(1);
			const runId = groups.find((g) => /^bg-/.test(g));
			const textGroup = groups.find((g) => g && !/^bg-/.test(g));
			if (runId && textGroup !== undefined) {
				return { action: "send", runId, text: textGroup, confidence: 0.95 };
			}
		}
	}

	for (const re of LAUNCH_PATTERNS) {
		const m = t.match(re);
		if (m) {
			const groups = m.slice(1);
			const sessionName = groups.find((g) => /^\w[\w.-]*$/.test(g ?? ""));
			const command = groups.find((g) => g && !/^\w[\w.-]*$/.test(g) && g.length > 1);
			if (sessionName || hasTmuxKeyword(t)) {
				return {
					action: "launch",
					sessionName: sessionName ?? `pi-ctrl-${Date.now().toString(36)}`,
					command: command ?? undefined,
					confidence: 0.8,
				};
			}
		}
	}

	for (const re of LIST_PATTERNS) {
		if (re.test(t)) {
			// Require explicit tmux keyword OR "list agents/runs/windows" — the bare
			// "list" pattern alone is too generic to swallow.
			if (hasTmuxKeyword(t) || /\b(agents?|runs?|windows?|bg)\b/i.test(t)) {
				return { action: "list", confidence: 0.9 };
			}
		}
	}

	for (const re of CAPTURE_PATTERNS) {
		const m = t.match(re);
		if (m) {
			const groups = m.slice(1);
			const runId = groups.find((g) => /^bg-/.test(g));
			const numStr = groups.find((g) => /^\d+$/.test(g));
			if (runId) {
				const lines = numStr ? parseInt(numStr, 10) : undefined;
				return { action: "capture", runId, lines, confidence: 0.85 };
			}
		}
	}

	return null;
}