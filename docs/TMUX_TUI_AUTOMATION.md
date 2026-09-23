# Driving any TUI via tmux — reference

A practical recipe for automating interactive terminal applications (pi, claude, vim, less, anything) by driving them through tmux from a script or another process. Verified end-to-end against `claude --dangerously-skip-permissions` reading the repo and producing a 640-word design analysis in 1m 13s.

## TL;DR

```bash
# 1. Start an isolated tmux server (won't touch your real session)
TMUX="tmux -L drive-claude-$$"
$TMUX kill-server 2>/dev/null || true
$TMUX new-session -d -s work -x 200 -y 50

# 2. Launch the TUI inside it
$TMUX send-keys -t work "claude --dangerously-skip-permissions" Enter
sleep 5

# 3. Dismiss any modal dialog (e.g. bypass-permissions confirmation)
$TMUX send-keys -t work "2"; $TMUX send-keys -t work Enter
sleep 3

# 4. Send the prompt (literal mode = safe for text with shell metachars)
$TMUX send-keys -l -t work "Review P5b and write a slice plan."
sleep 1
$TMUX send-keys -t work Enter

# 5. Wait for the TUI to think, then capture
sleep 60
$TMUX capture-pane -p -e -J -t work -S -2000
```

That's the whole pattern. The rest of this doc is the gotchas.

## Setup: isolated server + correct key format

### Always use `-L <socket>` for an isolated server

```bash
TMUX="tmux -L drive-$$"          # $$ = unique per shell; safe for parallel runs
$TMUX kill-server 2>/dev/null    # always start fresh
$TMUX new-session -d -s work -x 200 -y 50
```

`$$` makes the socket unique so two parallel scripts don't collide. **Don't touch the user's main tmux server** unless you mean to.

### Required: `extended-keys-format csi-u` for modified keys

Without this, TUIs cannot distinguish `Enter` from `Shift+Enter`, `Tab` from `Ctrl+Shift+Tab`, etc. Critical for any modern TUI (pi, claude code, neovim, helix, lazygit, …).

```bash
# Pass via -f so it applies even if user hasn't set it globally
TMUX_CONF=$(mktemp)
cat > "$TMUX_CONF" <<'EOF'
set -g extended-keys-format csi-u
set -g extended-keys on
EOF
$TMUX -f "$TMUX_CONF" new-session -d -s work -x 200 -y 50
rm -f "$TMUX_CONF"
```

Requires tmux ≥ 3.5. PI itself prints a yellow warning if this is missing.

## Sending keys

### `send-keys` flags

| Flag | Purpose |
|---|---|
| `-l` | **Literal mode.** Disable key-name lookup. Every char in the argument is sent as-is. Critical for text with shell metachars. |
| `-R` | Reset terminal state before sending. Useful after pasting escape-heavy text. |
| `-H` | Args are hex codes (e.g., `0x41` for `A`). |
| `-N count` | Repeat the sequence N times. |
| `-t target` | Target pane (`session:window.pane`). Omit → current pane. |

### ⚠️ `-l` is global across all args

```bash
# WRONG: "Enter" gets sent as literal characters
$TMUX send-keys -l -t work "ls" Enter

# RIGHT: send Enter as a separate call
$TMUX send-keys -l -t work "ls"
$TMUX send-keys    -t work Enter
```

If you want literal `Enter` (the 5 chars) typed into the prompt, then `-l` for the whole call works. If you want the key press, separate the calls.

### Two ways to inject a long prompt

**Option A: literal mode + `send-keys`** (good for ≤ a few KB)
```bash
$TMUX send-keys -l -t work "Multi-line prompt here."
$TMUX send-keys    -t work Enter
```

**Option B: paste buffer** (better for large/multi-line; preserves bracketed paste)
```bash
$TMUX load-buffer -t work - <<< "Long prompt here."
$TMUX paste-buffer -t work
sleep 1
$TMUX send-keys -t work Enter
```

TUIs that support bracketed paste (most modern ones — pi, claude code, neovim ≥ 0.8) handle multi-line paste as a single submit instead of triggering Enter on every newline. Use `paste-buffer` for any non-trivial text.

## Key name reference

| Key | send-keys name(s) |
|---|---|
| Enter / Return | `Enter`, `C-m`, `CR`, `KPEnter` (keypad) |
| Escape | `Escape`, `C-[`, `C-3` |
| Tab | `Tab` |
| Backspace | `BSpace`, `C-h` |
| Space | `Space` |
| Arrows | `Up`, `Down`, `Left`, `Right` |
| Navigation | `Home`, `End`, `PageUp`, `PageDown`, `IC` (insert), `DC` (delete) |
| Function | `F1`–`F12` |
| Ctrl+letter | `C-a` … `C-z` |
| Alt/Option+letter | `M-a` … `M-z` |
| Shift+key | Prefix `S-` (e.g., `S-Tab`, `S-Up`) |
| Combined | `C-S-Tab`, `C-M-x`, etc. |

For most TUIs, `Enter` (literal key name) works better than `C-m`.

## Reading pane output

```bash
# Plain text
$TMUX capture-pane -p -t work -S -200            # last 200 lines

# With ANSI escapes (for color/sgr-aware parsing)
$TMUX capture-pane -p -e -J -t work -S -2000

# Joined wrapped lines
$TMUX capture-pane -p -e -J -t work -S -2000 | tail -80
```

- `-p` print to stdout (without it, you enter copy mode)
- `-S -N` start N lines back (negative)
- `-e` include escape sequences
- `-J` join wrapped lines (single logical line)
- `-t target` pane address

After capture, **strip ANSI escapes** for clean text:
```bash
sed 's/\x1b\[[0-9;]*m//g'
```

## Waiting for the TUI to be ready

There's no built-in "wait for prompt" command. Patterns that work:

```bash
# 1. Sleep + capture (simplest, brittle to timing)
sleep 5
$TMUX capture-pane -p -t work

# 2. Poll for a known marker (robust)
for i in {1..30}; do
  out=$($TMUX capture-pane -p -t work)
  if echo "$out" | grep -q "bypass permissions on"; then break; fi
  sleep 1
done

# 3. Wait for a specific output length or content delta (advanced)
prev=""
for i in {1..60}; do
  cur=$($TMUX capture-pane -p -t work -S -50)
  if [ "$cur" = "$prev" ] && [ -n "$cur" ]; then break; fi   # idle
  prev="$cur"
  sleep 2
done
```

For claude specifically, "Cooked for Xs" or the model name "Opus 4.8" in the footer are reliable readiness markers.

## Modal dialogs

If the TUI shows a confirmation dialog (like claude's bypass-permissions warning), the prompt lands behind it. Two strategies:

```bash
# Strategy A: pre-emptively answer with the option number
$TMUX send-keys -t work "2"   # accept
$TMUX send-keys -t work Enter

# Strategy B: pass flags to skip the dialog (claude: --dangerously-skip-permissions)
$TMUX send-keys -t work "claude --dangerously-skip-permissions"
```

For pi, there's no bypass-prompt — just `/agents` and `/skills` need explicit `Tab` to confirm. Use:
```bash
$TMUX send-keys -t work Tab    # accept dialog
```

## Reliable workflow for "ask claude and read the answer"

```bash
#!/usr/bin/env bash
set -euo pipefail

PROMPT="$1"
SOCK="drive-claude-$$"
SESS="work"
TMUX_CMD="tmux -L $SOCK"

# 1. Isolated server with extended-keys
TMUX_CONF=$(mktemp)
cat > "$TMUX_CONF" <<'EOF'
set -g extended-keys-format csi-u
set -g extended-keys on
EOF

$TMUX_CMD kill-server 2>/dev/null || true
$TMUX_CMD -f "$TMUX_CONF" new-session -d -s "$SESS" -x 200 -y 50
rm -f "$TMUX_CONF"
sleep 0.5

# 2. Launch claude (keychain OAuth works because no --bare)
$TMUX_CMD send-keys -t "$SESS" "claude --dangerously-skip-permissions" Enter
sleep 6

# 3. Accept bypass-mode confirmation
$TMUX_CMD send-keys -t "$SESS" "2"
$TMUX_CMD send-keys -t "$SESS" Enter
sleep 4

# 4. Wait for the input prompt to be ready (look for the empty input field)
for i in {1..30}; do
  if $TMUX_CMD capture-pane -p -t "$SESS" -S -50 | grep -q "❯.*$"; then break; fi
  sleep 1
done

# 5. Send the prompt (paste-buffer for multi-line safety)
$TMUX_CMD load-buffer -t "$SESS" - <<< "$PROMPT"
$TMUX_CMD paste-buffer -t "$SESS"
sleep 1
$TMUX_CMD send-keys -t "$SESS" Enter

# 6. Poll for completion (look for "Cooked for" or footer model info)
for i in {1..120}; do
  pane=$($TMUX_CMD capture-pane -p -t "$SESS" -S -30)
  if echo "$pane" | grep -qE "Cooked for|Baked for|✻"; then break; fi
  sleep 5
done
sleep 5  # small grace

# 7. Read response
$TMUX_CMD capture-pane -p -e -J -t "$SESS" -S -2000 | sed 's/\x1b\[[0-9;]*m//g' | tail -200

# 8. Cleanup
$TMUX_CMD kill-server 2>/dev/null || true
pkill -f "claude --dangerously-skip-permissions" 2>/dev/null || true
```

## Common pitfalls

### 1. `--bare` skips OAuth/keychain auth

For `claude`, **`--bare` makes OAuth+keychain unreadable**. Drop it; rely on the default behavior that reads from `~/.claude/` and the macOS Keychain. The side effects of `--bare` you give up:
- CLAUDE.md auto-discovery (you can add `--add-dir` to compensate)
- LSP sync
- Plugin sync
- Auto-memory

For a single-shot automation these are usually fine to skip anyway — but only by passing `--add-dir <cwd>` does claude see your project files. If you DON'T use `--bare`, claude reads CLAUDE.md and other context automatically.

### 2. Bare window names break tmux commands

`tmux capture-pane -t <window_name>` returns "can't find pane" when multiple sessions exist with same-named windows. Use **`session:window_index`** instead:

```bash
$TMUX capture-pane -p -t work:2
```

To find the right index: `tmux list-windows -a -F '#{session_name}:#{window_index}.#{window_name}'`

### 3. Timing is the universal pain

`capture-pane` after `send-keys` returns the *current* buffer, not the future state. Always add a `sleep` or a poll-for-marker. Common waits:

| Action | Wait |
|---|---|
| TUI start (shell prompt) | 0.5s |
| TUI ready (pi/claude loaded) | 5–10s |
| Modal dismissal | 3–5s |
| claude response (Opus, 600-word) | 60–120s |
| claude response (Sonnet, 600-word) | 30–60s |

### 4. Newlines in pasted text

`tmux load-buffer` preserves newlines. The TUI's response to a multi-line paste depends on **bracketed paste mode**:
- **Enabled** (most modern TUIs): paste is delivered as one event, TUI inserts as one block
- **Disabled**: each newline is sent as Enter, which submits prematurely

Verify your target TUI supports bracketed paste. If not, send the prompt as one `send-keys -l` call (single line — replace `\n` with spaces or restructure the prompt).

### 5. `set-window-option` and the `kill-window` race

If you're automating a TUI that creates its own windows (like pi spawning subagents), the window list is volatile. Always re-query via `list-windows -a` before each capture/send if your session might have churned.

## OAuth and credential forwarding

tmux sessions inherit the launching shell's environment. **But macOS Keychain access is per-process-tree and may not propagate to grandchildren.**

If your TUI needs OAuth and "Not logged in" appears:

```bash
# Option A: extract OAuth from keychain and pass via env
CREDS=$(security find-generic-password -s "Claude Code-credentials" -w)
# (parse and pass the relevant fields — format varies per tool)

# Option B: don't use --bare (it explicitly skips keychain)

# Option C: launch from a Terminal.app session where keychain IS unlocked
osascript -e 'tell app "Terminal" to do script "tmux new-session -d -s work"'
```

For most tools the simplest fix is to launch from your normal interactive shell, not from a non-interactive script context.

## Alternative tools

| Tool | When to prefer |
|---|---|
| **`tmux` + `send-keys`** (this doc) | TUIs with rich input, modal dialogs, multi-line paste, ANSI escapes |
| `expect` / `pexpect` | Tight prompt-regex matching; better for classical line-based tools |
| `tmuxp` | Session orchestration (declare windows/panes in YAML) |
| `wezterm cli` | If you already use wezterm — same send-text primitives |
| `zellij` CLI | If you already use zellij — `zellij action write-chars` is equivalent |
| **`node-pty` + custom code** | When you need a programmatic pseudo-terminal (no real TUI) |

For driving pi and claude specifically, tmux is the best fit because:
- Both are full TUI apps with input field, status bar, key bindings
- Both expect real PTY semantics (raw mode, alternate screen buffer)
- Both render ANSI escapes that tmux preserves
- Bracketed paste mode is essential for multi-line prompts

## Sources & further reading

- `man tmux` — `send-keys` section, KEY BINDINGS table
- [tmux send-keys command reference](https://tmux.info/docs/commands/send-keys) — flags & examples
- [tmux-extended-keys skill (ray-manaloto)](https://skillsmp.com/creators/ray-manaloto/dotfiles/claude-skills-tmux-extended-keys) — CSI-u / csi-u setup
- [pi coding-agent tmux docs](https://pi.dev/docs/latest/tmux) — recommended tmux.conf for pi itself
- [tui-input](https://github.com/maked-dev/tui-input) — pattern for an input bar pinned to a tmux pane
- aimax — uses `paste-buffer -p` + triple `send-keys Enter` for TUI mode-switching reliability

## Provenance

This document was written after a working experiment that drove `claude --dangerously-skip-permissions` through tmux inside an isolated socket (`tmux -L drive-claude-$$`), to ask claude to design a P5b plan for the `pi-extensions` repo. claude read the design doc + tmux-terminal source, produced a 640-word analysis (Slice 0 + 3 parallel tracks), and exited cleanly — all in 1m 13s. Captured to `/tmp/claude-pane.txt` via `tmux capture-pane -p -e -J -t work -S -2000`.
