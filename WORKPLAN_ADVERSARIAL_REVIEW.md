# Adversarial Review of `WORKPLAN.md`

## Review Stance

This review assumes the plan will fail unless its sequencing, scope, validation gates, and security assumptions are tightened. The goal is to find hidden coupling, over-broad MVP scope, missing validation, and unsafe defaults before implementation begins.

## Executive Verdict

**Conditional go, but not as written.**

The plan has the right strategic direction, but the MVP definition for `tool-context-loader` is too large, the agent sequencing still has ambiguity, and several safety assumptions need explicit validation before relying on them.

The highest-risk assumption is that child Pi subprocesses used by subagents will automatically inherit globally installed extensions, including `tool-context-loader`. That must be proven before agent-loader integration becomes a pillar of the roadmap.

## Top Risks

### R-001: `tool-context-loader` MVP is too large

**Severity:** High  
**Risk:** P1 becomes a long-running platform project instead of a shippable MVP.

The MVP includes:

- discovery
- trust gates
- parser
- episode eligibility
- duplicate identity
- preload
- JIT injection
- advisory wrappers
- budgets
- dedupe
- parallel race safety
- diagnostics
- 24 validation contracts

That is closer to a v1 release than an MVP.

**Failure mode:** implementation stalls before producing value; agents wait indefinitely; tests are delayed until after too much code exists.

**Recommendation:** split P1 into smaller slices:

1. **P1a: Discovery + diagnostics only**
   - scan configured roots
   - parse frontmatter
   - list eligible/unmapped files
   - no context injection yet

2. **P1b: Preload index only**
   - inject bounded index into system prompt
   - no JIT body loading yet

3. **P1c: JIT tool-result injection**
   - match tool calls
   - inject advisory-wrapped body excerpts
   - enforce budgets

4. **P1d: hardening**
   - dedupe lifecycle
   - parallel race safety
   - symlink/path escape tests

---

### R-002: Agent sequencing is internally ambiguous

**Severity:** High  
**Risk:** work starts on agents before the loader behavior they depend on is proven.

The plan says:

- P2 is minimal agent/subagent scaffold.
- Suggested task 7 says create minimal agents after loader skeleton is stable.
- Agent sequencing doc says minimal scaffold can start now, but broad workflows should wait.

These are compatible, but easy to misread.

**Recommendation:** define a hard boundary:

- Agent scaffold may start after **P1a discovery + diagnostics** exists.
- Agent-loader integration cannot start until **P1c JIT injection** exists.
- Full workflows cannot start until **P1d hardening** passes.

---

### R-003: Subagent extension inheritance is assumed, not verified

**Severity:** High  
**Risk:** tool-context-loader does not actually run inside child Pi subprocesses.

The subagent example spawns Pi with:

```text
--mode json -p --no-session
```

The workplan assumes globally installed extensions are loaded in that child process. That may be true, but the plan needs a proof step.

**Recommendation:** add a pre-integration validation task:

- Install a trivial global extension that marks the system prompt or emits a JSON-mode visible message.
- Run a child Pi invocation matching the subagent arguments.
- Confirm the extension loads in `--mode json -p --no-session`.

If it does not, the subagent extension must explicitly pass `-e` or otherwise ensure the loader is available.

---

### R-004: Global episodic memory scanning may leak irrelevant or sensitive context

**Severity:** High  
**Risk:** cross-project memories get injected into unrelated work.

The design allows global roots:

```text
~/.episodic-memory/episodes/
```

Global episodes may contain sensitive project details or stale practices. Even if advisory, they could steer the model incorrectly.

**Recommendation:** make global episodic memory disabled by default for injection. Allow global runbooks, but require explicit opt-in for global episodes:

```json
{
  "enableGlobalEpisodes": false
}
```

Also require tool tags and maybe project/category filters before global episodes are eligible.

---

### R-005: Prompt Shield integration is optional but the threat model depends on it

**Severity:** High  
**Risk:** runbook injection becomes a prompt-injection bypass.

The plan says the advisory wrapper subordinates runbook content, but wrappers are not a complete defense. If the loader injects malicious local content, the model may still follow it.

**Recommendation:** add a stricter MVP gate:

- If Prompt Shield reports active dangerous unapproved resources, `tool-context-loader` should disable body injection and only show diagnostics.
- Suspicious/unapproved runbooks should not be injected by default.

If direct Prompt Shield integration is too much for MVP, make body injection opt-in until integration exists.

---

### R-006: Validation gates do not include TypeScript/runtime checks

**Severity:** Medium  
**Risk:** tests pass while extensions fail to load under Pi/jiti.

The current gates include existing scripts, but no generic check that new TypeScript extension files load.

**Recommendation:** add a smoke command for each new extension:

```bash
pi -e ./tool-context-loader/index.ts -p "noop" --mode json
```

or an equivalent minimal load check. Also add syntax/type checking if the repo gains a package config.

---

### R-007: No explicit CI integration plan for new extension tests

**Severity:** Medium  
**Risk:** tests exist locally but are not enforced.

The root CI workflow should eventually include new test fixture scripts. The workplan says add shell tests but does not say to wire them into `.github/workflows/ci.yml`.

**Recommendation:** add done criteria:

- New extension tests are added to CI, or there is a documented reason they are manual-only.

---

### R-008: `VC-001` through `VC-024` may create false confidence if not mapped to tests

**Severity:** Medium  
**Risk:** contracts are listed but not traceable.

The plan says implement contracts, but there is no matrix showing test coverage.

**Recommendation:** add a validation matrix file or section:

```text
VC-001 -> test-fixtures/test-trust-gate.mjs
VC-002 -> test-fixtures/test-discovery-determinism.mjs
...
```

Done means every VC has one of:

- automated test
- live smoke test
- explicitly deferred with reason

---

### R-009: Workplan lacks rollback/kill-switch strategy

**Severity:** Medium  
**Risk:** a bad loader release pollutes every session context.

Since this extension may inject context globally, bad behavior could affect all projects.

**Recommendation:** include operational safety:

- `/tool-context-loader off`
- config `enabled: false`
- no-op behavior when config is invalid
- clear status indicator when disabled
- documented uninstall path

Some of this exists in design, but it should be a workplan gate.

---

### R-010: Agent prompts can drift into policy duplication

**Severity:** Medium  
**Risk:** agents become inconsistent with runbooks and policy extensions.

The plan says keep prompts short, but without a review rule, prompts may grow.

**Recommendation:** add an agent prompt budget:

- agent prompt max target: 1-2 KB
- no embedded runbook bodies
- no duplicated permission-policy or prompt-shield instructions beyond one-line deference

---

### R-011: The plan does not define ownership of existing extension regressions

**Severity:** Low  
**Risk:** new work breaks prompt-shield/permission-policy integration quietly.

The plan says keep existing extensions healthy, but not what to do if existing tests fail.

**Recommendation:** add policy:

- P1/P2 work stops if P0 gates fail.
- Fix P0 before continuing feature work.

---

### R-012: Documentation may get ahead of implementation

**Severity:** Low  
**Risk:** users think tool-context-loader exists because design docs and workplan are prominent.

**Recommendation:** clearly mark `tool-context-loader/` as design-only until `index.ts` exists and passes smoke tests. Keep README references under “Planned” until implementation lands.

## Required Changes to `WORKPLAN.md`

### Change 1: Split P1 into staged milestones

Replace single P1 MVP with:

- P1a Discovery + diagnostics
- P1b Preload index
- P1c JIT injection
- P1d Hardening + contract coverage

### Change 2: Add precondition for agent scaffold

P2 may begin after P1a, but P3 requires P1c or later.

### Change 3: Add subagent inheritance proof

Before P3, prove whether global extensions load in child Pi subprocesses.

### Change 4: Harden global episode defaults

Global episodic memory injection should be disabled by default unless explicitly enabled and tool-tagged.

### Change 5: Add Prompt Shield safety gate

Loader body injection should not occur for dangerous/unapproved resources.

### Change 6: Add VC coverage matrix

Every validation contract should map to automated, smoke, or deferred status.

## Suggested Revised Priority Order

1. **P0: Existing extension health**
2. **P1a: Tool-context-loader discovery + diagnostics**
3. **P1b: Preload index injection**
4. **P1c: JIT tool-result injection**
5. **P1d: Loader hardening + VC matrix**
6. **P2: Minimal agent scaffold**
7. **P3a: Prove subagent extension inheritance**
8. **P3b: Agent + loader integration**
9. **P4: Full workflows**

## Final Recommendation

Do not start with the full loader MVP as currently described. Start with discovery/diagnostics and make each behavior observable before injecting anything into model context.

The plan is good strategically, but it needs narrower milestones, explicit proof of subagent loader inheritance, safer global episode defaults, and stronger validation traceability before implementation begins.
