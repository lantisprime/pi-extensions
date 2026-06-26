#!/usr/bin/env bash
set -euo pipefail
# P11: review-target flags (--base/--range) + header clarity.
# Groups A/B/C/G live in test-review-context.mjs; D/E/F in test-run-resolver-target.mjs;
# plumbing/directive wording in test-prepare-task.mjs. P9 suite is the regression net for the
# re-signed providers.
here="$(dirname "$0")"
node "$here/test-review-context.mjs"
node "$here/test-prepare-task.mjs"
node "$here/test-run-resolver-target.mjs"
bash "$here/run-p9-tests.sh"
echo "P11: all suites passed"
