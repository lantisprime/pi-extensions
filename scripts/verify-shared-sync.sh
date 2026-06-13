#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/shared/security-scan.ts"
TARGETS=(
  "$ROOT/prompt-shield/lib/security-scan.ts"
  "$ROOT/web-search/lib/security-scan.ts"
)

for target in "${TARGETS[@]}"; do
  if ! cmp -s "$SOURCE" "$target"; then
    echo "Shared scanner is out of sync: $target" >&2
    echo "Run scripts/sync-shared.sh and commit the result." >&2
    exit 1
  fi
  echo "in sync: $target"
done
