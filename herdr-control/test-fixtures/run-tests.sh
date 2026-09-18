#!/usr/bin/env bash
# herdr-control test runner (mirrors cmux-control/tmux-control style).
# Runs via Node 22+ `--experimental-strip-types`; no herdr server required.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Running herdr-control exec tests..."
node --experimental-strip-types test-fixtures/test-exec.mjs
echo "Running herdr-control safety tests..."
node --experimental-strip-types test-fixtures/test-safety.mjs
echo "Running herdr-control json tests..."
node --experimental-strip-types test-fixtures/test-json.mjs
echo "Running herdr-control gate tests..."
node --experimental-strip-types test-fixtures/test-gate.mjs
echo "Running herdr-control registry tests..."
node --experimental-strip-types test-fixtures/test-registry.mjs
echo "Running herdr-control nlp tests..."
node --experimental-strip-types test-fixtures/test-nlp.mjs
echo "Running herdr-control read/list tests..."
node --experimental-strip-types test-fixtures/test-read-list.mjs
echo "Running herdr-control launch tests..."
node --experimental-strip-types test-fixtures/test-launch.mjs
echo "Running herdr-control prompt tests..."
node --experimental-strip-types test-fixtures/test-prompt.mjs
echo "Running herdr-control terminal tests..."
node --experimental-strip-types test-fixtures/test-terminal.mjs
echo "Running herdr-control extension entry tests..."
node --experimental-strip-types test-fixtures/test-extension.mjs
echo "herdr-control tests passed"
