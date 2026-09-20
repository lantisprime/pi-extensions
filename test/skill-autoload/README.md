# Skill auto-load experiment

A reproducible harness for one question: **can a pi skill be made to load
reliably when the trigger signal lives in the model's own chain-of-thought?**

It measures four strategies against a baseline across two model classes.

**Headline result: the decisive variable is the model, not the extension.**
A reasoning model's chain-of-thought already drives skill loading at ~70%
unaided; a non-reasoning model manages ~10-20%; no extension beats doing
nothing, and one actively hurts. Explicit `/skill:name` is the only 100% path.

Full results, tables, and caveats: [FINDINGS.md](./FINDINGS.md).

## Layout

```
test/skill-autoload/
├── README.md                 # this file
├── FINDINGS.md               # full findings + methodology
├── run-experiment.mjs        # the runner (Node ESM)
└── fixtures/
    ├── extensions/           # one .ts per strategy under test
    │   ├── option-a-load-tool.ts     # custom load_skill tool + system-prompt instruction
    │   ├── option-b-mandatory.ts     # forceful "MANDATORY skill check" via before_agent_start
    │   ├── option-c-typed.ts         # scan TYPED thinking blocks, inject on broad trigger
    │   ├── option-c-precise.ts       # same, but only on intent-to-load phrasing
    │   └── option-c-inline-scan.ts   # scan inline <think> text (non-reasoning models)
    └── skill/vague-task/SKILL.md     # fixture skill; mandates a "**Bottom line**" section
```

## Running

```bash
# default: baseline + broad + precise, 1 rep, litellm/deepseek-reasoner
node test/skill-autoload/run-experiment.mjs

# all strategies, 2 reps
node test/skill-autoload/run-experiment.mjs \
  --configs baseline,option-a-tool,option-b-mandatory,option-c-broad,option-c-precise,option-c-inline \
  --reps 2

# a non-reasoning model (expect a much lower baseline)
node test/skill-autoload/run-experiment.mjs --model minimax --reps 1

# keep the staged temp workspace for inspection
node test/skill-autoload/run-experiment.mjs --keep
```

| Flag | Default | Meaning |
|---|---|---|
| `--provider` | `litellm` | pi provider |
| `--model` | `deepseek-reasoner` | pi model id |
| `--reps` | `1` | repetitions of the 5-prompt battery per config |
| `--configs` | `baseline,option-c-broad,option-c-precise` | comma-separated config names |
| `--keep` | off | preserve the staged temp workspace |

## How it works (and why it stages a workspace)

pi discovers skills from `<cwd>/.pi/skills`, but `.pi/` is **gitignored** in this
repo — so fixtures can't live there. The runner therefore:

1. `mkdtemp`s a throwaway workspace and copies `fixtures/skill/` into
   `<ws>/.pi/skills/`.
2. Runs `pi` with `cwd=<workspace>` and `SKILL_AUTOLOAD_SKILLS_DIR=<ws>/.pi/skills`
   so extensions can locate the skill regardless of where the repo lives.
3. Always passes `--no-extensions`, adding exactly one `--extension` for the
   config under test.

**Step 3 matters.** pi auto-discovers every `.ts` under `.pi/extensions/`. An
un-isolated run silently loads every extension present, which is how the first
attempt at this experiment produced invalid "baseline" numbers.

## Metrics

| Metric | Meaning |
|---|---|
| `injected` | extension fired (`custom_message` with an `auto-skill*` type) |
| `applied` | final answer used the fixture skill's mandated `**Bottom line**` structure |
| `read` | model issued a `read` tool call on `vague-task/SKILL.md` |
| `turns` | assistant turns in the session |
| `avg_s` | wall-clock seconds per run |

`applied` is the metric that matters — it is the observable behavior, not the
model's narration.

## Notes for re-running

- **Small samples lie here.** At `n=5` the typed-thinking extension looked like a
  win (baseline 1/5 vs 3/5); at `n=20` it reversed. Use `--reps 2+` before
  drawing conclusions.
- **`thinking: no` in pi's model registry does not mean the model returns no
  reasoning.** It means no *settable thinking levels*. `deepseek-reasoner` shows
  `thinking: no` yet emits typed `{type:"thinking", thinking, thinkingSignature}`
  blocks. Any OpenAI-compatible reasoner on the gateway may behave the same.
- **`openai-codex` is the only registry provider with `thinking: yes`**, but its
  OAuth token expired 2026-08-10 and there is no CLI re-login subcommand.
- The fixture skill's description is deliberately vague ("Helpful utility
  skill.") to make auto-loading hard. A trigger-rich description scored no better
  (1/11 vs 2/11 — inside noise), but if you change it, note the comparison in
  FINDINGS.md no longer applies.

## Findings record

Durable episodes (survive this checkout):

- `20260920-003433-pi-skill-auto-load-the-decisive-variable-6a1f` — global lesson
- `20260920-003641-full-experimental-record-forcing-pi-skil-192a` — global research record
- `20260920-002541-pi-registertool-needs-typebox-parameters-ad5c` — local discovery (tool schema gotcha)

## Related technical gotcha

If you write a custom pi tool for this harness, use **TypeBox**, not raw JSON
Schema:

```typescript
import { Type } from "typebox";
pi.registerTool({
  name: "load_skill",
  parameters: Type.Object({ skill_name: Type.String() }), // NOT inputSchema: {...}
  async execute(toolCallId, params) { /* ... */ },
});
```

Raw JSON Schema under `inputSchema` yields
`400: litellm... invalid params, function parameters is empty (2013)`.
