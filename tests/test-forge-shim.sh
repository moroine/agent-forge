#!/bin/bash
# Structural tests of the cli/forge shim, taken over from test-forge-image.sh
# when forge-image.sh was deleted. tests/e2e.test.ts runs the shim for real.
# Run: bash tests/test-forge-shim.sh
set -e

FORGE="$(cd "$(dirname "$0")/.." && pwd)/cli/forge"
PASS=0
FAIL=0

assert_contains() {
  if grep -qF -- "$1" "$FORGE"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (expected in $FORGE): $1"
  fi
}

bash -n "$FORGE"
assert_contains 'exec node "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/forge.ts" "$@"'
assert_contains 'forge requires Node 24+'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
