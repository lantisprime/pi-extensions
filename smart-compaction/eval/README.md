# smart-compaction evals — how to use the tests

Two layers of testing live in this repo:

| Layer | Where | What it proves | Needs live pi? |
|---|---|---|---|
| **Unit + wiring tests** | `smart-compaction/test/` | decision math, guards, telemetry shape, wiring lifecycle over mock inputs | no |
| **Needle-in-a-haystack evals** | `smart-compaction/eval/` (this guide) | real trigger behavior, real summarizer retention, doc↔code link survival, gate routing — per model | yes |

Method + results rationale: [`../TESTING.md`](../TESTING.md). This file is the
operating manual.

---

## Part A — unit + wiring tests (fast, no live pi)

```bash
cd smart-compaction
node --experimental-strip-types --test test/engine.test.ts test/task-subjects.test.ts test/wiring.test.ts
```

Expect `tests 46 / pass 46`. What each file covers:

- `engine.test.ts` — decision math: refusal ladder ordering, economy
  savings/cost inequality, floor derivation, min-interval, pricing
  precedence (catalog > explicit pin > derived > fallback).
- `task-subjects.test.ts` — task-board parsing and subject extraction.
- `wiring.test.ts` — mock-API harness over real event wiring
  (`turn_end`/`agent_settled` lifecycles, telemetry records, compaction
  triggers). Wiring bugs get wiring tests here.

Type check (use the pinned tsc; 7.x breaks on the repo's tsconfig `baseUrl`):

```bash
~/.npm/_npx/85a4f22d502a8066/node_modules/.bin/tsc --noEmit
```

These tests CANNOT tell you what a real session does with real model prices,
a real summarizer, or real telemetry. That is Part B.

---

## Part B — needle-in-a-haystack evals (live, per model)

### Step 0 — pick an approach

| Approach | Question bank | Measures | Corpus size at default seed |
|---|---|---|---|
| `prose` | 10 facts | baseline fact retention (run BOTH anchoring variants — anchoring dominates the outcome) | 10 files ≈ 15–18 files×12k tok to cross the floor |
| `code` | 6 constants + 6 fn→file | identifier retention through compaction | 30 modules, 200–400 LOC (≈2.4k tok each) |
| `hybrid` | code bank + 7 doc↔code cross-refs | requirements/design/plan ↔ code link survival; catches plausible-name hallucination | code corpus + 3 docs |

### Step 1 — generate corpus + question bank

```bash
cd smart-compaction/eval
node generate.mjs --approach code --out /tmp/sc-eval-code --seed 20261004
# same for --approach prose / --approach hybrid
```

Deterministic per seed → runs are comparable across models and extension
versions. `eval-set.json` (the durable question bank) lands inside the out
dir; the corpus itself is disposable.

### Step 2 — scratch project config

Create `<out>/.pi/smart-compaction.json` for the model under test. Config is
loaded ONCE at session start — changing it requires a fresh pane.

```json
{
  "profiles": [
    {
      "match": "litellm/minimax",
      "mode": "cost",
      "gate": { "enabled": true, "aggressiveBelow": 0.35, "deferAbove": 0.7 }
    }
  ]
}
```

- `match` must equal the model key shown in the pane footer.
- `gate.enabled: false` removes the Jev dependency when you only want
  trigger/retention numbers.

### Step 3 — fresh pane (herdr tab, house style)

```bash
test "${HERDR_ENV:-}" = 1   # must be 1, else you are not inside herdr
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd /tmp/sc-eval-code --label eval-code --no-focus
# note .result.root_pane.pane_id from the JSON, then:
herdr agent start <name> --kind pi --pane <pane-id> --timeout 60000
```

- `<name>`: `[a-z][a-z0-9_-]{0,31}`, e.g. `eval-code`.
- **cwd gotcha (macOS):** use the RESOLVED path (`/private/tmp/...`). A `/tmp`
  cwd makes pi treat reads as outside-project → permission wedge.
- **Fresh process is mandatory** — running panes never reload extension code.
  Stale long-lived sessions running old code produced the original
  "compacts at 2%" false report.

### Step 4 — search turn (establishes needle evidence in tool results)

```text
You are part of a context-management experiment. <dir layout one-liner>.
Rules: do exactly what each instruction asks; keep replies minimal; never
quote file content beyond exactly what the instruction asks for.

INSTRUCTION 1 (search phase): Using bash grep, locate the definitions of
<needles> across <dir>. Reply with ONLY filename:line for each, nothing else.
```

Hybrid variant searches the `.md` docs instead: "locate the requirement that
covers <fn>, the decision that covers <fn>, the milestone that mentions <fn>.
Reply with ONLY the identifiers."

### Step 5 — growth turns (silent reads; this is the anchoring control)

```text
INSTRUCTION n (growth): Read these files in full (use offset reads if output
truncates): <batch>. Reply with exactly: files read
```

- **Batch sizing:** target `floor = 0.15 × window` tokens. Examples
  (1,048,576 window → floor 157,286): code ≈ 2.4k tok/file → need ~65 files
  (use `--seed` corpus + wave-2 style filler, or larger batches); prose ≈
  12k tok/file → 15–18 files. Watch the footer (`ctx N%`) — repetitive filler
  tokenizes at ~7–8 chars/token, don't estimate from bytes.
- **Silence rule:** replies must be exactly `files read`. Anything the agent
  restates in a reply or summary becomes *anchored* and trivially survives.
  If you intentionally want the anchored variant (prose approach), instruct
  per-file summaries instead and SAY SO in the results record.
- **keepRecent:** the last ~20k tokens survive verbatim — keep the final
  batches needle-free (read needle files early).
- **min-interval:** compaction needs ≥4 turns in ONE process; one-shot
  `pi --print` can never fire.

### Step 6 — fire check

```bash
ls -t ~/.pi/agent/cache/smart-compaction/telemetry-*.jsonl | head -1   # newest session
tail -n 5 <that file>
```

Expected ladder (v3 fire line, 2026-10-04 amendment — compaction waits for
the context-quality line at 0.5 × window, e.g. 524,288 on a 1M window):

```
agent_settled why:"min-interval (3/4)"
agent_settled why:"below window-floor (132154 < 157286)"
agent_settled why:"below fire-line (158732 < 524288 = (qualityLine ?? 0.5)×1048576; …)"
agent_settled decision:"economy" savings>cost×1.25        ← only past the fire line
gate {"probability":..,"action":"focused"}
session_before_compact:manual → session_compact → compact_complete tokensBefore:… tokensAfter:… compactionCall*…
```

Note `tokensBefore`, savings/cost, and the gate record — the scorecard writeup
wants them. `compact_complete` now also records the compaction call's real
usage (`compactionCallInput/Output/CacheRead/Total`) — audit those against the
claimed savings (live 2026-10-03: 14 compactions burned 54% of what they
compacted). Footer shows `sc cost compacting` + ctx drop after.

### Step 7 — recall turn

```text
INSTRUCTION n (recall — do NOT read or grep any files; answer only from this
conversation; one best answer each; write 'unknown' if you don't know):
1. What is the value of <CONST>?          ← from eval-set.json "ask" fields
2. Which file defines <function>?
...
```

Copy the `ask` lines straight from `eval-set.json`. The `unknown` rule is
mandatory — without it models guess confidently and scores inflate.

### Step 8 — score

Save the pane's answers as JSON — per question id, or one blob under `"*"`:

```json
{"C-codec-lzw": "19", "F-codec-lzw": "src/codec-lzw.ts"}
```

```bash
node score.mjs --eval-set /tmp/sc-eval-code/eval-set.json --answers answers.json \
  > results/<model>-<approach>-<date>.json
```

Questions absent from the answers file are scored `not-asked` (excluded), so
partial runs are fine. Record next to the scorecard: session id, model key,
`tokensBefore`, gate event, anchoring variant.

### Step 9 — profiling a NEW model (checklist)

1. Add/verify a profile whose `match` equals the new model key (Step 2).
2. Fresh tab pane (Step 3).
3. Run search → growth → fire → recall with the SAME seed.
4. Score → `results/<model>-<approach>-<date>.json`.
5. **Publish to the shared pi store** (visible to ALL projects using pi):

```bash
node publish.mjs --scorecard results/<model>-<approach>-<date>.json \
  --project <project-name> --model <model-key> --session <piSessionId> \
  --tokens-before <tokensBefore> --profile /path/to/.pi/smart-compaction.json \
  --notes "anchoring variant / notable behavior"
```

This copies the scorecard into `~/.pi/agent/eval/results/<project>/`, saves
the model's eval profile into `~/.pi/agent/eval/profiles/` (once), and
rebuilds `~/.pi/agent/eval/INDEX.md` — the cross-project comparison table.
See `~/.pi/agent/eval/README.md` for the store's layout.

6. Compare against the baselines in `INDEX.md`
   (minimax 2026-10-04: code 12/12, hybrid 5/7, prose-anchored 10/10,
   prose-unanchored 0/10).

---

## Interpreting results

- **Trigger health:** refusal ladder below floor + exactly one economy fire
  just past it. Anything firing at 2–10% context = bug (check for stale code
  first).
- **Retention is type-dependent (known mechanism):** code constants survive
  (the summarizer tabulates them), doc ID mappings survive, prose facts and
  rationale sentences don't. A low prose score with high code score is
  expected, not a bug.
- **Hybrid hallucination:** a wrong-but-plausible identifier
  (`normalizeQuat` for `slerpWithNudge`) counts as FAIL — this is the eval
  that catches it.

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| never fires, all `below window-floor` / `below fire-line` | corpus too small — v3 fires at 0.5 × window; grow past ~50% ctx (Step 5 sizing) |
| `pricing-unknown` declines | model catalog has no positive prices — set explicit `prices` in the profile (v3: economy runs only on published/opted-in pricing) |
| all `min-interval (n/4)` | too few turns — more, smaller growth turns |
| `pricing-unavailable` / `savings $0.0000` | catalog missing prices — needs the cacheRead-0 fix (PR #179) or explicit `prices` in profile |
| gate always `default "no active tasks"` | known bug: tasks board injected per-run only, invisible at `agent_settled` (TESTING.md §7) — record it, don't debug your config |
| permission wedge on first read | pane cwd used `/tmp` instead of `/private/tmp` (Step 3 gotcha) |
| recall suspiciously perfect | anchoring leak: agent summarized files, or needles sat in the keepRecent tail (Step 5) |
| results not reproducible | different seed, stale extension code, or config changed mid-session — all three reset comparability |
