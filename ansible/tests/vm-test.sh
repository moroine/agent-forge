#!/bin/bash
# Throwaway-VM test of ansible/site.yml (agent-forge v2, sub-project 1).
#
# Creates a VM on this LXD or Incus host, provisions it twice with site.yml
# (the second run must change nothing), runs tests/verify.yml, reboots the VM,
# verifies again, then deletes the VM. Runs on omen today, from a clone of
# `next` kept apart from the v1 clone. A v1 agent container cannot run it: it
# has no access to the host's LXD and cannot run a VM.
#
# Usage: ansible/tests/vm-test.sh [--exposure public|lan|local] [--keep]
set -e
set -o pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPOSURE="public"
KEEP=0
FORGE_SSH_PORT=2222   # moves sshd away from 22, so the port change is exercised

die() { echo "vm-test: $*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --exposure) EXPOSURE="${2:-}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) die "usage: $0 [--exposure public|lan|local] [--keep]" ;;
  esac
done
case "$EXPOSURE" in
  public|lan|local) ;;
  *) die "--exposure must be public, lan or local" ;;
esac

# --- Preconditions ---------------------------------------------------------
if command -v incus >/dev/null 2>&1; then
  CLI=incus
  IMAGE="images:ubuntu/26.04/cloud"
elif command -v lxc >/dev/null 2>&1; then
  CLI=lxc
  IMAGE="ubuntu:26.04"
else
  die "needs lxc (LXD) or incus on this host"
fi
[ -e /dev/kvm ] || die "/dev/kvm is missing: this host cannot run VMs"
for tool in ansible-playbook ansible-galaxy git ssh ssh-keygen ssh-agent ssh-add; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is missing"
done
# ansible-core >= 2.20; Ubuntu 24.04's apt ships 2.16 (pipx install ansible-core).
read -r major minor <<<"$(ansible-playbook --version | sed -nE '1s/.*core ([0-9]+)\.([0-9]+).*/\1 \2/p')"
if [ -z "$major" ] || [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt 20 ]; }; then
  die "ansible-core >= 2.20 is required ($(ansible-playbook --version | head -1)); try: pipx install ansible-core"
fi

# --- Throwaway material ----------------------------------------------------
WORK="$(mktemp -d)"
VM="forge-host-test-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
AGENT_PID=""
cleanup() {
  if [ -n "$AGENT_PID" ]; then kill "$AGENT_PID" 2>/dev/null || true; fi
  if [ "$KEEP" -eq 1 ]; then
    echo "vm-test: kept VM $VM and $WORK"
  else
    "$CLI" delete --force "$VM" >/dev/null 2>&1 || true
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

ssh-keygen -q -t ed25519 -N "" -C "vm-test-admin" -f "$WORK/admin"
ssh-keygen -q -t ed25519 -N "" -C "vm-test-forge" -f "$WORK/forge"
: > "$WORK/known_hosts"
# The forge key goes into a throwaway agent, so that verify.yml can check
# that agent forwarding reaches the forge user and is refused to the admin.
eval "$(ssh-agent -s)" >/dev/null
AGENT_PID="$SSH_AGENT_PID"
ssh-add -q "$WORK/forge"

export ANSIBLE_COLLECTIONS_PATH="$WORK/collections"
ansible-galaxy collection install -r "$REPO/ansible/requirements.yml" -p "$WORK/collections" >/dev/null

# --- VM ----------------------------------------------------------------------
cat > "$WORK/user-data" <<EOF
#cloud-config
ssh_authorized_keys:
  - $(cat "$WORK/admin.pub")
EOF
echo "vm-test: creating $VM from $IMAGE"
"$CLI" launch "$IMAGE" "$VM" --vm \
  -c limits.cpu=2 -c limits.memory=4GiB \
  -c cloud-init.user-data="$(cat "$WORK/user-data")" \
  -d root,size=40GiB

# The VM agent needs a moment before `exec` works.
for _ in $(seq 60); do
  "$CLI" exec "$VM" -- true >/dev/null 2>&1 && break
  sleep 5
done
# cloud-init exits 2 for "done, with recoverable errors": accept 0 and 2.
rc=0
"$CLI" exec "$VM" -- cloud-init status --wait >/dev/null || rc=$?
[ "$rc" -eq 0 ] || [ "$rc" -eq 2 ] || die "cloud-init failed in $VM (exit $rc)"
IP="$("$CLI" list "$VM" --format csv --columns 4 | sed -E 's/ .*//' | head -1)"
[ -n "$IP" ] || die "$VM has no IPv4 address"

wait_ssh() {  # $1 = port; succeeds once the admin can log in on it
  for _ in $(seq 60); do
    if ssh -F none -o BatchMode=yes -o ConnectTimeout=5 -o IdentitiesOnly=yes \
        -o HostKeyAlgorithms=ssh-ed25519 \
        -o UserKnownHostsFile="$WORK/known_hosts" -o StrictHostKeyChecking=accept-new \
        -i "$WORK/admin" -p "$1" "ubuntu@$IP" true 2>/dev/null; then
      return 0
    fi
    sleep 5
  done
  return 1
}
wait_ssh 22 || die "SSH on port 22 never answered"

# --- Inventory -------------------------------------------------------------
# ansible_port is left out on purpose: site.yml must find the port itself.
cat > "$WORK/inventory.yml" <<EOF
all:
  hosts:
    vm:
      ansible_host: "$IP"
      ansible_user: ubuntu
      ansible_ssh_private_key_file: "$WORK/admin"
      ansible_ssh_common_args: >-
        -o IdentitiesOnly=yes -o HostKeyAlgorithms=ssh-ed25519
        -o UserKnownHostsFile=$WORK/known_hosts -o StrictHostKeyChecking=accept-new
  vars:
    forge_exposure: "$EXPOSURE"
    forge_ssh_port: $FORGE_SSH_PORT
    forge_users:
      - name: forgetest
        ssh_keys:
          - "$(cat "$WORK/forge.pub")"
EOF

playbook() { ansible-playbook -i "$WORK/inventory.yml" "$@"; }

echo "vm-test: first run"
playbook "$REPO/ansible/site.yml"

echo "vm-test: second run (must change nothing; only changed tasks are shown)"
ANSIBLE_DISPLAY_OK_HOSTS=false ANSIBLE_DISPLAY_SKIPPED_HOSTS=false \
  playbook "$REPO/ansible/site.yml" | tee "$WORK/second-run.log"
grep -Eq '^vm +: .*changed=0 .*failed=0' "$WORK/second-run.log" \
  || die "the second run changed something (see the tasks above)"

# devsec must not have regenerated the host key: the key sshd showed on 22
# before provisioning is the one it shows on the new port.
key_on() { ssh-keygen -F "$1" -f "$WORK/known_hosts" | grep -v '^#' | awk '{print $3}' | head -1; }
k22="$(key_on "$IP")"
knew="$(key_on "[$IP]:$FORGE_SSH_PORT")"
[ -n "$k22" ] && [ "$k22" = "$knew" ] || die "the host key changed during provisioning"

verify() {  # $1 = true|false: run the deliberate authentication failures
  playbook "$REPO/ansible/tests/verify.yml" \
    -e "ansible_port=$FORGE_SSH_PORT" -e "verify_work=$WORK" -e "verify_negative_auth=$1"
}
echo "vm-test: verify"
verify true

echo "vm-test: reboot"
"$CLI" restart "$VM" --timeout 120 || "$CLI" restart --force "$VM"
wait_ssh "$FORGE_SSH_PORT" || die "SSH on port $FORGE_SSH_PORT never came back after the reboot"
echo "vm-test: verify after reboot"
verify false

echo "vm-test: PASS (exposure $EXPOSURE)"
