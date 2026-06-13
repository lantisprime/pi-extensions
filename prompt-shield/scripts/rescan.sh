#!/usr/bin/env bash
set -euo pipefail

# Trigger Prompt Shield scan through pi in non-interactive mode, then print status.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
(
  cd "$ROOT"
  pi -p --no-builtin-tools --approve "/prompt-shield scan" >/tmp/prompt-shield-rescan.out 2>/tmp/prompt-shield-rescan.err || true
)
"$(dirname "$0")/status.sh"
