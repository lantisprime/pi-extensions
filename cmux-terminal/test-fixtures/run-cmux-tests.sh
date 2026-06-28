#!/usr/bin/env bash
# P5b-1 cmux-terminal test runner. Runs the 8 unit tests in test-cmux-backend.mjs
# via Node 22+ `--experimental-strip-types`. Also runs the REQ-13 grep guard
# (no agents/lib imports outside bg-terminal.ts) plus a second guard for the
# helper-file verbatim-copy contract.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Running P5b-1 cmux-backend tests..."
node --experimental-strip-types test-fixtures/test-cmux-backend.mjs
echo "Verifying REQ-13 (no agents/lib imports outside bg-terminal.ts)..."
if grep -rn 'from "\.\./.*/agents/lib/"' .; then
	echo "REQ-13 VIOLATED: agents/lib imports outside bg-terminal.ts"
	exit 1
fi
echo "REQ-13 OK"
echo "Verifying helper-file verbatim-copy contract (matches tmux-terminal/)..."
for f in path-validate.ts redact-error.ts shell-escape.ts resolve-worker-path.ts; do
	if ! diff -q "../tmux-terminal/lib/$f" "lib/$f" >/dev/null; then
		echo "Helper file drift detected: lib/$f differs from tmux-terminal/lib/$f"
		diff "../tmux-terminal/lib/$f" "lib/$f" || true
		exit 1
	fi
done
echo "Helper files OK"
echo "P5b-1 tests passed"
