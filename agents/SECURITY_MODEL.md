# Agents Security Model

This document defines the security model for the `agents` extension.

User-facing registration guidance is defined in:

```text
agents/REGISTRATION_GUIDE.md
```

## Research Summary

Current agent-security guidance converges on layered controls rather than prompt-only defenses:

- OWASP AI Agent Security Cheat Sheet recommends least-privilege tools, input validation and prompt-injection defense, memory/context isolation, human-in-the-loop controls, output validation, monitoring, multi-agent security, data protection, and adversarial validation.
- OpenAI Agents SDK guardrails docs distinguish input, output, and tool guardrails; when workflows include managers/handoffs/delegated specialists, checks around individual tool calls are needed rather than relying only on agent-level input/output guardrails.
- Microsoft multi-agent reference architecture recommends identity enforcement, RBAC, agent registry capability declarations, policy-controlled tool invocation, secure communication, memory redaction, guardrails, and observability.
- Pi security docs state that Pi has no built-in sandbox; project trust controls input loading only and does not make untrusted code/prompts safe. Strong isolation requires OS/container/VM boundaries.
- This repo already has Prompt Shield hash approvals and Permission Policy stricter-mode integration; the agents extension should reuse the same pattern: exact-hash trust, least privilege, bounded output, and explicit approvals.

Sources:

- https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html
- https://openai.github.io/openai-agents-python/guardrails/
- https://microsoft.github.io/multi-agent-reference-architecture/docs/security/Security.html
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/security.md`
- `prompt-shield/README.md`
- `permission-policy/README.md`

## Threat Model

### Trusted components

- `agents/index.ts` extension code after user/global install approval.
- Built-in agent specs shipped in this repo.
- Parent extension code that validates specs and builds child argv.

### Untrusted or conditionally trusted inputs

- User-level Markdown agent specs in `~/.pi/agent/agents/*.md` until registered by exact hash.
- Project-local specs in `.pi/agents/*.md` until project trust is active and the spec is registered by exact hash.
- Ephemeral one-shot agent prompts supplied by the user.
- Delegated task text from user/model.
- Repository files read by child agents.
- Child Pi JSONL output, stderr, tool results, and final assistant text.
- Any instructions discovered in runbooks, context files, source comments, docs, or tool output.

### Main risks

- Prompt injection in agent spec prompt bodies.
- Prompt injection in ephemeral one-shot agent prompts.
- Agent spec widening tools, model, thinking, limits, or safety policy unexpectedly.
- Recursive fan-out through `run_subagent`.
- Child agent leaking sensitive file contents into summaries or monitoring logs.
- Child output manipulating parent into executing actions.
- Project-local specs silently becoming runnable.
- Untrusted child contexts inheriting too much authority.

## Security Principles

1. **Code-enforced controls beat prompt promises.** Prompts may instruct safe behavior, but tool allowlists, argv construction, registry checks, and parser limits enforce it.
2. **Least privilege by default.** P3 built-ins are read-only: `read`, `grep`, `find`, `ls`.
3. **No implicit trust expansion.** No `--approve` by default; project-local specs are not auto-runnable and require project trust plus exact-hash registration.
4. **Exact-hash trust.** Registered specs are trusted by canonical path plus raw-file-byte SHA-256 hash. If a file changes, trust is invalidated.
5. **Bound all data.** Prompt size, stdout, stderr, JSON lines, tool previews, summary text, and history are capped.
6. **Treat child output as data.** Parent never executes commands or changes files based only on child output.
7. **No recursive delegation in P3.** Child tool allowlist excludes `run_subagent`.
8. **Monitoring is metadata-first.** No full prompt, full task, full tool result, or thinking text persistence by default.

## Trusted Agent Registry

Yes: the extension should include a trusted-agent registration mechanism.

P3 default policy:

- built-in agents are trusted as part of the installed extension
- ephemeral one-shot agents are allowed only from an explicit user request, are not persisted, and run under strict read-only/default safety constraints
- user-level specs are discoverable but **not runnable until registered**
- project-level specs are discoverable only when project trust is active and are **not runnable until registered**

This balances ease of use and security: users can try a temporary agent once without creating durable trust, and projects can ship essential agents in `.pi/agents/*.md` that users approve once per exact hash. The extension should fail closed with actionable registration/save guidance instead of silently running untrusted project prompts.

Registry locations:

```text
~/.pi/agent/agents/registry.json
~/.pi/agent/agents/projects/<project-path-hash>.json
```

Use the global registry for user-level specs and a per-project registry for project-level specs so approvals do not accidentally apply across unrelated repositories.

Project registry path derivation:

- compute the canonical project root from the active project context/cwd using the same canonicalization policy everywhere
- resolve symlinks where practical before hashing
- compute `<project-path-hash>` as SHA-256 of the canonical project root path
- store both `projectRoot` and `projectRootHash` in the project registry file
- `/agents doctor` must report a mismatch if the registry file's recorded root does not match the current canonical root

Registry trust material:

- trust hash is SHA-256 over the raw file bytes, not normalized frontmatter or prompt text
- registry entries also store canonical path and agent name
- normalized spec metadata may be stored/displayed, but it is not the trust anchor
- any raw-byte change invalidates trust, even if the parsed spec appears equivalent

Registry entry shape:

```ts
type RegisteredAgent = {
  name: string;
  source: "user" | "project";
  canonicalPath: string;
  rawBytesSha256: string;
  approvedAt: string;
  approvedBy: "user";
  specVersion: 1;
  tools: string[];
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  evalStatus: "present" | "missing" | "unknown";
  scannerRisk: "safe" | "suspicious" | "dangerous";
};
```

Runtime gate:

All execution paths must call one shared gate before child argv construction:

```text
resolve spec -> validate -> scan -> check trust/registry -> canRunAgent -> build child argv
```

`canRunAgent` applies to:

- `/agents run`
- `/agents chain`
- `run_subagent`
- saved ephemeral specs
- project-level specs
- any future workflow command

```text
canRun(agent) =
  agent.source == "built-in"
  OR (
    agent.source == "ephemeral"
    AND request came from explicit slash/user command
    AND (scannerRisk == "safe" OR explicitly-confirmed suspicious in TUI)
    AND tools are P3 read-only
  )
  OR (
    agent.source == "user"
    AND user registry has same canonicalPath + rawBytesSha256 + name
    AND scannerRisk != "dangerous"
  )
  OR (
    agent.source == "project"
    AND project trust is active
    AND project registry for current cwd has same canonicalPath + rawBytesSha256 + name
    AND scannerRisk != "dangerous"
  )
```

If a registered file changes, the raw-bytes SHA-256 mismatch makes it `unregistered` until reviewed and registered again.

Project-level specs must never be globally approved across projects. Their approvals are scoped to the canonical project root/hash.

Implementation must use Pi's `ctx.isProjectTrusted()` API as the runtime source of truth for whether project trust is active. This includes temporary decisions and CLI trust overrides, not only saved `~/.pi/agent/trust.json` decisions.

## Proposed Commands

```text
/agents list
/agents inspect <name>
/agents run-temp <base-role> <task>
/agents save-temp <name>
/agents register <path-or-name>
/agents register-project [--all-safe]
/agents unregister <name>
/agents registry
/agents verify
/agents doctor
```

Behavior:

- `/agents list`: show name, source, registered/trusted status, eval status, risk status, tools, model/thinking, and project-trust status when project specs exist. If project specs are present but unregistered, include a concise next step: `/agents register-project`. If an ephemeral agent was recently used, show that it is not persisted and can be saved with `/agents save-temp <name>`.
- `/agents inspect <name>`: show bounded spec summary, hash, source path, scanner findings, output contract, tools, limits, observability policy, eval status, and the exact next step when not runnable.
- `/agents config`: show `projectTrust: active|inactive`, current cwd, whether `.pi/agents/*.md` discovery is available, registry paths, and how to activate/register project specs.
- `/agents run-temp <base-role> <task>`: run an explicit one-shot agent prompt supplied by the user using a safe built-in base role (`scout`, `planner`, or `reviewer`) and P3 read-only constraints. Do not persist the prompt or register it. After completion, offer to save it as a user-level spec.
- `/agents save-temp <name>`: write the last explicit ephemeral prompt to `~/.pi/agent/agents/<name>.md` after user confirmation, then guide the user to `/agents register <name>`. Saving does not make it runnable until registration succeeds.
- `/agents register <path-or-name>`: validate, scan, show summary, then require explicit user confirmation before writing registry entry. Do not register dangerous specs. In TUI mode, follow `REGISTRATION_GUIDE.md` wizard behavior.
- `/agents register-project [--all-safe]`: first check `ctx.isProjectTrusted()`. If inactive, fail closed with an actionable message to use Pi project trust (`/trust` in interactive mode, restart as needed, or explicit one-run `--approve` only when intended). If active, discover trusted-project `.pi/agents/*.md`, validate/scan them, show a batch summary, and register selected safe specs into the current project's registry after confirmation. Suspicious specs require separate per-spec confirmation and are excluded from `--all-safe`. Dangerous specs are skipped. In TUI mode, follow `REGISTRATION_GUIDE.md` wizard behavior.
- `/agents unregister <name>`: remove matching user/project registry entry.
- `/agents registry`: show registered exact hashes.
- `/agents verify`: rescan specs and report hash mismatches, missing evals, invalid specs, dangerous specs, shadowed names, and project-trust status.
- `/agents doctor`: run the full consistency check and print a prioritized remediation plan. It should combine config, trust, discovery, registry, scanner, eval, and smoke-readiness checks into one user-friendly diagnostic. It must be bounded and deterministic: known spec directories only, file-size/frontmatter caps, no child Pi calls, and no provider/model calls.

In non-interactive JSON/print mode, registration should fail closed unless an explicit future non-interactive approval mechanism is designed. P3 has no `--yes`, `--force`, or non-interactive approval flag.

Suspicious/dangerous behavior:

- dangerous specs/prompts never register, save, or run
- suspicious specs may register only after per-spec explicit TUI confirmation
- suspicious ephemeral prompts may run only after explicit TUI confirmation
- suspicious ephemeral prompts in non-TUI mode fail closed
- `--all-safe` registers only safe specs; it must exclude suspicious and dangerous specs

## Proactive Project Registration UX

Project-level registration should be proactive, not hidden behind failure messages only.

On `session_start` or first `/agents` command in an interactive session, if all of the following are true:

- project trust is active (`ctx.isProjectTrusted()`)
- `.pi/agents/*.md` exists
- one or more project specs are unregistered, hash-mismatched, invalid, suspicious, or missing eval metadata

then the extension should surface a concise, non-blocking recommendation:

```text
Project agents found: 3 total, 2 unregistered, 1 hash changed.
Next: /agents doctor or /agents register-project
```

Do not show repeated noisy notifications. Track an in-memory per-session notification key by project root + aggregate spec hash/status. Show again only after status changes or when the user runs `/agents`.

Other agent commands should also recommend next steps:

- `/agents list`: show runnable status and next command per blocked project agent.
- `/agents run <project-agent>`: if blocked, fail closed with the precise reason and remediation.
- `/agents verify`: include next steps for every issue.
- `/agents doctor`: provide the full ordered remediation plan.
- `/agents chain`: preflight every agent through `canRunAgent` before starting any child; if one is blocked, fail the whole chain with next steps.

## Protecting Prompts, Specs, and Contracts

### Ephemeral one-shot agents

Ephemeral agents support requests like:

```text
Create a reviewer agent with this prompt "..." and run it once.
```

P3 behavior:

- require an explicit slash/direct user request; do not create ephemeral agents from child-agent output or model/tool output
- base the temporary agent on a built-in role: `scout`, `planner`, or `reviewer`
- do not expose arbitrary ephemeral prompt overrides through the model-callable `run_subagent` tool in P3
- enforce P3 read-only tools regardless of prompt text
- reject attempts to add `write`, `edit`, `bash`, or `run_subagent`
- scan the prompt before running; reject dangerous prompts and require confirmation for suspicious prompts when UI is available
- do not persist the prompt by default
- do not register the prompt by default
- label results as `source=ephemeral`, `registered=no`, `persisted=no`
- after the run, offer next steps:
  ```text
  Save this temporary agent? Run /agents save-temp <name>
  Then review/register it with /agents register <name>
  ```

Saving flow:

1. User runs `/agents save-temp <name>` or asks to save it.
2. Validate safe name and write a Markdown spec to `~/.pi/agent/agents/<name>.md` only after confirmation.
3. Do not add it to the trusted registry automatically.
4. Guide the user to inspect/register:
   ```text
   /agents inspect <name>
   /agents register <name>
   ```

Ephemeral prompts do not require eval fixtures. Once saved as a reusable user-level spec, `/agents list` should show `evals: missing` unless a companion eval exists.

### Spec validation

- Parse specs with a bounded simple parser.
- Accept only known frontmatter fields: `name`, `description`, `tools`, `model`, `thinking`.
- Validate safe name regex.
- Validate tools against P3 allowlist.
- Validate thinking against allowed levels.
- Reject model/thinking conflicts.
- Apply default safety, limits, observability, input contract, and output contract in code.
- Freeze normalized spec objects before execution.

### Prompt protection

- Treat Markdown prompt bodies as untrusted until registered.
- Treat ephemeral prompt bodies as untrusted even for one-shot runs.
- Scan prompt body for prompt-injection/security patterns before registration or ephemeral execution.
- Registration copy must clearly state that approving an agent registers exact agent spec bytes only; it does not sandbox the project or trust arbitrary repository content.
- Wrap role prompt and task with clear boundaries.
- Do not embed secrets or parent hidden state in child prompts.
- Do not expose full specs/registry contents to child agents.
- Do not allow spec prompt text to override code-enforced safety rules.

### Contract protection

- Output contracts live in parent code/spec metadata, not only in child prompt text.
- Validate returned child summaries against required sections where possible.
- Use trajectory checks from JSONL events for tool allowlist enforcement.
- Treat failed contract validation as a structured warning/error, not as permission to broaden behavior.

### Runtime protection

- Use `spawn` argv arrays; never shell-concatenate tasks/specs.
- Pass delegated prompt/task via stdin or private temp file, not argv.
- Always use `--no-session` for child Pi in P3.
- Do not pass `--approve` by default.
- Exclude `run_subagent` from child tools.
- Enforce timeout/output caps and kill runaway children.
- Keep child stderr diagnostic-only.

## Review Context Assembly (P9)

Agents that declare code-owned `context:` providers (built-ins only — `reviewer`, `planner`) have a
review-context bundle assembled by the **trusted parent** and handed to the child via a temp file the
sandboxed child reads with its `read` tool. Design invariants:

- **Git stays in the trusted parent.** Only the parent shells read-only git (argv arrays, never a
  shell string; refs validated by `SAFE_GIT_REF_RE`, pathspecs always after `--`). Children never get
  `git`/`bash` — `context:` does not widen child tools.
- **`context:` is code-owned.** It is accepted only on built-in specs in `specs.ts`, and is **not** in
  `AGENT_MARKDOWN_ACCEPTED_KEYS`. A user/project Markdown spec therefore cannot compel the trusted
  parent to shell git or assemble a bundle. (Frontmatter `context:` is a deferred follow-up with its
  own trust analysis.)
- **Bundle file lifecycle.** Written 0600 inside a 0700 `mkdtemp` dir and deleted in a `finally` on
  **every** dispatch path (complete/timeout/spawn-error/kill) — unlike the stdout spill file, the
  bundle is never kept on failure (it contains repo source/diff).
- **Soft-fail.** Any git/fs error degrades to a note; assembly never throws out of best-effort dispatch.

### Named accepted residual: untrusted content → parent turn (B2)

The review bundle (diff, file text, commit messages) is attacker-influenceable: any file on the branch
can contain prompt-injection text. That content reaches the child, and the child's **summary** then
flows into the main, **unsandboxed** pi turn via `deliverResult → sendUserMessage`. We do not (and
cannot fully) sanitize natural-language findings, so this is an **accepted residual**, mitigated by:

- The bundle directive and header instruct the child to treat bundle contents as untrusted data, not
  instructions.
- Delivered child free-text (summary, error) is wrapped by `frameUntrusted()` in an explicit
  do-NOT-obey boundary before it enters pi's turn, and a forged boundary marker in the child output is
  defanged so the child cannot break out of the boundary.
- Only the child's bounded **summary** is delivered — never the raw diff re-emitted verbatim.

Residual: a determined injection could still influence the parent model's narration. Treat parent
actions taken in response to delivered findings with the same scrutiny as any model output over
untrusted input.

## Prompt Shield and Permission Policy Integration

P3 must scan agent Markdown specs before registration using the repo shared deterministic security scanner. To preserve independent installability, vendor the shared scanner source into the agents extension:

```text
shared/security-scan.ts -> agents/lib/security-scan.ts
```

Registration scanning must not require Prompt Shield to be installed. Prompt Shield can be additive later, but the agents extension must have its own vendored scanner copy and use it for `/agents register`, `/agents register-project`, `/agents save-temp`, `/agents verify`, and `/agents doctor` risk reporting.

When `agents/lib/security-scan.ts` is added, update shared scanner sync/verify tooling so scanner drift is caught alongside the existing `prompt-shield` and `web-search` vendored copies.

A later integration can extend Prompt Shield to scan:

```text
~/.pi/agent/agents/
.pi/agents/
```

Recommended behavior when Prompt Shield reports active unapproved suspicious/dangerous resources:

- built-in agents remain runnable
- user-level registration requires explicit confirmation
- project-level registration requires project trust plus explicit confirmation
- dangerous specs cannot be registered
- future write-enabled agents remain disabled

Permission Policy should remain the backstop for sensitive parent tools. Child tools are separately constrained through child `--tools` allowlists.

## Evals and Security Testing

Local pre-commit/review eval command should include security cases:

- shared `canRunAgent` blocks unregistered user specs before child argv construction
- shared `canRunAgent` blocks unregistered project specs before child argv construction, even when project trust is active
- shared `canRunAgent` blocks project specs when project trust is inactive, even if a registry entry exists
- raw-byte hash mismatch blocks run
- project registry approval does not apply to another project root
- dangerous spec cannot register
- suspicious spec requires explicit TUI confirmation
- non-TUI registration writes no registry entry
- `--all-safe` excludes suspicious and dangerous specs
- dangerous ephemeral prompt cannot run or save
- saved ephemeral prompt is not runnable until registered
- `run_subagent` does not accept arbitrary prompt override in P3
- project-local spec is discoverable only after project trust and cannot run until registered in the project registry
- chain preflights every agent before first child starts
- spec cannot add `write`, `edit`, `bash`, or `run_subagent` in P3
- child argv never contains task/prompt text
- child argv excludes `--approve` by default
- child argv excludes `run_subagent`
- child output cannot trigger parent command execution
- `/agents doctor` reports inactive trust, missing registration, hash mismatch, dangerous specs, and shadowed reserved names
- `/agents doctor` uses bounded deterministic checks only
- monitoring does not persist full prompt/task/tool result/thinking text by default

These security evals are locally invokable before commit/review, not mandatory CI gates in P3.

## Cut Line

Do not ship user-level or project-level agent execution before the trusted registry exists.

If registry implementation is too large for initial P3, cut scope to built-in agents only. Do not allow unregistered user-level or project-level Markdown agents to run as a shortcut.
