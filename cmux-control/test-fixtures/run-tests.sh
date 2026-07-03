#!/usr/bin/env bash
# P5d-S1 cmux-control macOS cmux 0.64.17+ test runner.
# Runs executor, identify, and socket tests via Node 22+ `--experimental-strip-types`.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Running P5d-S1 cmux-control exec tests..."
node --experimental-strip-types test-fixtures/test-exec.mjs
echo "Running P5d-S1 cmux-control identify tests..."
node --experimental-strip-types test-fixtures/test-identify.mjs
echo "Running P5d-S1 cmux-control socket tests..."
node --experimental-strip-types test-fixtures/test-cmux-socket.mjs
echo "Running P5d-S2 cmux-control safety tests..."
node --experimental-strip-types test-fixtures/test-safety.mjs
echo "Running P5d-S2 cmux-control focus-op tests..."
node --experimental-strip-types test-fixtures/test-focus-ops.mjs
echo "P5d-S2 cmux-control tests passed"
