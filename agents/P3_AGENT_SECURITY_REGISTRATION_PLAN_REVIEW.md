# P3 Security/Registration Plan Review

Review target:

- `agents/P3_AGENT_SCAFFOLD_PLAN.md`
- `agents/AGENT_SPEC.md`
- `agents/SECURITY_MODEL.md`
- `agents/REGISTRATION_GUIDE.md`

## Verdict

**Conditional go, with sequencing constraints.**

Follow-up blocker resolutions are documented in:

```text
agents/P3_AGENT_SECURITY_REGISTRATION_BLOCKER_RESOLUTION.md
```

The substantive updates improve the design materially. Project-level agents are now usable without silently trusting repo-controlled prompts, ephemeral agents are supported without creating durable trust, and TUI registration has a clear path from discovered spec to runnable agent.

The plan should proceed only if implementation preserves the order below:

1. spec parsing/normalization
2. scanner/risk classification
3. registry checks
4. doctor diagnostics
5. registration TUI/non-TUI flows
6. child execution
7. `run_subagent` tool

Do not implement child execution for user/project specs before registry gates are working.

## What Improved

### 1. Project agents now balance usability and security

Previous state disabled project agents by default. That was secure but too restrictive for repositories that depend on `.pi/agents/*.md`.

Current state is better:

- project specs are discoverable after project trust
- project specs require project-scoped raw-file-byte exact-hash registration before run
- approvals do not apply across unrelated repos
- unregistered project agents fail closed with actionable guidance

This is the right balance for P3.

### 2. Trusted registry is now concrete

The plan defines:

```text
~/.pi/agent/agents/registry.json
~/.pi/agent/agents/projects/<project-path-hash>.json
```

This supports separate trust domains for user-level and project-level agents.

### 3. TUI registration guidance closes the UX gap

`agents/REGISTRATION_GUIDE.md` makes registration user-guided rather than cryptic. The flow from `discovered -> valid -> scanned -> registered -> runnable` is clear.

Important UX improvements:

- `/agents register-project` batch summary
- `/agents doctor` prioritized remediation
- non-TUI fail-closed behavior with exact next commands
- saved ephemeral agents do not silently become trusted

### 4. Ephemeral agents are useful but bounded

Temporary agents address user prompts like “create a reviewer with this prompt and run it” without forcing persistence.

Good constraints:

- explicit user request only
- built-in base role only
- read-only tools
- prompt scan
- dangerous prompt rejection
- no persistence by default
- save/register path if reusable

### 5. Doctor command is now a first-class safety/UX feature

`/agents doctor` is important because this system has multiple state surfaces:

- project trust
- spec discovery
- scanner result
- registry hash
- eval status
- tool/model/thinking validity
- child-run readiness

A single diagnostic command is necessary.

## Required Clarifications Before Implementation

### 1. Define project root hashing

The plan references:

```text
~/.pi/agent/agents/projects/<project-path-hash>.json
```

Implementation must define canonicalization and hash algorithm.

Recommendation:

- canonical project root from `ctx.cwd` after resolving symlinks where possible
- SHA-256 of canonical path
- use same or similar approach as permission-policy if practical

### 2. Define scanner source

The plan says scan specs before registration. Implementation needs to decide whether to:

- import/copy shared scanner logic
- vendor scanner into `agents/`
- call Prompt Shield state only

Recommendation for independent installability:

- vendor deterministic scanner into `agents/lib/security-scan.ts` if code is needed
- do not require Prompt Shield to be installed
- optionally read Prompt Shield state as an additional signal later

### 3. Define suspicious prompt behavior in non-TUI mode

TUI can confirm suspicious prompts. Non-TUI cannot.

Recommendation:

- safe: can proceed for already registered specs
- suspicious unregistered registration: fail closed
- dangerous: always fail closed
- ephemeral suspicious prompt in non-TUI: fail closed unless a future explicit flag is designed

### 4. Define “explicit user request” for ephemeral agents

An LLM tool call might request an ephemeral agent. That is not necessarily direct user intent.

Recommendation:

- slash command `/agents run-temp` counts as explicit user request
- model-callable `run_subagent` should not support arbitrary prompt override in initial P3
- if prompt override is later exposed to `run_subagent`, require a separate review

### 5. Separate save from register

The plan says save-temp does not register automatically. Preserve this strictly.

Implementation should avoid convenience shortcuts like `save and register` in P3.

## Suggested Implementation Tests

Add tests for:

1. project registry path is project-scoped
2. same project agent path in different projects does not share approval
3. hash mismatch blocks run
4. unregistered project spec produces `/agents register-project` next step
5. `/agents doctor` returns `action-needed` for missing registration
6. non-TUI registration fails closed
7. TUI registration requires confirmation
8. ephemeral prompt is not persisted by run
9. save-temp writes file but does not register
10. dangerous ephemeral prompt cannot run or save

## Conditional Go Criteria

Proceed if implementation preserves these invariants:

- no unregistered user/project Markdown agent can run
- project approvals are project-scoped
- no dangerous spec/prompt can register or run
- ephemeral save does not imply registration
- non-TUI cannot silently approve
- doctor can explain blocked states
