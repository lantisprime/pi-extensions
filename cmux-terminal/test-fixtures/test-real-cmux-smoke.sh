#!/usr/bin/env bash
# P5b-1-S1 real-cmux integration smoke test runner.
# Requires:
#   - cmux 0.64.17+ installed and on $PATH
#   - CMUX_SOCKET_MODE=allowAll exported (cmux has an ancestry check on its
#     Unix socket; this smoke test runs in a foreign process tree)
#
# Usage:
#   CMUX_SOCKET_MODE=allowAll bash cmux-terminal/test-fixtures/test-real-cmux-smoke.sh
#
# Exits 0 only when every smoke step passes (the .mjs itself prints
# "ALL SMOKE TESTS PASSED" on success).
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${CMUX_SOCKET_MODE:-}" != "allowAll" ]]; then
	echo "FAIL: CMUX_SOCKET_MODE=allowAll is required." >&2
	echo "cmux 0.64.17 has a default ancestry check on its Unix socket." >&2
	echo "Re-run with:  CMUX_SOCKET_MODE=allowAll bash $0" >&2
	exit 1
fi

node --experimental-strip-types test-fixtures/test-real-cmux-smoke.mjs