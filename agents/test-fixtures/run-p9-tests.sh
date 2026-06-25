#!/usr/bin/env bash
set -euo pipefail
# P9: review-context provider layer (bundle assembly + prepareAgentTask wiring + B2 framing).
node "$(dirname "$0")/test-review-context.mjs"
node "$(dirname "$0")/test-prepare-task.mjs"
node "$(dirname "$0")/test-specs.mjs"        # built-in context: declarations + validation
node "$(dirname "$0")/test-child-runner.mjs" # includes B2 untrusted-framing test
