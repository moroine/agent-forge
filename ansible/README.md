# Host playbook

`site.yml` provisions an agent-forge host: a fresh Ubuntu 26.04 machine, VM or
bare metal. It hardens the OS (devsec.hardening), installs a native nftables
firewall, fail2ban, and Incus 7.0 LTS with a btrfs storage pool. It also sets
up one forge user with Node 24, Claude Code, Ansible and `forge`. On a machine
that already has Ubuntu's Node, it replaces it with NodeSource's Node 24,
which removes Ubuntu's `npm` and the packages that depend on it (NodeSource's
`nodejs` ships its own `npm`). Everything inside Incus (project, bridge,
profiles, image) is `forge setup`'s job. Design:
`docs/superpowers/specs/2026-10-15-v2-host-ansible-design.md`.

The forge user also gets a systemd user service, `forge-api.service` (`forge api
serve`, the API the team containers call, see the main README), with lingering
on so that it runs without a login and after a reboot. A new release restarts
it, and so does `forge team converge`: the unit is the forge user's, not
root's, for that reason.

## Running it

On the controller (your machine), from a git checkout of this repository.
`forge` is deployed from the checkout's HEAD.

```bash
ansible-galaxy collection install -r ansible/requirements.yml
cp ansible/inventory.example.yml ~/forge-inventory.yml   # then edit it
ANSIBLE_PIPELINING=True ansible-playbook -i ~/forge-inventory.yml ansible/site.yml
```

`ANSIBLE_PIPELINING=True` is optional and makes the run much faster on a remote host
(one SSH session per task); `forge install` sets it.

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

The main README's "Quick start: local" runs the whole setup with
`forge install`; the next section is the same setup by hand.

## Installing by hand

`forge install` (see the main README) does everything below. Do it by hand to
run the playbook yourself: other options, a machine forge does not manage, or
to see what `forge install` runs.

### A local Lima VM

```bash
git clone https://github.com/moroine/agent-forge.git
cd agent-forge
limactl create --tty=false --name forge-local ansible/lima/forge.yaml
limactl start forge-local
```

`--tty=false` skips `limactl create`'s question (proceed, edit the
configuration, or pick another template): the template is meant to be used as
is. If port 60022 is taken, create the VM with another one, then use that port
as `ansible_port` in the inventory and as `Port` in the SSH block below:

```bash
limactl create --tty=false --name forge-local --set '.ssh.localPort = 60122' ansible/lima/forge.yaml
```

Copy the matching inventory and edit it:

```bash
cp ansible/inventory.lima.example.yml ~/forge-local-inventory.yml
```

- `ansible_user`: your login name on this machine (`whoami`); Lima created
  that account in the VM;
- `ssh_keys`: the public key you use for GitHub (`ssh-add -L`).

### A remote VM

Create an Ubuntu 26.04 VM (at least 2 vCPU, 4 GB of memory, a 40 GB disk) with
an admin account your key can log in to, and let SSH (port 22) through the
provider's firewall. Copy `inventory.example.yml` outside the repository and
set:

- the VM's address, and the admin account as `ansible_user`;
- `forge_exposure: public` for a cloud VM, `lan` for a machine on your
  network;
- your forge user: a name of your choice and your GitHub public key.

An admin account with a sudo password is a manual inventory edit: set
`ansible_become_exe: sudo.ws` and the password in an ansible-vault file (see
"sudo password" above and the comments in `inventory.example.yml`).
`forge install --remote` assumes passwordless sudo.

### Run the playbook

From the checkout (it deploys `forge` from its HEAD). For a remote VM, pass
your copy of `inventory.example.yml` to `-i` instead:

```bash
ansible-galaxy collection install -r ansible/requirements.yml
ANSIBLE_PIPELINING=True ansible-playbook -i ~/forge-local-inventory.yml ansible/site.yml
```

A second run must report `changed=0`.

### Reach the host over SSH

Add this to `~/.ssh/config`, for a local VM:

```
Host forge-local
  HostName 127.0.0.1
  Port 60022
  User forge
  HostKeyAlias forge-local
  ForwardAgent yes
```

and for a remote one (the port stays 22 unless you set `forge_ssh_port`):

```
Host forge-vm
  HostName 203.0.113.10
  User alice
  ForwardAgent yes
```

`forge` (or your forge user) is the account the playbook created.
`ForwardAgent yes` lets the host clone your repositories with your key.
OpenSSH forwards the agent it uses for that host, the one named by
`IdentityAgent` (or `SSH_AUTH_SOCK`): if your GitHub key lives in another agent
(a hardware key's, a password manager's), set `IdentityAgent` to it in the
block.

A file of yours in `~/.ssh/config.d/` works too, but OpenSSH reads that
directory only through an `Include` that applies to every host: at the top of
`~/.ssh/config`, before any `Host` or `Match` line, or under `Match all` or
`Host *`. Settings placed before that `Include` (in a `Host *` above it, say)
win over the block, since ssh keeps the first value it reads: `ssh -G
forge-local` shows what is in effect.

`forge install` writes the same blocks to its own file,
`~/.ssh/config.d/agent-forge.config`, with `UserKnownHostsFile`,
`IdentityFile` and `IdentitiesOnly` added (and, for `forge-local`,
`StrictHostKeyChecking accept-new`). It adds
`Include config.d/agent-forge.config` at the top of `~/.ssh/config` when no
`Include` there reads that file. When one does, forge checks with `ssh -G`
that its values are in effect, and offers the top-of-file `Include` when a
setting of yours wins. Leave that file name to forge: it rewrites the file on
every run.

### Log in and build the image

```bash
ssh forge-local                        # accept the host key once
# the Claude token: run `claude setup-token` on your machine, paste what it prints
mkdir -p ~/.config/agent-forge
(umask 077; cat > ~/.config/agent-forge/claude-token)   # paste, Enter, Ctrl-D
git config --global user.name "Alice Example"
git config --global user.email "alice@example.com"
forge setup
forge image build                      # about 10 minutes
exit
```

Then `herdr --remote forge-local --remote-keybindings server` (for a remote
host, your alias: `herdr --remote forge-vm --remote-keybindings server`).

Declare a team in `~/.config/agent-forge/config.json` on the host and run
`forge team converge` there (README, step 3). To see its agents in Herdr App
without `forge team up`, add each container yourself, on your machine, with
your `hc` at the version forge pins:
`hc machine add --name <alias>-<container without agent-> --via '<path to forge> hc-via <alias> <container>'`.

### Fetch the agents' branches by hand

`forge fetch` (README, "Get the work back") does this for you. By hand, in
your clone of the repository, with your SSH alias in place of `forge-local`:

```bash
git remote add forge-web forge-local:team-web
git config remote.forge-web.uploadpack "forge team upload-pack web"
git config remote.forge-web.tagOpt --no-tags
git config remote.forge-web.pruneTags false
git fetch forge-web
```

(`web` is the team's name in the host's configuration.) `forge team
upload-pack` runs on the host: it refreshes the team mirror, a repository of
the host's own that holds the branches the developers own, and serves it, so
the host never runs git in an agent's workspace. `tagOpt` and `pruneTags` keep
the agent's tags out of your clone, even with `fetch.pruneTags` in your git
configuration: a tag named `origin/main` would take that branch's place in
`git log origin/main..` and other git commands. Review the branch, then sign
and push it yourself.

### Troubleshooting a manual install

- **`REMOTE HOST IDENTIFICATION HAS CHANGED`** after recreating the VM:
  `ssh-keygen -R forge-local` (and `ssh-keygen -R forge-local-admin` for
  Ansible).
- **`Too many authentication failures`** from `ssh forge-local` or
  `ssh forge-vm`: sshd allows two attempts, which an agent holding several
  keys uses up. Add `IdentityFile ~/.ssh/<your key>.pub` and
  `IdentitiesOnly yes` to the Host block.

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

It needs Lima 2.1.2 or newer and about 6 GiB of free disk while it runs. On
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
- **GitHub's host keys.** The play fetches them from GitHub's API on the
  controller and writes them into the forge user's `~/.ssh/known_hosts`,
  replacing older `github.com` entries, so the first clone never asks to trust
  a key. A failed fetch stops the run.

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
