#!/usr/bin/env bash
# tmux-control test runner. Runs unit tests + real-tmux smoke + REQ-13 + REQ-17 guards.
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
echo "Running tmux-control Path A bracketed-paste marker test..."
node --experimental-strip-types test-fixtures/test-pathA.mjs
echo "Verifying REQ-13 (no agents/lib imports outside resolve.ts)..."
# Allow ONLY lib/resolve.ts to dynamically import agents/lib.
hits=$(grep -rn 'from "\.\./\.\./agents/lib/"' lib/ index.ts | grep -v 'lib/resolve.ts' || true)
if [ -n "$hits" ]; then
	echo "REQ-13 VIOLATED: static import of agents/lib outside lib/resolve.ts"
	echo "$hits"
	exit 1
fi
echo "REQ-13 OK"
echo "Verifying REQ-17 (argv-only invariant)..."
# Forbidden: shell:true, execSync, raw exec( call sites (not executor.exec wrapper).
# Allowed: lib/exec.ts (where executor.exec is implemented), test fixtures (fake-tmux).
violations_shell=$(grep -rnE 'shell:\s*true' lib/ index.ts 2>/dev/null || true)
violations_execsync=$(grep -rnE '\bexecSync\b' lib/ index.ts 2>/dev/null || true)
# ` exec\(` matches ` async exec(` (with leading space); the wrapper in lib/exec.ts is allowed.
violations_exec=$(grep -rnE ' exec\(' lib/ index.ts 2>/dev/null | grep -v '^lib/exec.ts' || true)
violations="${violations_shell}${violations_execsync}${violations_exec}"
if [ -n "$violations" ]; then
	echo "REQ-17 VIOLATED: non-argv tmux invocations detected"
	echo "$violations"
	exit 1
fi
# REQ-17 red-then-green self-check: inject a deliberate violation, verify the
# guard bites, then remove the violation. Proves the guard is wired correctly
# (per PLAN_TEMPLATE.md Verify deny-list).
# Covers both `shell:\s*true` and `\bexecSync\b` patterns (the two most common
# argv-only escape hatches). The third pattern, raw ` exec\(`, is covered by
# the main guard + the fact that no production code other than lib/exec.ts
# defines the wrapper method.
echo "Verifying REQ-17 self-check (guard bites on deliberate violations)..."
self_check_file="lib/_req17_self_check.ts"
# Crash-safe cleanup: trap ensures rm runs on Ctrl-C, set -e abort, or any other
# abnormal exit. Without this, a mid-check interrupt would leave the violation
# file in lib/ and falsely trip the main REQ-17 guard on subsequent runs.
trap 'rm -f "$self_check_file"' EXIT
cat > "$self_check_file" <<'EOF'
// DELIBERATE REQ-17 VIOLATIONS (removed immediately by self-check)
const _req17_self_check_shell = { exec: "shell: true" };
const _req17_self_check_execsync = require("child_process").execSync("echo x");
EOF
# Temporarily allow failure to capture the guard's exit code.
set +e
grep -rnE 'shell:\s*true|\bexecSync\b' lib/ >/dev/null 2>&1
guard_bite=$?
set -e
rm -f "$self_check_file"
trap - EXIT  # Clear the trap now that cleanup is done
if [ "$guard_bite" -eq 0 ]; then
	echo "REQ-17 self-check OK"
else
	echo "REQ-17 self-check FAILED: guard did not bite on deliberate violation"
	exit 1
fi
echo "tmux-control tests passed"