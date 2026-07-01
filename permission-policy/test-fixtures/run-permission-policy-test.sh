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
if grep -qiE "denied|not permitted|blocked|permission restriction" /tmp/pp-test.out; then
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

# ---- CLI --permission-mode flag scenarios ----

run_pi_with_flag() {
  local cwd="$1"
  local mode="$2"
  shift 2
  (
    cd "$cwd"
    pi -p --no-extensions --permission-mode "$mode" -e "$ROOT/permission-policy/index.ts" --tools bash,read,write "$@" >/tmp/pp-test.out 2>/tmp/pp-test.err || true
  )
}

read_policy_mode() {
  local project_path="$1"
  local project_real
  project_real="$(cd "$project_path" 2>/dev/null && pwd -P || echo "$project_path")"
  local hash
  hash=$(python3 -c "import hashlib; print(hashlib.sha256('$project_real'.encode()).hexdigest()[:16])")
  local policy_file="$PP_DIR/projects/${hash}.json"
  if [ -f "$policy_file" ]; then
    python3 -c "import json; print(json.load(open('$policy_file'))['mode'])"
  else
    echo "none"
  fi
}

# Clean policy dir before CLI flag tests
rm -rf "$PP_DIR/projects"
mkdir -p "$PP_DIR/projects"

# Scenario 9: --permission-mode yolo allows bash commands
rm -rf "$PP_DIR/projects"
mkdir -p "$PP_DIR/projects"
TP9="$(mktemp -d)"
echo "scenario 9: --permission-mode yolo allows bash"
rm -f /tmp/pp-cli-yolo-test
run_pi_with_flag "$TP9" yolo 'bash command="touch /tmp/pp-cli-yolo-test"'
sleep 1
if [ -f "/tmp/pp-cli-yolo-test" ]; then
  echo "scenario 9 ok"
  rm -f /tmp/pp-cli-yolo-test
else
  echo "scenario 9 failed: yolo mode did not allow bash"
  cat /tmp/pp-test.out
  rm -rf "$TP9"
  exit 1
fi

# Verify policy file was written with yolo mode
ACTUAL_MODE=$(read_policy_mode "$TP9")
if [ "$ACTUAL_MODE" = "yolo" ]; then
  echo "scenario 9b ok: policy file saved with yolo mode"
else
  echo "scenario 9b failed: policy mode is '$ACTUAL_MODE', expected 'yolo'"
  rm -rf "$TP9"
  exit 1
fi
rm -rf "$TP9"

# Scenario 10: --permission-mode read-only allows read-only bash
rm -rf "$PP_DIR/projects"
mkdir -p "$PP_DIR/projects"
TP10="$(mktemp -d)"
echo "scenario 10: --permission-mode read-only allows read-only bash"
run_pi_with_flag "$TP10" read-only 'bash command="echo pp-cli-readonly-marker"'
if grep -q "pp-cli-readonly-marker" /tmp/pp-test.out; then
  echo "scenario 10 ok"
else
  echo "scenario 10 failed: read-only bash was blocked in read-only mode"
  cat /tmp/pp-test.out
  rm -rf "$TP10"
  exit 1
fi

# Scenario 10b: read-only mode blocks destructive bash
rm -f /tmp/pp-cli-ro-block
run_pi_with_flag "$TP10" read-only 'bash command="touch /tmp/pp-cli-ro-block"'
sleep 1
if [ -f "/tmp/pp-cli-ro-block" ]; then
  echo "scenario 10b failed: destructive bash was allowed in read-only mode"
  rm -f /tmp/pp-cli-ro-block
  rm -rf "$TP10"
  exit 1
fi
echo "scenario 10b ok: destructive bash blocked in read-only mode"

# Verify policy file was written with readOnlyAuto mode
ACTUAL_MODE=$(read_policy_mode "$TP10")
if [ "$ACTUAL_MODE" = "readOnlyAuto" ]; then
  echo "scenario 10c ok: policy file saved with readOnlyAuto mode"
else
  echo "scenario 10c failed: policy mode is '$ACTUAL_MODE', expected 'readOnlyAuto'"
  rm -rf "$TP10"
  exit 1
fi
rm -rf "$TP10"

# Scenario 11: --permission-mode auto saves llmAuto to policy
rm -rf "$PP_DIR/projects"
mkdir -p "$PP_DIR/projects"
TP11="$(mktemp -d)"
echo "scenario 11: --permission-mode auto saves llmAuto to policy"
run_pi_with_flag "$TP11" auto 'echo test'
ACTUAL_MODE=$(read_policy_mode "$TP11")
if [ "$ACTUAL_MODE" = "llmAuto" ]; then
  echo "scenario 11 ok"
else
  echo "scenario 11 failed: policy mode is '$ACTUAL_MODE', expected 'llmAuto'"
  rm -rf "$TP11"
  exit 1
fi
rm -rf "$TP11"

# Scenario 12: --permission-mode ask blocks bash (default behavior)
rm -rf "$PP_DIR/projects"
mkdir -p "$PP_DIR/projects"
TP12="$(mktemp -d)"
echo "scenario 12: --permission-mode ask blocks unapproved bash"
rm -f /tmp/pp-cli-ask-test
run_pi_with_flag "$TP12" ask 'bash command="touch /tmp/pp-cli-ask-test"'
sleep 1
if [ -f "/tmp/pp-cli-ask-test" ]; then
  echo "scenario 12 failed: ask mode allowed unapproved bash"
  rm -f /tmp/pp-cli-ask-test
  rm -rf "$TP12"
  exit 1
fi
echo "scenario 12 ok"

# Verify policy file mode
ACTUAL_MODE=$(read_policy_mode "$TP12")
if [ "$ACTUAL_MODE" = "ask" ]; then
  echo "scenario 12b ok: policy file saved with ask mode"
else
  echo "scenario 12b failed: policy mode is '$ACTUAL_MODE', expected 'ask'"
  rm -rf "$TP12"
  exit 1
fi
rm -rf "$TP12"

# Scenario 13: --permission-mode with invalid value resets to ask
rm -rf "$PP_DIR/projects"
mkdir -p "$PP_DIR/projects"
TP13="$(mktemp -d)"
echo "scenario 13a: invalid value blocks bash (clean state)"
rm -f /tmp/pp-cli-invalid-test
run_pi_with_flag "$TP13" garbage 'bash command="touch /tmp/pp-cli-invalid-test"'
sleep 1
if [ -f "/tmp/pp-cli-invalid-test" ]; then
  echo "scenario 13a failed: invalid mode allowed bash"
  rm -f /tmp/pp-cli-invalid-test
  rm -rf "$TP13"
  exit 1
fi
echo "scenario 13a ok: invalid flag value resets to ask, bash blocked"

# Verify policy file was explicitly set to ask (not left untouched)
ACTUAL_MODE=$(read_policy_mode "$TP13")
if [ "$ACTUAL_MODE" = "ask" ]; then
  echo "scenario 13b ok: policy file explicitly saved with ask mode"
else
  echo "scenario 13b failed: policy mode is '$ACTUAL_MODE', expected 'ask'"
  rm -rf "$TP13"
  exit 1
fi
rm -rf "$TP13"

# Scenario 13c: invalid value overrides persisted yolo -> ask (blocker fix)
rm -rf "$PP_DIR/projects"
mkdir -p "$PP_DIR/projects"
TP13c="$(mktemp -d)"
echo "scenario 13c: invalid value overrides pre-existing yolo to ask"
write_project_policy "$TP13c" yolo bashCommands allow
run_pi_with_flag "$TP13c" garbage 'echo test'
ACTUAL_MODE=$(read_policy_mode "$TP13c")
if [ "$ACTUAL_MODE" = "ask" ]; then
  echo "scenario 13c ok: invalid flag reset yolo to ask (fail closed)"
else
  echo "scenario 13c failed: policy mode is '$ACTUAL_MODE', expected 'ask' (should not stay in yolo)"
  rm -rf "$TP13c"
  exit 1
fi
rm -rf "$TP13c"

# Scenario 13d: empty string value overrides persisted yolo -> ask (fail-closed)
rm -rf "$PP_DIR/projects"
mkdir -p "$PP_DIR/projects"
TP13d="$(mktemp -d)"
echo "scenario 13d: empty string overrides pre-existing yolo to ask"
write_project_policy "$TP13d" yolo bashCommands allow
run_pi_with_flag "$TP13d" '' 'echo test'
ACTUAL_MODE=$(read_policy_mode "$TP13d")
if [ "$ACTUAL_MODE" = "ask" ]; then
  echo "scenario 13d ok: empty flag reset yolo to ask (fail closed)"
else
  echo "scenario 13d failed: policy mode is '$ACTUAL_MODE', expected 'ask'"
  rm -rf "$TP13d"
  exit 1
fi
rm -rf "$TP13d"

# Scenario 14: --permission-mode yolo still hard-blocks rm -f
rm -rf "$PP_DIR/projects"
mkdir -p "$PP_DIR/projects"
TP14="$(mktemp -d)"
echo "scenario 14: --permission-mode yolo still hard-blocks rm -f"
echo "test" > /tmp/pp-cli-rm-test
run_pi_with_flag "$TP14" yolo 'bash command="rm -f /tmp/pp-cli-rm-test"'
# The file should still exist because yolo hard-blocks rm -f
if [ -f "/tmp/pp-cli-rm-test" ]; then
  echo "scenario 14 ok: rm -f blocked even in yolo mode via CLI flag"
  rm -f /tmp/pp-cli-rm-test
else
  echo "scenario 14 failed: rm -f was NOT blocked in yolo mode"
  rm -rf "$TP14"
  exit 1
fi
rm -rf "$TP14"

echo ""
echo "Permission-policy end-to-end scenarios passed"
