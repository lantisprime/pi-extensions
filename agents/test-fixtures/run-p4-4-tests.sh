#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "P4-4 bg-terminal tests"
node --experimental-strip-types test-fixtures/test-bg-terminal.mjs
echo "P4-4 bg-terminal tests passed"
