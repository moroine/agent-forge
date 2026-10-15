# agent-forge v2: Incus runtime, Ansible host, herdr orchestration — Framing Design

**Date:** 2026-10-15
**Status:** Approved in brainstorming, pending user review of this document
**Branch:** `next`

## Context

agent-forge v1 runs Claude Code agents in LXD containers on one hand-configured
Ubuntu 24.04 host. It works, but it cannot be shared:

- Host setup is a sequence of manual README steps (sshd, UFW, fail2ban, LXD
  snap, an LXD profile pasted by hand, keys).
- It is hard-wired to one person: `/home/moroine` (`provision.ts`,
  `forge-image.sh`), `AllowUsers moroine` (`config/sshd_config`), `uid 1000`
  in the profile's `raw.idmap`, the bot's email, `omen` / `192.168.1.177` in
  the README.
- Session management is home-grown (tmux inside the container, attached by
  `forge`).
- It only runs on a dedicated server.

v2 is a redesign along two axes — **host hardening** and **container hardening
and configuration** — towards this architecture: the developer machine drives
an orchestrator on a host VM, which drives the agent in a system container; the
source code lives on a volume shared by host and container, and the developer's
own git retrieves the agents' work from that volume.

This is the **framing spec**. It records the cross-cutting decisions and the
boundaries between components. Each sub-project listed under "Sub-projects and
order" gets its own spec → plan → implementation cycle, and its spec settles
the details this document deliberately leaves to it.

## Goals

- Anyone can install agent-forge on their own VM (single user) from the repo,
  with no personal value hard-coded anywhere.
- The host is provisioned and hardened reproducibly (Ansible), for a public
  cloud VM as well as a LAN machine.
- Containers are configured and hardened by a tool that behaves identically on
  a remote host and on a developer machine (Linux and macOS at minimum).
- Session management relies on herdr instead of a home-grown tmux layer.

## Non-goals (designed for, not built in v2.0)

- **Autonomous mode** — bot account, PAT, commit-signing key, agent-opened PRs.
- **Super mode** — nested runtime to self-host agent-forge development.
- **Multi-user host ("B")** — several non-root users on one VM, each in an
  `incus-user` restricted project.
- **Image sharing** — simplestreams publication, CI-built images.
- **DNS exfiltration protection.**

Each of these must remain possible without restructuring: the mode concept
stays in provisioning and in `pre-bash.sh`; the image stays free of personal
data; container config avoids restricted-project-incompatible keys where it
can and lists the ones it cannot avoid.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Audience | One user per VM ("A"); nothing may preclude several non-root users on one VM ("B") | Open source first, team use later |
| Container runtime | Incus 7.0 LTS from the Zabbly repository, replacing LXD | Native packages (no snap), amd64 + arm64, `incus-user` for B, nftables-native |
| Host OS | Ubuntu 26.04 LTS | Ships Linux 7.0, which satisfies Incus 7.0's ≥ 6.12 requirement without an HWE kernel; Zabbly builds for `resolute` |
| Host provisioning | Ansible, run from the developer machine | Replaces the manual README steps |
| Host firewall | Native nftables, own table only, replacing UFW | Incus 7.0 is nftables-only; one syntax and one ruleset to audit instead of two tools writing into the same netfilter |
| Orchestration | herdr client on the dev machine, herdr server on the Incus host, agents in panes via `incus exec` | Containers stay sealed (no sshd, no herdr inside); one model for remote and local; herdr's control socket stays out of the agents' reach |
| Image build | Ansible playbook with the `community.general.incus` connection plugin | Same tool as the host; no SSH in the build container; CI-ready. Packer rejected: extra tool, third-party Incus plugin, fragile Packer → Ansible chaining |
| Git flow | Supervised only: no GitHub credential in containers; the host clones and fetches with the user's forwarded SSH agent; the dev machine fetches the work from the host workspace | Matches the target architecture; no bot account to set up |
| Exposure | One playbook, `forge_exposure: public \| lan \| local` | Cloud VM, homelab, and local Lima VM share one recipe |
| Container egress | Open by default with private ranges blocked; per-container opt-in domain allowlist | The default must stay usable (WebFetch, package installs); sensitive repos get a strict mode |
| Local mode | Linux: directly on the dev machine. macOS: a local Lima VM provisioned by the same playbook | Linux is "better than nothing"; macOS becomes remote mode with a local VM |
| Branching | v2 lives on a long-lived `next` branch; `main` stays v1 until release | omen keeps running v1, super mode included, to develop v2 |

## Architecture

### Layers and owners

| Layer | Where | Configured by | Contents |
|---|---|---|---|
| Dev machine | laptop | the user | herdr client, git, ssh (YubiKey), Ansible |
| Host | a VM (remote, or local Lima VM on macOS), or the dev machine itself (local Linux) | Ansible `ansible/site.yml` (not in local Linux mode) | Hardened OS; Incus installed and initialized; Node, Claude Code, ansible-core, `forge` |
| Runtime | the host's Incus | `forge setup`, in every mode | Incus project, profile, bridge, network ACLs, image, egress proxy |
| Container | an Incus instance | `forge start` | The agent, rootless Docker, Chrome DevTools MCP, `/workspace` |

**Boundary rule: Ansible never configures Incus internals, and `forge` never
touches the host OS.** Ansible stops once Incus is installed, initialized
(storage pool) and usable by the forge user. Everything inside Incus belongs to
`forge setup`, which is idempotent. This split is what makes local mode
possible: on a developer machine there is no Ansible and no OS hardening, but
the same `forge setup` produces the same containers. (`forge setup` also
installs forge's herdr key bindings, which is user-level configuration rather
than host OS configuration — see "herdr key bindings".)

Consequence: blocking the LAN moves from host-level `ufw route` rules to
**Incus network ACLs**, so it applies in local mode too. The host's own
nftables table still protects the host itself.

### Shareable vs personal

**Everything shareable goes into the image; everything personal is injected at
`forge start`.** The image contains nothing tied to a user — no token, key,
host path or host UID — which keeps future image sharing possible. Injected at
`forge start`: Claude credentials, the workspace mount, `CLAUDE.md`,
`pre-bash.sh`, Claude settings, onboarding state, the superpowers plugin.

### Repository layout

```
ansible/     site.yml (host), image.yml (container image), roles/, inventory.example.yml
cli/         forge — TypeScript run by Node's type stripping, as in v1
container/   files pushed into containers: CLAUDE.md, pre-bash.sh, settings.json, onboarding state
docs/
```

`config/sshd_config` and `config/jail.local` become Ansible role templates.
`scripts/lib/forge-image.sh` is replaced by `ansible/image.yml`. The repo's own
`.claude/settings.json` points its hook at `container/pre-bash.sh`. The README
becomes an installation guide per mode: remote, local Linux, local macOS.

## Host (sub-project 1)

Target: a fresh Ubuntu 26.04 LTS VM. Run from the dev machine:
`ansible-playbook -i inventory.yml ansible/site.yml`.

### Accounts

- **admin** — sudo, key-only, used by Ansible alone, never agent forwarding.
- **forge users** — listed in `forge_users` (one in v2.0); no sudo; their own
  SSH keys; agent forwarding allowed; group `incus-admin` in v2.0 (root
  equivalent, accepted on a single-user VM), group `incus` once B lands.

The split is mostly structural in v2.0, since `incus-admin` is root
equivalent. It is the right shape for B, and it keeps day-to-day work off a
sudo account.

### Roles

1. **`base`** — unattended security upgrades, NTP, headless (sleep targets
   masked), persistent journald.
2. **`hardening`** — the `devsec.hardening` collection (`os_hardening`,
   `ssh_hardening`) with documented overrides. At minimum `ip_forward` must
   stay enabled or the Incus bridge breaks. SSH: keys only, configurable port,
   `PermitRootLogin no` (v1 had `yes`), agent forwarding for forge users only,
   and exactly the forwarding features herdr's remote attach needs (see
   "Validation spike"). Ubuntu 26.04 ships `sudo-rs` and Rust coreutils by
   default; the role is tested against them.
3. **`firewall`** — nftables, one table of our own, `inet forge_host`.
   The file deletes and recreates that table only, **never `flush ruleset`**:
   Ubuntu's default `/etc/nftables.conf` starts with it, and reloading it would
   wipe Incus's tables and cut container networking until Incus restarts.
   - Input: established/related and loopback accepted; SSH accepted on the
     external interface only — rate-limited and restricted to
     `ssh_allowed_sources` when `public`; from the forge bridge only DHCP and
     DNS; everything else dropped.
   - Forward: drop by default; forge bridge ↔ external interface accepted,
     with fine-grained filtering delegated to the Incus ACLs.
4. **`fail2ban`** — sshd jail with nftables actions (`nftables-multiport`
   instead of v1's `iptables-ipset-proto6`); stricter when `public`; off when
   `local`.
5. **`incus`** — Zabbly `lts-7.0` repository, install, `incus admin init` with
   a storage pool (driver choice — `dir` or `btrfs` — settled in the
   sub-project 1 spec). The role stops there.
6. **`forge_users`** — account, keys, groups, Node 24, Claude Code (so the user
   can `claude auth login`), ansible-core (image builds), `forge`. Installs a
   `~/.ssh/rc` that repoints a stable `~/.ssh/agent.sock` at each login, and
   sets `SSH_AUTH_SOCK` to it (see "Stable SSH agent"). herdr is **not**
   installed by Ansible: it installs itself in `~/.local/bin` on the first
   `herdr --remote`, at the client's version, which avoids client/server
   version conflicts.

### `forge_exposure`

| Value | Use | Differences |
|---|---|---|
| `public` | cloud VM with a public IP | fail2ban strict, SSH rate limit, `ssh_allowed_sources` honored |
| `lan` | homelab / LAN machine | fail2ban on |
| `local` | local Lima VM on macOS | no fail2ban, SSH on Lima's forwarded port |

### Tests

`ansible-lint`; a full run on a throwaway VM (`incus launch --vm`, or Lima); a
second run must report zero changes; smoke checks (`sshd -t`,
`nft list table inet forge_host`, `incus info`).

## Runtime (sub-projects 2 and 3)

### `forge setup` — idempotent, every mode

- **Project** `agent-forge`: forge's instances stay apart from anything else on
  the host's Incus.
- **Bridge** `forgebr0`, IPv6 disabled in v2.0.
- **ACL `forge-egress`**, applied at the NIC level through the profile — which
  also isolates containers from each other, not only from the LAN:
  - egress reject to `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
    `169.254.0.0/16` (this includes the cloud metadata service
    `169.254.169.254`), `100.64.0.0/10`, `224.0.0.0/4`;
  - default egress action `allow`; default ingress action `reject`.
- **Profile `agent-forge`**:
  - unprivileged; `security.nesting=true` for rootless Docker; seccomp deny
    list;
  - limits on CPU, memory, root disk, and **process count** (new: fork-bomb
    protection), configurable in forge's config;
  - `raw.idmap` computed from the forge user's actual UID/GID — no hard-coded
    `1000`;
  - capability drops via `raw.lxc` kept in v2.0.
- **Restricted-project compatibility (for B).** `raw.idmap` remains possible
  inside admin-granted `restricted.idmap.uid` / `restricted.idmap.gid` ranges.
  `raw.lxc` does not: under B the capability drops need a replacement or are
  accepted as lost — they are defense in depth only, since `aiuser` holds no
  capabilities. The sub-project 2 spec lists every key used and its status
  under a restricted project.

### Image

- Built by `ansible/image.yml` through `community.general.incus`, for the
  host's architecture (amd64 or arm64); `forge image build` runs it.
- Roles mirror v1's `forge-image.sh`: base packages, git + git-lfs, Node LTS +
  pnpm, Claude Code, rootless Docker + Compose, Chrome + `chrome-devtools-mcp`,
  user `aiuser` (UID 1001), `/workspace`. `gh` is dropped until autonomous mode
  returns: in supervised mode it is unusable (no credential) and blocked by
  `pre-bash.sh` anyway.
- Base `images:ubuntu/26.04/cloud`; fall back to 24.04 if a third-party
  repository (Docker, Chrome) does not ship 26.04 packages yet. On arm64, use
  Chromium if Chrome still has no linux/arm64 build.
- Stamped with the build's commit (`user.forge.commit`), as in v1; `forge list`
  keeps comparing it against each container's stamp.

### Optional egress allowlist (sub-project 3)

- A `forge-proxy` container, managed by `forge setup`, runs a forward HTTP(S)
  proxy that filters by domain.
- A strict container gets ACL `forge-egress-strict` (default egress reject;
  only the proxy's address and port allowed) and `HTTP_PROXY` / `HTTPS_PROXY`,
  including in the rootless Docker daemon's environment. It fails closed: a
  program that ignores the proxy reaches nothing.
- v2.0: one allowlist per user; strict mode toggled per container.
- Known limit: DNS to the bridge is a baseline service that Incus allows before
  any ACL rule, so DNS tunneling stays possible. Documented, deferred.

## Orchestration (sub-project 4)

### Daily flow (remote)

1. On the dev machine: `herdr --remote forge-vm`, with `ForwardAgent yes` in
   the ssh config for that host.
2. In the local herdr UI, press the forge key (e.g. `prefix+n`). herdr custom
   commands belong to the server where the panes run, so **the host's herdr
   server runs `forge start`**, in a popup displayed by the local client. The
   popup shows `forge start`'s usual menus (repo, then task: new task, existing
   worktree, branch…). Typing `forge start owner/repo task` in a host pane
   remains possible and does the same thing.
   - First time: the host clones `git@github.com:owner/repo` into
     `~/workspaces/<container>` with the forwarded agent; the container is
     created from the image, the workspace mounted, the personal files
     injected.
   - `git fetch origin` runs **on the host**, with the forwarded agent. New:
     v1 supervised containers could not refresh `main` at all.
   - The worktree `/workspace/.trees/<task>` on `agent/<task>` is created
     inside the container, as in v1.
   - `forge` opens a herdr tab named `<repo>/<task>` running `forge attach`:
     `incus exec <container> --user 1001 … -- claude --permission-mode auto
     --remote-control <container>-<task>`, with `HERDR_AGENT=claude` set on
     the host-side wrapper so herdr recognizes the agent. It drives herdr
     through its CLI (`tab create`, `pane run`), reached through the
     `HERDR_BIN_PATH` and `HERDR_SOCKET_PATH` that herdr passes to custom
     commands and panes.
   - The popup closes; the new tab with the agent appears in the local UI.
3. Retrieval: from the dev machine, `git fetch` from
   `ssh://forge-vm/~/workspaces/<container>`. `forge` prints the command, as in
   v1.

### Changes to `forge`

- tmux leaves the container; herdr provides persistence.
- `forge resume` runs `claude --continue` in the worktree. The conversation
  survives a herdr server restart without depending on herdr's own resume
  integration, whose hooks would live in the container and could not reach the
  host-side herdr socket.
- Outside herdr (no `HERDR_ENV`), `forge start` / `forge resume` attach in the
  foreground. No persistence in that case; documented.
- Commands: `setup` (new), `image build`, `start`, `resume`, `finish`, `stop`,
  `delete`, `list`, `completion`.
- Worktrees stay managed by `forge`, inside the container. herdr's own
  worktrees would record host paths that do not exist inside the container.

### herdr key bindings

`forge setup` installs forge's herdr custom commands in the forge user's herdr
config (`~/.config/herdr/config.toml`), for example:

```toml
[[keys.command]]
key = "prefix+n"
type = "popup"
command = "forge start"
description = "new forge task"
```

- `forge setup` owns this because it is the only command present in every
  mode, local Linux included, where there is no Ansible. herdr's config is
  user-level configuration, not host OS configuration, so the boundary rule
  ("`forge` never touches the host OS") holds.
- It is a delimited, idempotent block: `forge setup` rewrites its own block and
  never touches the rest of the user's herdr config. If herdr supports
  including a separate file (spike 9), `forge setup` writes its own file and
  adds a single include line instead.
- v2.0 binds `forge start` only. `resume` / `finish` bindings follow the same
  pattern later.

### Stable SSH agent

The herdr server outlives the SSH session that started it, while a forwarded
agent socket dies with its session: panes would keep a dead `SSH_AUTH_SOCK`.
The `~/.ssh/rc` installed by the `forge_users` role repoints
`~/.ssh/agent.sock` at each login, and the herdr server and its panes use that
path. When the user is disconnected, a host-side `git fetch` fails with a clear
message.

## Local mode (sub-project 5)

### Linux — directly on the dev machine

- Documented prerequisites: Incus (distribution package or Zabbly),
  `incus admin init --minimal`, Node 24, Ansible, Claude Code, herdr.
- Same commands: `forge setup`, `forge image build`, `forge start`. Workspaces
  in `~/workspaces/`; herdr runs locally; the git remote is a local path.
- `forge setup` detects that there is no VM between the containers and the dev
  machine and says so: an escaped container lands on the developer's machine,
  with its keys and sessions.
- Open point (spike 5): on a VM, the host's nftables input chain keeps
  containers away from host services on the bridge IP. On a Linux dev machine
  only the Incus ACL is there, and its documentation does not say whether it
  filters container → host traffic. If it does not, the README documents a
  manual nftables rule — `forge` does not touch the host OS.

### macOS — local Lima VM

- A Lima Ubuntu 26.04 VM provisioned by `ansible/site.yml` with
  `forge_exposure: local`, then used exactly like remote mode:
  `herdr --remote forge-local`, retrieval with `git fetch` over SSH.
- Workspaces stay inside the VM. Sharing a Mac folder into the VM (virtiofs)
  would bring UID mapping across Mac, VM and container, and slow
  `node_modules`.
- Images are built for arm64 on Apple Silicon.
- Colima with `--runtime incus` rejected: a second installation path to
  maintain, and no hardening.

## Security model summary

| Threat | Mitigation |
|---|---|
| Agent escapes its container | Unprivileged container, seccomp, capability drops, Incus' AppArmor profile. Remote: lands in the VM. Local Linux: lands on the dev machine (accepted, warned) |
| Container pivots to the LAN or cloud metadata | `forge-egress` ACL rejects private, link-local, CGNAT and multicast ranges; IPv6 off |
| Container reaches host services | Host nftables input accepts only DHCP/DNS from the bridge. Local Linux: Incus ACL only (spike 5) |
| Containers reach each other | ACL applied at the NIC level |
| Agent exfiltrates code or the Claude token | Accepted with open egress (default); strict allowlist per container; DNS remains a known gap |
| Agent publishes to GitHub | No GitHub credential in containers; `pre-bash.sh` blocks `git push` and `gh` |
| Agent drives other agents' panes | herdr's control socket lives on the host, outside every container |
| SSH brute force | Keys only, fail2ban, rate limit and source restriction when `public` |
| Forwarded agent abused on the host | YubiKey touch per use; the admin account never forwards; containers never receive the agent |
| Forge user is root equivalent | Accepted for A (`incus-admin`); B moves users to the `incus` group and restricted projects |

## Validation spike

Throwaway work, done before the sub-project 2 and 4 specs; each result is
recorded in the spec it affects.

1. herdr's CLI can open a named tab that runs a command: exact syntax of
   `herdr tab create` and `herdr pane run` (tab name, working directory), which
   the CLI reference pages fetched during brainstorming did not detail.
2. `HERDR_AGENT=claude` detection works through `incus exec`.
3. Which SSH features herdr's remote attach needs (stdio only, or Unix-socket
   forwarding) — feeds `ssh_hardening`.
4. How `claude --continue` behaves after a herdr server restart.
5. Whether a bridge ACL filters container → host traffic.
6. Chrome on linux/arm64, or the Chromium fallback.
7. (for later) A nested Incus installed via apt works without restoring
   `mac_admin`, `mac_override` and `sys_ptrace`.
8. A custom command defined in the host's herdr config fires from a
   remote-attached client with its default (local) key bindings, or only with
   `--remote-keybindings server`. herdr's docs are ambiguous: local bindings
   apply by default, and local custom commands are not sent to the server. If
   the flag is required, the README's attach command includes it.
9. Whether herdr's config supports including a separate file (see "herdr key
   bindings").

## Sub-projects and order

| # | Sub-project | Deliverable | Depends on |
|---|---|---|---|
| 1 | Host | `ansible/site.yml` with its six roles, nftables, `forge_exposure`; light CI (unit tests, `tsc`, `ansible-lint`) | — |
| 2 | Runtime | CLI ported from `lxc` to `incus`; `forge setup`; image built by Ansible; profile and ACLs; autonomous and super modes and the bot account disabled | — (any Incus) |
| 3 | Egress allowlist | `forge-proxy`, strict ACL, per-container toggle | 2 |
| 4 | Orchestration | herdr integration and key bindings (`forge start` popup), tmux removal, `forge resume` via `--continue`, host-side fetch | 2, spike |
| 5 | Local mode and docs | Linux direct, macOS Lima, README per mode, no personal value left | 1, 2 |

Sub-projects 1 and 2 can run in parallel.

## Transition

- `next` is branched from `main`; this spec is its first commit. v2 pull
  requests go from `agent/*` to `next`.
- `main` stays v1 (LXD). omen keeps running it, super mode included, to
  develop v2. v1 fixes keep landing on `main`, and `main` is merged into
  `next` regularly (agents may already `git merge origin/main`).
- **Prerequisite pull request on `main`**, because v1 assumes `main`
  everywhere and v1 is what runs the agents building v2:
  - `pre-bash.sh` also accepts `git merge origin/next`.
  - `templates/CLAUDE.md`: a PR's base is the branch the task came from
    (`main` by default), and the project's `CLAUDE.md` may specify it. On
    `next`, the repo's `CLAUDE.md` says `--base next`.
  - v2 tasks start from `forge start`'s "other branch…" entry with
    `origin/next`. No code change.
- v2 tests cannot run inside a v1 super container: it embeds a nested LXD, not
  Incus, and a VM cannot run inside a container. Playbook tests run on a
  throwaway VM (Lima on the Mac, or an LXD VM on omen); runtime tests run on a
  test Incus.
- Release: a pull request from `next` to `main`, merged by the user. Then omen
  migrates: first retrieve every unpushed supervised branch from
  `~/workspaces` (the only copy), then reinstall on 26.04 (or provision a new
  VM) and apply the playbook.

## Testing strategy

- **Unit** — Node's test runner with a fake `incus` (successor of
  `fake-lxc`) and a fake herdr CLI. Covers the idempotence of `forge setup`'s herdr
  config block.
- **Contract** — real `git` and the real `herdr` binary (successor of the tmux
  contract test).
- **Integration** (opt-in, `FORGE_INTEGRATION=1`) — real Incus, throwaway
  project. Network checks from inside a container: the internet answers;
  `10.x`, `192.168.x` and `169.254.169.254` do not; two containers cannot reach
  each other; in strict mode only allowlisted domains pass; reloading the host
  firewall leaves container networking intact.
- **Ansible** — `ansible-lint`, a throwaway VM, an idempotent second run.
