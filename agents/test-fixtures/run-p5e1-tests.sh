#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
npx --yes tsx agents/test-fixtures/test-bg-args.mjs
npx --yes tsx agents/test-fixtures/test-bg.mjs
