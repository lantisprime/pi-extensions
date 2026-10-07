# Pi Permission Policy Extension

A Pi extension that asks before allowing sensitive operations and stores persistent decisions per project folder.

> **User Manual**: See [../../docs/USER_MANUAL.md](../../docs/USER_MANUAL.md#permission-modes-deep-dive) for scenario guides.

## What it gates

- Reads outside the current project folder via `read`
- File writes/updates via `write` and `edit`
- Any non-empty bash command via `bash` and user `!` commands
- Destructive-looking shell commands via `bash` and user `!` commands, as a more specific category
- Git commands via `bash` and user `!` commands, detected broadly with `\bgit\b`, as a more specific category
- Web/search/fetch-style tools by tool name
- MCP server tool calls via the dedicated `mcp` category — any tool from the MCP bridge extension (namespace `mcp_<server>_<tool>`) requires the `Call MCP server tools` permission; names are never misclassified as web just because the underlying MCP tool name contains "search"

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

```text
/permissions mode yolo
```

Dangerous YOLO mode. Automatically allows permission requests by default, including bash/git/web/write/outside-read/MCP categories, without prompting. The extension still hard-blocks `rm -f`/`rm -rf` style commands and commands that appear to delete the repository or its `.git` metadata.

The seatAuto hard-deny categories below (git config/push/worktree/remote/submodule, `ln`/`link`, command substitution, `~`/`$HOME`, network verbs, protected paths) are also hard-denied in YOLO mode, without a dialog.

When enabling YOLO mode, Pi shows an explicit warning and confirmation prompt. Use YOLO only in disposable or fully trusted workspaces.

```text
/permissions mode seat-auto
```

Deterministic seat mode for delegated agents (installed by herdr-driver's `hd start --kind pi --approve`, which writes the policy file with a `seat` block; pi treats seatAuto with a missing or expired `seat.expiresAt` as ask). No LLM decides any allow in this mode. Everything that does not match the shapes below falls through to the normal permission prompt — under herdr, `hd watch` reports the pane as `blocked` and wakes the orchestrator, which decides.

What seatAuto auto-allows, and only after a hard-deny check (see below):

- Write/edit tools: targets inside the project that pass a component-wise lstat walk from the project root (no symlink components), where an existing target has exactly one link (`st_nlink == 1`, so hardlinked files are refused), that are not the `.git` entry (file or dir, including the worktree git-dir and common dir) or a protected path, and where a new file's nearest existing ancestor passes the same checks. After every seat write, pi re-stats the target (realpath plus nlink); on mismatch it reverts from a pre-write copy and records a violation in `~/.pi/agent/permission-policy/seat-violations.jsonl`. The window between the write landing and the re-stat remains a residual swap race.
- Bash: only when every `;`, `&&`, `||`, `|`, and newline-separated segment matches an allowed shape:
  - read-only commands in strict shapes: `find` without `-delete`/`-exec`/`-execdir`/`-ok`/`-okdir`/`-fprint*`/`-fls`; `sed` only `-n` with a print script (never `-i` or a `w` command); `awk` and `xargs` are never read-only; when unsure, not read-only;
  - test runners: `python3 -m unittest|pytest`, `sh tests/*.sh`, `node --test`, `npm test`, `./node_modules/.bin/tsc --noEmit` (never `npx`), `claude plugin test|validate`;
  - in-project git: `status`, `diff`, `log`, `show`, `rev-parse`, `add <paths>`, `commit -m/-F`, `branch --show-current`;
  - redirects only to `/dev/null`, stream dups (`2>&1`), or a file inside the project that passes the write checks above.

Hard-deny categories never reach any allow path in any mode — only the interactive dialog keystroke can let them through (stored session or project grants are not operator actions):

- the YOLO hard-deny patterns (`rm -f`/`rm -rf`, repository deletion);
- `ln`/`link`, `git config` (any key), `git push`, `git worktree`, `git remote`, `git submodule`;
- git global options `-c`/`--config-env`/`--git-dir`/`--work-tree`/`--exec-path`/`--namespace`, and `-C` targeting a path outside the project;
- command substitution/backticks/process substitution, `eval`, `source`, `~` or `$HOME`;
- network verbs `curl`, `wget`, `nc`, `ssh`, `scp`, `rsync`;
- any path resolving into `~/.pi/agent/permission-policy`, `~/.ssh`, `~/.config`, `~/.aws`, `~/.gnupg`, the herdr-driver cache — except the seat's exact `seat.manifestPath`, which write/edit tools may write with the same link checks.

Residual risks, accepted by design: test runners execute seat-authored code as the operator (they are allowlisted on purpose); in-project shell redirects and writes can modify any project file that passes the link checks; and the post-write swap race described above. Segment splitting is token-based, not quote-aware (deferred); it fails closed — a command the splitter cannot parse asks the operator instead of being auto-allowed. Operator-typed `!` commands are not subject to seatAuto allows and keep their normal behaviour.

## Prompt Shield integration

If `prompt-shield` reports active unapproved suspicious/dangerous project or global resources, permission-policy enters a stricter path for sensitive operations. In that state it bypasses automatic/project grants and asks again for:

- bash commands
- destructive bash
- git commands
- web/search/fetch
- write/edit
- reads outside the project
- MCP server tool calls

Prompt Shield state is read from:

```text
~/.pi/agent/prompt-shield/state.json
```

## Storage

Persistent policy files are stored outside the repo under:

```text
~/.pi/agent/permission-policy/projects/<project-path-hash>.json
```

Policy files carry `schemaVersion: 2`. Fields the extension does not know about (the herdr-driver `seat` block, vendor bookkeeping) are preserved verbatim on every save. Seat post-write violations are appended to `~/.pi/agent/permission-policy/seat-violations.jsonl`.

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
│ permission: ask
│ permission: read-only
│ permission: auto
│ permission: seat-auto
│ permission: yolo
```

It also registers this shortcut:

```text
ctrl+shift+m
```

Pressing `ctrl+shift+m` cycles modes in this order:

```text
ask -> read-only -> auto -> yolo -> ask
```

`seat-auto` is not part of the interactive cycle; set it via herdr-driver or `/permissions mode seat-auto`.

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
/permissions mode ask|read-only|auto|seat-auto|yolo
```

Sets the current project's permission mode and updates the status line. Setting `yolo` requires confirmation and shows a danger warning.

### CLI Flag

```bash
pi --permission-mode ask|read-only|auto|seat-auto|yolo
```

Set the permission mode from the command line at startup. The mode is persisted to the project policy file, same as `/permissions mode`. Accepts the same value aliases (`ask`/`manual`, `read-only`/`readonly`/`readonlyauto`, `auto`/`llm`/`llm-auto`/`automatic`, `seat-auto`/`seatauto`, `yolo`/`unsafe`/`dangerous`). Invalid values are fail-closed: the policy is explicitly reset to `ask`.

```bash
# Examples
pi --permission-mode yolo "Deploy the release"
pi --permission-mode read-only -p "Review the codebase"
pi --permission-mode auto "Refactor the auth module"
```

When `yolo` is set via CLI in non-interactive mode, the confirmation prompt is bypassed since there is no UI to confirm. Use yolo from CLI only in fully trusted or disposable workspaces.

## Tests

Classification unit tests:

```bash
permission-policy/test-fixtures/run-all-tests.sh
```

Runs classification unit tests covering destructive detection, git detection, read-only command classification, outside-project detection, tool classification, read-only auto allowance logic, YOLO hard-deny negative/adversarial scenarios, and parseMode for CLI flag values.

seatAuto unit tests (spec Phase 1 + v3 amendments):

```bash
npx --yes tsx permission-policy/test-fixtures/test-seat-auto.ts
```

Loads the real extension with a throwaway `HOME` (never touches the real `~/.pi`) and drives write/edit/bash/user_bash flows: the adversarial table (hardlinks, symlink components, the worktree `.git` file, `git -c core.hooksPath`, `$(...)`, curl in a pipe, `find -delete`, `sed -i`, redirects into `~/`, newline-joined commands, heredocs, `tee`, `npx tsc`), expired/missing seat blocks, the manifestPath exception, post-write revert wiring, and unknown-field preservation across mode toggles and "Allow permanently" saves.

herdr:blocked dialog-reporting unit tests:

```bash
npx --yes tsx permission-policy/test-fixtures/test-herdr-blocked.ts
```

End-to-end scenarios verified against a live Pi instance:

- Default ask mode blocks unapproved operations
- readOnlyAuto allows read-only shell/git commands
- readOnlyAuto blocks non-read-only bash and writes
- Project permissions persist across Pi invocations
- Prompt Shield strict mode bypasses readOnlyAuto grants
- /permissions reset clears project permissions
- --permission-mode yolo allows bash and persists mode to policy
- --permission-mode read-only allows read-only bash, blocks destructive
- --permission-mode auto saves llmAuto to policy
- --permission-mode ask blocks unapproved bash
- --permission-mode with invalid value is ignored (falls back to ask)
- --permission-mode yolo still hard-blocks rm -f

Note: Some e2e scenarios (outside-project read blocking) rely on the model calling the actual tool, which some models refuse to do. Classification logic for those cases is covered by unit tests.
