#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "P3f-2 model profiles wiring tests"
echo ""

npx --yes tsx test-fixtures/test-p3f-2-wiring.mjs
