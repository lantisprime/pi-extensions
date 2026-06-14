#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
npx --yes tsx tool-context-loader/test-fixtures/test-discovery.ts
npx --yes tsx tool-context-loader/test-fixtures/test-preload.ts
npx --yes tsx tool-context-loader/test-fixtures/test-jit.ts
npx --yes tsx tool-context-loader/test-fixtures/test-jit-e2e.ts
npx --yes tsx tool-context-loader/test-fixtures/test-p1d-hardening.ts
