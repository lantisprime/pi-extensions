# TESTING.md — needle-in-a-haystack live test method (smart-compaction)

Status: proven on pi 1.0.1, litellm/minimax (1M window), 2026-10-03/04.
Scope: live verification of (a) trigger correctness, (b) economy-fire behavior,
(c) fact retention through compaction, (d) relevance-gate routing. This is the
method behind the numbers cited in PR #179 and the 2026-10-04 episodes; the
earlier results lived in `/tmp/sc-needle-RESULTS.md` and rotted — this file is
the durable record.

## 0. Why live testing (not unit tests)

Unit/wiring tests (test/*.ts) prove the decision math over mock inputs. They
cannot prove what a real pi process does: telemetry contents, refusal wording,
footer state, gate fallbacks, model-catalog prices, or retention through a REAL
summarizer. Every claim in this file was observed on a fresh `pi` process with
the installed extension (symlink at `~/.pi/agent/extensions/smart-compaction`
→ repo).

**Fresh process is mandatory.** A running pi never reloads extension code after
its module loaded; `/reload` is unproven. A stale long-lived session running
pre-fix code is how the "compacts at 2% context" report actually happened.

## 1. Environment

- Scratch project dir per scenario: `/tmp/sc-needle{,2,3}` (never the repo —
  isolates config + avoids touching user state).
  **Gotcha:** spawn the pane with the RESOLVED path (`/private/tmp/...` on
  macOS). A `/tmp/...` cwd makes pi treat reads of `/tmp/...` paths as
  outside-project → permission prompt wedges the pane.
- Scenario config at `<dir>/.pi/smart-compaction.json`, loaded ONCE at
  session_start. Changing config ⇒ new process. Minimal scenario config:

```json
{
  "profiles": [
    {
      "match": "litellm/minimax",
      "mode": "cost",
      "gate": { "enabled": false, "aggressiveBelow": 0.35, "deferAbove": 0.7 }
    }
  ]
}
```

  `gate.enabled: false` removes the Jev dependency when testing triggers;
  `enabled: true` (default thresholds) when testing gate routing.
- Model: the operator's default (litellm/minimax, catalog `{input≈0.278,
  cacheRead:0-with-fix→derived}`, window 1,048,576 ⇒ window floor
  `0.15 × window = 157,286`).
- Harness: `herdr_spawn` (kind `pi`), one instruction per `herdr_prompt` turn
  (each = one real turn in ONE process ⇒ `turnsSinceCompaction` accrues;
  `pi --print` one-shots can NEVER test cadence/guards for this reason).

## 2. Corpus construction (generator pattern)

Node script, seeded RNG (`seed = (seed*1103515245+12345) % 2^31`), so corpora
are reproducible:

- **Filler:** paragraph templates from topic word lists (verbs × nouns), 26+
  paragraphs per file, sectioned `Section N.` — deliberately repetitive and
  needle-free. For multi-topic corpora use one word list per unrelated domain
  (cooking / automotive / astronomy) so topics share no vocabulary.
- **File size:** ~50KB ≈ 12–13k tokens of natural prose. **Gotcha:** highly
  repetitive filler tokenizes at ~7–8 chars/token (not 4) — measure with the
  pane footer (`ctx N%`), don't estimate from bytes. Enlarge files BEFORE the
  growth phase; post-hoc appends shift line offsets (reads then need
  `offset=`).
- **Needles:** single distinctive sentences with unique tokens (port `5434`,
  `INC-2271`, `THROTTLEMAN`, `4417`, `10.42.7.19`, `9f3a`, `$12,400`,
  `kx-77`…), inserted at controlled depths (`parts.splice(4 + i*9, 0, …)` ⇒
  ~13%, ~40%, ~70% of file). Never in the first or last section.
- **keepRecent accounting:** pi keeps the last ~20k tokens verbatim through
  compaction. Anything read into that tail survives trivially — keep the LAST
  read files needle-free (or account for it in scoring).

## 3. Delivery protocol

1. Spawn pane, then one instruction per turn:
   - **growth turns:** "Read files X, Y, Z in full (offset reads for truncated
     tails). Reply with exactly `done`/`files read` — do not mention any file
     content."
   - **search turns (multi-topic):** "Using bash grep, search all *.txt for
     `MARKER`; reply with ONLY the filename(s)." — puts needle-adjacent
     evidence into tool results without anchoring.
2. **Anchoring variants** (the single biggest confound — name which one you
   ran):
   - *anchored:* agent must summarize each file in a sentence ⇒ needle text
     enters assistant messages.
   - *unanchored:* SILENCE RULE — reply only `done`; needle text exists only in
     tool results.
3. **Fire check:** after each growth turn read the telemetry (next section).
   Stop growing once `agent_settled economy` + `session_compact` +
   `compact_complete` appear. Guards need ≥4 turns (`minIntervalTurns`) and
   ≥157,286 tokens on this window — 15–18 files at ~12k tokens across 4–6
   turns lands right past it.
4. **Recall prompt:** "Do NOT read any files. Answer only from what is already
   in this conversation… write unknown if you don't know." Score exact values.
   For multi-topic runs also ask fact→file location.
5. **Control leg:** same corpus, ask recall BEFORE any compaction. 10/10
   control proves the corpus and questions are answerable at all.

## 4. Observation points

- **Telemetry:** `~/.pi/agent/cache/smart-compaction/telemetry-<sessionId>.jsonl`
  (one file per session; `wedge-*`/`gap-*`/`failed-*` names are the wiring
  suite's artifacts, not real sessions). Event grammar:
  - `turn_end none no-warning` — observation plane only, never compacts.
  - `agent_settled none why:"min-interval (3/4)" | "below window-floor
    (149126 < 157286)" | "below keepRecent floor" | "savings $0.0000 <= cost
    $0.0527 x 1.25 (…)" | "pricing-unavailable…"` — the refusal ladder.
  - `agent_settled economy {savings, cost, cacheHot, H, cont}` → `gate` →
    `session_before_compact:manual` → `session_compact` → `compact_complete
    {tokensBefore}` — a full fire. Print `d.gate` separately (source,
    probability, action, detail).
- **Pane footer:** `ctx N%/1049k`, `sc <mode>`, `sc cost compacting` +
  `⠼ Compacting context...` spinner during compaction.
- **Post-compaction context %:** drops to ~1–2%; `turnsSinceCompaction`
  resets (AC-8).

## 5. Results (2026-10-04, minimax, 1M window, post-#179-fix code)

| Variant | Context at fire | Fire? | Recall | Notes |
|---|---|---|---|---|
| A0 anchored, no compaction (control) | 16% (n/a) | n/a | **10/10** | corpus sanity |
| A1 anchored (per-file summaries), economy | 176,422 (16.8%) | YES — savings $0.162 > cost $0.055×1.25 | **10/10** | first live economy fire |
| A2 unanchored (silence rule), economy | 175,187 (16.7%) | YES — $0.161 | **0/10** | unanchored facts do not survive |
| B unanchored, active task + unrelated context, gate ON | 169,723 (16.2%) | YES — $0.155 | unrelated 0/10, task-adjacent 1/3 | gate saw NO task board (see §7) |
| C multi-topic (3 domains × 6 files) + grep search phase, gate ON | 161,028 (15.4%) | YES — $0.146 | facts 0/6; file groups survived (cooking-02/05, automotive-03/06, astronomy-01/04), fact→file mapping lost | compaction kicks in mid search workflow |
| C code-only: 30 unrelated TS modules (200–400 LOC), silent reads, economy | 161,279 (15.4%) | YES — $0.146 | **12/12** (6 constants + 6 fn→file) | summarizer emitted a "Default budget constants per file" table; code identifiers survive (some locations inferred from naming, disclosed by the agent) |
| H hybrid: code + requirements/design/plan cross-refs, economy | 162,470 (15.5%) | YES — $0.147 | **5/7 asked** (crossref IDs ✓; D-21 rationale lost; confabulated `normalizeQuat` for `slerpWithNudge`) | doc↔code ID links survive; doc *detail* text does not |
| refusal ladder (all runs) | 15k–149k | no (correct) | — | `min-interval` then `below window-floor (< 157286)` |

Baselines live in `eval/results/` as scorer-generated scorecards (model
comparable); minimax 2026-10-04: code 12/12, hybrid 5/7, prose-anchored 10/10,
prose-unanchored 0/10.

## 5b. The three approaches (and the eval set)

The corpus families are now three named approaches, packaged as a reusable
question-bank harness in [`eval/`](./eval/README.md):

1. **prose** — unrelated-topic text files, needle facts at mid-file depth.
   Measures baseline fact retention; must be run in an anchoring variant
   (anchored vs unanchored) because anchoring dominates the outcome.
2. **code** — unrelated TypeScript modules, 200–400 LOC, needles = exotic
   function names + distinctive constants. Measures identifier retention.
   Finding: the economy summarizer reliably tabulates code constants, so code
   facts survive silent reads (unlike unanchored prose facts).
3. **hybrid** — code corpus plus requirements/plan/design docs whose IDs
   cross-reference code needles. Measures doc↔code link survival — the
   realistic repo case. Finding: ID mappings survive (REQ-114 ↔
   verifyJwtKeyStamp), rationale details and exact function names do not
   (plausible-name confabulation observed).

`eval/generate.mjs` emits the corpus + `eval-set.json` (seeded, deterministic);
`eval/score.mjs` turns the pane's recall answers into a scorecard. New models
append one scorecard to `eval/results/`.

Interpretation: retention is an **anchoring** effect, not a compaction-quality
constant. Anchored facts survive; unanchored tool-result-only facts are lost at
~0–8% even with focused instructions (and with no task subjects the focused
template degenerates to "summarize unrelated content more briefly"). Trigger
correctness held in every run: nothing below 157,286, one fire just past it.

## 6. Known confounds / scoring rules

- State which anchoring variant ran; never compare across variants.
- keepRecent tail: last ~20k tokens survive verbatim — keep them needle-free.
- The recall answer "the fact is in file X or Y" scores as MISS for fact→file
  mapping, partial signal only.
- One fire per session (post-compaction gap `minGapTokens 20k` + min-interval);
  run each variant in a fresh pane.

## 7. Findings log (feed back into issues)

- **Gate never sees the task board live.** All FIVE 2026-10-04 live runs with
  gate ON (three prose, code + hybrid tabs) recorded
  `{"probability":0.5,"source":"default","detail":"no active tasks"}` — including pane B with an ACTIVE `ROTATE-1` task visible in the
  footer. Mechanism: the tasks extension injects `<session-tasks>` via
  `before_agent_start` (per-run prompt only); smart-compaction reads
  `ctx.getSystemPrompt()` at `agent_settled`, which returns the base prompt
  without the block. The gate's none/active/settled logic (lib/task-subjects.ts)
  is therefore dead code in live wiring. Secondary gap: `oldContextExcerpt`
  excludes tool results, so even a working gate would judge relevance from
  instructions/replies, never from actual context content.
- **LiteLLM catalog `cacheRead: 0`** was the $0-savings blocker fixed in
  PR #179 — verified by variant A1 firing after the fix (pre-fix refusal
  `savings $0.0000 <= cost $0.0527` at 167,828 tokens, 2026-10-04).
- **Summarizer salience is type-dependent.** Code constants/identifiers are
  tabulated by the economy summarizer and survive (12/12); unanchored prose
  facts are dropped (0/10); doc rationale sentences are dropped while doc ID
  mappings survive (hybrid). Retention tuning should target the prose-fact and
  rationale classes explicitly — e.g. task-board subjects or a
  salience-oriented summary section.
- **Stale-process artifact:** the user-visible "compacts at 2%" report came
  from long-lived sessions running pre-#178 code (compactions at 44–98k) plus
  a manual `/compact` failing "Nothing to compact" at 25.5k. Not a HEAD bug.

## 8. Reproduction checklist

1. `node` generator → corpus in `/tmp/sc-needleN` + scenario config
2. `herdr_spawn` pi pane, cwd = `/private/tmp/sc-needleN`
3. growth turns (batches of 3–6 files), silence rule as applicable
4. after each turn: read the session's telemetry file (fire check)
5. at fire: confirm `economy → gate → compact_complete` chain + footer % drop
6. recall prompt; score vs control
7. close pane; record session id + variant + numbers in this file or the
   episodic store
