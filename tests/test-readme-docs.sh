#!/bin/bash
# Vérifie que README.md documente le forge CLI (post-cutover).
# Lancer : bash tests/test-readme-docs.sh
set -e

FILE="$(cd "$(dirname "$0")/.." && pwd)/README.md"
PASS=0
FAIL=0

assert_contains() {
  if grep -qF -- "$1" "$FILE"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu présent): $1"
  fi
}

assert_not_contains() {
  if grep -qF -- "$1" "$FILE"; then
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu absent): $1"
  else
    PASS=$((PASS + 1))
  fi
}

assert_contains 'forge start'
assert_contains 'forge stop'
assert_contains 'forge delete'
assert_contains 'forge list'
assert_contains 'forge image build'
assert_contains 'forge completion bash'
assert_not_contains 'next-task'
assert_contains 'forge resume'
assert_contains 'forge finish'
assert_contains 'worktree'
assert_contains 'git-lfs'
assert_contains 'older than latest build'
assert_contains 'alias forge='
assert_contains 'idmap'
assert_contains 'Claude Code credentials'
assert_contains 'onboarding'
assert_contains 'permission mode'
assert_contains 'Docker/Compose'
assert_contains 'rootless'
assert_contains '--privileged'
assert_contains 'chrome-devtools-mcp'
assert_not_contains 'new-agent-container.sh'
assert_not_contains 'start-agent.sh'
assert_contains 'Supervised mode'
assert_contains 'git remote add'
assert_contains 'rebase --reset-author'
assert_not_contains 'fetch-only credential'
assert_contains 'forge image build super'
assert_contains 'agent-super'
assert_contains 'nested LXD'
assert_contains 'forge template rebuild'
assert_contains 'forge token'
assert_contains 'forge claude update'
assert_contains '.forge-cache'
assert_contains 'user.forge.role'
assert_not_contains 'forge stop <owner/repo> [--force]'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
