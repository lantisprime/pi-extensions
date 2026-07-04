#!/usr/bin/env bash
# P5b-2 zellij-terminal test runner. Runs the 33 unit tests in
# test-zellij-backend.mjs, the 4 extension tests in test-extension.mjs, the
# REQ-9 grep guard (no shell-spawning APIs), the REQ-13 real-zellij smoke
# (UNGUARDED-IN-CI — self-skips if zellij is not on $PATH or socket dir is
# unusable), and the REQ-10 git-diff guard (no agents/ or tmux-terminal/ or
# cmux-terminal/ changes).
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "Running P5b-2 zellij-backend tests..."
node --experimental-strip-types zellij-terminal/test-fixtures/test-zellij-backend.mjs
echo "Running P5b-2 zellij-extension tests..."
node --experimental-strip-types zellij-terminal/test-fixtures/test-extension.mjs
echo "Verifying REQ-9 (no shell-spawning APIs in lib/)..."
if grep -rnE 'shell:\s*true|\bexecSync\b|child_process\.exec\b' zellij-terminal/lib/; then
	echo "REQ-9 VIOLATED: shell-spawning APIs found in zellij-terminal/lib/"
	exit 1
fi
echo "REQ-9 OK"
echo "Verifying REQ-10 (no agents/ or tmux-terminal/ or cmux-terminal/ changes)..."
if [ -n "$(git diff --stat agents/ tmux-terminal/ cmux-terminal/ 2>/dev/null | head -1)" ]; then
	echo "REQ-10 VIOLATED: agents/ or tmux-terminal/ or cmux-terminal/ has changes"
	git diff --stat agents/ tmux-terminal/ cmux-terminal/
	exit 1
fi
echo "REQ-10 OK"
echo "Running P5b-2 real-zellij smoke (UNGUARDED-IN-CI, self-skips if zellij unavailable)..."
if command -v zellij >/dev/null; then
	# P5b-2 fix: production code in lib/exec.ts:getZellijSpawnEnv() ensures
	# ZELLIJ_SOCKET_DIR is set to a short path. No env setup needed here.
	node zellij-terminal/test-fixtures/test-real-zellij-smoke.mjs
else
	echo "zellij not installed, skipping smoke"
fi
echo "P5b-2 tests passed"
