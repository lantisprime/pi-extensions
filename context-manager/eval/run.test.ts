// context-manager/eval/run.test.ts — L2 golden-corpus eval runner
// (eval-plan.md@4961e6ff). Skipped unless JEV_EVALS=1 — the full pass hits
// the real System One endpoint (network + cost); the degraded pass is
// hermetic but still gated so the default suite never does corpus work.
//
//   JEV_EVALS=1 node --test eval/run.test.ts            # heuristic pass only
//   JEV_EVALS=1 JEV_API_KEY=... node --test eval/run.test.ts  # + live Jev pass
//
// Relevance rows replay through the production decision function
// (__eval.ingestRelevance). Drift rows replay the PRODUCTION CASCADE through
// the wiring harness (pin turn → probe turn → taskSwitch telemetry row), not
// isolated jevDriftCall calls (plan amendment A2). Floors are the adopted
// plan-v2 starting floors (amendment B); aggregates must also beat the
// majority-class baseline by ≥0.10 (amendment A3). Scores are appended to
// eval/scores/latest.json as the committed regression summary.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const GATED = process.env.JEV_EVALS?.trim() === "1";
const DEAD = "http://127.0.0.1:9/unreachable";
const PROD_ENDPOINT = process.env.JEV_ENDPOINT?.trim() ?? ""; // "" ⇒ extension default

// jevKey() resolution order replicated (presence only — never printed):
function keySource(): "env" | "models.json" | null {
	if (process.env.JEV_API_KEY?.trim()) return "env";
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "models.json"), "utf8")) as {
			providers?: Record<string, { apiKey?: string }>;
		};
		if (parsed.providers?.litellm?.apiKey) return "models.json";
	} catch {
		/* ignore */
	}
	return null;
}

type CorpusRow = any;
const corpus: CorpusRow[] = fs
	.readFileSync(path.join(import.meta.dirname, "corpus.jsonl"), "utf8")
	.trim()
	.split("\n")
	.map((l) => JSON.parse(l));

// Module-level import: index.ts has no import-time side effects (no network);
// the JEV_EVALS gate below is what keeps corpus work out of the default suite.
const { default: createExtension, __eval } = await import("../index.ts");
const relevanceRows = corpus.filter((r) => r.kind === "relevance");
const driftRows = corpus.filter((r) => r.kind === "drift");

interface Cls {
	expected: string;
	got: string;
	capable: boolean; // false for A3 rows (tasks:[]) and tier:"hard" rows — excluded from floors
	hard: boolean; // tier:"hard" — judged-relevant construction but empirically hard for the Jev on_task judge
}
interface Binary {
	expected: boolean;
	got: boolean;
}
const scores: any = {
	generatedAt: new Date().toISOString(),
	requestedModel: "jev-latest",
	endpoint: PROD_ENDPOINT || "(extension default)",
	keySource: keySource(),
	corpus: { relevance: relevanceRows.length, drift: driftRows.length },
	passes: {} as any,
};

test("L2 eval runner is gated (skip proof)", { skip: GATED ? false : "set JEV_EVALS=1 to run (see eval/README.md)" }, () => {
	assert.ok(GATED);
});

// ---------------- metrics helpers ----------------
function aggregate(rows: Cls[]): number {
	const capable = rows.filter((r) => r.capable);
	return capable.filter((r) => r.expected === r.got).length / capable.length;
}
function majorityBaseline(rows: Cls[]): number {
	const capable = rows.filter((r) => r.capable);
	const counts = new Map<string, number>();
	for (const r of capable) counts.set(r.expected, (counts.get(r.expected) ?? 0) + 1);
	return Math.max(...counts.values()) / capable.length;
}
function perClassRecall(rows: Cls[], cls: string): number {
	const cap = rows.filter((r) => r.capable && r.expected === cls);
	if (cap.length === 0) return 1;
	return cap.filter((r) => r.got === cls).length / cap.length;
}
function perClassPrecision(rows: Cls[], cls: string): number {
	const pred = rows.filter((r) => r.capable && r.got === cls);
	if (pred.length === 0) return 1;
	return pred.filter((r) => r.expected === cls).length / pred.length;
}
function pr(rows: Binary[]): { precision: number; recall: number } {
	const tp = rows.filter((r) => r.expected && r.got).length;
	const fp = rows.filter((r) => !r.expected && r.got).length;
	const fn = rows.filter((r) => r.expected && !r.got).length;
	return {
		precision: tp + fp === 0 ? 1 : tp / (tp + fp),
		recall: tp + fn === 0 ? 1 : tp / (tp + fn),
	};
}
function assertFloor(name: string, value: number, floor: number) {
	assert.ok(
		value >= floor,
		`${name}=${value.toFixed(3)} < floor ${floor} — see eval/scores/latest.json`,
	);
}

// ---------------- harness helpers (pattern: test/wiring-phase2-m1.test.ts) ----------------
type Handler = (event: any, ctx: any) => Promise<any>;
function mockPi() {
	const handlers = new Map<string, Handler[]>();
	return {
		pi: {
			on: (e: string, h: Handler) => {
				const l = handlers.get(e) ?? [];
				l.push(h);
				handlers.set(e, l);
				return () => {};
			},
			registerCommand: (_n: string, _o: any) => {},
			events: { emit: () => {}, on: () => () => {} },
		} as any,
		handlers,
	};
}
function mockCtx(opts: { cwd: string; prompt: string }) {
	const promptRef = { current: opts.prompt };
	return {
		ctx: {
			cwd: opts.cwd,
			hasUI: true,
			model: { provider: "litellm", id: "minimax" },
			ui: { setStatus: () => {}, notify: () => {} },
			sessionManager: { getSessionId: () => "eval-run", getEntries: () => [] },
			getContextUsage: () => ({ tokens: 10_000, contextWindow: 1_048_576, percent: 1 }),
			isIdle: () => true,
			hasPendingMessages: () => false,
			getSystemPrompt: () => promptRef.current,
			signal: undefined,
			compact: () => {},
		} as any,
		promptRef,
	};
}
async function drive(h: Map<string, Handler[]>, e: string, ev: any, ctx: any) {
	for (const handler of h.get(e) ?? []) await handler(ev, ctx);
}
function jsonl(cwd: string): any[] {
	const f = path.join(cwd, ".pi", "context-telemetry.jsonl");
	if (!fs.existsSync(f)) return [];
	return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function makeSpan(excerpt: string, pth: string | null, i: number): any {
	return {
		id: `s${i}`,
		path: pth ?? undefined,
		contentHash: `h${i}`,
		tok: 5000,
		capturedAt: Date.now(),
		cls: "unclassified",
		excerpt,
		isError: false,
	};
}
const CFG = {} as any; // ingestRelevance reads no config fields (see index.ts)

async function replayDriftRow(row: CorpusRow): Promise<{ staged: boolean; source: string | null }> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-eval-"));
	const { pi, handlers } = mockPi();
	createExtension(pi);
	const { ctx, promptRef } = mockCtx({ cwd: dir, prompt: row.pinnedPrompt });
	try {
		await drive(handlers, "session_start", {}, ctx);
		await drive(handlers, "message_end", { message: { role: "user", content: row.firstUser } }, ctx);
		if (row.taskListChanged) promptRef.current = row.nextPrompt;
		await drive(handlers, "message_end", { message: { role: "user", content: row.nextUser } }, ctx);
		await drive(handlers, "turn_end", {}, ctx);
		const tsRows = jsonl(dir).map((l) => l.taskSwitch).filter(Boolean);
		const last = tsRows[tsRows.length - 1];
		return { staged: !!last?.staged, source: last?.driftSource ?? null };
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

async function runRelevancePass(): Promise<Cls[]> {
	const out: Cls[] = [];
	for (const r of relevanceRows) {
		const verdict = await __eval.ingestRelevance(
			makeSpan(r.candidate.excerpt, r.candidate.path, 0),
			r.existing.map((e: any, i: number) => makeSpan(e.excerpt, e.path, i + 1)),
			r.tasks,
			CFG,
		);
		out.push({ expected: r.expected, got: verdict.v, capable: r.tasks.length > 0 && r.tier !== "hard", hard: r.tier === "hard" });
	}
	return out;
}
// capable=false rows (A3 tasks:[] + tier:hard) are still RUN and reported as
// diagnostics in scores/latest.json, but excluded from anchor floor assertions
// (plan amendment: hard cases belong in later additions, not the anchor).
async function runDriftPass(): Promise<Binary[]> {
	const out: Binary[] = [];
	for (const r of driftRows.filter((r) => !r.taskListChanged)) {
		const res = await replayDriftRow(r);
		out.push({ expected: r.expected, got: res.staged });
	}
	return out;
}
async function assertCascadeSanity() {
	for (const r of driftRows.filter((r) => r.taskListChanged)) {
		const res = await replayDriftRow(r);
		assert.equal(res.staged, true, `${r.id}: task-diff row must stage`);
		assert.equal(res.source, "task-diff", `${r.id}: task-diff short-circuit before any judge`);
	}
}

// ---------------- the eval ----------------
if (GATED) {
	test("L2 degraded pass: relevance floors (heuristic)", async () => {
		process.env.JEV_ENDPOINT = DEAD;
		try {
			const rows = await runRelevancePass();
			const agg = aggregate(rows);
			const maj = majorityBaseline(rows);
			const relRec = perClassRecall(rows, "relevant");
			const dupRec = perClassRecall(rows, "duplicate");
			const unrelPrec = perClassPrecision(rows, "unrelated");
			// A3 diagnostic: rows with tasks=[] where the heuristic is incapable by design
			const a3Misses = rows.filter((r) => !r.capable && !r.hard && r.expected !== r.got).length;
			const hard = rows.filter((r) => r.hard);
			scores.passes.degraded = scores.passes.degraded ?? {};
			scores.passes.degraded.relevance = {
				aggregate: agg,
				majorityBaseline: maj,
				relevantRecall: relRec,
				duplicateRecall: dupRec,
				unrelatedPrecision: unrelPrec,
				a3IncapableMisses: a3Misses,
				hardTier: { total: hard.length, correct: hard.filter((r) => r.expected === r.got).length },
			};
			assertFloor("degraded relevance aggregate", agg, 0.6);
			assertFloor("degraded relevant-recall", relRec, 0.7);
			assertFloor("degraded duplicate-recall", dupRec, 0.5);
			assertFloor("degraded unrelated-precision", unrelPrec, 0.6);
			assertFloor("degraded majority-baseline margin", agg - maj, 0.1);
		} finally {
			if (PROD_ENDPOINT) process.env.JEV_ENDPOINT = PROD_ENDPOINT;
			else delete process.env.JEV_ENDPOINT;
		}
	});

	test("L2 degraded pass: drift floors (heuristic) + cascade sanity", async () => {
		process.env.JEV_ENDPOINT = DEAD;
		try {
			await assertCascadeSanity();
			const rows = await runDriftPass();
			const { precision, recall } = pr(rows);
			scores.passes.degraded = scores.passes.degraded ?? {};
			scores.passes.degraded.drift = { precision, recall };
			assertFloor("degraded drift precision", precision, 0.5);
			assertFloor("degraded drift recall", recall, 0.5);
		} finally {
			if (PROD_ENDPOINT) process.env.JEV_ENDPOINT = PROD_ENDPOINT;
			else delete process.env.JEV_ENDPOINT;
		}
	});

	const skipLive = keySource() === null ? "no Jev key (JEV_API_KEY / models.json litellm)" : false;

	test("L2 live pass: relevance floors (Jev)", { skip: skipLive }, async () => {
		const rows = await runRelevancePass();
		const agg = aggregate(rows);
		const maj = majorityBaseline(rows);
		const relRec = perClassRecall(rows, "relevant");
		const aggregateAll = rows.filter((r) => r.expected === r.got).length / rows.length; // incl. A3 + hard rows (diagnostic)
		const hard = rows.filter((r) => r.hard);
		scores.passes.live = {
			relevance: {
				aggregate: agg,
				majorityBaseline: maj,
				relevantRecall: relRec,
				aggregateAll,
				hardTier: { total: hard.length, correct: hard.filter((r) => r.expected === r.got).length },
			},
		};
		assertFloor("live relevance aggregate", agg, 0.75);
		assertFloor("live relevant-recall", relRec, 0.85);
		assertFloor("live majority-baseline margin", agg - maj, 0.1);
	});

	test("L2 live pass: drift floors (Jev)", { skip: skipLive }, async () => {
		await assertCascadeSanity();
		const rows = await runDriftPass();
		const { precision, recall } = pr(rows);
		scores.passes.live.drift = { precision, recall };
		assertFloor("live drift precision", precision, 0.75);
		assertFloor("live drift recall", recall, 0.65);
	});

	test("L2 write scores/latest.json", async () => {
		if (skipLive && !scores.passes.live) scores.passes.live = { skipped: skipLive };
		const dir = path.join(import.meta.dirname, "scores");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(scores, null, 2) + "\n");
		assert.ok(fs.existsSync(path.join(dir, "latest.json")));
	});
}
