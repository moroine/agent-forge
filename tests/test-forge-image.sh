#!/bin/bash
# Tests structurels de scripts/forge (shim vers forge.ts) et
# scripts/lib/forge-image.sh (script bash standalone). Le dispatch de
# "forge image" est couvert par tests/e2e.test.ts.
# Lancer : bash tests/test-forge-image.sh
set -e

FORGE="$(cd "$(dirname "$0")/.." && pwd)/scripts/forge"
LIB="$(cd "$(dirname "$0")/.." && pwd)/scripts/lib/forge-image.sh"
PASS=0
FAIL=0

assert_contains() {
  local file="$1" pattern="$2"
  if grep -qF -- "$pattern" "$file"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu présent dans $file): $pattern"
  fi
}

assert_not_contains() {
  local file="$1" pattern="$2"
  if grep -qF -- "$pattern" "$file"; then
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu absent de $file): $pattern"
  else
    PASS=$((PASS + 1))
  fi
}

assert_line_before() {
  local file="$1" p1="$2" p2="$3" l1 l2
  l1=$(grep -nF -- "$p1" "$file" | head -1 | cut -d: -f1)
  l2=$(grep -nF -- "$p2" "$file" | head -1 | cut -d: -f1)
  if [ -n "$l1" ] && [ -n "$l2" ] && [ "$l1" -lt "$l2" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu '$p1' avant '$p2' dans $file): l1=${l1:-?} l2=${l2:-?}"
  fi
}

echo "bash -n syntax check..."
bash -n "$FORGE"
bash -n "$LIB"

assert_contains "$FORGE" 'exec node "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/forge.ts" "$@"'
assert_contains "$FORGE" 'forge requires Node 24+'
assert_contains "$LIB" '#!/bin/bash'
assert_contains "$LIB" 'if [ "${BASH_SOURCE[0]}" = "$0" ]; then'

assert_contains "$LIB" 'build|update'
assert_contains "$LIB" 'agent-base-setup'
assert_contains "$LIB" 'lxc publish'
assert_line_before "$LIB" 'Removing leftover' 'lxc launch ubuntu:24.04'
assert_contains "$LIB" 'lxc launch ubuntu:24.04 "$setup" --profile agent'
assert_contains "$LIB" 'docker-ce docker-ce-cli containerd.io docker-ce-rootless-extras docker-compose-plugin'
assert_contains "$LIB" 'systemctl disable --now docker.service docker.socket containerd.service'
assert_contains "$LIB" 'systemctl mask docker.service containerd.service'
assert_line_before "$LIB" 'apt install -y docker-ce docker-ce-cli' 'systemctl disable --now docker.service docker.socket containerd.service'
assert_contains "$LIB" 'npm install -g chrome-devtools-mcp@latest'
assert_line_before "$LIB" 'google-chrome-stable_current_amd64.deb' 'npm install -g chrome-devtools-mcp@latest'
assert_line_before "$LIB" 'npm install -g chrome-devtools-mcp@latest' 'Installing Docker (rootless)'
assert_contains "$LIB" 'chown -R aiuser:aiuser /home/aiuser'
assert_line_before "$LIB" 'mkdir -p /workspace /home/aiuser/.ssh' 'chown -R aiuser:aiuser /home/aiuser'
assert_contains "$LIB" "sed -i '/^aiuser:/d' /etc/subuid /etc/subgid"
assert_contains "$LIB" "echo 'aiuser:200000:65536' >> /etc/subuid"
assert_contains "$LIB" "echo 'aiuser:200000:65536' >> /etc/subgid"
assert_not_contains "$LIB" 'add-subuids'
assert_not_contains "$LIB" 'add-subgids'
assert_contains "$LIB" 'enable-linger aiuser'
assert_contains "$LIB" 'dockerd-rootless-setuptool.sh install'
assert_contains "$LIB" 'systemctl --user enable docker'
assert_contains "$LIB" 'DOCKER_HOST=unix:///run/user/1001/docker.sock'
assert_line_before "$LIB" 'useradd -m -s /bin/bash aiuser' "sed -i '/^aiuser:/d' /etc/subuid /etc/subgid"
assert_line_before "$LIB" "echo 'aiuser:200000:65536' >> /etc/subuid" 'dockerd-rootless-setuptool.sh install'

# git-lfs ships in the image
assert_contains "$LIB" 'git-lfs'
# image is stamped with the build commit
assert_contains "$LIB" 'lxc image set-property agent-base user.forge.commit'
assert_contains "$LIB" 'git -C "$FORGE_REPO_DIR" rev-parse HEAD'
# next-task is gone
assert_not_contains "$LIB" 'next-task'

assert_contains "$LIB" '/usr/local/bin/claude'
assert_contains "$LIB" 'readlink -f /opt/forge-claude/current'
assert_not_contains "$LIB" 'npm install -g @anthropic-ai/claude-code'

# --- garde source vs execution directe (voir le fix "safely sourceable") ---
# Le guard `if [ "${BASH_SOURCE[0]}" = "$0" ]; then cmd_forge_image "$@"; fi`
# a un mode d'echec silencieux : s'il evalue mal, `forge image build` devient
# un no-op sans que rien dans la suite ne le remarque. Ces deux assertions
# couvrent les deux moities du guard, sans toucher lxc.

# 1) Execute directement sans argument : cmd_forge_image doit tourner et
#    imprimer l'usage. Pas de lxc en jeu : la branche usage retourne avant
#    tout provisioning.
output=$(bash "$LIB" 2>&1) && code=0 || code=$?
if [ "$code" -ne 0 ] && echo "$output" | grep -qF 'Usage: forge image build|update'; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "FAIL (execution directe de $LIB sans argument, attendu usage + code non nul): code=$code sortie=[$output]"
fi

# 2) Source, la garde doit empecher cmd_forge_image de tourner avec les
#    arguments du script appelant — c'est exactement ce qui a casse l'ancien
#    scripts/forge avant le fix (set -e + cmd_forge_image "$@" inconditionnel
#    tuait tout le process pendant le sourcing).
output=$(bash -c 'set -e; source "'"$LIB"'"; echo STILL_ALIVE' list 2>&1) && code=0 || code=$?
if [ "$code" -eq 0 ] && [ "$output" = "STILL_ALIVE" ]; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "FAIL (source de $LIB avec argument 'list', attendu STILL_ALIVE + code 0): code=$code sortie=[$output]"
fi

# 3) Le garde-fou de version : sous Node < 24 le type-stripping n'existe pas,
#    et l'operateur recevrait une SyntaxError brute sur les annotations de
#    type au lieu d'un message exploitable. On simule un vieux node en tete
#    de PATH.
fakebin=$(mktemp -d)
trap 'rm -f "$fakebin/node"; rmdir "$fakebin"' EXIT
printf '#!/bin/sh\nif [ "$1" = "-v" ]; then echo v20.11.1; exit 0; fi\nexit 1\n' > "$fakebin/node"
chmod +x "$fakebin/node"
output=$(PATH="$fakebin:$PATH" "$FORGE" list 2>&1) && code=0 || code=$?
if [ "$code" -ne 0 ] && echo "$output" | grep -qF 'forge requires Node 24+ (found v20.11.1)'; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "FAIL (shim sous un node v20, attendu message + code non nul): code=$code sortie=[$output]"
fi

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
