#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "P3f-4 profile override + stdout spill tests"
echo ""

npx --yes tsx test-fixtures/test-p3f-4.mjs
