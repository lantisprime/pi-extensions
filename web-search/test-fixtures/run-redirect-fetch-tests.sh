#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
npx --yes tsx web-search/test-fixtures/test-redirect-fetch.ts
npx --yes tsx web-search/test-fixtures/test-duckduckgo.ts
npx --yes tsx web-search/test-fixtures/test-searxng.ts
