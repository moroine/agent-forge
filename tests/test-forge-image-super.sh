#!/bin/bash
# Vérifie que forge-image.sh sait construire agent-base-super : profil correct,
# snapd démarré + seedé, snap LXD installé, aiuser dans le groupe lxd, image
# publiée et tamponnée. Lancer : bash tests/test-forge-image-super.sh
set -e

FILE="$(cd "$(dirname "$0")/.." && pwd)/cli/lib/forge-image.sh"
PASS=0
FAIL=0
assert_contains() {
  if grep -qF -- "$1" "$FILE"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL (attendu présent): $1"; fi
}

assert_contains '_forge_image_build_super'
assert_contains 'agent-super-setup'
assert_contains '--profile agent-super'
assert_contains 'snap wait system seed.loaded'
assert_contains 'snap install lxd'
assert_contains 'usermod -aG lxd aiuser'
assert_contains '--alias agent-base-super'
assert_contains 'lxc image set-property agent-base-super user.forge.commit'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
