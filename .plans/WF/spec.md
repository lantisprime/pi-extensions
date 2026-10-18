---
code: WF
title: Workflow guard — compiled repo contract, action gates, verified runbook derivation
status: implemented and live (S1-S3, S5; 6 reviews)
created: 2026-10-18
version: 4
summary: >
  Make repo instructions load-bearing without context bloat: compile AGENTS.md +
  CI + scripts into a small machine-checkable contract, steer with a constant
  per-turn line plus gates that fire only at irreversible actions, and derive
  runbooks from commands the repo actually runs — quarantined until the operator
  accepts them.
---

# Workflow guard

## Why now (evidence, not vibes)

1. **AGENTS.md is present, but inert.** Pi rebuilds `project_context` from
   context files on every request (`pi dist/core/system-prompt.js:100`), so the
   rules are not lost to compaction. They are *unverified prose*: nothing checks
   them, nothing notices a violation, and long rule blocks are skimmed.
2. **Advisory-only steering is already known to fail here.** The tasks extension
   shipped a tail-of-tool-result nudge, observed it being ignored in practice,
   and replaced it with a three-layer ladder: standing rule (`tasks/index.ts:162`)
   + nudge + hard gate (`:179`). Project instructions never got layers 2–3
   (see `.plans/ENF/spec.md`, Amendments).
3. **JIT runbooks cannot steer the first move.** `tool-context-loader` injects a
   body only *after* a matching tool result (`tool-context-loader/index.ts:1182`).
   A "how to ship a change" runbook therefore arrives after the plan and the
   first `git` command — too late. Broad bash runbooks are intentionally not
   injected at all.
4. **Runbooks are unverified and unscanned.** They are hand-written, have no
   link to the commands CI actually runs, and `prompt-shield`'s scan roots do not
   include `.pi/runbooks` (`prompt-shield/index.ts:21-41`). A runbook is
   injected as advisory guidance, so an LLM-written or stale runbook is a
   prompt-poisoning path.
5. **Quarantine location matters.** `tool-context-loader` walks roots
   recursively (`index.ts:316-351`), so draft runbooks must NOT live under
   `.pi/runbooks` or `.runbooks` — they would be discovered and injected.

## Goals

- Make each repo rule either **checked** or explicitly **advisory-for-humans**.
- Keep the model aligned at the **decision point**, at near-zero context cost
  while compliant.
- Generate runbooks from the repo's **real** workflows (CI, scripts, session
  commands), with **operator verification** as the only activation path.
- Keep auto-derived content untrusted: no silent self-modification of the
  instructions that steer the model.

## Non-goals

- No re-statement of AGENTS.md in the system prompt; no new prose rules.
- No LLM calls in the guard's decision path (deterministic only).
- No blocking of read-only exploration, `task_*`, or MCP reads.
- No replacement of `permission-policy` (hard safety) or `prompt-shield`
  (untrusted resources). The guard is workflow compliance, not security.
- No automatic activation, rewrite, or deletion of accepted runbooks.

## Design

### A. Artifacts

```
.pi/workflow.json          # committed contract, reviewable, ~1-2 KB
.pi/workflow-drafts/       # quarantine: NOT under a scanned root
.pi/runbooks/*.md          # accepted runbooks only (existing loader)
workflow-guard/            # new extension: steering + gates + /workflow
scripts/workflow-derive.mjs# deterministic miner/proposer (no extension needed)
```

### B. Contract (`.pi/workflow.json`)

```json
{
  "version": 1,
  "sources": [".github/workflows/ci.yml", "AGENTS.md"],
  "packages": [
    { "glob": "herdr-control/**", "test": "bash herdr-control/test-fixtures/run-tests.sh" },
    { "glob": "agents/**", "test": "npx --yes tsx --test agents/test/test-agents-run-tool.mjs" }
  ],
  "docsOnly": ["**/*.md", "docs/**", ".plans/**"],
  "protectedPaths": ["AGENTS.md", "MEMORY.md", ".pi/runbooks/**", ".pi/workflow.json"],
  "gates": {
    "protect-instructions": { "enabled": true },
    "test-before-commit": { "enabled": true },
    "plan-before-pr": { "enabled": false }
  }
}
```

The implemented shape is an object keyed by gate id (the earlier array sketch
was replaced during implementation). Runbooks are not listed in the contract:
they are derived and activated separately by `scripts/workflow-derive.mjs` and
the existing loader.

`packages` is derived from CI + `package.json` scripts + test paths; it is the
mapping the gate uses to answer "what must be green for these edits".

### C. Steering ladder (the load-bearing part)

| Layer | Fires | Content | Budget |
|---|---|---|---|
| 1. Standing line | `before_agent_start`, every turn | `[workflow] plan → tests → PR; run workflow_status before commit` (constant, one line) | ≤ 180 B |
| 2. Delta status | only when compliance state changes, at most once per turn | `[workflow] missing: green tests for tasks/ (edits after last run)` | ≤ 240 B, ≤ 1/turn |
| 3. Action gate | `tool_call` on a gated action | `blocked: tests not run since edit to tasks/index.ts. Run: bash tasks/test/run-tests.sh` | ≤ 400 B, only on violation |
| 4. Runbook index | existing loader `preload` | ids + one-line summaries, active tools only | existing 2 KB cap |
| 5. Runbook body | existing loader `tool_result` | advisory-wrapped excerpt | existing 5 KB/runbook, 10 KB/turn |

Compliant session cost: **one ~180 B line per turn**. No output is produced
while compliant; nothing grows per turn; the gate reason is the only steering
text most sessions ever see.

Cardinality bound: the gate names at most the first dirty package plus
`(+N more)`; the full list lives in `/workflow status`. No string grows with
the number of packages.

Composition: `before_agent_start` handlers chain — a returned `systemPrompt`
becomes `forceSystemPrompt`, and the next handler's `event.systemPrompt` getter
renders it (`pi dist/core/extensions/runner.js:1146`,
`dist/core/system-prompt.js:127`). Appends compose in registration order, so the
guard must be registered at a fixed position and covered by a three-appender
wiring test.

Keep the standing line *constant* and make it name the recovery command, not the
rules. Rules live in the contract; bodies live in runbooks; both are read only
when the gate or the trigger fires.

### D. Deterministic compliance state (fail-closed, restart-proof)

State is derived, never prompted:

- `changed`: paths from a read-only `git status --porcelain -z -uall` at gate
  time, not only from observed `write`/`edit` events. NUL separation prevents
  git quoting from hiding a path; `-uall` expands untracked directories. This
  closes evasions that in-memory tracking cannot see: `sed -i`, `tee`, `>`,
  `cp`/`mv`, edits made before the extension loaded, and edits that survive a
  restart.
- `green`: package → `{ contentHash, changedKey, at }` when a bash command
  matches the package's `test` command (exactly, or as the final segment of a
  `cd … &&` chain) and `isError === false`. Failure-masking forms
  (`… || true`, `… ; echo ok`) never record green. The hash covers the
  package's changed files at that moment.
- `dirty`: changed files in the package whose current hash ≠ the hash recorded
  at the last green run. A restart does not reset it because the record is
  persisted.
- `docsOnly`: every changed path matches `docsOnly`.

Persistence: `~/.pi/agent/workflow/<project-path-hash>.json` (outside the repo,
like permission-policy). Hashes, timestamps, and package ids only — no file
contents. TTL 7 days.

Parallel calls: `tool_call` handlers can run concurrently. State updates are
keyed by `toolCallId` and survive turn boundaries (a long suite may finish after
`turn_end`); the map is bounded at 256 entries. The gate reads a snapshot
recomputed at the gate call. If the snapshot cannot be computed (git
error/timeout), the snapshot is truncated (>5000 paths), or a test run for a
dirty package is still in flight, the gate **fails closed** — blocked, never
allowed.

Deletions, symlinks, and oversized files are hashed by marker/metadata rather
than rejected, so a green run stays recordable after a deletion (no deadlock).
Mutation records are written on a successful `tool_result`, not on `tool_call`,
so a denied or failed write cannot mark a package dirty or clean. Bash writes
(`sed -i`, `tee`, `>`/`>>`, `cp`/`mv`) are not reconstructable from tool events;
the gate-time git snapshot is the authority, and the delta line is derived from
that snapshot rather than from event history.

Pure function `evaluateGate(contract, snapshot, toolCall) → allow | block(reason)`.
Turn reset clears per-turn dedupe only; compliance records persist for the
project.

### E. Gates (proposed; operator decides which are on)

- **G1 protect-instructions** — any mutation of `AGENTS.md`, `MEMORY.md`,
  `.pi/runbooks/**`, or `.pi/workflow.json` asks the operator once per file.
  Covers `write`/`edit`, bash-mediated mutation (`sed -i`/`--in-place`, `tee`,
  `>`/`>>`, `cp`/`mv`, `unlink`, `find -delete`, `patch`, `dd`), git mutations
  with global options (`git -C … checkout`), and `../` escapes from a subdir.
  Bash paths are resolved lexically against the project root. Accepted bypass
  class: interpreter writes (`python -c open(...)`), which cannot be detected
  reliably and are not claimed as gated.
- **G2 test-before-commit** — `git commit`, `git push`, and `gh pr create`
  (subcommand parsed after `git -C/-c/--git-dir/…` options; `git log --grep=commit`
  does not match) require each changed package's current change hash to match a
  recorded green run (see D). Docs-only diffs are exempt. Blocked reason names
  the exact command. Accepted bypass class: commits made inside scripts or
  aliases, and piecemeal runs of a multi-command package suite — neither is
  invisible, but neither is claimed as gated.
- **G3 plan-before-pr** (optional, default **off**) — `gh pr create` requires a
  plan artifact (`.plans/<CODE>/spec.md` or a plan path in the commit message).
- Never gated: reads, search, `task_*`, MCP reads, and `bash` commands other
  than the gated ones.

Escape hatches: `/workflow enforce on|off|status`, `/workflow override <reason>`
(one next action, appended to the user-level audit `~/.pi/agent/workflow/<hash>.telemetry.jsonl`; never inside the repo). Kill switch must
work without a reload.

### F. Runbook derivation (mine → quarantine → verify → activate)

Sources, in trust order:

1. `.github/workflows/*.yml` steps — what CI actually enforces.
2. `package.json` scripts and `*/test-fixtures/run-*.sh` — the repo's real
   entry points.
3. `AGENTS.md` headings → rule ids (prose is linked, never copied).
4. Episodic-memory episodes tagged `runbook` / `workflow` / `canonical-workplan`
   — commands and preconditions only.
5. Opt-in: successful bash commands from Pi session logs, clustered by argv
   prefix, ranked by recency × frequency.

The miner **normalizes** (argv prefix, redacted flags), **redacts** secrets
(`*_TOKEN`, `--token`, env assignments, paths outside the repo), and **clusters**
before proposing. It writes only commands, paths, and preconditions — no
LLM-authored prose.

Verification flow:

```
/workflow derive        # preview candidates + diff, no writes
/workflow derive --accept <id...>   # or ctx.ui multi-select in the TUI
```

Land the `.pi/runbooks` prompt-shield root **in S1**, before the first
acceptance; otherwise the first accepted runbook predates the scan.

Acceptance requires: (a) explicit operator selection, (b) a `prompt-shield` scan
of the rendered draft (refuse on suspicious/dangerous), (c) provenance written
into frontmatter:

```yaml
derivedFrom: [".github/workflows/ci.yml:42"]
sourceCommit: <sha>
verifiedAt: 2026-10-18
verifiedBy: operator
```

Staleness: on `session_start` and `/workflow verify`, re-check that every
command/path still exists. Stale runbooks are **reported once** and marked
`stale: true`; never auto-edited or deleted.

### G. Poisoning / bloat defenses

- Quarantine directory outside all loader roots; drafts are never injected.
  Because loader roots are user-configurable (`tool-context-loader/index.ts:170`
  spreads overrides), a root of `.pi` or `.` would otherwise discover drafts:
  the loader hard-excludes any path with a `workflow-drafts` segment, shipped
  in S1 and tested with a `.pi` root.
- Operator acceptance is the only activation path; no auto-activation, ever.
- `prompt-shield` scans `.pi/runbooks`, `.pi/workflow.json` (new roots) before
  and after activation.
- Loader's advisory wrapper and priority framing stay authoritative: runbooks
  are guidance, not instructions, and cannot grant permissions.
- Caps: body ≤ 2 KB / 40 lines (write `maxBytes: 2048` in frontmatter; the
  loader's 5 KB default is unchanged), index ≤ 1 KB, gate reason ≤ 400 B,
  delta ≤ 240 B.
- Dedupe per turn (existing) + no re-injection of unchanged status.
- Secrets are redacted at derivation time, not at injection time.

## Acceptance

| ID | Requirement |
|----|-------------|
| AC-1 | WHEN all gates pass THEN the only workflow context added per turn is one constant line ≤ 180 B |
| AC-2 | WHEN compliance state is unchanged THEN no delta line is appended; at most one delta line is appended per turn |
| AC-3 | WHEN `git commit`/`gh pr create` runs with a changed package lacking a green test since its last edit THEN the call is blocked with the exact test command (≤ 400 B) |
| AC-4 | WHEN the same command runs with all changed packages green THEN it is never blocked |
| AC-5 | WHEN a write/edit targets a protected steering path THEN the operator is asked before it lands |
| AC-6 | Read-only tools, `task_*`, and non-gated bash are never blocked |
| AC-7 | WHEN `/workflow enforce off` THEN gates stop for the session and the standing line says enforcement is off |
| AC-8 | WHEN a runbook is derived THEN it is written only under `.pi/workflow-drafts/` until explicitly accepted |
| AC-9 | WHEN a draft is accepted THEN provenance frontmatter is written and a prompt-shield scan has passed |
| AC-10 | WHEN prompt-shield flags a draft THEN acceptance is refused with the finding |
| AC-11 | WHEN an accepted runbook's command/path disappears THEN it is marked `stale` and reported once, not injected as current |
| AC-12 | Compliance state is derived from git + observed tool events only; the guard makes no LLM call |
| AC-13 | WHEN a protected steering path is mutated via bash (`sed -i`, `tee`, `>`, `cp`/`mv`) THEN the operator is asked, same as `write`/`edit` |
| AC-14 | WHEN a restart or compaction follows edits THEN an unrun test still blocks the commit (persisted hash), and an uncomputable snapshot fails closed |
| AC-15 | WHEN N packages are dirty THEN gate/delta strings stay within budget (first package + count); the full list appears only in `/workflow status` |
| AC-16 | WHEN tasks, tool-context-loader, and the guard all append in `before_agent_start` THEN all blocks survive in registration order |
| AC-17 | WHEN a bash command mutates a protected steering path THEN it is gated by G1 and recorded in the audit log, not just `write`/`edit` |
| AC-18 | WHEN a loader root is configured to `.pi` or `.` THEN files under `workflow-drafts/` are still not discovered or injected |
| AC-19 | WHEN a runbook or contract is accepted or read into a gate reason THEN it has passed a prompt-shield scan in the same session |
| AC-20 | WHEN a package file is deleted or is a symlink THEN a subsequent green run is recordable and the commit is not permanently blocked |
| AC-21 | WHEN the git snapshot is truncated (>5000 paths) THEN a commit-like command is blocked instead of being allowed |
| AC-22 | WHEN a protected path is mutated via `git -C … checkout`, `sed --in-place`, or `../AGENTS.md` from a subdir THEN G1 asks the operator |
| AC-23 | WHEN a bash command masks failure (`… || true`, `… ; echo ok`) THEN it does not record a green run; `cd … && <test>` does |

## Constraints

- ✅ Always: pure decision functions + wiring tests; bounded, constant strings;
  operator-owned activation; audit log.
- ⚠️ Ask first: enabling G3, mining session logs, changing gate boundaries.
- 🚫 Never: auto-activate derived content; block exploration; gate on LLM
  judgement; grow context per turn; edit accepted runbooks without consent.

## Evaluation

- Unit: normalize/redact/cluster, `evaluateGate`, budget and dedupe.
- Wiring: mock `ExtensionAPI` harness (pattern:
  `smart-compaction/test/wiring.test.ts`); assert state lifecycle across
  `turn_start` / `tool_call` / `tool_result`.
- Composition: three mock appenders (tasks pattern + loader pattern + guard)
  assert all blocks survive in registration order.
- Restart: persist a green hash, rebuild the mock session, edit the package,
  assert the commit gate blocks.
- Negative controls: a draft containing instruction-override text is rejected;
  a commit without green tests MUST be blocked.
- Budget assertion: render a compliant session and assert added bytes/turn.
- Live: fresh `pi` process (repo lesson: `/reload` is unproven for module
  changes).

## Rollout slices

1. **S1** `scripts/workflow-derive.mjs` + `.pi/workflow.json` + prompt-shield
   `.pi/runbooks` and `.pi/workflow.json` roots + loader `workflow-drafts`
   exclusion + docs; no runtime.
2. **S2** extension skeleton: standing line, delta status, `/workflow status|verify|enforce`.
3. **S3** G1 + G2 (with bash-mutation detection) + override + audit +
   wiring/negative tests. Gates do not ship before S1's scan roots are live.
4. **S4** staleness check + telemetry rollup (scan roots and exclusion already
   landed in S1).
5. **S5** live test, telemetry review, handoff/MEMORY update.

## Open decisions (operator)

1. Which gates ship on by default: G1 only, G1+G2, or all three?
2. G3 plan-before-PR: on for feature work only, or off until proven?
3. Session-log mining: opt-in per repo, or never?
4. Ship `workflow-guard` globally (`~/.pi/agent/extensions`) or repo-local
   (`.pi/extensions`)?

## Review findings (2026-10-18)

Two subagent passes (built-in `reviewer` on litellm/minimax; its output was
truncated by the harness at the summary boundary, so the open questions were
verified directly in the pi dist). A third pass on `glm-design-reviewer`
(litellm/glm-5.3-zai) returned **accept-with-changes** with two High findings,
both already fixed in v2 and confirmed again. Confirmed: JIT injection point,
recursive walk, prompt-shield root exclusion, tasks ladder, `tool_call` block +
`input.command` + `ctx.ui.confirm`, appender chaining. Fixed in v2:

1. **G1 bash bypass** (blocker) — protected paths must also be checked on bash
   mutation, not only `write`/`edit`.
2. **State evasion** (blocker) — in-memory edits/green state was lost on
   restart/compaction and blind to bash-mediated edits. Replaced with a git
   snapshot + persisted content hash, fail-closed.
3. **Parallel gate race** (major) — keyed updates plus a gate-time snapshot.
4. **String growth** (major) — gate/delta bounded by cardinality, not only bytes.
5. **Acceptance ordering** (major) — prompt-shield root moves into S1.
6. **Cap mismatch** (minor) — 2 KB is a runbook frontmatter `maxBytes`, not a
   change to the loader's 5 KB default.

GLM pass added in v3 (new, not covered above):

7. **Configurable-root leak** (major) — loader roots are user-configurable, so
   `.pi/workflow-drafts` can be discovered under a `.pi` or `.` root. Fixed with
   a hard `workflow-drafts` path-segment exclusion in S1 (AC-18).
8. **Delta oscillation** (medium) — edit↔test oscillation could emit multiple
   delta lines in one turn. Capped at one per turn (AC-2).
9. **Gate coverage** (low) — `git push` was ungated, and aliases/scripts are
   invisible to command matching. `git push` added; the alias class is now
   documented as an accepted bypass (AC-19 covers the scan-order window).

Implementation review (GLM, 2026-10-18) — fixed in v4 after verifying each
claim against the code:

10. **Deletion deadlock** (high) — unstat-able/deleted paths made the hash
    `null`, so a green run could never be recorded and the commit stayed
    blocked forever. Deletions/symlinks/oversized files are now hashed by
    marker (AC-20).
11. **Truncation fail-open** (high) — a >5000-path porcelain snapshot dropped
    files silently. The gate now treats `truncated` as fail-closed (AC-21).
12. **G1/G2 matcher bypasses** (high) — `git -C … checkout`, `sed --in-place`,
    `../AGENTS.md`, and `git log --grep=commit` were reachable gaps. Fixed with
    lexical `..` resolution, long-option coverage, and subcommand parsing that
    skips git global options (AC-22).
13. **Green spoofing / brittleness** (medium) — `… || true` recorded green;
    piecemeal runs of a chained package suite did not. Failure-masking is now
    rejected; `cd … && <test>` is accepted; piecemeal runs are a documented
    limit (AC-23).
14. **Cross-turn pending command** (medium) — `turn_start` dropped commands, so
    a long suite finishing after the turn boundary lost its green record. The
    map now survives turn boundaries and is capped at 256.

## Amendments

- 2026-10-18 | v2 | Review fixes: bash-mediated protected-path gate (AC-13);
  restart-proof hash state + fail-closed snapshot (AC-14); cardinality-bound
  strings (AC-15); three-appender composition test (AC-16); prompt-shield root
  moved into S1; runbook cap expressed as frontmatter `maxBytes: 2048`.
- 2026-10-18 | v3 | GLM review fixes: configurable-root draft exclusion +
  loader segment filter (AC-18); one delta per turn (AC-2); `git push` gated and
  alias bypass documented; bash-mutation audit (AC-17); scan-before-use
  (AC-19); S1 owns scan roots + exclusion, S4 is staleness only.
- 2026-10-18 | v6 | Repos without `.pi/workflow.json` now get an in-memory
  contract derived at session start (CI steps, nested package.json test scripts,
  documented pytest command) and a project-scoped runbook projected to
  `~/.pi/agent/runbooks/derived/`. Nothing is written into the scanned repo;
  audit moved beside the ledger. Validation: home-network dry run detected 3
  packages, fresh process logged `contract=loaded (derived) packages=3`, and
  discovery reported `runbooks: 1` scoped to that project. Reviewed by GLM
  (accept-with-changes): telemetry deadlock, TCL record shape, tea gating,
  lifecycle, trust, and Python fallback were addressed or designed around.
- 2026-10-18 | v5 | Derivation collapsed to one aggregate `ship-change` runbook
  that fires on git inspection (status/diff) before the commit, instead of
  per-package drafts that only appeared after their test ran. Accepted after a
  safe scan with provenance `operator (delegated to agent)`. Installed globally
  at `~/.pi/agent/extensions/workflow-guard/` and live-verified in a fresh
  process (`contract=loaded packages=18 enforcing=true`). Local duplicate install
  removed to avoid double registration.
- 2026-10-18 | v4 | Implementation review fixes: deletion/symlink hashing
  (AC-20); truncated snapshot fails closed (AC-21); G1/G2 matcher bypasses
  `git -C`, `--in-place`, `../`, `git log --grep=commit` (AC-22); green masking
  rejected (AC-23); pending commands survive turn boundaries; contract schema
  amended to the implemented object shape; G3 explicitly not implemented.
