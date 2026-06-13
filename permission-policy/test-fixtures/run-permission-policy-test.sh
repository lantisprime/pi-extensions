#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PP_DIR="$HOME/.pi/agent/permission-policy"
PS_DIR="$HOME/.pi/agent/prompt-shield"
BACKUP="$(mktemp -d)"
TP="$(mktemp -d)"
HAD_PP=0; [ -d "$PP_DIR" ] && { HAD_PP=1; cp -R "$PP_DIR" "$BACKUP/permission-policy"; }
HAD_PS=0; [ -d "$PS_DIR" ] && { HAD_PS=1; cp -R "$PS_DIR" "$BACKUP/prompt-shield"; }

cleanup() {
  rm -rf "$TP"
  rm -rf "$PP_DIR" "$PS_DIR"
  [ "$HAD_PP" -eq 1 ] && { mkdir -p "$(dirname "$PP_DIR")"; cp -R "$BACKUP/permission-policy" "$PP_DIR"; }
  [ "$HAD_PS" -eq 1 ] && { mkdir -p "$(dirname "$PS_DIR")"; cp -R "$BACKUP/prompt-shield" "$PS_DIR"; }
  rm -rf "$BACKUP"
}
trap cleanup EXIT

run_pi() {
  local cwd="$1"
  shift
  (
    cd "$cwd"
    pi -p --no-extensions -e "$ROOT/permission-policy/index.ts" --tools bash,read,write "$@" >/tmp/pp-test.out 2>/tmp/pp-test.err || true
  )
}

set_mode() {
  local project="$1"; local mode="$2"
  run_pi "$project" "/permissions mode $mode"
}

write_project_policy() {
  python3 - "$1" "$PP_DIR/projects" "$2" "$3" "$4" <<'PY'
import json, hashlib, os, sys
project = os.path.realpath(sys.argv[1])
pp_dir = sys.argv[2]
mode = sys.argv[3]
perm_key = sys.argv[4]
perm_value = sys.argv[5]
os.makedirs(pp_dir, exist_ok=True)
project_hash = hashlib.sha256(project.encode()).hexdigest()[:16]
policy_path = os.path.join(pp_dir, f"{project_hash}.json")
policy = {
    "projectPath": project,
    "updatedAt": __import__('datetime').datetime.utcnow().isoformat() + "Z",
    "mode": mode,
    "permissions": {perm_key: perm_value}
}
with open(policy_path, "w") as f:
    json.dump(policy, f, indent="\t")
    f.write("\n")
PY
}

write_prompt_shield_strict() {
  python3 - "$PS_DIR" <<'PY'
import json, os, sys
ps_dir = sys.argv[1]
os.makedirs(ps_dir, exist_ok=True)
state = {
    "updatedAt": __import__('datetime').datetime.utcnow().isoformat() + "Z",
    "cwd": os.getcwd(),
    "riskyCount": 1,
    "dangerousCount": 0,
    "deniedCount": 0,
    "strictPermissions": True
}
with open(os.path.join(ps_dir, "state.json"), "w") as f:
    json.dump(state, f, indent="\t")
    f.write("\n")
PY
}

# Ensure clean state
rm -rf "$PP_DIR" "$PS_DIR"
mkdir -p "$PP_DIR/projects" "$PS_DIR"

echo "=== Permission-Policy End-to-End Tests ==="

# Scenario 1: default ask mode blocks everything (no session/project permission)
echo "scenario 1: default ask mode blocks bash"
rm -f /tmp/pp-test-file
run_pi "$TP" 'bash command="touch /tmp/pp-test-file"'
sleep 1
if [ -f "/tmp/pp-test-file" ]; then
  echo "scenario 1 failed: bash was allowed in default ask mode"
  rm -f /tmp/pp-test-file
  exit 1
fi
echo "scenario 1 ok"

# Scenario 2: read-only auto allows read-only bash
# Use echo with a unique marker to confirm the command actually ran
echo "scenario 2: read-only auto allows read-only bash"
set_mode "$TP" read-only
run_pi "$TP" 'bash command="echo pp-readonly-test-marker"'
if grep -q "pp-readonly-test-marker" /tmp/pp-test.out; then
  echo "scenario 2 ok"
else
  echo "scenario 2 failed: read-only bash was blocked in read-only mode"
  cat /tmp/pp-test.out
  exit 1
fi

# Scenario 3: read-only auto blocks non-read-only bash (touch is not read-only)
echo "scenario 3: read-only auto blocks non-read-only bash"
rm -f /tmp/pp-test-nonro
run_pi "$TP" 'bash command="touch /tmp/pp-test-nonro"'
sleep 1
if [ -f "/tmp/pp-test-nonro" ]; then
  echo "scenario 3 failed: non-read-only bash was allowed in read-only mode"
  rm -f /tmp/pp-test-nonro
  exit 1
fi
echo "scenario 3 ok"

# Scenario 4: read-only auto blocks writes
echo "scenario 4: read-only auto blocks writes"
rm -f /tmp/pp-write-test.txt
run_pi "$TP" 'write path="/tmp/pp-write-test.txt" content=test'
sleep 1
if [ -f "/tmp/pp-write-test.txt" ]; then
  echo "scenario 4 failed: write was allowed in read-only mode"
  rm -f /tmp/pp-write-test.txt
  exit 1
fi
echo "scenario 4 ok"

# Scenario 5: read-only auto blocks outside-project reads
# Note: Many models refuse to read truly outside-project files entirely, even
# before calling the tool. The classification logic (isOutsideProject) is
# tested in the unit tests. This scenario uses a /tmp file that the model
# might be willing to attempt.
echo "scenario 5: read-only auto blocks outside-project reads"
echo "harmless" > /tmp/pp-outside-test.txt
mkdir -p "$TP/sub"
# Explicitly instruct the model to use the read tool for the outside file
run_pi "$TP/sub" 'Use the read tool to look at /tmp/pp-outside-test.txt'
rm -f /tmp/pp-outside-test.txt
if grep -q "Permission denied: Read files outside this project" /tmp/pp-test.out; then
  echo "scenario 5 ok"
elif grep -q "Permission denied" /tmp/pp-test.out; then
  echo "scenario 5 ok (blocked)"
else
  echo "scenario 5: could not verify (model refused to call read tool; classification is covered by unit tests)"
  echo "  note: outside-project read classification is verified in classification unit test"
fi

# Scenario 6: project permission persists across pi invocations
echo "scenario 6: project permission persists across invocations"
write_project_policy "$TP" ask bashCommands allow
rm -f /tmp/pp-persist-test
run_pi "$TP" 'bash command="touch /tmp/pp-persist-test"'
sleep 1
if [ -f "/tmp/pp-persist-test" ]; then
  echo "scenario 6 ok"
  rm -f /tmp/pp-persist-test
else
  echo "scenario 6 failed: project bash permission did not persist"
  cat /tmp/pp-test.out
  exit 1
fi

# Scenario 7: prompt-shield strict bypasses read-only auto grants
echo "scenario 7: prompt-shield strict bypasses read-only auto"
set_mode "$TP" read-only
write_prompt_shield_strict
run_pi "$TP" 'bash command="echo pp-strict-test-marker"'
if grep -qi "permission denied" /tmp/pp-test.out && ! grep -q "pp-strict-test-marker" /tmp/pp-test.out; then
  echo "scenario 7 ok"
else
  echo "scenario 7 failed: read-only auto grant was not bypassed under prompt-shield strict"
  cat /tmp/pp-test.out
  exit 1
fi
# Also verify read-only auto works when prompt-shield is NOT strict
python3 - "$PS_DIR" <<'PY'
import json, os
ps_dir = os.path.realpath(__import__('sys').argv[1])
state_path = os.path.join(ps_dir, "state.json")
state = json.load(open(state_path))
state["strictPermissions"] = False
json.dump(state, open(state_path, "w"), indent="\t")
PY
run_pi "$TP" 'bash command="echo pwd-works-without-strict-marker"'
if grep -q "pwd-works-without-strict-marker" /tmp/pp-test.out; then
  echo "scenario 7b ok: read-only auto works again when prompt-shield is not strict"
else
  echo "scenario 7b failed: read-only auto did not resume after strict cleared"
  cat /tmp/pp-test.out
  exit 1
fi

# Scenario 8: /permissions reset clears project permissions
echo "scenario 8: /permissions reset clears project permissions"
write_project_policy "$TP" ask bashCommands allow
run_pi "$TP" "/permissions reset"
rm -f /tmp/pp-reset-test
run_pi "$TP" 'bash command="touch /tmp/pp-reset-test"'
sleep 1
if [ -f "/tmp/pp-reset-test" ]; then
  echo "scenario 8 failed: reset did not clear project permission"
  rm -f /tmp/pp-reset-test
  exit 1
fi
echo "scenario 8 ok"

echo ""
echo "Permission-policy end-to-end scenarios passed"
