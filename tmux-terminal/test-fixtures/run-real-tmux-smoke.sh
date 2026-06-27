#!/usr/bin/env bash
# P5 real-tmux integration smoke test runner.
# Runs the smoke test against an isolated tmux socket (-L p5-smoke-<pid>).
# Exits 0 if tmux is unavailable (test is opt-in by environment).
set -euo pipefail
cd "$(dirname "$0")/../.."
node --experimental-strip-types tmux-terminal/test-fixtures/test-real-tmux-smoke.mjs