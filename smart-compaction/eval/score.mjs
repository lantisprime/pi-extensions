#!/usr/bin/env node
/**
 * Score needle-eval answers against an eval-set.json question bank.
 *
 * Contract: answers.json is a flat map { "<question-id>": "<agent's verbatim answer>" }.
 * The operator copies each answer out of the pane reply (or pastes the whole
 * reply under key "*": the scorer then matches per question against the blob).
 *
 * Matching rule: for kind fact|location|crossref, PASS when every expected
 * token appears in the normalized answer (number / identifier containment);
 * for kind detail, PASS when at least half the expected tokens appear.
 *
 * Usage: node score.mjs --eval-set <eval-set.json> --answers <answers.json>
 */
import fs from "node:fs";

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : null; };
const set = JSON.parse(fs.readFileSync(arg("eval-set"), "utf8"));
const answers = JSON.parse(fs.readFileSync(arg("answers"), "utf8"));

const norm = (s) => String(s).toLowerCase().replace(/\.ts\b/g, "").replace(/^src\//, "").replace(/[_\-\s]+/g, " ");
const blob = answers["*"] ? norm(answers["*"]) : null;

const perApproach = {};
const rows = [];
for (const q of set.questions) {
  const asked = q.id in answers || blob !== null;
  const given = answers[q.id] ?? answers["*"] ?? "(no answer)";
  const hay = blob ?? norm(given);
  const needles = q.expect.map((e) => norm(e));
  const hits = needles.filter((n) => hay.includes(n)).length;
  const pass = q.kind === "detail" ? hits >= Math.ceil(needles.length / 2) : hits === needles.length;
  if (!asked) {
    rows.push({ id: q.id, kind: q.kind, status: "not-asked", given: "" });
    continue;
  }
  rows.push({ id: q.id, kind: q.kind, pass, hits, of: needles.length, given: String(given).slice(0, 80) });
  perApproach[q.kind] ??= { pass: 0, total: 0 };
  perApproach[q.kind].total++;
  if (pass) perApproach[q.kind].pass++;
}
const askedRows = rows.filter((r) => r.status !== "not-asked");
const scorecard = {
  meta: { approach: set.meta.approach, seed: set.meta.seed, scoredAt: new Date().toISOString() },
  perKind: perApproach,
  total: { pass: askedRows.filter((r) => r.pass).length, of: askedRows.length, rate: +(askedRows.filter((r) => r.pass).length / askedRows.length).toFixed(3) },
  questions: rows,
};
console.log(JSON.stringify(scorecard, null, 2));
