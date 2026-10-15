# agent-forge v2, sub-project 2: Runtime — Design

**Date:** 2026-10-15
**Status:** Approved by the user (2026-10-15)
**Branch:** `agent/v2-runtime-spec` → `next`
**Framing spec:** `docs/superpowers/specs/2026-10-15-v2-incus-ansible-herdr-design.md`
**Spike report:** `docs/superpowers/spikes/2026-10-15-v2-validation-spike.md`

## Context

The framing spec splits v2 into five sub-projects. This is sub-project 2, the
**runtime**:

- the `forge` CLI ported from `lxc` to `incus`;
- `forge setup`, which owns everything inside Incus: project, bridge, network
  ACL, profile;
- the container image, built by Ansible;
- autonomous and super modes, and the bot account, disabled.

It depends on any working Incus, not on sub-project 1. Sub-project 1 (host,
Ansible) is specified in parallel; the "Host contract" section below is the
interface between the two.

The validation spike changed several framing-spec assumptions. The blocking one:
on an Ubuntu 26.04 host, `kernel.apparmor_restrict_unprivileged_userns=1`
prevents `aiuser` from creating user namespaces inside the container, which
breaks rootless Docker (`rootlesskit`) and Chrome's sandbox. This spec settles
it, along with the bridge address, the ACL's limits, the image contents, the
`raw.idmap`, the CLI's stdin handling and the restricted-project key list.

## Scope

**In:**

- Port every `lxc` call to `incus --project <project>`.
- New command `forge setup`.
- `forge image build`, with the lifecycle in `forge` and the configuration in
  `ansible/image.yml` (role `forge_image`).
- Provisioning reduced to supervised mode: no PAT, no `gh`, no signing key, no
  bot identity.
- `raw.idmap` computed from the forge user's real UID/GID.
- No personal value left in the CLI or the container files.
- The framing spec's repository layout for the runtime parts (`cli/`,
  `container/`).

**Out (owner in parentheses):**

- herdr integration, tmux removal, host-side `git fetch`, `forge resume` via
  `claude --continue` (4). Until then the CLI keeps v1's tmux attach.
- Egress allowlist, `forge-proxy`, `forge-egress-strict` (3).
- README per mode, "no VM between containers and your machine" warning, macOS
  Lima specifics (5).
- Host OS, nftables, Incus installation, sysctls (1).
- Multi-user hosts (B), super mode, autonomous mode, image sharing: framing-spec
  non-goals. This spec keeps them possible and lists what B needs.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| User namespaces in containers | **Host requirement.** The host sets `kernel.apparmor_restrict_unprivileged_userns=0` and keeps `kernel.unprivileged_userns_clone=1`. Ansible does it on a VM (sub-project 1); a README step does it in local Linux mode. `forge setup` only reads the values and stops with the exact fix | Rootless Docker inherently gives `aiuser` user namespaces: once `rootlesskit` may create one, `rootlesskit bash` gives a full one for any command. Per-binary AppArmor profiles in the container therefore expose the same kernel surface to the agent, while costing `mac_admin` and an untested setup. The LXD snap has always set this sysctl on omen, so v1 already runs this way |
| Chrome sandbox | Kept. No `--no-sandbox` | Works once the host requirement holds (spike point 6) |
| Degraded mode when the sysctl is 1 | None. `forge setup` refuses | One supported configuration to test |
| Agent's git identity | The host user's `git config --global user.name` / `user.email`; commits unsigned (`commit.gpgsign=false`); Claude Code's `Co-Authored-By` trailer kept. The user re-signs when publishing | No signing key in containers (framing non-goal) and no bot account. The trailer still marks the agent's commits |
| Image build lifecycle | Driven by `forge` (TypeScript); the playbook only configures one given instance | The lifecycle is unit-tested with the fake `incus` like the rest of the CLI; the playbook stays plain configuration |
| Base image | `images:ubuntu/26.04` (no cloud-init) instead of `/cloud` | Nothing uses cloud-init. With it, every new instance recreates the `ubuntu` account and its passwordless sudo, which v1 deletes at each provisioning |
| Claude Code in the image | Anthropic's apt repository, `stable` channel | Same source as the host (sub-project 1); root-owned binary the agent cannot modify; signed repository |
| Node in the image | NodeSource `node_<major>.x`, `forge_image_node_major: 24` | Same major as the host. Node 24 enters maintenance on 2026-10-20 and is supported until 2028-04; moving to 26 is a variable change |
| forge's config | `~/.config/agent-forge/config.json`, optional, every key defaulted | JSON parses natively in Node: no dependency |
| Incus objects | Declarative convergence: read with `list -f json`, compare, write the whole object only when it differs | Idempotent by construction; a second `forge setup` makes no mutating call |
| Bridge address | Explicit, configurable, default `10.77.0.1/24` | `ipv4.address=auto` fails under Lima (spike finding A) |
| ACL placement | At NIC level, through the profile | Verified by the spike: also covers container → host and container → container (point 5) |
| Networks and ACLs | In the `default` project; project `agent-forge` has `features.networks=false` | A project with `features.networks=true` can hold only OVN networks, not a bridge (Incus v7.0.1 source) |

## Repository layout

The move happens first, as one mechanical commit with no behaviour change:

| v1 | v2 |
|---|---|
| `scripts/forge`, `scripts/forge.ts`, `scripts/lib/` | `cli/forge`, `cli/forge.ts`, `cli/lib/` |
| `templates/CLAUDE.md` | `container/CLAUDE.md` |
| `config/claude-container-settings.json` | `container/settings.json` |
| `config/claude-onboarding-state.json` | `container/claude.json` |
| `.claude/hooks/pre-bash.sh` | `container/pre-bash.sh` (the repo's `.claude/settings.json` points at it) |

- `cli/forge` is a contract with sub-project 1, which links
  `/usr/local/bin/forge` to it.
- Deleted later in this sub-project: `scripts/lib/forge-image.sh`,
  `config/lxd-agent-profile.yaml`, `config/lxd-agent-super-profile.yaml`, and
  their tests (`test-forge-image*.sh`, `test-lxd-agent*-profile.sh`,
  `tests/integration/super-lxd.test.ts`).
- `config/sshd_config` and `config/jail.local` belong to sub-project 1, which
  turns them into role templates.
- `ansible/image.yml` and `ansible/roles/forge_image/` are this sub-project's.
  Sub-project 1 owns `ansible/site.yml`, `ansible/requirements.yml`, its six
  roles, `ansible/tests/` and the root `.ansible-lint`, which lints all of
  `ansible/`. Neither sub-project creates an `ansible.cfg`.
- The repo's own `CLAUDE.md` gets its paths updated (`cli/`, `container/`).
  The README stays v1 until sub-project 5 rewrites it; `test-readme-docs.sh` is
  only adjusted for moved files.

## Host contract

What the runtime needs from the host. Sub-project 1 provides it on a VM; in
local Linux mode the README (sub-project 5) lists it. `forge` never changes the
host OS: `forge setup` checks each point **read-only** and stops at the first
failure with the command that fixes it.

| Check | Pass condition | Why |
|---|---|---|
| User | not root | `raw.idmap` maps the caller's UID/GID |
| Incus | `incus info` succeeds | |
| Firewall driver | `environment.firewall` is `nftables` in `incus info` | ACLs on a bridged NIC require it |
| userns restriction | `/proc/sys/kernel/apparmor_restrict_unprivileged_userns` absent or `0` | Rootless Docker and Chrome's sandbox (spike point 6) |
| userns clone | `/proc/sys/kernel/unprivileged_userns_clone` absent or `1` | At `0` it also blocks root inside unprivileged containers (the check is `capable(CAP_SYS_ADMIN)` against the initial namespace) |
| Storage pool | the configured pool exists | The profile's root disk uses it |
| IPv4 forwarding | `/proc/sys/net/ipv4/ip_forward` is `1`, checked after the bridge exists | Without it containers have no network, a confusing failure |

- The messages give the fix for both modes: on a VM, re-run the playbook; in
  local Linux mode, a `sysctl -w` and a file under `/etc/sysctl.d/`.
- Incus 7.0 LTS is the tested version. `forge setup` does not gate on the
  version, because Ubuntu 26.04's archive ships 6.0.5, a likely choice in local
  Linux mode; 6.0 is expected to work but untested.
- Agreed with sub-project 1:
  - sysctls `apparmor_restrict_unprivileged_userns=0`,
    `unprivileged_userns_clone=1`, `ip_forward=1`, `yama.ptrace_scope=1`;
  - the bridge name `forgebr0` is a shared constant, and the host nftables
    rules match it by interface name, never by subnet;
  - IPv6 stays off on the bridge;
  - storage pool `default`;
  - the `ansible` apt package (ansible-core 2.20 and community.general 12.1);
  - forge is installed read-only, without `.git`, and a `COMMIT` file at the
    release root holds the commit.

## forge's configuration

`~/.config/agent-forge/config.json` (`$XDG_CONFIG_HOME` honoured). The file is
optional; these are the defaults:

```json
{
  "network": { "ipv4Address": "10.77.0.1/24" },
  "storagePool": "default",
  "limits": { "cpu": null, "memory": "75%", "processes": 10000, "rootDisk": "50GiB" }
}
```

- `network.ipv4Address`: the bridge's address with its prefix. It must lie in
  `10.0.0.0/8`, `172.16.0.0/12` or `192.168.0.0/16`, so that `forge-egress` also
  blocks the bridge address itself.
- `limits.cpu`: `null` means no limit; otherwise a number of CPUs (`4`) or a
  string Incus accepts for `limits.cpu` (`"0-3"`).
- `limits.memory`: a string, an Incus size (`"12GiB"`) or a percentage of host
  memory (`"75%"`).
- `limits.processes`: a positive integer. The pids cgroup counts threads, and
  Chrome, Node and Docker use many. 10 000 leaves room and still stops a fork
  bomb.
- `limits.rootDisk`: on btrfs this is a soft limit, because nested subvolumes
  escape qgroups.
- Unknown keys and invalid values are errors that name the file and the key.
  A typo must not be silently ignored.
- v1's values (8 CPU, 12 GB, 100 GB) were sized for one machine. A user who
  wants them sets them in this file.

## `forge setup`

Idempotent; run once per host, and again after changing the config. Every mode
runs it (VM, local Linux, Lima). Sub-project 4 later adds the herdr key
bindings as one more step.

1. Check the host contract (except IPv4 forwarding).
2. Read and validate the config.
3. Converge the objects below, in order.
4. Check IPv4 forwarding.
5. Warn if a host IPv4 address (`os.networkInterfaces()`, non-internal, other
   than the bridge's) lies outside the ACL's rejected ranges. Containers can
   reach host services on that address unless a host firewall drops bridge
   traffic, which the Ansible host does. A dev machine with a public address
   does not (spike point 5).
6. Print one line per object: `created`, `updated` or `unchanged`.

### Objects

| Object | Incus project | Desired state | Policy |
|---|---|---|---|
| Project `agent-forge` | — | `features.images=true`, `features.profiles=true`, `features.storage.volumes=true`, `features.networks=false` | Created if missing. If present, the features are checked, never edited: under B the project belongs to the admin |
| Bridge `forgebr0` | `default` | `ipv4.address=<config>`, `ipv4.nat=true`, `ipv6.address=none` | Converged |
| ACL `forge-egress` | `default` | One egress rule: `action: reject`, `state: enabled`, destination `10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,100.64.0.0/10,224.0.0.0/4`. No ingress rule | Converged |
| Profile `agent-forge` | `agent-forge` | See below | Converged |

Profile `agent-forge`:

```yaml
config:
  environment.HOME: /home/aiuser
  security.privileged: "false"
  security.nesting: "true"            # rootless Docker
  security.syscalls.deny_default: "true"
  limits.memory: "75%"                # from the config
  limits.processes: "10000"           # from the config
  # limits.cpu only when the config sets it
  raw.idmap: "uid <getuid()> 1001\ngid <getgid()> 1001"
  raw.lxc: <v1's capability drops, unchanged>
devices:
  eth0:
    type: nic
    name: eth0
    network: forgebr0
    security.acls: forge-egress
    security.acls.default.egress.action: allow
    security.acls.default.ingress.action: reject
  root:
    type: disk
    path: /
    pool: default                     # from the config
    size: 50GiB                       # from the config
```

- `raw.lxc` is omitted when the project has `restricted=true` without
  `restricted.containers.lowlevel=allow`, with a notice that the capability
  drops are lost there (see the next section). They are defense in depth only:
  `aiuser` holds no capabilities.
- The project's own `default` profile stays empty. Instances get only
  `--profile agent-forge`.

### Convergence rules

- **State is read** with `incus project|network|network acl|profile list -f json`
  and the object is compared field by field (`description`, `config`, `devices`,
  ACL rules).
- **Writes:**
  - a missing object is created with its whole desired state on stdin;
  - a differing object gets one `edit` with its whole desired state on stdin;
  - `volatile.*` keys belong to Incus: they are ignored by the comparison and
    carried over in the edit.
- **Format:** the desired state is written as JSON. Incus parses its input as
  YAML, and YAML 1.2 is a superset of JSON. The first integration test checks
  it.
- **Ownership:** forge owns the bridge, the ACL and the profile. A manual
  change to them is reverted by the next `forge setup`, which says so
  (`updated`).
- **Bridge address changes:** when `ipv4.address` changes while containers run
  on `forgebr0`, `forge setup` warns that they lose their network until
  restarted.

## Restricted-project compatibility (for B)

Required by the framing spec. Verified against the Incus v7.0.1 source
(`internal/server/project/permissions.go`, `device/disk.go`,
`device/nic_bridged.go`) and covered by an integration test (see "Testing").

| Key or device | Restricted project, default | What the admin sets |
|---|---|---|
| `security.privileged=false` | allowed | — |
| `security.nesting=true` | **blocked** | `restricted.containers.nesting=allow` |
| `security.syscalls.deny_default` | allowed | — |
| `environment.HOME`, `user.forge.*` | allowed | — |
| `limits.memory`, `limits.processes`, `limits.cpu` | allowed | If the admin sets project-level `limits.*`, every instance must declare those keys. A project `limits.cpu` would then require `limits.cpu` in forge's config |
| `raw.idmap` (in a profile) | **blocked** unless both `restricted.containers.lowlevel` and `restricted.virtual-machines.lowlevel` are `allow` | `restricted.idmap.uid` / `restricted.idmap.gid` ranges containing the forge user's UID and GID |
| `raw.lxc` | **blocked** | `restricted.containers.lowlevel=allow`, or accept the loss; forge omits it (see above) |
| `workspace` disk, host path `source=~/workspaces/<c>` | **blocked** | `restricted.devices.disk=allow`, ideally with `restricted.devices.disk.paths=<home>/workspaces` (forge uses no `shift`, which that key forbids) |
| `root` disk with `pool` and `size` | allowed | The pool must be in `restricted.storage-pools.access` when that key is set |
| `eth0` NIC on `forgebr0` | allowed | `forgebr0` must be in `restricted.networks.access` when that key is set |
| `security.acls*` on the NIC | allowed (no project check) | The ACL must exist in the NIC's network project, `default` |
| Bridge `forgebr0`, ACL `forge-egress` | a restricted user cannot create them in `default` | Created by the admin (or by an admin-run `forge setup`) |

Incus' `stable-7.0` branch, after v7.0.1, adds a way to share default-project
networks through `restricted.networks.access`. This table is re-checked when
B is designed.

## Image

### `forge image build`

The image is built for the host's architecture (amd64 or arm64). Steps:

1. **Preconditions.**
   - The host contract holds, and `forge setup` has run: the project and
     profile exist.
   - `ansible-playbook` is on PATH, and
     `ansible-doc -t connection community.general.incus` succeeds.
2. **Clean up.** Delete a leftover `forge-image-build` instance from a failed
   build.
3. **Launch.**
   - `incus --project agent-forge launch images:ubuntu/26.04 forge-image-build --profile agent-forge`.
   - The profile brings nesting, network and the ACL; rootless Docker needs
     nesting to start its daemon during the build, as in v1.
   - The name does not start with `agent-`, so `forge list` never shows it.
4. **Wait for the instance.** Run `systemctl is-system-running --wait`, and
   accept `running` or `degraded` as ready (the helper is shared with
   provisioning).
5. **Configure.** forge attaches `ansible-playbook` to the terminal:
   - inventory `-i forge-image-build,`;
   - the extra vars `ansible_connection=community.general.incus`,
     `ansible_incus_project=<project>` and `ansible_pipelining=true`;
   - the playbook `<repo root>/ansible/image.yml`.

   Nothing is written in the repo directory, which is read-only on an Ansible
   host.
6. **Publish.**
   - Record the fingerprint of the current `agent-base`, if any.
   - `incus stop forge-image-build`, then
     `incus publish forge-image-build --alias agent-base --reuse`.
   - `incus image set-property agent-base user.forge.commit <commit>`.
   - Delete the previous image by its fingerprint, and delete the build
     instance.

   Unlike v1, an `agent-base` image exists at every moment.
7. **Find the commit.**
   - Read `<repo root>/COMMIT`, written by sub-project 1's installation.
   - Otherwise run `git -C <repo root> rev-parse HEAD` (checkout, local mode,
     development).
   - If neither works, fail before step 3.

On failure the build instance is left in place for debugging; step 2 removes it
next time.

### `ansible/image.yml` and role `forge_image`

- **Play.** `image.yml` is one play on `hosts: all`, connecting as root. It has
  `gather_facts: false`, a `raw` task that installs `python3` if missing, then
  `ansible.builtin.setup` and the role.
- **Per-user steps.** Steps that must run as `aiuser` (rootless Docker setup,
  `systemctl --user`) use `command: su - aiuser -c '…'`, as v1 does, not
  Ansible's `become`:
  - `su -` opens a PAM session, which provides `XDG_RUNTIME_DIR`;
  - the community.general 12.1 that Ubuntu ships predates the fix for
    become methods that need a tty.
- **Architecture.** The architecture comes from `dpkg --print-architecture`.
  Anything other than `amd64` or `arm64` fails at once.
- **Apt repositories.** They are declared with
  `ansible.builtin.deb822_repository`, with each vendor's key fetched over
  HTTPS, as in v1.

Task files, in order:

| File | Contents |
|---|---|
| `base.yml` | `apt update` (with retries, since the instance's network may come up late), then git, git-lfs, tmux (until sub-project 4), curl, wget, unzip, zip, python3, python3-pip, ca-certificates |
| `node.yml` | NodeSource `node_{{ forge_image_node_major }}.x` (`nodistro`), `nodejs`, `npm install -g pnpm` |
| `claude.yml` | Anthropic apt repository (`stable`), package `claude-code` |
| `chrome.yml` | Google's apt repository, `google-chrome-stable` (amd64 and arm64); `npm install -g chrome-devtools-mcp` |
| `docker.yml` | Docker's apt repository (suite `resolute`): `docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-ce-rootless-extras`, `docker-compose-plugin`, `uidmap`, `dbus-user-session`. Rootful `docker`/`containerd` units disabled and masked |
| `aiuser.yml` | `useradd -m -u 1001 -U -s /bin/bash aiuser`; `/workspace` (750), `~/.claude`, `~/.local/bin`; a final `chown -R aiuser:aiuser /home/aiuser`, which handles the profile's `environment.HOME` creating `/home/aiuser` as root before `useradd`, as in v1 |
| `rootless_docker.yml` | aiuser's subuid/subgid replaced by `200000:65536`; `loginctl enable-linger aiuser`; `dockerd-rootless-setuptool.sh install --skip-iptables`; `systemctl --user enable docker`; `DOCKER_HOST` in `~/.bashrc` |
| `verify.yml` | Below |

Role defaults: `forge_image_node_major: 24`, `forge_image_aiuser_uid: 1001`,
`forge_image_subid_start: 200000`, `forge_image_subid_count: 65536`.

Dropped from v1's image: `gh` (unusable without a credential, and blocked by
`pre-bash.sh`), snapd, `~/.ssh`. The image holds no personal data: credentials
and every personal file are injected at `forge start`.

### Verification (`verify.yml`)

The play ends with checks that fail the build. They also guard against
community.general 12.1 silently ignoring failed file transfers, and they test
the user-namespace requirement end to end:

- `node`, `pnpm`, `claude`, `google-chrome-stable`, `chrome-devtools-mcp`,
  `docker`, `docker compose`, `git lfs` and `tmux` all answer, and Node's major
  version is the expected one.
- `aiuser` has UID 1001 and GID 1001.
- No account other than `root` and `aiuser` has a login shell, and
  `/etc/sudoers.d/` holds no rule.
- As `aiuser`: `unshare -Ur true` succeeds.
- As `aiuser`: Chrome headless, **with** its sandbox and a throwaway
  `--user-data-dir`, dumps `about:blank`.
- As `aiuser`: `docker info` reports `rootless`.

## CLI port

### Transport: `cli/lib/incus.ts` (was `lxd.ts`)

- Every call is `incus --project <project> …`.
  - `<project>` is `agent-forge`. The environment variable
    `FORGE_INCUS_PROJECT` overrides it for tests only and is not documented
    for users.
  - The bridge and the ACL keep their names whatever the project, in `default`.
- **stdin rule.** `incus profile|network|network acl|project create|edit` read
  YAML from stdin when it is not a terminal, and an empty stdin replaces the
  object with an empty one. So:
  - every `create` / `edit` passes the object's whole desired state as `input`;
  - no `incus` command that reads stdin goes through `ctx.attach`, which
    inherits the terminal;
  - `ctx.exec` already closes stdin, so nothing hangs. The risk left is
    wiping, and the fake `incus` models it.
- **Values reach Incus and the container as argv elements**, never
  interpolated into a shell string. `execAsAgent` keeps its script form only
  for fixed scripts whose interpolated names went through `validate.ts`.
- `attachArgv` changes only its binary and project:
  `incus --project agent-forge exec <c> --user 1001 --group 1001 … -- tmux …`.
  Sub-project 4 replaces it.
- A shared `waitReady` helper wraps `systemctl is-system-running --wait`.

### Commands

`setup` (new), `image build`, `start`, `resume`, `finish`, `stop`, `delete`,
`list`, `completion`.

- `image build` loses its `super` argument and its `update` alias.
- `start` checks, before provisioning, that the profile `agent-forge` and the
  image `agent-base` exist. If one is missing, it names `forge setup` or
  `forge image build`.
- `list` keeps its mode column; there is a single base image, `agent-base`.
- Container naming (`agent-<owner>-<repo>`) and the `agent-` filter are
  unchanged.

### Provisioning (`forge start` on a new container)

Preconditions, checked before anything is created:

- `~/.claude/.credentials.json` exists (`claude auth login` on the host, as in
  v1).
- The host has a git identity: `git config --global user.name` and
  `user.email` are both set. Otherwise forge stops with the two
  `git config --global` commands to run.
- The workspace is reusable or absent (v1's `workspaceIsReusable`, unchanged).

Then:

1. `incus launch agent-base <c> --profile agent-forge`, then `waitReady`.
2. Workspace:
   - create `~/workspaces/<c>`;
   - clone `git@github.com:<owner/repo>.git` on the host, or realign the
     origin of a reused clone;
   - add the `workspace` disk device (`source=<dir>`, `path=/workspace`, no
     shift, since `raw.idmap` maps the host user to `aiuser`).
3. Git identity in the container:
   - `user.name` and `user.email` copied from the host;
   - `commit.gpgsign=false`;
   - set with `incus exec --user 1001 --group 1001 --env HOME=/home/aiuser -- git config --global <key> <value>`.
4. Claude credentials, `container/claude.json` → `~/.claude.json`,
   `container/CLAUDE.md`, the superpowers plugin: same as v1, files read from
   `container/`.
5. `container/pre-bash.sh` and `container/settings.json`, owned by root (not
   modifiable by the agent), as in v1.
6. Claude Code refresh:
   `apt-get update && apt-get install --only-upgrade -y claude-code`. A
   failure is a warning, not fatal: the image's version works.
7. Mode marker `supervised` in `~/.claude/forge-mode` and `user.forge.mode`.
8. git-lfs filters and hooks, `.trees/` exclusion: unchanged from v1.
9. Metadata: `user.forge.repo`, `user.forge.image_commit`.
10. Retrieval hint: `git remote add <c> ssh://<user>@<forge-host><workspace>`.
    `<user>` comes from `os.userInfo()`, and `<forge-host>` is left for the
    user to fill in; sub-project 5 refines it.

`refreshMain` keeps its supervised behaviour (no fetch, a notice) until
sub-project 4 moves the fetch to the host.

### Removed

- The mode menu, `modeFromChoice`, autonomous and super paths.
- PAT prompt, `gh auth`, signing key push, bot identity.
- `deluser ubuntu` and the cloud-init sudoers cleanup: the image has neither.
- The nested LXD initialization, `agent-base-super`, `agent-super`.
- `container/CLAUDE.md`:
  - the super-mode section goes;
  - the supervised paragraph no longer says "signed";
  - the autonomous paragraph stays, as do `pre-bash.sh`'s autonomous rules.

  The mode concept stays (framing non-goals).
- `pre-bash.sh` keeps its content. Its default when the marker is missing
  stays `autonomous`, because the repo's own sessions on the dev machine use
  the same hook without a marker.

### Personal values removed

| v1 | v2 |
|---|---|
| `FORGE_HOME` defaults to `/home/moroine` | `os.homedir()` (env override kept for tests) |
| `FORGE_REPO_DIR` defaults to `/home/moroine/agent-forge` | Derived from the CLI's location (`cli/..`) (env override kept for tests) |
| `raw.idmap` `uid 1000 1001` in a static profile | Computed by `forge setup` |
| Bot email `moroine-claude@users.noreply.github.com` | Host user's identity |
| `ssh://moroine@<host>:2222` in the retrieval hint | `os.userInfo().username`, no port |
| `lxdbr0`, pool `default` in the profile | Config, with defaults |

## Error handling

- v1's rule stands:
  - every mutating step goes through `mustSucceed`, which surfaces Incus' or
    git's stderr as is;
  - probes (`list`, `info`, `config get`, `/proc` reads) are never fatal by
    themselves; their result is the answer.
- `forge setup` stops at the first failed host check with its fix.
  Convergence stops at the first failed write, naming the object; the next run
  resumes, since objects already converged report `unchanged`.
- Config errors name the file, the key and the expected form.
- `forge image build` streams Ansible's output live (`ctx.attach`), as v1
  streamed `forge-image.sh`.

## Testing

- **Unit** (`node --test`, fake `incus` in `tests/lib/fake-incus.ts`, successor
  of `fake-lxc`).
  - What the fake models:
    - it requires `--project` on instance, profile and image commands, so a
      forgotten project fails;
    - it reads stdin on `create` and `edit`, and an empty stdin wipes the
      object, as the real one does;
    - it serves `list -f json` from an in-memory state;
    - it records every call.
  - `forge setup` convergence:
    - an empty Incus gives four creations;
    - a second run makes **no** mutating call;
    - a drifted bridge address or limit gives exactly one `edit`, carrying the
      whole object;
    - a restricted project without `lowlevel` gives a profile without
      `raw.lxc`.
  - Generation of the desired objects from the config and the UID/GID,
    defaults included. These tests replace `test-lxd-agent-profile.sh`.
  - Config validation: unknown key, invalid address, out-of-range address.
  - Host contract: each failure and its message, through injectable `/proc`
    paths.
  - `image build`:
    - step order;
    - leftover cleanup;
    - `COMMIT` first, then the `git rev-parse` fallback, then failure;
    - `ansible-playbook` argv;
    - the old image is deleted only after the new one is published.
  - Provisioning:
    - missing or present git identity;
    - identity values passed as argv;
    - no autonomous remnant (no `gh`, no signing key, no mode prompt).
- **Contract** — real `git` as today. The tmux contract test stays until
  sub-project 4.
- **bash** — `test-pre-bash.sh` and `test-claude-template.sh` follow their
  files into `container/`.
- **Integration** (opt-in, `FORGE_INTEGRATION=1`). It runs on a throwaway test
  Incus: a Lima VM, prepared by hand as in the spike until sub-project 1 lands.
  It uses project `forge-selftest`, the sentinel and the double-guard teardown
  of v1.
  - **Setup:** `forge setup` twice; the second run reports only `unchanged`.
    The JSON-as-YAML input is checked here first.
  - **Network, from a provisioned container:**
    - `https://example.com` answers;
    - `10.x`, `192.168.x`, `169.254.169.254` and the bridge address do not;
    - a second container is unreachable;
    - DNS works.
  - **userns, from the same container:** as `aiuser`, `unshare -Ur true`,
    Chrome with its sandbox, `docker info` rootless.
  - **idmap:** a file created in `/workspace` by `aiuser` belongs to the host
    user.
  - **Restricted project:**
    - a project with `restricted=true` and the admin keys from the table above,
      with `agent-base` copied into it;
    - `forge setup` there creates a profile without `raw.lxc`;
    - an instance launches with the workspace mounted.

    This validates the table.
  - **Full image build:** slow, so behind a second opt-in,
    `FORGE_INTEGRATION_IMAGE=1`.
- **Ansible** — `ansible-lint` through sub-project 1's `.ansible-lint`
  (profile `production`), which covers `image.yml` and `forge_image`.
  `verify.yml` is the image's smoke test.

## Risks and open points

| Point | Handling |
|---|---|
| `kernel.unprivileged_userns_clone` may not exist on the 26.04 kernel | The check treats an absent file as passing |
| Ubuntu's community.general 12.1 ignores some failed file transfers and has become/tty issues | Pipelining, a root connection, `su -` commands instead of `become`, and `verify.yml` |
| JSON accepted as YAML by `incus … create/edit` | Expected (YAML 1.2); first integration check |
| Incus 6.0 LTS (Ubuntu archive) in local Linux mode | Not gated, untested; documented by sub-project 5 |
| Root disk `size` is soft on btrfs | Documented in the config reference; the loop file still bounds the pool (sub-project 1) |
| A host address outside the rejected ranges is reachable from containers | Warning in `forge setup`; covered on an Ansible host by its nftables input chain |
| Bridge subnet already routed on the host | Incus' own error is surfaced; the user changes `network.ipv4Address` |
| DNS to the bridge bypasses the ACL | Known, deferred (framing spec, sub-project 3) |

## Changes to the framing spec

This spec supersedes these points of the framing spec. The framing document is
not edited.

- **Runtime → Image:**
  - the base is `images:ubuntu/26.04`, not `/cloud`;
  - Chrome stable on both architectures, so the Chromium fallback is dropped;
  - Claude Code comes from Anthropic's apt repository;
  - the 24.04 fallback is unnecessary, since Docker publishes `resolute`.
- **Runtime → `forge setup`:**
  - the bridge address is explicit and configurable;
  - the bridge and the ACL live in `default`, and the project has
    `features.networks=false`;
  - the profile depends on the host's user-namespace sysctls (host contract).
- **Runtime → Image (build):** the lifecycle (launch, publish, stamp) is
  `forge`'s; `image.yml` only configures the instance.
- **Git flow:** agent commits are unsigned and carry the host user's
  identity. The user re-signs when publishing.
- **Security model summary**, row "Container reaches host services", local
  Linux cell: "Incus ACL, for host addresses in the rejected ranges; warning
  otherwise".
