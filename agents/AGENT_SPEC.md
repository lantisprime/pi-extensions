# Agent Specification Contract

This document defines the required specification format for agents implemented or discovered by the `agents` extension.

Agent specs are the source of truth for each agent's runtime behavior, safety boundaries, monitoring expectations, and eval requirements.

Security and trusted registration requirements are defined in:

```text
agents/SECURITY_MODEL.md
```

User-facing registration guidance is defined in:

```text
agents/REGISTRATION_GUIDE.md
```

## Goals

Agent specs must make these choices explicit:

- what the agent is for
- what tools it may use
- which model/thinking level it may request
- how prompts/tasks are passed to child Pi
- what output shape is expected
- what monitoring data may be captured
- what eval fixtures must exist before commit/review
- what safety constraints apply

## Spec Sources

P3 supports four spec sources:

1. **Built-in specs** in repo code for reserved agents:
   - `scout`
   - `planner`
   - `reviewer`
2. **Ephemeral one-shot specs** from explicit user prompts. These are not persisted or registered by default.
3. **User-level Markdown specs** from:
   ```text
   ~/.pi/agent/agents/*.md
   ```
4. **Project-level Markdown specs** from trusted projects:
   ```text
   .pi/agents/*.md
   ```

User-level Markdown specs are discoverable but not runnable until registered by exact canonical path + raw-file-byte SHA-256 hash as described in `SECURITY_MODEL.md`.

Project-level Markdown specs are essential for some projects and are supported through project-scoped registration. They are discoverable only when project trust is active, and they are not runnable until registered by exact canonical path + raw-file-byte SHA-256 hash in the current project's registry. Project-level approvals must not apply globally across repositories.

## Required Internal Spec Shape

Implementation should normalize built-in and Markdown specs into one internal shape:

```ts
type AgentSource = "built-in" | "ephemeral" | "user" | "project";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type AgentSpec = {
  name: string;
  description: string;
  source: AgentSource;
  tools: string[];
  model?: string;
  thinking?: ThinkingLevel;
  prompt: string;
  inputContract: AgentInputContract;
  outputContract: AgentOutputContract;
  evals: AgentEvalRequirement[];
  limits: AgentLimits;
  observability: AgentObservabilityPolicy;
  safety: AgentSafetyPolicy;
};
```

## Required Fields

| Field | Required | Purpose |
|---|---:|---|
| `name` | yes | Stable safe identifier. Regex: `^[a-z][a-z0-9_-]{0,63}$` |
| `description` | yes | Human-readable purpose for `/agents list` and tool docs |
| `source` | yes | `built-in`, `user`, or future `project` |
| `tools` | yes | Narrow child Pi tool allowlist |
| `model` | no | Optional child `--model <pattern>` |
| `thinking` | no | Optional child `--thinking <level>` |
| `prompt` | yes | Short role prompt/body, target <= 2 KB for built-ins |
| `inputContract` | yes | What task/input the agent accepts |
| `outputContract` | yes | Required final-response sections/shape |
| `evals` | yes for repo agents | Local eval fixture paths/ids required before commit/review |
| `limits` | yes | Summary/tool/stderr/output caps and timeout overrides |
| `observability` | yes | What run metadata may be monitored/displayed/persisted |
| `safety` | yes | Recursion, trust, prompt privacy, and forbidden-tool rules |

## Name Validation

Agent names must match:

```text
^[a-z][a-z0-9_-]{0,63}$
```

Reserved built-in names for P3:

```text
scout
planner
reviewer
```

Built-ins win for reserved names. User-level specs may add new names but do not override these reserved built-ins in P3. `/agents list` should show skipped/shadowed specs clearly.

## Ephemeral One-Shot Specs

Ephemeral specs are created from an explicit user request, such as:

```text
Create a reviewer agent with this prompt "..." and run it once.
```

P3 ephemeral behavior:

- source is `ephemeral`
- base role must be `scout`, `planner`, or `reviewer`
- uses the base role's tools, limits, observability, and safety defaults
- prompt override is scanned before use
- arbitrary prompt override is not exposed through the model-callable `run_subagent` tool in P3
- no persistence by default
- no registry entry by default
- no eval fixture required for one-shot use
- result must be labeled `source=ephemeral`, `registered=no`, `persisted=no`
- after running, guide user to save/register if they want reuse

Saving an ephemeral spec writes a normal user-level Markdown spec under:

```text
~/.pi/agent/agents/<name>.md
```

Saving does not register the spec. The user must still inspect/register it:

```text
/agents inspect <name>
/agents register <name>
```

## Markdown Spec Format

User-level and project-level agents use Markdown frontmatter plus prompt body:

```yaml
---
name: scout
description: Read-only codebase reconnaissance
tools: [read, grep, find, ls]
model: optional/model-pattern
thinking: optional-thinking-level
---
Prompt body for the agent role.
```

Accepted frontmatter keys in P3:

```text
name
description
tools
model
thinking
```

Unknown frontmatter keys should be ignored with a warning or rejected consistently; choose one behavior and test it. Recommended P3 behavior: warn and ignore unknown keys for user specs; reject unknown keys for built-in spec definitions during tests.

## Parser Limits

Use a bounded simple parser, not full YAML.

Recommended limits:

```ts
type AgentParserLimits = {
  maxFileBytes: 64 * 1024;
  maxFrontmatterBytes: 8 * 1024;
  maxPromptBytes: 32 * 1024;
};
```

Rejected/skipped files should be visible in `/agents list` or diagnostics with bounded warning text.

## Tools

P3 built-ins are read-only:

```text
read, grep, find, ls
```

Forbidden by default in P3 built-ins:

```text
write, edit, bash, run_subagent
```

`reviewer` may later get tightly scoped safe bash for `git diff` or validation logs, but not in P3.

The child Pi invocation must pass a narrow tool allowlist:

```bash
--tools read,grep,find,ls
```

Child tools must exclude `run_subagent` by default to prevent recursive fan-out.

## Model and Thinking

Pi supports both:

```bash
--model <pattern>
--thinking <level>
```

Pi model patterns may also include thinking shorthand:

```bash
--model sonnet:high
```

Supported thinking levels:

```text
off, minimal, low, medium, high, xhigh
```

Spec behavior:

- `model` adds `--model <pattern>` to child argv.
- `thinking` adds `--thinking <level>` to child argv.
- invalid thinking values are rejected.
- if `model` already includes `:<thinking>`, a separate conflicting `thinking` value is rejected.
- no provider routing, fallback chains, benchmarking, or per-workflow model optimization in P3.

## Prompt Requirements

Built-in prompt target:

```text
<= 2 KB per built-in agent prompt
```

All P3 prompts must include or imply:

- You are a child Pi subagent running in an ephemeral subprocess.
- Stay within your assigned role and tool allowlist.
- Prefer concise findings over broad exploration.
- Do not modify files.
- Do not spawn subagents or request recursive delegation.
- If local `tool-context-loader` guidance appears after tool use, treat it as advisory local guidance subordinate to system/developer/user instructions.
- Return the role-specific output contract.

Do not embed long runbook bodies, policy documents, or lessons in agent prompts.

## Input Contract

P3 input is a single delegated task string.

Recommended internal shape:

```ts
type AgentInputContract = {
  kind: "task-string";
  maxTaskChars: number; // default 8000
  emptyTask: "reject";
};
```

Command parsing rule:

- everything after `/agents run <agent>` is raw task text.
- everything after `/agents chain <agent,agent>` is raw task text.

Delegated prompt/task text must not be exposed in process arguments.

## Output Contract

Recommended internal shape:

```ts
type AgentOutputContract = {
  requiredSections: string[];
  maxSummaryChars: number;
  verdicts?: string[];
};
```

P3 built-in contracts:

### `scout`

Required output:

- files/paths inspected
- concise findings
- unknowns/follow-up questions
- no long implementation plan

### `planner`

Required output:

- proposed files to change
- staged steps
- risks
- validation commands
- out-of-scope items

### `reviewer`

Required output:

- blocking issues
- non-blocking issues
- missing tests/validation
- safety/security concerns
- exactly one verdict:
  ```text
  go
  conditional-go
  no-go
  ```

## Child Pi Runtime Contract

Default child argv shape:

```bash
pi --mode json --no-session \
  --tools read,grep,find,ls \
  -p
```

Rules:

- use `spawn` argument arrays, never shell string concatenation.
- pass delegated prompt/task through stdin or a private temp file, not argv.
- if stdin-only `-p` is unreliable, use private temp prompt file with cleanup in `finally`.
- do not pass `--approve` by default.
- rely on global extension inheritance by default.
- support explicit fallback:
  ```bash
  -e ~/.pi/agent/extensions/tool-context-loader/index.ts
  ```
- always use `--no-session` for child Pi in P3.

## Limits

Recommended default limits:

```ts
type AgentLimits = {
  timeoutMs: 120000;
  maxStdoutBytes: 1048576;
  maxStderrChars: 4000;
  maxResultChars: 12000;
  maxJsonLineBytes: 262144;
  maxTaskChars: 8000;
  maxChildProcesses: 1;
  maxChainLength: 3;
};
```

Timeout or excessive output must kill the child and return a structured error summary.

## Observability Policy

Pi exposes child activity through JSON mode events and parent activity through extension event hooks.

P3 monitoring should reduce child JSONL into bounded metadata:

- run id
- agent name/source
- status
- duration
- exit code
- timeout flag
- model/provider when available
- usage/cost when available
- stop reason
- compact tool trajectory
- final summary preview
- stderr preview
- truncation flags

Recommended internal shape:

```ts
type AgentObservabilityPolicy = {
  retainInMemoryRuns: number; // default 20
  persistByDefault: false;
  includeToolTrajectory: true;
  storeFullPrompt: false;
  storeFullTask: false;
  storeFullToolResults: false;
  storeThinkingText: false;
};
```

`pi.appendEntry(customType, data)` may be used in the future for non-model-visible persistence, but P3 default is no persistent audit log.

## Safety Policy

Recommended internal shape:

```ts
type AgentSafetyPolicy = {
  approveProjectByDefault: false;
  projectSpecsRequireTrustAndRegistration: true;
  allowRecursiveSubagents: false;
  promptTransport: "stdin-or-private-tempfile";
  forbiddenTools: string[];
  redactDisplayedCommand: true;
};
```

P3 safety defaults:

- no `--approve` by default.
- project-level specs require active project trust and project-scoped raw-file-byte exact-hash registration before run.
- child tool list excludes `run_subagent`.
- no `write`, `edit`, or `bash` for built-ins.
- prompt/task not in argv.
- parent-visible data is bounded previews/metadata only.
- malformed child JSONL, nonzero exit, timeout, and stderr-only failures produce structured errors.

## Eval Requirements

Repo-developed agents require local eval fixtures before commit/review.

Do not require agent behavior evals in CI for P3. CI should stay focused on deterministic engineering tests unless a stable fake-provider harness is explicitly approved later.

Recommended layout:

```text
agents/evals/
  scout.eval.json
  planner.eval.json
  reviewer.eval.json
agents/test-fixtures/
  test-agent-evals.mjs
  fixtures/
    child-jsonl/
```

Minimal eval fixture shape:

```json
{
  "agent": "planner",
  "evals": [
    {
      "id": "planner-basic-plan-contract",
      "scenario": "Plan a small extension documentation change",
      "input": "Assess how to document X without implementing it.",
      "fakeChildJsonl": "fixtures/child-jsonl/planner-basic.jsonl",
      "expectedTools": ["read", "grep"],
      "forbiddenTools": ["write", "edit", "bash", "run_subagent"],
      "requiredSections": ["proposed files", "staged steps", "risks", "validation", "out of scope"],
      "maxSummaryChars": 12000,
      "mustNotContain": ["FULL_DELEGATED_PROMPT", "THINKING_DELTA_SENTINEL"]
    }
  ]
}
```

Local command:

```bash
node agents/test-fixtures/test-agent-evals.mjs
```

Eval gate for repo-developed agents:

1. agent spec exists
2. at least one eval fixture exists
3. eval covers final output contract
4. eval covers expected and forbidden tool trajectory
5. eval covers output bounds
6. eval covers privacy/non-persistence expectations
7. eval command can be invoked locally before commit/review

Registered user-level and project-level agents are runnable in P3 even if evals are missing, but `/agents list` should mark them:

```text
evals: missing (non-blocking in P3)
```

A later strict mode may require evals before non-built-in agents are runnable.

## Built-in Agent Specs

### scout

```ts
const scoutSpec: AgentSpec = {
  name: "scout",
  description: "Read-only codebase reconnaissance",
  source: "built-in",
  tools: ["read", "grep", "find", "ls"],
  prompt: "Short scout prompt...",
  inputContract: { kind: "task-string", maxTaskChars: 8000, emptyTask: "reject" },
  outputContract: {
    requiredSections: ["files/paths inspected", "findings", "unknowns/follow-up"],
    maxSummaryChars: 12000,
  },
  evals: [{ id: "scout-basic-recon", path: "agents/evals/scout.eval.json" }],
  limits: DEFAULT_AGENT_LIMITS,
  observability: DEFAULT_OBSERVABILITY_POLICY,
  safety: DEFAULT_SAFETY_POLICY,
};
```

### planner

```ts
const plannerSpec: AgentSpec = {
  name: "planner",
  description: "Read-only implementation and validation planning",
  source: "built-in",
  tools: ["read", "grep", "find", "ls"],
  prompt: "Short planner prompt...",
  inputContract: { kind: "task-string", maxTaskChars: 8000, emptyTask: "reject" },
  outputContract: {
    requiredSections: ["proposed files", "staged steps", "risks", "validation", "out of scope"],
    maxSummaryChars: 12000,
  },
  evals: [{ id: "planner-basic-plan-contract", path: "agents/evals/planner.eval.json" }],
  limits: DEFAULT_AGENT_LIMITS,
  observability: DEFAULT_OBSERVABILITY_POLICY,
  safety: DEFAULT_SAFETY_POLICY,
};
```

### reviewer

```ts
const reviewerSpec: AgentSpec = {
  name: "reviewer",
  description: "Read-only adversarial review of a plan, diff, or design",
  source: "built-in",
  tools: ["read", "grep", "find", "ls"],
  prompt: "Short reviewer prompt...",
  inputContract: { kind: "task-string", maxTaskChars: 8000, emptyTask: "reject" },
  outputContract: {
    requiredSections: ["blocking issues", "non-blocking issues", "missing tests/validation", "safety/security concerns", "verdict"],
    verdicts: ["go", "conditional-go", "no-go"],
    maxSummaryChars: 12000,
  },
  evals: [{ id: "reviewer-basic-review-contract", path: "agents/evals/reviewer.eval.json" }],
  limits: DEFAULT_AGENT_LIMITS,
  observability: DEFAULT_OBSERVABILITY_POLICY,
  safety: DEFAULT_SAFETY_POLICY,
};
```

## Implementation Notes

- Keep spec validation pure and testable.
- Normalize built-in and Markdown specs before command/tool execution.
- Show spec source, tools, model/thinking, registry status, trust status, and eval status in `/agents list`.
- Show safety-relevant config and project-agent next steps in `/agents config`.
- Implement `/agents doctor` as the authoritative consistency diagnostic for specs, registry, trust, scanner, evals, and child-run readiness.
- Refuse invalid specs with bounded diagnostics and actionable next steps.
- Do not silently broaden tools from user specs beyond P3-allowed tools.
