# agent-forge

Infrastructure for running Claude Code agents in isolated LXD containers on a dedicated Ubuntu server.

## Architecture

```
SSH (port 2222, Ed25519, no password)
└── UFW (deny all, allow 2222, LXD isolated from LAN)
    └── Fail2ban (5 retries, 30 day ban)
        └── LXD container (2CPU, 4GB RAM, 20GB disk)
            └── aiuser (no sudo, /workspace only)
                └── Claude Code (Claude Pro, full permissions)
```

One LXD container per **task**, not per repo. The host mount is unchanged —
one clone, one shared `.git`, one `.trees/<task>` worktree per task — but the
container layer splits into a **template** (provisioned once, always
stopped) and one **task** container per in-flight task, all mounting the
same host directory:

```
REPO   ~/workspaces/agent-<owner>-<repo>/            (host, unchanged)
         .git/   <main>   .trees/feat-a/   .trees/feat-b/   .forge-cache/
           │
           ├─ mounted /workspace ─▶ TEMPLATE  agent-<owner>-<repo>
           │                         user.forge.role = template
           │                         always Stopped after provisioning
           │
           ├─ mounted /workspace ─▶ TASK  agent-<owner>-<repo>-feat-a
           │                         user.forge.role = task
           │                         user.forge.task = feat-a
           │                         cwd /workspace/.trees/feat-a
           │
           └─ mounted /workspace ─▶ TASK  agent-<owner>-<repo>-feat-b
```

`forge start` provisions the template once per repo (from `agent-base`) and
`lxc copy`s it into a fresh task container for every task afterward — the
template itself is never worked in. Because each task gets its own container,
it also gets its own network namespace: ports and Docker no longer collide
between two tasks of the same repo, the way they would sharing one container.
See "Mental model" below, and
`docs/superpowers/specs/2026-09-20-container-per-task-design.md` for the full
design rationale.

## Prerequisites

- Ubuntu 24.04 fresh install
- SSH access (keyboard/screen) for initial setup
- Claude Pro account
- GitHub bot account, invited as a **write collaborator** on each target repo
- Node.js 24+ on the host (the `forge` CLI is TypeScript, run directly by Node's
  type stripping — no build step, no `npm install`). Node is separately installed
  *inside* the agent image; this entry is about the host. No `jq` needed on the
  host either — the CLI parses `lxc list -f json` in-process instead of shelling
  out to it.

## Setup

### 1. SSH

Install and generate host keys:

```bash
sudo apt update && sudo apt install -y openssh-server
sudo ssh-keygen -A
```

Copy `config/sshd_config` to `/etc/ssh/sshd_config`, then validate and restart:

```bash
sudo sshd -t
sudo systemctl restart ssh
```

### 2. Firewall

```bash
sudo apt install -y ufw

# Détecter l'interface sortante (wlo1 pour WiFi, eth0/enp3s0 pour filaire)
IFACE=$(ip route get 8.8.8.8 | awk '{print $5; exit}')

sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 2222/tcp comment "SSH"

# Bloquer les containers LXD depuis toutes les plages privées/spéciales (IPv4)
# Empêche un container compromis d'atteindre le LAN ou des services internes
sudo ufw route deny in on lxdbr0 out on "$IFACE" to 10.0.0.0/8      comment "Block RFC1918 10/8"
sudo ufw route deny in on lxdbr0 out on "$IFACE" to 172.16.0.0/12   comment "Block RFC1918 172.16/12"
sudo ufw route deny in on lxdbr0 out on "$IFACE" to 192.168.0.0/16  comment "Block RFC1918 192.168/16"
sudo ufw route deny in on lxdbr0 out on "$IFACE" to 169.254.0.0/16  comment "Block link-local"
sudo ufw route deny in on lxdbr0 out on "$IFACE" to 100.64.0.0/10   comment "Block CGNAT"
sudo ufw route deny in on lxdbr0 out on "$IFACE" to 224.0.0.0/4     comment "Block multicast"

# Bloquer les plages privées IPv6 (le bridge lxdbr0 a IPv6 NAT activé par défaut)
sudo ufw route deny in on lxdbr0 out on "$IFACE" to fc00::/7        comment "Block IPv6 ULA"
sudo ufw route deny in on lxdbr0 out on "$IFACE" to fe80::/10       comment "Block IPv6 link-local"
sudo ufw route deny in on lxdbr0 out on "$IFACE" to ff00::/8        comment "Block IPv6 multicast"

# Autoriser internet (GitHub, Anthropic API, etc.)
sudo ufw route allow in on lxdbr0 out on "$IFACE" to any            comment "Allow internet"

sudo ufw enable
```

Optionnel — désactiver IPv6 sur le bridge LXD pour éliminer toute surface d'attaque IPv6 :

```bash
lxc network set lxdbr0 ipv6.address none
lxc network set lxdbr0 ipv6.nat false
```

### 3. Fail2ban

```bash
sudo apt install -y fail2ban
sudo cp config/jail.local /etc/fail2ban/jail.local
sudo systemctl enable --now fail2ban
```

### 4. System

Disable sleep and switch to headless mode:

```bash
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
sudo systemctl set-default multi-user.target
sudo reboot
```

### 5. LXD

```bash
sudo snap install lxd
sudo lxd init --minimal
sudo usermod -aG lxd $USER
newgrp lxd
```

Build the base image:

```bash
./scripts/forge image build
```

(Aliased as `forge image update` — same command, use whichever name you find
more intuitive for a rebuild.) This scripts the same steps every time:
launches a scratch `agent-base-setup` container, installs Node LTS, `pnpm`,
Claude Code, `gh`, `git`/`git-lfs`, Chrome, `chrome-devtools-mcp`,
and Docker (rootless) and Compose, creates `aiuser`, sets
up `/workspace`/`.ssh`/`.claude` ownership, then publishes the `agent-base`
alias and cleans up the scratch container. Only affects containers created
*after* the rebuild — already-running containers keep their existing image
until you delete and `forge start` them again. Safely re-runnable: a leftover
`agent-base-setup` from a previous failed build is deleted first.

Also stamps the image with the build's commit
(`lxc image set-property agent-base user.forge.commit <sha>`), which is how
`forge start` (at provisioning) and `forge list` (on every run) can tell a
container's image apart from whatever the latest build is — see
"Image versioning" below. There's no auto-rebuild trigger: you decide when
to run `forge image build` (e.g. after changing `scripts/lib/forge-image.sh`
or the container-side templates it installs), and it only affects containers
created afterward.

> **Note:** if you built `agent-base` before `gh` was part of the build, rebuild it — autonomous containers need the GitHub CLI.

No image ships `claude-code` any more — it's installed on the host instead
(see "claude-code distribution" below) and mounted read-only into every
container. Right after building the image, install a version:

```bash
./scripts/forge claude update
```

This is a required first-run step, not an optional one: without it, no
container has a `claude` binary to run — the in-container shim exits with
`claude-code is not installed on the host. Run: forge claude update` the
first time anything tries to invoke it.

To build the layered `agent-base-super` image (base + nested LXD, for super
mode), run `forge image build super` — but create and configure the
`agent-super` profile first (see "Super mode" below).

Create the agent LXD profile:

```bash
lxc profile create agent
lxc profile edit agent
```

Paste the content of `config/lxd-agent-profile.yaml`.

This enables `security.nesting` (needed for rootless Docker inside each
container — see "Docker/Compose access" below) on top of an otherwise
unprivileged container, and sizes the root disk at 100GB to leave room for
Docker images/volumes.

### 6. GitHub bot account: signing key, PAT, branch protection

#### Signing key

Generate the commit-signing key on the server:

```bash
ssh-keygen -t ed25519 -C "agents-server-signing@github" -f ~/.ssh/github_agents_signing -N ""
```

On the GitHub bot account, add `github_agents_signing.pub` as a **Signing Key** under Settings → SSH and GPG keys. Agent commits then show as **Verified**.

> The old read-only deploy key (`~/.ssh/github_agents`) is no longer used by
> either mode — autonomous containers authenticate with a PAT over HTTPS,
> and supervised containers get no credential at all (the host clones over
> SSH using your own forwarded agent instead; see §7 and "Supervised mode"
> below). It can be removed if you don't need it for anything else.

#### Fine-grained PAT (one per target repo)

Created from **your laptop**, in the **bot account's** web UI — your personal
credentials never touch the server or the containers. GitHub has no API to
mint fine-grained PATs, so this step is manual:

1. Invite the bot account as a collaborator with **write** access on the target repo (and accept the invitation as the bot).
2. Logged in as the bot: Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.
3. Resource owner: the repo's owner. Repository access: **Only select repositories** → the target repo.
4. Permissions: **Contents: Read and write**, **Pull requests: Read and write**, **Metadata: Read** (added automatically).
5. Expiration: maximum (1 year).
6. Keep the token in your password manager; you'll paste it when provisioning the repo's template (or ahead of time with `forge token set <owner/repo>` — see "Host credential store" below).

> **Fallback:** fine-grained PATs targeting a repo owned by another account
> are recent on GitHub's side. If token creation or usage fails cross-owner,
> use a classic PAT (`repo` scope) on the bot instead — same effective
> boundary, since the bot is only invited to agent-approved repos.

#### Branch protection (required before the first autonomous container)

On each autonomous repo, protect `main`: Settings → Branches → Add branch
ruleset (or classic protection rule) on `main`, with **Require a pull request
before merging** and **Require approvals: 1**.

This is the real security boundary — even a leaked token cannot land code on
`main`, and since GitHub forbids approving your own PR, the bot can never
merge its own work. You review and approve as yourself.

### 7. SSH Agent Forwarding (YubiKey)

On the server, add to `sshd_config`:

```
Match User moroine
    AllowAgentForwarding yes
Match User *
    AllowAgentForwarding no
```

On your local machine, add to `~/.ssh/config`:

```
Host omen
  HostName 192.168.1.177
  Port 2222
  User moroine
  ForwardAgent yes
```

Configuration de git host

```
git config --global user.name "Ton Nom"
git config --global user.email "ton@email.com"
git config --global gpg.format ssh
git config --global user.signingkey "$(ssh-add -L | head -1)"
git config --global commit.gpgsign true
```

## Usage

### Mental model: one host mount per repo, one container per task

A repo has one host mount, `~/workspaces/agent-<owner>-<repo>` — one clone,
one shared `.git`, one **git worktree** per task under `/workspace/.trees/<task>`,
each checked out on its own `agent/<task>` branch. That part is unchanged.
What changed is the container layer: instead of one long-lived container
holding every task's worktree, the repo now gets a **template** container
(provisioned once from `agent-base`, always stopped, never worked in — see
"Architecture" above) and one **task** container per in-flight task,
produced by copying the template (`lxc copy`). Every container, template and
tasks alike, mounts the same host directory, so all worktrees still share
one `.git` (branches, remotes, LFS objects) — retrieval, review and pushes
all see the same object store, exactly as before.

What a task container buys over the old shared one: its own CPU/RAM
accounting, and — the actual motivation for the split — its own **network
namespace**. Each task's own tmux session, `cd`'d into `.trees/<task>` with
its own `claude` process attached, now also has its own ports and its own
Docker daemon, so two tasks of the same repo no longer collide over `docker
compose up` or a hardcoded `container_name:`. You can still run several
tasks in parallel with no cross-task interference — the isolation is a
container boundary now, not just a worktree boundary.

### Start a task (provisions the repo's template on first use)

```bash
./scripts/forge start [<owner/repo>] [<task>]
```

Container identity is derived from `owner/repo` — no project name to choose
or remember. If no **template** container exists yet for that repo, `forge
start` provisions one first (this happens once per repo, not once per task):
- Prompts for the template's mode: **autonomous** (bot pushes and opens PRs itself) or **supervised** (no GitHub credential ever touches any container — see "Supervised mode" below)
- Creates an LXD container from `agent-base`, marked `user.forge.role=template`
- Mounts `/workspace` with correct permissions (no `sudo` required — LXD idmap shifting handles the UID mapping, scoped to that one mount)
- Copies the signing key and configures git (signed commits)
- Reuses your Claude Code credentials from the host (`~/.claude/.credentials.json`), so every task container starts already authenticated — no Remote Control pairing needed
- Pre-accepts onboarding and installs the `superpowers` plugin, so the first `claude` launch skips the setup questions
- **Autonomous:** reads the bot's fine-grained PAT from the host token store (`forge token set`, or see "Host credential store" below) if one is already there, otherwise prompts for it and stores it once accepted by GitHub; authenticates `gh` inside the template — and clones `https://github.com/<owner/repo>.git` into `/workspace` inside it
- **Supervised:** no token involved; clones `git@github.com:<owner/repo>.git` on the host over SSH, using your own forwarded agent (§7) — no container ever receives any GitHub credential
- Either clone step is **skipped when `~/workspaces/agent-<owner>-<repo>` already holds a clone of that same repo** — a workspace left behind by a previously deleted template is adopted as-is, with only its `origin` URL realigned on the new template's mode (see "Re-provisioning over an existing workspace" below)
- Sets up `git-lfs` (which itself ships preinstalled in the `agent-base` image, via `forge image build`) in three separate steps, because they don't have the same reliability: **the LFS filters** (`git lfs install --skip-repo` — clean/smudge/process in the global config, so LFS files check out and commit normally) and **`.trees/` in `.git/info/exclude`** (so worktrees never show up as untracked noise in `/workspace`) are both required and abort provisioning if they fail; **the repo's LFS hooks** (`git lfs install` in `/workspace`) are best-effort. `git lfs install` refuses to overwrite a `pre-push` hook it doesn't recognise and exits 2 — which happens whenever the project manages its own hooks (husky sets `core.hooksPath`, and git-lfs then installs *into* it) or the hooks present were written by a different `git-lfs` version than the image's. Since a surviving workspace is adopted rather than recloned, both are normal inputs, and neither is a reason to leave a half-provisioned template behind: the failure and git's own message are printed on stderr, along with `git lfs update --manual` as the manual way out, and provisioning carries on. Only the pre-push *upload* hook is missing in that case
- Points `npm` and `pnpm` at the shared cache directories under `/workspace/.forge-cache/` and excludes them from the main clone's status (see "Shared caches" below) — every task container inherits this through the copy, with no extra step
- Stamps the template with the commit `forge image build` last ran from (`user.forge.image_commit`), so `forge list` can later tell you if it's running an older image than the latest build
- Records `owner/repo`, mode and `user.forge.role=template` on the container itself (LXD config keys) — there's no separate registry file; `forge list` and future `forge start` calls discover containers this way
- Stops the template — it is provisioned once and only ever copied, never worked in directly

Either way (freshly provisioned or already existing), `forge start` then
makes sure the **task** has its own container — copying the template
(`lxc copy`, stopping it first if it was left running) if this task has no
container yet, or just starting an existing one back up — and, from inside
that task's own container:
1. **Refreshes `main`** — autonomous tasks `git fetch origin` in `/workspace` first, so every new task branches from a genuinely current `origin/main` (that remote-tracking ref, not the local `main`, is what the worktree is cut from); supervised tasks have no credential to fetch with, so this step is skipped and the task branches from whatever `origin/main` was last fetched to (fetch it yourself on the host beforehand if you need it current — see "Supervised mode" below). The local `main` ref is then fast-forwarded too, as a convenience for anyone reading `/workspace` directly — by `git fetch origin main:main` when `main` isn't the branch checked out there, and by `git merge --ff-only origin/main` when it is. **The branch checked out in `/workspace` is never merged into**: the main clone is *meant* to sit on `main`, but when it has drifted onto some `agent/*` branch, advancing that branch is not something `forge start` was asked to do. Neither step is fatal: a failure (host offline, origin unreachable, a local `main` that has diverged) prints git's own message on stderr and `forge start` carries on. The two are reported separately, because they have different consequences — a failed *fetch* means the task may branch from a stale `origin/main`; a failed *fast-forward* means only `/workspace`'s own `main` lags, while the task still branches from a current `origin/main`.
2. **Puts the task's worktree in place** — resolving what `<task>` should branch from rather than always starting over from `main` (see "Resolving the task's branch" below).
3. **Attaches the session** — starts (or re-attaches, via `tmux new-session -A`) a tmux session named `<task>`, `cd`'d into `.trees/<task>`, running `claude` in `auto` permission mode (`--permission-mode auto`) — autonomous by default, but the auto-mode classifier pauses for confirmation on sensitive actions (credential handling, irreversible deletion, pushes to protected branches, etc.). A session URL and QR code are displayed at startup.

Running `forge start` again with a *different* task name on a repo that
already has a template just copies that template into a new task container —
no re-provisioning, no re-pasting the PAT. If the template is running behind
the latest `forge image build`, `forge start` warns and proceeds anyway
(pointing you at `forge template rebuild`); it never blocks on it.

#### Resolving the task's branch

`forge start` is idempotent: given a task whose worktree is already there, it
attaches to it instead of failing. Otherwise it picks the branch to work from
in this order, announcing which case it landed in so you always know what
you're sitting on:

| Situation | What happens |
|-----------|--------------|
| `.trees/<task>` already exists | Attach to it (same thing `forge resume` does) |
| A ref was named through the `other branch…` menu entry | New `agent/<task>` branched from that ref |
| Local `agent/<task>` exists | Worktree on that branch — the case left behind by `forge finish`, which keeps the ref |
| `origin/agent/<task>` exists | New local `agent/<task>` tracking it — a branch pushed from another container or machine, typically an open PR |
| Nothing exists | New `agent/<task>` from `origin/main` |

Leave `<task>` out and you get these as a menu instead — existing worktrees,
`agent/*` branches that have no worktree (local, or only on `origin`), plus
`new task` and `other branch…`:

```
$ forge start moroine/agent-forge
 1) new task
 2) cli (existing worktree — attach)
 3) docs (local branch)
 4) api (branch on origin)
 5) other branch…
Task>
```

`other branch…` asks for a ref and a task name, and is how you pick up a
branch that doesn't follow the `agent/<task>` convention — say a
`feature/*` branch a human pushed. The work still happens on `agent/<task>`
branched from it, never on the original branch: the container's `pre-bash.sh`
hook only lets the agent push to `origin agent/*`, so a worktree on any other
branch could commit but never publish. The trade-off is that you get a fresh
PR rather than adding commits to the existing one.

### Resume or finish a task

```bash
./scripts/forge resume [<owner/repo>] [<task>]   # re-attach an existing task's tmux session
./scripts/forge finish [<owner/repo>] [<task>] [--force]   # remove a finished task's worktree
```

Leave a bracketed argument out and `forge` asks for it as a numbered menu,
built from the containers and worktrees that actually exist — the same
source the bash completion reads. With no terminal on stdin (a script, CI)
nothing is asked: the command prints its usage and exits non-zero rather
than blocking on a prompt nobody will answer.

`forge resume` does no fetch and no rebranch — it just starts the container
if needed and re-attaches the task's existing tmux session. It errors out
(pointing you at `forge start`) if the worktree doesn't exist.

`forge finish` runs the same dirty-tree/unpushed-commits WIP check as `forge
stop`/`forge delete` (scoped to that one worktree) unless `--force` is
passed, then runs `git worktree remove` and kills the task's tmux session if
it's still around. The `agent/<task>` branch itself is **not** deleted — it
stays in the shared `.git`, so a merged or abandoned task can still be
inspected or re-checked-out later.

### Working on several features in parallel

Because worktrees (and now containers) are independent, nothing stops you
from having multiple tasks in flight on the same repo at once:

```bash
./scripts/forge start <owner/repo> feature-a
./scripts/forge start <owner/repo> feature-b   # second task container, second worktree, second tmux session
```

Each gets its own task container, its own `.trees/<task>` checkout, its own
`agent/<task>` branch, and its own tmux session — detach from one (`Ctrl+b
d`) and `forge resume` the other, or check `forge list` to see which
sessions are attached. Unlike the old shared-container model, two tasks
running `docker compose up` or binding the same port at the same time no
longer collide — each has its own network namespace.

### Autonomous PR flow

The agent works on `agent/<task>` inside its worktree, pushes with
`git push -u origin agent/<task>` and opens a PR with
`gh pr create --base main`, all authenticated as the bot. The `pre-bash.sh`
hook only allows pushes to `origin agent/*` (no force, no delete) and blocks
`gh pr merge`, `gh api`, `gh repo`, `gh alias`, `gh extension` and
`gh auth token`. You review, approve and merge the PR as yourself.

### Supervised mode

For repos where no standing GitHub credential should ever exist inside a
container. No task container gets a PAT or a `gh auth` — `pre-bash.sh`
blocks every `git push` and every `gh` subcommand unconditionally, and
`templates/CLAUDE.md` tells the agent to commit locally (signed) and stop
when the task is done, never attempting to publish.

Retrieving and publishing the work is a manual, laptop-side flow — every
line the agent wrote gets reviewed before it's re-authored as your own:

```bash
git remote add agent-<owner>-<repo> ssh://moroine@<host>:2222/home/moroine/workspaces/agent-<owner>-<repo>
git fetch agent-<owner>-<repo> agent/<task>:agent/<task>
git log -p main..agent/<task>          # review before doing anything else
git checkout agent/<task>
git rebase --reset-author main
git push origin agent/<task>            # your identity, YubiKey-signed
```

`forge start`'s supervised path prints the exact `git remote add` command
(the template's name filled in, which is always `agent-<owner>-<repo>`) once
— at the end of the repo's *template* provisioning, not on every task. Don't
substitute a task container's `hostname` here: a task container's name is
the template's name plus the task (and may be hash-truncated), and it is not
where the repo is mounted. The mount is per repo, so this one `git remote
add` gives you access to every task's branch of that repo, current and
future, not just one.

Because supervised containers never fetch (no credential), `forge start` on
a supervised repo branches each new task from whatever `origin/main` was
last fetched to — which may be stale. If you want a task to start from a
genuinely current `main`, fetch it yourself from a host shell in the
workspace directory (`git -C ~/workspaces/agent-<owner>-<repo> fetch
origin`) before running `forge start`.

### Super mode

For self-hosting agent-forge itself: a super repo's **template** is an
**autonomous container plus a nested LXD**, initialised once at template
provisioning (`lxd init --minimal` against a `dir` pool and an internal
bridge). Every task container copies that template, so it inherits an
already-initialised nested LXD through the copy — no per-task init — and can
run `forge`, `lxc`, and the real integration tests
(`FORGE_INTEGRATION=1 npm run test:integration`) against a live LXD fully
isolated from the host's and from every other task's. Git discipline is
identical to autonomous mode (push `agent/*`, open a PR, human merges).

Setup (once), in order — the profile must exist before the image, because the
build container itself needs its capabilities:

```bash
lxc profile create agent-super
lxc profile edit agent-super   # paste config/lxd-agent-super-profile.yaml
./scripts/forge image build super
```

`agent-super` is `agent` with three capabilities restored
(`mac_admin`, `mac_override`, `sys_ptrace`) that the nested LXD's snapd needs;
`security.privileged` stays `false` and the seccomp blocklist stays on. The
nested LXD (`agent-base-super` image) cannot see the host's LXD — the agent's
`lxc` only drives its own nested daemon.

Pick super at `forge start` (the `[u]` choice). Everything else — PAT prompt,
`gh auth`, HTTPS clone, PR flow — is the autonomous path.

### Docker/Compose access

Every agent container gets rootless Docker and Compose by default (baked
into `agent-base`, no opt-in) — for repos that need a backing service
(MongoDB, Postgres, Redis, ...) for tests or for running the app itself.
The daemon runs entirely as `aiuser` (no root, no `docker` group, no
privileged daemon): a worst-case container escape lands the agent back at
its own existing `aiuser` privilege level, nothing new. `pre-bash.sh` blocks
`--privileged`, `--pid=host`/`--network=host`, and bind-mounts outside
`/workspace` as defense-in-depth on top of that containment — everything
else (`docker run`, `docker compose up`, named volumes, workspace-relative
bind mounts) works normally. Because each task has its own container, it
also has its own network namespace and its own Docker daemon: published
ports and hardcoded `container_name:` entries no longer collide between two
tasks of the same repo, which was the original motivation for the
container-per-task split (see "Architecture" above). What each task
container does **not** get is a shared Docker image/build cache — the
daemon's storage lives in the container's own rootfs, so a task inherits
whatever the template held at copy time and nothing more; `docker compose
pull` inside the template before rebuilding it is the escape hatch if that
bites. See
`docs/superpowers/specs/2026-07-17-agent-docker-support-design.md` for the
full design rationale.

### Browser automation (Chrome DevTools MCP)

Every agent container gets `chrome-devtools-mcp` wired up globally as an MCP
server — no `.mcp.json` needed per repo. It drives the headless
`google-chrome-stable` already installed in the image, letting the agent
navigate to a locally running dev server, take screenshots, and read
console/network output — the tool needed to follow the "verify UI changes in
a browser before reporting done" guidance in a container with no display and
no `claude-in-chrome` extension pairing.

Only reaches *new* templates: the binary is baked into the image at `forge
image build` time, and the MCP server declaration is pushed to
`~/.claude.json` once, at template provisioning — neither refreshes on an
already-existing template, nor on a task container copied from it. Rebuild
the image and run `forge template rebuild <owner/repo>` to pick it up on the
template; already-running task containers keep what they were copied with
until they're finished (`forge finish`) and started again.

### Host credential store

Fine-grained PATs live on the host, one file per repo, at
`~/.config/agent-forge/credentials/<owner>-<repo>` (`chmod 600`) — deliberately
**not** under `~/workspaces/`, since everything under a repo's host mount is
readable by every one of that repo's containers through `/workspace`.

```bash
./scripts/forge token set <owner/repo>     # paste a token (input hidden), stored once GitHub accepts it
./scripts/forge token rm  <owner/repo>     # remove the stored token
./scripts/forge token import <owner/repo>  # pull the token out of an existing container's `gh auth token`
```

`forge start` and `forge template rebuild` read this store automatically —
if a token is already there, provisioning is non-interactive and doesn't
ask. `forge token import` is the migration helper: it starts the repo's
existing container just long enough to run `gh auth token` inside it (a
credential can't be read from a stopped container), stores the result, and
stops the container again if it wasn't already running. Whether typed or
imported, the token reaches `gh auth login --with-token` through **stdin**,
never `argv` (visible in `ps`), and is written to disk only *after* GitHub
has accepted it — a rejected token never lingers in the store to make the
next provisioning attempt fail identically.

To renew an expired PAT (fine-grained PATs expire after at most a year):
create a new one in the bot's web UI (same repo, same permissions), then
`forge token set <owner/repo>` to replace the stored one. It takes effect
the next time a container needs to authenticate — `forge template rebuild`
if you want it applied immediately.

### claude-code distribution

No image ships `claude-code` any more — installing it used to mean a network
`npm install -g` on every template rebuild, and a container's copy could
only be refreshed by recreating it. Instead, versions live on the host, in
an immutable, versioned directory tree, with a `current` symlink pointing at
the active one:

```
~/.local/share/agent-forge/claude/versions/<version>/     immutable once installed
                                    current -> versions/<version>   (atomic rename)
```

```bash
./scripts/forge claude update [<version>]   # install a version (latest, if omitted) and make it current
./scripts/forge claude list                 # show installed versions and which one is current
```

Every container — template and tasks alike — mounts `~/.local/share/agent-forge/claude`
read-only at `/opt/forge-claude`. The in-container `claude` command is a
shim that resolves `/opt/forge-claude/current` **once, at launch**, and
`exec`s that version's `cli.js`. That single resolution point is what makes
an update safe while a session is running: `claude-code` imports lazily, so
overwriting an install in place could make a module vanish mid-session.
Here nothing is ever overwritten — `forge claude update` installs the new
version alongside the old ones and only then flips `current` with an atomic
rename — so a running session keeps whatever version it resolved at launch,
and only the *next* session picks up the update.

Plugins (`claude plugin install`, e.g. `superpowers`) stay in the
**template**, not on this mount: they write into `~/.claude/plugins/`
(including a cache), which a read-only mount cannot host, and they change
far less often than the CLI itself.

### Shared caches

`npm` and `pnpm` are configured, once, in the template
(`npm config set cache` / `pnpm config set store-dir`), to use
`/workspace/.forge-cache/npm` and `/workspace/.forge-cache/pnpm` — inside
the repo's host mount, in the **same mount** as `.trees/<task>/`, and
excluded from the main clone's status via `.git/info/exclude` exactly like
`.trees/` itself. Every task container inherits this through the template
copy, with no extra step, and the cache follows the repo's lifecycle: a
`forge delete` leaves it warm for the next `forge start`.

**It has to live inside the repo mount, not on a separate device — and this
is deliberate, not an oversight.** pnpm's speed comes from hardlinking from
its store into `node_modules`, and the kernel refuses `link()` across two
mount points (`EXDEV`) even when the same filesystem sits underneath both.
A cache mounted as a second host device and a worktree under
`/workspace/.trees/<task>/` would be two distinct bind mounts, so pnpm would
silently fall back to copying every package on every install — paying the
complexity of a shared store for none of its benefit. Putting `.forge-cache/`
inside the same mount as the worktrees it serves is what keeps the
hardlinks working. If you're ever tempted to move it onto its own volume
"to keep things tidy," this is why not to: on ext4 there is no reflink
fallback, and the design has to hold regardless of the host filesystem.

The trade-off accepted for this: the cache is per **repo**, not global (a
global cache would mean mounting all of `~/workspaces/` into every
container, exposing every repo to every agent — not worth it), and any task
of a repo can write to a cache shared with its sibling tasks (already true
of `node_modules` today; both `npm`'s and `pnpm`'s caches are
content-addressed with atomic writes, so the realistic worst case is a
corrupted entry that re-downloads, not lost work).

### Remote access

Each task's session registers directly under its own container's name (e.g.
`agent-owner-repo-feature-a` — the task container name already carries the
task, so there's no extra suffix), so multiple parallel tasks on the same
repo show up as distinct sessions. Once a session is running, connect from
any device:

- **Browser**: open the session URL printed at startup, or go to [claude.ai/code](https://claude.ai/code) and find the session by its container name
- **Mobile app**: tap **Code** in the Claude app navigation

The session stays accessible as long as the task's container is running and the `claude` process is alive in its tmux session. If the Remote Control connection times out (network outage >10 min), re-run `forge resume <owner/repo> <task>` to re-attach (`forge start` on that task does the same thing) — or type `/remote-control` inside an existing session to re-enable it.

**Requirements**: the host must be authenticated with a claude.ai account (`claude auth login`). API key auth does not support Remote Control. New templates reuse this credential automatically at provisioning time (see "Start a task" above), and every task container copied from a template inherits its copy; if you re-authenticate on the host afterward, existing templates and task containers keep their own copy until recreated.

### tmux cheatsheet

| Action | Command |
|--------|---------|
| Detach | `Ctrl+b d` |
| Reattach | `./scripts/forge resume <owner/repo> <task>` |
| List sessions | `./scripts/forge list` |
| Kill session | `lxc exec agent-<owner>-<repo>-<task> -- su - aiuser -c "tmux kill-session -t <task>"` |

### Stop / list / delete / finish — what each one touches

```bash
./scripts/forge stop   [<owner/repo>] [<task>]     # pause: stop one task's container, or every running container of the repo
./scripts/forge finish [<owner/repo>] [<task>] [--force]  # WIP pre-flight, then remove the task's worktree and delete its container (branch retained)
./scripts/forge delete [<owner/repo>] [--force]    # WIP pre-flight across every worktree, then delete every task AND the template
./scripts/forge list                               # every repo: template state, then one row per task container (session attached/detached)
```

**`forge stop` runs no WIP pre-flight, on purpose.** It used to — stopping
the one container that held every worktree of a repo used to be the
destructive-adjacent move, so it checked for dirty or unpushed work first.
That container no longer exists: a task's code, commits, WIP and
`node_modules` all live on the host mount, which stopping a container can't
touch. Adding a pre-flight back would only add friction to the gesture that
actually frees RAM, CPU and Docker — and it would be warning about a danger
that isn't there any more. `forge finish` and `forge delete` still run
theirs, because they still destroy something: a worktree, or (for `delete`)
every container of the repo including the template.

`forge finish` operates on one task: WIP pre-flight (unless `--force`),
`git worktree remove`, then delete that task's container — in that order,
because removing the container first would leave an orphaned
`.git/worktrees/<task>` entry in the shared mount. `forge delete` operates
on the whole repo: WIP pre-flight across every worktree (unless `--force`),
then every task container and the template are deleted, in that order. The
host mount — clone, branches, WIP, `.forge-cache/` — survives both; only
`forge finish`'s target worktree and `forge delete`'s target containers are
gone.

`forge list` prints one row per repo, then one indented row per task
container:

```
REPO             MODE        TEMPLATE
owner/repo       autonomous  ok
  feature-a      Running     attached
  feature-b      Running     detached
owner/other      supervised  behind
  bugfix         Stopped     no session
```

Column widths are computed from the data, so a long repo name widens its
column instead of shifting every column after it. The container name itself
is never printed — it's derivable (`agent-<owner>-<repo>` for the template,
`agent-<owner>-<repo>-<task>` for a task, occasionally hash-truncated) and
only made the output wrap.

The `TEMPLATE` column on a repo's own row compares its template's stamped
image commit against the latest `forge image build` (see "Image versioning"
below): `ok` if they match, `behind` if the template runs an image older
than latest build, `unknown` if either commit is unavailable (e.g.
`agent-base` was never stamped). A repo with no template yet shows `missing`.
Task rows show that container's LXD state and, only while it's `Running`,
whether the task's tmux session is `attached`, `detached`, or has `no
session` running at all. A container carrying no `user.forge.role` — a
leftover from the old one-container-per-repo model — is reported separately
as `old model — recreate` instead of being mistaken for a template.

### Image versioning

`forge image build` stamps the published `agent-base` image (or
`agent-base-super`, for super mode) with the agent-forge commit it was built
from (`lxc image set-property agent-base user.forge.commit <sha>`). Every
template provisioning copies that stamp onto the template
(`user.forge.image_commit`), so the two can be compared later even after
you've rebuilt the image several times.

There's no automatic rebuild or in-place patch: a template keeps running
whatever image it was created from until you explicitly rebuild it. When
`forge list` reports a repo's template as `behind` (running an image
**older than latest build**), that's informational, not an error — you
decide whether the drift matters enough to act on it. If you do:

```bash
./scripts/forge template rebuild <owner/repo>
```

This deletes the old template and re-provisions a fresh one from the
current `agent-base` — non-interactively, since the PAT comes from the host
token store (see "Host credential store" above) rather than being re-pasted.
**Task containers already in flight are not touched**: they're already
their own copy, and recreating them would lose whatever Docker state they
hold. They pick up the rebuilt template the next time they go through
`forge finish` + `forge start`.

### Re-provisioning over an existing workspace

`forge delete` removes containers only — the template and every task. The
host mount, `~/workspaces/agent-<owner>-<repo>`, is a host directory
mounted into all of them, and it deliberately outlives the containers — in
supervised mode it is the **sole** copy of any commit you haven't retrieved
yet. Provisioning a new template therefore never clones over it blindly.
Before creating anything (no container, no mount, no PAT prompt), it looks
at that directory:

| State of `~/workspaces/agent-<owner>-<repo>` | What provisioning does |
| --- | --- |
| Missing, or empty | Clones normally |
| A clone of the same `owner/repo` | Adopts it — no clone — and runs `git remote set-url origin` to match the new template's mode (`git@github.com:…` supervised, `https://github.com/…` autonomous) |
| Anything else, non-empty | Stops with an error, having touched neither the directory nor the host |

The adopted clone keeps its branches and its `.trees/` worktrees, so a repo
whose template was deleted and reprovisioned (`forge template rebuild`, or
the migration flow in "Migrating a repo from the old model" below) comes
back with its history intact. To genuinely start from a fresh clone, move
or remove the directory yourself first — that deletion is yours to make,
never the tool's:

```bash
mv ~/workspaces/agent-<owner>-<repo> ~/workspaces/agent-<owner>-<repo>.old   # review, then remove
```

### Migrating a repo from the old model

There's no dedicated migration command — the host mount already carries
everything that matters (clone, branches, worktrees, WIP), so migrating a
repo provisioned under the old one-container-per-repo model is a `delete`
followed by a `start`:

```bash
./scripts/forge token import <owner/repo>   # reads the old container's `gh auth token` into the host store
./scripts/forge delete <owner/repo>         # deletes the old container; .git, branches, worktrees, WIP survive
./scripts/forge start  <owner/repo> <task>  # provisions a template, recreates the task
```

In-flight work is not recreated — it's **re-adopted**: `.trees/<task>` is
still on the host mount, and `forge start` attaches to it just like it does
for any existing worktree (see "Resolving the task's branch" above). Until
you run this, `forge list` reports the old container as `old model — recreate`
rather than mistaking it for a template.

### Bash completion

Completion is registered for the bare command name `forge`, not a path — if
you invoke the CLI as `./scripts/forge` (this README's convention),
tab-completion won't trigger unless `forge` also resolves on your `PATH`.
Add an alias alongside the `eval` line so both work the same way:

```bash
alias forge=/home/moroine/agent-forge/scripts/forge
eval "$(/home/moroine/agent-forge/scripts/forge completion bash)"
```

**Use the full path in the `eval`, not the alias.** That line has to run
`forge` at the moment `~/.bashrc` reaches it, and an alias defined on a later
line — or a `PATH` entry added further down — is not available yet. When it
cannot run, `$(...)` is empty, `eval ""` defines nothing, and completion falls
back to filenames with no error to explain why. `type _forge_completions`
returning "not found" is the symptom.

The emitted function itself calls `forge` by absolute path, so it keeps
working regardless of how `forge` is resolved in your shell.

Add those two lines to `~/.bashrc` to get tab-completion on `forge
start`/`resume`/`finish`/`stop`/`delete`: `<owner/repo>` in second position,
then the repo's task names on `start`/`resume`/`finish`/`stop` and
`--force` on `delete`/`finish`. `template`, `token` and `claude` also
complete their own subcommands (`rebuild`, `set`/`rm`/`import`,
`update`/`list`).

The completion is fed by two machine-readable subcommands rather than by
parsing the `forge list` table, so reformatting the table can't break it:

```bash
forge completion repos               # one owner/repo per line
forge completion tasks <owner/repo>  # one task name per line
```

Both read LXD config keys only — no `lxc exec` — which is what keeps a TAB
press fast: `completion tasks` lists a repo's task containers by their
`user.forge.role`/`user.forge.task` config, so it works whether they're
running or stopped, and prints nothing (without erroring) for a repo it
doesn't recognize.

### Developing the CLI

The CLI lives in `scripts/forge.ts` and `scripts/lib/`, written in TypeScript
and executed directly by Node — there is no build step and no runtime
dependency, which is why the host needs nothing but Node itself.

```bash
npm install          # development only: typescript + @types/node
npm test             # unit + contract (real git/tmux) + the retained bash tests
npm run check        # tsc --noEmit — Node strips types without checking them
```

`npm run check` is not optional in spirit: Node erases type annotations without
verifying them, so `tsc` is what makes the types mean anything.

Two things stay in bash on purpose: `scripts/lib/forge-image.sh`, which is a
sequence of provisioning shell piped into a container (in TypeScript it would
just become template strings of the same shell, with no readability gain),
and `.claude/hooks/pre-bash.sh`, a container-side security control that must
stay auditable and independent of the container's Node install.

A third test layer runs against a real LXD and is opt-in, because it needs
the host:

```bash
FORGE_INTEGRATION=1 npm run test:integration
```

It creates a throwaway container inside a dedicated `forge-selftest` LXD
project — instances in another project never appear in `forge list` — and
deletes it again. Its `--capture` mode refreshes `tests/fixtures/`, which is
what keeps the faked `lxc` in the other layers honest.
