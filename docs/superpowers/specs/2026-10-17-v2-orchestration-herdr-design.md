# agent-forge v2, sub-project 4: Orchestration (herdr) — Design

**Date:** 2026-10-17
**Status:** Approved by the user (2026-10-18)
**Branch:** `agent/v2-herdr-spec`, stacked on `agent/fix-forge-entrypoint` → `next`
**Framing spec:** `docs/superpowers/specs/2026-10-15-v2-incus-ansible-herdr-design.md`
**Spike report:** `docs/superpowers/spikes/2026-10-15-v2-validation-spike.md`
**Runtime spec (sub-project 2):** `docs/superpowers/specs/2026-10-15-v2-runtime-design.md`

## Context

The framing spec gives sub-project 4 the herdr integration and key bindings,
the removal of tmux, `forge resume` through `claude --continue`, and the
host-side fetch. Sub-project 2 also found a security hole that this
sub-project must close: host-side git runs in a repository the agent can
write.

### What the user wants

From the brainstorming of 2026-10-17 (Moroine):

- **The pain today (v1 on omen):** "SSH in by hand, list the sessions, no
  simple and transparent interface to the infrastructure. I want fluidity."
- **The target:** "Open my herdr the way I open VSCode." One command, and
  every agent is there as a tab, with its state visible.
- **What it is for:** running tasks in parallel on the VM. The work must not
  need the laptop to stay open, and it must have **no access to his data**.
- **Later:** combining several agents (Codex, Claude, self-hosted models).
- He has not used herdr much yet. He asked to move ahead on sensible defaults
  and to correct them once the whole v2 is finished. So the herdr UX choices
  below are deliberately isolated (one module, one config block) and cheap
  to change.

## Goals

- `herdr --remote <host> --remote-keybindings server` is the only door. It
  shows one herdr workspace per repo and one tab per task, and herdr shows
  each agent's live state (idle, working, blocked) in that tab.
- `prefix+f` opens `forge start` in a popup. The popup closes on a tab running
  the agent.
- Agents keep running when the client detaches or the laptop sleeps. After a
  herdr server restart or a VM reboot, one key (`prefix+shift+f`) brings
  every agent back with its conversation.
- **Host-side git never runs in a repository the agent can write.** This
  covers forge's own fetch and the user's retrieval from the dev machine.
- tmux is gone from the CLI, the tests, CI and the image.
- Outside herdr, `forge start` and `forge resume` still work, in the
  foreground and without persistence.

## Non-goals

- **Other agents** (Codex, self-hosted models). Designed for, not built: one
  module (`cli/lib/agent.ts`) decides the agent's command line and its herdr
  hint. The image only ships Claude Code.
- **Automatic resume after a herdr restart.** herdr 0.9.5 can replay a resume
  command, but only by taking over the agent's live state (see "Research").
  The resume key stands in for now, and the upgrade path is written down.
- `forge finish` / `forge stop` key bindings (framing spec: "follow the same
  pattern later").
- herdr's own worktrees and herdr's Claude integration (its hooks would live
  in the container and could not reach the host socket).
- Host-side fetches while no client is attached (they need the forwarded
  agent).
- The README rewrite. It belongs to sub-project 5; this sub-project hands over
  notes (see "README notes").

## Anti-goals

These would make the work a failure even if every test passed:

- Any new path from a container to the host. This means no herdr socket, no
  sshd and no host git in a container's workspace.
- The forge user's herdr config broken or reordered outside forge's own
  block.
- Two Claude processes running in the same worktree.
- Losing herdr's live agent state (idle / working / blocked). It is what
  makes herdr worth opening.

## Decisions

| Topic | Decision | Source |
|---|---|---|
| Where herdr runs | herdr client on the dev machine, herdr server on the Incus host; containers stay sealed (no sshd, no herdr inside) | Framing, decided |
| Starting a task | Server-side `[[keys.command]]`, `type = "popup"`, on `prefix+f`; fires only with `--remote-keybindings server` | Framing + spike 8; key: `prefix+n` is `next_tab` |
| Opening the agent tab | `tab create`, then `pane run <pane> "exec env HERDR_AGENT=claude <forge> attach <container> <task>"`; the hint sits on the wrapper process, never on the tab | Spike 1 and 2, decided |
| Layout | One herdr workspace per repo, labelled `owner/repo`; one tab per task, labelled `<task>` | Moroine, 2026-10-17 |
| Pane working directory | `$HOME`, never the workspace | This spec (a git-aware shell prompt would run host git there) |
| Persistence | tmux leaves the container; herdr keeps panes alive across detach; `claude --continue` recovers a conversation | Framing + spike 4, decided |
| Resume after a herdr restart | Key `prefix+shift+f` runs `forge resume --all` in a popup | This spec, from the research below |
| herdr config | A delimited, idempotent block at the end of `~/.config/herdr/config.toml`, written by `forge setup` | Framing + spike 9, decided |
| SSH agent | herdr's stable forwarded agent (`~/.config/herdr/herdr.sock.agent`); no `~/.ssh/rc` | Spike finding F, decided |
| Worktrees | Managed by forge, inside the container | Framing, decided |
| Host fetch | Into a forge-owned bare **mirror** per container, never into the workspace | This spec (security) |
| Workspace clone | Done **inside the container**, from the mirror mounted read-only | This spec (security) |
| Retrieval from the dev machine | `git fetch` through `forge upload-pack <container>`, which runs `git-upload-pack` **inside the container** as `aiuser` | This spec (security) |
| Agent seam | `cli/lib/agent.ts`: the agent's herdr label and command line, one agent (`claude`) in v2.0 | This spec, from "later: Codex, self-hosted" |

## Research done for this spec

These were throwaway checks on 2026-10-17, against herdr 0.9.5 on the
developer's Mac. They ran in an isolated herdr: `HOME` pointed into a
scratch directory, with a short `HERDR_SOCKET_PATH` and a client in a private
tmux socket. A shell script stood in for `forge attach`.

1. **Workspace creation.**
   - `herdr workspace create --label demo/repo --cwd … --no-focus` returns
     `.result.workspace.workspace_id`, `.result.tab.tab_id` and
     `.result.root_pane.pane_id`.
   - The new workspace has a root tab labelled `1` with a shell.
   - `workspace list` and `tab list` return each object's `label` and
     `workspace_id`.
2. **Resume command, plain.** `pane report-agent-session --source forge
   --agent claude <pane> -- …` is refused:
   `resume_not_accepted: resume_argv requires the reporter to hold the pane;
   report its state with pane.report_agent first`.
3. **Resume command, with a state report.**
   - `pane report-agent --source forge --agent claude --state unknown --seq <n>
     <pane> -- env HERDR_AGENT=claude fake-forge attach --continue c t` is
     accepted.
   - After `herdr server stop` and a new client, herdr ran
     `fake-forge attach --continue c t` again in the same pane (`w2:p2`, same
     id), with `HERDR_AGENT=claude` in its environment.
   - **The replay works.**
4. **But the reported state replaces the screen state.**
   - Setup: a pane showing a "working" screen (an OSC title that the Claude
     manifest's `osc_title_working` rule matches) while forge holds it with a
     reported state.
   - `herdr agent explain` gives screen state `working`, with
     `screen_detection_skipped: false`.
   - `herdr agent list` shows the **reported** state: `unknown`, `idle` or
     `blocked`, whichever forge sent.
   - So holding the pane hides Claude's live state. forge cannot report that
     state itself: the agent runs inside the container.
5. **`pane.clear_agent_authority`** (socket API, no CLI command) returns `ok`,
   but it also drops the resume command: nothing was replayed after the next
   restart.
6. **Key bindings.**
   - In herdr's defaults, prefix-mode letters `a d f i m t u y` are free, and
     so is `shift+f`.
   - `prefix+r` is `resize_mode` and `prefix+shift+r` is `reload_config`.
7. **Socket paths.** A Unix socket path longer than `sun_path` (104 bytes on
   macOS) makes every herdr call fail with
   `local socket name length exceeds capacity of sun_path`. Tests must keep
   `HERDR_SOCKET_PATH` short.
8. **git's own security notes** (git 2.52):
   - `git(1)`, section SECURITY: running git in an untrusted `.git` is not
     safe, because "the commands in its config and hooks are executed in the
     usual way". Owning the files yourself does not make them trusted.
   - About `upload-pack`: it "restrict[s] the set of options and hooks", but
     "the surface area for attack against upload-pack is large". The safest
     thing is to serve the repository as an unprivileged user.

Conclusion for resume: the live state is used every day, a server restart is
rare. v2.0 keeps the live state and puts resume behind one key. If herdr
later accepts a resume command without taking over the state, `forge attach`
reports it and the key becomes a fallback.

## Host-side git (security)

### The threat

- The forge user is root-equivalent (`incus-admin`). Its environment also
  holds the user's forwarded SSH agent, which opens GitHub with the YubiKey.
- Sub-project 2 runs host git in `~/workspaces/<container>`. That directory is
  bind-mounted at `/workspace`, and the agent writes it: `.git/config`,
  hooks, symlinks, everything.

From there, an agent can make host git run its commands or write host files.

| Vector | Example |
|---|---|
| Config-driven execution | `core.sshCommand`, `core.fsmonitor`, `core.hooksPath`, `core.askPass`, `credential.helper`, `url.<base>.insteadOf` rewriting origin to a local path with `remote.origin.uploadpack` set, `include.path` / `includeIf`, submodule recursion into further agent-made repositories |
| Hooks | `reference-transaction` runs on every ref update a fetch makes; `post-checkout`, `post-merge`… |
| Filesystem tricks | `.git` replaced by a `gitdir:` file pointing at another container's repository; symlinks inside `.git` (`FETCH_HEAD` → `~/.bashrc`) make host git write outside the workspace; `objects/info/alternates` pulls in another repository's objects |
| Confused deputy | `remote.origin.url` pointed at another private repository of the user: the host fetches it with the user's agent, into the agent's reach |

Sub-project 2's code is exposed in two places, both in
`cli/lib/commands/provision.ts`:

- `git -C <workspace> remote get-url origin` (`workspaceIsReusable`);
- `git -C <workspace> remote set-url origin …` (reused workspace).

The fetch planned for this sub-project would have been a third, and the
retrieval command `forge` prints (`git fetch ssh://…/~/workspaces/<c>`) a
fourth: it runs `git-upload-pack` as the forge user, in the agent's
repository.

### The rule

**No git process running as the forge user ever opens a repository the agent
can write.** The rule removes those calls rather than hardening them.

Rejected:

- **Hardening the calls** (`-c` overrides, environment variables):
  - git has no switch that ignores a repository's own config;
  - multi-valued keys (`url.*.insteadOf`, `include.path`, helpers)
    accumulate instead of being overridden;
  - every git release can add an executing key;
  - none of it covers symlinks or `gitdir:` redirection.
- **Sandboxing host git** (bubblewrap, a helper container): heavy, and the
  user's SSH agent would have to enter the sandbox.
- **A different `raw.idmap`, so that `safe.directory` refuses the
  workspace:** it breaks sub-project 2's idmap, and the forge user can no
  longer read the files.

### The design

**1. A mirror per container, owned by forge.**

- **Location.** A bare repository at
  `<data>/mirrors/<container>.git`.
  - `<data>` is `$XDG_DATA_HOME/agent-forge`, by default
    `~/.local/share/agent-forge`.
  - `paths.ts` gains `dataDir()` and `mirrorsDir()`, with an environment
    override for tests, like the other paths.
- **Creation** at provisioning:
  `git clone --bare git@github.com:<owner>/<repo>.git <mirror>`, on the host,
  with the inherited SSH agent.
- **An existing mirror** whose `remote.origin.url` names the same
  `owner/repo` is kept, and refreshed instead of cloned. This is the case after
  `forge delete`. A mirror for another repo stops provisioning: it means two
  repos share a container name.
  - *Builder's call, made here:* this also lets the integration test pre-seed
    the mirror from a local repository. No test-only override of the URL or
    of the protocol policy goes into production code.
- **Refresh** at each `forge start`:

  ```
  git --git-dir=<mirror> -c protocol.allow=never -c protocol.ssh.allow=always \
      fetch --prune --no-recurse-submodules \
      git@github.com:<owner>/<repo>.git '+refs/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*'
  ```

  - The URL and the refspecs are on the command line, built from
    `user.forge.repo`. That Incus metadata key is set by forge, the agent
    cannot change it, and `validateRepo` checks it again.
  - `GIT_TERMINAL_PROMPT=0` is set.
  - Nothing read from any repository the agent writes reaches this command.
- **Failure handling.**
  - At creation, a failure is fatal. Without a forwarded agent the message
    says to attach with `ForwardAgent yes`.
  - At refresh, a failure is a warning, as v1's `refreshMain`: forge goes on
    from the last-known refs. herdr's agent socket answers
    `Error connecting to agent` while no client is attached (finding F).
- **Unit tests** replace the URL builder and the protocol policy through a
  seam, so that a local bare repository can stand in for GitHub.

**2. The mirror is mounted read-only in the container.**

- **The device.**
  `incus config device add <c> origin disk source=<mirror> path=/forge/origin.git readonly=true`,
  at provisioning, before the workspace clone.
- **Locked read-only.** A read-only bind mount set up by Incus cannot be
  remounted read-write from an unprivileged container, by `aiuser` or by the
  container's root. The integration test checks both.
- **Restricted projects (B).** `restricted.devices.disk.paths` must include
  `<data>/mirrors` as well as `<home>/workspaces`. Sub-project 2's
  restricted-project table gains that row.

**3. The workspace is cloned inside the container.**

- **The clone.** As `aiuser`, after both devices are added:
  `GIT_LFS_SKIP_SMUDGE=1 git clone --no-local /forge/origin.git /workspace`.
  - `--no-local` copies objects through the git transport instead of
    hardlinking them into the agent's writable tree.
  - `/workspace` is the empty mount point.
  - `origin` is then `/forge/origin.git`.
- **What the agent can do with it.**
  - The agent can run `git fetch origin` at any time and gets the last
    mirror refresh. v1's supervised containers had no way to refresh `main`.
  - `git push origin` fails on the read-only mount, on top of
    `pre-bash.sh`'s block.
- **LFS.** It stays unavailable in supervised containers, which hold no
  credential. Files are checked out as pointers. This is unchanged from
  sub-project 2 in practice, and now stated.
- **`forge start`'s refresh step** (`refreshMain`) becomes:
  1. the host mirror refresh (above);
  2. in the container, `git -C /workspace fetch origin`;
  3. the existing `advanceMain`.

  The "Supervised container: skipping origin fetch" branch goes.

**4. Reusing a workspace after `forge delete`.**

- **What survives.** `forge delete` keeps the workspace, as before, and now
  also the mirror.
- **The rule.** A non-empty `~/workspaces/<c>` is reused only when
  `<data>/mirrors/<c>.git` exists and its `remote.origin.url` names the same
  `owner/repo`.
  - Reading the mirror with git is allowed: forge owns it.
  - A non-empty workspace without a matching mirror stops provisioning, with
    sub-project 2's "move it aside" message.
- **What the host does to the workspace.** It only uses `existsSync` and
  `readdirSync` on it, never git.
- **On reuse,** the container runs
  `git -C /workspace remote set-url origin /forge/origin.git`, in the agent's
  context.
- **Containers provisioned before this change** have no `origin` device and
  an `origin` remote on GitHub. *Builder's call, made here:* no migration,
  because v2 is unreleased and only test VMs hold such containers.
  - `forge start` on a container without the `origin` device stops.
  - Its message gives the way out: retrieve the work, `forge delete`, move
    `~/workspaces/<c>` aside, then `forge start` again.

**5. Retrieval goes through the container.**

- **The command.** New: `forge upload-pack <container> [<path>]`.
  1. Check that `<container>` is a forge container: the `agent-` prefix and
     `user.forge.repo` set.
  2. Start it if it is stopped.
  3. Exec, with the terminal's stdio inherited:

     ```
     incus --project <p> exec <c> --force-noninteractive --user 1001 --group 1001 \
       --cwd /workspace --env HOME=/home/aiuser [--env GIT_PROTOCOL=<value>] \
       -- git-upload-pack /workspace
     ```

  - `<path>` is whatever git appends to the command, and is ignored.
  - `GIT_PROTOCOL` is passed through only when it matches `^version=[0-9]$`.
  - **Nothing goes to stdout before the exec**: stdout carries the git
    protocol. Every message goes to stderr.
- **On the dev machine.** forge prints these commands at provisioning,
  replacing sub-project 2's hint:

  ```
  git remote add <c> <forge-host>:<c>
  git config remote.<c>.uploadpack "forge upload-pack <c>"
  git fetch <c>
  ```

  - Over SSH, git runs `forge upload-pack <c> '<c>'` on the host.
  - `<forge-host>` stays for the user to fill in, as in sub-project 2.
- **What this changes.**
  - `git-upload-pack` now runs as `aiuser`, inside the agent's own sandbox.
  - What reaches the dev machine is the git protocol from an untrusted
    server, which is git's normal trust model for any remote.
  - The agent's *code* reaches the dev machine when the user checks it out.
    The README says to review before running it (sub-project 5).

**6. Host shells never sit in a workspace.** Tabs and workspaces are created
with `--cwd "$HOME"`. A shell prompt that shows git status would otherwise
run host git in the agent's repository, at every prompt and after every
restore. The README says not to run git in `~/workspaces` on the host.

### Security tests

- **Unit.**
  - The fake context records every host argv.
  - An invariant test asserts that no host `git` invocation has `-C`,
    `--git-dir` or a cwd under the workspaces directory. It covers
    provisioning (new and reused), `start`, `resume`, `finish`, `list` and
    `upload-pack`.
- **Contract (real git).**
  - `tests/lib/hostile-repo.ts` builds a repository with:
    - config keys that would each write a marker: `core.fsmonitor`,
      `core.sshCommand`, `core.hooksPath`, `credential.helper`,
      `uploadpack.packObjectsHook`, `url.<x>.insteadOf` towards a local
      path with `remote.origin.uploadpack`;
    - executable hooks that write a marker (`reference-transaction`,
      `post-checkout`, `pre-push`);
    - `FETCH_HEAD` as a symlink to a canary file.
  - **Positive control:** a plain `git fetch` run *inside* that repository
    writes a marker. This proves the fixture is hostile.
  - Then forge's mirror create and refresh run against a local bare
    repository standing in for GitHub, with the hostile repository sitting
    where the workspace would be.
  - Asserted: no marker, and the canary unchanged.
  - **The retrieval wiring.** A fresh repository is configured with the
    printed commands (`remote add`, `uploadpack`), and its `uploadpack`
    points at a stand-in script.
    - The script records its argv and runs `git-upload-pack` on a *clean*
      repository.
    - Checked: git calls it as `forge upload-pack <c> '<c>'`, and the fetch
      succeeds.
    - Retrieval against a hostile repository is the integration test's job:
      only there does `upload-pack` really run inside a container.
- **Integration** (`FORGE_INTEGRATION=1`, real Incus):
  - the test pre-seeds the mirror from a local repository, with
    `remote.origin.url` set to the GitHub URL. The test Incus has no GitHub
    access, so the host refresh fails, and the test asserts that this failure
    is a warning;
  - the agent, through `incus exec` as `aiuser`, plants the same config,
    hooks and symlinks in `/workspace/.git`;
  - then `forge start` (host and container refresh) and a dev-side
    `git fetch` through `forge upload-pack` run;
  - no marker appears on the host;
  - `touch /forge/origin.git/x` fails as `aiuser`, and
    `mount -o remount,rw /forge/origin.git` fails as the container's root.

## herdr integration

### forge's herdr layer

- **`cli/lib/herdr.ts`** wraps herdr's CLI.
  - Every call is `ctx.exec([herdrBin, …])`, and its JSON is parsed.
  - Parse failures name the command and quote its output.
  - "Inside herdr" means `HERDR_ENV=1` and `HERDR_BIN_PATH` set. `herdrBin` is
    `HERDR_BIN_PATH`, and the socket comes from the inherited
    `HERDR_SOCKET_PATH`.
  - Outside herdr, forge drives no herdr. The exception is `forge setup`,
    which looks for a herdr binary to check and reload its config.
- **Functions:**
  - find a workspace by label;
  - create a workspace;
  - list a workspace's tabs;
  - create, rename, focus and close a tab;
  - `pane run`;
  - a pane's foreground processes (`pane process-info`).

  The JSON shapes are those of spike point 1 and research point 1.
- **`<forge>`** in typed commands and in the herdr config is the path forge
  was invoked through, not resolved. The shim exports it, typically
  `/usr/local/bin/forge`, so a restored shell's PATH does not matter.
  `forge` is the fallback.

### Layout

- **Workspace** label: `owner/repo`, from `user.forge.repo`, in its original
  case. This refines the decided `--label "<repo>/<task>"`: the repo is now
  the workspace.
- **Tab** label: `<task>`.
- **Finding or creating them:**
  - A missing workspace is created with
    `workspace create --label <owner/repo> --cwd "$HOME" --focus`. Its root tab
    is renamed `<task>` and its root pane is used, so no stray shell tab is
    left.
  - Otherwise the tab is looked up by label in that workspace. A missing tab
    is created with
    `tab create --workspace <ws> --label <task> --cwd "$HOME" --focus`.
- **Several matches** (a user who duplicated a label by hand): forge takes
  the first and says so on stderr.

### Starting or reopening a task inside herdr

`forge start` and `forge resume` inside herdr end in the same step. It
depends on two facts:

- **agent running:** a Claude process for that task runs in the container
  (in-container probe, see `forge list`);
- **tab:** the task's tab exists in the repo's workspace.

| Agent running | Tab | Action |
|---|---|---|
| no | none | create the tab, `pane run` the attach command |
| no | exists, bare shell | `pane run` the attach command in it, focus it |
| yes | exists, its pane runs `forge attach` for this task | focus it |
| yes | none, or a bare shell | refuse: the agent for `<task>` already runs outside this herdr (another terminal?). Two Claudes in one worktree is the failure to avoid |

- **A bare shell** is a pane whose foreground process is a shell. **A live
  pane** is one whose foreground process is `forge attach <container>
  <task>`.
- **The attach command** is always
  `exec env HERDR_AGENT=claude <forge> attach <container> <task>`.
  `forge attach` itself decides whether to continue a conversation.
- **In the popup**, the popup closes when forge exits.
  - On success, the user lands on the focused tab.
  - **On failure in the popup**, forge prints the error, then
    `Press Enter to close`, waits, and exits 1.
  - The popup is recognised by `HERDR_ENV=1` without `HERDR_PANE_ID` (spike
    point 8).
- **From a host pane** inside herdr (`HERDR_PANE_ID` set), it behaves the
  same way, without the wait.

`forge start` keeps its order: provisioning if needed, refresh, the task menu
(repo, then task: new task, existing worktree, branch…), the worktree, and
then the step above.

### `forge attach <container> <task>` (new)

This is the command a tab runs. It also works outside herdr, and the resume
key reuses it.

1. **Preconditions.**
   - `<container>` is a forge container.
   - It is started if stopped. Concurrent starts are tolerated: a failed
     `incus start` followed by a `Running` status is fine. Several tabs
     resume at once after a reboot.
   - The worktree exists. Otherwise the error names `forge start`.
2. **Conversation probe.**
   - forge adds `--continue` when the worktree already has a Claude
     conversation.
   - It probes the container for a transcript under
     `/home/aiuser/.claude/projects/<slug>/`, where `<slug>` is Claude Code's
     encoding of `/workspace/.trees/<task>`.
   - `claude --continue` with nothing to continue must never be the result.
   - The builder confirms the encoding against the image's Claude Code. It is
     an internal detail of Claude Code, so it lives in one function, and an
     integration test covers it.
3. **The command.**

   ```
   incus --project <p> exec <c> --user 1001 --group 1001 --cwd /workspace/.trees/<task> \
     --env TERM=<term> -- bash -lc 'exec claude --permission-mode auto --remote-control <c>-<task> [--continue]'
   ```

   - `bash -lc` restores `DOCKER_HOST` from `.bashrc`, as in v1.
   - `exec` keeps Claude the direct child, so window resizes reach it. That
     was v1's tmux concern, commit c34a145.
   - The command line comes from `cli/lib/agent.ts`.
4. **The herdr hint.** The `incus` child's own environment also gets
   `HERDR_AGENT=<agent label>`. The hint is then right however
   `forge attach` was started.
5. **Running.** The terminal is inherited (`ctx.attach`) and the exit code
   is propagated. There is no herdr lifecycle report, so there is nothing
   to release.

### Resume after a herdr server restart or a VM reboot

- **What happens.** herdr restores the layout and labels, with every pane a
  host shell in `$HOME` and every agent gone (spike point 4, research point
  3). Incus restarts the containers that were running at shutdown
  (`boot.autostart` unset restores the last state), and `forge attach`
  starts any that are not.
- **`prefix+shift+f`** runs `forge resume --all` in a popup.
  1. It finds every herdr workspace whose label is the `owner/repo` of a
     forge container.
  2. In each, it takes every tab whose label is a task with a worktree and
     whose pane is a bare shell.
  3. It runs the attach command in that pane.
  4. It prints one line per task: `resumed`, `already running` or
     `skipped (<reason>)`.
  - It makes no fetch, so no YubiKey touch.
  - On failure it waits for Enter, like `forge start` in the popup.
- **`forge resume [<owner/repo>] [<task>]`** inside herdr applies the tab
  step above, without the refresh or the worktree creation. Outside herdr it
  attaches in the foreground.
- **Upgrade path.** If herdr accepts a resume command without taking over the
  lifecycle state, `forge attach` reports
  `env HERDR_AGENT=claude <forge> attach <c> <task>` and the key becomes a
  fallback. That would be an issue to open upstream, outside this
  sub-project.

### Outside herdr

- When `HERDR_ENV` is unset, `forge start` and `forge resume` run the attach
  in the foreground.
- They first print one line on stderr: `outside herdr: the agent stops when
  this terminal closes`.
- No herdr call is made.

### `forge setup`: the herdr config block

- **The file.** `$HERDR_CONFIG_PATH` if set, otherwise
  `<forge home>/.config/herdr/config.toml`. The builder checks whether herdr
  honours `XDG_CONFIG_HOME` and follows it if so.
- **The block:**

  ```toml
  # >>> agent-forge >>>
  # Managed by `forge setup`: edits inside this block are overwritten.
  # Keep your own settings above it.
  [[keys.command]]
  key = "prefix+f"
  type = "popup"
  command = "<forge> start"
  description = "forge: start or open a task"

  [[keys.command]]
  key = "prefix+shift+f"
  type = "popup"
  command = "<forge> resume --all"
  description = "forge: resume agents stopped by a herdr restart"
  # <<< agent-forge <<<
  ```

  The popups are large enough to read the provisioning output, through
  herdr's `width` / `height` keys. The exact values are left to the builder.
- **Where it goes.**
  - An existing block is replaced in place. A missing one is appended at the
    end of the file.
  - It belongs last: in TOML, a bare key written after it would land inside
    its last `[[keys.command]]` table. Hence the comment.
- **Idempotent.**
  - Identical content means no write. Otherwise the file is written
    atomically (temporary file, then rename).
  - A missing `~/.config/herdr` is created with mode 0700. A new file gets
    mode 0644; an existing file keeps its mode.
  - It reports `herdr config <path>: created|updated|unchanged`, like the
    Incus objects.
- **Errors and warnings.**
  - A start marker without an end marker, or two blocks, is an error that
    names the file. Nothing is written.
  - A binding of `prefix+f` or `prefix+shift+f` outside the block gives a
    warning.
- **Afterwards.**
  - When a herdr binary is found (`HERDR_BIN_PATH`, then `~/.local/bin/herdr`,
    then PATH), forge runs `herdr config check` and prints its diagnostics
    as warnings.
  - Then `herdr server reload-config`. When no server runs, that is a notice:
    the bindings apply at the next server start.
  - With no herdr binary, a notice says the bindings apply once
    `herdr --remote` installs herdr on this host.
- **The code.**
  - `cli/lib/herdr-config.ts` holds the pure part: render the block and
    splice it into a text.
  - `setup.ts` gains one step, after the host checks and the warnings.
    Sub-project 2's spec already planned that step.

### `forge list`

- Each task line shows `running` or `stopped`, replacing tmux's
  `attached` / `detached` / `no session`.
- `running` means a `claude` process with `--remote-control <c>-<task>` runs
  in the container, as `aiuser`.
  - It is read from one in-container process listing per container.
  - forge parses it strictly: process names are agent-controlled, so they
    only ever feed this column.

### `forge finish`

1. The WIP check (unchanged).
2. Stop the task's agent: kill its Claude process in the container. The tab
   closes by itself, because the attach command runs under `exec`.
3. `git worktree remove` (in the container, unchanged).
4. Move the task's transcript folder aside, in the container:
   `~/.claude/projects/<slug>` becomes `<slug>.finished-<UTC timestamp>`.
5. Inside herdr, close the task's tab if it is still there as a bare shell.

- **Killing comes before removal.** v1 removed the worktree first, under a
  live agent.
- **Moving the transcripts aside.** A task name can come back after
  `finish`: the user picks `agent/<task>` again, or reuses the name. Without
  step 4, the conversation probe would find the finished conversation and
  continue it.
  - *Builder's call, made here:* a task that comes back after `finish`
    starts a fresh conversation, as in v1. The old transcripts are moved,
    never deleted.

### `forge stop` and `forge delete`

Unchanged. Agents die with the container, and their tabs close by
themselves. `forge delete` also says that the workspace and the mirror are
kept, and where they are.

### tmux removal

| Where | Change |
|---|---|
| `cli/lib/incus.ts` | `attachArgv` replaced by the `forge attach` command line |
| `cli/lib/worktrees.ts` | `parseSessionStates` / `sessionStates` replaced by the agent-process probe |
| `cli/lib/commands/list.ts`, `finish.ts`, `resume.ts`, `start.ts` | As above |
| `cli/lib/context.ts`, `cli/lib/prompt.ts` | Comments that justify things by tmux |
| `tests/contract/tmux.test.ts` | Deleted; a herdr contract test takes over |
| `tests/incus.test.ts`, `start.test.ts`, `resume-finish.test.ts`, `worktrees.test.ts`, `tests/lib/fake-context.ts` | Updated |
| `ansible/roles/forge_image/tasks/base.yml`, `verify.yml` | tmux removed from the packages and the checks |
| `.github/workflows/ci.yml` | tmux replaced by a pinned herdr release (see "Testing") |

The README's tmux sections belong to sub-project 5's rewrite. Dated specs and
plans stay as they were written.

### `container/CLAUDE.md`

The supervised paragraph changes:

- `origin` is a read-only mirror that forge refreshes when a task starts.
  `git fetch origin` works; `git push` does not.
- The retrieval commands for the human are the ones in "Retrieval goes
  through the container" above.

## Security model additions

These rows extend the framing spec's table.

| Threat | Mitigation |
|---|---|
| Agent makes host git run its code or write host files | Host git only touches forge-owned mirrors; the workspace is cloned and served from inside the container; host shells never sit in a workspace |
| Agent uses the user's GitHub access for another repository | The mirror's URL comes from Incus metadata, never from an agent-writable file |
| Agent corrupts what the host fetched | The mirror is mounted read-only (locked) |
| Agent code reaches the dev machine | Through `git checkout` only, by the user's choice; the README says to review first |
| Agent output drives the terminal | Escape sequences (titles, OSC 52 clipboard writes) reach herdr and the dev machine's terminal, as they reached tmux in v1. Not addressed in v2.0; noted |

## README notes (for sub-project 5)

Delivered as `readme-needs-sp4.md` in the shared notes folder once this spec
is approved:

- **Installing herdr on the dev machine.**
- **The first attach is interactive.** `herdr --remote <host>` asks
  `Install … to "$HOME/.local/bin/herdr"? [Y/n]` once. A non-interactive run
  fails instead. A client version change may ask again.
- **The attach command:**
  `herdr --remote <host> --remote-keybindings server`.
  - The flag is what makes `prefix+f` exist.
  - The user's local herdr key customisations do not apply in that session.
- **SSH config:**
  - `ForwardAgent yes` for that host;
  - the YubiKey agent must be the default agent (`IdentityAgent`), or
    OpenSSH does not forward it (finding F);
  - GitHub's host key is accepted once, in the popup, at the first clone.
- **`forge setup`** can run before the first attach.
- **The keys:** `prefix+f` and `prefix+shift+f`, and what each does.
- **Outside herdr:** foreground attach, no persistence.
- **Retrieval:** the three commands, and "review before running agent code
  on your machine".
- **Never run git in `~/workspaces` on the host.**
- **Local Linux mode:** herdr runs locally without `--remote`. Local
  custom commands bind normally there, so no flag is needed.

## Testing

- **Unit** (`node --test`, fake context and fake `incus`).
  - **herdr layer:**
    - JSON parsing;
    - the start/resume table above (all four rows);
    - workspace creation reusing the root tab;
    - popup detection and the failure wait.
  - **`forge attach`:**
    - argv;
    - `--continue` driven by the probe;
    - the container start, including the concurrent case;
    - the hint in the child's environment.
  - **`forge resume --all`:** which tabs are selected or skipped.
  - **herdr config block:**
    - render;
    - splice into an empty file, a file without the block and a file with
      it;
    - a second run reports `unchanged` and does not write;
    - broken markers;
    - the conflict warning;
    - the user's content outside the block byte-identical.
  - **`forge list`:** process parsing, including hostile process names.
  - **`forge finish`:** kill, then remove.
  - **`forge upload-pack`:** argv, `GIT_PROTOCOL` filtering, nothing on
    stdout.
  - **Provisioning:**
    - the mirror, then the devices, then the in-container clone;
    - the reuse rule;
    - an existing mirror refreshed instead of cloned;
    - a mirror for another repo refused;
    - `forge start` refusing a container without the `origin` device.
  - **`forge finish`:** the transcript folder moved aside.
  - **The host-git invariant** (see "Security tests").
- **Contract.**
  - Real git: the hostile-repository tests.
  - Real herdr:
    - `herdr config check` passes on the generated block (with
      `HERDR_CONFIG_PATH` in a temporary directory);
    - a private server (short `HERDR_SOCKET_PATH`, temporary `HOME`) answers
      `workspace create`, `tab create`, `tab list`, `pane run` and
      `pane process-info` in the shapes forge parses.
  - The tests skip when herdr is absent locally. CI installs a pinned herdr
    release (0.9.5) with a checked hash.
- **Integration** (`FORGE_INTEGRATION=1`, test Incus).
  - The mirror and its locked read-only mount.
  - The hostile workspace scenario.
  - Retrieval through `forge upload-pack`, with git's `uploadpack` set on a
    local remote. No SSH is needed.
  - The conversation probe and `--continue` on the image's Claude Code. This
    needs the user's credentials, so it is a manual step on the test VM.
- **Manual acceptance on a real VM** (Moroine, after v2):
  - attach;
  - `prefix+f` on a new repo and on an existing task;
  - parallel tasks;
  - a laptop sleep;
  - `herdr server stop`, then `prefix+shift+f`;
  - a VM reboot;
  - retrieval from the Mac.

## Risks and open points

| Point | Handling |
|---|---|
| herdr on the host follows the client's version (installed at the client's version) | Contract tests on a pinned version; parsers fail with the command and its output, never silently |
| Claude Code's transcript directory encoding is internal | One probe function; integration check; the failure mode is a fresh conversation, not a crash |
| `tab create --focus` / `tab focus` across workspaces not yet observed | Integration and manual check; if focus does not follow, `workspace focus` is added |
| `pane run` types into the user's host shell | The typed command is plain POSIX (`exec env … <path> attach <c> <t>`, validated names); the forge user's shell is bash by default |
| Disk: each repo exists twice on the host (mirror and workspace) | Accepted; `--no-local` is what keeps the mirror out of the agent's reach |
| A long provisioning in a popup the user closes by mistake | forge is killed mid-way; the next `forge start` reports the partly provisioned container, as today |
| herdr's `config reset-keys` removes custom bindings | Re-running `forge setup` restores the block (spike point 9) |

## Changes to earlier specs

These points of the framing and runtime specs are superseded. Those
documents are not edited.

- **Framing, "Daily flow (remote)".**
  - The attach command gains `--remote-keybindings server`.
  - The key is `prefix+f`.
  - One workspace per repo, one tab per task, panes in `$HOME`.
  - The host fetches into a mirror, not the workspace.
  - Retrieval goes through `forge upload-pack`.
- **Framing, "herdr key bindings".** Two bindings (`prefix+f`,
  `prefix+shift+f`) instead of one; no include file.
- **Framing, "Stable SSH agent".** herdr's agent socket (finding F).
- **Framing, "Git flow".**
  - The host clones and fetches a forge-owned mirror.
  - The workspace is cloned inside the container from the read-only mirror.
  - The dev machine fetches through the container.
- **Runtime, "Provisioning".**
  - Step 2 (clone on the host into the workspace) becomes: the mirror on the
    host, the `origin` and `workspace` devices, then the clone inside the
    container.
  - The reuse rule reads the mirror, never the workspace.
  - The retrieval hint changes.
- **Runtime, "Restricted-project compatibility".** The mirror's disk device
  and its path in `restricted.devices.disk.paths`.
- **Runtime, `refreshMain`.** The "no fetch, a notice" behaviour is replaced
  by the mirror refresh and an in-container fetch.

## Delivery

Stacked pull requests, each based on the previous branch and titled
"(pile v2, N/n)".

- **Commits are unsigned** (`--no-gpg-sign`). Moroine authorised it for this
  stack: "Tu peux gérer le tout sans Yubikey ? Et faire des stack PRs ? Je
  resignerais demain". Each PR body says so, and he re-signs.
- Nothing is merged into `next`.
- The plan (`superpowers:writing-plans`) fixes the cut. The expected order:

1. this spec and the plan;
2. host-side git: mirror, in-container clone, `forge upload-pack`, reuse
   rule, security tests;
3. `forge attach`, tmux removal, `list` / `finish`;
4. herdr layer, tab logic for `start` / `resume`, `resume --all`, config block
   in `forge setup`, herdr contract tests and CI.

Sub-project 3 also edits `cli/lib/commands/setup.ts` and probably
`provision.ts`. This sub-project's changes there are one `setup` step and the
provisioning steps above, coordinated with that session before
implementation.
