# Workflow Guard

Keeps the repo's own workflow rules in force without bloating the context.

The rules live in a small machine-checkable contract. `.pi/workflow.json` wins
when present; otherwise the guard derives one in memory at session start from
CI steps, nested `package.json` test scripts, and a documented pytest command —
without writing into the repository.
`AGENTS.md` stays the human narrative; the guard never re-states it per turn.

## Context cost

| Surface | When | Budget |
|---|---|---|
| Standing line | every turn | one constant line, ~100 B |
| Delta line | only when packages are not green, at most once per turn | 240 B |
| Gate reason | only when an action is blocked | 400 B |
| Runbook index/body | existing `tool-context-loader` caps | unchanged |

While compliant, the guard adds one line per turn and nothing else. There are
no LLM calls in the decision path.

## Gates

- **G1 protect-instructions** — `AGENTS.md`, `MEMORY.md`, `.pi/runbooks/**`,
  `.pi/workflow.json` require operator confirmation. Covers `write`/`edit` and
  bash-mediated mutation (`sed -i`, `tee`, `>`, `cp`/`mv`, `git checkout`).
- **G2 test-before-commit** — `git commit`, `git push`, `gh pr create` require
  the changed package's current content hash to match a recorded green run.
  State comes from a read-only `git status` snapshot plus a persisted ledger;
  an uncomputable snapshot fails closed.
- **G3 plan-before-pr** — configurable, **not implemented**, off by default.

Read-only tools, `task_*`, and non-gated bash are never blocked.

## Commands

```text
/workflow status
/workflow enforce on|off
/workflow verify
/workflow override <reason>
```

`override` allows exactly the next gated action and appends to
the user-level audit (below). There is no silent bypass.

## Derive and verify runbooks

```bash
npx --yes tsx scripts/workflow-derive.mjs                       # preview
npx --yes tsx scripts/workflow-derive.mjs --write               # contract + drafts
npx --yes tsx scripts/workflow-derive.mjs --accept <id[,id]>    # operator-only activation
npx --yes tsx scripts/workflow-derive.mjs --accept <id> --dry-run
```

Drafts are written to `.pi/workflow-drafts/` (quarantine, ignored by the loader
and by git). Acceptance is fail-closed: the draft body must pass the shared
scanner; `dangerous` is always refused, `suspicious` needs `--force` after
reading it. Accepted runbooks carry `derivedFrom`, `sourceCommit`, `verifiedAt`,
and `verifiedBy: operator`.

The loader hard-excludes `workflow-drafts/`, `.git/`, and `node_modules/` at any
depth, so a root of `.pi` or `.` cannot discover quarantined drafts.

## Install

```bash
mkdir -p ~/.pi/agent/extensions/workflow-guard
cp -R workflow-guard/index.ts workflow-guard/lib ~/.pi/agent/extensions/workflow-guard/
```

Restart pi or run `/reload`. Project-local installs under `.pi/extensions/` also
work when the project is trusted. The guard does nothing without a trusted
project; with one, it uses the file contract or derives one at session start.

## State and audit

- Green ledger: `~/.pi/agent/workflow/<project-hash>.json` (hashes, timestamps,
  package ids; 7-day TTL).
- Audit: `~/.pi/agent/workflow/<sha256(cwd)[0:24]>.telemetry.jsonl` (never inside the repo).
- Derived runbook: `~/.pi/agent/runbooks/derived/<sha256(cwd)[0:24]>-ship-change.md`,
  project-scoped via `match.project`; removed when a repo runbook exists.
- Diagnostics: `PI_WORKFLOW_GUARD_DEBUG=1 pi -p "..."` prints
  `contract=loaded packages=N enforcing=true|false` on session start.

## Known limits

- Commits made inside scripts or aliases are invisible to command matching.
- Interpreter writes (`python -c open(...)`) cannot be detected reliably; they
  are an accepted G1 bypass, not claimed as gated.
- A test runner invoked indirectly (not the exact contract command) does not
  count as green; the gate names the exact command. Piecemeal runs of a
  multi-command package suite do not count either.
- More than 5000 changed paths truncates the snapshot; commit-like commands
  then fail closed.
- Files outside every `packages[].glob` (except `docsOnly`) are not gated.
- The contract is only as good as its package map: re-run the derive script when
  CI entry points change, and review the diff.
