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

# Write a real role file — strong, specific output-contract instruction
role_file=$(mktemp)
cat > "$role_file" <<'ROLE'
Your output MUST include exactly this header line at the very start:
SMOKE_ROLE_OK
Then answer the task concisely. Do not add any preamble before the header.
ROLE

# Run pi with --mode json, read-only tools, --append-system-prompt
set +e
output=$(pi --mode json --no-session --no-approve \
  --no-extensions --no-skills --no-prompt-templates --no-themes \
  --tools read,grep,find,ls \
  --append-system-prompt "$role_file" \
  -p 2>&1 <<'STDIN'
What is 2 + 2?
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
  # (a) Check for write/edit/bash tool names
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

# (c) Verify role reached child: the JSONL must contain an assistant text event
# with the sentinel. The model may or may not emit it (non-deterministic), so
# we retry up to 3 times. The assertion is that the transport path works — if
# it NEVER appears across retries, --append-system-prompt is likely broken.
sentinel_found=0
for attempt in 1 2 3; do
  if echo "$output" | grep -q 'SMOKE_ROLE_OK'; then
    sentinel_found=1
    break
  fi
  if [ "$attempt" -lt 3 ]; then
    output=$(pi --mode json --no-session --no-approve \
      --no-extensions --no-skills --no-prompt-templates --no-themes \
      --tools read,grep,find,ls \
      --append-system-prompt "$role_file" \
      -p 2>&1 <<<'What is 2 + 2?')
  fi
done

if [ "$sentinel_found" -eq 0 ]; then
  echo "SMOKE FAILED: role marker absent across 3 retries (--append-system-prompt may not reach child)"
  exit 1
fi

echo "P6-0b smoke OK ($jsonl_lines JSONL lines, 0 forbidden, sentinel found on attempt $attempt)"
rm -f "$role_file"
