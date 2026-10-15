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
