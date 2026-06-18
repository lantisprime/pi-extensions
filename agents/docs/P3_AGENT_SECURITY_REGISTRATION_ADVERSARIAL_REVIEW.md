# P3 Security/Registration Adversarial Review

Review target:

- `agents/P3_AGENT_SCAFFOLD_PLAN.md`
- `agents/AGENT_SPEC.md`
- `agents/SECURITY_MODEL.md`
- `agents/REGISTRATION_GUIDE.md`

## Executive Verdict

**Conditional go, but this update adds enough surface area that implementation must be staged.**

Follow-up blocker resolutions are documented in:

```text
agents/P3_AGENT_SECURITY_REGISTRATION_BLOCKER_RESOLUTION.md
```

The security/registration additions are directionally correct, especially exact-hash registration, project-scoped approvals, TUI guidance, `/agents doctor`, and explicit ephemeral-agent constraints. However, these features can fail dangerously if implemented as UX-only affordances rather than hard runtime gates.

The critical requirement is: **registration status must be enforced at run time, not only displayed in `/agents list` or `/agents doctor`.**

## Blockers

### B-001: Registry must be a runtime gate, not advisory metadata

**Risk:** A project/user spec appears as unregistered in diagnostics but still runs through `/agents run` or `run_subagent` due to a routing bug.

**Required control:** All execution paths must call one shared `canRunAgent(spec, context)` function before child argv construction.

Must apply to:

- `/agents run`
- `/agents chain`
- `run_subagent`
- saved ephemeral specs
- project-level specs
- any future workflow command

Acceptance test:

- direct helper tests prove unregistered user/project specs cannot reach child argv construction.

### B-002: Ephemeral agents can become a registry bypass

**Risk:** A model or prompt says “create a temporary coding agent with this prompt” and bypasses the normal registered-spec controls.

**Required control:** P3 ephemeral agents must be slash-command/direct-user only and must not expose arbitrary prompt overrides through `run_subagent`.

Allowed:

```text
/agents run-temp reviewer <task>
```

Not allowed in P3:

```ts
run_subagent({ promptOverride: "..." })
```

unless a separate future review explicitly approves it.

### B-003: Project registration can be mistaken for project trust

**Risk:** Users may think `/agents register-project` makes the project safe. It only approves exact agent specs, not repo contents, code, context files, or tool outputs.

**Required control:** Registration copy must be precise:

```text
This registers exact agent spec hashes only. It does not sandbox this project or trust arbitrary project content.
```

### B-004: Hash approval can hide dangerous capability changes if normalized incorrectly

**Risk:** If hashing uses normalized frontmatter/prompt instead of raw file bytes, attackers may exploit parser ambiguities or ignored content.

**Required control:** Registry hash must be over raw file bytes, plus path/name metadata in the registry entry. Normalized spec can be stored for display, but trust must bind to raw bytes.

### B-005: TUI wizard must not collapse suspicious/dangerous distinctions

**Risk:** “Register all” accidentally registers suspicious or dangerous specs.

**Required control:**

- dangerous specs: never register
- suspicious specs: require per-spec explicit confirmation, not covered by `--all-safe`
- `--all-safe`: only safe specs

## High-Risk Issues

### R-001: Scanner dependency can weaken independent installability

If agents imports Prompt Shield internals directly, the extension may become non-independent or break when installed alone.

Recommendation:

- vendor deterministic scanner into `agents/lib/security-scan.ts`, or keep a small local scanner
- Prompt Shield integration can be additive later
- absence of Prompt Shield must not disable registration scanning

### R-002: Non-TUI approval path must fail closed

JSON/print modes cannot confirm. If registration is attempted there, it must not write registry entries.

Required output should be bounded and actionable:

```text
Registration requires interactive confirmation. Run in TUI: /agents register <name>
```

No `--yes` or non-interactive approval flag in P3.

### R-003: Project registry path can collide or drift

If project hashing is inconsistent, approvals may not be found or may apply to wrong roots.

Recommendation:

- canonicalize project root deterministically
- hash canonical path with SHA-256
- record both hash and canonical path in registry file
- detect cwd mismatch and report in `/agents doctor`

### R-004: `/agents doctor` may become too broad and slow

Doctor should not recursively scan huge trees or run model calls.

Constraints:

- only known spec directories
- bounded file sizes
- deterministic scanning only
- no child Pi/provider calls
- bounded output with counts and top issues

### R-005: Saved ephemeral agent file can be modified before registration

This is okay if registration hashes raw bytes at registration time, but UX must not imply saved temp equals trusted.

Required copy:

```text
Saved, but not runnable until registered. If edited, the edited bytes are what registration approves.
```

## Medium-Risk Issues

### M-001: Missing evals for user/project agents can be misunderstood

Plan says missing evals do not block P3. That is okay, but display should distinguish:

```text
evals: missing (non-blocking in P3)
```

### M-002: Suspicious ephemeral prompt in non-TUI mode

Should fail closed. Do not try to continue with warning-only behavior.

### M-003: Project agents with reserved names

A project may ship `.pi/agents/reviewer.md`. In P3, built-ins are reserved and win.

Doctor/list must make this obvious:

```text
.pi/agents/reviewer.md shadowed by built-in reviewer; not runnable under that name.
```

### M-004: Agent prompt scanning can produce false positives

Registration UX should allow suspicious-but-not-dangerous specs after explicit confirmation. Otherwise useful project agents may become too hard to use.

### M-005: Chain mode multiplies blocked-state complexity

If chain includes one blocked project agent, the whole chain should fail before starting any child, not partially execute earlier agents.

## Required Tests Before Implementation Is Considered Complete

1. `canRunAgent` blocks unregistered user spec.
2. `canRunAgent` blocks unregistered project spec even if project trust is active.
3. `canRunAgent` blocks project spec when project trust is inactive even if registry entry exists.
4. raw-byte hash mismatch blocks run.
5. project registry approval does not apply to another project root.
6. dangerous spec cannot register.
7. suspicious spec requires explicit TUI confirmation.
8. non-TUI registration writes no registry entry.
9. `--all-safe` excludes suspicious and dangerous specs.
10. ephemeral run does not write a file or registry entry.
11. saved ephemeral file is not runnable until registered.
12. `run_subagent` does not accept arbitrary prompt override in P3.
13. chain preflights every agent before first child starts.
14. `/agents doctor` reports inactive trust, missing registration, hash mismatch, dangerous specs, and shadowed reserved names.
15. doctor uses bounded deterministic checks only.

## Recommended Cut Order If Scope Gets Too Large

Cut in this order:

1. chain mode
2. ephemeral save flow, keeping run-temp only
3. user-level custom agents
4. project-level custom agents
5. `run_subagent` tool

Do **not** cut:

- runtime registry gate
- raw-byte exact-hash trust
- no prompt/task in argv
- no `--approve` default
- output/timeout caps
- no recursive subagents
- non-TUI fail-closed registration

## Final Recommendation

Proceed with the security/registration design only if implementation treats it as a security boundary inside the extension. The TUI guide and doctor command are good UX, but the real control is the shared runtime gate:

```text
resolve spec -> validate -> scan -> check trust/registry -> canRunAgent -> build child argv
```

No execution path should bypass that sequence.
