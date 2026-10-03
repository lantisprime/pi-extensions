# smart-compaction eval set — needle-in-a-haystack, three approaches

Purpose: profile how different models (or provider profiles) behave under
smart-compaction, using three corpus families. Each approach is deterministic
(seeded generator), so runs are comparable across models and across extension
versions. Method rationale lives in [`../TESTING.md`](../TESTING.md).

## The three approaches

| # | Approach | Corpus | Needles | What it measures |
|---|---|---|---|---|
| 1 | **prose** | 10 unrelated-topic text files, needle facts at mid-file depth | 10 distinctive facts (port, INC id, codename, IP…) | baseline fact retention; anchored vs unanchored gap |
| 2 | **code** | 30 unrelated TS modules, 200–400 LOC each, one function each | 6 constants + 6 function→file locations | whether the summarizer preserves *code* identifiers (it does — it tabulates them) |
| 3 | **hybrid** | code corpus + requirements.md / design.md / plan.md whose IDs cross-reference code needles | 6 cross-refs + 1 detail + 1 id+fn pair | doc↔code link survival (the realistic repo case) |

## Known baselines (litellm/minimax, 2026-10-04, fire at ~161–162k tok, 15.4%)

- prose, anchored (agent summarizes per file): **10/10** post-compaction
- prose, unanchored (silence rule): **0/10** post-compaction — anchoring is THE
  retention variable
- code, silent reads: **12/12** — the economy summarizer emits a
  "Default budget constants per file" table; code identifiers survive
- hybrid: **5.5/8 (~69%)** — cross-ref IDs survive (REQ/D/M ↔ fn), doc *rationale
  details* are lost (D-21 "why"), and one function name was confabulated
  (`normalizeQuat` for `slerpWithNudge` — plausible-name hallucination)
- trigger behavior in all runs: refusal ladder held below the 157,286 floor;
  exactly one economy fire just past it; gate recorded `default 0.5 "no active
  tasks"` in every run (known gate-blind bug, see TESTING.md §7)

## Run protocol (per model)

1. Generate: `node generate.mjs --approach <prose|code|hybrid> --out /tmp/sc-eval-<approach> --seed 20261004`
2. Scratch project config `<out>/.pi/smart-compaction.json` (profiles for the
   model under test; see TESTING.md §1).
3. Fresh pi pane (herdr tab in the current workspace is the house style:
   `herdr tab create --workspace $HERDR_WORKSPACE_ID --cwd <out>`, then
   `herdr agent start <name> --kind pi --pane <pane-id>`).
4. Search turn(s) → silent growth turns (`Reply with exactly: files read`)
   until telemetry shows `economy → gate → compact_complete`
   (`~/.pi/agent/cache/smart-compaction/telemetry-<sessionId>.jsonl`).
5. Recall prompt: "Do NOT read or grep any files; answer only from this
   conversation; 'unknown' if you don't know" + the `ask` lines from
   eval-set.json.
6. Score: save answers as `{"<question-id>": "<answer>", ...}` (or one blob
   under `"*"`) and run:
   `node score.mjs --eval-set <out>/eval-set.json --answers answers.json`
7. Record the scorecard JSON under `results/<model>-<date>.json` alongside
   tokensBefore, gate event, and refusal-ladder excerpts.

## Files

- `generate.mjs` — seeded corpus + question-bank generator (all approaches)
- `score.mjs` — deterministic scorer → scorecard JSON
- `results/` — one scorecard per model/run (checked in; append-only)
