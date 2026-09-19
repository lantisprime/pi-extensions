# Using the task harness efficiently

A guide for **humans and agents**. The `tasks` skill (`SKILL.md`) defines the
rules; this file shows how to run the whole system well — task list plus plan
artifacts — especially on long autonomous runs where drift, hallucinated
specs, and AI slop are the failure modes.

**Files in this skill** (progressive disclosure — load only what you need):

| File | Load when |
|---|---|
| `SKILL.md` | doing any multi-step work (rules: lifecycle, evidence, artifacts) |
| `templates/spec-template.md` | starting a themed task set that carries design/specs |
| `templates/design-template.md` | the HOW is non-trivial and worth its own file |
| `templates/plan-template.md` | many tasks / cross-task sequencing needs a map |
| `DELEGATION.md` | delegating steps to subagents (run_subagent, herdr) or non-LLM threads |
| `README.md` (this file) | first time, or when teaching another human/agent |

## The system in one paragraph

The task list is working memory (injected every turn, compacted when settled).
Plan artifacts under `.plans/<CODE>/` are durable intent: version-controlled
markdown with a small schema (YAML frontmatter + AC-id tables + append-only
amendments) that any model or harness parses uniformly. Tasks **pin** the
artifact by hash; agents **re-anchor** by re-reading from disk at task start;
evidence must cite AC ids. Chat memory of a spec is never trusted over the
file. That is the whole anti-drift mechanism.

## Worked example: the AUTH theme

**1. Create the artifact** (agent or human):

```bash
mkdir -p .plans/AUTH
cp ~/.pi/agent/skills/tasks/templates/spec-template.md .plans/AUTH/spec.md
# fill in Goal, Non-goals, AC-1..N, Constraints; delete inapplicable sections
shasum -a 256 .plans/AUTH/spec.md | cut -c1-8   # → 9f3c21ab  (the pin)
```

Commit it. Artifacts are version control, not scratch.

**2. Create tasks that reference the pin and AC ids:**

```
task_create code=AUTH subject="Implement password hashing"
  description="Per .plans/AUTH/spec.md@9f3c21ab — covers AC-1, AC-2."
```

The `@hash8` pin is compaction-proof: even after the context window rolls
over, the task row still says exactly which version of the spec is truth.

**3. Re-anchor at every task start:**

```bash
shasum -a 256 .plans/AUTH/spec.md | cut -c1-8     # must equal the pin
grep -n "AC-1\|AC-2" .plans/AUTH/spec.md          # then read those sections only
```

- Match → read the frontmatter `summary` + in-scope ACs/constraints, work.
- Mismatch + amendment entry exists → the spec legitimately changed; use the
  new version, refresh pins in pending task descriptions.
- Mismatch + **no** amendment entry → **silent drift**. Stop, restore the
  artifact from git, re-read. Never implement against a spec you can't
  account for.

**4. Complete with conformance evidence:**

```
task_update AUTH-1 completed
  evidence="AC-1, AC-2 verified: pytest tests/auth -q → 14 passed, 0 failed;
            files: src/auth/hasher.ts, tests/auth/hasher.test.ts"
```

"It should work now" is rejected by the harness; AC ids + real command output
is the standard.

**5. Amend, never rewrite.** Mid-run discovery (operator adds rate limiting):

```markdown
## Amendments
- 2026-01-05 | operator | ADDED AC-5: rate-limit login to 5/min | security review
```

Bump `version`, refresh pins in pending tasks, continue. The amendment log is
the audit trail that makes long runs reviewable after the fact.

## For humans: reviewing an autonomous run

You don't need to watch the stream. Check these, in order:

1. **Spec quality** (`.plans/CODE/spec.md`): is every AC objectively checkable?
   Are non-goals and 🚫 boundaries stated? Garbage spec in = confidently
   traceable garbage out.
2. **Evidence vs ACs**: does each completed task cite AC ids and real command
   output? Uncited work is unaudited work.
3. **Amendments log**: every spec change has a dated entry with a reason? No
   entry + changed hash = silent drift — ask the agent to reconcile.
4. **Scope creep**: work touching files/behaviors beyond the ACs and non-goals
   should have triggered an amendment first. If not, flag it.
5. **⚠️ Ask-first gates**: the spec's ⚠️ tier is where the agent should have
   paused for you. Check it survived contact with the run.

To intervene mid-run: amend the spec (append an amendment entry), tell the
agent which AC ids changed — pins refresh from there. You never need to
re-brief the whole plan; the artifact is the briefing.

## For agents: token-efficiency playbook

- **Summary first**: read the frontmatter (`head -20 <file>`) before the body;
  the `summary:` field is designed to be enough for scanning.
- **Section-scoped reads**: `grep -n "AC-3" spec.md` then read only that
  region — not the whole file, every turn.
- **Tail for recency**: `tail -25 spec.md` shows the latest amendments without
  re-reading settled content.
- **Delegate by reference**: subagent prompts carry path + pin, never pasted
  spec bodies. The child reads ground truth itself — one source, no
  summary-drift between agents.
- **Compaction survival**: after any context reset, the task rows (with pins)
  are your recovery anchor; re-anchor before resuming work.
- **Skip artifacts entirely** for trivial sets — a 2-task fix needs no spec.
  Proportionality is part of the discipline.

### Subagent prompt skeleton

```
Read .plans/AUTH/spec.md; verify sha256 first-8 == 9f3c21ab before trusting it.
Implement AUTH-2 covering AC-3 only. ## Constraints apply verbatim
(⚠️ and 🚫 tiers included). Non-goals are hard boundaries.
Report: AC ids done, commands run, files changed.
```

## Failure modes and correct responses

| Symptom | Meaning | Response |
|---|---|---|
| Hash ≠ pin, no amendment entry | silent drift / tampered spec | restore from git, re-read, re-pin |
| Hash ≠ pin, amendment exists | legitimate change | adopt new version, refresh pending pins |
| Agent "remembers" a spec detail | hallucination risk | fresh disk read wins; memory never overrides file |
| Work beyond AC ids | scope creep (slop) | amend first or descope; never gold-plate |
| AC not covered by any task | gap in plan | add task or amend plan.md task map |
| Evidence without AC citation | unaudited claim | re-verify before accepting completion |

## Design notes (why it is shaped this way)

- **Schema is a floor, not a ceiling**: fixed parts are frontmatter keys, AC/D
  id stability, and append-only amendments. Everything else is free-form so
  the framework flexes to the work instead of the work contorting to fit.
- **EARS-style ACs preferred, not required** (`WHEN x THE system SHALL y`) —
  checkability is the requirement, phrasing is a convention.
- Based on the spec-driven-development patterns of GitHub Spec Kit, AWS Kiro,
  OpenSpec (delta specs), and BMAD (context-carrying story files): intent
  lives in versioned files, agents re-read rather than recall, changes are
  explicit and dated. This is the "spec-anchored" rung — spec kept and
  evolved through the work.
