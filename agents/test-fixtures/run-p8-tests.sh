#!/usr/bin/env bash
# P8: non-blocking in-process agent runs + live TUI feedback — slice test runner.
set -euo pipefail
here="$(dirname "$0")"
node "$here/test-child-runner.mjs"     # P8-1: onProgress plumbing (+ existing child-runner suite)
node "$here/test-bg-run.mjs"           # P8-2: bg-run module
node "$here/test-intent-command.mjs"   # P8-3: do/run wiring (+ existing do suite)
node "$here/test-chain.mjs"            # P8-3: chain wiring (+ existing chain suite)
node "$here/test-ephemeral.mjs"        # P8-3: run-temp wiring (+ existing ephemeral suite)
node "$here/test-subagent-tool.mjs"    # P8-3: REQ-9 — tool path stays synchronous
