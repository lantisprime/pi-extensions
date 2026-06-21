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
	| { ok: false; reason: "missing" | "invalid" | "untrusted" | "inline-model" | "unknown-kind" };

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
			match: { phrases },
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

	// Phrase matching: scan ALL entries, collect matches, check for ambiguity
	const matchedEntries: { entry: IntentGateEntry; matchedBy: "phrase" }[] = [];

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
