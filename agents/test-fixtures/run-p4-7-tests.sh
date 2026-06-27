#!/bin/bash
# P4-7: Background agent integration tests
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR/../.."

echo "P4-7 bg integration tests"
node agents/test-fixtures/test-bg.mjs

echo "P4-7 bg integration tests passed"