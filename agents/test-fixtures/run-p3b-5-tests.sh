#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
npx --yes tsx agents/test-fixtures/test-specs.mjs
npx --yes tsx agents/test-fixtures/test-agent-markdown.mjs
npx --yes tsx agents/test-fixtures/test-registry-gate.mjs
npx --yes tsx agents/test-fixtures/test-diagnostics.mjs
npx --yes tsx agents/test-fixtures/test-registration.mjs
npx --yes tsx agents/test-fixtures/test-extension-scaffold.mjs
scripts/verify-shared-sync.sh
