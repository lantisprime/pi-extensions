#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$ROOT/.pi/skills/prompt-shield-smoke"
cp "$ROOT/prompt-shield/test-fixtures/malicious-skill.md" "$ROOT/.pi/skills/prompt-shield-smoke/SKILL.md"
(
  cd "$ROOT"
  pi -p --no-builtin-tools --approve "/prompt-shield scan" >/tmp/prompt-shield-smoke.out 2>/tmp/prompt-shield-smoke.err || true
)
rm -rf "$ROOT/.pi/skills/prompt-shield-smoke"
rmdir "$ROOT/.pi/skills" "$ROOT/.pi" 2>/dev/null || true
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
