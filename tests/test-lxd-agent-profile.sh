#!/bin/bash
# Tests structurels de config/lxd-agent-profile.yaml : nesting activé et
# disque suffisant pour Docker rootless (voir
# docs/superpowers/specs/2026-07-17-agent-docker-support-design.md).
# Lancer : bash tests/test-lxd-agent-profile.sh
set -e

FILE="$(cd "$(dirname "$0")/.." && pwd)/config/lxd-agent-profile.yaml"
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

assert_contains 'security.nesting: "true"'
assert_not_contains 'security.nesting: "false"'
assert_contains 'security.privileged: "false"'
assert_contains 'size: 100GB'
assert_not_contains 'size: 20GB'

# Les capabilities explicitement retirées restent inchangées malgré le nesting
assert_contains 'lxc.cap.drop = sys_module sys_rawio sys_boot sys_ptrace sys_pacct'
assert_contains 'lxc.cap.drop = mac_override mac_admin'
assert_contains 'lxc.cap.drop = bpf perfmon'

# claude-code arrive par un montage read-only depuis l'hôte (spec §4) :
# l'agent ne peut pas modifier le CLI, et une mise à jour hôte profite à
# tous les containers sans en recréer aucun.
assert_contains 'forge-claude:'
assert_contains 'path: /opt/forge-claude'
assert_contains 'readonly: "true"'
assert_contains 'source: /home/moroine/.local/share/agent-forge/claude'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
