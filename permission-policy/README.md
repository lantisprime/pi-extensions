# Pi Permission Policy Extension

A Pi extension that asks before allowing sensitive operations and stores persistent decisions per project folder.

## What it gates

- Reads outside the current project folder via `read`
- File writes/updates via `write` and `edit`
- Any non-empty bash command via `bash` and user `!` commands
- Destructive-looking shell commands via `bash` and user `!` commands, as a more specific category
- Git commands via `bash` and user `!` commands, detected broadly with `\bgit\b`, as a more specific category
- Web/search/fetch-style tools by tool name

## Permission choices

When a gated operation is requested, choose one of:

- Allow once
- Allow for current session
- Allow permanently for this project
- Deny once
- Deny for current session
- Deny permanently for this project

"Permanently" means for the current project folder across Pi sessions, not across all projects.

## Modes

Modes are per project and are stored in the same persistent policy file.

```text
/permissions mode ask
```

Default mode. Ask when no current-session or persistent project permission is already recorded.

```text
/permissions mode read-only
```

Automatically allow known read-only shell/git commands in the current project, such as `pwd`, `ls`, `rg`, `cat`, `git status`, and `git diff`. Reads outside the project, writes/edits, web tools, and destructive commands still require recorded permission or a prompt.

```text
/permissions mode auto
```

Use the current LLM to classify bash/git commands. Commands classified as `SAFE` are automatically allowed. Commands classified as `UNSAFE`, or commands the LLM cannot classify, fall back to the normal permission prompt/block behavior.

## Prompt Shield integration

If `prompt-shield` reports active unapproved suspicious/dangerous project or global resources, permission-policy enters a stricter path for sensitive operations. In that state it bypasses automatic/project grants and asks again for:

- bash commands
- destructive bash
- git commands
- web/search/fetch
- write/edit
- reads outside the project

Prompt Shield state is read from:

```text
~/.pi/agent/prompt-shield/state.json
```

## Storage

Persistent policy files are stored outside the repo under:

```text
~/.pi/agent/permission-policy/projects/<project-path-hash>.json
```

Session grants are kept only in memory.

## Install

For global use across projects:

```bash
mkdir -p ~/.pi/agent/extensions/permission-policy
cp index.ts ~/.pi/agent/extensions/permission-policy/index.ts
```

Then restart Pi or run `/reload`.

## Status line and shortcut

The extension shows the current mode in Pi's status/footer line:

```text
permission: ask
permission: read-only
permission: auto
```

It also registers this shortcut:

```text
ctrl+shift+m
```

Pressing `ctrl+shift+m` cycles modes in this order:

```text
ask -> read-only -> auto -> ask
```

Pi's default `shift+tab` binding remains available for thinking level cycling.

## Commands

```text
/permissions
```

Shows the mode plus persistent and current-session permissions for the current project.

```text
/permissions reset
```

Clears persistent and current-session permissions for the current project.

```text
/permissions mode ask|read-only|auto
```

Sets the current project's permission mode and updates the status line.
