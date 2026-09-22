// smart-compaction/lib/gate.ts — relevance gate (AC-6).
//
// Estimates P(summarized context is related to the current session tasks):
//   - primary: one Jev noul question (same gateway as the jev extension)
//   - fallback: keyword-overlap heuristic
// Any failure / timeout / no-tasks resolves to a conservative default so the
// caller can proceed (spec AC-6, AC-10). Never throws.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_ENDPOINT = "https://litellm.lab.znp.pw/typesafe/v1/systemone";
const DEFAULT_MODEL = "jev-latest";
const TIMEOUT_MS = 15_000;

function resolveKey(): string | null {
	const fromEnv = process.env.JEV_API_KEY?.trim();
	if (fromEnv) return fromEnv;
	try {
		const modelsPath = join(homedir(), ".pi", "agent", "models.json");
		const parsed = JSON.parse(readFileSync(modelsPath, "utf8")) as {
			providers?: Record<string, { apiKey?: string }>;
		};
		return parsed.providers?.litellm?.apiKey ?? null;
	} catch {
		return null;
	}
}

function endpoint(): string {
	return process.env.JEV_ENDPOINT?.trim() || DEFAULT_ENDPOINT;
}

const STOPWORDS = new Set([
	"the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "with", "is",
	"are", "be", "this", "that", "it", "as", "at", "by", "from", "up", "about",
	"into", "over", "after", "before", "out", "use", "when", "then", "than",
	"so", "such", "can", "will", "should", "would", "do", "does", "did", "not",
	"test", "plugin", "work", "need", "needs", "check", "using", "used",
]);

function words(text: string): Set<string> {
	const out = new Set<string>();
	for (const m of text.toLowerCase().matchAll(/[a-z0-9_./-]{3,}/g)) {
		if (!STOPWORDS.has(m[0])) out.add(m[0]);
	}
	return out;
}

/** Keyword-overlap heuristic: share of task vocabulary present in the excerpt. */
export function heuristicRelevance(subjects: string[], excerpt: string): number {
	if (subjects.length === 0 || excerpt.length === 0) return 0.5;
	const taskWords = words(subjects.join(" "));
	if (taskWords.size === 0) return 0.5;
	const excerptWords = words(excerpt);
	let hits = 0;
	for (const w of taskWords) if (excerptWords.has(w)) hits++;
	return hits / taskWords.size;
}

export interface GateResult {
	/** P(context is related to current tasks), 0..1. */
	probability: number;
	source: "jev" | "heuristic" | "default";
	/** Action mapped per profile gate thresholds (design D2). */
	action: "aggressive" | "focused" | "defer";
	detail?: string;
}

export function mapAction(p: number, profile: { enabled: boolean; aggressiveBelow: number; deferAbove: number }): "aggressive" | "focused" | "defer" {
	if (!profile.enabled) return "focused";
	if (p < profile.aggressiveBelow) return "aggressive";
	if (p > profile.deferAbove) return "defer";
	return "focused";
}

/**
 * Ask Jev whether the to-be-summarized context still relates to the tasks.
 * `excerpt` should be a bounded serialization (first N chars) of the messages
 * that would be summarized; `subjects` are the active task subjects.
 */
export async function relevanceGate(
	subjects: string[],
	excerpt: string,
	gate: { enabled: boolean; aggressiveBelow: number; deferAbove: number },
	signal?: AbortSignal,
): Promise<GateResult> {
	if (subjects.length === 0) {
		const p = 0.5;
		return { probability: p, source: "default", action: mapAction(p, gate), detail: "no active tasks" };
	}

	const key = resolveKey();
	if (key) {
		try {
			const body = JSON.stringify({
				model: DEFAULT_MODEL,
				state: {
					question: "Does this conversation context still contain information needed for the listed tasks?",
					tasks: subjects,
					contextExcerpt: excerpt.slice(0, 4000),
				},
				questions: {
					task_related: {
						type: "noul",
						instructions:
							"noul: the conversation excerpt contains information (decisions, file paths, commands, open questions) that is needed to continue the listed tasks. Related-but-complete work counts as NO.",
					},
				},
			});
			const timeout = AbortSignal.timeout(TIMEOUT_MS);
			const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
			const res = await fetch(endpoint(), {
				method: "POST",
				headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
				body,
				signal: composed,
			});
			if (res.ok) {
				const parsed = (await res.json()) as {
					answers?: Record<string, { noul?: number }>;
				};
				const p = parsed.answers?.task_related?.noul;
				if (typeof p === "number" && p >= 0 && p <= 1) {
					return { probability: p, source: "jev", action: mapAction(p, gate) };
				}
			}
		} catch {
			// fall through to heuristic (AC-10)
		}
	}

	const p = heuristicRelevance(subjects, excerpt);
	return {
		probability: p,
		source: "heuristic",
		action: mapAction(p, gate),
		detail: "Jev unavailable or errored",
	};
}
