#!/usr/bin/env bash
# SCHEMA1-A test runner: green run + red-then-green negative control.
# BREAK_VALIDATE=1 flips one assertion expectation (test-agents-run-tool.mjs
# "validateRejectsEachBadInput") so a validation that wrongly passes goes red
# (a guard never observed failing guards nothing).
set -euo pipefail
cd "$(dirname "$0")/.."

node --test test/test-agents-run-tool.mjs
node --test test/test-agents-run-wiring.mjs
node --test test/test-chain-runner.mjs

# Negative control: with BREAK_VALIDATE=1 the test asserts a known-valid input
# is rejected — on correct validation code this must exit non-zero.
if BREAK_VALIDATE=1 node --test test/test-agents-run-tool.mjs >/dev/null 2>&1; then
  echo "negative control failed: validation unexpectedly passes broken input" >&2
  exit 1
fi
echo "agents-run tests: green + negative control red (as intended)"
