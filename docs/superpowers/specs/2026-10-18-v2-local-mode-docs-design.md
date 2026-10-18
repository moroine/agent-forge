# agent-forge v2, sub-project 5: Local mode and docs — Design

**Date:** 2026-10-18
**Status:** Approved in brainstorming, pending user review of this document
**Branch:** `next` (stacked pull requests, see "Delivery")
**Framing spec:** `docs/superpowers/specs/2026-10-15-v2-incus-ansible-herdr-design.md`
(sections "Local mode (sub-project 5)" and "Repository layout")

## Context

Sub-projects 1 to 4 give v2 a hardened host provisioned by Ansible
(`ansible/site.yml`), a runtime built by `forge setup` and `forge image build`,
an egress allowlist (strict mode), and herdr orchestration. All of them assume
a host VM that the developer reaches over SSH. The README still describes v1:
LXD, `./scripts/forge`, a hand-configured server, the maintainer's own paths,
host name and LAN address.

Sub-project 5 makes v2 usable and shareable:

- a **local mode**, for developers with no VM to spare;
- a **README rewritten per mode**;
- **no personal value left** anywhere in the repository;
- the repo's **`CLAUDE.md`** brought up to date for v2, its Git section
  included.

### Who it is for

The first readers are the developers of the maintainer's team. They use
**Apple Silicon Macs** and **Ubuntu 24.04** machines, which usually have
Docker installed. Within their first hour they must have agent-forge running
locally and an agent started from herdr with `prefix+f`. Remote mode (a cloud
VM, a LAN machine) stays documented, as the second path.

## Goals

- One local mode, the same on macOS and Ubuntu, reachable within an hour by
  following the README.
- The README documents what sub-projects 1 to 4 ship, per mode.
- Nothing personal in the repository: no maintainer name, home path, host name,
  LAN address or bot identity, in code, tests, docs or design history.
- The repo's `CLAUDE.md` describes v2 accurately.

## Non-goals

- A setup script. The local VM, its inventory and the SSH configuration are
  **manual README steps**, by decision.
- Linux local mode directly on the developer's machine (see "Decisions").
- Rewriting git history to remove personal values from past commits.
- Intel Macs, Windows, other Linux distributions: not tested, not documented as
  supported. Nothing in the design excludes them.

## Anti-goals

- A local mode that weakens the developer's machine (host sysctls, an
  `incus-admin` root-equivalent account on the laptop, Docker/Incus firewall
  conflicts).
- Anything of the developer's machine stored in the local VM: no shared
  folder, no SSH key, no forwarded agent outside the forge user's own SSH
  sessions. (Network reachability is a separate, accepted limit: see
  "Security: what the local VM can reach".)
- A README that promises a path nobody has run.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Local mode | **A Lima VM on both macOS and Ubuntu**, provisioned by `ansible/site.yml` with `forge_exposure: local`, then used exactly like a remote host | A real VM boundary on every OS; nothing to change on the developer's machine; one path to document and test. Lima runs on Linux through QEMU/KVM |
| Linux directly on the dev machine | **Removed from the docs.** The code keeps working (`forge setup`'s host contract still prints local-Linux fixes) | It needs Incus, a root-equivalent group, a host-wide userns sysctl and a Docker workaround on the laptop |
| Setup | Manual README steps, helped by two files in the repo: a Lima template and an example inventory | Decided by the maintainer |
| Lima networking | Lima's default user-mode network; no vzNAT; SSH over the forwarded TCP port (`ssh.overVsock: false`) | Works the same on vz (Mac) and QEMU (Linux). The VM is only reached through `127.0.0.1:<port>`. Spike finding A does not apply, because the playbook creates no network and `forge setup` gives `forgebr0` an explicit address (validated, see "Lima validation") |
| SSH port | `forge_ssh_port` stays at its default, **22**, in every mode; the README suggests no other port | Decided by the maintainer. Lima forwards its local port to the guest's port 22 |
| Language | README in English, as today | Open source audience |
| Personal values | Removed everywhere, `docs/superpowers` included | Decided by the maintainer |
| Ubuntu validation | The maintainer runs the Lima test on their own Ubuntu 24.04 server (amd64, KVM) | No Ubuntu machine with KVM is available to the implementer |
| macOS walk-through | The maintainer follows the README's local quick start end to end on their Mac (real repository, YubiKey, Claude account, herdr) before the docs PR; that PR waits for it | The first-hour path must have been run, and only the maintainer can run its credentialed steps |
| The local VM reaching the developer's machine | **Accepted and documented**, to be improved later | Decided by the maintainer: see "Security: what the local VM can reach" |

This reverses the framing spec's "Linux: directly on the dev machine" (see
"Changes to the framing spec").

## Local mode

### What the developer installs

| | macOS (Apple Silicon) | Ubuntu 24.04 |
|---|---|---|
| Lima ≥ 2.0 | `brew install lima` | release archive from GitHub into `/usr/local`, plus `qemu-system-x86`, `qemu-utils`, and the user in group `kvm` (`/dev/kvm` must exist) |
| ansible-core ≥ 2.20 | `brew install ansible` | `pipx install ansible-core` (24.04's apt ships 2.16) |
| herdr | `brew install herdr` | release binary |
| git, an SSH key GitHub accepts, loaded in the agent that ssh uses by default | — | — |

Exact package names, the Lima release URL pattern and the herdr install
command are checked by the implementer at writing time.

### Lima template: `ansible/lima/forge.yaml`

```yaml
minimumLimaVersion: 2.0.0
base:
- template:_images/ubuntu-26.04
plain: true
cpus: 4
memory: 6GiB
disk: 60GiB
ssh:
  localPort: 60022
  overVsock: false
```

- **`plain: true`** turns off Lima's mounts (by default Lima mounts the
  developer's home read-only into the VM), its automatic port forwarding, its
  containerd and its guest agent. An agent that escapes its container lands in
  a VM that stores nothing of the developer's machine. Workspaces stay inside
  the VM, as the framing spec decided. (The VM can still reach the
  developer's machine over the network: see "Security: what the local VM can
  reach".)
- **`ssh.overVsock: false`.** On vz, Lima defaults to SSH over vsock. sshd then
  sees no client address (`SSH_CONNECTION=UNKNOWN …`), and the playbook's
  preflight refuses to run, because it cannot tell which interface SSH arrives
  on. Over the forwarded TCP port, SSH arrives on `eth0` from Lima's gateway,
  as on a QEMU host.
- **`ssh.localPort: 60022`**, fixed, so that the README's inventory and SSH
  config can be copied as they are. The README says how to pick another port.
- **Sizes.** The values were validated on a 16 GiB Mac. The disk is sparse:
  after `forge image build` it used about 11 GiB on the Mac. The playbook's
  pool takes about 80 % of the VM's free space, which clears its 20 GiB floor.
  The README says how to give the VM more memory or CPUs (`limactl edit`).
- The architecture follows the developer's machine: arm64 on Apple Silicon,
  amd64 on Ubuntu. Lima picks vz on macOS and QEMU on Linux by itself.
- Each comment in the file explains its setting.

The README's commands:

```bash
limactl create --name forge-local ansible/lima/forge.yaml
limactl start forge-local
```

### Inventory: `ansible/inventory.lima.example.yml`

The same variables as `inventory.example.yml`, filled in for Lima:

```yaml
all:
  hosts:
    forge-local:
      ansible_host: 127.0.0.1
      ansible_port: 60022                         # ssh.localPort in ansible/lima/forge.yaml
      ansible_user: YOUR_LOGIN                    # Lima's user is your login name on this machine
      ansible_ssh_private_key_file: ~/.lima/_config/user
      ansible_ssh_common_args: -o IdentitiesOnly=yes -o HostKeyAlias=forge-local-admin
  vars:
    forge_exposure: local
    forge_users:
      - name: forge                               # must differ from ansible_user
        ssh_keys:
          - "ssh-ed25519 AAAA... you@laptop"      # your public key: ssh-add -L
```

- **Admin:** Lima's own user (the developer's login name, passwordless sudo),
  reached with Lima's key `~/.lima/_config/user`.
- **Forge user:** `forge`. It cannot be the developer's login name, because
  that name is already the admin's, and preflight requires two accounts.
- **Host key checking.** The example keeps it on. `HostKeyAlias` stops the VM's
  key from colliding with other `127.0.0.1` entries in `known_hosts`. The exact
  option set is the implementer's call, tested by `vm-test.sh --lima`.
- The file says to copy it outside the repository, as `inventory.example.yml`
  does.

### SSH config on the developer's machine

The README gives this block to add to `~/.ssh/config`:

```
Host forge-local
  HostName 127.0.0.1
  Port 60022
  User forge
  HostKeyAlias forge-local
  ForwardAgent yes
```

- `herdr --remote forge-local --remote-keybindings server` and the retrieval
  remote (`forge-local:<container>`, sub-project 4) both use this alias.
- **Agent forwarding gotcha** (validation spike, finding F): OpenSSH forwards
  the agent it uses by default for that host (`IdentityAgent`). The agent that
  holds the developer's GitHub key, a YubiKey's for example, must be that one.
- Remote mode uses the same block shape, with the VM's address and the forge
  user's name. With port 22 there is no `Port` line.

### Then, as in remote mode

```bash
ansible-galaxy collection install -r ansible/requirements.yml
ansible-playbook -i ~/forge-inventory.yml ansible/site.yml
ssh forge-local            # claude auth login; git config --global user.name/user.email;
                           # forge setup; forge image build
herdr --remote forge-local --remote-keybindings server   # then prefix+f
```

The README orders these steps as sub-project 4's note asks: Ansible, then
`forge setup`, then `forge image build`, then the first `herdr --remote`, in a
real terminal (its install prompt is interactive).

### Lifecycle

The README covers, for the local VM:

- `limactl stop forge-local` / `limactl start forge-local`. Agents stop with
  the VM. After a start, `prefix+shift+f` brings them back (sub-project 4).
- Updating agent-forge: `git pull` in the checkout, re-run the playbook (it
  deploys `forge` from HEAD), `forge setup`, and `forge image build` when the
  image changed.
- Starting over: `limactl delete forge-local`, then `ssh-keygen -R` for the
  `forge-local` and `forge-local-admin` aliases. The workspaces live in the VM
  and are deleted with it, so the README says to fetch every branch first.

### Security: what the local VM can reach

In Lima's user-mode network the gateway, `192.168.5.2`, leads to the
developer's machine's loopback, and the VM reaches the developer's LAN through
the machine's NAT. Containers cannot reach either: the `forge-egress` ACL
rejects private ranges, which the Lima validation checked. The VM itself can,
and the host firewall has no output chain.

- **Consequence:** an agent that escapes its container into the VM can reach
  services listening on the developer's localhost (development servers,
  databases) and on their LAN (router, NAS).
- **Decision:** accepted for v2.0 and documented in the README's security
  model, as a local-mode row. An output chain for `forge_exposure: local`
  (drop new connections to the gateway and to private ranges, except Lima's DNS
  at `192.168.5.3`) is the likely improvement, deferred. It would stop a
  non-root escape only, since root in the VM can remove it.

## Host fixes found by the Lima validation

Three changes to sub-project 1's playbook. They are not Lima workarounds: each
fixes a latent bug that Lima exposed.

1. **devsec locks out an admin whose UID is below 1000.** `os_hardening` treats
   every account with a UID up to `SYS_UID_MAX` as a system account, and sets
   its shell to `/usr/sbin/nologin`. Lima's user has the developer's UID (501
   on a Mac). After the first run, the admin could no longer log in ("This
   account is currently not available"), and neither could Ansible.
   - **Fix:** the `hardening` role passes `os_ignore_users` = devsec's default
     (`vagrant`, `kitchen`) plus the admin, next to the existing
     `os_users_without_password_ageing` exemption.
   - **Unit test:** the rendered list contains the admin.
   - Why the second run did not catch it: it still reported `changed=0`,
     because Ansible's multiplexed connection predated the change. `verify.yml`,
     on fresh connections, did catch it.
2. **The SSH host keys must survive a new cloud-init instance id.** Lima gives
   cloud-init a new instance id at every start. cloud-init then deletes and
   regenerates the host keys, and `ssh forge-local` and `herdr --remote` fail
   on "REMOTE HOST IDENTIFICATION HAS CHANGED" after each restart.
   - **Fix:** the playbook installs a cloud-init drop-in with
     `ssh_deletekeys: false`, for every exposure. A stable instance id, as on a
     cloud VM, never triggers it, so this costs nothing there.
   - cloud-init itself cannot be disabled, because Lima runs its boot scripts
     through it.
   - The drop-in's role (`base` or `hardening`) is the implementer's call.
   - **Verification:** the host key is unchanged after the test's reboot.
3. **`verify.yml` needs the controller-side SSH port.** Its SSH checks connect
   to `ansible_host` on `forge_ssh_port`. Under Lima, the controller reaches
   the VM on `127.0.0.1:60022` while sshd listens on 22.
   - **Fix:** a `verify_ssh_port` variable, defaulting to `forge_ssh_port`,
     used only by the controller-side checks.
   - `vm-test.sh` sets it in Lima mode.

## Testing the local mode

### `ansible/tests/vm-test.sh --lima`

A third target for the existing script, next to the default (a VM on an
LXD/Incus host) and `--host`. Run on a Mac or on an Ubuntu machine with KVM.

1. **Preconditions:**
   - `limactl` ≥ 2.0 is present;
   - on Linux, `/dev/kvm` is writable;
   - the usual Ansible checks apply.
2. **VM.** A throwaway VM, `forge-host-test-<random>`, from
   `ansible/lima/forge.yaml`:
   - with an automatic SSH port (`--set '.ssh.localPort = 0'`), so that it
     never collides with the developer's own `forge-local`;
   - its port and user are read back from `limactl list --json`.
3. **Inventory**, generated:
   - the Lima admin and key, `ansible_port` set to the Lima port;
   - forge user `forgetest`;
   - `forge_exposure` from `--exposure` (default `local` in this mode);
   - `forge_ssh_port` left at 22.
4. **Runs and checks:**
   1. first and second run, the second with `changed=0`;
   2. `verify.yml` with `verify_ssh_port`;
   3. a login as the admin on a fresh connection;
   4. a reboot through `limactl stop` / `limactl start`;
   5. `verify.yml` again. The host key must be unchanged, which `known_hosts`
      enforces.
5. **Delete** the VM, unless `--keep`.

Step 4.3 is new for every target. It catches the next account lockout, which a
reused connection would hide.

Out of scope for the script, as for the other targets: `forge setup`,
`forge image build` and container checks. Those belong to sub-project 2's
integration tests. The README's walk-through covers them by hand (see "Lima
validation").

### Coverage

| Path | Validated by |
|---|---|
| macOS, Apple Silicon (vz, arm64) | The Lima validation below (playbook, verify, restart, `forge setup`, image build, container network); `vm-test.sh --lima` on the Mac for branch 2; the maintainer's README walk-through before the docs PR |
| Ubuntu 24.04 (QEMU, amd64) | `vm-test.sh --lima` on the maintainer's Ubuntu server, run by the maintainer. Until then the README marks this path "not yet validated" |
| `forge_exposure: local` on amd64 | `vm-test.sh --host … --exposure local` on AWS, 2026-10-17: passed |
| `forge start` with a real repository, herdr attach | Sub-projects 2 and 4 (AWS smoke test, herdr integration); on Lima, herdr's remote attach was covered by the v2 validation spike |

`vm-test.sh --exposure local` alone does not cover macOS: it ran on an amd64
cloud VM and tests none of Lima's networking, forwarded port, arm64 or Mac-side
steps.

### Lima validation (2026-10-18)

Throwaway run on the maintainer's Mac. Setup: Apple Silicon with 16 GiB, Lima
2.2.1 (vz), ansible-core 2.20.2. The playbook deployed came from
`agent/v2-polish` (977a5f3). The VM used the template above, with an Ubuntu
26.04 arm64 cloud image (release-20260927) and kernel 7.0.0-34.

| Step | Result |
|---|---|
| First run, SSH over vsock (Lima's default) | Preflight failed: "Ansible's SSH session arrives on UNKNOWN" → `overVsock: false` |
| First run, over TCP | ok=234 changed=88 failed=0 (16 min); the admin was then locked out (fix 1) |
| Fresh VM with fix 1: first run, second run | changed=88, then changed=0; admin login OK after each run |
| `verify.yml` | ok=51 failed=0 |
| `limactl stop` / `start` | 2 s / 6 s; **host keys regenerated** (fix 2); with `known_hosts` reset, `verify.yml` ok=51 failed=0 |
| Third run after the restart | changed=2: devsec's `/var/log` permissions and tally directory. These look like generic reboot drift, not Lima-specific (open point 1) |
| `forge setup`, twice | Objects created, then all `unchanged`; `forgebr0` at `10.77.0.1/24`, IPv6 off; no host-address warning |
| `forge image build` (arm64) | 10 min, failed=0; Chrome rendered a page, aiuser's Docker is rootless |
| Container from `agent-base` | DNS and `https://example.com` OK. Blocked: the bridge address, the VM's `eth0`, Lima's gateway (`192.168.5.2`), Lima's DNS (`192.168.5.3`) and `169.254.169.254`. `unshare -Ur` as aiuser OK |

Not run: `forge start` with a real repository (GitHub clone through the
forwarded agent, `claude auth login`) and herdr on this VM. The maintainer's
walk-through covers them (see "Decisions").

## `forge setup` on bare metal

Linux local mode leaves the docs, but nothing stops someone from running
`forge setup` on their own machine. The framing spec asked for a warning, and
it stays:

- **When:** `forge setup` was not installed by the playbook (its release root
  is not under `/opt/agent-forge/releases/`), and the machine is not a VM
  (`systemd-detect-virt --vm` reports `none`).
- **What it prints:** a `WARNING`. There is no VM between the containers and
  this machine, so an agent that escapes its container lands here, with this
  machine's keys and sessions. The supported local mode is the Lima VM
  (README).
- An Ansible host on bare metal (`lan`) does not warn: it is a dedicated,
  hardened host, which is what remote mode documents.
- A missing `systemd-detect-virt` counts as "not a VM".
- **Unit test** with the fake environment: the three cases (Ansible release,
  VM, bare metal from a checkout).

The host contract's local-Linux fix messages stay as they are.

## README

### Structure

English, one file, written last (see "Delivery"):

1. **What it is.**
   - One paragraph and a diagram: dev machine (herdr client, git, ssh) → host
     VM (herdr server, `forge`, Incus) → containers (agent, `/workspace`).
   - A link to the security model.
2. **Choose your setup.**
   - *Local*: a Lima VM on your Mac or Ubuntu machine, recommended to try
     agent-forge.
   - *Remote*: a cloud VM or a LAN machine.
3. **Quick start: local.** The first hour, step by step:
   1. prerequisites per OS;
   2. creating the VM;
   3. the inventory and the playbook;
   4. the SSH config block;
   5. on the VM: `claude auth login`, git identity, `forge setup`,
      `forge image build`;
   6. `herdr --remote … --remote-keybindings server` and `prefix+f`;
   7. getting the work back.
4. **Remote host.** Only what differs:
   - creating the VM (Ubuntu 26.04, at least 2 vCPU, 4 GB, 40 GB);
   - the provider's firewall (port 22);
   - the inventory (`public` or `lan`);
   - the `forge-vm` SSH alias.

   Then steps 3.5 to 3.7, and a pointer to `ansible/README.md` for playbook
   details.
5. **Daily use.**
   - The keys (`prefix+f`, `prefix+shift+f`).
   - The commands: `start`, `resume`, `finish`, `stop`, `delete`, `list`,
     `attach`.
   - One container per repository, one worktree per task.
   - Outside herdr: foreground attach, no persistence.
   - Getting the work back, with sub-project 4's rules:
     - never run git in `~/workspaces/<container>` on the host;
     - review agent code before running it.
   - Strict mode: `--strict`, `forge egress`, the allowlist.
   - Docker/Compose, Chrome DevTools MCP, image versioning, bash completion.
6. **Updating.** Re-run the playbook from an updated checkout,
   `forge setup`, `forge image build` when the image changed.
7. **Configuration.** `~/.config/agent-forge/config.json` and
   `egress-allowlist`.
8. **Security model.** The threat/mitigation table, per mode, with the known
   limits:
   - in local mode, the VM can reach the developer's localhost and LAN (an
     escaped agent could too);
   - DNS tunnelling;
   - escape sequences reaching the terminal;
   - no LFS content in containers;
   - in strict mode, what can still leak through an allowed domain.
9. **Troubleshooting.**
   - A half-provisioned container: `incus --project agent-forge delete --force <container>`.
   - An image to rebuild after an image change (the `jq` case).
   - `known_hosts` after recreating the VM.
   - The agent not forwarded (`IdentityAgent`).
   - herdr's first attach run outside a real terminal.
   - Stopping provisioning on a GitHub host key prompt.
10. **Developing agent-forge.** Tests (`npm test`, `npm run check`,
    `ansible-lint`, `vm-test.sh` and its three targets, integration tests),
    and the `next` branch while v2 is in progress.

### Inputs

The README documents what the other stacks ship. Its content comes from:

- sub-project 3's spec and its note `readme-needs-sp3.md`;
- sub-project 4's spec and its note `readme-needs-sp4.md`;
- sub-projects 1 and 2's specs and `ansible/README.md`;
- the parent session's AWS smoke test.

Before writing, the implementer re-reads each stack's final code and user-facing
messages. The notes predate the implementation.

### `tests/test-readme-docs.sh`

Rewritten for v2.

- **Present:** each mode's key commands (`limactl create`,
  `ansible-playbook`, `forge setup`, `forge image build`, `herdr --remote`,
  `--remote-keybindings server`, `prefix+f`, `uploadpack`, `forge egress`,
  `--strict`, `ForwardAgent`).
- **Absent:**
  - v1 terms: `lxc `, `LXD`, `scripts/forge`, `tmux`, `Ctrl+b d`, `ufw`,
    `forge image build super`, `agent-super`;
  - Linux direct mode: `incus admin init`.

The personal values are checked by the cleanup grep (next section), not by this
test, so that the test file does not have to contain them.

## Personal values

### Scope

Every tracked file on the final stack: code, tests, `container/`, `ansible/`,
`README.md`, `CLAUDE.md`, and `docs/superpowers`, including the specs and plans
that sub-projects 3 and 4 added.

### Replacements

| Found | Replaced by |
|---|---|
| The maintainer's first name, family name or login, as a person or an account | "the maintainer", "the user", or a neutral account such as `alice` |
| The maintainer's home path | `/home/<user>` (or `/home/alice` in examples) |
| v1's bot address (`<login>-claude@users.noreply.github.com`) | removed, or a placeholder address in text that describes history |
| The v1 server's host name | "the v1 server" |
| The maintainer's LAN addresses | `192.0.2.x` (RFC 5737 documentation range) |
| `config/`, whose `AllowUsers` names the maintainer | deleted (see below) |
| Test fixtures built on the project's own repository name (`<login>/agent-forge`, `agent-<login>-agent-forge`) | `acme/widgets`, `agent-acme-widgets` (or similar neutral names) |

### Kept, as the implementer's call

- **The project's own GitHub address**, `github.com/moroine/agent-forge`, and
  references to its pull requests (`moroine/agent-forge#35`). It is where the
  project lives, not a personal setting. The README's clone command uses it.
  If the project moves to an organisation, these follow.
- Generic mentions of a YubiKey, as an example of a hardware key.

### Removed

- **`config/`** (`sshd_config`, `jail.local`, v1's host files). The playbook's
  roles replaced them, and `AllowUsers` there names the maintainer.
- `CLAUDE.md`'s "Config files hôte de la v1 dans `config/`" goes with it.

### Check

The implementation plan ends with a case-insensitive `git grep` over the final
tree for the values above (name, login, family name, work email domain, home
path, host name, LAN prefix). It must return nothing outside the "kept" list.
There is no permanent test, which would itself contain the values.

## `CLAUDE.md`

The repo's `CLAUDE.md` builds on moroine/agent-forge#34 (stack 2/n), which
already describes the v2 stack and runtime.

- **Contexte.**
  - All five sub-projects are delivered.
  - The README describes v2.
  - The host is either a VM reached over SSH, or a Lima VM in local mode.
- **Git section, rewritten for v2:**
  - **Working branch:** `agent/<tâche>`, one per task.
  - **Inside a forge v2 container (supervised):**
    - the agent commits on `agent/<tâche>`, unsigned, under the host user's
      git identity;
    - it never pushes and never runs `gh`, which `pre-bash.sh` blocks;
    - the maintainer fetches the work through `forge upload-pack`, reviews it,
      re-signs it, pushes it and opens the PR.
  - **On the developer's machine** (a Claude Code session using the repo's
    hook):
    - push only to `agent/<tâche>`, then open a PR to the base branch (`next`
      while v2 is in progress, `main` after the release);
    - in `auto` permission mode, without asking; in an interactive session,
      after confirmation;
    - never merge a PR, never push to `main` or `next`, never check out
      `main`.
  - **Merging:** the only allowed form is `git merge origin/<base>`. The
    section notes that `pre-bash.sh` on `next` accepts `origin/main` only until
    `main` (which has it since moroine/agent-forge#27) is merged into `next`.
    That merge is the maintainer's.
  - **v1's autonomous-container rules** (bot account, `gh pr create` from a
    container) leave this file. They stay on `main`.
- **Périmètre and "Ce que tu peux faire":** `config/` removed; `ansible/` and
  `docs/` listed.
- **Sécurité:** unchanged from #34, except the YubiKey line, which becomes
  generic ("an SSH key, a hardware key for example").
- The "Branche `next`" section stays until the release, when the
  `next` → `main` pull request removes it.

## Delivery

Stacked pull requests, titles ending "(pile v2 · sp5, N/n)", based on the stack
top at the time of writing (`agent/v2-polish`, moroine/agent-forge#38). Never
merged into `next` or `main` by the implementer. Commits are unsigned
(`--no-gpg-sign`) under the maintainer's standing authorization for this v2
stack; each PR body says so, and the maintainer re-signs.

1. **`agent/v2-local-spec`:** this spec and the implementation plan.
2. **`agent/v2-local-lima`:**
   - the three host fixes;
   - `ansible/lima/forge.yaml` and `ansible/inventory.lima.example.yml`;
   - `vm-test.sh --lima`;
   - `forge setup`'s bare-metal warning;
   - an `ansible/README.md` section on Lima.

   Its PR includes a passing `vm-test.sh --lima` summary from the Mac, run by
   the implementer. The host fixes apply to every exposure, so when the
   maintainer provides a fresh cloud VM, a `vm-test.sh --host` run is added;
   otherwise the PR says the fixes were validated under Lima only.
3. **`agent/v2-docs`, last:**
   - the personal-value cleanup;
   - `CLAUDE.md`;
   - the README and `test-readme-docs.sh`.

   **It must sit on top of every v2 pull request still open at that time.**
   On 2026-10-18 that is:
   - #34 (`CLAUDE.md`, branched from `next`, not an ancestor of the others);
   - #35 to #38 (the main stack, up to `agent/v2-polish`);
   - sub-project 3, up to `agent/v2-egress-acceptance` (#47), whose default
     allowlist differs from the spec's;
   - sub-project 4, up to `agent/v2-herdr-followups` (#45);
   - this sub-project's branches 1 and 2.

   They fork from `agent/hook-fail-closed` (#36), or from `next` for #34. The
   implementer cannot join them, because `pre-bash.sh` blocks `git merge` of
   other branches and `git rebase`. So before branch 3 starts, the maintainer
   chains them into one line and decides the order and the method. Branch 3
   then starts from the resulting top, and the README documents that tree.

   The docs PR also waits for the maintainer's macOS walk-through (see
   "Decisions"). Its result goes in the PR body.

The README rewrite lands last so that it documents what the other stacks
actually ship. Branch 2 depends only on sub-projects 1 and 2.

## Changes to the framing spec

Recorded here; the framing document is not edited.

- **"Local mode → Linux"**: replaced. Local mode is a Lima VM on Linux too; the
  direct mode leaves the docs. `forge setup` keeps a bare-metal warning.
- **"Local mode → macOS"**: Lima template settings (`plain`, `overVsock: false`,
  fixed SSH port) and the forge user named `forge`.
- **"Decisions → Local mode"**: "Linux: directly on the dev machine" →
  "Lima VM on macOS and Linux".
- **"Security model summary"**: the "Local Linux: lands on the dev machine"
  cells no longer apply to a documented mode. A new local-mode limit: the Lima
  VM can reach the developer's localhost and LAN.
- **"Host → Roles → `hardening`"**: the admin is exempt from devsec's
  system-account shell change.
- **"Host → Tests"**: `vm-test.sh` gains a Lima target.

## Open points (bounded)

1. **Reboot drift: generic, out of scope.** After a restart, a third
   playbook run changed 2 tasks: devsec's `/var/log` permissions and its tally
   directory. The `/var/log` drift was already seen on the AWS VM (rsyslog's
   tmpfiles rule resets it to 775 `root:syslog` at every boot), so it is not
   Lima-specific. It stays a sub-project 1 follow-up, and `vm-test.sh` is not
   changed to fail on it here.
2. **Ubuntu path.** Validated only once the maintainer has run
   `vm-test.sh --lima` and the README walk-through on the maintainer's Ubuntu server. The README says
   so until then.
3. **Lima on Ubuntu with Docker installed.** Lima's user-mode network does not
   touch the host's firewall, so Docker's `FORWARD` policy should not matter.
   The run on the maintainer's Ubuntu server confirms it.
4. **Stack order** for branch 3 (see "Delivery"): the maintainer's call.
5. **Output filtering from the local VM** (see "Security: what the local VM
   can reach"): deferred improvement.
