#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

echo "Running mcp-gateway tests..."
npx --yes tsx mcp-gateway/test-fixtures/test-mcp-client.ts
npx --yes tsx mcp-gateway/test-fixtures/test-security-gating.ts

echo "All mcp-gateway tests passed"
