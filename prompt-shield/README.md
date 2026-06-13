# Pi Prompt Shield Extension

Scans project/global Pi resources for prompt-injection and agent-security risk. It can monitor, ask, or block direct dangerous resource writes depending on mode.

## What it scans

Prompt Shield scans project text-like resource files in:

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

It scans common text/code resource extensions under those directories, including Markdown, JSON/YAML/TOML/INI, TypeScript/JavaScript variants, Python, shell scripts, HTML/XML, env/npm/pypirc files, and package metadata.

It also scans global user resources:

```text
~/.pi/agent/skills/
~/.agents/skills/
~/.pi/agent/extensions/
```

## Scanning basis

Prompt Shield uses deterministic pattern scoring plus optional LLM review. The deterministic scanner is vendored from the repo shared scanner (`shared/security-scan.ts` -> `prompt-shield/lib/security-scan.ts`) so web-search and prompt-shield use consistent risk categories while remaining independently installable.

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
- Obfuscation, long base64-like blobs, URL/base64-decoded payloads, zero-width characters, suspicious hidden HTML comments

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
- LLM JSON output is parsed robustly even if the model wraps JSON in extra text; unavailable, timed-out, or unparsable LLM review is logged in the audit file.
- Prompt Shield keeps the stricter of deterministic and LLM risk. LLM review is advisory and does not automatically downgrade deterministic findings.

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

When detected, it warns before the tool runs and scans after the tool succeeds. Direct `write` calls to resource files are pre-scanned before landing, so `ask` and `block-dangerous` modes can stop risky content before it is written. Bash detection is best-effort and post-result scanning is still the backstop for generated installers or scripts. It also scans on `session_start` and `resources_discover`, so `/reload` catches newly installed resources too.

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

Approving a resource uses cached/normal scan results so the command returns quickly and does not leave the editor waiting on a nested model call. Run `/prompt-shield llm` first if you want explicit model review before approval. Prompt Shield asks for confirmation before approving any non-safe exact hash; approval trusts only that exact hash.

Denying a resource deletes the file from disk so Pi can no longer load it. Recording an untrusted hash alone does not stop Pi from loading the file, so deny resolves the risk by removing it. Prompt Shield asks for confirmation before deleting (skipped in non-interactive mode), then rescans and clears the now-removed resource from cache and state. Scans also prune stale approvals/denials whose files no longer exist.

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

Rescan project resources using deterministic scanning and LLM review only for suspicious files. Scan output always includes suggested follow-up commands, including exact approve/deny commands for risky resources.

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

## Helper scripts

Maintenance scripts live in:

```text
prompt-shield/scripts/
```

Approve the currently installed trusted global extension hashes after reinstalling/updating this repo's extensions. The script also refreshes cached approval flags and current Prompt Shield strict-permission state so permission-policy stops prompting once all current cached risks are approved:

```bash
prompt-shield/scripts/approve-installed-extensions.sh
```

Show Prompt Shield mode, state, approvals, and unapproved risky cached resources:

```bash
prompt-shield/scripts/status.sh
```

Run a non-interactive Prompt Shield scan through Pi, then print status:

```bash
prompt-shield/scripts/rescan.sh
```

These scripts help avoid the common false-positive case where Prompt Shield reports the trusted `permission-policy`, `prompt-shield`, or `web-search` extension files after their hashes change.

## Tests

Fixtures live in:

```text
prompt-shield/test-fixtures/
```

Smoke test:

```bash
prompt-shield/test-fixtures/run-smoke-test.sh
```

Cache-management scenario test, including negative approval/deny/stale cases:

```bash
prompt-shield/test-fixtures/run-cache-management-test.sh
```

Shared scanner unit smoke test:

```bash
scripts/test-security-scan.mjs
```

## Limitations

Prompt Shield cannot prove content is safe and cannot sandbox malicious extensions. Pi extensions execute as local code with user permissions. Use Prompt Shield together with project trust, the permission-policy extension, code review, and containers/VMs for untrusted projects.
