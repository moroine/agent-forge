#!/bin/bash
# Tests structurels de config/lxd-agent-super-profile.yaml : profil du mode
# super, identique à agent SAUF qu'il restaure trois capabilities requises par
# le LXD imbriqué (snapd/snap-confine). Voir
# docs/superpowers/specs/2026-09-17-super-mode-nested-lxd-design.md.
# Lancer : bash tests/test-lxd-agent-super-profile.sh
set -e

FILE="$(cd "$(dirname "$0")/.." && pwd)/config/lxd-agent-super-profile.yaml"
PASS=0
FAIL=0

assert_contains() {
  if grep -qF -- "$1" "$FILE"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL (attendu présent): $1"; fi
}
assert_not_contains() {
  if grep -qF -- "$1" "$FILE"; then FAIL=$((FAIL + 1)); echo "FAIL (attendu absent): $1"; else PASS=$((PASS + 1)); fi
}

# Durcissement conservé
assert_contains 'security.privileged: "false"'
assert_contains 'security.nesting: "true"'
assert_contains 'security.syscalls.deny_default: "true"'

# Les trois capabilities que super doit GARDER (le LXD imbriqué en dépend) :
# elles ne doivent apparaître dans AUCUNE ligne de drop.
assert_not_contains 'lxc.cap.drop = sys_module sys_rawio sys_boot sys_ptrace sys_pacct'
assert_not_contains 'mac_override mac_admin'
# La forme attendue de la première ligne de drop, ptrace retiré
assert_contains 'lxc.cap.drop = sys_module sys_rawio sys_boot sys_pacct'

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
