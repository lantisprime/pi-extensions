import { promises as fs } from "node:fs";

// ── Types ──

export type IntentGateConfig = {
	version: 1;
	intents: IntentGateEntry[];
};

export type IntentGateEntry = {
	id: string;
	match: {
		phrases: string[];
		regex?: string[];
	};
	workflow:
		| { kind: "review"; profile?: string }
		| { kind: "plan-only" }
		| { kind: "implementation" };
};

export type GateDecision =
	| { kind: "route"; agent: "reviewer"; task: string; profile?: string; metadata: GateMetadata }
	| { kind: "inject"; instruction: GateInstruction }
	| { kind: "confirm"; agent: string; task: string; metadata: GateMetadata }
	| { kind: "pass-through" };

export type GateMetadata = {
	intentId: string;
	matchedBy: "phrase" | "regex";
};

/** Code-owned system instruction enum — config selects kind only (REQ-SEC-4). */
export type GateInstruction = "PLAN_ONLY" | "IMPLEMENTATION_CONFIRM";

export const GATE_INSTRUCTIONS: Record<GateInstruction, string> = {
	PLAN_ONLY: "The user requested a plan. Produce a detailed plan only. Do NOT implement, edit, or execute any code.",
	IMPLEMENTATION_CONFIRM: "The user requested implementation. Confirm scope before proceeding.",
};

// ── Config loading ──

export type ConfigResult =
	| { ok: true; config: IntentGateConfig }
	| { ok: false; reason: "missing" | "invalid" | "untrusted" | "inline-model" | "unknown-kind" | "unsafe-regex" };

export async function loadGateConfig(configPath: string, trusted: boolean): Promise<ConfigResult> {
	if (!trusted) return { ok: false, reason: "untrusted" };

	let raw: string;
	try {
		raw = await fs.readFile(configPath, "utf-8");
	} catch {
		return { ok: false, reason: "missing" };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, reason: "invalid" };
	}

	if (typeof parsed !== "object" || parsed === null || !("version" in parsed) || (parsed as Record<string, unknown>).version !== 1) {
		return { ok: false, reason: "invalid" };
	}

	const config = parsed as Record<string, unknown>;
	if (!Array.isArray(config.intents)) return { ok: false, reason: "invalid" };

	const entries: IntentGateEntry[] = [];
	for (const entry of config.intents) {
		if (typeof entry !== "object" || entry === null) return { ok: false, reason: "invalid" };

		const e = entry as Record<string, unknown>;

		// Reject inline model/thinking fields (REQ-SEC-2) — check both entry and workflow levels
		const entryObj = e as Record<string, unknown>;
		if ("model" in entryObj || "thinking" in entryObj) return { ok: false, reason: "inline-model" };

		if (typeof entryObj.id !== "string" || !entryObj.id) return { ok: false, reason: "invalid" };

		const match = entryObj.match as Record<string, unknown> | undefined;
		if (!match || !Array.isArray(match.phrases)) return { ok: false, reason: "invalid" };
		const phrases = match.phrases.filter((p): p is string => typeof p === "string");

		// P7-3: validate regex patterns (REQ-SEC-6)
		const regexRaw = match.regex;
		let regex: string[] | undefined;
		if (regexRaw !== undefined) {
			if (!Array.isArray(regexRaw)) return { ok: false, reason: "invalid" };
			const patterns = regexRaw.filter((r): r is string => typeof r === "string");
			if (patterns.length > 10) return { ok: false, reason: "unsafe-regex" };
			for (const pattern of patterns) {
				if (pattern.length > 256) return { ok: false, reason: "unsafe-regex" };
				// Reject nested quantifiers that risk catastrophic backtracking
				if (/\([^)]*[+*{][^)]*\)[+*{]/.test(pattern)) return { ok: false, reason: "unsafe-regex" };
			}
			regex = patterns;
		}

		const workflow = entryObj.workflow as Record<string, unknown> | undefined;
		if (!workflow || typeof workflow.kind !== "string") return { ok: false, reason: "invalid" };

		// Reject inline model/thinking fields (REQ-SEC-2) — check inside workflow object
		if ("model" in (workflow as object) || "thinking" in (workflow as object)) return { ok: false, reason: "inline-model" };

		const kind = workflow.kind;
		if (kind !== "review" && kind !== "plan-only" && kind !== "implementation") {
			return { ok: false, reason: "unknown-kind" };
		}

		const gateEntry: IntentGateEntry = {
			id: entryObj.id as string,
			match: { phrases, ...(regex ? { regex } : {}) },
			workflow: { kind } as IntentGateEntry["workflow"],
		};

		if (kind === "review" && typeof workflow.profile === "string") {
			(gateEntry.workflow as { kind: "review"; profile?: string }).profile = workflow.profile;
		}

		entries.push(gateEntry);
	}

	return { ok: true, config: { version: 1, intents: entries } };
}

// ── Intent classification ──

export function classifyGateIntent(prompt: string, config: IntentGateConfig): GateDecision {
	// Skip /commands (REQ-8)
	if (prompt.trimStart().startsWith("/")) return { kind: "pass-through" };

	const text = prompt.trim();
	if (!text) return { kind: "pass-through" };

	// Phrase matching: scan ALL entries, collect matches
	const matchedEntries: { entry: IntentGateEntry; matchedBy: "phrase" | "regex" }[] = [];

	for (const entry of config.intents) {
		for (const phrase of entry.match.phrases) {
			const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const re = new RegExp("\\b" + escaped + "\\b", "i");
			if (re.test(text)) {
				matchedEntries.push({ entry, matchedBy: "phrase" });
				break; // first phrase match wins per entry; continue to next entry
			}
		}
	}

	// P7-3: Regex matching (REQ-2, REQ-SEC-6). Soft timeout — can't abort a single
	// catastrophic regex mid-execution, but prevents additional regex runs after 100ms.
	const regexStart = BigInt(Date.now());
	for (const entry of config.intents) {
		const patterns = entry.match.regex;
		if (!patterns || patterns.length === 0) continue;
		for (const pattern of patterns) {
			const elapsed = Number(BigInt(Date.now()) - regexStart);
			if (elapsed > 100) break;
			try {
				if (new RegExp(pattern, "i").test(text)) {
					matchedEntries.push({ entry, matchedBy: "regex" });
					break; // first regex match wins per entry
				}
			} catch {
				// Invalid regex at runtime → skip, treat as no-match for this pattern
			}
		}
	}

	if (matchedEntries.length === 0) return { kind: "pass-through" };

	// Ambiguity check: if any two matched entries have DIFFERENT workflow kinds, pass-through
	const firstKind = matchedEntries[0].entry.workflow.kind;
	for (let i = 1; i < matchedEntries.length; i++) {
		if (matchedEntries[i].entry.workflow.kind !== firstKind) {
			return { kind: "pass-through" };
		}
	}

	const { entry, matchedBy } = matchedEntries[0];
	const metadata: GateMetadata = { intentId: entry.id, matchedBy };

	switch (entry.workflow.kind) {
		case "review":
			return {
				kind: "route",
				agent: "reviewer",
				task: text,
				profile: (entry.workflow as { kind: "review"; profile?: string }).profile,
				metadata,
			};
		case "plan-only":
			return { kind: "inject", instruction: "PLAN_ONLY" };
		case "implementation":
			return { kind: "confirm", agent: "planner", task: text, metadata };
	}
}
