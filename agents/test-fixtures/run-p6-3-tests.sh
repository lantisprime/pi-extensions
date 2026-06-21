#!/usr/bin/env bash
set -euo pipefail
node "$(dirname "$0")/test-p3f-4.mjs"
node "$(dirname "$0")/test-subagent-tool.mjs"
node "$(dirname "$0")/test-intent-command.mjs"
