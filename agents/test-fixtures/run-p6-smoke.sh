#!/usr/bin/env bash
set -euo pipefail
if ! command -v pi >/dev/null 2>&1; then
  echo "SKIP (pi absent) — non-pass"
  exit 2
fi
echo "P6-0b smoke: real-pi scout run (read-only, --mode json JSONL, role in system prompt)"
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
cd "$fixture"
git init -q
echo "# Test repo" > README.md
git add README.md && git commit -q -m "init"
result=$(pi --mode json --no-session --no-approve \
  --no-extensions --no-skills --no-prompt-templates --no-themes \
  --tools read,grep,find,ls \
  --append-system-prompt /dev/null \
  -p 2>&1 <<'STDIN'
summarize the repo layout
STDIN
) || { echo "SMOKE FAILED: pi exited non-zero"; exit 1; }
echo "$result" | head -5
echo "P6-0b smoke OK"
