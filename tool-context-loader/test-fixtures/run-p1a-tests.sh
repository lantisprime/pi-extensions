#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
npx --yes tsx tool-context-loader/test-fixtures/test-discovery.ts
npx --yes tsx tool-context-loader/test-fixtures/test-preload.ts
