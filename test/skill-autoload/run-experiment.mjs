#!/usr/bin/env node
/**
 * Skill auto-load experiment harness.
 *
 * Measures how reliably a pi skill gets loaded/applied under different
 * strategies (baseline vs. custom tool vs. system-prompt nudge vs.
 * thinking-block scan), across non-reasoning and reasoning models.
 *
 * See FINDINGS.md for results and README.md for usage.
 *
 * Why it stages a temp workspace: pi discovers skills from `<cwd>/.pi/skills`,
 * but `.pi/` is gitignored in this repo. So we copy the fixture skill into a
 * throwaway workspace and run pi with that cwd, keeping `--no-extensions` on so
 * only the extension under test is loaded (pi otherwise auto-discovers every
 * `.ts` in `.pi/extensions/`).
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const EXT_DIR = join(FIXTURES, "extensions");
const SKILL_SRC = join(FIXTURES, "skill");

const DEFAULT_PROMPTS = [
  "research the topic of memory consolidation",
  "tell me a joke about cats",
  "study the history of the printing press",
  "what is 2 plus 2?",
  "investigate the causes of the french revolution",
];

const CONFIGS = {
  baseline: null,
  "option-a-tool": join(EXT_DIR, "option-a-load-tool.ts"),
  "option-b-mandatory": join(EXT_DIR, "option-b-mandatory.ts"),
  "option-c-broad": join(EXT_DIR, "option-c-typed.ts"),
  "option-c-precise": join(EXT_DIR, "option-c-precise.ts"),
  "option-c-inline": join(EXT_DIR, "option-c-inline-scan.ts"),
};

// ---------- args ----------
const argv = process.argv.slice(2);
const getFlag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const hasFlag = (name) => argv.includes(name);

const provider = getFlag("--provider", "litellm");
const model = getFlag("--model", "deepseek-reasoner");
const reps = Number(getFlag("--reps", "1"));
const configNames = getFlag("--configs", "baseline,option-c-broad,option-c-precise").split(",");
const keep = hasFlag("--keep");

// ---------- workspace staging ----------
function stageWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "skill-autoload-"));
  const skillsDir = join(ws, ".pi", "skills");
  mkdirSync(skillsDir, { recursive: true });
  cpSync(SKILL_SRC, skillsDir, { recursive: true });
  return { ws, skillsDir };
}

// ---------- one run ----------
function runOnce({ ws, skillsDir }, extPath, prompt, tag) {
  const sessionDir = join(ws, "sessions", tag);
  rmSync(sessionDir, { recursive: true, force: true });
  mkdirSync(sessionDir, { recursive: true });

  const args = [
    "--provider", provider,
    "--model", model,
    "--approve", "-p",
    "--no-extensions",
    "--session-dir", sessionDir,
  ];
  if (extPath) args.push("--extension", extPath);
  args.push(prompt);

  const t0 = Date.now();
  spawnSync("pi", args, {
    cwd: ws,
    stdio: "ignore",
    env: { ...process.env, SKILL_AUTOLOAD_SKILLS_DIR: skillsDir },
  });
  const durSec = (Date.now() - t0) / 1000;

  const file = findSession(sessionDir);
  if (!file) return { error: "no session written" };
  return { ...analyze(file), durSec };
}

function findSession(dir) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = readdirSyncSafe(d); } catch { continue; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith(".jsonl")) return p;
    }
  }
  return null;
}

function readdirSyncSafe(d) {
  return readdirSync(d, { withFileTypes: true });
}

function analyze(file) {
  const out = { injected: 0, turns: 0, read: false, applied: false };
  let lastText = "";
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type === "custom_message" && String(d.customType || "").includes("auto-skill")) {
      out.injected += 1;
    }
    if (d.type !== "message") continue;
    const m = d.message || {};
    if (m.role !== "assistant") continue;
    out.turns += 1;
    for (const c of m.content || []) {
      if (!c || typeof c !== "object") continue;
      if (c.type === "text" && c.text) lastText = c.text;
      if (c.type === "toolCall" && c.name === "read") {
        if (String(c.arguments?.path || "").includes("vague-task/SKILL.md")) out.read = true;
      }
    }
  }
  // The fixture skill mandates a "**Bottom line**" section, so its presence in
  // the final answer text is the application signal.
  out.applied = /bottom line/i.test(lastText);
  return out;
}

// ---------- main ----------
const unknowns = configNames.filter((c) => !(c in CONFIGS));
if (unknowns.length) {
  console.error(`Unknown config(s): ${unknowns.join(", ")}\nAvailable: ${Object.keys(CONFIGS).join(", ")}`);
  process.exit(1);
}
if (!existsSync(join(SKILL_SRC, "vague-task", "SKILL.md"))) {
  console.error(`Missing fixture skill at ${SKILL_SRC}/vague-task/SKILL.md`);
  process.exit(1);
}

console.log(`provider/model : ${provider}/${model}`);
console.log(`prompts        : ${DEFAULT_PROMPTS.length} x ${reps} rep(s)`);
console.log(`configs        : ${configNames.join(", ")}\n`);

const { ws, skillsDir } = stageWorkspace();
if (keep) console.log(`workspace kept : ${ws}\n`);

const rows = [];
try {
  for (const name of configNames) {
    const extPath = CONFIGS[name];
    const agg = { n: 0, injected: 0, applied: 0, read: 0, turns: 0, dur: 0 };
    for (let r = 0; r < reps; r++) {
      for (const prompt of DEFAULT_PROMPTS) {
        const tag = `${name}-${r}-${Math.abs(hash(prompt)) % 100000}`;
        const res = runOnce({ ws, skillsDir }, extPath, prompt, tag);
        if (res.error) { console.log(`  ${name} [${prompt.slice(0, 34)}] ERROR ${res.error}`); continue; }
        agg.n += 1;
        agg.injected += res.injected ? 1 : 0;
        agg.applied += res.applied ? 1 : 0;
        agg.read += res.read ? 1 : 0;
        agg.turns += res.turns;
        agg.dur += res.durSec;
        console.log(
          `  ${name.padEnd(20)} [${prompt.slice(0, 34).padEnd(34)}] ` +
          `inj=${res.injected} applied=${res.applied ? "Y" : "n"} read=${res.read ? "Y" : "n"} ` +
          `turns=${res.turns} ${res.durSec.toFixed(1)}s`
        );
      }
    }
    if (agg.n) rows.push({ name, ...agg });
  }
} finally {
  if (!keep) rmSync(ws, { recursive: true, force: true });
}

console.log("\n=== SUMMARY ===");
console.log(
  `${"config".padEnd(20)} ${"injected".padStart(9)} ${"applied".padStart(9)} ${"read".padStart(8)} ${"n".padStart(4)} ${"avg_s".padStart(7)}`
);
for (const r of rows) {
  console.log(
    `${r.name.padEnd(20)} ` +
    `${r.injected + "/" + r.n}`.padStart(9) + " " +
    `${r.applied + "/" + r.n}`.padStart(9) + " " +
    `${r.read + "/" + r.n}`.padStart(8) + " " +
    `${r.n}`.padStart(4) + " " +
    `${(r.dur / r.n).toFixed(1)}`.padStart(7)
  );
}
console.log(
  "\nNote: `applied` = final answer used the fixture skill's mandated " +
  "'**Bottom line**' structure. Reasoning models auto-apply at a far higher\n" +
  "baseline than non-reasoning models; extensions do not beat that baseline."
);

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
