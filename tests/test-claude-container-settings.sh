#!/bin/bash
# Vérifie le contenu de container/settings.json.
# Lancer : bash tests/test-claude-container-settings.sh
set -e

FILE="$(cd "$(dirname "$0")/.." && pwd)/container/settings.json"
PASS=0
FAIL=0

check() {
  local desc="$1" expr="$2" expected="$3"
  local actual
  # Exceptions (e.g. a missing key) are caught and reported as a normal FAIL
  # instead of a bare traceback killing the script under set -e.
  actual=$(python3 -c "
import json
try:
    d = json.load(open('$FILE'))
    print($expr)
except Exception as e:
    print('ERROR:' + type(e).__name__)
")
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL ($desc): got '$actual', expected '$expected'"
  fi
}

echo "JSON validity..."
python3 -m json.tool "$FILE" > /dev/null

check "superpowers enabled" "d['enabledPlugins']['superpowers@claude-plugins-official']" "True"
check "pre-bash hook still wired" "d['hooks']['PreToolUse'][0]['hooks'][0]['command']" "bash /home/aiuser/.claude/hooks/pre-bash.sh"
# The image installs claude-code from the apt `stable` repository; the update
# notice must compare against the same channel, not `latest`.
check "update channel matches the apt stable repository" "d['autoUpdatesChannel']" "stable"

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
