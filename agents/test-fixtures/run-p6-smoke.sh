#!/usr/bin/env bash
set -euo pipefail
if ! command -v pi >/dev/null 2>&1; then
  echo "SKIP (pi absent) — non-pass"
  exit 2
fi
echo "P6-0b smoke: real-pi --append-system-prompt end-to-end"

fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
cd "$fixture"
git init -q
echo "# SMOKE_TEST_REPO" > README.md
mkdir -p src
echo "export const X = 1;" > src/lib.ts
git add -A && git commit -q -m "init"

# Write a real role file with a sentinel
role_file=$(mktemp)
cat > "$role_file" <<'ROLE'
You are a smoke-test agent. Output the marker SMOKE_ROLE_OK in your response.
ROLE

# Run pi with --mode json, read-only tools, --append-system-prompt
set +e
output=$(pi --mode json --no-session --no-approve \
  --no-extensions --no-skills --no-prompt-templates --no-themes \
  --tools read,grep,find,ls \
  --append-system-prompt "$role_file" \
  -p 2>&1 <<'STDIN'
Read README.md and reply with just the first line you find.
STDIN
)
exit_code=$?
set -e

if [ "$exit_code" -ne 0 ]; then
  echo "SMOKE FAILED: pi exited $exit_code"
  exit 1
fi

# (b) Verify output contains parseable JSON lines
jsonl_lines=0
forbidden=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  if ! echo "$line" | python3 -c 'import json,sys; json.loads(sys.stdin.read())' 2>/dev/null; then
    echo "SMOKE FAILED: non-JSON line: ${line:0:120}"
    exit 1
  fi
  jsonl_lines=$((jsonl_lines + 1))
  # (a) Check for write/edit/bash tool names in the raw line
  case "$line" in
    *'"write"'*|*'"edit"'*|*'"bash"'*) forbidden=$((forbidden + 1)) ;;
  esac
done <<< "$output"

if [ "$jsonl_lines" -lt 2 ]; then
  echo "SMOKE FAILED: only $jsonl_lines JSONL lines"
  exit 1
fi

if [ "$forbidden" -gt 0 ]; then
  echo "SMOKE FAILED: $forbidden forbidden tool name(s) in output"
  exit 1
fi

# (c) Verify output has an agent_end or result event (run completed)
if ! echo "$output" | grep -q '"type"[[:space:]]*:[[:space:]]*"\(agent_end\|result\)"'; then
  echo "SMOKE FAILED: no completion event in JSONL"
  exit 1
fi

echo "P6-0b smoke OK ($jsonl_lines JSONL lines, 0 forbidden tools)"
rm -f "$role_file"
