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
echo "Running P5d-S3 cmux-control list tests..."
node --experimental-strip-types test-fixtures/test-list.mjs
echo "Running P5d-S3 cmux-control capture tests..."
node --experimental-strip-types test-fixtures/test-capture.mjs
echo "Running P5d-S3 cmux-control send tests..."
node --experimental-strip-types test-fixtures/test-send.mjs
echo "Running P5d-S3 cmux-control launch tests..."
node --experimental-strip-types test-fixtures/test-launch.mjs
echo "Running P5d-S4 cmux-control resolve tests..."
node --experimental-strip-types test-fixtures/test-resolve.mjs
echo "Running P5d-S4 cmux-control nlp tests..."
node --experimental-strip-types test-fixtures/test-nlp.mjs
echo "P5d-S4 cmux-control tests passed"
echo "Running P5d-S5 cmux-control extension entry test..."
node --experimental-strip-types test-fixtures/test-extension.mjs
echo "P5d-S5 cmux-control tests passed"
