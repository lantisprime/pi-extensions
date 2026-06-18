# P3 Agents

A Pi extension for defining, registering, vetting, and running constrained
child agents. Read-only by default.

> **User Manual**: See [../../docs/USER_MANUAL.md](../../docs/USER_MANUAL.md#registered-custom-agents) for scenario guides. No write, edit, bash, or `run_subagent` in
child tools unless the spec explicitly re-requests them.

## Quick smoke

Verify the extension loads without errors:

```bash
pi --no-extensions -e ./agents/index.ts --list-models
```

## Built-in agents

Three agents ship with the extension:

| Agent | Role | Tools | Output contract |
|---|---|---|---|
| `scout` | Read-only codebase reconnaissance | `read`, `grep`, `find`, `ls` | Files inspected, findings, unknowns |
| `planner` | Implementation/validation planning | `read`, `grep`, `find`, `ls` | Files to change, staged steps, risks, validation commands |
| `reviewer` | Adversarial review with verdict | `read`, `grep`, `find`, `ls` | Blocking issues, non-blocking issues, missing tests, safety concerns, verdict |

Reviewer verdicts: `go`, `conditional-go`, `no-go`.

No write, edit, bash, or `run_subagent` tools are allowed by default.

## Commands

```
/agents list                         Show all built-in + registered agents
/agents built-ins                    List built-in agent specs
/agents config                       Show extension configuration
/agents inspect <name>               Inspect a single agent spec
/agents registry                     Show registration registry
/agents verify                       Verify all registered agent specs
/agents doctor                       Full consistency + trust diagnostic
```

### Registration

```
/agents register <path-or-name>      Register a user/project agent
/agents register-project [--all-safe] Register project agents (--all-safe skips suspicious)
/agents unregister <name>            Remove a registered agent
```

- Registration writes a raw-byte SHA-256 hash of the spec file.
- Hash mismatch at runtime blocks execution (fail-closed).
- Dangerous specs (per deterministic security scanner) never register.

### Running agents

```
/agents run <agent> <task>           Run a single built-in or registered agent
/agents run-temp <scout|planner|reviewer> <task>  One-shot ephemeral run (not registered)
/agents save-temp <name>             Save a temp agent for inspection/debug
/agents chain <a>,<b>[,<c>] <task>   Run up to 3 agents in sequence with handoff
```

### Profiles

```
/agents profiles                     List all available model profiles
/agents profiles register <path>     Register a profile file
/agents profiles unregister <name>   Remove a registered profile
```

Profiles carry model/capability hints (`model`, `thinking`) and are resolved with
agent spec precedence (higher trumps lower): user > built-in, project > user. Three built-in profiles ship
with the extension: `fast-local`, `reasoning-deep`, `adversarial-review`.

## Agent spec format

Agents are defined as Markdown files with YAML frontmatter. Example:

```markdown
---
name: my-scout
description: Custom project scout
model: openai-codex/gpt-5.5
profile: fast-local
tools: [read, grep, find, ls]
---
Scout the repository and report findings…
```

Supported Markdown frontmatter fields: `name`, `description`, `tools`, `model`, `thinking`, `profile`.

Other fields on the internal `AgentSpec` type (`source`, `maxTaskChars`, `maxResultChars`,
`evals`, `outputContract`, `limits`, `observability`, `safety`, etc.) are not user-settable
via Markdown — they are derived from built-in defaults or profile resolution.

## Safety model

1. **Read-only default tools** — `read`, `grep`, `find`, `ls`.
2. **Forbidden tools** — `write`, `edit`, `bash`, `run_subagent`.
3. **canRunAgent gate** — every agent passes the runtime gate before `child pi` argv is built.
4. **Deterministic security scanner** — classifies specs as safe/suspicious/dangerous.
   Dangerous specs never register.
5. **Hash-based registration** — exact path + raw-file-byte SHA-256; mismatch blocks execution.
6. **Project trust** — project agents require active project trust.
7. **Child argv safety** — task text goes to stdin (not shell argv), `--no-approve` by default.
8. **No chain through `run_subagent`** — the `run_subagent` tool schema has no chain parameter.

## Chain mode

`/agents chain scout,planner <task>` runs up to 3 agents in sequence:

1. All agents preflighted through `canRunAgent` before first spawn.
2. Each agent's `summary.summaryText` is handed off to the next agent.
3. Mid-chain failure, hash mismatch, or timeout stops all subsequent agents.
4. Handoff text truncated at 24,000 bytes to stay within agent limits.

Maximum chain length: 3.

## Ephemeral agents

- `/agents run-temp` — one-shot run with no persistence; requires TUI confirmation.
  Non-TUI mode is fail-closed (no run).
- `/agents save-temp` — saves for inspection; does not register.
  Saved specs still require explicit registration before running.

If an agent spec sets both `model` and `profile`, the profile takes precedence
(profile-as-authority resolution).

## Model profiles

Model profiles define reusable model/capability configurations. Three built-in
capability-hint profiles ship with the extension. User/project profile files are
auto-discovered from the user/project agents directories and can be registered
with hash-based trust.

## Registration guide

1. Write a Markdown agent spec.
2. Run `/agents register <path>` from within Pi.
3. The spec is scanned (safe/suspicious/dangerous).
4. TUI confirmation required; non-TUI is fail-closed.
5. Upon registration, a raw-byte SHA-256 hash is stored in the registry.
6. Any change to the file invalidates the hash and blocks execution until re-registration.

## Testing

```bash
# All test suites
for s in agents/test-fixtures/run-p3*.sh; do echo "--- $s"; ./$s; done

# Individual slices
./agents/test-fixtures/run-p3b-1-tests.sh   # Core spec model and built-ins
./agents/test-fixtures/run-p3b-2-tests.sh   # Markdown parser and security scanner
./agents/test-fixtures/run-p3b-3-tests.sh   # Registry and runtime gate
./agents/test-fixtures/run-p3b-4-tests.sh   # Diagnostics commands
./agents/test-fixtures/run-p3b-5-tests.sh   # Registration flows
./agents/test-fixtures/run-p3c-1-tests.sh   # JSONL monitor and child argv builder
./agents/test-fixtures/run-p3c-2-tests.sh   # Built-in child execution
./agents/test-fixtures/run-p3c-3-tests.sh   # Registered user/project execution
./agents/test-fixtures/run-p3c-4-tests.sh   # Ephemeral one-shot agents
./agents/test-fixtures/run-p3d-1-tests.sh   # run_subagent single-run tool
./agents/test-fixtures/run-p3d-2-tests.sh   # Command-only chain mode
./agents/test-fixtures/run-p3f-1-tests.sh   # Model profiles pure helpers
./agents/test-fixtures/run-p3f-2-tests.sh   # Model profiles wiring
./agents/test-fixtures/run-p3f-3-tests.sh   # Profile file discovery + hash-registration
```

Tests use `npx tsx` and pure `.mjs` files. No live child `pi` processes are
spawned — all child execution is mocked via `agentsChildRunner`.

## Reference docs

- `AGENT_SPEC.md` — Full agent specification format
- `SECURITY_MODEL.md` — Security model and invariants
- `REGISTRATION_GUIDE.md` — Step-by-step registration guide
- `P3_AGENT_SCAFFOLD_PLAN.md` — Original P3 scaffold plan
- `P3_IMPLEMENTATION_SLICES.md` — Slice ladder and implementation history
