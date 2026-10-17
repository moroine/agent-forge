#!/bin/bash
# Argument handling of ansible/tests/vm-test.sh: the cases that stop before
# any VM, SSH or Ansible work, so they run anywhere (npm run test:bash).
set -e

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/ansible/tests/vm-test.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0

# expect <name> <expected exit: 0|nonzero> <text the output must contain> -- <args...>
expect() {
  local name="$1" want="$2" text="$3" out code=0
  shift 4
  out="$("$SCRIPT" "$@" 2>&1)" || code=$?
  if { [ "$want" = 0 ] && [ "$code" -eq 0 ]; } || { [ "$want" = nonzero ] && [ "$code" -ne 0 ]; }; then
    if printf '%s' "$out" | grep -qF -- "$text"; then
      PASS=$((PASS + 1))
      return
    fi
  fi
  FAIL=$((FAIL + 1))
  echo "FAIL ($name): exit=$code, expected $want and output containing [$text]; output: $out"
}

bash -n "$SCRIPT"

echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIVmTestOnly vm-test@example" > "$TMP/admin.pub"

# --user-data prints the cloud-init that gives a fresh cloud VM its admin.
expect user-data-header 0 '#cloud-config' -- --user-data "$TMP/admin.pub"
expect user-data-user 0 'name: ubuntu' -- --user-data "$TMP/admin.pub"
expect user-data-sudo 0 'sudo: "ALL=(ALL) NOPASSWD:ALL"' -- --user-data "$TMP/admin.pub"
expect user-data-key 0 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIVmTestOnly vm-test@example' -- --user-data "$TMP/admin.pub"
expect user-data-missing nonzero 'no such public key' -- --user-data "$TMP/missing.pub"

# --host targets an existing machine: it needs the admin's private key.
expect host-without-key nonzero '--host needs --admin-key' -- --host 203.0.113.10
expect host-missing-key nonzero 'no such private key' -- --host 203.0.113.10 --admin-key "$TMP/missing"

# With --host, the new SSH port must get through the provider's firewall
# before provisioning moves sshd there (else the machine is locked out). An
# unroutable documentation address stands for a filtered port.
ssh-keygen -q -t ed25519 -N "" -C vm-test -f "$TMP/admin"
expect host-port-filtered nonzero 'port 2222 on 192.0.2.1 is not reachable' -- --host 192.0.2.1 --admin-key "$TMP/admin"

# Options that take a value fail loudly when it is missing.
expect exposure-last nonzero '--exposure needs a value' -- --exposure
expect exposure-bad nonzero '--exposure must be public, lan or local' -- --exposure nope
expect host-last nonzero '--host needs a value' -- --host

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
