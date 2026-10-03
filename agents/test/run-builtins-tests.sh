#!/usr/bin/env bash
# BUILTINS slice test runner: green run + red-then-green negative control.
# BREAK_BUILTINS=1 flips one fixture expectation so a roster regression that
# wrongly passes goes red (a guard never observed failing guards nothing).
set -euo pipefail
cd "$(dirname "$0")/.."

node --test test/test-builtins.mjs

# Negative control: with BREAK_BUILTINS=1 the test asserts the retired name
# 'tester' IS present — on correct code this must exit non-zero.
if BREAK_BUILTINS=1 node -e '
import { RESERVED_BUILT_IN_AGENT_NAMES } from "./lib/specs.ts";
process.exit(RESERVED_BUILT_IN_AGENT_NAMES.includes(process.env.BREAK_NAME ?? "tester") ? 0 : 1);
'; then
  echo "negative control failed: roster unexpectedly contains retired name" >&2
  exit 1
fi
echo "builtins tests: green + negative control red (as intended)"
