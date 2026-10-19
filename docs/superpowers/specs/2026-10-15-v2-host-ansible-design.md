# agent-forge v2 — Sub-project 1: Host (Ansible) — Design

**Date:** 2026-10-15
**Status:** Approved (brainstorming, then user review of this document, 2026-10-15)
**Branch:** `next`
**Parent:** `docs/superpowers/specs/2026-10-15-v2-incus-ansible-herdr-design.md`
(framing spec, section "Host (sub-project 1)")
**Inputs:** `docs/superpowers/spikes/2026-10-15-v2-validation-spike.md`
(validation spike, merged into `next` as moroine/agent-forge#29)

## Context and scope

The framing spec decides that the host is provisioned by an Ansible playbook run
from the developer's machine, and that this playbook replaces v1's manual README
steps (sshd, UFW, fail2ban, LXD). This document settles what the framing spec
left to sub-project 1. The framing decisions are not reopened here:

- Ubuntu 26.04 LTS;
- six roles: `base`, `hardening` (`devsec.hardening`), `firewall` (native
  nftables in its own table, never `flush ruleset`), `fail2ban` (nftables
  actions), `incus` (Zabbly `lts-7.0`), `forge_users`;
- `forge_exposure: public | lan | local`;
- separate admin and forge-user accounts.

**Boundary rule (from the framing spec).** Ansible configures the host OS and
stops once Incus is installed, initialized with a storage pool, and usable by the
forge user. Everything inside Incus (project, bridge, profiles, ACLs, image)
belongs to `forge setup` (sub-project 2). The only place this playbook touches
Incus internals is a smoke test in `verify.yml`, which creates and deletes a
throwaway project.

**Target.** A fresh Ubuntu 26.04 machine, **VM or bare metal**. omen, today a
hand-configured v1 host, is meant to be reinstalled and provisioned by this
playbook when v2 ships. So the playbook assumes nothing from cloud-init, and it
detects the external interface, WiFi included, unless it is given one.

**Out of scope:** everything inside Incus (sub-project 2), the egress allowlist
(3), herdr integration (4), and the per-mode README (5). Sub-project 1 adds a
short `ansible/README.md` covering how to run the playbook and its test. v1's
README setup steps stay as they are until sub-project 5 rewrites the README.

## Decisions settled by this spec

| Topic | Decision | Why |
|---|---|---|
| Incus storage | `btrfs`; a loop file by default, a dedicated disk or partition optionally | Copy-on-write makes container creation instant and shares image blocks. A loop file bounds the pool, so a container that fills its disk cannot fill the host's root filesystem. `dir` enforces no size limit on a typical ext4 root |
| Admin account | The machine's existing sudo account (`ansible_user`), never `root` | One kind of run, no two-phase bootstrap, no lockout window. The playbook does not change its keys or its sudo |
| `forge` install | Controller-side `git archive HEAD`, unpacked system-wide into `/opt/agent-forge/releases/<sha>/`, with a `current` symlink | `forge` always comes from the same commit as the playbook that installs it. Works for forks and unpushed branches; the host needs no GitHub access; one version per host is the right shape for multi-user (B) |
| Stable SSH agent | **Dropped** from Ansible. herdr 0.9.5 provides `~/.config/herdr/herdr.sock.agent` to panes and popups, repointed at each attach (spike, finding F) | The framing spec's `~/.ssh/rc` mechanism is redundant |
| SSH features for herdr | None. `herdr --remote` uses ssh's stdio only (spike, point 3). The only forwarding allowed is agent forwarding, for forge users, for host-side `git clone`/`fetch` | Resolves the framing spec's open point |
| devsec overrides | Four sysctls plus `ufw_manage_defaults: false` on `os_hardening`; six settings on `ssh_hardening` (see "Role `hardening`") | Override only what breaks the host's purpose; keep every other upstream default |
| sudo-rs and uutils | Tested as shipped: the verification asserts they are active, then the full run, idempotence and reboot checks pass on the stock image | A test that silently ran on GNU coreutils or C sudo would prove nothing |
| Claude Code on the host | Anthropic's signed apt repository, `stable` channel | System-wide, signature-checked, updated by unattended-upgrades; no `curl \| bash` per user |
| Ansible on the host | Ubuntu's `ansible` package | It bundles community.general 12.1, whose `incus` connection plugin `forge image build` needs (≥ 8.2). No `ansible-galaxy` at runtime |
| Throwaway test VM | `ansible/tests/vm-test.sh`, in one of two modes: `--host`, against an existing fresh VM (a cloud VM) from the developer's machine; or, by default, a VM it creates on an LXD/Incus host with KVM (omen) | omen stopped being reachable during implementation, and most cloud VMs have no nested KVM, so `--host` makes the cloud VM itself the throwaway target. On omen, Ansible runs on omen itself: its sshd forbids TCP forwarding |
| CI | GitHub Actions on `ubuntu-26.04`: `npm test`, `npm run check`, `ansible-lint` (profile `production`), and the playbook's controller-only unit tests. No VM in CI | Light, fast, no secrets |

## Repository layout

```
ansible/
  site.yml                 # preflight play, then the main play (six roles in order)
  requirements.yml         # controller-side collections, pinned
  inventory.example.yml    # every user-facing variable, documented
  README.md                # how to run site.yml and the VM test
  roles/
    base/  hardening/  firewall/  fail2ban/  incus/  forge_users/
  tests/
    vm-test.sh             # throwaway VM on an LXD/Incus host (omen)
    verify.yml             # assertions run against the provisioned host
.ansible-lint              # profile: production; lints all of ansible/
.github/workflows/ci.yml
```

Sub-project 2 adds `ansible/image.yml` and `ansible/roles/forge_image/`. No
`ansible.cfg` is created by sub-project 1: `site.yml` sets what it needs in the
play itself.

`ansible/requirements.yml` lists `devsec.hardening` pinned to `11.0.0` (released
2026-10-05, the first to list Ubuntu 26.04), plus `community.general` and
`ansible.posix`, each pinned to an exact version. It is for the controller only.

## Running the playbook

From a git checkout of the repository, on the controller (the developer's
machine, or omen for the VM test):

```bash
ansible-galaxy collection install -r ansible/requirements.yml
ansible-playbook -i inventory.yml ansible/site.yml
```

- **Controller requirements:** ansible-core ≥ 2.20 (the version Ubuntu 26.04
  ships), git, and a checkout of this repository (`forge` is deployed from its
  HEAD).
- **Connection:** Ansible connects as `ansible_user`, the admin account, with
  `become` for root tasks.
- **sudo-rs and become passwords.** On 26.04, `sudo` is sudo-rs. With a
  passwordless sudo admin (`ubuntu` on cloud images, the Lima user), Ansible
  works unchanged. With a sudo password, whether given by `-K` or by
  `ansible_become_password`, Ansible's `become` times out, because sudo-rs
  rewrites the prompt Ansible waits for. This is ansible/ansible#85837, fixed in
  ansible-core 2.22. Until then, set `ansible_become_exe: sudo.ws`, the C sudo
  that 26.04 still installs under that name. This affects only Ansible's
  connection; the host's default `sudo` stays sudo-rs. A become password, if
  used, lives in an `ansible-vault` file, never in plain text in the inventory.
- **SSH port change.** If `ansible_port` is not set in the inventory and
  `forge_ssh_port` is not 22, the preflight play tries an authenticated login
  on `forge_ssh_port` and falls back to 22 when it is unreachable, which is the
  case on the first run. It must be a real login: a bare TCP connect that
  closes before the SSH banner counts as a failure in fail2ban's aggressive
  mode (`public`), and a few runs would ban the controller. When `ansible_port`
  is set (Lima's forwarded port, for example), it is used as is.
- **No lockout.** The sshd restart and the nftables load are handlers, and
  `site.yml` sets `force_handlers: true`. The provisioning play imports its
  roles as ordered `import_role` tasks, not under `roles:`. Handlers run in
  the order they are loaded, and under `roles:` devsec's "Restart sshd"
  (imported by the hardening role) would run after every other role's
  handlers. With ordered imports it runs right before "Load the host
  firewall". A handler that fails before the pair leaves both undone; after
  the pair, both are done. Either way sshd's port and the firewall agree. The
  established-connection rule keeps the current Ansible connection alive
  throughout.

## Inventory and variables

```yaml
all:
  hosts:
    forge-vm:
      ansible_host: 203.0.113.10
      ansible_user: ubuntu              # the admin: the machine's sudo account, never root
      # ansible_port: 60022             # only when it differs from forge_ssh_port (Lima)
      # ansible_become_exe: sudo.ws     # sudo with a password and ansible-core < 2.22
  vars:
    forge_exposure: public              # public | lan | local
    forge_users:                        # exactly one in v2.0
      - name: alice
        ssh_keys:
          - "ssh-ed25519 AAAA… alice@laptop"
    # Optional (defaults shown)
    forge_ssh_port: 22
    forge_ssh_allowed_sources: []       # CIDRs allowed to reach SSH; [] = anywhere
    forge_external_interface: ""        # "" = the interface of the default IPv4 route
    forge_incus_storage_size: ""        # "" = ~80 % of free space, computed at pool creation
    forge_incus_storage_source: ""      # a disk or partition for the pool instead of a loop file
    forge_fail2ban_ignoreip: []         # extra addresses fail2ban never bans
```

- Every user-facing variable has the `forge_` prefix and is documented in
  `inventory.example.yml`. Role internals live in each role's `defaults/` with
  the role's own prefix, and are not part of the interface.
- `forge_ssh_allowed_sources` applies whenever it is non-empty, whatever the
  exposure. The framing spec tied it to `public` only, but nothing justifies
  silently ignoring it on a LAN. It is matched for IPv4 and IPv6. Setting it
  without including the controller's address locks the controller out; the
  example file says so.
- `forge_users[].ssh_keys` is authoritative: the role installs exactly these
  keys, and a key added to the forge user's `authorized_keys` by hand is removed
  on the next run.

### Preflight

The first play of `site.yml` fails early, with a message naming the variable or
condition, unless:

- the target is Ubuntu 26.04;
- `ansible_user` is set (sshd's `AllowUsers` is built from it, so it must be
  the account Ansible logs in as) and is not `root` (`PermitRootLogin no`
  would lock the next run out);
- the firewall's external interface exists, and Ansible's own SSH session
  arrives on one of its addresses (or on loopback): SSH is accepted on that
  interface only;
- `forge_exposure` is `public`, `lan` or `local`;
- `forge_users` holds exactly one user, whose name differs from `ansible_user`
  and who has at least one SSH key. Several forge users would share one Incus
  project and bridge, which is multi-user (B) territory;
- the controller runs ansible-core ≥ 2.20 and the playbook sits in a git
  checkout.

It then resolves the connection port (see "Running the playbook").

## Roles

The main play runs the roles in this order: `base`, `hardening`, `firewall`,
`fail2ban`, `incus`, `forge_users`.

### Role `base`

- **Packages:** `git`, `curl`, `ca-certificates`.
- **Updates.** unattended-upgrades is enabled for Ubuntu's security pocket and
  for the three repositories the playbook adds: Zabbly, NodeSource and Claude
  Code, matched by host name (`site=`), because NodeSource's `Release` file has
  no usable Origin (`. nodistro`). The playbook itself installs with
  `state: present` and never upgrades anything, except Incus (see the `incus`
  role). There is **no automatic
  reboot**: it would kill the herdr server and every running agent. Pending
  reboots show in `/var/run/reboot-required`.
- **Third-party apt repositories** (here and in later roles) use deb822 sources.
  Their signing key is fetched over HTTPS, and its fingerprint is asserted
  against a value pinned in the role's defaults.
- **Time:** the distribution's default time-sync service is enabled and active.
  There is no custom server list.
- **Headless:** `sleep`, `suspend`, `hibernate` and `hybrid-sleep` targets are
  masked, and the default target is `multi-user.target`. This matters for bare
  metal.
- **journald:** a drop-in sets `Storage=persistent` and `SystemMaxUse=1G`.

### Role `hardening`

It applies `devsec.hardening.os_hardening` and `devsec.hardening.ssh_hardening`
11.0.0 with the overrides below, and nothing else. Every override carries a
comment in the role's vars stating why.

**`os_hardening` — `sysctl_overwrite`:**

| Key | devsec | Ours | Why |
|---|---|---|---|
| `net.ipv4.ip_forward` | 0 | **1** | Incus's NAT bridge routes container traffic |
| `kernel.unprivileged_userns_clone` | 0 (Ubuntu vars) | **1** | With 0, an unprivileged user inside a container cannot create a nested user namespace: Chrome's sandbox and rootless Docker break |
| `kernel.apparmor_restrict_unprivileged_userns` | not set (Ubuntu: 1) | **0** | Same breakage, from Ubuntu's AppArmor mediation (spike, point 6). v1 already runs with 0 on omen: the LXD snap sets it host-wide at each start. Incus does not |
| `kernel.yama.ptrace_scope` | 2 (since 10.6.0) | **1** | 1 is Ubuntu's default. With 2, and with `sys_ptrace` dropped from containers, `strace` and `gdb` stop working inside containers, even on the agent's own processes |

Also `ufw_manage_defaults: false`, since UFW is not used.

IPv6 forwarding stays at devsec's 0: the forge bridge has IPv6 disabled in
v2.0. If sub-project 2 ever enables IPv6 on the bridge,
`net.ipv6.conf.all.forwarding` must be overridden too.

Kept at devsec defaults on purpose, after review:

- **Filesystem blocklist:** squashfs and vfat are blocked, but devsec removes
  any type that is currently mounted, and removes vfat on EFI machines.
- **`/proc` mounted with `hidepid=2`:** the verification checks that `incus` and
  herdr still work as the forge user.
- **Password ageing:** devsec adds `no_pass_expiry` to pam_unix, so key-only
  logins are never refused by an expired password.
- **The rest:** umask 027, home directories 0700, auditd, faillock, core dumps
  off.
- **`KillUserProcesses`:** devsec does not touch logind. The verification
  asserts it is `no`, so the herdr server survives logout (spike, finding E).

**`ssh_hardening`:**

| Setting | Value | Why |
|---|---|---|
| `ssh_server_ports` | `[forge_ssh_port]` | Configurable port |
| `ssh_allow_users` | the admin and the forge user | Nobody else logs in |
| `ssh_permit_root_login` | `no` (devsec default, pinned) | v1 had `yes` |
| `ssh_allow_agent_forwarding` | `false`, plus `ssh_server_match_user` for the forge user with `AllowAgentForwarding yes` | Agent forwarding only where host-side git needs it; the admin never forwards |
| `sshd_custom_options` | `AllowStreamLocalForwarding no` | devsec does not template it, and OpenSSH defaults it to `yes` |
| `ssh_host_key_files` | `[/etc/ssh/ssh_host_ed25519_key]` | Otherwise devsec regenerates the RSA host key (Ubuntu's is 3072 bits, devsec wants 4096) and clients see a changed host key |

TCP forwarding, X11 and tunnels stay at devsec's `no`.

- **Kept on purpose:**
  - `MaxAuthTries 2`: `inventory.example.yml` and `ansible/README.md` recommend
    `IdentitiesOnly yes` for agents that hold several keys;
  - sftp enabled: Ansible's file transfer uses it;
  - client-side hardening of `/etc/ssh/ssh_config`: it breaks nothing.
- **Socket activation.** devsec masks `ssh.socket` and starts `ssh.service`, so
  `Port` in `sshd_config` applies. devsec issue #941 ("Unit ssh.socket is
  masked") is worked around by a pre-task only if the VM test hits it.

**Against sudo-rs and uutils.** The verification first asserts that the VM runs
them (`sudo --version` reports sudo-rs, `ls --version` reports uutils). Then
the full run, a second run with zero changes, a reboot and the verification
make up the compatibility test. If a devsec task breaks under them, the fix is
a targeted override, upstreamed when it is a devsec bug. Switching the system
back is documented but not enabled: `coreutils-from-gnu`, and `update-alternatives`
for sudo.

### Role `firewall`

- `nftables` is installed and `ufw` is purged: two tools writing into netfilter
  is exactly what the framing spec rules out.
- `/etc/nftables.conf` is replaced by a template, validated with `nft -c -f`
  before it is installed:

```
#!/usr/sbin/nft -f
# agent-forge manages this table only. Never `flush ruleset`: it would wipe
# Incus's tables (inet incus, bridge incus) and cut container networking.
table inet forge_host {}
delete table inet forge_host
table inet forge_host {
  chain input {
    type filter hook input priority filter; policy drop;
    ct state established,related accept
    ct state invalid drop
    iif lo accept
    # essential ICMP / ICMPv6 (echo-request rate-limited; neighbor and router discovery)
    iifname "forgebr0" udp dport 67 accept                     # DHCP for containers
    iifname "forgebr0" meta l4proto { tcp, udp } th dport 53 accept   # DNS for containers
    iifname "<ext>" tcp dport <forge_ssh_port> [saddr in allowed sources] [public: rate limit] accept
  }
  chain forward {
    type filter hook forward priority filter; policy drop;
    ct state established,related accept
    iifname "forgebr0" oifname "<ext>" accept
  }
}
```

- **Safe service lifecycle.** Ubuntu's `nftables.service` runs
  `nft flush ruleset` on stop, so also on every `restart`. A systemd drop-in
  replaces that `ExecStop` with `nft delete table inet forge_host`. A reflexive
  `systemctl restart nftables` is then harmless to Incus. The service is
  enabled, so the table loads at boot.
- **Coexistence.** The table lives alongside `inet incus` and `bridge incus`
  (Incus), `inet f2b-table` (fail2ban) and, under Lima, `ip nat`. In nftables a
  packet must pass every base chain on its hook, so this table's input policy
  holds no matter what Incus accepts. That is why DHCP and DNS from the bridge
  are accepted here too.
- **`<ext>`** is `forge_external_interface`, defaulting to the interface of the
  default IPv4 route (`wlo1` on a WiFi machine, for example).
- **`forgebr0`** is a constant shared with sub-project 2, the role's default. The
  rules match on `iifname`, never on the bridge's subnet, which `forge setup`
  makes configurable (spike, finding A). They are valid before the bridge exists.
- **Refinements of the framing spec:**
  - Essential ICMP is accepted. Without ICMPv6 neighbor discovery the host's
    own IPv6 breaks, and dropping all ICMP breaks path-MTU discovery. DHCPv6
    replies and MLD from link-local addresses are accepted too: conntrack
    cannot match them as replies, and dropping them loses the host's IPv6.
  - Forwarding is not symmetric: from the bridge to the external interface,
    anything goes; from the external interface to the bridge, only return
    traffic passes. No container is exposed inbound in v2.0.
  - Inter-container traffic is bridged, not routed, so it never reaches this
    table. The Incus ACLs isolate containers (sub-project 2).
- **SSH rate limit (`public`):** new SSH connections are limited to 10 per
  minute per source address, with a small burst. herdr and Ansible both
  multiplex over a ControlMaster, so legitimate use stays far below that.
- The rules are loaded by a handler (see "No lockout").

### Role `fail2ban`

A dedicated `jail.d/` file:

- jail `sshd` on `forge_ssh_port`;
- `backend = systemd`, which does not depend on `/var/log/auth.log` existing;
- `banaction = nftables-multiport` and `banaction_allports = nftables-allports`;
- `ignoreip` holds the loopback addresses plus `forge_fail2ban_ignoreip`.

fail2ban keeps its bans in its own table, which the firewall never touches.
Settings per exposure are under `forge_exposure`; with `local` the service is
stopped and disabled.

### Role `incus`

- **Repository:** Zabbly's key goes to `/etc/apt/keyrings/zabbly.asc`, with its
  fingerprint asserted (`4EFC 5906 96CB 15B8 7C73 A3AD 82CC 8797 C838 DCFD`).
  The deb822 source points at `https://pkgs.zabbly.com/incus/lts-7.0`, suite
  `resolute`, `main`, for the host's architecture.
- **Packages:**
  - `incus-base` (the daemon without VM support, so no QEMU; v2 runs containers
    only) and the `incus` client;
  - `btrfs-progs`, only a *Suggests* of the Incus packages.

  Ubuntu's universe also ships Incus 6.0.5. Zabbly's `1:` epoch wins, and the
  verification asserts a 7.0.x version.
- **Upgrades:** unlike the other roles, the packages are installed with
  `state: latest` on an apt cache at most an hour old. Re-running the playbook
  is how a host gets a newer Incus at once (sub-project 3's strict mode
  requires 7.0.2 or later and says so); it stays within the configured
  repository (`incus_zabbly_uri`, `lts-7.0` by default), as unattended-upgrades
  already does daily. An upgrade restarts the daemon; running containers keep
  running.
- **Initialization**, only when `incus storage show default` fails, through
  `incus admin init --preseed`:
  - storage pool `default`, driver `btrfs`:
    - on a loop file of `forge_incus_storage_size` when set;
    - otherwise ~80 % of the free space of the filesystem holding
      `/var/lib/incus`, rounded down to a GiB. Below 20 GiB the role fails and
      asks for an explicit size or a dedicated device;
    - or `source: forge_incus_storage_source` for a dedicated disk or
      partition;
  - the `default` profile of the `default` project gets a root disk on that
    pool, as `incus admin init` normally does;
  - **no network** (under Lima, Incus cannot auto-pick a subnet — spike,
    finding A) and no `core.https_address` (no remote API).
- **Existing pool:** left untouched. If its driver is not `btrfs`, the role
  fails with a clear message; there is no automatic migration. The pool can grow
  later with `incus storage set default size=…`, documented in
  `ansible/README.md`; the playbook never runs it.
- **Quota caveat:** btrfs quotas (qgroups) enforce each container's root disk
  size, but an agent can escape them, because `btrfs subvolume create` needs no
  privilege and nested subvolumes are not counted. The pool's size is the hard
  ceiling; per-container sizes are a guard rail.
- The role stops there.

### Role `forge_users`

v2.0 has exactly one forge user (see "Preflight"). For that user:

- **Account:**
  - shell `/bin/bash`, locked password, supplementary group `incus-admin` only,
    never `sudo`;
  - `authorized_keys` set exclusively from `ssh_keys`.

  `incus-admin` is root-equivalent; that is accepted on a single-user VM
  (framing spec).
- **PATH.** A managed block at the top of `~/.bashrc` prepends `~/.local/bin`.
  It sits before Ubuntu's early `return` for non-interactive shells, so SSH
  commands find what herdr installs there (spike, finding G).
- **Node 24:** NodeSource's `node_24.x` repository, suite `nodistro`, with an apt
  pin at priority 600. Ubuntu 26.04 only ships Node 22.
- **Claude Code:** Anthropic's apt repository, `stable` channel, key fingerprint
  asserted (`31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE`), giving
  `/usr/bin/claude`. On the host it is only used for `claude auth login`. The
  credentials it writes are what `forge start` injects into containers.
- **Ansible:** Ubuntu's `ansible` package (ansible-core 2.20 plus collections,
  including community.general 12.1), used by `forge image build`.
- **`forge`:**
  1. On the controller (`delegate_to: localhost`, `run_once`, no become),
     `git archive HEAD` produces a tarball. `git rev-parse HEAD` gives the
     commit. If `git status --porcelain` is not empty, a warning says that HEAD
     is deployed, not the working tree.
  2. The tarball is unpacked into `/opt/agent-forge/releases/<sha>/`, owned by
     `root:root`. A `COMMIT` file at the release root holds the full SHA. The step is skipped when
     the directory already exists.
  3. `/opt/agent-forge/current` is switched to it atomically (symlink rename),
     and `/usr/local/bin/forge` points at the CLI entry point under `current`.
     That is `cli/forge` in the framing layout, or `scripts/forge` until
     sub-project 2 moves the CLI; it is an internal role variable.
  4. The current and previous releases are kept; older ones are removed.
  5. `/etc/bash_completion.d/forge` is regenerated from `forge completion bash`
     whenever `current` changes.
- **Not done here, on purpose:**
  - **herdr:** it installs itself into `~/.local/bin` on the first
    `herdr --remote`, at the client's version.
  - **`~/.ssh/rc`:** herdr provides the stable agent socket (spike, finding F).
  - **`~/workspaces`:** `forge` creates it.
  - **systemd linger:** the herdr server already survives logout with
    `KillUserProcesses=no`.

## `forge_exposure`

| | `public` | `lan` | `local` (Lima) |
|---|---|---|---|
| fail2ban | `mode = aggressive`, `maxretry = 3`, `findtime = 1h`, `bantime = 1d` with `bantime.increment` up to 30 d | normal mode, `maxretry = 5`, `findtime = 10m`, `bantime = 1h` | stopped and disabled (it would ban Lima's gateway) |
| nft rate limit on new SSH connections | 10/min per source | — | — |
| `forge_ssh_allowed_sources` | applied when set | applied when set | applied when set |

v1 banned for 30 days from the first offence. On a LAN, one key mistake would
lock the owner out for a month; `public` reaches the same severity for repeat
offenders only, through the increasing ban.

## Interfaces with other sub-projects

Agreed with the sub-project 2 spec session on 2026-10-15.

| Item | Provided by sub-project 1 | Used by |
|---|---|---|
| Host sysctls | `ip_forward=1`, `unprivileged_userns_clone=1`, `apparmor_restrict_unprivileged_userns=0`, `ptrace_scope=1` | 2: `forge setup` checks the two userns values read-only and stops with the exact fix if they are wrong (relevant to local Linux mode, where there is no Ansible) |
| Bridge name | `forgebr0` in the host firewall (by `iifname`) | 2 creates it, with a configurable `ipv4.address` |
| Storage pool | `default`, btrfs | 2: the forge profile's root disk (pool name overridable in forge's config) |
| Incus access | the forge user in `incus-admin` | 2, 4 |
| Tools | `/usr/bin/node` (24), `/usr/bin/claude`, Ubuntu's `ansible` with community.general | 2 (`forge image build`), host-side login |
| `forge` | `/usr/local/bin/forge` → `/opt/agent-forge/current/…`; `COMMIT` at the release root (`/opt/agent-forge/releases/<sha>/COMMIT`, beside `cli/` and `ansible/`) | 2: the image stamp reads `<repo root>/COMMIT` (repo root = the CLI's own location, `cli/..`), falling back to `git -C <repo root> rev-parse HEAD`. `forge` writes nothing under `/opt/agent-forge` |
| IPv6 | forwarding stays off | 2 keeps IPv6 off on `forgebr0` in v2.0 |

## Testing

### Throwaway VM: `ansible/tests/vm-test.sh`

A bash script (`set -e`, preconditions checked first, per the repository's
conventions), run by the user. Two targets:

- **`--host ADDRESS --admin-key KEY [--admin USER]`**: an existing, fresh
  Ubuntu 26.04 machine, typically a cloud VM, tested from the developer's
  machine. `--user-data PUBLIC_KEY` prints the cloud-init that creates its
  passwordless-sudo `ubuntu` admin for that key (the playbook refuses root,
  and some providers only give root). The script refuses a machine that is
  already provisioned (sshd on 2222, or `/opt/agent-forge` present). The user
  rebuilds the VM before each run and destroys it afterwards.
- **By default**: a VM that the script creates and deletes on the LXD or Incus
  host with KVM it runs on (omen), from a dedicated clone of `next` kept apart
  from the v1 clone. A v1 agent container can neither reach omen's LXD nor run
  a VM.

Options: `--exposure public|lan|local` (default `public`), `--keep`.

The steps below describe the default mode. With `--host`, step 3 is the
existing machine (its admin key copied into the temporary directory), and the
reboot in step 8 goes through `sudo systemctl reboot` over SSH.

1. **Preconditions.** `lxc` or `incus` is present and `/dev/kvm` exists.
   `ansible-playbook` ≥ 2.20 is on PATH; on omen's Ubuntu 24.04 that means
   `pipx install ansible-core`, and the script prints that hint when the version
   is too old. Collections from `requirements.yml` go into a temporary
   `ANSIBLE_COLLECTIONS_PATH`.
2. **Throwaway material** in a `mktemp -d` removed by a `trap`: an admin key, a
   forge-user key and a `known_hosts` file. SSH uses
   `StrictHostKeyChecking=accept-new` against that file, so a host key that
   changes between runs fails the test.
3. **VM** `forge-host-test-<random>`:
   - from `ubuntu:26.04` (LXD) or `images:ubuntu/26.04/cloud` (Incus);
   - 2 vCPU, 4 GiB of memory, a 40 GiB root disk, so that the pool clears
     20 GiB;
   - cloud-init puts the admin key on the image's `ubuntu` user (passwordless
     sudo).

   The script waits for cloud-init to finish and for an IPv4 address.
4. **Inventory**, generated: admin `ubuntu`, forge user `forgetest`,
   `forge_ssh_port: 2222` (exercises the move away from 22), and the chosen
   exposure.
5. **First run** of `site.yml`.
6. **Second run**: the play recap must show `changed=0` for the host.
7. **`verify.yml`**, plus SSH checks from the controller, every one on a fresh
   connection (`ControlMaster=no`). herdr's and Ansible's multiplexed
   connections would otherwise hide sshd changes (spike, finding D).
8. **Reboot** the VM, then run step 7 again. This catches anything that does not
   persist: sysctls, the nftables table, `ssh.socket` masking, Incus starting.
9. **Delete** the VM, unless `--keep`.

### What `verify.yml` and the controller-side checks assert

- **Platform:** Ubuntu 26.04; `sudo --version` reports sudo-rs; `ls --version`
  reports uutils.
- **sshd:**
  - `sshd -t` passes;
  - `sshd -T` shows the configured port, `permitrootlogin no`,
    `allowtcpforwarding no`, `allowstreamlocalforwarding no`,
    `allowagentforwarding no`;
  - `sshd -T -C user=forgetest,host=x,addr=192.0.2.1` shows
    `allowagentforwarding yes`.
- **SSH from the controller:**
  - root is refused;
  - port 22 does not answer;
  - with `-A`, `SSH_AUTH_SOCK` is set for `forgetest` and unset for the admin.

  At most two deliberate authentication failures happen, below `public`'s
  `maxretry` of 3.
- **Firewall:**
  - `nft list table inet forge_host` succeeds;
  - `/etc/nftables.conf` contains no `flush ruleset`;
  - a sentinel table created by the test survives `systemctl restart nftables`
    and `systemctl reload nftables`.
- **fail2ban** (`public`, `lan`):
  - `fail2ban-client status sshd` succeeds;
  - `fail2ban-client set sshd banip 192.0.2.1` shows up in `inet f2b-table`,
    and `unbanip` removes it. This proves the nftables action without locking
    the controller out.

  With `local`, the service is inactive.
- **Kernel:**
  - the four sysctls from the `hardening` table;
  - `/proc` mounted with `hidepid=2`;
  - `loginctl` reports `KillUserProcesses=no`.
- **Incus:**
  - version 7.0.x from Zabbly;
  - pool `default` with driver `btrfs`;
  - no managed network.
  - **Smoke test:** as `forgetest`, in a throwaway project, the test launches a
    container with no NIC and runs
    `setpriv --reuid 1000 --regid 1000 --clear-groups unshare -Ur true` inside
    it. This proves, end to end, that an unprivileged user can create a user
    namespace inside a container (the userns sysctls). The project is then
    deleted.
- **Forge user:**
  - member of `incus-admin`;
  - `sudo -n true` fails;
  - `node --version` is v24;
  - `claude --version` answers;
  - `ansible-doc -t connection community.general.incus` answers;
  - `forge --help` works over a non-interactive SSH command;
  - `/opt/agent-forge/current/COMMIT` equals the controller's HEAD;
  - `~/.local/bin` is on the non-interactive PATH.
- **Base:**
  - unattended-upgrades is enabled, and its origins include the three added
    repositories;
  - the sleep targets are masked;
  - `/var/log/journal` exists;
  - the time-sync service is active.

A passing `vm-test.sh` run (`--exposure public`) is required before a
sub-project 1 pull request is merged into `next`; its summary goes in the PR
description. The architecture covered is the test VM's: amd64 on omen or an
amd64 cloud VM. arm64 is covered by an arm64 cloud VM, or when sub-project 5
provisions a Lima VM on the Mac with the same playbook.

### CI: `.github/workflows/ci.yml`

- **Triggers:** pull requests (any base) and pushes to `next` and `main`;
  `permissions: contents: read`.
- **Job `cli`:** `runs-on: ubuntu-26.04`; Node 24 via `actions/setup-node`;
  `npm ci`; `apt-get install tmux` (contract tests, until sub-project 4 removes
  tmux); `npm test`; `npm run check`.
- **Job `ansible-lint`:** the official `ansible/ansible-lint` action, with
  `requirements_file: ansible/requirements.yml`. `.ansible-lint` sets profile
  `production` and covers all of `ansible/`, sub-project 2's image playbook
  included.
- **Job `ansible-unit`:** the playbook's controller-only unit tests
  (`ansible/tests/unit.yml`). They need no target machine: input checks, the
  port fallback, computed variables and rendered templates (firewall,
  fail2ban, preseed).
- **Pinning:** every action is pinned to a full commit SHA.
- **Missing tools:** when a test fails because the runner lacks a tool, the CI
  setup is fixed; the test is never skipped.
- **No VM in CI:** the playbook's real test is `vm-test.sh`.

## Security model changes

Deltas to the framing spec's security model, all approved in brainstorming:

- **User namespaces.** `kernel.apparmor_restrict_unprivileged_userns=0` and
  `kernel.unprivileged_userns_clone=1` loosen Ubuntu host mitigations. On a
  single-user VM where the forge user is already root-equivalent
  (`incus-admin`), the marginal cost is low, and the container stays the
  boundary. v1 on omen has run with the first one at 0 all along, through the
  LXD snap.
- **ptrace.** `kernel.yama.ptrace_scope=1` (Ubuntu's default) instead of devsec's
  2.
- **SSH.** No forwarding at all except agent forwarding for the forge user;
  `PermitRootLogin no` (v1: `yes`); ed25519 host key only.
- **Firewall.** Inbound traffic to containers is return traffic only.
  fail2ban and SSH settings scale with `forge_exposure`.

## Open points (bounded)

1. **userns sysctls, confirmation by sub-project 2.** Sub-project 2's spec
   proposes the host sysctl (spike option 1) to its user. If it settles on
   another option, sub-project 1 drops the `apparmor_restrict_unprivileged_userns`
   override and keeps the other three.
2. **devsec issue #941** (`ssh.socket` masked): worked around by a pre-task only
   if `vm-test.sh` hits it on 26.04.
3. **become with a sudo password** is documented (`sudo.ws`) but not covered by
   `vm-test.sh`, which uses the cloud image's passwordless `ubuntu`. omen's
   bare-metal migration will exercise it. It disappears with ansible-core 2.22.
4. **arm64** is not covered by the VM test until sub-project 5 (Lima on the Mac).

## Changes to the framing spec

Recorded here; the framing document is not edited.

- "Host → Roles → `hardening`": herdr needs no SSH forwarding feature; only agent
  forwarding for forge users remains.
- "Host → Roles → `forge_users`" and "Orchestration → Stable SSH agent": the
  `~/.ssh/rc` / `~/.ssh/agent.sock` mechanism is dropped in favour of herdr's
  `~/.config/herdr/herdr.sock.agent`.
- "Host → Roles → `incus`": `dir` or `btrfs` → `btrfs`; the preseed creates no
  network.
- "Host → `forge_exposure`": `ssh_allowed_sources` (`forge_ssh_allowed_sources`)
  applies whenever set, not only with `public`.
- "Host → Roles → `firewall`": essential ICMP accepted; forwarding from the
  external interface to the bridge limited to return traffic.
- "Host → Tests": the throwaway VM is a fresh cloud VM tested with `--host`, or an LXD VM on omen.
