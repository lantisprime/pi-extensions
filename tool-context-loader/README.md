# Tool Context Loader

Dynamic local runbook/episode discovery for Pi tools.

## P1a Status

This extension currently implements **P1a: discovery + diagnostics only**.

It does:

- scan configured Markdown roots
- parse small YAML-like frontmatter metadata
- respect project trust before reading project-local roots
- classify unmapped episodes as diagnostics-only
- dedupe records deterministically
- expose `/tool-context-loader` diagnostics

It does **not** yet:

- inject system prompt context
- modify tool results
- match tool calls
- load runbook bodies into model context

## Default roots

Project-local roots, scanned only when the project is trusted:

```text
.pi/runbooks
.runbooks
.episodic-memory/episodes
```

Global roots:

```text
~/.pi/agent/runbooks
~/.episodic-memory/episodes
```

Global episodes are diagnostics-only unless explicitly enabled in future configuration and tool-mapped.

## Frontmatter

Supported subset:

```markdown
---
id: bash-kubectl
summary: Kubernetes safety checks for bash kubectl commands
tools: [bash]
tags: [kubernetes, tool:bash]
match:
  commandIncludes: [kubectl, helm]
injection: tool_result
preload: index
priority: 50
maxBytes: 5000
---

# Body

P1a discovers metadata only. Bodies are not injected.
```

Supported fields:

- `id`
- `summary`
- `tools`
- `tags`
- `injection`
- `preload`
- `priority`
- `maxBytes`
- `match.commandIncludes`
- `match.pathIncludes`

## Commands

```text
/tool-context-loader
/tool-context-loader status
/tool-context-loader verbose
/tool-context-loader rescan
/tool-context-loader on
/tool-context-loader off
```

`status` is compact by default: it shows root/count summaries and eligible runbooks only. Use `verbose` to inspect unmapped episodes, skipped records, and warnings.

In P1a, `on` and `off` are session-only in-memory toggles. They do not edit config files.

## Config

Optional project config, read only when the project is trusted:

```text
.pi/tool-context-loader.json
```

Example:

```json
{
  "enabled": true,
  "roots": [".pi/runbooks", ".runbooks", ".episodic-memory/episodes"],
  "globalRoots": ["~/.pi/agent/runbooks", "~/.episodic-memory/episodes"]
}
```

## Install

For global use:

```bash
mkdir -p ~/.pi/agent/extensions/tool-context-loader
cp tool-context-loader/index.ts ~/.pi/agent/extensions/tool-context-loader/index.ts
```

Then restart Pi or run `/reload` in the TUI.

## Test

```bash
tool-context-loader/test-fixtures/run-p1a-tests.sh
pi --no-extensions -e ./tool-context-loader/index.ts --list-models
```
