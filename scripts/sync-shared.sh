#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for target in \
  "$ROOT/prompt-shield/lib/security-scan.ts" \
  "$ROOT/web-search/lib/security-scan.ts"
do
  mkdir -p "$(dirname "$target")"
  cp "$ROOT/shared/security-scan.ts" "$target"
  echo "synced $target"
done
