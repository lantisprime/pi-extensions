# Tool Context Loader

Dynamic local runbook/episode discovery for Pi tools.

## P1b Status

This extension currently implements **P1a discovery/diagnostics** and **P1b preload index only**.

It does:

- scan configured Markdown roots
- parse small YAML-like frontmatter metadata
- respect project trust before reading project-local roots
- classify unmapped episodes as diagnostics-only
- dedupe records deterministically
- expose `/tool-context-loader` diagnostics
- append a compact metadata-only preload index during `before_agent_start` for active tools with matching `injection: preload` records

It does **not** yet:

- inject Markdown bodies into model context
- modify tool results
- match actual tool calls/results
- load runbook bodies just-in-time

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

P1b preloads metadata indexes only. Bodies are not injected.
```

For P1b preload, set `injection: preload`. The `preload` field is still treated as index-only in P1b, including `preload: body`; body injection remains deferred to a later milestone.

## Preload Index

During `before_agent_start`, the extension reads Pi's active tool list from `systemPromptOptions.selectedTools`. If an eligible record has `injection: preload` and one of its `tools` is active, the extension appends a bounded index block to the system prompt.

The preload block includes only:

- runbook id
- tool names from metadata
- source/display path
- summary
- priority

It does not read or inject Markdown bodies, and it does not duplicate Pi's built-in tool descriptions.

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

`on` and `off` are session-only in-memory toggles. They do not edit config files.

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
  "globalRoots": ["~/.pi/agent/runbooks", "~/.episodic-memory/episodes"],
  "maxPreloadBytesPerTurn": 2000
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
pi -e ./tool-context-loader/index.ts -p "noop" --mode json
```
