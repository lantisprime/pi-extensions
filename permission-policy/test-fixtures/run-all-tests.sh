#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "=== Permission-Policy Classification Unit Tests ==="

npx --yes tsx "$ROOT/permission-policy/test-fixtures/test-classification.ts" 2>&1

echo ""
echo "=== Permission-Policy End-to-End Tests ==="

bash "$ROOT/permission-policy/test-fixtures/run-permission-policy-test.sh" 2>&1

echo ""
echo "All permission-policy tests passed"
