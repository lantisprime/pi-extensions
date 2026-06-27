#!/usr/bin/env bash
# tmux-control test runner. Runs unit tests + real-tmux smoke + REQ-13 guard.
#
# typebox dependency model:
#   - At RUNTIME (loaded by pi): pi's extension loader (jiti + virtualModules)
#     resolves typebox from pi's own node_modules. End users do not need to
#     install typebox.
#   - For TESTS (run via `node --experimental-strip-types`): Node's bare ESM
#     resolution does NOT find typebox from this directory. The runner below
#     installs typebox into ./node_modules on first run if missing.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d "node_modules/typebox" ]; then
	echo "Installing test dep typebox (one-time)..."
	npm install --no-save --no-audit --no-fund --silent typebox@^1.1.0
fi

echo "Running tmux-control safety tests..."
node --experimental-strip-types test-fixtures/test-safety.mjs
echo "Running tmux-control NLP tests..."
node --experimental-strip-types test-fixtures/test-nlp.mjs
echo "Running tmux-control exec tests..."
node --experimental-strip-types test-fixtures/test-exec.mjs
echo "Running tmux-control extension integration test..."
node --experimental-strip-types test-fixtures/test-extension-integration.mjs
echo "Running tmux-control real-tmux smoke..."
node --experimental-strip-types test-fixtures/test-real-tmux-smoke.mjs
echo "Verifying REQ-13 (no agents/lib imports outside resolve.ts)..."
# Allow ONLY lib/resolve.ts to dynamically import agents/lib.
hits=$(grep -rn 'from "\.\./\.\./agents/lib/"' lib/ index.ts | grep -v 'lib/resolve.ts' || true)
if [ -n "$hits" ]; then
	echo "REQ-13 VIOLATED: static import of agents/lib outside lib/resolve.ts"
	echo "$hits"
	exit 1
fi
echo "REQ-13 OK"
echo "tmux-control tests passed"