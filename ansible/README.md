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
  `forge_ssh_port`. Later runs connect there directly.
- **sudo password.** Ubuntu 26.04's sudo is sudo-rs. A passwordless sudo admin
  needs nothing. With a password (`-K`, or `ansible_become_password` in an
  ansible-vault file), Ansible's become times out until ansible-core 2.22
  (ansible/ansible#85837). Set `ansible_become_exe: sudo.ws` to use the C sudo
  that 26.04 still ships. The host's own `sudo` stays sudo-rs.
- **Several keys in your agent.** sshd allows two authentication attempts. Give
  the host an `IdentityFile` and `IdentitiesOnly yes` in `~/.ssh/config`, and
  `ansible_ssh_common_args: -o IdentitiesOnly=yes` in the inventory.

## Tests

```bash
npm run test:ansible     # controller-only unit tests, no target machine
ansible-lint ansible/    # profile production (.ansible-lint)
```

## VM test

`tests/vm-test.sh` creates a throwaway VM on an LXD or Incus host with KVM, and
provisions it with this playbook. omen is that host today. The script checks
that a second run changes nothing, runs `tests/verify.yml`, reboots the VM,
verifies again, and deletes the VM. Run it on omen, from a clone of `next` kept
apart from the v1 clone:

```bash
git clone git@github.com:moroine/agent-forge.git ~/src/agent-forge-next   # once
git -C ~/src/agent-forge-next fetch origin
git -C ~/src/agent-forge-next checkout --detach origin/<branch>
~/src/agent-forge-next/ansible/tests/vm-test.sh                    # --exposure public (default)
~/src/agent-forge-next/ansible/tests/vm-test.sh --exposure local   # fail2ban off
```

It needs ansible-core 2.20 or newer (`pipx install ansible-core` on Ubuntu
24.04). `--keep` leaves the VM and its keys in place for debugging. The script
prints where they are.

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
- **sshd.**
  - The port is `forge_ssh_port`, and `AllowUsers` lists the admin and the
    forge user.
  - Agent forwarding is allowed for the forge user only, and
    `AllowStreamLocalForwarding no`.
  - The ed25519 host key is the only host key.
