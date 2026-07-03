#!/usr/bin/env bash
# P5b-1-S3 real-cmux end-to-end /agents bg dispatch test driver.
#
# UNGUARDED-IN-CI per REQ-R2. Requires:
#   - macOS (cmux is Ghostty-based darwin-only)
#   - cmux 0.64.17+ installed and on $PATH
#   - cmux GUI running
#   - CMUX_SOCKET_MODE=allowAll exported in cmux's environment
#     (cmux 0.64.17+ has a default ancestry check on its Unix socket;
#      only the process tree that started cmux can talk to it by default.
#      This test runs in a foreign process tree.)
#
# Usage:
#   bash cmux-terminal/test-fixtures/run-real-cmux-e2e.sh
#
# The .mjs itself gates on each of the above and exits 0 on any
# environment-skip case (CONFIG-REQUIRED for missing CMUX_SOCKET_MODE,
# SKIP for missing cmux binary or unreachable daemon).  We pre-set
# CMUX_SOCKET_MODE=allowAll here so the common-case invocation Just Works
# — the .mjs gate is the safety net for someone running it directly.
#
# Exits 0 if all scripted tests pass (or any env-gate triggers a skip);
# non-zero if a scripted test fails.
set -euo pipefail
cd "$(dirname "$0")/.."

# Export CMUX_SOCKET_MODE=allowAll unless the caller already set it.
# This is the opt-in that lets a foreign process tree talk to cmux's
# socket; without it, the .mjs's gate 2 will skip with CONFIG-REQUIRED.
export CMUX_SOCKET_MODE="${CMUX_SOCKET_MODE:-allowAll}"

exec node --experimental-strip-types test-fixtures/test-real-cmux-e2e.mjs
