#!/usr/bin/env bash
# P5 tmux-terminal test runner. Runs all 63 tests across 3 test files plus
# the REQ-13 grep guard (no agents/lib imports outside bg-terminal.ts).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Running P5 tmux-backend tests..."
node --experimental-strip-types test-fixtures/test-tmux-backend.mjs
echo "Running P5 helper tests..."
node --experimental-strip-types test-fixtures/test-helpers.mjs
echo "Running P5 extension tests..."
node --experimental-strip-types test-fixtures/test-extension.mjs
echo "Verifying REQ-13 (no agents/lib imports outside bg-terminal.ts)..."
if grep -rn 'from "\.\./.*/agents/lib/"' .; then
	echo "REQ-13 VIOLATED: agents/lib imports outside bg-terminal.ts"
	exit 1
fi
echo "REQ-13 OK"
echo "P5 tests passed"