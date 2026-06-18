# Pi Extensions — User Manual

Scenario-driven guide to the five Pi extensions. Each scenario starts with a
goal and walks through the extensions that help achieve it.

## Contents

1. [Defense in depth](#defense-in-depth) — layering Permission Policy, Prompt Shield, and Web Search
2. [Registered custom agents](#registered-custom-agents) — defining, vetting, and running your own agents
3. [Model profiles](#model-profiles) — reusable model/capability presets
4. [Agent chain workflows](#agent-chain-workflows) — scout → planner → reviewer pipelines
5. [Ephemeral one-shot agents](#ephemeral-one-shot-agents) — safe throwaway runs
6. [Just-in-time runbook guidance](#just-in-time-runbook-guidance) — command-specific context
7. [Web research with security](#web-research-with-security) — safe web search in Pi
8. [Permission modes deep dive](#permission-modes-deep-dive) — ask, read-only, auto, yolo
9. [Extension combo: full safety stack](#extension-combo-full-safety-stack)

---

## Defense in depth

**Goal**: Protect Pi from prompt injection, risky tool use, and unsafe child
agent execution.

### Layer 1: Prompt Shield

Scans all project and global resources (skills, prompts, extensions, AGENTS.md,
CLAUDE.md) for prompt-injection and agent-security risks.

```text
/prompt-shield scan             # Full rescan of all resources
/prompt-shield llm              # Force LLM review for suspicious resources
/prompt-shield mode ask         # Ask before allowing risky writes
/prompt-shield mode block-dangerous  # Block dangerous resource writes
```

If Prompt Shield finds a suspicious skill, approve or deny it:

```text
/prompt-shield approve ~/.pi/agent/skills/my-skill/SKILL.md
/prompt-shield deny   ~/.pi/agent/skills/my-skill/SKILL.md
```

### Layer 2: Permission Policy

Gates sensitive operations (bash, write, edit, web, outside-project reads).
Permission decisions can be once, session, or permanent per project.

```text
/permissions mode ask            # Ask for every gated operation (default)
/permissions mode read-only      # Auto-allow known read-only shell commands
/permissions                     # Show current permission state
/permissions reset               # Clear all project permissions
```

### Layer 3: Prompt Shield → Permission Policy integration

When Prompt Shield detects unapproved risky resources, Permission Policy
enters strict mode — it bypasses automatic and permanent grants and asks
again for bash, git, web, write/edit, and outside-project reads.

To clear strict mode:

```text
/prompt-shield approve <path>    # Approve the flagged resource
```

### Layer 4: Web Search safety

`secure_web_search` tool scans questions for prompt injection and fetches
only HTTPS pages through DNS consistency and malware-filtering checks.

### Layer 5: Agent safety

Child agents are read-only by default (`read`, `grep`, `find`, `ls`).
Forbidden tools (`write`, `edit`, `bash`, `run_subagent`) are blocked.
`canRunAgent` gate, hash registration, and project trust enforcement
run before any child `pi` process spawns.

---

## Registered custom agents

**Goal**: Create a project-specific agent that the team can reuse.

### Step 1: Write the agent spec

Create a Markdown file, e.g. `agents/my-scout.md`:

```markdown
---
name: my-scout
description: Custom project scout
model: openai-codex/gpt-5.5
profile: fast-local
tools: [read, grep, find, ls]
---
Scout the repository for patterns related to the delegated task.
Report file paths, findings, and follow-up questions.
```

### Step 2: Register the agent

```text
/agents register agents/my-scout.md
```

Pi scans the spec with the deterministic security scanner.
A TUI confirmation dialog shows the scan result.
Confirm to write the spec's raw-byte SHA-256 hash to the registry.

### Step 3: Verify registration

```text
/agents registry                 # See all registered agents
/agents inspect my-scout         # Inspect the registered spec
/agents doctor                   # Full consistency check
```

### Step 4: Run the agent

```text
/agents run my-scout Find all authentication-related code paths
```

### Step 5: Re-register after changes

If you edit `agents/my-scout.md`, the hash changes and the agent
can no longer run:

```text
/agents doctor                   # Will show hash mismatch
/agents register agents/my-scout.md  # Re-register with new hash
```

---

## Model profiles

**Goal**: Define reusable model/capability presets and assign them to agents.

### Built-in profiles

Three built-in capability-hint profiles ship with the extension:

| Profile | Purpose | Model hint |
|---|---|---|
| `fast-local` | Quick local models for fast iteration | — |
| `reasoning-deep` | Extended thinking for complex planning | `thinking: true` |
| `adversarial-review` | Security/adversarial review work | — |

### List available profiles

```text
/agents profiles
```

### Assign a profile to an agent

In the agent's Markdown frontmatter:

```markdown
profile: reasoning-deep
```

When both `model` and `profile` are set, the profile takes precedence
(profile-as-authority resolution).

### Register a custom profile

Create a profile file, e.g. `profiles/my-profile.md`:

```markdown
---
name: my-profile
model: openai-codex/gpt-5.5
thinking: true
purpose: Deep reasoning for architecture planning
---
```

```text
/agents profiles register profiles/my-profile.md
```

Registered project profiles require project trust. Hash registration
prevents unregistered profile changes from taking effect.

---

## Agent chain workflows

**Goal**: Run scout → planner → reviewer as a bounded sequential pipeline.

### Three-agent review pipeline

```text
/agents chain scout,planner,reviewer \
  Review the authentication module for security issues
```

1. **scout** — inspects the codebase, reports findings and unknowns
2. **planner** — receives the scout summary, produces staged implementation steps
3. **reviewer** — receives the plan, returns blocking/non-blocking issues and a verdict

### Two-agent quick pipe

```text
/agents chain scout,planner Audit the database migration scripts
```

### Chain safety

- All agents preflighted through `canRunAgent` before the first child spawns.
- Each agent's summary is handed off to the next (capped at 24,000 bytes).
- Mid-chain failure, hash mismatch, or timeout stops all subsequent agents.
- Maximum 3 agents per chain.
- No chain through `run_subagent` — the tool schema has no chain parameter.

---

## Ephemeral one-shot agents

**Goal**: Run a throwaway scout/planner/reviewer without registration.

### Quick codebase recon

```text
/agents run-temp scout Find all places where user input is used without validation
```

A TUI confirmation dialog appears (fail-closed in non-TUI mode).

### Save for later inspection

```text
/agents save-temp recon-2026-06-18
```

Saved specs are not registered — they must be explicitly registered
before they can run via `/agents run`.

---

## Just-in-time runbook guidance

**Goal**: Get command-specific operational guidance without bloating the context.

### When runbooks activate

Tool Context Loader appends concise guidance after you use a matching tool.
It does **not** preload runbook bodies into every prompt.

### Default scan roots

```
.pi/runbooks        (project-local, trusted projects only)
.runbooks           (project-local, trusted projects only)
.episodic-memory/episodes  (episodic memory episodes)
```

### Commands

```text
/tool-context-loader status      # Show discovered runbooks
/tool-context-loader verbose     # Include unmapped episodes and warnings
/tool-context-loader rescan      # Re-discover runbooks
/tool-context-loader on          # Enable injection (session-only)
/tool-context-loader off         # Disable injection (session-only)
```

### Writing a runbook

Create `.pi/runbooks/my-runbook.md`:

```markdown
---
id: my-runbook
summary: Guidance for a specific tool or workflow
tools: [bash]
injection: tool_result
priority: 70
match:
  commandIncludes: [kubectl, helm]
---
## Safety checks before running kubectl

1. Verify context: `kubectl config current-context`
2. Check namespace: `kubectl config view --minify | grep namespace`
3. Prefer `--dry-run=client` before apply
```

### Runbook vs episodic memory

- **Runbooks**: procedural, command-specific, repeated guidance. Best for
  `kubectl`, `git`, `em-store.mjs`, project-specific workflows.
- **Episodic memory**: durable decisions, lessons, discoveries across sessions.
  Use `em_store`, `em_search`, `em_revise` through the episodic-memory skill.

---

## Web research with security

**Goal**: Safely search the web from within Pi.

### Basic search via tool

The `secure_web_search` tool is available to the model:

```
User: "Search for the latest Pi coding agent release notes"
```

The tool scans the question for prompt injection before generating
search queries. Results are security-checked through DNS consistency,
malware-filtering DNS, and DNSBL checks.

### Local SearXNG setup

For private, self-hosted search:

```bash
cd web-search/optional-packages/searxng
./init.sh
docker compose up -d
```

Then in Pi:

```text
/web-search-config searxng http://127.0.0.1:8080/search
/web-search-config provider auto
/web-search-config list
```

### Sharing internal IPs

Save known internal IPs for secure access:

```text
/web-search-ip add 192.168.1.1
/web-search-ip add https://192.168.1.100/health
/web-search-ip list
```

Saved IPs are only used when `includeSavedIpUrls: true` is passed
to `secure_web_search`, and still go through HTTPS/TLS validation
and DNSBL checks.

---

## Permission modes deep dive

**Goal**: Understand and choose the right permission mode.

### `ask` (default)

Every gated operation prompts for a decision. You choose:
- Allow/Deny once
- Allow/Deny for session
- Allow/Deny permanently for this project

Best for: everyday development where you want explicit control.

### `read-only`

Automatically allows known read-only shell/git commands:
`pwd`, `ls`, `rg`, `cat`, `git status`, `git diff`, `git log`, etc.

Still prompts for: bash writes, destructive commands, web tools,
outside-project reads, git push/pull/commit.

Best for: code review, exploration, read-heavy sessions.

### `auto`

Uses the current LLM to classify bash/git commands.
`SAFE` commands auto-allow. `UNSAFE` or unclassified commands fall back
to the normal prompt.

Best for: agent-driven sessions where you want the model to make
routine command decisions.

### `yolo`

Auto-allows all gated operations. Shows a danger warning and confirmation
on enable. Hard-blocks `rm -rf /`-style commands even in yolo mode.

Best for: disposable workspaces, fully trusted projects, CI pipelines.

### Mode switching

```text
/permissions mode ask
/permissions mode read-only
/permissions mode auto
/permissions mode yolo
```

Shortcut: `ctrl+shift+m` cycles through all four modes.

---

## Extension combo: full safety stack

**Goal**: Maximum safety for working with untrusted or external repositories.

### Setup

```bash
# Load all extensions
pi -e ./permission-policy/index.ts \
   -e ./prompt-shield/index.ts \
   -e ./web-search/index.ts \
   -e ./tool-context-loader/index.ts \
   -e ./agents/index.ts
```

### Configuration

```text
# Layer 1: scan all resources for risks
/prompt-shield scan
/prompt-shield mode block-dangerous

# Layer 2: ask for all gated operations
/permissions mode ask

# Layer 3: set up secure web search
/web-search-config provider duckduckgo-html

# Layer 4: enable just-in-time runbook guidance
/tool-context-loader on

# Layer 5: verify agents are ready
/agents doctor
/agents profiles
```

### Daily workflow

1. Start Pi with all extensions loaded.
2. Prompt Shield scans on session_start — review any findings.
3. Permission Policy asks for sensitive operations.
4. Use `/agents run scout` for codebase exploration.
5. Use `secure_web_search` for web research (never raw `curl`).
6. Runbook guidance appears after matching tool calls.
7. Run `/agents doctor` before ending the session to check consistency.

### CI / non-interactive

For CI or headless Pi runs, Permission Policy and Prompt Shield fail-closed:

```bash
pi --mode text --no-session --no-approve \
  --no-extensions \
  -e ./permission-policy/index.ts \
  -e ./prompt-shield/index.ts \
  -p < task.txt
```

Non-TUI mode skips confirmation dialogs and fails closed —
no operation that requires a prompt is allowed through.
