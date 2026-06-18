# P3 Agent/Subagent Scaffold Adversarial Review

Review target: `agents/P3_AGENT_SCAFFOLD_PLAN.md`

## Executive Verdict

**Conditional go, with blockers to resolve before implementation.**

The plan is directionally good and incorporates the global Pi-agent design episode, but it introduces a higher-risk surface than the earlier command-only plan by adding ephemeral prompts, Markdown agent discovery, trusted registration, chain mode, and an LLM-callable `run_subagent` tool in P3. Those are acceptable only if implementation is staged and tests gate exposure.

## Blockers

### B-001: Stdin prompt transport is assumed, not proven

**Risk:** If `pi -p` without an argv message does not behave as expected with stdin in this subprocess setup, live subagent runs may hang, ignore the prompt, or behave unpredictably.

**Required action:** Before implementing the real child runner, add a tiny local proof or fake-runner abstraction. If stdin behavior is uncertain, default to private temp prompt files and cleanup.

Acceptance criteria:

- helper can build argv without task text
- delegated task text is present only in stdin/temp-file content
- temp-file fallback cleans up in success, error, and timeout paths

### B-002: Markdown agent files create a prompt-injection channel

**Risk:** User-level agent files under `~/.pi/agent/agents/*.md` can contain malicious instructions. Even though user-level files are more trusted than project-local files, they still need bounded parsing, clear precedence, deterministic scanning, and raw-file-byte exact-hash registration before execution.

**Required action:** Implement bounded parser, validation, scanner, and registry checks before user-level agents are runnable. If registry work slips, cut user-level execution and ship built-ins only.

Minimum constraints:

- file size cap
- frontmatter cap
- accepted keys allowlist
- name regex
- tools allowlist
- body cap
- warning/skip behavior for invalid files
- exact path + raw-file-byte SHA-256 registry approval before run
- changed file hash invalidates trust
- dangerous scanner result cannot register

### B-003: Ephemeral prompts can bypass registration if not constrained

**Risk:** A user may ask for a temporary agent with prompt text that tries to widen tools, persist itself, override instructions, or recursively spawn subagents. If treated as trusted because it came from the user, it can bypass the spec registry model.

**Required action:** Ephemeral agents must run only from explicit user requests, use a safe built-in base role, scan prompts before execution, reject dangerous prompts, require confirmation for suspicious prompts, remain read-only in P3, and never persist/register automatically.

### B-004: `run_subagent` can become recursive fan-out

**Risk:** If child Pi inherits the parent agents extension globally and the child tool allowlist includes `run_subagent`, a child can spawn more children. This may cause cost explosions, confusing control flow, or prompt recursion.

**Required action:** Tests must prove child argv `--tools` excludes `run_subagent` by default. The child prompt must also explicitly say not to spawn subagents.

### B-005: Chain mode may be too much for first implementation

**Risk:** Chain mode adds handoff summarization, error propagation, partial failure semantics, and output-budget interactions. It can distract from proving the single-run child scaffold.

**Required action:** Implement single run first. Chain mode can remain in P3 only if it is a separate commit/stage after single-run tests pass. If schedule pressure appears, defer chain mode rather than weakening bounds.

## High-Risk Issues

### R-001: Tool exposure before command validation

The plan says `run_subagent` is initial LLM-callable interface but also says it is enabled only after tests pass. Implementation must not register the tool until helper tests and command path work.

Recommended staged commits:

1. helpers + tests
2. slash commands + child runner
3. `run_subagent` tool
4. optional chain command

### R-002: Project-local trust can accidentally sneak in

Project-level agents are necessary for some repositories, but they are repo-controlled prompt/spec surfaces. Child Pi may also load project-local extensions/resources if global/default trust says yes or user passes approve later.

Recommendation:

- no `--approve` by default
- project-level specs require active project trust plus project-scoped raw-file-byte exact-hash registration before run
- first run of an unregistered required project agent should fail closed with an actionable `/agents register-project` or `/agents doctor` message
- proactive recommendations should surface project-agent registration needs once per status change without notification spam
- document that normal Pi context-file behavior still applies
- consider `--no-extensions -e <known safe extensions>` as a future hermetic mode, not P3 default

### R-003: Read-only tools can still expose sensitive data

`read`, `grep`, `find`, and `ls` can inspect sensitive repo files. A child subagent can summarize secrets into parent-visible output.

Recommendation:

- keep parent-visible output capped
- do not persist logs
- optionally add later deny patterns for `.env`, private keys, credentials
- rely on existing permission/prompt-shield ecosystem but do not claim this is a sandbox

### R-004: Stderr and malformed JSON can confuse parent output

Child JSON mode can emit non-JSON stderr or partial JSON on crashes.

Recommendation:

- separate stdout JSONL parsing from stderr diagnostics
- tolerate malformed stdout lines with warnings
- do not treat stderr as assistant summary

### R-005: Agent precedence can surprise users

Built-ins winning over user-level reserved names is safe, but users may expect to customize `scout`.

Recommendation:

- document reserved names clearly
- `/agents list` should show source and whether a user file was skipped/shadowed
- defer override config until later

## Medium-Risk Issues

### M-001: Model/thinking config can become scope creep

Pi supports per-run `--model <pattern>` and `--thinking <level>`, and model patterns may include thinking shorthand such as `sonnet:high`. Keep handling mechanical only: validate allowed thinking levels, pass `--model`/`--thinking`, and reject conflicts. No provider routing, fallback chains, model benchmarking, or per-workflow optimization in P3.

### M-002: Usage/cost may not be available in JSON events

The result type includes `usage?: unknown`. Treat it as optional and avoid tests that require provider-specific usage fields.

### M-003: CI should not depend on provider credentials or agent behavior evals

Deterministic engineering tests should stay in CI. Initial agent behavior evals should be locally invokable before commit/review using pure helpers, fake child JSONL output, or fixture scenarios, but should not be mandatory CI gates in P3. Live child Pi invocations belong in manual smoke tests until a fake provider or stable eval harness exists and is explicitly approved.

### M-004: Temp prompt files may be readable by other local processes

If using temp files, create a private temp directory with restrictive permissions where possible, avoid predictable names, and delete promptly.

### M-005: Monitoring can become a privacy leak

Pi exposes rich observability through extension events and JSON mode streams, including message text, tool args/results, usage/cost, errors, and sometimes thinking deltas. Monitoring must be bounded and privacy-conscious.

Recommendation:

- keep only compact in-memory run history by default
- do not persist full prompts, full tasks, full tool results, or thinking text in P3
- if `appendEntry` persistence is added later, require explicit config and store previews/metadata only
- redact or truncate tool args/results before parent-visible display

## Required Plan Changes Before Implementation

The current plan is acceptable if these implementation gates are explicitly followed:

1. Single-run helper tests before any subprocess execution.
2. Command path before `run_subagent` tool.
3. Single-run before chain mode.
4. `AGENT_SPEC.md`-compatible spec validation before built-in or user-level agents are runnable.
5. Bounded Markdown parser before user-level discovery.
6. Recursion exclusion test before registering `run_subagent`.
7. Prompt transport test proving task text is absent from argv.
8. Monitoring reducer test proving full prompts/tasks/thinking are not persisted or parent-visible by default.
9. Agent eval fixtures proving each role's required output contract and tool trajectory expectations.
10. Pre-commit/review command that reports missing, stale, or mismatched eval metadata for repo-developed agents without requiring agent behavior evals in CI.
11. `/agents doctor` consistency checks and proactive recommendation dedupe tests.
12. Ephemeral agent tests proving dangerous prompts cannot run, save is explicit, and saved specs remain unregistered until approved.
13. Registration-guide tests proving TUI flow asks for confirmation and non-TUI flow fails closed with exact next commands.

## Final Recommendation

Proceed with P3 implementation only as a staged scaffold:

```text
P3b helpers + Markdown parser + tests
P3c slash commands + single child runner
P3d run_subagent single-run tool
P3e optional chain command + docs/smoke
```

If any blocker proves expensive, cut scope in this order:

1. defer chain mode
2. defer user custom agents, keep built-ins only
3. defer `run_subagent`, keep command-only

Do not cut timeout/output caps, prompt argv privacy, or recursion prevention.
