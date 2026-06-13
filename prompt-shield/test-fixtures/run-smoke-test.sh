#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROMPT_SHIELD_DIR="$HOME/.pi/agent/prompt-shield"
BACKUP_DIR="$(mktemp -d)"
HAD_PROMPT_SHIELD_STATE=0

cleanup() {
  rm -rf "$ROOT/.pi/skills/prompt-shield-smoke"
  rmdir "$ROOT/.pi/skills" "$ROOT/.pi" 2>/dev/null || true
  rm -rf "$PROMPT_SHIELD_DIR"
  if [ "$HAD_PROMPT_SHIELD_STATE" -eq 1 ]; then
    mkdir -p "$(dirname "$PROMPT_SHIELD_DIR")"
    cp -R "$BACKUP_DIR/prompt-shield" "$PROMPT_SHIELD_DIR"
  fi
  rm -rf "$BACKUP_DIR"
}
trap cleanup EXIT

if [ -d "$PROMPT_SHIELD_DIR" ]; then
  HAD_PROMPT_SHIELD_STATE=1
  cp -R "$PROMPT_SHIELD_DIR" "$BACKUP_DIR/prompt-shield"
fi

mkdir -p "$ROOT/.pi/skills/prompt-shield-smoke"
cp "$ROOT/prompt-shield/test-fixtures/malicious-skill.md" "$ROOT/.pi/skills/prompt-shield-smoke/SKILL.md"
(
  cd "$ROOT"
  pi -p --no-builtin-tools --approve "/prompt-shield scan" >/tmp/prompt-shield-smoke.out 2>/tmp/prompt-shield-smoke.err || true
)
python3 - <<'PY'
import json, pathlib, sys
p = pathlib.Path.home() / '.pi/agent/prompt-shield/cache.json'
data = json.loads(p.read_text())
matched = [v for k, v in data.get('results', {}).items() if 'prompt-shield-smoke' in k]
if not matched or matched[0].get('risk') != 'dangerous':
    print('Prompt Shield smoke test failed')
    sys.exit(1)
print('Prompt Shield smoke test passed')
PY
