#!/usr/bin/env bash
# tmux-control test runner. Runs unit tests + real-tmux smoke + REQ-13 guard.
set -euo pipefail
cd "$(dirname "$0")/.."

# typebox is a peer dep of @earendil-works/pi-coding-agent (not bundled with
# extensions). Make it findable by pointing NODE_PATH at pi's node_modules.
PI_NM="$(node -e "console.log(require.resolve('@earendil-works/pi-coding-agent/package.json').replace('/package.json',''))" 2>/dev/null || true)"
if [ -n "$PI_NM" ] && [ -d "$PI_NM/node_modules/typebox" ]; then
	export NODE_PATH="$PI_NM/node_modules${NODE_PATH:+:$NODE_PATH}"
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