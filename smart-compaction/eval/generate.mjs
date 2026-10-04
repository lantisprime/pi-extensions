#!/usr/bin/env node
/**
 * Needle-in-a-haystack corpus generator for smart-compaction live evals.
 *
 * Three approaches:
 *   prose  — N unrelated-topic text files, needle facts embedded at depth
 *   code   — N unrelated TypeScript modules (200-400 LOC), needles = exotic
 *            function names + distinctive constants
 *   hybrid — code corpus + requirements.md / design.md / plan.md whose IDs
 *            cross-reference specific code needles
 *
 * Deterministic per seed. Emits the corpus under <out>/ and eval-set.json
 * (question bank with expected answers) next to it.
 *
 * Usage: node generate.mjs --approach prose|code|hybrid --out /tmp/eval-X [--seed 20261004]
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : dflt;
};
const approach = opt("approach", "code");
const outDir = opt("out", "/tmp/sc-eval-" + approach);
const seedArg = Number(opt("seed", "20261004"));

let seed = seedArg;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const GREEK = ["alpha","beta","gamma","delta","epsilon","zeta","eta","theta","iota","kappa","lambda","mu","nu","xi","omicron","rho","sigma","tau","upsilon","phi","chi","psi","omega"];

const evalSet = { meta: { approach, seed: seedArg, generated: new Date().toISOString(), notes: "Corpus is disposable; eval-set.json is the durable question bank." }, questions: [] };

function write(rel, content) {
  const p = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// ---------- approach: prose ----------
function genProse() {
  const topics = {
    ops: ["deploy","rollback","alert","oncall","ticket","runbook","incident","queue","socket","cluster"],
    kitchen: ["sourdough","starter","brine","chili","dutch oven","ferment","miso","galangal","char","glaze"],
    astronomy: ["comet","perihelion","guide camera"," exposures","photometry"," occultation","declination","sky flat","seeing","ephemeris"],
  };
  const needleDefs = [
    ["N1", "The primary Postgres write replica listens on port 5434, not the default.", "5434"],
    ["N2", "Incident INC-2271 was opened on 2026-08-14 for the replication lag spike.", "2271"],
    ["N3", "The failover service account is named THROTTLEMAN.", "throttleman"],
    ["N4", "The legacy exporter still binds to port 4417.", "4417"],
    ["N5", "Grafana lives at 10.42.7.19 behind the ops VLAN.", "10.42.7.19"],
    ["N6", "The pool caps at 250 sessions per shard before queueing.", "250"],
    ["N7", "Snapshot maintenance runs Tuesday 03:00 UTC.", "03:00"],
    ["N8", "The on-call escalation owner is Priya Raghunathan.", "priya raghunathan"],
    ["N9", "The vault unlock prefix for this quarter is 9f3a.", "9f3a"],
    ["N10", "The unused vendor credit totals $12,400.", "12,400"],
  ];
  const files = 10;
  const perFile = 26;
  for (let f = 0; f < files; f++) {
    const t = topics.ops;
    const L = [];
    for (let s = 0; s < perFile; s++) {
      L.push(`Section ${s + 1}.`);
      for (let para = 0; para < 3; para++) {
        L.push(`${t[ri(0, t.length - 1)]} review ${ri(100, 999)}: the ${t[ri(0, t.length - 1)]} workflow was audited against the ${t[ri(0, t.length - 1)]} baseline and ${t[ri(0, t.length - 1)]} follow-ups were logged for the next rotation. Checks covered ${t[ri(0, t.length - 1)]} hygiene, ${t[ri(0, t.length - 1)]} drift, and ${t[ri(0, t.length - 1)]} ownership; no action was required beyond routine ${t[ri(0, t.length - 1)]} bookkeeping.`);
      }
      const n = needleDefs[f];
      if (s === 12) L.push(n[1]);
    }
    write(`ops-${String(f + 1).padStart(2, "0")}.txt`, L.join("\n") + "\n");
  }
  evalSet.questions = needleDefs.map(([id, sentence, expect]) => ({ id, kind: "fact", ask: sentence, expect: [expect] }));
}

// ---------- approach: code ----------
const CODE_MODULES = [
  ["codec-lzw","LZW_MAX_CODE_WIDTH","19","decompressLZWChunks","variable-width LZW decompression"],
  ["auth-jwt","JWT_LEEWAY_SECONDS","47","verifyJwtKeyStamp","JWT key-stamp verification"],
  ["ds-heap","HEAP_SHRINK_RATIO","0.31","rebalanceHeapNodes","lazy binary heap rebalancing"],
  ["archive-tar","TAR_BLOCK_SIZE","7168","extractTarMemberStream","tar member extraction"],
  ["net-ratelimit","RL_BUCKET_TTL_MS","91000","sweepRateLimiterBuckets","token-bucket sweeper"],
  ["semver-tags","SEMVER_MAX_TAGS","9","decodeSemverPrerelease","prerelease tag decoding"],
  ["text-diff","DIFF_CONTEXT_RADIUS","23","diffWithBlockedHunks","hunk-blocked diffing"],
  ["fuzzy-match","LEVENSHTEIN_BAND_K","13","boundedLevenshteinSweep","banded edit distance"],
  ["id-uuid7","UUID7_CLOCK_DRIFT_GUARD","61","parseUuid7Fraction","uuid7 fraction parsing"],
  ["geo-toposort","TOPO_CYCLE_PROBE_DEPTH","29","probeTopoCycleFromNode","cycle probing in DAGs"],
];
const SCORED_CONST = ["codec-lzw","auth-jwt","net-ratelimit","archive-tar","ds-heap","text-diff"];
const SCORED_FN = ["codec-lzw","auth-jwt","net-ratelimit","archive-tar","ds-heap","text-diff"];

function genCodeModule(name, cn, cv, fn, purpose, extraFns) {
  const L = [];
  const p = (s = "") => L.push(s);
  const target = ri(300, 395);
  p(`// ${name}.ts — ${purpose}.`);
  p("// Synthetic module for a context-management corpus; no external imports.");
  p("");
  const Cap = fn[0].toUpperCase() + fn.slice(1);
  p(`export interface ${Cap}Options {`);
  p("  strict: boolean;");
  p("  budget: number;");
  p("  tags?: string[];");
  p("}");
  p("");
  p(`export const ${cn} = ${cv};`);
  p("");
  p(`/** ${purpose} — primary entry point. */`);
  p(`export function ${fn}(`);
  p("  input: Uint8Array | string,");
  p(`  options: ${Cap}Options,`);
  p("): Map<string, number> {");
  p("  const ledger = new Map<string, number>();");
  p(`  const budget = options.budget > 0 ? options.budget : ${cn};`);
  p("  let cursor = 0;");
  p("  while (cursor < input.length) {");
  p("    const span = Math.min(budget & 0xff, input.length - cursor);");
  p(`    const chunk = typeof input === "string" ? input.slice(cursor, cursor + span) : input.subarray(cursor, cursor + span);`);
  p("    const key = options.strict ? String(chunk.length) : String(chunk).slice(0, 24);");
  p("    ledger.set(key, (ledger.get(key) ?? 0) + span);");
  p("    cursor += span;");
  p("  }");
  p("  if (options.tags) {");
  p('    for (const t of options.tags) ledger.set("tag:" + t, cursor);');
  p("  }");
  p("  return ledger;");
  p("}");
  let g = 0;
  while (L.length < target - 14 - extraFns * 5) {
    const word = GREEK[g % GREEK.length];
    const idx = Math.floor(g / GREEK.length) + 1;
    const kind = g % 4;
    p("");
    if (kind === 0) {
      p(`function ${word}Helper${idx}(acc: number, step: number): number {`);
      p("  let out = acc;");
      p("  for (let i = 0; i < step; i++) out = (out * 31 + i) & 0xffff;");
      p("  return out;");
      p("}");
    } else if (kind === 1) {
      p(`const ${word}Table${idx}: readonly number[] = [`);
      p("  " + Array.from({ length: ri(3, 6) }, () => ri(0, 255)).join(", ") + ",");
      p("];");
    } else if (kind === 2) {
      p(`export interface ${word[0].toUpperCase() + word.slice(1)}Shape${idx} {`);
      p("  id: number;");
      p("  label: string;");
      p("  weight?: number;");
      p("}");
    } else {
      p(`function ${word}Fold${idx}(rows: ${word[0].toUpperCase() + word.slice(1)}Shape${Math.max(1, idx - 1)}[]): number {`);
      p(`  return rows.reduce((n, r) => n + (r.weight ?? r.id), 0) % ${ri(97, 999)};`);
      p("}");
    }
    g++;
  }
  p("");
  p(`export const ${name.replace(/-/g, "_").toUpperCase()}_READY = true;`);
  while (L.length > 400) L.splice(L.length - 2, 1);
  return L.join("\n") + "\n";
}

function genCode() {
  const wave2 = Array.from({ length: 20 }, (_, i) => {
    const name = `util-wave2-${String(i + 1).padStart(2, "0")}`;
    return [name, `W2_${String(i + 1).padStart(2, "0")}_BUDGET`, String(ri(11, 99)), `applyWave2Rule${i + 1}`, `wave-2 filler utility ${i + 1}`];
  });
  for (const [name, cn, cv, fn, purpose] of [...CODE_MODULES, ...wave2]) {
    const src = genCodeModule(name, cn, cv, fn, purpose, 0);
    write(`src/${name}.ts`, src);
  }
  evalSet.questions = [
    ...SCORED_CONST.map((mod) => {
      const def = CODE_MODULES.find((m) => m[0] === mod);
      return { id: `C-${mod}`, kind: "fact", ask: `What is the value of ${def[1]}?`, expect: [String(def[2])] };
    }),
    ...SCORED_FN.map((mod) => {
      const def = CODE_MODULES.find((m) => m[0] === mod);
      return { id: `F-${mod}`, kind: "location", ask: `Which file defines ${def[3]}?`, expect: [`${mod}.ts`, `src/${mod}.ts`] };
    }),
  ];
}

// ---------- approach: hybrid ----------
const HYBRID_REQS = [
  ["REQ-114","auth-jwt","verifyJwtKeyStamp","JWT key-stamp verification MUST reject stamps older than JWT_LEEWAY_SECONDS."],
  ["REQ-077","codec-lzw","decompressLZWChunks","The LZW decoder MUST cap code width at LZW_MAX_CODE_WIDTH bits."],
  ["REQ-233","net-ratelimit","sweepRateLimiterBuckets","Expired buckets MUST be swept at RL_BUCKET_TTL_MS intervals, not lazily."],
  ["REQ-056","archive-tar","extractTarMemberStream","Tar members MUST stream in TAR_BLOCK_SIZE multiples without buffering the whole file."],
  ["REQ-188","text-diff","diffWithBlockedHunks","Diffs MUST suppress hunks inside protected regions (DIFF_CONTEXT_RADIUS)."],
  ["REQ-341","semver-tags","decodeSemverPrerelease","At most SEMVER_MAX_TAGS prerelease tags MUST be accepted."],
  ["REQ-402","math-quat","slerpWithNudge","Slerp MUST nudge near-parallel quaternions beyond QUAT_NORM_EPSILON."],
  ["REQ-519","parse-cron","expandCronDowField","Cron day-of-week MUST expand as a 6-bit bitmap (CRON_DOW_BITMAP_MASK)."],
];
const HYBRID_DECISIONS = [
  ["D-3","codec-lzw","LZW code width grows lazily instead of being fixed, so decompressLZWChunks stays allocation-flat.","Chose lazy width growth over a fixed 16-bit table after profiling overflow paths."],
  ["D-9","net-ratelimit","Sweeping runs on a timer rather than on request; sweepRateLimiterBuckets owns the TTL math.","Lazy sweeps let cold buckets pin memory indefinitely; a timer bounded memory in the load test."],
  ["D-21","archive-tar","TAR_BLOCK_SIZE is deliberately non-standard (7168) to match the cold-storage appliance sector size.","Standard 512/10240 blocks caused read-modify-write amplification on the appliance."],
  ["D-33","math-quat","Slerp nudges by the smallest representable angle instead of failing when quaternions are near-parallel.","Callers in the animation loop cannot handle thrown errors per-frame."],
];
const HYBRID_PLAN = [
  ["M1","codec-lzw + auth-jwt","Land the decoders first: decompressLZWChunks and verifyJwtKeyStamp unblock the ingest pipeline."],
  ["M2","net-ratelimit + archive-tar","Sweeper and tar streaming follow; sweepRateLimiterBuckets shares the timer wheel with ingest."],
  ["M4","parse-cron + semver-tags","Scheduler expansion and tag decoding land together; expandCronDowField feeds the M2 timer wheel."],
];

function genHybrid() {
  genCode();
  const codeQs = evalSet.questions;
  let out = [];
  out.push("# Requirements — synthetic ingest platform\n");
  for (const [id, mod, fn, text] of HYBRID_REQS) {
    out.push(`## ${id} (${mod}.ts)\n`);
    out.push(`${text}\n`);
    out.push(`Acceptance: exercise \`${fn}\` directly; no other entry point may be used.\n`);
  }
  write("requirements.md", out.join("\n"));
  out = ["# Design decisions — synthetic ingest platform\n"];
  for (const [id, mod, choice, why] of HYBRID_DECISIONS) {
    out.push(`## ${id} — ${mod}.ts\n`);
    out.push(`Choice: ${choice}\n`);
    out.push(`Rationale: ${why}\n`);
  }
  write("design.md", out.join("\n"));
  out = ["# Plan — synthetic ingest platform\n"];
  for (const [m, mods, text] of HYBRID_PLAN) {
    out.push(`## ${m}: ${mods}\n`);
    out.push(`${text}\n`);
  }
  write("plan.md", out.join("\n"));
  evalSet.questions = [
    ...codeQs,
    { id: "X-req-verifyJwtKeyStamp", kind: "crossref", ask: "Which requirement covers verifyJwtKeyStamp?", expect: ["REQ-114"] },
    { id: "X-dec-sweepRateLimiterBuckets", kind: "crossref", ask: "Which decision covers sweepRateLimiterBuckets?", expect: ["D-9"] },
    { id: "X-milestone-extractTarMemberStream", kind: "crossref", ask: "Which plan milestone mentions extractTarMemberStream?", expect: ["M2"] },
    { id: "X-req-lzw-width", kind: "crossref", ask: "Which requirement caps the LZW code width?", expect: ["REQ-077"] },
    { id: "X-fn-REQ-233", kind: "crossref", ask: "Which function implements REQ-233?", expect: ["sweepRateLimiterBuckets"] },
    { id: "X-detail-D-21", kind: "detail", ask: "What non-standard block size does decision D-21 set, and for what hardware reason?", expect: ["7168", "appliance", "sector"] },
    { id: "X-fn-REQ-402", kind: "crossref", ask: "Which requirement binds QUAT_NORM_EPSILON, and to which function?", expect: ["REQ-402", "slerpWithNudge"] },
  ];
}

if (approach === "prose") genProse();
else if (approach === "code") genCode();
else if (approach === "hybrid") genHybrid();
else { console.error("unknown approach"); process.exit(1); }

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "eval-set.json"), JSON.stringify(evalSet, null, 2));
console.log(`approach=${approach} seed=${seedArg} out=${outDir} questions=${evalSet.questions.length}`);
