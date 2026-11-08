# agent-forge

Run Claude Code agents in sealed Incus system containers, one container per
repository and one git worktree per task, on a hardened host that you reach
from your own machine with [herdr](https://herdr.dev).

```
your machine                     host (a VM)                          containers
┌──────────────────────┐  ssh    ┌───────────────────────────┐        ┌──────────────────────┐
│ herdr client         │───────▶ │ herdr server              │ incus  │ agent-<owner>-<repo> │
│ git, ssh (your key)  │         │ forge, Incus, Claude login│──────▶ │ Claude Code, Docker, │
│ Ansible (provisions) │◀─────── │ ~/workspaces/<container>  │  exec  │ Chrome, /workspace   │
└──────────────────────┘  fetch  └───────────────────────────┘        └──────────────────────┘
```

- **The host** is an Ubuntu 26.04 VM that `ansible/site.yml` provisions and
  hardens: a cloud VM or a LAN machine (remote mode), or a Lima VM on your own
  Mac or Ubuntu machine (local mode).
- **The containers** hold no SSH key and no GitHub credential. The host clones
  and fetches with your forwarded SSH agent; agents commit locally and never
  push. You fetch their work from your machine (`forge fetch`), review it, then
  `forge ship` signs it, pushes it and opens the PR.
- **herdr** keeps every agent in a tab of a session that survives your laptop
  closing. One key opens a new task.

The [security model](#security-model) says what this protects against and
what it does not.

## Choose your setup

| | Local | Remote |
|---|---|---|
| Where the host runs | A Lima VM on your Mac (Apple Silicon) or Ubuntu machine | A cloud VM or a machine on your LAN |
| Best for | Trying agent-forge, working on one machine | Agents that keep running while your laptop is off |
| Guide | [Quick start: local](#quick-start-local) | [Remote host](#remote-host) |

Both are one command, `forge install`, run from a checkout of this
repository on your machine. It provisions the host, logs Claude Code in and
builds the image, then opens herdr.

## Quick start: local

About an hour, most of it waiting for the playbook and the image build. The
VM takes 4 CPUs, 6 GiB of memory and a sparse 60 GiB disk (about 11 GiB used
after the first image build); change them with `limactl edit`.

Validated on an Apple Silicon Mac. The Ubuntu 24.04 path is
**not yet validated** on a real machine: report what breaks.

### 1. Install the tools on your machine

**macOS:**

```bash
brew install lima ansible herdr
```

**Ubuntu 24.04:** Lima runs its VMs with QEMU and KVM. Lima itself comes from
its release archive (2.1.2 or newer, see https://github.com/lima-vm/lima/releases),
and Ubuntu's own ansible is too old:

```bash
sudo apt install qemu-system-x86 qemu-utils ovmf pipx   # ovmf: the UEFI firmware Lima boots the VM with
sudo usermod -aG kvm "$USER"          # then log out and back in; /dev/kvm must be writable
curl -fsSL https://github.com/lima-vm/lima/releases/download/v2.2.1/lima-2.2.1-Linux-x86_64.tar.gz \
  | sudo tar -C /usr/local -xz
pipx install ansible-core             # 2.20 or newer
```

Install herdr from its releases (https://herdr.dev).

**Both:** you need git, and an SSH key that GitHub accepts, loaded in the
agent that ssh uses for `github.com` (`ssh-add -L` lists it). The host clones
your repositories with it, through agent forwarding. If that key lives in
another agent (a hardware key's, a password manager's), point `IdentityAgent`
at it in your `~/.ssh/config`, in a `Host github.com` block.

### 2. Install

```bash
git clone https://github.com/moroine/agent-forge.git
cd agent-forge
./cli/forge install
```

With no option, and no host installed yet, `forge install` sets up the local
VM `forge-local`. It never installs anything on your machine: when a tool is
missing it prints the command to run and stops. Run it again afterwards.

It asks little:

- which key is your GitHub key, only when your agent holds several (it uses
  the agent ssh uses for `github.com`);
- whether to add `Include config.d/agent-forge.config` at the top of
  `~/.ssh/config`, so that ssh reads forge's own file. It is not asked when an
  `Include` there already reads that file for every host
  (`Include config.d/*` at the top, or `Include ~/.ssh/config.d/*.config`
  under `Match all` or `Host *`) and forge's values are in effect. Settings
  placed before such an `Include` win over forge's (ssh keeps the first value
  it reads), so forge checks what `ssh -G` resolves for the alias, names each
  setting of yours that wins, and then asks;
- whether to link `~/.local/bin/forge` to the checkout, so `forge` works from
  anywhere (a refusal is asked again on every run);
- whether to turn herdr's notifications on in `~/.config/herdr/config.toml`,
  on your machine, unless that file sets `[ui.toast]` or an inline
  `ui = {…}` itself (a `[ui]` table alone does not stop forge; a refusal is
  asked again on every run);
- the Claude login, once: `claude auth login` prints a URL, you open it and
  paste the code back.

In between it does, in order:

1. checks the prerequisites;
2. creates and starts the Lima VM from `ansible/lima/forge.yaml` (plain mode:
   no shared folder, no port forwarding besides SSH on `127.0.0.1:60022`, or
   a free port if that one is taken; workspaces live inside the VM);
3. writes the inventory, once, to
   `~/.config/agent-forge/hosts/forge-local/inventory.yml` (your edits are
   kept) and runs the playbook from the checkout;
4. writes the SSH alias `forge-local` to `~/.ssh/config.d/agent-forge.config`,
   a file that is forge's own, with forge's own `known_hosts`
   (`~/.config/agent-forge/known_hosts`);
5. gives the host your git identity (`user.name`, `user.email`), the one the
   agents' commits carry;
6. runs `claude auth login` on the host, unless it is already logged in; every
   new container reuses those credentials;
7. runs `forge setup` there: forge's Incus objects, the egress proxy and its
   allowlist when Incus is recent enough (see
   [Strict egress mode](#strict-egress-mode)), and forge's herdr key bindings
   on the host;
8. builds `agent-base` (about 10 minutes) when it is missing or older than the
   checkout's image inputs;
9. turns herdr's notifications on in your machine's herdr config if you say
   yes: they are a setting of the client, not of the host (see
   [step 3](#3-start-a-task-from-herdr));
10. prints a summary and opens herdr.

A run that fails stops with the step to fix; run `forge install` again and it
resumes. `forge install` refuses a `forge-local` Lima VM or a `Host` entry it
did not create, and says what to remove.

On a fresh host, `forge setup` prints two notices:

```
NOTICE: Incus 7.0.1 is too old for strict mode, which needs 7.0.2 or later on the 7.0 LTS line ...
NOTICE: herdr is not installed on this host yet, which is expected before your first attach ...
```

The first goes away once Zabbly publishes Incus 7.0.2 and you update (see
[Updating](#updating)); the second at your first `herdr --remote`.

With a touch-to-use hardware key, a first install asks for about a dozen
touches: one per SSH connection.

#### What `forge install` changes on your machine

| Path | What | Mode | Asked |
|---|---|---|---|
| `~/.config/agent-forge/hosts.json` | The hosts this machine installed | 0600 | No |
| `~/.config/agent-forge/hosts/<name>/` | Per host: `inventory.yml`, the generated inventory, written once (your edits are kept), and `forge-key.pub`, the public half of your GitHub key | 0700; 0600 and 0644 | No |
| `~/.config/agent-forge/known_hosts` | forge's own `known_hosts`: the hosts' keys, for the alias and for Ansible | Written by ssh | No |
| `~/.local/share/agent-forge/collections` | The Ansible collections the playbook needs | Written by `ansible-galaxy` | No |
| `~/.ssh/config.d/agent-forge.config` | forge's own SSH file: one block per host, rewritten on every run | 0600; 0700 for a directory forge creates | No |
| `~/.ssh/config` | One line at the top, `Include config.d/agent-forge.config`, and a blank line before your own first line, only when no `Include` there reads forge's file for every host with forge's values in effect. Nothing else changes | Kept; 0600 if forge creates it | Yes |
| `~/.config/herdr/config.toml` | A block of forge's own at the end, `[ui.toast]` then `delivery = "herdr"`, only when the file sets neither `[ui.toast]` nor an inline `ui = {…}` | Kept; 0644 if forge creates it, 0700 for a directory forge creates | Yes |
| `~/.local/bin/forge` | A link to the checkout's `cli/forge` | A link | Yes |

forge creates `~/.config/agent-forge` 0700. A `~/.ssh/config.d/agent-forge` that
an earlier forge wrote (it starts with forge's header line) counts as forge's
own, and is removed once ssh reads the new file: until then it keeps the alias
working. Any other file of that name stays.

forge's SSH file, for `forge-local`:

```
# Managed by forge install: edits are overwritten.

Host forge-local
  HostName 127.0.0.1
  Port 60022
  User forge
  HostKeyAlias forge-local
  StrictHostKeyChecking accept-new
  UserKnownHostsFile ~/.config/agent-forge/known_hosts
  IdentityFile ~/.config/agent-forge/hosts/forge-local/forge-key.pub
  IdentitiesOnly yes
  ForwardAgent yes
```

- forge writes your home's full path where this shows `~`.
- `HostKeyAlias` and `accept-new`: the VM's port and host key change when it
  is recreated, so its key is pinned under a stable name. A remote host's
  block has neither: OpenSSH asked about its key at the first connection.
- `IdentityFile` names the public half of your GitHub key, which stays in
  your agent; `IdentitiesOnly` offers only that key.
- An `IdentityAgent` line comes before `ForwardAgent` when your ssh uses
  another agent than `SSH_AUTH_SOCK`'s for `github.com`.
- `ForwardAgent yes`: the host clones and fetches your repositories with your
  agent. Containers never get it.

The tools write their own files: Lima keeps the VM in `~/.lima/forge-local`
(and its SSH key, which the inventory uses, in `~/.lima/_config`), and
Ansible its own in `~/.ansible`.

#### To undo

Fetch the work you want first: the local VM's workspaces live inside it.

```bash
limactl stop forge-local                 # if it is running
limactl delete forge-local
limactl prune                            # Lima's cache of downloaded images, for every VM
rm -r ~/.config/agent-forge ~/.local/share/agent-forge
rm ~/.ssh/config.d/agent-forge.config
rm ~/.local/bin/forge                    # if it is forge's link
```

`~/.config/agent-forge` also holds `known_hosts.old`, which `ssh-keygen -R`
leaves when forge forgets a VM's keys. Then remove what forge added to your
own files, if it did: the `Include config.d/agent-forge.config` line at the
top of `~/.ssh/config` (and an `Include config.d/agent-forge` line left by a
pre-release run, with `~/.ssh/config.d/agent-forge` if it is still there),
and the block from `# >>> agent-forge laptop >>>` to
`# <<< agent-forge laptop <<<` in `~/.config/herdr/config.toml`. A remote VM
is deleted at your provider. `~/.lima/_config` and `~/.ansible` belong to
Lima and Ansible, which may use them for other things.

### 3. Start a task from herdr

`forge install` ends by opening herdr. Later:

```bash
./cli/forge open
```

It runs `herdr --remote forge-local --remote-keybindings server` for you, and
starts the VM first if it is stopped. In a real terminal: the first attach
asks to install herdr on the host. `--remote-keybindings server` is required:
forge's keys live on the host.

Press `prefix+f` (herdr's prefix is `ctrl+b`). A popup asks for the repository
(`owner/repo`, the first time) and the task:

- the first `prefix+f` on a repository creates its container and clones it on
  the host;
- each task gets a worktree, `/workspace/.trees/<task>` on branch
  `agent/<task>`, and its own tab running Claude Code.

On success the popup closes by itself; warnings show up as a herdr
notification. After an error it stays open until you press Enter.

Those notifications only show if herdr has toasts turned on on your machine,
in `~/.config/herdr/config.toml`: `forge install` offers to add `[ui.toast]`
then `delivery = "herdr"` there, in a block of its own. If you said no, or if
that file sets `[ui.toast]` or an inline `ui = {…}` itself (forge then leaves
it alone; a `[ui]` table alone does not stop it), set them there yourself.
Otherwise herdr still reports the notification as shown, and the popup's
warnings go unseen.

### 4. Get the work back

On your machine, in your own clone of the repository (not in the VM):

```bash
forge fetch
```

The first run adds a git remote named after the container
(`agent-acme-widgets`) that points at your forge host, and says so, then
fetches the agents' `agent/*` branches through it, without the container's
tags. The host serves the repository from inside the container and never runs
git in the agent's workspace. `forge fetch` also refreshes `origin` and lists
each task with its commit count and the branch it started from:

```
Fetching agent-acme-widgets…
Fetching origin…
agent/fix-login  3 commits on origin/main
```

Review the branch against that base, then ship it:

```bash
git log -p origin/main..agent-acme-widgets/agent/fix-login
forge ship fix-login
```

A stacked task is reviewed against the task it started from, the base that
`forge fetch` lists: for `agent/fix-tests  2 commits on agent/fix-login`, that
is `git log -p agent-acme-widgets/agent/fix-login..agent-acme-widgets/agent/fix-tests`.

`forge ship <task>` re-signs the agent's commits that are not on GitHub yet
with your own git signing configuration, pushes `agent/<task>` and opens its
pull request (or finds the one that exists). It fetches again first, then
lists every commit it will sign, task by task, and asks once before signing:
the agent may have committed since your review. It replays the commits in a
temporary worktree, so your checkout is never touched, and runs no git hook
there: the tree is the agent's. It never force-pushes: if GitHub's
`agent/<task>` moved since the fetch, it stops and asks you to run `forge
ship` again, and a conflict stops it at the commit it names. Each signature
may need a touch of your key. A task whose pull request is already merged
ships new commits only after a confirmation, as a new pull request.

A stacked task, started from another task's branch (`forge start`, then
"other branch…"), ships its whole chain, bottom first: shipping `b`, started
from `agent/a`, pushes `agent/a` then `agent/b`, and `b`'s pull request
targets `agent/a`.

`forge ship` needs the GitHub CLI, installed and logged in on your machine
(`gh auth login`). `--host <name>` picks the forge host when you have several.

### The local VM day to day

- `limactl stop forge-local` / `limactl start forge-local`. Agents stop with
  the VM; after a start, `forge open` (it starts a stopped VM too) and press
  `prefix+shift+f` to bring them back with their conversation.
- To start over: fetch every branch you want first (workspaces live in the
  VM), then `limactl delete forge-local`. The next `forge install` offers to
  forget the old VM and installs a new one.

## Remote host

The same install, on a VM that you create:

1. **The VM.** Ubuntu 26.04, at least 2 vCPU, 4 GB of memory and a 40 GB disk
   (more for several agents), with an admin account that has passwordless
   sudo and that your key can log in to (`ubuntu` on most cloud images). Let
   SSH (port 22) through the provider's firewall.
2. **The install**, from a checkout, with the VM's address:

   ```bash
   ./cli/forge install --remote 203.0.113.10
   ```

   The prerequisites are the local ones, without Lima. It asks:
   - the host's name, `forge-<name>` (as `forge-acme`), which is also its SSH
     alias;
   - the admin account (default `ubuntu`);
   - the exposure: `public` for a cloud VM, `lan` for a machine on your
     network;
   - your forge user on the host (default: your login on this machine);
   - the key the admin account accepts: your GitHub key, or a private key
     file.

   Then it follows the steps of the local install. The first connection shows
   OpenSSH's own host-key question: check the fingerprint with your provider
   before you answer. If that first connection never succeeds, the next
   `forge install --host forge-acme` offers to retry or to forget your
   answers. An admin account with a sudo password, or other playbook options:
   see "Installing by hand" in `ansible/README.md`.

`forge open --host forge-acme` opens herdr on it, and
`forge fetch --host forge-acme` fetches its work (step
[4](#4-get-the-work-back)). With several hosts installed, `forge open` asks which one. `forge install`
with no option goes to `forge-local` when it is listed, and asks which host
only when just remote hosts are listed.

## Daily use

### Keys

| Key | What it does |
|---|---|
| `prefix+f` | `forge start` in a popup: pick a repository and a task; opens or focuses the task's tab. One herdr workspace per repository, one tab per task |
| `prefix+shift+f` | `forge resume --all`: after a herdr server restart or a VM reboot, relaunches the agent in every forge tab left as a bare shell, with its conversation |

Agents keep running when you detach. In remote mode they also run while
your laptop sleeps; in local mode they pause with the VM.

### Commands

Run on your machine, from the checkout (or through the `~/.local/bin/forge`
link):

| Command | What it does |
|---|---|
| `forge install [--remote <address>] [--host <name>]` | Install or update a host: the local VM by default, a new remote VM with `--remote`, an installed host with `--host` |
| `forge open [--host <name>]` | Open herdr on a host |
| `forge fetch [--host <name>]` | In your clone: fetch the agents' branches and list the tasks (needs no `gh`) |
| `forge ship <task> [--host <name>]` | In your clone: re-sign, push and open the PR; needs `gh auth login` |

Run on the host (in a herdr pane, or over `ssh`):

| Command | What it does |
|---|---|
| `forge start [--strict] [<owner/repo>] [<task>]` | Create the container if needed, then open the task. `--strict` creates a new container in strict egress mode |
| `forge resume [<owner/repo>] [<task>]` | Re-attach a task's agent, with no fetch; `--all` for every forge tab (inside herdr) |
| `forge finish [<owner/repo>] [<task>]` | Stop the task's agent and remove its worktree, refused on uncommitted changes unless `--force`. The branch `agent/<task>` stays; a task name reused later starts a fresh conversation |
| `forge list` | Every container: repository, mode, egress, state, image build |
| `forge stop [<owner/repo>] [--force]` | Stop a container; refused while a task has uncommitted changes, unless `--force`. Commits are not checked: fetch them first |
| `forge delete [<owner/repo>] [--force]` | Delete a container, with the same guard. Its workspace and the host's mirror stay, and `forge start` reuses them |
| `forge egress [<owner/repo>] [strict\|open]` | Show or switch a stopped container's egress |
| `forge egress log [<owner/repo>]` | The egress proxy's recent requests |
| `forge attach <container> <task>` | Run a task's agent in this terminal: what herdr tabs run |
| `forge image build` | Rebuild `agent-base` |
| `forge completion bash` | Bash completion (already installed on the host by Ansible) |

A bracketed argument left out is asked for, as a numbered menu.

**Outside herdr** (plain `ssh`), `forge start` and `forge resume` run the
agent in the foreground and say
`outside herdr: the agent stops when this terminal closes`: no persistence.

### Rules for getting work back

- **Never run git yourself in `~/workspaces/<container>` on the host,** and do
  not `cd` there with a git-aware prompt. The agent controls that repository,
  hooks and `.git/config` included, and host git would run its commands as
  you. Fetch and ship from your machine, as in step 4.
- **Review agent code before running it on your machine.** Checking out an
  agent branch and running its scripts (`npm install`, test runners) runs the
  agent's code there.
- **Large files:** Git LFS content is not available inside containers; files
  are checked out as pointers.
- **Submodules:** not set up inside containers. The host mirrors the
  repository alone, so `git submodule update --init` fails for a relative URL
  (`../other.git` resolves to `/forge/other.git`, which does not exist), for
  an SSH URL (`git@github.com:…`, even to a public repository) and for a
  private repository (no SSH key nor GitHub credential in the container). A
  public HTTPS URL may work, egress permitting. Scripts that rely on a missing
  submodule fail in the container; the agent has to work around them.

Inside the container, `origin` is a read-only mirror the host refreshes at
each `forge start`: the agent can `git fetch origin`, never push.

### Strict egress mode

By default a container reaches the internet, but not private, link-local,
CGNAT or multicast ranges (your LAN, the cloud metadata service, the host, the
other containers). Strict mode is per container: it reaches only the domains
on your allowlist, through a filtering proxy (`forge-proxy`) that
`forge setup` manages, and it fails closed: a program that ignores the proxy
reaches nothing.

- **The allowlist** is `~/.config/agent-forge/egress-allowlist` on the host,
  one domain per line (`example.com`, or `.example.com` for its subdomains
  too). `forge setup` creates it with Claude Code's own domains active and
  common ones (GitHub, npm, PyPI, Docker Hub) commented out, each with what
  it lets a hijacked agent do. Edit it, then run `forge setup` to apply it.
- `forge start --strict <owner/repo>` creates a container strict from its
  first boot.
- `forge egress <owner/repo> strict` or `open` switches a stopped container
  (`forge stop` first); `forge egress` alone shows it.
- `forge egress log` shows what was allowed and refused: use it to find the
  domain to add.
- Docker in a strict container pulls through the proxy; builds and containers
  get no proxy unless you pass `HTTPS_PROXY` to them.
- Strict mode needs Incus 7.0.2 or newer on the 7.0 LTS line, or 7.5.0 or
  newer. 7.0.2 is not published yet on Zabbly's lts-7.0 channel, which the
  playbook installs from (October 2026): until it is, `forge setup` prints a
  notice and skips the strict objects, and `forge start --strict` is refused.
  Re-running the playbook upgrades Incus once 7.0.2 is out.

### Docker, Compose and the browser

- **Docker and Compose** run rootless inside every container, as the agent's
  own unprivileged user, for repositories that need a database or other
  services. `pre-bash.sh` blocks `--privileged`, host namespaces and bind
  mounts outside `/workspace`.
- **Chrome DevTools MCP** is configured in every container. The agent drives
  headless Chrome to check a running app: navigation, screenshots, console
  and network.

### The image

`forge list` shows `behind` in the BUILD column when a container was created
from an older `agent-base` than the latest build. After `forge image build`,
existing containers keep their image until recreated: `forge delete`, then
`forge start` (the workspace is kept).

## Updating

From your machine, in the agent-forge checkout:

```bash
git pull
./cli/forge install
```

For a remote host, `forge install --host forge-acme`. On a finished host,
`forge install` updates it: the playbook (which deploys the checkout's
`forge` and upgrades Incus within its channel), `forge setup`, and the image
build when the image's inputs changed (it asks when it cannot tell).

## Configuration

Both files live on the host and are optional; `forge setup` reads them.

- **`~/.config/agent-forge/config.json`**, with its defaults:

  ```json
  {
    "network": { "ipv4Address": "10.77.0.1/24" },
    "storagePool": "default",
    "limits": { "cpu": null, "memory": "75%", "processes": 10000, "rootDisk": "50GiB" }
  }
  ```

  - `network.ipv4Address`: the bridge's address, a /27 or wider inside
    `10.0.0.0/8`, `172.16.0.0/12` or `192.168.0.0/16`;
  - `limits`: per container. `cpu` is `null` (no limit), a number or a CPU
    set; `memory` a size or a percentage of the host's; `rootDisk` is a guard
    rail, not a hard limit.

  An unknown key or an invalid value stops `forge setup` with the file and
  the key.
- **`~/.config/agent-forge/egress-allowlist`**: see
  [Strict egress mode](#strict-egress-mode).

## Security model

| Threat | What stands in the way |
|---|---|
| An agent escapes its container | Unprivileged container, seccomp, capability drops, Incus' AppArmor profile. It lands in the host VM, not on your machine |
| A container reaches your LAN, the cloud metadata service, the host or another container | The `forge-egress` network ACL rejects private, link-local, CGNAT and multicast ranges; IPv6 is off on the bridge |
| An agent sends code or tokens out | Accepted in the default open mode. Strict mode limits egress to your allowlist |
| An agent publishes to GitHub | No GitHub credential in containers; `pre-bash.sh` blocks `git push` and `gh` |
| An agent drives other agents' tabs | herdr's control socket lives on the host, outside every container |
| SSH brute force on the host | Keys only, fail2ban (not in local mode), a connection rate limit (`public`), an optional source restriction |
| Your forwarded agent is abused on the host | Containers never receive it; a hardware key asks for a touch per use |

Known limits:

- **Local mode:** the Lima VM can reach your machine's localhost and your LAN
  (containers cannot). An agent that escaped its container into the VM could
  too.
- **DNS:** a container can still tunnel data through DNS queries to the
  bridge, in both modes.
- **Strict mode** does not inspect TLS: an allowed domain that accepts uploads
  (a package registry, an API with another key) is still a way out.
- **Escape sequences:** agent output reaches herdr and your terminal (window
  titles, clipboard).
- The forge user on the host is root-equivalent through Incus (one user per
  VM).

## Troubleshooting

- **A container was half provisioned** (provisioning stopped midway): the
  next `forge start` offers to recreate it; `forge delete <owner/repo>`
  removes it. The mirror survives either way, and so does a workspace from an
  earlier run; a workspace the failed attempt created itself is emptied. A
  container half provisioned before this version has no marker: `forge start`
  then tells you to run `forge delete <owner/repo>`, which asks first.
- **Provisioning says the security hook refuses a harmless command:** the
  image predates a change to it. Run `forge image build`, then recreate the
  container.
- **`REMOTE HOST IDENTIFICATION HAS CHANGED`** after recreating a remote VM
  at the same address: a host forge installed keeps its key in forge's own
  file. Remove the old key, then record the new one yourself:
  `ssh-keygen -R 203.0.113.10 -f ~/.config/agent-forge/known_hosts` (the VM's
  address), then `ssh forge-acme true` once in a terminal. Check the
  fingerprint OpenSSH shows against your provider's console and answer yes:
  the alias and the playbook's admin connection read the same file, and
  nothing else records the key. Then `forge install --host forge-acme`. For
  the local VM, `forge install` handles it when it recreates the VM.
- **The host cannot clone** (`Permission denied (publickey)` or
  `Error connecting to agent`): the agent is not forwarded. Check
  `ForwardAgent yes` and `IdentityAgent` in your SSH config, and that you are
  attached: with no client attached, the host has no agent.
- **`herdr --remote` fails the first time:** run it in a real terminal; it
  asks before installing herdr on the host.
- **`forge start` stops on `smudge filter lfs failed`** (a repository with
  Git LFS files): the container was provisioned by an older forge, whose
  git-lfs configuration downloads LFS objects the mirror does not hold. Fix it
  once on the host with
  `incus --project agent-forge exec <container> -- su - aiuser -c 'git lfs install --skip-repo --skip-smudge'`,
  or recreate the container (`forge delete`, then `forge start`; the
  workspace is kept).
- **A repository whose default branch is not `main`:** new tasks start from
  `origin/main`, so such a repository is not supported yet.
- **`forge setup` warns that forge runs directly on this machine:** you ran it
  outside a VM. Use the Lima VM: nothing would stand between an escaped agent
  and your machine.

## Developing agent-forge

- Read [CONTRIBUTING.md](CONTRIBUTING.md) first, and install the
  secret-scanning pre-commit hook once with `npm run hooks:install`.
- `npm test` (unit, contract and bash tests), `npm run check` (types),
  `npm run test:ansible` (the playbook's unit tests) and
  `ansible-lint ansible/`.
- `FORGE_INTEGRATION=1 npm run test:integration` runs against a real,
  throwaway Incus.
- An agent can develop agent-forge on its own AWS VM, as a contributor: see
  [docs/contributor-model.md](docs/contributor-model.md).
- `ansible/tests/vm-test.sh` provisions a fresh machine twice, verifies it,
  reboots it and verifies again: `--lima` for a throwaway Lima VM, `--host`
  for a fresh cloud VM, or a VM on an Incus host with KVM. See
  `ansible/README.md`.
- Designs and plans live in `docs/superpowers/`.

## License

Copyright (C) 2026 the agent-forge contributors.

agent-forge is free software, licensed under the GNU Affero General Public
License, version 3 only (`AGPL-3.0-only`). See [LICENSE](LICENSE).
