#!/bin/bash
# Vérifie le contenu de container/claude.json.
# Lancer : bash tests/test-claude-onboarding-state.sh
set -e

FILE="$(cd "$(dirname "$0")/.." && pwd)/container/claude.json"
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

check "global onboarding accepted" "d['hasCompletedOnboarding']" "True"
check "workspace trust accepted" "d['projects']['/workspace']['hasTrustDialogAccepted']" "True"
check "workspace project onboarding accepted" "d['projects']['/workspace']['hasCompletedProjectOnboarding']" "True"
check "chrome-devtools MCP command" "d['mcpServers']['chrome-devtools']['command']" "chrome-devtools-mcp"
check "chrome-devtools MCP headless flag" "'--headless' in d['mcpServers']['chrome-devtools']['args']" "True"
check "chrome-devtools MCP executablePath flag" "'--executablePath=/usr/bin/google-chrome-stable' in d['mcpServers']['chrome-devtools']['args']" "True"
check "chrome-devtools MCP isolated flag" "'--isolated' in d['mcpServers']['chrome-devtools']['args']" "True"
check "chrome-devtools MCP no-usage-statistics flag" "'--no-usage-statistics' in d['mcpServers']['chrome-devtools']['args']" "True"

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
