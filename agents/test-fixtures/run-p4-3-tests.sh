#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "P4-3 bg-worker tests"
node --experimental-strip-types test-fixtures/test-bg-worker.mjs
echo "P4-3 bg-worker tests passed"
