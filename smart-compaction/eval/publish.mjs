#!/usr/bin/env node
/**
 * Publish an eval scorecard to the shared pi-wide store so ALL projects
 * using pi can view results and model profiles:
 *
 *   ~/.pi/agent/eval/
 *     profiles/<model-key>.json                 — eval profile configs (reusable)
 *     results/<project>/<scorecard>.json        — scorecards
 *     INDEX.md                                  — rebuilt table of everything
 *
 * Usage:
 *   node publish.mjs --scorecard results/x.json --project pi-extensions \
 *        --model litellm/minimax [--session <sessionId>] [--tokens-before N] \
 *        [--profile /path/.pi/smart-compaction.json] [--notes "…"]
 *   node publish.mjs --reindex
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : null; };
const has = (n) => args.includes("--" + n);

const STORE = path.join(os.homedir(), ".pi", "agent", "eval");
const PROFILES = path.join(STORE, "profiles");
const RESULTS = path.join(STORE, "results");
for (const d of [STORE, PROFILES, RESULTS]) fs.mkdirSync(d, { recursive: true });

function reindex() {
  const rows = [];
  for (const project of fs.readdirSync(RESULTS)) {
    const dir = path.join(RESULTS, project);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        rows.push({
          project, file: `${project}/${f}`,
          model: s.meta?.model ?? "?", approach: s.meta?.approach ?? "?",
          anchored: s.meta?.anchored ?? "",
          total: `${s.total?.pass}/${s.total?.of}`, rate: s.total?.rate,
          tokensBefore: s.meta?.tokensBefore ?? "", session: s.meta?.sessionId ?? "",
          scoredAt: (s.meta?.scoredAt ?? "").slice(0, 10),
          notes: s.meta?.notes ?? "",
        });
      } catch { /* skip unreadable */ }
    }
  }
  const lines = [
    "# pi shared eval results",
    "",
    "Populated by `smart-compaction/eval/publish.mjs` from every project using pi.",
    "Profiles live in `profiles/`, scorecards under `results/<project>/`.",
    "",
    "| project | model | approach | anchored | score | rate | tokensBefore | session | date | notes |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.project} | ${r.model} | ${r.approach} | ${r.anchored} | ${r.total} | ${r.rate} | ${r.tokensBefore} | ${r.session} | ${r.scoredAt} | ${r.notes} |`),
    "",
  ];
  fs.writeFileSync(path.join(STORE, "INDEX.md"), lines.join("\n"));
  return rows.length;
}

if (has("--reindex")) {
  console.log(`indexed ${reindex()} scorecards -> ${path.join(STORE, "INDEX.md")}`);
  process.exit(0);
}

const scPath = arg("scorecard");
const project = arg("project");
if (!scPath || !project) {
  console.error("--scorecard and --project are required");
  process.exit(1);
}
const card = JSON.parse(fs.readFileSync(scPath, "utf8"));
card.meta ??= {};
card.meta.model = arg("model") ?? card.meta.model ?? "unknown";
if (arg("session")) card.meta.sessionId = arg("session");
if (arg("tokens-before")) card.meta.tokensBefore = Number(arg("tokens-before"));
if (arg("notes")) card.meta.notes = arg("notes");

const profPath = arg("profile");
if (profPath && fs.existsSync(profPath)) {
  const prof = JSON.parse(fs.readFileSync(profPath, "utf8"));
  const dest = path.join(PROFILES, `${card.meta.model.replace(/[^a-z0-9._-]+/gi, "_")}.json`);
  if (!fs.existsSync(dest)) {
    fs.writeFileSync(dest, JSON.stringify({ model: card.meta.model, evalConfig: prof, sourceProject: project, capturedAt: new Date().toISOString() }, null, 2));
  }
  card.meta.profileRef = path.relative(STORE, dest);
}

const projectDir = path.join(RESULTS, project);
fs.mkdirSync(projectDir, { recursive: true });
const dest = path.join(projectDir, path.basename(scPath));
fs.writeFileSync(dest, JSON.stringify(card, null, 2));
reindex();
console.log(`published -> ${path.relative(process.cwd(), dest)}\nindex -> ${path.join(STORE, "INDEX.md")}`);
