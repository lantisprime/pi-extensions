#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "P3f-3 profile discovery and registration tests"
echo ""

npx --yes tsx test-fixtures/test-p3f-3.mjs
