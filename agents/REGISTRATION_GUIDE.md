# Agent Registration Guide

This guide defines the user flow for getting an agent from discovered/spec-created to runnable.

The goal is to make registration easy in the TUI while preserving exact-hash trust and avoiding silent execution of untrusted prompts.

## Registration States

Every non-built-in agent should have a clear state:

```text
discovered -> valid -> scanned -> registered -> runnable
```

Blocked states:

```text
invalid
untrusted-project
unregistered
hash-mismatch
scanner-dangerous
forbidden-tools
model-thinking-conflict
```

Runnable rules:

- built-in agents are runnable after extension load
- ephemeral agents are runnable once from explicit user prompts under strict P3 defaults, but are not persisted
- user-level Markdown agents require exact path + raw-file-byte SHA-256 registration
- project-level Markdown agents require active project trust plus project-scoped exact path + raw-file-byte SHA-256 registration

## TUI Registration Wizard

When `ctx.hasUI` is true, registration commands should guide the user with dialogs using Pi's UI APIs:

```ts
ctx.ui.select(...)
ctx.ui.confirm(...)
ctx.ui.input(...)
ctx.ui.editor(...)
ctx.ui.notify(...)
```

### `/agents register <path-or-name>`

TUI flow:

1. Resolve candidate spec by name/path.
2. Parse and validate bounded spec.
3. Scan prompt/spec content.
4. Show review summary:
   ```text
   Agent: security-reviewer
   Source: user
   Path: ~/.pi/agent/agents/security-reviewer.md
   Raw-bytes SHA-256: abc123...
   Risk: safe | suspicious | dangerous
   Tools: read, grep, find, ls
   Model: default | <pattern>
   Thinking: default | high
   Evals: present | missing (non-blocking in P3)
   Runnable after approval: yes | no
   ```
5. If invalid: show reason and next step, no confirmation.
6. If dangerous: block registration and show scanner findings.
7. If suspicious: require explicit per-spec confirmation.
8. If safe: ask for confirmation anyway because registration creates durable trust.
9. Before confirmation, state clearly: registration approves this exact agent spec hash only; it does not sandbox the project or trust arbitrary repository content.
10. Write registry entry only after confirmation.
11. Notify success and show how to run:
    ```text
    Registered security-reviewer.
    Run: /agents run security-reviewer <task>
    ```

### `/agents register-project [--all-safe]`

TUI flow:

1. Check `ctx.isProjectTrusted()`.
2. If trust inactive, stop and guide:
   ```text
   Project trust is inactive.
   1. Run /trust
   2. Restart Pi if required
   3. Run /agents register-project
   ```
3. Discover `.pi/agents/*.md`.
4. Parse, validate, scan all candidates.
5. Show grouped summary:
   ```text
   Project agents found: 4
   Safe: 2
   Suspicious: 1
   Dangerous: 1 blocked
   Invalid: 0
   Hash changed: 1
   ```
6. Let user select which safe agents to register. Suspicious agents require separate per-spec confirmation and are never included in `--all-safe`.
7. Block dangerous agents regardless of selection.
8. Confirm exact raw-byte-hash approvals and state that registration approves only exact agent spec files, not the rest of the project.
9. Write entries to the current project registry only:
   ```text
   ~/.pi/agent/agents/projects/<project-path-hash>.json
   ```
10. Show runnable agents and next steps.

### `/agents doctor`

TUI flow:

1. Run all consistency checks.
2. Show status:
   ```text
   Status: ok | action-needed | blocked
   ```
3. Show prioritized next steps.
4. If actionable and safe, offer to launch the next command:
   - `/agents register-project`
   - `/agents inspect <name>`
   - `/agents register <name>`

`doctor` should not make changes by itself. It only diagnoses and guides.

### `/agents save-temp <name>`

TUI flow after an ephemeral one-shot agent:

1. Show the temporary agent summary:
   ```text
   Source: ephemeral
   Base role: reviewer
   Tools: read, grep, find, ls
   Persist target: ~/.pi/agent/agents/<name>.md
   ```
2. Confirm save. If the ephemeral prompt scanned as dangerous, do not save. If it scanned as suspicious, require explicit TUI confirmation and fail closed in non-TUI mode.
3. Write Markdown spec.
4. Do **not** register automatically.
5. Make clear that if the file is edited after saving, registration approves the edited bytes.
6. Guide:
   ```text
   Saved but not registered.
   Next: /agents inspect <name>
   Then: /agents register <name>
   ```

## Non-TUI / JSON / Print Modes

When `ctx.hasUI` is false:

- never prompt interactively
- do not register specs without an explicit future non-interactive approval design
- print bounded diagnostics and exact next commands
- registration should fail closed if confirmation would be required
- suspicious unregistered specs/prompts fail closed
- dangerous specs/prompts fail closed
- no `--yes`, `--force`, or non-interactive approval flag exists in P3

Example:

```text
Registration requires interactive confirmation.
Run in TUI mode:
  /agents inspect security-reviewer
  /agents register security-reviewer
```

## Proactive Guidance

The extension should proactively guide users without becoming noisy.

On `session_start` or first `/agents` command, if project trust is active and `.pi/agents/*.md` has blocked specs, show once per status change:

```text
Project agents found: 3 total, 2 unregistered, 1 hash changed.
Next: /agents doctor or /agents register-project
```

Dedupe key:

```text
projectRoot + aggregateSpecHashes + aggregateStatuses
```

Commands should include local next steps:

- `/agents list`: show runnable status and next command per blocked agent
- `/agents inspect`: show why this agent is or is not runnable
- `/agents run`: if blocked, fail closed with exact remediation
- `/agents verify`: show issue list plus commands
- `/agents doctor`: show ordered remediation plan

## Security Invariants

The guide must not bypass security controls:

- no silent registration
- no global approval for project specs
- no registration of dangerous specs
- hash changes invalidate trust
- saved ephemeral specs are not runnable until registered
- no prompt/task text in child process argv
- no forbidden P3 tools: `write`, `edit`, `bash`, `run_subagent`
- no `--approve` by default

## Successful Registration Definition

An agent is runnable only when all applicable checks pass:

```text
valid spec
scanner risk != dangerous
tools allowed
model/thinking valid
registry entry matches canonical path + raw-file-byte SHA-256 + name
project trust active for project specs
no reserved-name conflict
evals present OR evals missing (non-blocking in P3)
```

After success, user should see:

```text
Agent is runnable.
Run: /agents run <name> <task>
```
