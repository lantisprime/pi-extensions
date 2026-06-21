#!/usr/bin/env bash
# P8: non-blocking in-process agent runs + live TUI feedback — slice test runner.
set -euo pipefail
here="$(dirname "$0")"
node "$here/test-child-runner.mjs"   # P8-1: onProgress plumbing (+ existing child-runner suite)
node "$here/test-bg-run.mjs"         # P8-2: bg-run module (registry, spinner, sanitize, cap, dispose)
