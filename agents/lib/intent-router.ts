import { redactChildPiArgv, type ChildPiInvocation } from "./child-args.ts";
import type { ChildAgentRunResult } from "./child-runner.ts";

export const INTENT_AUTORUN_CONFIDENCE = 0.8;
export const HEURISTIC_SATURATION = 6;           // confidence = min(1, weight / SATURATION)
export const TIE_ORDER = ["reviewer", "planner", "scout"] as const;
export const AMBIGUOUS_DEFAULT = Object.freeze({ agent: "scout", confidence: 0.3 });
export const ROLE_DEFAULT_PROFILE = Object.freeze({
  scout: "fast-local", planner: "reasoning-deep", reviewer: "adversarial-review",
}) as Readonly<Record<string, string>>;
// keyword → weight, grouped by role. Matched case-insensitively as whole words / phrases.
export const ROLE_KEYWORDS = Object.freeze({
  reviewer: { review: 3, critique: 3, audit: 3, verdict: 2, bug: 2, bugs: 2, assess: 2, evaluate: 2 },
  planner:  { plan: 3, design: 3, "break down": 3, roadmap: 2, steps: 2, architecture: 2, approach: 2 },
  scout:    { find: 2, where: 2, locate: 2, explore: 2, recon: 2, inspect: 2, search: 2, "which files": 2 },
}) as Readonly<Record<string, Readonly<Record<string, number>>>>;
// profileEffect: defined HERE (P6-1) — not in P6-4 — so BOTH P6-3b (runIntentCommand role-default
// guard) and P6-4 (display labels) import it from intent-router.ts. Structural param (no profiles.ts
// import); only reads truthiness, so a ModelProfile (thinking?: ThinkingLevel ⊆ string) is assignable.
export function profileEffect(p: { model?: string; thinking?: string }): "none" | "model" | "thinking" | "both" {
  const m = !!p.model, t = !!p.thinking;
  return m && t ? "both" : m ? "model" : t ? "thinking" : "none";
}
// CLASSIFIER_LIMITS: the bounded spawnAndCollect options the classifier child runs under (REQ-5).
// P6-2 builds the options object from these + the injected spawn/now. Values are concrete, not knobs.
export const CLASSIFIER_LIMITS = Object.freeze({
  stdoutLimit: 65_536, stderrLimit: 4_096, timeoutMs: 20_000,
  maxJsonLineBytes: 65_536, maxResultChars: 512, killSignal: "SIGTERM", forceKillAfterMs: 1_000,
});
export type IntentDecision = { agent: string; confidence: number; reason: string;
  engine: "llm" | "heuristic-fallback"; signals?: string[] };
export type IntentCandidate = { name: string; source: "built-in" | "user" | "project";
  description: string; role?: "scout" | "planner" | "reviewer" };

export function classifyIntentHeuristic(task: string, candidates: string[]): IntentDecision {
  if (task.trim() === "") throw new Error("task must be non-empty");

  // Score each role from ROLE_KEYWORDS
  const scores: Record<string, { weight: number; signals: string[] }> = {};
  for (const [role, keywords] of Object.entries(ROLE_KEYWORDS)) {
    let weight = 0;
    const signals: string[] = [];
    for (const [kw, kwWeight] of Object.entries(keywords)) {
      const regex = new RegExp("\\b" + kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
      if (regex.test(task)) {
        weight += kwWeight;
        signals.push(kw);
      }
    }
    scores[role] = { weight, signals };
  }

  // Find the maximum weight
  let maxWeight = 0;
  for (const s of Object.values(scores)) {
    if (s.weight > maxWeight) maxWeight = s.weight;
  }

  if (maxWeight === 0) {
    const defaultAgent = candidates.includes(AMBIGUOUS_DEFAULT.agent)
      ? AMBIGUOUS_DEFAULT.agent
      : candidates[0];
    return {
      agent: defaultAgent,
      confidence: AMBIGUOUS_DEFAULT.confidence,
      reason: "no intent keywords matched",
      engine: "heuristic-fallback",
      signals: [],
    };
  }

  // Pick highest-weight role; break ties by TIE_ORDER
  let winner = "";
  for (const role of TIE_ORDER) {
    if (scores[role]?.weight === maxWeight) {
      winner = role;
      break;
    }
  }

  const confidence = Math.min(1, maxWeight / HEURISTIC_SATURATION);
  const winnerSignals = scores[winner].signals;

  return {
    agent: winner,
    confidence,
    reason: `matched: ${winnerSignals.join(", ")}`,
    engine: "heuristic-fallback",
    signals: winnerSignals,
  };
}

export function parseClassifierOutput(
  raw: string,
  candidateNames: string[]
): { ok: true; decision: IntentDecision } | { ok: false; reason: string } {
  // (a) Fence pass
  const fences = [...raw.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (fences.length > 1) return { ok: false, reason: "multiple-objects" };
  const fenced = fences.length === 1;
  const candidate = fenced ? fences[0][1] : raw;

  // (b) Top-level object scan: walk chars tracking brace depth, counting only outside strings
  const runs: Array<[number, number]> = [];
  let depth = 0;
  let inStr = false;
  let runStart = -1;

  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i];

    // Toggle inStr on unescaped "
    if (ch === '"') {
      // Check if escaped: count preceding backslashes
      let escCount = 0;
      for (let j = i - 1; j >= 0 && candidate[j] === "\\"; j--) escCount++;
      if (escCount % 2 === 0) inStr = !inStr;
    }

    // Track braces only outside strings
    if (!inStr) {
      if (ch === "{") {
        if (depth === 0) runStart = i;
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0 && runStart !== -1) {
          runs.push([runStart, i]);
          runStart = -1;
        }
      }
    }
  }

  // (c) Validate run count
  if (runs.length === 0) return { ok: false, reason: "non-json" };
  if (runs.length > 1) return { ok: false, reason: "multiple-objects" };

  const [s, e] = runs[0];

  // (d) Check for embedded prose (only when not fenced)
  if (!fenced) {
    if (candidate.slice(0, s).trim() !== "" || candidate.slice(e + 1).trim() !== "") {
      return { ok: false, reason: "embedded" };
    }
  }

  // (e) JSON.parse in try/catch
  let obj: any;
  try {
    obj = JSON.parse(candidate.slice(s, e + 1));
  } catch {
    return { ok: false, reason: "non-json" };
  }

  // (f) Validate shape: exactly {agent, confidence, reason}
  const keys = Object.keys(obj).sort();
  if (keys.length !== 3 || keys[0] !== "agent" || keys[1] !== "confidence" || keys[2] !== "reason") {
    return { ok: false, reason: "bad-shape" };
  }

  const { agent, confidence, reason } = obj;

  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    return { ok: false, reason: "bad-confidence" };
  }

  if (!candidateNames.includes(agent)) {
    return { ok: false, reason: "unknown-agent" };
  }

  // (g) Success
  return {
    ok: true,
    decision: {
      agent,
      confidence: Math.max(0, Math.min(1, confidence)),
      reason: String(reason),
      engine: "llm",
    },
  };
}

/** P6-2: build the LLM classifier child invocation. No AgentSpec, no tools, no session.
 *  Override is model-only — thinking is always forced off. Returns warnings for ignored override fields. */
export function buildClassifierPiArgs(task: string, candidates: IntentCandidate[], opts: { piCommand?: string; overrideModel?: string; overrideThinking?: string } = {}): { invocation: ChildPiInvocation; warnings: string[] } {
  const warnings: string[] = [];
  if (opts.overrideThinking) {
    warnings.push("intent-classifier: profile thinking ignored (forced off)");
  }
  const argv = ["--mode", "json", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-tools", "--thinking", "off"];
  if (opts.overrideModel) argv.push("--model", opts.overrideModel);
  argv.push("-p");
  const command = opts.piCommand ?? "pi";
  const candidateLines = candidates.map((c) => `- ${c.name}: ${c.description.slice(0,200)}`).join("\n");
  const CLASSIFIER_PROMPT = [
    "You are an intent classifier. Choose the single best agent for the task.",
    "",
    candidateLines,
    "",
    'Reply with ONLY one JSON object: {"agent":"<name>","confidence":<0..1>,"reason":"<short>"}',
    "",
    `Task:`,
    task,
  ].join("\n");
  const invocation: ChildPiInvocation = {
    command,
    argv,
    promptTransport: { kind: "stdin", stdinText: CLASSIFIER_PROMPT },
    argvPreview: redactChildPiArgv(argv),
  };
  return { invocation, warnings };
}

/** P6-2: resolve run intent — tries LLM classifier first, falls back to heuristic.
 *  The deps.runClassifier is prod = collectChildProcess, inject a stub in tests.
 *  Given a non-empty task (guaranteed by parseDoArgs), never throws on classifier failure. */
export async function resolveRunIntent(task: string, candidates: IntentCandidate[], deps: { runClassifier: (invocation: ChildPiInvocation, limits: typeof CLASSIFIER_LIMITS) => Promise<ChildAgentRunResult>; piCommand?: string; overrideModel?: string; overrideThinking?: string }): Promise<IntentDecision> {
  const names = candidates.map((c) => c.name);
  const { invocation } = buildClassifierPiArgs(task, candidates, { piCommand: deps.piCommand, overrideModel: deps.overrideModel, overrideThinking: deps.overrideThinking });
  try {
    const result = await deps.runClassifier(invocation, CLASSIFIER_LIMITS);
    const parsed = parseClassifierOutput(result.summary.summaryText, names);
    return parsed.ok ? parsed.decision : classifyIntentHeuristic(task, names);
  } catch {
    return classifyIntentHeuristic(task, names);
  }
}
