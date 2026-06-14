# P3 Security/Registration Blocker Resolution

This document maps the security/registration plan-review and adversarial-review findings to concrete plan changes.

Reviewed files:

- `agents/P3_AGENT_SCAFFOLD_PLAN.md`
- `agents/AGENT_SPEC.md`
- `agents/SECURITY_MODEL.md`
- `agents/REGISTRATION_GUIDE.md`
- `agents/P3_AGENT_SECURITY_REGISTRATION_PLAN_REVIEW.md`
- `agents/P3_AGENT_SECURITY_REGISTRATION_ADVERSARIAL_REVIEW.md`

## Resolution Summary

All identified blockers are resolved at the plan/spec level. Implementation must still satisfy the documented tests before code is considered complete.

## Blocker Resolutions

### B-001: Registry must be a runtime gate, not advisory metadata

Resolution:

- `SECURITY_MODEL.md` now requires one shared runtime gate:
  ```text
  resolve spec -> validate -> scan -> check trust/registry -> canRunAgent -> build child argv
  ```
- Applies to `/agents run`, `/agents chain`, `run_subagent`, saved ephemeral specs, project-level specs, and future workflow commands.
- `P3_AGENT_SCAFFOLD_PLAN.md` now requires tests proving execution cannot reach child argv without `canRunAgent` passing.

### B-002: Ephemeral agents can become a registry bypass

Resolution:

- Ephemeral agents require explicit slash/direct user request.
- Ephemeral agents use only built-in base roles: `scout`, `planner`, `reviewer`.
- Ephemeral prompt overrides are not exposed through `run_subagent` in P3.
- Dangerous ephemeral prompts cannot run or save.
- Suspicious ephemeral prompts fail closed in non-TUI mode and require TUI confirmation.
- Saving an ephemeral prompt does not register it.

### B-003: Project registration can be mistaken for project trust

Resolution:

- `REGISTRATION_GUIDE.md` and `SECURITY_MODEL.md` now require registration copy to state:
  ```text
  Registration approves exact agent spec hashes only. It does not sandbox the project or trust arbitrary repository content.
  ```
- Project trust and agent registration remain separate gates.

### B-004: Hash approval must bind to raw file bytes

Resolution:

- Registry trust material is now raw-file-byte SHA-256.
- Hash is not over normalized frontmatter or prompt text.
- Registry entry field is `rawBytesSha256`.
- Any raw-byte change invalidates trust.

### B-005: TUI wizard must not collapse suspicious/dangerous distinctions

Resolution:

- Dangerous specs/prompts never register, save, or run.
- Suspicious specs require per-spec explicit TUI confirmation.
- `--all-safe` registers only safe specs and excludes suspicious/dangerous specs.
- Non-TUI suspicious registration fails closed.

## High-Risk Issue Resolutions

### R-001: Scanner dependency can weaken independent installability

Resolution:

- Plan now requires an independent deterministic scanner vendored/local to `agents/`, e.g. `agents/lib/security-scan.ts`.
- Prompt Shield can be additive later but is not required for registration scanning.

### R-002: Non-TUI approval path must fail closed

Resolution:

- P3 has no `--yes`, `--force`, or non-interactive approval flag.
- Non-TUI registration writes no registry entry.
- Non-TUI output must provide exact TUI commands to run.

### R-003: Project registry path can collide or drift

Resolution:

- Project registry path uses SHA-256 of the canonical project root.
- Project registry stores both `projectRoot` and `projectRootHash`.
- `/agents doctor` must report root mismatch.
- Project approvals do not apply across different roots.

### R-004: `/agents doctor` may become too broad and slow

Resolution:

- Doctor must be bounded and deterministic.
- It scans only known spec directories.
- It applies file-size/frontmatter caps.
- It makes no child Pi calls and no provider/model calls.

### R-005: Saved ephemeral agent file can be modified before registration

Resolution:

- Save flow says saved specs are not runnable until registered.
- Registration approves bytes at registration time.
- If edited after saving, the edited bytes are what registration approves.

## Medium-Risk Issue Resolutions

### M-001: Missing evals can be misunderstood

Resolution:

- P3 display must mark missing evals as non-blocking:
  ```text
  evals: missing (non-blocking in P3)
  ```

### M-002: Suspicious ephemeral prompt in non-TUI mode

Resolution:

- Suspicious ephemeral prompts fail closed in non-TUI mode.

### M-003: Project agents with reserved names

Resolution:

- Built-ins are reserved and win in P3.
- `/agents doctor` and `/agents list` must report shadowed reserved names.

### M-004: Scanner false positives

Resolution:

- Suspicious but not dangerous specs can be registered after explicit TUI confirmation.
- Dangerous specs cannot register.

### M-005: Chain mode multiplies blocked-state complexity

Resolution:

- Chain mode must preflight every agent through `canRunAgent` before starting the first child.
- If any agent is blocked, the whole chain fails before execution.

## Remaining Implementation Gates

Implementation slices are defined in:

```text
agents/P3_IMPLEMENTATION_SLICES.md
```

Before implementation is considered complete, tests must prove:

1. shared `canRunAgent` blocks unregistered user/project specs before argv construction
2. raw-byte hash mismatch blocks run
3. project approvals are root-scoped
4. dangerous specs/prompts cannot register, save, or run
5. suspicious specs require TUI confirmation and are excluded from `--all-safe`
6. non-TUI registration writes no registry entries
7. ephemeral run does not persist or register
8. saved ephemeral specs remain unrunnable until registered
9. `run_subagent` has no arbitrary prompt override in P3
10. chain preflights all agents before execution
11. doctor reports inactive trust, missing registration, hash mismatch, dangerous specs, and shadowed names
12. doctor uses bounded deterministic checks only
