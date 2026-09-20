# One Container per Task — Design

**Date:** 2026-09-20
**Status:** Approved (brainstorming), ready for planning
**Repo:** agent-forge
**Follow-ups split out:** specs 2 and 3, plus one BACKLOG item — see
`docs/superpowers/BACKLOG.md`

## Context

The current model is **one container per repo, many worktrees**. The
2026-08-28 worktrees spec chose it deliberately and listed the trade-off under
its non-goals: *"Per-task security/resource isolation (rejected the
container-per-feature model): parallel tasks share one container's CPU/RAM."*

That framing turned out to be incomplete. The binding constraint is not CPU or
RAM — it is the **network namespace**, which every worktree of a container
shares. Since Docker support landed (2026-07-17 spec), a repo whose tasks run
`docker compose up` cannot host two parallel agents:

- **published ports collide** (`80`, `3000`, `5432`…) — only one agent can
  bind;
- **`container_name:` entries hardcoded in a repo's compose file** collide;
- the Docker image store and build cache are shared, so concurrent builds
  contend.

What does *not* break: `COMPOSE_PROJECT_NAME` derives from the directory name,
so `.trees/feat-a` and `.trees/feat-b` already produce distinct compose
projects. The problem is confined to what a namespace boundary would solve.

The goal is to make **the container the unit of a task**, while keeping the
property that made the current model pleasant: starting a second task on an
already-provisioned repo must stay cheap.

## Decisions

| Decision | Choice |
|---|---|
| Isolation unit | One LXD container per **task**, not per repo. |
| Workspace | **One host mount per repo, mounted into every task container.** The single clone, the shared `.git` and the `.trees/<task>` layout are unchanged. The container split buys network/Docker isolation without duplicating the repo. |
| New-task creation | Copy a per-repo **template container** (`lxc copy`), always stopped, never used for work. |
| Template freshness | Surfaced, never automatic: `forge list` shows `ok`/`behind` against `agent-base`, `forge start` warns and proceeds, `forge template rebuild <repo>` is an explicit operator decision. |
| GitHub PAT | Stored **on the host**, at `~/.config/agent-forge/credentials/<owner>-<repo>`, `chmod 600`. |
| `claude-code` | Installed on the host in versioned directories, exposed to every container through a **read-only disk device**, resolved once at launch by a shim. |
| npm / pnpm caches | Shared **per repo**, inside the repo's host mount at `/workspace/.forge-cache/`. |
| Command semantics | `finish` destroys (worktree + container), `stop` is a reversible pause with **no WIP pre-flight**, `delete` operates at the repo level. |
| Resource limits | Unchanged (8 CPU / 12 GB / 100 GB). Pressure is managed by `stop`/`finish`/prune, not by lowering ceilings. |
| Migration | No dedicated command. `forge token import` → `forge delete` → `forge start`. |

## Design

### 1. Entities

Three entities where there were two. The host mount is unchanged; the
container layer splits.

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

The template **keeps the name the repo container has today**
(`agent-<owner>-<repo>`); task containers suffix it. The distinction is
carried by a config key, `user.forge.role`, not by the name: a legacy
container has no `role`, so `forge list` can report it as "old model —
recreate" instead of mistaking it for a template.

Instance names are capped at 63 characters by LXD. `agent-<owner>-<repo>-<task>`
is truncated with a short hash suffix when it would exceed that.

Two consequences of the shared mount carry the rest of the design:

- **Any container of a repo can drive git.** There is one `.git`, mounted
  everywhere. So `finish` can remove the worktree of a task whose container is
  already stopped by going through the template — without that, every cleanup
  would leave an orphaned `.git/worktrees/<task>` entry behind.
- **Nothing that matters lives inside a container.** Code, commits, WIP,
  `node_modules`: all under `/workspace`, on the host. That is what makes
  `stop` safe without a pre-flight and `finish` safe to destroy.

### 2. Command surface

```
forge start    [<repo>] [<task>]           copy the template + worktree + attach
forge resume   [<repo>] [<task>]           re-attach (start the container if stopped)
forge stop     [<repo>] [<task>]           PAUSE — no WIP pre-flight
                                           without <task>: every container of the repo
forge finish   [<repo>] [<task>] [--force] WIP pre-flight → worktree removed and
                                           container deleted. Branch retained.
forge delete   [<repo>] [--force]          WIP pre-flight across all worktrees →
                                           deletes the tasks AND the template.
                                           The host mount survives.
forge list                                 grouped by repo: template state, then one
                                           line per task (container + session)
forge template rebuild [<repo>]            rebuild the template from agent-base,
                                           credentials re-read from the host store
forge token    set|rm|import [<repo>]      manage the host PAT store
forge claude   update [<version>] | list   install a version on the host, switch `current`
forge image    build|update [super]        unchanged
forge completion …                         unchanged (tasks = task containers)
```

`containerForRepo`, which assumed one container per repo, splits into
`templateForRepo`, `containersForRepo` and `containerForTask`. That is the
central refactor in `containers.ts`; the rest of the command layer follows
mechanically.

#### `forge start <repo> <task>`

```
template absent ? → full provisioning (clone, gh auth, stamp), then lxc stop
template behind  ? → warn, do not block
lxc copy <template> agent-<repo>-<task>     ← template Stopped ⇒ consistent copy
lxc config set … role=task, task=<task>
lxc start
git fetch + ff main                          ← from the task container
git worktree add .trees/<task>               ← same branch resolution as today:
                                               local branch > origin/agent/<task> > origin/main
tmux attach --remote-control agent-<repo>-<task>
```

The remote-control name loses its suffix: the container name already carries
the task.

An existing `.trees/<task>` is **adopted**, not recreated — `start` already
does this ("Worktree .trees/X is already there — attaching to it"), and the
migration path in §8 depends on it.

Two concurrent `forge start` calls on the same repo both `lxc copy` the same
stopped template (read-only, safe) and both `git worktree add` into the same
`.git` (git's own locking arbitrates).

#### `forge finish <repo> <task>`

Order matters: the worktree must be removed **before** the container is
deleted, otherwise the `.git/worktrees/<task>` entry is orphaned. When the
task container is stopped, the removal goes through the template instead (§1).

```
WIP pre-flight (unless --force)
tmux kill-session
git worktree remove .trees/<task>    ← from the task container, or the template
lxc delete agent-<repo>-<task>
branch agent/<task> retained
```

#### Why `stop` loses its WIP pre-flight

`stop` is no longer "cut the whole repo"; it is "pause this task". Everything
it could endanger is on the host mount and survives. Keeping a pre-flight
there would add friction to the gesture we most want to encourage — the one
that actually frees RAM, CPU and Docker — and would warn about a danger that
no longer exists. `finish` and `delete` keep theirs.

### 3. Credentials — host store

```
~/.config/agent-forge/credentials/<owner>-<repo>     chmod 600, owner moroine
```

The 2026-07-17 design kept the PAT off host disk. That precaution defends
against nothing realistic here: whoever controls the host has `lxc exec` as
root into every container and already has the token. The only real delta is a
host-home backup carrying the file — accepted on a dedicated, controlled
machine.

The location rule that does matter: **never under `~/workspaces/`**, since
everything under the mount is readable by the agent through `/workspace`. The
token still reaches `gh auth login --with-token` through **stdin**, never
`argv` (visible in `ps`). Provisioning only prompts when the store is empty.

What this unlocks: `forge template rebuild` just re-reads the store instead of
fishing the token out of the old template; provisioning becomes
non-interactive, therefore scriptable and testable end to end; and losing a
template no longer costs a PAT re-paste.

### 4. `claude-code` — read-only versioned mount

The template makes *provisioning* fast but cannot keep a long-lived task
container fresh: it stays pinned to the `claude-code` of the day it was
copied. Only a source outside the container fixes staleness.

```
host  ~/.local/share/agent-forge/claude/versions/<v>/     immutable
                                        current -> versions/<v>    (ln -sfn, atomic)
   └─ disk device, readonly=true ─▶ container  /opt/forge-claude
                                    shim /usr/local/bin/claude:
                                      V=$(readlink -f /opt/forge-claude/current)
                                      exec node "$V/cli.js" "$@"
```

Overwriting a Node install under a running process is a real hazard —
`claude-code` imports lazily, so a module can vanish before it is loaded. The
nvm/pnpm pattern removes it entirely: immutable versioned installs, an
atomically renamed symlink, and **resolution once at launch**. A running
session stays on its version; the next one picks up the new one; nothing is
pulled out from under a process. Old versions are garbage-collected once
nothing references them.

`forge claude update` installs a version and flips the link; `forge claude
list` shows what is present and which is `current`.

**Plugins stay in the template.** `claude plugin install` writes into
`~/.claude/plugins/` (including a cache), so a read-only mount cannot host
them, and they move far less often than the CLI.

Side effect worth stating: `forge template rebuild` no longer runs a network
`npm install -g`, so it becomes local and nearly free.

### 5. npm / pnpm caches — inside the repo mount

The obvious placement — a dedicated host directory mounted as a second device
— is **wrong for pnpm**, for a precise reason. pnpm's speed comes from
**hardlinking** from its store into `node_modules`, and the kernel refuses
`link()` across two mount points (`EXDEV`) even when the same filesystem lies
underneath. A store on a second device and `node_modules` under
`/workspace/.trees/<task>/` are two distinct bind mounts: pnpm would fall back
to copying every package, paying the complexity for none of the gain. (On
btrfs/xfs, `package-import-method=clone` would salvage it via reflink; on
ext4, not. The design must not depend on the host filesystem.)

Hence: **inside the repo mount, in the same mount as the worktrees.**

```
~/workspaces/agent-<owner>-<repo>/
  .git/   <main>   .trees/feat-a/   .trees/feat-b/
  .forge-cache/
    pnpm/     shared pnpm store      ← same mount as .trees/ ⇒ hardlinks work
    npm/      npm cache (cacache)
```

Excluded through `.git/info/exclude`, exactly as `.trees/` already is.
Configured once in the template (`npm config set cache`, `pnpm config set
store-dir`), so every task inherits it through the copy with no extra step.

The second task of a repo re-downloads nothing, and the cache follows the
repo's lifecycle: `forge delete` leaves it warm, because the host mount
survives.

Three accepted reservations:

- **Per repo, not global.** A global cache would mean mounting the parent
  `~/workspaces/` into every container, exposing every repo's code to every
  agent. The gain does not justify that loss of scope.
- **Concurrency.** Two tasks of one repo may `pnpm install` against the same
  store simultaneously. Both caches are content-addressed with atomic writes
  (tmp + rename) — the scenario they are designed for. The realistic worst
  case is a corrupted entry that re-downloads, not lost work.
- **The agent can write to it.** One task could poison a sibling's cache — but
  both are agents of the same repo with the same credentials, so no privilege
  boundary is crossed. Already true of `node_modules` today.

The **Docker** cache is not shareable this way: it lives in the container
rootfs, so each task inherits whatever the template held at copy time and
nothing more. That is the price of the clean template. If it bites in real
use, a one-off `docker compose pull` inside the template is the escape hatch.

### 6. Security and the LXD profile

The posture does not change: `security.privileged` stays `false`,
`security.nesting` stays `true` for Docker, every `lxc.cap.drop` is intact,
and `pre-bash.sh` needs no new rule. Two additions only:

- **the same host `source=` mounted into N containers** — supported by LXD,
  and without `shift=true` since every container carries the same profile and
  therefore the same `raw.idmap` (1000 → 1001);
- **one extra `disk` device, `readonly=true`**, for `/opt/forge-claude`. This
  is a hardening, not a relaxation: the CLI becomes unmodifiable from inside.

What the split gains: two tasks no longer share a network namespace, a Docker
daemon, a PID namespace or `/tmp`. The port conflict disappears because a real
boundary appears — and an agent can no longer kill another agent's processes
(today, same container, same UID, `kill` works).

**Non-goal, stated explicitly:** `/workspace` stays shared. A task can read
and modify the code, the `.git` and the cache of every other task of the same
repo. Unchanged from today, and the accepted price of the single mount.

### 7. Super mode

`lxd init --minimal` moves from per-container provisioning into **the
template, once**. Task containers inherit an already-initialised nested LXD
through the copy — and this is where "the template is always stopped" pays
most: copying a live dqlite mid-write would be a genuine problem, copying a
stopped daemon is not. Two copies share the nested LXD's certificate and
bridge name, but in separate network namespaces, so they do not collide.

### 8. Migration — no dedicated command

The host mount carries everything that matters, so migration is a delete
followed by a start:

```
forge token import <repo>     # reads `gh auth token` in the old container (started if stopped) → host store
forge delete <repo>           # deletes the old container; .git, branches, worktrees, WIP survive
forge start <repo> <task>     # provisions the template, recreates the task
```

In-flight work is not recreated but **re-adopted**: `.trees/<task>` is still
there and `start` attaches to it (§2). `forge list` reports a container with
no `user.forge.role` as "old model — recreate".

## Non-goals

- `exit → stop + cleanup` on remote-control exit — **spec 2**.
- `forge prune` (containers, worktrees, merged branches) — **spec 3**.
- Refreshing expired Claude OAuth credentials in long-lived containers —
  BACKLOG. Worth noting the split makes it more likely to bite:
  `~/.claude/.credentials.json` is pushed once at provisioning and never
  refreshed, and more containers means more chances to hit it.
- Per-task filesystem isolation within a repo (§6).
- Sharing the Docker cache, or sharing npm/pnpm caches across repos (§5).
- Lowering per-container resource ceilings or capping the number of running
  containers. Pressure is managed by `stop`, `finish` and prune.

## Testing

Aligned on the four existing layers.

**Unit** (`tests/*.test.ts`, `fake-context` / `fake-lxc`) carries the bulk: the
`containers.ts` split (`templateForRepo` / `containersForRepo` /
`containerForTask`), `start` (copy vs. full provisioning, template-behind
warning, worktree adoption), `finish` (the ordering — worktree removed *before*
`lxc delete`, through the template when the task container is stopped), `stop`
without pre-flight, repo-level `delete`, grouped `list`, legacy-container
detection, the credential store (paths and permissions), and the shim's
version resolution.

**Contract** (`tests/contract/`): one new git contract test — `worktree
remove` driven from a third directory (the template), since that is the new
mechanism. `lxc copy`/`lxc config` parsing adds nothing.

**Bash** (`tests/test-*.sh`): `test-lxd-agent-profile.sh` for the read-only
device, `test-claude-template.sh` for the updated instructions,
`test-readme-docs.sh`.

**Integration** (`tests/integration/`, opt-in `FORGE_INTEGRATION=1`, inside a
super container) — the three assertions that could disprove the design, and
that cannot be settled without a live LXD:

1. the same host directory mounted into two containers, written from both,
   with consistent file ownership;
2. **a successful hardlink** between `.forge-cache/pnpm` and
   `.trees/<task>/node_modules` — all of §5 rests on it;
3. a **super** container copied from a template starting its nested LXD
   correctly.

## Documentation

`README.md` (architecture, command reference, the autonomous PR flow section),
`CLAUDE.md` (the project conventions block), and `templates/CLAUDE.md` (the
agent's working directory is now its own container; the supervised retrieval
snippet names a task container, not a repo container).
