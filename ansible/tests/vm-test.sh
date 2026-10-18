#!/bin/bash
# Throwaway-machine test of ansible/site.yml (agent-forge v2, sub-project 1).
#
# Provisions a fresh Ubuntu 26.04 machine twice with site.yml (the second run
# must change nothing), runs tests/verify.yml, reboots the machine, and
# verifies again. Three kinds of target:
#   - by default, a VM that this script creates, then deletes, on this LXD or
#     Incus host (it needs KVM). A v1 agent container cannot run this mode: it
#     has no access to the host's LXD and cannot run a VM;
#   - with --host, an existing fresh machine such as a cloud VM, reached over
#     SSH as a passwordless-sudo admin (ubuntu by default). Create it with the
#     cloud-init that --user-data prints, and rebuild it before every run: the
#     first run must start from a fresh image;
#   - with --lima, a throwaway Lima VM from ansible/lima/forge.yaml (local
#     mode), on a Mac or on a Linux machine with KVM. It gets its own name and
#     a free SSH port of its own, so a forge-local VM is never touched. Lima's
#     user is the admin; sshd stays on 22, which Lima forwards.
#
# Usage:
#   ansible/tests/vm-test.sh [--exposure public|lan|local] [--keep]
#   ansible/tests/vm-test.sh --host ADDRESS --admin-key PRIVATE_KEY [--admin USER]
#                            [--exposure public|lan|local] [--keep]
#   ansible/tests/vm-test.sh --lima [--exposure public|lan|local] [--keep]
#   ansible/tests/vm-test.sh --user-data PUBLIC_KEY
set -e
set -o pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPOSURE=""   # public by default, local with --lima (set after parsing)
KEEP=0
LIMA=0
HOST=""
ADMIN="ubuntu"
ADMIN_KEY=""
FORGE_SSH_PORT=2222   # moves sshd away from 22, so the port change is exercised

die() { echo "vm-test: $*" >&2; exit 1; }
USAGE="usage: $0 [--exposure public|lan|local] [--keep] [--host ADDRESS --admin-key PRIVATE_KEY [--admin USER] | --lima] | --user-data PUBLIC_KEY"

# The cloud-init that gives a fresh cloud VM its admin: a passwordless-sudo
# account (the playbook refuses to run as root) that only this key opens.
print_user_data() {
  [ -f "$1" ] || die "no such public key: $1"
  cat <<EOF
#cloud-config
users:
  - name: ubuntu
    groups: [sudo]
    shell: /bin/bash
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    lock_passwd: true
    ssh_authorized_keys:
      - $(cat "$1")
EOF
}

need_value() { if [ "$#" -lt 2 ] || [ -z "$2" ]; then die "$1 needs a value"; fi; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --exposure) need_value "$@"; EXPOSURE="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --lima) LIMA=1; shift ;;
    --host) need_value "$@"; HOST="$2"; shift 2 ;;
    --admin) need_value "$@"; ADMIN="$2"; shift 2 ;;
    --admin-key) need_value "$@"; ADMIN_KEY="$2"; shift 2 ;;
    --user-data) need_value "$@"; print_user_data "$2"; exit 0 ;;
    *) die "$USAGE" ;;
  esac
done
if [ "$LIMA" -eq 1 ] && [ -n "$HOST" ]; then
  die "--lima and --host are exclusive"
fi
if [ -z "$EXPOSURE" ]; then
  if [ "$LIMA" -eq 1 ]; then EXPOSURE="local"; else EXPOSURE="public"; fi
fi
# Lima forwards its local port to the guest's 22: sshd must stay there.
if [ "$LIMA" -eq 1 ]; then FORGE_SSH_PORT=22; fi
case "$EXPOSURE" in
  public|lan|local) ;;
  *) die "--exposure must be public, lan or local" ;;
esac
if [ -n "$HOST" ]; then
  [ -n "$ADMIN_KEY" ] || die "--host needs --admin-key (the private key the machine's admin accepts)"
  [ -f "$ADMIN_KEY" ] || die "no such private key: $ADMIN_KEY"
  # The new SSH port must get through the provider's firewall (a security
  # group, say) before provisioning moves sshd there and the host firewall
  # closes 22, or the machine is locked out. On a fresh machine nothing
  # listens there yet, so the connection must be refused; a timeout or no
  # route means the port is filtered. A login that works means the machine
  # was already provisioned.
  probe="$(ssh -F none -o BatchMode=yes -o ConnectTimeout=8 -o IdentitiesOnly=yes \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
    -i "$ADMIN_KEY" -p "$FORGE_SSH_PORT" "$ADMIN@$HOST" true 2>&1)" && probe_ok=1 || probe_ok=0
  if [ "$probe_ok" -eq 1 ]; then
    die "$HOST already answers SSH on port $FORGE_SSH_PORT: it was provisioned; rebuild it from a fresh Ubuntu 26.04 image"
  fi
  case "$probe" in
    *"Connection refused"*) ;;
    *) die "port $FORGE_SSH_PORT on $HOST is not reachable (${probe:-no answer}): open TCP 22 and $FORGE_SSH_PORT in the provider's firewall first, or provisioning will lock the machine out" ;;
  esac
fi

# --- Preconditions ---------------------------------------------------------
# The Lima checks come first: a machine without Lima gets this message even
# when Ansible is missing too.
if [ "$LIMA" -eq 1 ]; then
  command -v limactl >/dev/null 2>&1 || die "--lima needs limactl (Lima 2.1.2 or newer)"
  # Lima ships the ubuntu-26.04 base template (ansible/lima/forge.yaml) from
  # 2.1.2 on; older versions fail at create with an unclear message.
  read -r lima_major lima_minor lima_patch <<<"$(limactl --version \
    | sed -nE 's/.* ([0-9]+)\.([0-9]+)\.([0-9]+).*/\1 \2 \3/p')"
  if [ -z "$lima_patch" ] \
    || [ $((lima_major * 1000000 + lima_minor * 1000 + lima_patch)) -lt 2001002 ]; then
    die "--lima needs Lima 2.1.2 or newer ($(limactl --version))"
  fi
  command -v python3 >/dev/null 2>&1 || die "--lima needs python3 (it picks the VM's SSH port)"
  if [ "$(uname -s)" = "Linux" ] && [ ! -w /dev/kvm ]; then
    die "/dev/kvm is not writable: add yourself to the kvm group"
  fi
  CLI=limactl   # cleanup() deletes the VM with "$CLI" delete --force
elif [ -z "$HOST" ]; then
  if command -v incus >/dev/null 2>&1; then
    CLI=incus
    IMAGE="images:ubuntu/26.04/cloud"
  elif command -v lxc >/dev/null 2>&1; then
    CLI=lxc
    IMAGE="ubuntu:26.04"
  else
    die "needs lxc (LXD) or incus on this host, or --host to test an existing machine"
  fi
  [ -e /dev/kvm ] || die "/dev/kvm is missing: this host cannot run VMs (use --host)"
fi
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
VM=""
AGENT_PID=""
cleanup() {
  if [ -n "$AGENT_PID" ]; then kill "$AGENT_PID" 2>/dev/null || true; fi
  if [ -n "$HOST" ]; then
    echo "vm-test: $HOST is provisioned now: destroy or rebuild it before the next run"
  fi
  if [ "$KEEP" -eq 1 ]; then
    echo "vm-test: kept ${VM:+VM $VM and }$WORK"
  else
    if [ -n "$VM" ]; then "$CLI" delete --force "$VM" >/dev/null 2>&1 || true; fi
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

# The admin key: a throwaway one for a VM this script creates, a copy of the
# given one with --host, a copy of Lima's own key with --lima (copied once the
# VM exists: Lima creates its key on first use). It lives at $WORK/admin for
# verify.yml.
if [ -n "$HOST" ]; then
  cp "$ADMIN_KEY" "$WORK/admin"
  chmod 600 "$WORK/admin"
elif [ "$LIMA" -eq 0 ]; then
  ssh-keygen -q -t ed25519 -N "" -C "vm-test-admin" -f "$WORK/admin"
fi
ssh-keygen -q -t ed25519 -N "" -C "vm-test-forge" -f "$WORK/forge"
: > "$WORK/known_hosts"
# The forge key goes into a throwaway agent, so that verify.yml can check
# that agent forwarding reaches the forge user and is refused to the admin.
eval "$(ssh-agent -s)" >/dev/null
AGENT_PID="$SSH_AGENT_PID"
ssh-add -q "$WORK/forge"

export ANSIBLE_COLLECTIONS_PATH="$WORK/collections"
ansible-galaxy collection install -r "$REPO/ansible/requirements.yml" -p "$WORK/collections" >/dev/null

ssh_admin() {  # $1 = port, then the remote command; one fresh connection
  local port="$1"
  shift
  ssh -F none -o BatchMode=yes -o ConnectTimeout=5 -o IdentitiesOnly=yes \
    -o HostKeyAlgorithms=ssh-ed25519 \
    -o UserKnownHostsFile="$WORK/known_hosts" -o StrictHostKeyChecking=accept-new \
    -i "$WORK/admin" -p "$port" "$ADMIN@$IP" "$@"
}
wait_ssh() {  # $1 = port; succeeds once the admin can log in on it
  for _ in $(seq 60); do
    if ssh_admin "$1" true 2>/dev/null; then
      return 0
    fi
    sleep 5
  done
  return 1
}

# --- Machine ---------------------------------------------------------------
# SSH_PORT is where the controller reaches sshd: 22 until provisioning moves
# it (default and --host targets), Lima's forwarded port throughout (--lima).
SSH_PORT=22
if [ "$LIMA" -eq 1 ]; then
  VM="forge-host-test-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
  echo "vm-test: creating Lima VM $VM from ansible/lima/forge.yaml"
  # A free port, fixed for the VM's life: the developer's forge-local (60022)
  # is untouched, and the port survives the restart. Lima's own "0" would pick
  # a new port at every start, and known_hosts, keyed by port, would then
  # accept a changed host key silently.
  free_port="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
  limactl create --tty=false --name "$VM" --set ".ssh.localPort = $free_port" "$REPO/ansible/lima/forge.yaml"
  limactl start --tty=false "$VM"
  SSH_PORT="$(limactl list "$VM" --format '{{.SSHLocalPort}}')"
  [ "$SSH_PORT" = "$free_port" ] || die "$VM's SSH port is ${SSH_PORT:-unknown}, expected $free_port"
  ADMIN="$(limactl list "$VM" --format '{{.Config.User.Name}}' 2>/dev/null || true)"
  if ! printf '%s' "$ADMIN" | grep -Eq '^[a-z_][a-z0-9_.-]*$'; then
    ADMIN="$(limactl shell --workdir / "$VM" id -un)"
  fi
  cp "${LIMA_HOME:-$HOME/.lima}/_config/user" "$WORK/admin"
  chmod 600 "$WORK/admin"
  IP=127.0.0.1
  wait_ssh "$SSH_PORT" || die "SSH on port $SSH_PORT never let $ADMIN in"
  # cloud-init exits 2 for "done, with recoverable errors": accept 0 and 2.
  rc=0
  ssh_admin "$SSH_PORT" cloud-init status --wait >/dev/null || rc=$?
  [ "$rc" -eq 0 ] || [ "$rc" -eq 2 ] || die "cloud-init failed in $VM (exit $rc)"
elif [ -n "$HOST" ]; then
  IP="$HOST"
  wait_ssh 22 || die "SSH on $HOST port 22 never let $ADMIN in with the given key"
  if ssh_admin 22 test -e /opt/agent-forge; then
    die "$HOST was already provisioned: rebuild it from a fresh Ubuntu 26.04 image"
  fi
  # cloud-init exits 2 for "done, with recoverable errors": accept 0 and 2.
  rc=0
  ssh_admin 22 cloud-init status --wait >/dev/null || rc=$?
  [ "$rc" -eq 0 ] || [ "$rc" -eq 2 ] || die "cloud-init failed on $HOST (exit $rc)"
else
  VM="forge-host-test-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
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
  wait_ssh 22 || die "SSH on port 22 never answered"
fi

# --- Inventory -------------------------------------------------------------
# ansible_port is left out on purpose: site.yml must find the port itself.
# Lima is the exception: Ansible must use the forwarded port.
PORT_LINE=""
if [ "$LIMA" -eq 1 ]; then PORT_LINE="ansible_port: $SSH_PORT"; fi
cat > "$WORK/inventory.yml" <<EOF
all:
  hosts:
    vm:
      ansible_host: "$IP"
      ansible_user: "$ADMIN"
      $PORT_LINE
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

# The admin must still log in on a fresh connection: a reused, multiplexed
# one would hide a lockout (devsec once gave a UID-501 admin a nologin shell).
admin_still_logs_in() {  # $1 = first|second
  ssh_admin "$SSH_PORT" true \
    || die "the admin cannot log in on a fresh connection after the $1 run"
}

echo "vm-test: first run"
playbook "$REPO/ansible/site.yml"
# sshd has moved to forge_ssh_port (Lima: it stays behind the forwarded port).
if [ "$LIMA" -eq 0 ]; then SSH_PORT="$FORGE_SSH_PORT"; fi
admin_still_logs_in first

echo "vm-test: second run (must change nothing; only changed tasks are shown)"
ANSIBLE_DISPLAY_OK_HOSTS=false ANSIBLE_DISPLAY_SKIPPED_HOSTS=false \
  playbook "$REPO/ansible/site.yml" | tee "$WORK/second-run.log"
grep -Eq '^vm +: .*changed=0 .*failed=0' "$WORK/second-run.log" \
  || die "the second run changed something (see the tasks above)"
admin_still_logs_in second

# devsec must not have regenerated the host key: the key sshd showed on 22
# before provisioning is the one it shows on the new port. OpenSSH accepts a
# key recorded for the bare host on any port and then records nothing for
# "[host]:port", so the new port's key is read through an empty known_hosts.
# Under Lima the port never moves: the single known_hosts entry already
# enforces the key on every connection.
key_on() {  # $1 = host entry, $2 = known_hosts file
  ssh-keygen -F "$1" -f "$2" | grep -v '^#' | awk '{print $3}' | head -1
}
if [ "$LIMA" -eq 0 ]; then
: > "$WORK/known_hosts.new-port"
ssh -F none -o BatchMode=yes -o ConnectTimeout=10 -o IdentitiesOnly=yes \
  -o HostKeyAlgorithms=ssh-ed25519 \
  -o UserKnownHostsFile="$WORK/known_hosts.new-port" -o StrictHostKeyChecking=accept-new \
  -i "$WORK/admin" -p "$FORGE_SSH_PORT" "$ADMIN@$IP" true \
  || die "cannot log in on port $FORGE_SSH_PORT to read the host key"
k22="$(key_on "$IP" "$WORK/known_hosts" || true)"
knew="$(key_on "[$IP]:$FORGE_SSH_PORT" "$WORK/known_hosts.new-port" || true)"
[ -n "$k22" ] || die "no host key was recorded for $IP on port 22"
[ "$k22" = "$knew" ] || die "the host key changed during provisioning"
fi

verify() {  # $1 = true|false: run the deliberate authentication failures
  playbook "$REPO/ansible/tests/verify.yml" \
    -e "ansible_port=$SSH_PORT" -e "verify_ssh_port=$SSH_PORT" \
    -e "verify_work=$WORK" -e "verify_negative_auth=$1"
}
echo "vm-test: verify"
verify true

echo "vm-test: reboot"
if [ "$LIMA" -eq 1 ]; then
  # A new cloud-init instance id at every Lima boot used to regenerate the
  # host keys: the port stays the same, so known_hosts makes that fail here.
  limactl stop "$VM"
  limactl start --tty=false "$VM"
  if ! wait_ssh "$SSH_PORT"; then
    ssh_admin "$SSH_PORT" true || true   # once more, with ssh's own error shown
    die "SSH on port $SSH_PORT failed after the restart (ssh's error is above)"
  fi
elif [ -n "$HOST" ]; then
  # The connection drops as the machine goes down; give it time to stop
  # answering before waiting for it to come back.
  ssh_admin "$SSH_PORT" sudo systemctl reboot || true
  sleep 20
else
  "$CLI" restart "$VM" --timeout 120 || "$CLI" restart --force "$VM"
fi
wait_ssh "$SSH_PORT" || die "SSH on port $SSH_PORT never came back after the reboot"
echo "vm-test: verify after reboot"
verify false

if [ "$LIMA" -eq 1 ]; then
  echo "vm-test: PASS (exposure $EXPOSURE, lima)"
else
  echo "vm-test: PASS (exposure $EXPOSURE)"
fi
