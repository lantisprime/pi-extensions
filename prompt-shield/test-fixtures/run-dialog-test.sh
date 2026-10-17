#!/usr/bin/env bash
# prompt-shield dialog wiring test runner (herdr-control test style).
# Runs via Node 22+ `--experimental-strip-types`; no pi, network, or herdr
# needed. The loader hook stands in for pi's jiti virtualModules, which serve
# @earendil-works/pi-ai to extensions at runtime.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Running prompt-shield dialog wiring tests..."
node --experimental-strip-types --import ./test-fixtures/register-hooks.mjs test-fixtures/test-dialog.mjs
echo "prompt-shield dialog tests passed"
