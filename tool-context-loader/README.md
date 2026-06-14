# Tool Context Loader

Dynamic local runbook/episode discovery for Pi tools.

## P1d Status

This extension currently implements **P1a discovery/diagnostics**, **P1b preload index only**, **P1c JIT tool-result injection**, and **P1d hardening**.

It does:

- scan configured Markdown roots
- parse small YAML-like frontmatter metadata
- respect project trust before reading project-local roots
- classify unmapped episodes as diagnostics-only
- dedupe records deterministically
- expose `/tool-context-loader` diagnostics
- append a compact metadata-only preload index during `before_agent_start` for active tools with matching `injection: preload` records
- match actual tool calls using metadata only
- lazily append bounded, advisory-wrapped runbook body excerpts after matching tool results for explicit `injection: tool_result` records
- claim JIT runbooks before async body reads so parallel tool results do not duplicate per-turn injections
- reserve per-turn injection budget before async body reads so concurrent results cannot exceed the configured per-turn byte budget
- clear pending JIT matches on turn/session reset, rescan, and on/off toggles

It does **not** yet:

- inject broad bash tool-only runbooks without `match.commandIncludes`
- body-inject records that only inherit the default `tool_result` mode without explicit frontmatter
- integrate directly with Prompt Shield risk state for body suppression

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

P1b preloads metadata indexes only. P1c/P1d inject this body only after a matching tool result.
```

For P1b preload, set `injection: preload`. The `preload` field is still treated as index-only, including `preload: body`.

For P1c/P1d JIT body injection, set explicit frontmatter `injection: tool_result`. Records that only inherit the default injection mode are not body-injected.

## Preload Index

During `before_agent_start`, the extension reads Pi's active tool list from `systemPromptOptions.selectedTools`. If an eligible record has `injection: preload` and one of its `tools` is active, the extension appends a bounded index block to the system prompt.

The preload block includes only:

- runbook id
- tool names from metadata
- source/display path
- summary
- priority

It does not read or inject Markdown bodies, and it does not duplicate Pi's built-in tool descriptions.

## JIT Tool-Result Injection

During `tool_call`, the extension matches eligible explicit `injection: tool_result` records using metadata only. It does not mutate tool arguments.

During the matching `tool_result`, it lazily reads the runbook body, applies byte/line budgets, wraps the excerpt in an advisory notice, and appends it after the original tool result content.

P1c/P1d matching rules:

- `bash` requires `match.commandIncludes`; no implicit broad bash fallback.
- `read`, `write`, and `edit` support direct `path` matching via `match.pathIncludes`.
- `read`, `write`, and `edit` may use tool-only fallback when no command/path matcher is declared.
- Project-local bodies are only available when project-local discovery was allowed by project trust.

P1c/P1d preserves original tool behavior:

- original content remains first
- `isError` is not changed
- details are preserved/extended only when existing details are a plain object
- body text is never retained on discovery records

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
  "maxPreloadBytesPerTurn": 2000,
  "maxInjectedBytesPerTurn": 10000,
  "maxRunbookBytes": 5000,
  "maxInjectedLinesPerRunbook": 160,
  "dedupePerTurn": true
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
