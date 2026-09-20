# Empirical Test: Forcing Pi Skills to Auto-Load

**Date:** 2026-09-20
**Harness:** pi 0.85.1
**Harness:** `test/skill-autoload/` — run with `node run-experiment.mjs` (see README.md)
**Models:** `litellm/minimax` (non-reasoning, `thinking: no`) and `litellm/deepseek-reasoner` (emits typed thinking blocks, also labelled `thinking: no`)
**Test workspace:** staged to a temp dir per run (`.pi/` is gitignored, so fixtures are copied in)
**Skill under test:** `vague-task` (`.pi/skills/vague-task/SKILL.md`)
**Detection:** grep session `.jsonl` for a `read` call on `vague-task/SKILL.md`

## Headline result

| Approach | Loaded | Rate |
|---|---|---|
| Baseline — vague description | 2/11 | ~18% |
| Baseline — **specific** description | 1/11 | ~9% |
| Option B — "MANDATORY" system-prompt instruction | 1/5 | 20% |
| Option A — custom `load_skill` tool + instruction | 0/10 | 0% |
| Option C — typed thinking-block scan | 0/5 | n/a (no thinking blocks exposed) |
| Option C-fallback — inline `<think>` text scan | 1/5 | 20% (coincidental) |
| **Explicit `/skill:name` invocation** | **3/3** | **100%** |

**None of the "force it" approaches beat doing nothing by a meaningful margin.
Only explicit user invocation was reliable.**

## Test prompts (5)

1. `research the topic of memory consolidation`  (trigger word: research)
2. `tell me a joke about cats`  (control — no trigger)
3. `study the history of the printing press`  (trigger word: study)
4. `what is 2 plus 2?`  (control)
5. `investigate the causes of the french revolution`  (trigger word: investigate)

Baseline loaded on prompts 3 and 5 only. Prompts 1, 2, 4 never loaded.

## What each option actually did

**Option A (custom `load_skill` tool).** The tool registered correctly — after
fixing the schema format (pi needs TypeBox `parameters: Type.Object({...})`, not
raw JSON Schema; the wrong form produced
`400: "function parameters is empty (2013)"` from the provider).
But in 10 runs (5 with all tools, 5 with web search excluded) the model **never
called it once**. It preferred `secure_web_search`, `mcp_searxng_tools`, `bash`,
`task_create`, and `read` instead. A custom tool competes poorly against
built-in tools in the model's selection ranking.

**Option B (MANDATORY instruction).** The model's own traces show it *saw* the
instruction and *considered* the skill in 4/5 prompts — then declined to read
it. Raising salience changed consideration, not compliance.

**Option C (thinking scan).** Mechanically correct, but:
- typed thinking blocks: **0 exposed** on this model, so the intended path never fires
- inline `<think>` fallback: fired once, but only because the model's own
  narration contained the word "vague" (`/"seems too vague to match"/`) — a
  circular, coincidental trigger
- the injected skill was then **ignored** (final answer used a numbered outline,
  not the skill's requested 3-part structure)

**Latency (controlled, same prompt, n=3):**
- baseline: 30.0 / 33.9 / 36.1 s
- option-c-fallback: 24.5 / 42.9 / 108.4 s  (up to 3.2x, high variance)

**Assistant turns across 5 prompts:** baseline 10, option-b 11, option-a 8,
option-c-fallback 12.

## Secondary findings

- **Better descriptions did not help here.** A trigger-rich description
  ("Use when the user asks you to research, study, investigate...") scored
  1/11; the vague "Helpful utility skill." scored 2/11. Difference is inside
  noise. Description quality matters at the margin, but does not rescue
  auto-activation on this model.
- **The model reasons about skills explicitly** — its traces literally say
  "Let me check the available skills first" and "none of these skills are for
  historical research." The routing decision is being made; it just usually
  resolves to "don't load."
- **pi does not serialize the system prompt** into the session `.jsonl`, so
  extension-injected system-prompt text is not directly greppable. Use the
  model's own visible reasoning instead.

## Caveats

- Small n (5–11 samples per condition), single mid-tier model, one skill.
- Percentages carry wide error bars; treat them as "low and unreliable," not
  precise.
- The typed-thinking path is **untested**, not disproven — it needs a model with
  `thinking: yes` (e.g. `openai-codex/*`; auth was broken during this test).

## Recommendation

1. **If a skill must load, invoke it explicitly** — `/skill:name`, or put the
   instruction in `CLAUDE.md`/`AGENTS.md` as a hard rule. This was the only
   100% path.
2. **Do not build stream/thinking-regex machinery** for this. It is
   coincidental, adds turns, and multiplies latency up to 3x.
3. **Do not rely on a custom `load_skill` tool** to beat built-in tools in the
   model's selection ranking — it lost 0/10.
4. Description quality is still worth doing (it is free and helps at the
   margin), but treat auto-activation as best-effort, never as a guarantee.

---

# ADDENDUM (THINK round): typed thinking blocks on a reasoning model

Codex OAuth was stale (access token expired 2026-08-10, now 2026-09-20, refresh
invalid; no CLI re-login subcommand). Instead, `litellm/deepseek-reasoner` was
found to emit **typed thinking blocks** despite pi's registry showing
`thinking: no` — that flag governs settable thinking LEVELS, not whether
reasoning content is returned.

## Results (n=20 per config: 5 prompts x 2 reps x 2 rounds)

| Config | Skill applied |
|---|---|
| baseline (reasoning model) | **14/20 = 70%** |
| + thinking-scan, precise trigger | 12/20 = 60% |
| + thinking-scan, broad trigger | 5/10 = 50% |

**The extension did not beat baseline — and the broad trigger hurt.**

## Interpretation

A reasoning model's own chain-of-thought already deliberates about skills
("there's a 'vague-task' skill available... let me read it") and acts on it
~70% of the time. Intercepting that thinking to inject the skill adds nothing,
and a coarse trigger pollutes context on irrelevant prompts ("tell me a joke",
"what is 2 plus 2?").

**The decisive variable is the model, not the extension:**
reasoning ~70% vs non-reasoning ~15%.

## Correction to earlier rounds

The n=5 typed run showed baseline 1/5 vs extension 3/5, suggesting the extension
helped. At n=20 that reversed. **The n=5 signal was noise** — a reminder that the
earlier ~10-20% figures also carry wide error bars.

## Test-validity notes

- pi auto-discovers `.pi/extensions/*.ts`; un-isolated runs load every extension
  ever written. Use `--no-extensions` + explicit `-e` for clean configs.
- pi's registry `thinking: no` means *no settable thinking LEVELS* — it does not
  mean the model returns no reasoning. `deepseek-reasoner` emits typed
  `{type:"thinking", thinking, thinkingSignature}` blocks despite the label.
- "mandatory skill check" in model traces is pi's BASE prompt being paraphrased
  ("Use the read tool to load a skill's file when the task matches its
  description"), not evidence of an installed hook.

## Full six-config matrix (n=10 per config, deepseek-reasoner)

Produced by `node run-experiment.mjs --configs baseline,option-a-tool,option-b-mandatory,option-c-broad,option-c-precise,option-c-inline --reps 2`.

| config | injected | applied | read | avg_s |
|---|---|---|---|---|
| baseline (no extension) | 0/10 | **8/10** | 9/10 | 5.4 |
| option-b-mandatory | 0/10 | 9/10 | 10/10 | 6.7 |
| option-c-broad | 8/10 | 7/10 | 7/10 | 4.5 |
| option-c-inline | 0/10 | 6/10 | 6/10 | 4.1 |
| option-a-tool | 0/10 | 6/10 | 2/10 | **35.3** |
| option-c-precise | 7/10 | 5/10 | 5/10 | 5.9 |

Confirms the headline. Notable additions:

- **option-b-mandatory 9/10 is the only config nominally above baseline** — but
the gap (9 vs 8 of 10) is well inside noise at this n, and the extension has an
observable side effect: it injects on every turn regardless of relevance.
- **option-a-tool is 6.5x slower** (35.3s vs 5.4s avg) *and* worse (6/10),
  with a collapsed `read` rate (2/10) — the custom tool competes with built-ins
  and loses, while adding latency.
- **option-c-precise actively hurts** (5/10 vs baseline 8/10). Precision on the
  trigger did not help; fewer injections correlated with fewer applications.
- `option-c-inline` never injects on this model (0/10) — expected, since
  deepseek-reasoner emits typed thinking blocks, not inline `<think>` text.

Net: **do nothing, or change the model.** Every extension is either
within-noise equal, worse, or slower.

## Reproduce

```bash
node test/skill-autoload/run-experiment.mjs --reps 2
```

Scratch sessions are written under the staged temp workspace and discarded
unless `--keep` is passed.
