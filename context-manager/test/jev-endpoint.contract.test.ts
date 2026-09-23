// context-manager/test/jev-endpoint.contract.test.ts — L1 wire-contract tests
// for the live Jev path (eval-plan.md@4961e6ff). Every other wiring test stubs
// globalThis.fetch or uses a dead endpoint (degraded mode); nothing asserted
// the HTTP contract itself. Here a canned node:http System One server on
// 127.0.0.1:0 verifies: Authorization header, request body shape, happy-path
// response parsing ⇒ verdict/drift-p, and the degrade paths (HTTP 500,
// malformed JSON, socket destroy). Not covered: the 15s AbortSignal.timeout
// (JEV_TIMEOUT_MS is a const; a real timeout test would cost 15s per case —
// socket destroy exercises the same catch-and-degrade path).
//
// Keyless behavior is deliberately NOT tested here: jevKey() falls back to
// ~/.pi/agent/models.json, so "no env key" is machine-dependent and could hit
// the real endpoint (M1 AC-1b covers keyless degradation at the unit level).
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

process.env.JEV_API_KEY = "contract-test-key";

const { __eval } = await import("../index.ts");

// ---------- canned System One server ----------
interface CapturedRequest {
	auth?: string | string[];
	contentType?: string | string[];
	url?: string;
	body: any;
}
interface CannedResponse {
	status: number;
	contentType?: string;
	payload: string;
}
type Responder = (body: string) => CannedResponse | "destroy";

async function withServer(responder: Responder, fn: (requests: CapturedRequest[], base: string) => Promise<void>) {
	const requests: CapturedRequest[] = [];
	const server = http.createServer((req, res) => {
		let data = "";
		req.on("data", (c: Buffer) => (data += c.toString()));
		req.on("end", () => {
			let parsed: any = {};
			try {
				parsed = JSON.parse(data || "{}");
			} catch {
				parsed = { __unparsed: data };
			}
			requests.push({ auth: req.headers.authorization, contentType: req.headers["content-type"], url: req.url, body: parsed });
			const r = responder(data);
			if (r === "destroy") {
				res.destroy();
				return;
			}
			res.writeHead(r.status, { "Content-Type": r.contentType ?? "application/json" });
			res.end(r.payload);
		});
	});
	await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
	const port = (server.address() as { port: number }).port;
	const prev = process.env.JEV_ENDPOINT;
	process.env.JEV_ENDPOINT = `http://127.0.0.1:${port}/typesafe/v1/systemone`;
	try {
		await fn(requests, `http://127.0.0.1:${port}`);
	} finally {
		process.env.JEV_ENDPOINT = prev;
		await new Promise((ok) => server.close(ok));
	}
}

// ---------- fixtures ----------
function span(excerpt: string): any {
	return { id: "s1", contentHash: "h", tok: 5000, capturedAt: Date.now(), cls: "unclassified", excerpt, isError: false };
}
const CFG = {} as any; // ingestRelevance takes cfg but does not read it (degraded + Jev paths both key off state/questions only)
const okAnswers = (newInfo: number, onTask: number) =>
	JSON.stringify({ answers: { new_info: { noul: newInfo }, on_task: { noul: onTask } } });

// ---------- ingest (relevance) contract ----------
test("L1 ingest happy path: request contract over the wire + relevant verdict", async () => {
	await withServer(() => ({ status: 200, payload: okAnswers(0.9, 0.9) }), async (requests) => {
		const existing = [span("existing context about the auth refactor and its token budget")];
		const out = await __eval.ingestRelevance(span("candidate excerpt: new stack trace frame in login.ts"), existing, ["AUTH-1 fix login"], CFG);
		assert.equal(out.v, "relevant");
		assert.equal(out.source, "jev");
		assert.equal(requests.length, 1, "exactly one HTTP call");
		const req = requests[0];
		assert.equal(req.auth, "Bearer contract-test-key", "Authorization: Bearer <key>");
		assert.ok(String(req.contentType).startsWith("application/json"), "JSON content type");
		assert.equal(req.body.model, "jev-latest");
		assert.equal(req.body.questions.new_info.type, "noul");
		assert.equal(req.body.questions.on_task.type, "noul");
		assert.equal(req.body.state.candidate.excerpt, "candidate excerpt: new stack trace frame in login.ts");
		assert.ok(Array.isArray(req.body.state.existingInventory) && req.body.state.existingInventory.length === 1);
		assert.deepEqual(req.body.state.tasks, ["AUTH-1 fix login"]);
	});
});

test("L1 ingest verdict mapping: new_info<0.35 ⇒ duplicate, on_task<0.35 ⇒ unrelated", async () => {
	await withServer(() => ({ status: 200, payload: okAnswers(0.2, 0.9) }), async () => {
		const dup = await __eval.ingestRelevance(span("x"), [span("y")], ["AUTH-1"], CFG);
		assert.equal(dup.v, "duplicate");
		assert.equal(dup.source, "jev");
	});
	await withServer(() => ({ status: 200, payload: okAnswers(0.9, 0.2) }), async () => {
		const unrel = await __eval.ingestRelevance(span("x"), [span("y")], ["AUTH-1"], CFG);
		assert.equal(unrel.v, "unrelated");
		assert.equal(unrel.source, "jev");
	});
	await withServer(() => ({ status: 200, payload: okAnswers(0.35, 0.35) }), async () => {
		// thresholds are strict <: 0.35 is NOT below 0.35 ⇒ relevant
		const edge = await __eval.ingestRelevance(span("x"), [span("y")], ["AUTH-1"], CFG);
		assert.equal(edge.v, "relevant");
	});
});

test("L1 ingest degrade: HTTP 500 falls back to heuristic with source recorded", async () => {
	await withServer(() => ({ status: 500, payload: "server error" }), async () => {
		const text = "identical text body that should hash as duplicate via overlap";
		const out = await __eval.ingestRelevance(span(text), [span(text)], ["AUTH-1"], CFG);
		assert.equal(out.v, "duplicate", "verbatim overlap ⇒ duplicate");
		assert.equal(out.source, "heuristic-degraded", "degraded source recorded");
	});
});

test("L1 ingest degrade: malformed JSON body falls back to heuristic", async () => {
	await withServer(() => ({ status: 200, payload: "this is { not json" }), async () => {
		const out = await __eval.ingestRelevance(span("novel content entirely"), [span("unrelated base")], ["AUTH-1"], CFG);
		assert.equal(out.source, "heuristic-degraded");
	});
});

test("L1 ingest degrade: socket destroy (connection reset) falls back to heuristic", async () => {
	await withServer(() => "destroy", async () => {
		const out = await __eval.ingestRelevance(span("novel content entirely"), [span("unrelated base")], ["AUTH-1"], CFG);
		assert.equal(out.source, "heuristic-degraded");
	});
});

// ---------- drift contract ----------
test("L1 drift happy path: request shape + p extraction", async () => {
	await withServer(() => ({ status: 200, payload: JSON.stringify({ answers: { drift: { noul: 0.7 } } }) }), async (requests) => {
		const p = await __eval.jevDriftCall("pivot to the beta rollout", { tasks: ["TEST-1"], topic: "kick off alpha phase", turn: 1 });
		assert.equal(p, 0.7);
		const req = requests[0];
		assert.equal(req.auth, "Bearer contract-test-key");
		assert.equal(req.body.model, "jev-latest");
		assert.equal(req.body.questions.drift.type, "noul");
		assert.deepEqual(req.body.state.pinnedTaskModel.tasks, ["TEST-1"]);
		assert.equal(req.body.state.newestUserMessage, "pivot to the beta rollout");
	});
});

test("L1 drift degrade: HTTP 500 ⇒ null (caller falls back to heuristic)", async () => {
	await withServer(() => ({ status: 500, payload: "nope" }), async () => {
		const p = await __eval.jevDriftCall("any message", { tasks: ["TEST-1"], topic: "topic", turn: 1 });
		assert.equal(p, null);
	});
});

test("L1 drift degrade: malformed JSON ⇒ null", async () => {
	await withServer(() => ({ status: 200, payload: "}{ broken" }), async () => {
		const p = await __eval.jevDriftCall("any message", { tasks: ["TEST-1"], topic: "topic", turn: 1 });
		assert.equal(p, null);
	});
});
