// herdr-control: pane classifier.
//
// WHY: herdr cannot reliably classify pi agents in its panes — it reports
// `unknown` when its detection cannot confidently recognize the UI (and it
// can miss pi approval dialogs entirely). This module classifies the pane's
// TRUE state ourselves by fusing:
//   1. herdr's own agent_status (authoritative when it speaks clearly), with
//   2. pattern analysis of the pane's bottom buffer via `agent read --source
//      detection` (herdr 0.9+), the same plain-text snapshot herdr's own
//      detector uses.
// Dialog evidence ALWAYS outranks herdr: a missed blocked dialog is the most
// expensive misclassification (the agent silently waits forever).
//
// pi UI strings are grounded in pi itself: tool approvals render through
// ctx.ui.confirm("Allow tool call?", ...) (pi docs/extensions.md), the
// project-trust flow uses "trust"/"ask" dialogs (pi docs/security.md), and
// the TUI input prompt glyph is `❯`.

import type { HerdrExecutor } from "./exec.ts";
import { getAgent, listAgents, findByName } from "./list.ts";
import { extractError } from "./json.ts";

export type ClassifiedStatus = "working" | "blocked" | "idle" | "done" | "unknown";
export type Confidence = "high" | "medium" | "low";

export interface Classification {
	status: ClassifiedStatus;
	confidence: Confidence;
	/** Machine-consumable reasons: one line per matched signal. */
	evidence: string[];
	/** How the verdict was reached. */
	source: "herdr" | "pattern" | "fused";
}

export type ClassifyResult =
	| { ok: true; classification: Classification }
	| { ok: false; error: string };

// Dialog markers: approval/question UIs (pi confirm dialogs, y/n menus).
// The pi bash-permission dialog's real strings (live-captured):
//   "Permission required: Run bash commands" / "How should Pi handle this
//   permission?" / options "Allow once … Deny permanently for this project".
const BLOCKED_PATTERNS: Array<{ re: RegExp; label: string }> = [
	{ re: /\bPermission required\b/i, label: "pi permission dialog" },
	{ re: /\b(?:Allow|Deny) (?:once|for (?:the )?current session|permanently)\b/i, label: "allow/deny menu" },
	{ re: /\ballow (?:tool call|command|this)\b/i, label: "allow-dialog" },
	{ re: /\b(?:yes[ ,])?(?:allow|approve|accept)\b[^.!?]*\?/i, label: "approval question" },
	{ re: /\b(?:permission|approval) (?:request|dialog|prompt)\b/i, label: "permission wording" },
	{ re: /\[\s*(?:y|Y)\/(?:n|N)\s*\]|\(\s*(?:y|Y)\/(?:n|N)\s*\)/, label: "y/n menu" },
	{ re: /\b(?:yes|no)\/(?:no|yes|always|all)\b/, label: "yes/no/all menu" },
	{ re: /\btrust (?:this|the) (?:project|repository|directory|command)\b/i, label: "trust dialog" },
	{ re: /\bproject trust\b/i, label: "project trust" },
	{ re: /\bdeny\b(?![a-z])/i, label: "deny option" },
];

// Activity markers: spinners (braille + common glyph sets), interrupt hints.
const WORKING_PATTERNS: Array<{ re: RegExp; label: string }> = [
	{ re: /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒✻✶✳✢✥]/u, label: "spinner glyph" },
	{ re: /\besc to (?:interrupt|cancel)\b/i, label: "interrupt hint" },
	// Deliberately NO prose wording pattern ("...is running." in an answer must
	// not read as activity) — herdr's own `working` status covers that case.
];

// Idle prompt: the TUI input prompt at the bottom of the pane. pi (like most
// agents) parks a fresh prompt line at the bottom when ready for input.
const PROMPT_MARKER_RE = /(?:^|\n)\s*(?:❯|>)\s*$/;

export interface PatternVerdict {
	status: ClassifiedStatus;
	confidence: Confidence;
	evidence: string[];
}

// Pure pattern analysis over a detection-source snapshot. Exported for tests.
export function classifyDetectionText(text: string): PatternVerdict {
	const evidence: string[] = [];
	// The bottom of the buffer is the pane's present state; older lines above
	// may still contain finished-answer words like "allow" — dialogs live at
	// the bottom while they are open. Scan the last 25 lines for everything.
	const lines = text.split("\n");
	const bottom = lines.slice(-25).join("\n");

	for (const { re, label } of BLOCKED_PATTERNS) {
		const hit = bottom.match(re);
		if (hit) evidence.push(`blocked: ${label} "${hit[0].trim().slice(0, 60)}"`);
	}
	if (evidence.length > 0) return { status: "blocked", confidence: "high", evidence };

	for (const { re, label } of WORKING_PATTERNS) {
		const hit = bottom.match(re);
		if (hit) evidence.push(`working: ${label} "${hit[0].trim().slice(0, 60)}"`);
	}
	if (evidence.length > 0) return { status: "working", confidence: "medium", evidence };

	const lastLine = [...lines].reverse().find((l) => l.trim().length > 0) ?? "";
	// pi/claude park a `❯` prompt line at the bottom when ready for input. A
	// bare `>` is ambiguous (quotes, diffs, shell) — not sufficient.
	if (PROMPT_MARKER_RE.test(text) || /❯\s*$/.test(lastLine)) {
		return { status: "idle", confidence: "medium", evidence: [`idle: prompt marker at bottom "${lastLine.trim().slice(0, 40)}"`] };
	}
	return { status: "unknown", confidence: "low", evidence: ["no dialog, activity, or prompt marker in detection buffer"] };
}

// Fuse herdr's status with the pattern verdict. Evidence-first policy:
//   - a successful detection read is the PRIMARY truth. For path-sourced pi
//     panes herdr marks `screen_detection_skipped` and reports `working` even
//     mid-dialog (live-verified) — herdr's status is corroboration, never
//     override, when we have real screen evidence. Only herdr-confirmed
//     `blocked` stays authoritative-positive (delivery was refused for cause).
//   - a failed detection read + skipped herdr screen = no evidence at all →
//     unknown. Never invent a status from a skipped pane's stale herdr view.
export function fuseStatuses(
	herdrStatus: string | null,
	patterns: PatternVerdict,
	opts: { detectionFailed?: boolean; herdrScreenSkipped?: boolean } = {},
): Classification {
	const evidence = [...patterns.evidence];
	if (herdrStatus) {
		evidence.unshift(`herdr agent_status: ${herdrStatus}${opts.herdrScreenSkipped ? " (screen detection skipped — untrusted)" : ""}`);
	}

	const patternBlocked = patterns.status === "blocked";
	if (patternBlocked) {
		return { status: "blocked", confidence: "high", evidence, source: herdrStatus ? "fused" : "pattern" };
	}
	// herdr-confirmed blocked is equally authoritative in the other direction:
	// patterns miss dialogs herdr saw — never downgrade a herdr `blocked`.
	if (herdrStatus === "blocked") {
		return { status: "blocked", confidence: "high", evidence, source: "herdr" };
	}
	if (opts.detectionFailed) {
		// No buffer evidence: herdr's integration lifecycle is the best remaining
		// signal (valid for pi rows too — only its dialog blindness needs the
		// buffer, and with no buffer there is nothing to contradict it).
		if (herdrStatus && herdrStatus !== "unknown") {
			return { status: herdrStatus as ClassifiedStatus, confidence: "medium", evidence, source: "herdr" };
		}
		if (opts.herdrScreenSkipped) {
			evidence.push("no evidence: herdr skipped screen detection and detection read failed");
		}
		return { status: "unknown", confidence: "low", evidence, source: "pattern" };
	}

	// Detection read succeeded. For NON-skipped rows (claude/codex — herdr
	// reads their screens), patterns win and herdr corroborates. For SKIPPED
	// rows (path-sourced pi — herdr never reads the screen), invert: herdr's
	// integration-tracked lifecycle (idle/done/working) is valid, only its
	// blindness to dialogs is the problem — and dialogs were already handled
	// by the pattern check above. The buffer still contributes evidence.
	const agrees = herdrStatus === patterns.status;
	if (agrees) {
		return { status: patterns.status, confidence: "high", evidence, source: "fused" };
	}
	if (opts.herdrScreenSkipped) {
		if (herdrStatus && herdrStatus !== "unknown") {
			return { status: herdrStatus as ClassifiedStatus, confidence: "medium", evidence, source: "herdr" };
		}
		return { status: patterns.status, confidence: patterns.confidence, evidence, source: "pattern" };
	}
	// idle/done are the same lifecycle family (both mean "ready for input",
	// per herdr's own docs); herdr's variant corroborates settled-ness but the
	// detection buffer's concrete state names the verdict.
	const SETTLED = new Set(["idle", "done"]);
	if (SETTLED.has(patterns.status) && SETTLED.has(herdrStatus ?? "")) {
		return { status: patterns.status, confidence: "high", evidence, source: "fused" };
	}
	if (herdrStatus && herdrStatus !== "unknown") {
		evidence.push(`contradiction: herdr says ${herdrStatus}, detection shows ${patterns.status}`);
	}
	return { status: patterns.status, confidence: patterns.confidence, evidence, source: "pattern" };
}

const DETECTION_DEFAULT_LINES = 40;

export async function classifyAgent(
	executor: HerdrExecutor,
	target: string,
	opts: { detectionLines?: number } = {},
): Promise<ClassifyResult> {
	const lines = Math.max(5, Math.min(opts.detectionLines ?? DETECTION_DEFAULT_LINES, 200));

	// 1. herdr's own view. `agent get <name>` can fail with agent_not_found for
	// agents that `agent list` clearly shows (name scoping); fall back to the
	// list row (which carries agent_status and the pane id).
	let herdrStatus: string | null = null;
	let paneId: string | undefined;
	let screenSkipped = false;
	const detail = await getAgent(executor, target);
	if (detail.ok) {
		herdrStatus = detail.agent.agent_status ?? null;
		paneId = detail.agent.pane_id;
		screenSkipped = detail.agent.screen_detection_skipped === true;
	} else {
		const list = await listAgents(executor);
		const row = list.ok ? findByName(list.agents, target) : undefined;
		if (row) {
			herdrStatus = row.agent_status ?? null;
			paneId = row.pane_id;
			screenSkipped = row.screen_detection_skipped === true;
		}
	}

	// 2. Detection snapshot (plain text, not an envelope — see read.ts). Name
	// targeting first, then the pane id (the documented alternative target).
	const readTargets = paneId && paneId !== target ? [target, paneId] : [target];
	let read: Awaited<ReturnType<HerdrExecutor["exec"]>> | null = null;
	for (const readTarget of readTargets) {
		read = await executor.exec(
			["agent", "read", readTarget, "--source", "detection", "--lines", String(lines)],
			{ timeoutMs: 30_000 },
		);
		if (read.ok) break;
	}
	let patterns: PatternVerdict;
	const detectionFailed = !(read && read.ok);
	if (read && read.ok) {
		patterns = classifyDetectionText(read.stdout);
	} else {
		const err = extractError(read?.stderr ?? "", read?.exitCode ?? -1);
		patterns = { status: "unknown", confidence: "low", evidence: [`detection read failed: ${err.message}`] };
	}

	return { ok: true, classification: fuseStatuses(herdrStatus, patterns, { detectionFailed, herdrScreenSkipped: screenSkipped }) };
}
