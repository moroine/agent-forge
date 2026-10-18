#!/bin/bash
# Vérifie le template Lima du mode local et l'inventaire d'exemple qui va avec :
# les valeurs que la spec fixe, et le port SSH identique des deux côtés (le
# README les fait copier tels quels).
# Lancer : bash tests/test-lima-files.sh
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$ROOT/ansible/lima/forge.yaml"
INVENTORY="$ROOT/ansible/inventory.lima.example.yml"
PASS=0
FAIL=0

check() {  # check <description> <command...>
  local what="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $what"
  fi
}
has_line() { grep -qxF -- "$2" "$1"; }      # exact whole line

for line in 'minimumLimaVersion: 2.0.0' '  - template:_images/ubuntu-26.04' 'plain: true' \
  'cpus: 4' 'memory: 6GiB' 'disk: 60GiB' '  localPort: 60022' '  overVsock: false'; do
  check "template line [$line]" has_line "$TEMPLATE" "$line"
done
# plain: true ignores them, but a template that lists them misleads its reader.
check "template has no mounts key" bash -c "! grep -qE '^mounts:' '$TEMPLATE'"
check "template has no portForwards key" bash -c "! grep -qE '^portForwards:' '$TEMPLATE'"

for text in 'ansible_host: 127.0.0.1' 'ansible_port: 60022' \
  'ansible_ssh_private_key_file: ~/.lima/_config/user' 'HostKeyAlias=forge-local-admin' \
  'StrictHostKeyChecking=accept-new' 'forge_exposure: local' '- name: forge'; do
  check "inventory contains [$text]" grep -qF -- "$text" "$INVENTORY"
done
# Lima forwards its port to the guest's 22: forge_ssh_port stays at its default.
check "inventory leaves forge_ssh_port unset" bash -c "! grep -qE '^[[:space:]]*forge_ssh_port:' '$INVENTORY'"

template_port="$(sed -nE 's/^[[:space:]]+localPort:[[:space:]]*([0-9]+).*/\1/p' "$TEMPLATE" 2>/dev/null || true)"
inventory_port="$(sed -nE 's/^[[:space:]]+ansible_port:[[:space:]]*([0-9]+).*/\1/p' "$INVENTORY" 2>/dev/null || true)"
check "template port ($template_port) = inventory port ($inventory_port)" \
  test -n "$template_port" -a "$template_port" = "$inventory_port"

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
