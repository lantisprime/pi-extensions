#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
npx --yes tsx agents/test-fixtures/test-ephemeral.mjs
echo "P3c-4 ephemeral tests passed"
