# Host playbook

`site.yml` provisions an agent-forge host: a fresh Ubuntu 26.04 machine, VM or
bare metal. It hardens the OS (devsec.hardening), installs a native nftables
firewall, fail2ban, and Incus 7.0 LTS with a btrfs storage pool. It also sets
up one forge user with Node 24, Claude Code, Ansible and `forge`. Everything
inside Incus (project, bridge, profiles, image) is `forge setup`'s job. Design:
`docs/superpowers/specs/2026-10-15-v2-host-ansible-design.md`.

## Running it

On the controller (your machine), from a git checkout of this repository.
`forge` is deployed from the checkout's HEAD.

```bash
ansible-galaxy collection install -r ansible/requirements.yml
cp ansible/inventory.example.yml ~/forge-inventory.yml   # then edit it
ansible-playbook -i ~/forge-inventory.yml ansible/site.yml
```

- **Requirements.** The controller needs ansible-core 2.20 or newer and git.
- **Account.** Ansible connects as the machine's existing sudo account
  (`ansible_user`), never as root.
- **Port.** The first run connects on port 22 and moves sshd to
  `forge_ssh_port`. Later runs connect there directly: preflight tries an
  authenticated login on `forge_ssh_port` and falls back to 22. To change
  `forge_ssh_port` on a provisioned host, run once with `-e ansible_port=<old
  port>`: sshd listens on neither the new port nor 22 yet.
- **Interface.** The firewall accepts SSH on the external interface only (the
  default route's, or `forge_external_interface`). Preflight stops if
  Ansible's own session arrives on another interface, such as a VPN or a
  second LAN card, because the next run would be locked out.
- **fail2ban counts your mistakes too.** With `public`, three failed logins
  within an hour (a wrong key, a wrong user) ban the address for a day, the
  controller's included. Put your own fixed address in
  `forge_fail2ban_ignoreip` if you have one.
- **sudo password.** Ubuntu 26.04's sudo is sudo-rs. A passwordless sudo admin
  needs nothing. With a password (`-K`, or `ansible_become_password` in an
  ansible-vault file), Ansible's become times out until ansible-core 2.22
  (ansible/ansible#85837). Set `ansible_become_exe: sudo.ws` to use the C sudo
  that 26.04 still ships. The host's own `sudo` stays sudo-rs.
- **Several keys in your agent.** sshd allows two authentication attempts. Give
  the host an `IdentityFile` and `IdentitiesOnly yes` in `~/.ssh/config`, and
  `ansible_ssh_common_args: -o IdentitiesOnly=yes` in the inventory.

### On a local Lima VM

Local mode is the same playbook on a Lima VM, on a Mac or a Linux machine:

- `lima/forge.yaml` is the VM's template. It runs in Lima's plain mode, which
  means no shared folder and no port forwarding besides SSH. SSH goes over TCP
  on `127.0.0.1:60022`.
- `inventory.lima.example.yml` is the matching inventory:
  - Lima's own user (your login name) is the admin, opened by
    `~/.lima/_config/user`;
  - the forge user is `forge`;
  - `forge_exposure` is `local`;
  - sshd stays on 22, the port Lima forwards to.

The main README's "Quick start: local" walks through the whole setup.

## Tests

```bash
npm run test:ansible     # controller-only unit tests, no target machine
ansible-lint ansible/    # profile production (.ansible-lint)
```

## VM test

`tests/vm-test.sh` provisions a fresh Ubuntu 26.04 machine with this playbook,
checks that a second run changes nothing, runs `tests/verify.yml`, reboots the
machine and verifies again. It needs ansible-core 2.20 or newer
(`pipx install ansible-core` on Ubuntu 24.04). `--exposure public|lan|local`
picks the exposure (default `public`, `local` with `--lima`); `--keep`
leaves its temporary files (and the VM) in place for debugging.

After each of the two runs, the admin must still log in on a fresh SSH
connection. A reused, multiplexed connection would hide a lockout.

### On a cloud VM (`--host`)

The script runs on your machine and targets an existing, fresh VM. Most cloud
VMs cannot run VMs themselves, so this is the usual way.

1. Make a test key, used only for this:

   ```bash
   ssh-keygen -t ed25519 -N "" -f ~/.ssh/forge-host-test
   ```

2. Print the cloud-init that gives the VM a passwordless-sudo `ubuntu` admin
   with that key (the playbook refuses to run as root):

   ```bash
   ansible/tests/vm-test.sh --user-data ~/.ssh/forge-host-test.pub > user-data.yml
   ```

3. Create an Ubuntu 26.04 VM with that user data: at least 2 vCPU, 4 GB of
   memory and a 40 GB disk. Leave the provider's firewall off, or open ports
   22 and 2222: sshd moves to 2222.
4. Run the test against it:

   ```bash
   ansible/tests/vm-test.sh --host 203.0.113.10 --admin-key ~/.ssh/forge-host-test
   ```

The VM is provisioned afterwards. Rebuild it from a fresh image before the next
run (the script refuses a machine it already provisioned), and destroy it when
you are done.

### On an LXD or Incus host with KVM

Without `--host`, the script creates a throwaway VM on the LXD or Incus host it
runs on, and deletes it at the end:

```bash
ansible/tests/vm-test.sh                    # --exposure public (default)
ansible/tests/vm-test.sh --exposure local   # fail2ban off
```

### On a Lima VM (`--lima`)

With `--lima`, the script tests local mode. It creates a throwaway Lima VM
from `lima/forge.yaml`, with its own name and a free SSH port of its own, so your
`forge-local` VM is never touched. It provisions it with `--exposure local`
and restarts it with `limactl stop` / `limactl start`. The host key must
survive the restart. The script deletes the VM at the end.

```bash
ansible/tests/vm-test.sh --lima
```

It needs Lima 2.0 or newer and about 6 GiB of free disk while it runs. On
Linux, it also needs QEMU and a writable `/dev/kvm`: be in the `kvm` group.

## Hardening choices

`roles/hardening` applies devsec.hardening 11.0.0 (`os_hardening`,
`ssh_hardening`). Every upstream default is kept, except these:

- **Sysctls.**
  - `net.ipv4.ip_forward=1`, for the Incus bridge.
  - `kernel.unprivileged_userns_clone=1` and
    `kernel.apparmor_restrict_unprivileged_userns=0`, for user namespaces
    inside containers (Chrome's sandbox, rootless Docker).
  - `kernel.yama.ptrace_scope=1`, Ubuntu's default, so strace and gdb work in
    containers.
- **UFW.** `ufw_manage_defaults: false`, since nftables is used instead.
- **Password ageing.** The admin is exempt
  (`os_users_without_password_ageing`): the playbook never changes the
  admin's sudo, and devsec would otherwise expire its password after 60 days.
- **System accounts.** devsec gives every account below UID 1000 a `nologin`
  shell. A Lima VM's admin has your Mac's UID (501), so it would be locked out,
  Ansible included. The admin is therefore in `os_ignore_users`, next to
  devsec's own `vagrant` and `kitchen`.
- **Host keys and cloud-init.** `roles/base` installs
  `/etc/cloud/cloud.cfg.d/99-agent-forge-keep-host-keys.cfg`
  (`ssh_deletekeys: false`). Lima gives cloud-init a new instance id at every
  boot, and cloud-init would then regenerate the SSH host keys: clients would
  refuse the host after each restart. A stable instance id, as on a cloud VM,
  makes this a no-op.
- **sshd.**
  - The port is `forge_ssh_port`, and `AllowUsers` lists the admin and the
    forge user.
  - Agent forwarding is allowed for the forge user only, and
    `AllowStreamLocalForwarding no`.
  - The ed25519 host key is the only host key.

## Incus storage pool

The playbook creates the btrfs pool `default` once. It uses a loop file of
about 80 % of the free space, or `forge_incus_storage_size`, or the device
`forge_incus_storage_source`. It never changes the pool afterwards. To grow a
loop-file pool later, run on the host:

```bash
sudo incus storage set default size=200GiB
```

A loop file can grow, never shrink. Per-container disk sizes are a guard rail,
not a hard limit: an agent can escape btrfs quotas with nested subvolumes. The
pool's size is the hard ceiling.

## sudo-rs and Rust coreutils

The playbook is tested against Ubuntu 26.04 as shipped: `sudo` is sudo-rs and
the coreutils are uutils. It never switches them. If one of them breaks
something on your host, you can switch back by hand:

```bash
sudo update-alternatives --set sudo /usr/bin/sudo.ws   # C sudo
sudo apt install coreutils-from-gnu                     # GNU coreutils
```

For Ansible's own become with a sudo password, `ansible_become_exe: sudo.ws`
in the inventory is enough (see "Running it").
