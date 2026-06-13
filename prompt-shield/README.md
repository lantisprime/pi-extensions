# Pi Prompt Shield Extension

Scans project/global Pi resources for prompt-injection and agent-security risk. It can monitor, ask, or block direct dangerous resource writes depending on mode.

## What it scans

Prompt Shield scans project text-like files in:

```text
.pi/skills/
.agents/skills/
.pi/prompts/
.pi/extensions/
.pi/SYSTEM.md
.pi/APPEND_SYSTEM.md
AGENTS.md
CLAUDE.md
```

It also scans global user resources:

```text
~/.pi/agent/skills/
~/.agents/skills/
~/.pi/agent/extensions/
```

## Scanning basis

Prompt Shield uses deterministic pattern scoring plus optional LLM review.

Pattern categories include:

- Instruction override attempts, such as "ignore previous instructions"
- Concealment, such as "do not tell the user"
- Role simulation, such as fake `system:` / `developer:` blocks
- Secret access or exfiltration language
- Sensitive paths like `.env`, `~/.ssh`, `~/.aws`, `~/.config/gh`
- Network-capable commands like `curl`, `wget`, `scp`, `ssh`
- Remote-code patterns like `curl | sh`
- Destructive commands like `rm -rf /`
- Outside-project path references
- Obfuscation, long base64-like blobs, zero-width characters, suspicious hidden HTML comments

Risk score:

```text
0-2   safe
3-7   suspicious
8+    dangerous
```

## LLM review and performance

LLM review is included, but designed to avoid slowing Pi down:

- On normal startup, Prompt Shield scans files locally first.
- It only calls the current LLM for resources whose deterministic score is at or above the suspicious threshold.
- Scan results are cached by SHA-256 hash in `~/.pi/agent/prompt-shield/cache.json`.
- Unchanged files reuse cached results and do not trigger repeat LLM calls.
- Only the first 80 KB of each file is pattern-scanned.
- Only relevant excerpts around deterministic findings are sent to the LLM.
- LLM input is capped at 16 KB.
- LLM JSON output is parsed robustly even if the model wraps JSON in extra text.
- For project resources, Prompt Shield keeps the stricter of deterministic and LLM risk. For global user resources, LLM review can downgrade defensive-code false positives where dangerous words appear only as scanner/signature text.

You can force LLM review with:

```text
/prompt-shield llm
```

## Install/update activation

Prompt Shield activates when skills, prompts, or extensions are installed or updated through Pi tools.

It watches `write`, `edit`, and resource-modifying `bash` calls that target paths such as:

```text
.pi/skills
.agents/skills
.pi/prompts
.pi/extensions
~/.pi/agent/skills
~/.pi/agent/extensions
```

When detected, it warns before the tool runs and scans after the tool succeeds. Direct `write` calls to resource files are pre-scanned before landing, so `ask` and `block-dangerous` modes can stop risky content before it is written. It also scans on `session_start` and `resources_discover`, so `/reload` catches newly installed resources too.

Performance protection still applies: unchanged files are served from SHA-256 cache, and LLM review runs only for suspicious files unless forced.

## Modes

```text
/prompt-shield mode monitor
```

Default. Scan, cache, audit, and warn, but do not block.

```text
/prompt-shield mode ask
```

Ask before allowing direct writes of suspicious/dangerous skills, prompts, or extensions.

```text
/prompt-shield mode block-dangerous
```

Block direct writes of dangerous skills, prompts, or extensions unless their exact hash is approved.

## Approvals and denials

Approvals are hash-based. If an approved file changes, it must be reviewed again.

```text
/prompt-shield approve <path>
/prompt-shield deny <path>
/prompt-shield approvals
/prompt-shield reset
```

## Permission-policy integration

Prompt Shield writes current risk state to:

```text
~/.pi/agent/prompt-shield/state.json
```

The permission-policy extension reads this state. When unapproved suspicious/dangerous resources are active, permission-policy bypasses automatic/project grants for sensitive actions and asks again for bash, git, web, write/edit, and outside-project reads.

## Commands

```text
/prompt-shield
```

Show cached scan status.

```text
/prompt-shield scan
```

Rescan project resources using deterministic scanning and LLM review only for suspicious files.

```text
/prompt-shield llm
```

Force LLM review for scanned resources.

```text
/prompt-shield audit
```

Show recent audit entries.

```text
/prompt-shield mode monitor|ask|block-dangerous
/prompt-shield approve <path>
/prompt-shield deny <path>
/prompt-shield approvals
/prompt-shield reset
```

Manage enforcement and hash approvals.

## Storage

Cache:

```text
~/.pi/agent/prompt-shield/cache.json
```

Audit log:

```text
~/.pi/agent/prompt-shield/audit.jsonl
```

Configuration and hash approvals:

```text
~/.pi/agent/prompt-shield/config.json
```

Current risk state consumed by permission-policy:

```text
~/.pi/agent/prompt-shield/state.json
```

## Tests

Fixtures live in:

```text
prompt-shield/test-fixtures/
```

Smoke test:

```bash
prompt-shield/test-fixtures/run-smoke-test.sh
```

## Limitations

Prompt Shield cannot prove content is safe and cannot sandbox malicious extensions. Pi extensions execute as local code with user permissions. Use Prompt Shield together with project trust, the permission-policy extension, code review, and containers/VMs for untrusted projects.
