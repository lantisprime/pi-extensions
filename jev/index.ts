// jev — ask TypeSafe's System One model (Jev) for typed judgments.
//
// Jev is not a chat model. You send bounded `state` (the thing to judge) plus
// typed `questions`, and get back typed `answers` with probabilities — never
// prose. Three primitives:
//
//   noul   yes/no            -> probability the answer is yes (0..1)
//   choice one of a set      -> winner + full distribution + confidence
//   score  ordered levels    -> probability-weighted value (can land between)
//
// Jev ingests `state` once and evaluates every question in parallel, so packing
// many questions into one call is far cheaper than separate calls. Latency is
// near-flat as question count grows; cost scales with STATE size.
//
// Two hard constraints that shape every use:
//   1. It cannot search. It judges inside a candidate set you hand it —
//      retrieve deterministically (grep/find/em-search), then let Jev rank.
//   2. A per-candidate noul MUST be self-contained: name the candidate and
//      inline its content in the question. The vague form ("does this file
//      answer the following: <q>") returns a flat ~0.92 for EVERY candidate —
//      confident-looking and completely non-discriminative.
//
// Transport: the homelab LiteLLM gateway proxies TypeSafe, so the existing
// LiteLLM virtual key already at rest in ~/.pi/agent/models.json is the
// credential — no new secret.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { probeJev, readJevAvailabilitySync, writeJevStatus } from "./lib/availability.ts";
import { standingRuleAppend } from "./lib/standing-rule.ts";

const DEFAULT_ENDPOINT = "https://litellm.lab.znp.pw/typesafe/v1/systemone";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 120_000;

/** Resolve the gateway key: env override, else the LiteLLM virtual key at rest. */
function resolveKey(): string {
	const fromEnv = process.env.JEV_API_KEY?.trim();
	if (fromEnv) return fromEnv;
	const modelsPath = join(homedir(), ".pi", "agent", "models.json");
	const parsed = JSON.parse(readFileSync(modelsPath, "utf8")) as {
		providers?: Record<string, { apiKey?: string }>;
	};
	const key = parsed.providers?.litellm?.apiKey;
	if (!key) {
		throw new Error(
			`Jev: no credential. Set JEV_API_KEY, or add providers.litellm.apiKey to ${modelsPath}.`,
		);
	}
	return key;
}

function endpoint(): string {
	return process.env.JEV_ENDPOINT?.trim() || DEFAULT_ENDPOINT;
}

function model(): string {
	return process.env.JEV_MODEL?.trim() || DEFAULT_MODEL;
}

type QuestionType = "noul" | "choice" | "score";

/** Shape returned by the API, narrowed to the fields we surface. */
type Answer = {
	type: QuestionType;
	noul?: number;
	choice?: string;
	score?: number;
	confidence?: number;
	probabilities?: Record<string, number>;
	legend?: Record<string, string>;
};

type JevAskDetails = {
	available: boolean;
	reason?: string;
	endpoint?: string;
	model?: string;
	answers?: Record<string, Answer>;
	usage?: { input_tokens?: number; output_tokens?: number };
};

type JevResponse = {
	model: string;
	answers: Record<string, Answer>;
	usage?: { input_tokens?: number; output_tokens?: number };
};

/** The API accepts text or structured JSON for `state`; pass JSON through as an object. */
function normaliseState(raw: string): unknown {
	const trimmed = raw.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return raw; // not JSON after all — send as text
		}
	}
	return raw;
}

/** Render one answer compactly for the model, keeping the numbers it must threshold on. */
function renderAnswer(id: string, a: Answer): string {
	switch (a.type) {
		case "noul":
			return `${id}: noul=${a.noul?.toFixed(3)}`;
		case "choice": {
			const top = Object.entries(a.probabilities ?? {})
				.sort((x, y) => y[1] - x[1])
				.slice(0, 5)
				.map(([k, v]) => `${k}=${v.toFixed(3)}`)
				.join(" ");
			return `${id}: choice=${a.choice} confidence=${a.confidence?.toFixed(3)} [${top}]`;
		}
		case "score": {
			const legend = a.legend
				? Object.entries(a.legend)
						.map(([k, v]) => `${k}=${v}`)
						.join(" ")
				: "";
			return `${id}: score=${a.score?.toFixed(3)} confidence=${a.confidence?.toFixed(3)}${
				legend ? ` levels[${legend}]` : ""
			}`;
		}
		default:
			return `${id}: ${JSON.stringify(a)}`;
	}
}

export default function (pi: ExtensionAPI) {
	// Refresh the availability cache once per session, in the background so startup
	// is never blocked. Other components (e.g. agents child-args) read the cached
	// status synchronously and fall back to no-Jev when it is stale or negative.
	pi.on("session_start", async (_event, ctx) => {
		try {
			const status = await probeJev({ signal: ctx?.signal });
			if (!status.ok) {
				ctx?.ui?.notify?.(`Jev unavailable (${status.detail ?? "unknown"}) — proceeding without it.`, "warning");
			}
		} catch {
			// Availability stays unknown, which is the safe direction.
		}
	});

	// Standing rule (same mechanism as the tasks extension): a constant line
	// appended to the system prompt every turn, so grounded-judgement routing to
	// jev_ask is in the chain of thought from turn one — not only in Guidelines
	// bullets or the tool description. Gated on the cached availability probe so
	// a dead gateway never advertises a tool it cannot serve; the prompt changes
	// only when availability flips, which is one bounded cache miss, not growth.
	pi.on("before_agent_start", async (event) => {
		const append = standingRuleAppend(readJevAvailabilitySync());
		if (!append) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${append}` };
	});

	pi.registerTool({
		name: "jev_ask",
		label: "Ask Jev",
		description:
			"Ask TypeSafe's System One model (Jev) for typed judgments over a bounded state. " +
			"Returns probabilities, not prose. Use for: ranking/choosing among candidates you " +
			"already have (which of these?), verifying a claim against evidence (does this " +
			"demonstrate that?), and grading along ordered levels (score). " +
			"Jev cannot search — gather candidates first (grep/find/read), then pass them as " +
			"state. Pack many questions into ONE call: state is billed, questions are nearly free. " +
			"For a per-candidate noul, name the candidate AND inline its content in the " +
			"instructions, or the answer will be flat and meaningless.",
		promptSnippet: "Ask Jev for typed judgments (noul/choice/score) over a bounded state",
		promptGuidelines: [
			"For 'read this and score it', 'which of these fits best', 'does we have evidence for AC-3' " +
				"kind of judgments, prefer jev_ask over asking a chat model — it returns calibrated " +
				"probabilities you can threshold in code.",
			"Always gather candidates in code first (grep/find/read) and pass them as jev_ask state; " +
				"Jev ranks what you give it and cannot retrieve.",
		],
		parameters: Type.Object({
			state: Type.String({
				description:
					"The bounded state to judge: text, or a JSON string for structured state (e.g. " +
					'an object of candidates, a spec excerpt plus evidence). This is the billed part — ' +
					"keep it bounded (candidates and short excerpts, not whole corpora).",
			}),
			questions: Type.Array(
				Type.Object({
					id: Type.String({
						description: "Your name for this question; the answer comes back under it. Not sent to the model.",
					}),
					type: StringEnum(["noul", "choice", "score"] as const, {
						description:
							"Question kind. noul = yes/no probability; choice = pick one of `criteria`; " +
							"score = rate along the ordered `criteria` levels.",
					}),
					instructions: Type.String({
						description:
							"What to judge. For 'choice', frame as 'which of these...'. For 'noul', a yes/no " +
							"question; make it self-contained if it concerns one candidate.",
					}),
					criteria: Type.Optional(
						Type.Unknown({
							description:
								"For choice: map of option -> rubric description (required). For score: ordered array " +
								"of level descriptions, 2..10 (required). For noul: optional {true, false} meanings.",
						}),
					),
				}),
				{ description: "One or more typed questions; they are evaluated in parallel over the same state." },
			),
			model: Type.Optional(Type.String({ description: `Model id (default ${DEFAULT_MODEL}).` })),
		}),

		async execute(_toolCallId, params, signal) {
			// REAL-TIME availability (lesson 2026-09-22: a stale liveness file must
			// never refuse a call while the service is up — and must record downtime
			// when it is down). The request itself is the check: attempt it, and
			// write the outcome through to the shared status file so child-offering
			// and the standing rule stay fresh. 429/529 count as up (throttled ≠ down).
			const questions: Record<string, { type: QuestionType; instructions: string; criteria?: unknown }> = {};
			for (const q of params.questions) {
				if (!q.id.trim()) throw new Error("jev_ask: every question needs a non-empty id");
				if (questions[q.id]) throw new Error(`jev_ask: duplicate question id '${q.id}'`);
				if ((q.type === "choice" || q.type === "score") && q.criteria === undefined) {
					throw new Error(`jev_ask: '${q.id}' is a ${q.type} question and requires criteria`);
				}
				questions[q.id] = {
					type: q.type,
					instructions: q.instructions,
					...(q.criteria !== undefined ? { criteria: q.criteria } : {}),
				};
			}

			const body = JSON.stringify({
				state: normaliseState(params.state),
				model: params.model?.trim() || model(),
				questions,
			});

			const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
			const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;

			let res: Response;
			try {
				res = await fetch(endpoint(), {
					method: "POST",
					headers: {
						Authorization: `Bearer ${resolveKey()}`,
						"Content-Type": "application/json",
					},
					body,
					signal: composed,
				});
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				writeJevStatus({ ok: false, checkedAt: Date.now(), endpoint: endpoint(), detail: msg });
				return {
					content: [
						{
							type: "text",
							text:
								`Jev is unavailable — request failed (${msg}). Do NOT retry jev_ask. ` +
								`Proceed without it: use your own judgement, and state plainly which ` +
								`judgements you could not ground with a calibrated probability.`,
						},
					],
					details: { available: false, reason: "request-failed", endpoint: endpoint() } as JevAskDetails,
				};
			}

			const text = await res.text();
			if (!res.ok && res.status !== 429 && res.status !== 529) {
				writeJevStatus({ ok: false, checkedAt: Date.now(), endpoint: endpoint(), detail: `HTTP ${res.status}` });
				throw new Error(`jev_ask: HTTP ${res.status}: ${text.slice(0, 400)}`);
			}
			// Reachable (success or throttled): refresh the shared liveness file as a
			// side effect so child-offering and the standing rule stay fresh.
			writeJevStatus({ ok: true, checkedAt: Date.now(), endpoint: endpoint() });

			let parsed: JevResponse;
			try {
				parsed = JSON.parse(text) as JevResponse;
			} catch {
				throw new Error(`jev_ask: response was not JSON: ${text.slice(0, 300)}`);
			}
			if (!parsed?.answers || typeof parsed.answers !== "object") {
				throw new Error(`jev_ask: response had no answers: ${text.slice(0, 300)}`);
			}

			const lines = Object.entries(parsed.answers).map(([id, a]) => renderAnswer(id, a));
			const usage = parsed.usage
				? `\n\nmodel=${parsed.model} input_tokens=${parsed.usage.input_tokens ?? "?"}`
				: `\n\nmodel=${parsed.model}`;

			return {
				content: [
					{
						type: "text",
						text:
							`Jev answers (probabilities; threshold in your own code):\n` +
							lines.join("\n") +
							usage,
					},
				],
				details: { available: true, model: parsed.model, answers: parsed.answers, usage: parsed.usage } as JevAskDetails,
			};
		},
	});
}
