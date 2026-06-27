#!/usr/bin/env bash
# Real end-to-end background-agent test: launches pi through an ACTUAL tmux
# session and asserts the run completes. Self-skips (exit 0) when tmux/pi are
# not on PATH or the environment can't run agents (e.g. no model auth), so it is
# safe to run anywhere — it only fails on an actual bg-launch regression.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "bg e2e (real tmux launches pi)"
node --experimental-strip-types test-fixtures/test-bg-e2e-tmux.mjs
