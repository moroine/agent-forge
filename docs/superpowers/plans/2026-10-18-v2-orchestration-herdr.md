# agent-forge v2 — Sub-project 4: Orchestration (herdr) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Host-side git never opens a repository the agent can write.
- tmux leaves forge.
- `herdr --remote <host> --remote-keybindings server` becomes the daily door: one workspace per repo, one tab per task, `prefix+f` to start, `prefix+shift+f` to resume after a herdr restart.

**Architecture:**
- **The repository.**
  - The host keeps a forge-owned bare mirror per container and fetches GitHub into it (`cli/lib/mirror.ts`).
  - The mirror is mounted read-only in the container, where the workspace is cloned and served (`forge upload-pack`).
- **The agent.**
  - `forge attach` (`cli/lib/session.ts`) runs the agent in the current terminal, with the command line from `cli/lib/agent.ts`.
  - herdr tabs run `forge attach`.
- **herdr.**
  - `cli/lib/herdr.ts` wraps herdr's CLI, the way `incus.ts` wraps Incus.
  - `cli/lib/tabs.ts` holds the decisions: which tab, create or reuse, refuse a second agent.
  - `cli/lib/herdr-config.ts` writes forge's key bindings block, called by `forge setup`.

**Tech Stack:** Node 24 (type stripping, `node --test`, no runtime dependency), TypeScript 5 (`tsc --noEmit`), git, Incus 7.0, herdr 0.9.5, Ansible (image role only), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-17-v2-orchestration-herdr-design.md` is authoritative; read it first. Context:
- `docs/superpowers/specs/2026-10-15-v2-incus-ansible-herdr-design.md` (framing);
- `docs/superpowers/specs/2026-10-15-v2-runtime-design.md` (sub-project 2);
- `docs/superpowers/spikes/2026-10-15-v2-validation-spike.md`.

## Global Constraints

### Host-side git and the mirror

- **Mirror path:** `<data>/mirrors/<container>.git`.
  - `<data>` is `$XDG_DATA_HOME/agent-forge`, default `~/.local/share/agent-forge`. An empty `XDG_DATA_HOME` counts as unset.
  - `FORGE_MIRRORS` overrides the mirrors directory, for tests only.
- **Mirror creation:** `git -c protocol.allow=never -c protocol.ssh.allow=always clone --bare git@github.com:<owner>/<repo>.git <mirror>`.
- **Mirror refresh:** `git --git-dir=<mirror> -c protocol.allow=never -c protocol.ssh.allow=always fetch --prune --no-recurse-submodules git@github.com:<owner>/<repo>.git +refs/heads/*:refs/heads/* +refs/tags/*:refs/tags/*`.
- Every host git call on a mirror gets the environment `GIT_TERMINAL_PROMPT=0`.
- `<owner>/<repo>` always goes through `validateRepo` before it reaches git.
- **Mirror device:** named `origin`, `source=<mirror>`, `path=/forge/origin.git`, `readonly=true`.
- **Workspace clone, in the container as `aiuser`:** `env GIT_LFS_SKIP_SMUDGE=1 git clone --no-local /forge/origin.git /workspace`.
- **Reuse:** `git -C /workspace remote set-url origin /forge/origin.git`, in the container.
- **The rule:** no host `git` argv ever contains a path under the workspaces directory. The host only uses `existsSync` / `readdirSync` / `mkdirSync` there.

### Retrieval

- **`forge upload-pack`** runs exactly:

  ```
  incus --project <p> exec <c> --force-noninteractive --user 1001 --group 1001 --cwd /workspace --env HOME=/home/aiuser [--env GIT_PROTOCOL=<v>] -- git-upload-pack /workspace
  ```

  - `GIT_PROTOCOL` is passed only when it matches `^version=[0-9]$`.
  - It never writes to stdout itself.
- **The retrieval hint**, printed on stderr at provisioning, replaces sub-project 2's line:

  ```
  Retrieve this container's work from your machine with:
    git remote add <c> <forge-host>:<c>
    git config remote.<c>.uploadpack "forge upload-pack <c>"
    git fetch <c>
  ```

### The agent

- **Command in the container:** `bash -lc 'exec claude --permission-mode auto --remote-control <c>-<task>[ --continue]'`.
  - `--continue` is added only when `/home/aiuser/.claude/projects/<slug>/` holds a `.jsonl`.
  - `<slug>` is the worktree path with every character outside `[A-Za-z0-9]` replaced by `-`, so `/workspace/.trees/cli` becomes `-workspace--trees-cli`.
- **Attach argv:** `incus --project <p> exec <c> --user 1001 --group 1001 --cwd /workspace/.trees/<task> --env TERM=<term> -- <command>`. The host process also gets `HERDR_AGENT=claude` in its environment.
- **Typed into a herdr pane:** `exec env HERDR_AGENT=claude '<forge>' attach <c> <task>`.
  - `<forge>` is `path.resolve(FORGE_INVOKED_AS)`, exported by the shim, and `forge` when unset.
  - It is always single-quoted.

### herdr

- **Layout.**
  - Workspace label: `<owner>/<repo>`, taken from `user.forge.repo`.
  - Tab label: `<task>`.
  - `--cwd` is the forge home, never a workspace.
  - Creations use `--focus`.
  - Workspace labels compare case-insensitively.
- **Inside herdr** means `HERDR_ENV=1` and a non-empty `HERDR_BIN_PATH`. The popup is the same, with no `HERDR_PANE_ID`.
- **Keys:** `prefix+f` runs `<forge> start`; `prefix+shift+f` runs `<forge> resume --all`. Both are `type = "popup"`, `width = "90%"`, `height = "90%"`.
- **Block markers:** `# >>> agent-forge >>>` and `# <<< agent-forge <<<`.
- **herdr config path:** `$HERDR_CONFIG_PATH`, else `$XDG_CONFIG_HOME/herdr/config.toml`, else `<forge home>/.config/herdr/config.toml`. herdr 0.9.5 honours `XDG_CONFIG_HOME` (checked on 2026-10-18).

### Exact user-facing text

| Where | Text |
|---|---|
| Outside herdr, before attaching | `outside herdr: the agent stops when this terminal closes` (stderr) |
| Popup failure | `Press Enter to close` (stderr, after the error) |
| `forge list` task states | `running` / `stopped` |
| `forge resume --all` lines | `<owner/repo> <task>: resumed` / `already running` / `skipped (<reason>)` |
| `forge setup`, herdr step | `herdr config <path>: created` / `updated` / `unchanged` |
| `forge finish`, transcripts aside | `~/.claude/projects/<slug>` becomes `<slug>.finished-<YYYYMMDDTHHMMSSZ>` (UTC) |

### Code conventions (sub-project 2's, unchanged)

- Every mutating step goes through `mustSucceed`. Probes are never fatal by themselves.
- Values reach Incus and git as argv elements. `execAsAgent`'s shell form stays only for fixed scripts with validated names.
- New files are commented in English. Existing files keep French for new comments.
- No runtime npm dependency.

### Tests

- Unit tests never inherit a herdr session or a real home. `tests/lib/fake-context.ts` deletes `HERDR_ENV`, `HERDR_BIN_PATH`, `HERDR_PANE_ID`, `HERDR_SOCKET_PATH` and `HERDR_CONFIG_PATH` from `process.env` when it is imported.
- Every test that reaches the herdr config sets `HERDR_CONFIG_PATH` or `XDG_CONFIG_HOME` to a temporary directory.

### Git and delivery

- **Commits:**
  - unsigned, `git commit --no-gpg-sign`. Moroine authorised it in this session on 2026-10-18 ("Je valide, commits non signés OK"), for this sub-project's stack;
  - conventional messages, in French like the recent history (`feat:`, `fix:`, `test:`, `docs:`, `chore:`);
  - each ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Branches**, each created from the previous one:
  - `agent/v2-herdr-spec` (spec and plan, on `agent/hook-fail-closed`, moroine/agent-forge#36, which also changes `provision.ts`, `pre-bash.sh` and the image);
  - `agent/v2-host-git` (Tasks 1–5);
  - `agent/v2-attach` (Tasks 6–8);
  - `agent/v2-herdr` (Tasks 9–12).
- **Pull requests:**
  - one per branch, each `--base` the previous branch, titled `… (pile v2 · sp4, N/4)`: 1 spec and plan, 2 host-side git, 3 attach, 4 herdr;
  - the body says the commits are unsigned and that Moroine re-signs;
  - never merged by the agent, never towards `main` or `next` directly.
- **Commands on this Mac.** The repo's hook (`container/pre-bash.sh`) runs on this Mac too:
  - files are written with the editor tools, never with shell heredocs;
  - `git push -u origin <branch>` stays bare;
  - no `sudo`, no `rm -rf`.
- **Verification commands:** `npm run test:unit`, `npm run test:contract`, `npm test`, `npm run check`.

## Review Focus

1. **A repo typed in another case than at provisioning** (`Moroine/Agent-Forge` vs `moroine/agent-forge`). A person expects the same herdr workspace, not a second one. The test goes in Task 10.
2. **Two task names that Claude Code maps to one transcript folder** (`fix.v2` and `fix-v2` both give `-workspace--trees-fix-v2`). A person expects two separate conversations, so forge refuses the second name. The test goes in Task 8.
3. **A herdr whose JSON differs from 0.9.5**: a missing field, an error object, non-JSON. herdr on the host follows the client's version. A person expects an error naming the herdr command and quoting its output, not a `TypeError`. The test goes in Task 9.
4. **`forge upload-pack` on a stopped container.** A person expects the fetch to work. Any byte forge writes to stdout would corrupt the git protocol. The test goes in Task 4.
5. **A user's herdr config with CRLF line endings or no final newline.** A person expects every byte outside forge's block to stay as it was. The test goes in Task 12.

## Delivery

**First,** once this plan is approved: push `agent/v2-herdr-spec` (spec and plan) and open PR sp4 1/4 with `--base agent/hook-fail-closed`.

**Then,** after Task 5, Task 8 and Task 12:
1. run `npm test` and `npm run check`;
2. `git push -u origin <branch>`;
3. `gh pr create --base <previous branch>`, with the PR body naming the spec, the tasks covered, the unsigned commits, and what was not run (the integration tests need a test Incus).

Then create the next branch from the current one.

---

### Task 1: The mirror module

**Files:**
- Create: `cli/lib/mirror.ts`, `tests/mirror.test.ts`, `tests/lib/hostile-repo.ts`, `tests/contract/hostile-git.test.ts`
- Modify: `cli/lib/context.ts` (`ExecOptions.env`), `cli/lib/paths.ts` (`mirrorsDir`, `mirrorPath`), `cli/lib/incus.ts` (`deviceNames`), `tests/lib/fake-incus.ts` (`config device list`), `tests/lib/fake-context.ts` (herdr scrub), `tests/context.test.ts`, `tests/paths.test.ts`

**Interfaces:**
- Produces:
  - `ExecOptions = { input?: string; env?: Record<string, string> }`: `run` spawns with `{ ...process.env, ...env }`.
  - `mirrorsDir(): string`, `mirrorPath(container: string): string` in `paths.ts`.
  - `deviceNames(ctx: Context, name: string): Promise<string[]>` in `incus.ts`. It is a probe: `incus --project <p> config device list <name>`, one name per line, and `[]` on failure.
  - In `mirror.ts`:
    - `MIRROR_MOUNT = "/forge/origin.git"`, `ORIGIN_DEVICE = "origin"`;
    - `type GitRemote = { url(ownerRepo: string): string; protocol: string[] }`, and `GITHUB: GitRemote` (the URL and the `-c` pair from Global Constraints);
    - `remoteRepo(url: string): string`, moved from `provision.ts` unchanged;
    - `mirrorRepo(ctx, mirror: string): Promise<string | null>`: the lowercased `owner/repo` from `git --git-dir=<mirror> config --get remote.origin.url`. It returns `null` without any exec when the directory is absent, and on failure;
    - `ensureMirror(ctx, mirror: string, ownerRepo: string, remote = GITHUB): Promise<"created" | "kept">`;
    - `refreshMirror(ctx, mirror: string, ownerRepo: string, remote = GITHUB): Promise<ExecResult>`;
    - `cloneWorkspace(ctx, container: string): Promise<ExecResult>` and `pointOriginAtMirror(ctx, container: string): Promise<ExecResult>`, both through `execAsAgentArgv`;
    - `hasOriginDevice(ctx, container: string): Promise<boolean>`.
  - In `tests/lib/hostile-repo.ts`, for Task 5 as well:
    - `hostileConfig(marker: string): [string, string][]`, the config keys and values;
    - `HOSTILE_HOOKS = ["reference-transaction", "post-checkout", "pre-push"]`;
    - `hookScript(marker: string): string`;
    - `makeHostileRepo(dir: string, marker: string, canary: string): void`, built on them.

- [ ] **Step 1: Write the failing tests**
  - **`tests/context.test.ts`:**
    - `exec passes extra environment variables`: `run(["sh","-c","printf %s \"$FORGE_T\""], { env: { FORGE_T: "ok" } })` gives stdout `ok`;
    - `PATH` is still inherited, since `sh` is found.
  - **`tests/paths.test.ts`:**
    - with `FORGE_MIRRORS=/m`, `mirrorPath("agent-x")` is `/m/agent-x.git`;
    - with `FORGE_HOME=/h` and no `XDG_DATA_HOME`, it is `/h/.local/share/agent-forge/mirrors/agent-x.git`;
    - with `XDG_DATA_HOME=/d`, it is `/d/agent-forge/mirrors/agent-x.git`;
    - `XDG_DATA_HOME=""` counts as unset.
  - **`tests/mirror.test.ts`** (fake context, `FORGE_MIRRORS` in a temp directory):
    - `ensureMirror creates a bare clone over SSH only`:
      - one call, exactly `["git","-c","protocol.allow=never","-c","protocol.ssh.allow=always","clone","--bare","git@github.com:o/r.git", mirror]`;
      - its `execOptions` env is `{ GIT_TERMINAL_PROMPT: "0" }`;
      - the result is `"created"`;
      - the mirrors directory exists afterwards.
    - `an existing mirror of the same repo is kept`:
      - the mirror directory exists and the rule `--get remote.origin.url` answers `git@github.com:O/R.git`;
      - the result is `"kept"` and no `clone` call is made.
    - `a mirror of another repo is refused`: the URL answers `git@github.com:a/b.git`; the call rejects with `/mirror of a\/b/`, and no clone is made.
    - `an invalid repo never reaches git`: `ensureMirror(ctx, m, "o/r;id")` rejects with `/repo must be/`, and `ctx.calls` is empty.
    - `a failing clone surfaces git's stderr and names the forwarded agent`: the rule `clone --bare` gives code 128 with stderr `Permission denied (publickey)`; the call rejects with `/create mirror failed: Permission denied/` and `/ForwardAgent yes/`.
    - `refreshMirror fetches heads and tags with the URL on the command line`: the exact argv from Global Constraints, with the env above.
    - `mirrorRepo returns null without exec when there is no mirror`.
    - `cloneWorkspace runs in the container as aiuser`: argv `incus --project agent-forge exec agent-x --user 1001 --group 1001 --env HOME=/home/aiuser -- env GIT_LFS_SKIP_SMUDGE=1 git clone --no-local /forge/origin.git /workspace`.
    - `pointOriginAtMirror` ends with `-- git -C /workspace remote set-url origin /forge/origin.git`.
    - `hasOriginDevice`:
      - with `FakeIncus`, an instance holding devices `origin` and `workspace` gives `true`;
      - with only `workspace`, `false`;
      - a failing list gives `false`.
  - **`tests/contract/hostile-git.test.ts`** (real git; fixtures from `tests/lib/hostile-repo.ts`):
    - **`makeHostileRepo(dir: string, marker: string, canary: string): void`** builds a repository with a commit and with:
      - config `core.fsmonitor`, `core.sshCommand`, `core.askPass`, `credential.helper` and `uploadpack.packObjectsHook`, each a command that writes `marker`;
      - `core.hooksPath` pointing at a directory of executable `reference-transaction`, `post-checkout` and `pre-push` hooks that write `marker`, and the same hooks in `.git/hooks`;
      - `remote.origin.url` set to a local bare repository, and `remote.origin.uploadpack` set to a marker-writing wrapper around `git-upload-pack`;
      - `.git/FETCH_HEAD` as a symlink to `canary`.
    - `positive control: git run inside the hostile repository runs the agent's commands`: `git -C <hostile> fetch origin`, then `marker` exists.
    - `forge's mirror create and refresh run nothing from a hostile workspace`:
      1. Set `FORGE_WORKSPACES` and `FORGE_MIRRORS` to temp directories. Build the hostile repository at `<workspaces>/agent-x`, and a local bare "GitHub" with a commit on `main`.
      2. Call `ensureMirror` then `refreshMirror` with `createContext()` and `{ url: () => github, protocol: ["-c","protocol.allow=never","-c","protocol.file.allow=always"] }`.
      3. Asserted:
         - no `marker`;
         - `canary` byte-identical;
         - `git --git-dir=<mirror> rev-parse refs/heads/main` equals the "GitHub" `main`.

- [ ] **Step 2: Run them to verify they fail**

  Run: `node --test tests/mirror.test.ts tests/paths.test.ts tests/context.test.ts tests/contract/hostile-git.test.ts`

  Expected: FAIL. `cli/lib/mirror.ts` does not exist; `mirrorPath` is not exported; `FORGE_T` is not set. The positive control already PASSes: it does not use forge.

- [ ] **Step 3: Implement**
  - **`tests/lib/fake-incus.ts`:** `config device list <name>` prints the instance's device names, one per line.
  - **`tests/lib/fake-context.ts`:** the herdr scrub from Global Constraints, at import.
  - **`ensureMirror`:**
    1. `validateRepo`.
    2. If `existsSync(mirror)`: the repo comes from `mirrorRepo`. A different repo throws `ForgeError("<mirror> is a mirror of <other>, not <ownerRepo>: two repos share the container name. Move it aside and run the command again.")`. A matching one gives `"kept"`.
    3. Otherwise `mkdirSync(mirrorsDir(), { recursive: true })`, then the clone. On failure it throws `create mirror failed: <stderr>`, followed by `Is your SSH agent forwarded? Attach with ForwardAgent yes and run the command again.`
  - **`refreshMirror`** returns the `ExecResult`; the caller decides.

- [ ] **Step 4: Run them to verify they pass**

  Run: the command of Step 2, then `npm run check`. Expected: PASS, no type error.

- [ ] **Step 5: Commit**

  ```bash
  git add cli/lib/mirror.ts cli/lib/context.ts cli/lib/paths.ts cli/lib/incus.ts tests/mirror.test.ts tests/lib/hostile-repo.ts tests/contract/hostile-git.test.ts tests/lib/fake-incus.ts tests/lib/fake-context.ts tests/context.test.ts tests/paths.test.ts
  git commit --no-gpg-sign -m "feat: miroir nu possédé par forge pour le fetch GitHub côté hôte"
  ```

### Task 2: Provisioning through the mirror

**Files:**
- Create: `tests/lib/host-git.ts`
- Modify: `cli/lib/commands/provision.ts`, `cli/lib/commands/delete.ts`, `tests/provision.test.ts`, `tests/stop-delete.test.ts`

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces:
  - `provisionContainer(ctx, container, ownerRepo): Promise<{ mirror: "created" | "kept" }>`. Task 3 uses the result to skip a second fetch right after a clone.
  - `assertNoHostGitIn(calls: string[][], dir: string): void` in `tests/lib/host-git.ts`. It fails when any call with `argv[0] === "git"` has an element containing `dir`.

- [ ] **Step 1: Write the failing tests** in `tests/provision.test.ts`
  - **Setup:** `FORGE_MIRRORS` is set in `beforeEach`.
  - **Removed:** the tests "the clone happens on the host over SSH", "a workspace left by a deleted container is reused, its origin realigned", "a non-empty workspace of another repo…", "a non-empty workspace that is not a git repository…" and "an empty workspace directory is cloned into". They are replaced by:
    - `the mirror is created on the host before the launch`: the `clone --bare` index is lower than the `launch` index.
    - `the workspace is cloned inside the container, after both devices`:
      - `devices.origin` deep-equals `{ type: "disk", source: <mirror>, path: "/forge/origin.git", readonly: "true" }`;
      - `devices.workspace` is unchanged;
      - the in-container clone call comes after both `device add` calls.
    - `no host git touches the workspace`: `assertNoHostGitIn(ctx.calls, <workspaces>)`, for a new container and for a reuse.
    - `a workspace with a matching mirror is reused`:
      - `seedWorkspace("README.md")`, the mirror directory created, the rule `--get remote.origin.url` answering `git@github.com:o/r.git`;
      - no `clone` call on the host or in the container;
      - one `remote set-url origin /forge/origin.git` in the container;
      - the result is `{ mirror: "kept" }`.
    - `a non-empty workspace without a mirror stops before the launch`: rejects with `/no mirror of o\/r/`; not launched.
    - `a mirror of another repo stops before the launch`: with an empty workspace; rejects with `/mirror of a\/b/`.
    - `a failing mirror clone stops before the launch`: `/create mirror failed: Permission denied/`; not launched.
  - **Updated:** `the retrieval hint …` asserts the three lines of Global Constraints and no `ssh://`.
  - **In `tests/stop-delete.test.ts`:** `delete says the workspace and the mirror are kept`. One out line contains both paths and `forge start moroine/agent-forge`.

- [ ] **Step 2: Run them to verify they fail**

  Run: `node --test tests/provision.test.ts tests/stop-delete.test.ts`. Expected: FAIL on the new tests.

- [ ] **Step 3: Implement**
  - **Preconditions**, in this order:
    1. credentials;
    2. identity;
    3. `requireRuntime`;
    4. `existing = await mirrorRepo(ctx, mirrorPath(container))`. A different repo throws the Task 1 message;
    5. the workspace check. A non-empty workspace is reusable only when `existing === ownerRepo.toLowerCase()`. Otherwise it throws `"<dir> already exists and is not empty, and no mirror of <ownerRepo> vouches for it (<mirror>). It is the only copy of whatever it contains, so provisioning stops rather than overwrite it: move it aside (or remove it) and run the command again."`.
  - **Then:**
    1. `ensureMirror`, with an out line `Fetching <ownerRepo> into the host mirror…` or `Reusing the host mirror <mirror>…`;
    2. launch, then `waitReady`;
    3. `mkdirSync(workspace)`;
    4. `device add <c> origin disk source=<mirror> path=/forge/origin.git readonly=true`;
    5. `device add <c> workspace disk source=<dir> path=/workspace`;
    6. `pointOriginAtMirror` (reuse) or `cloneWorkspace` (new), both through `mustSucceed`;
    7. the rest unchanged.
  - **Deleted:** `workspaceIsReusable`'s `git -C` calls.
  - **`delete.ts`** prints `Kept <workspace> and <mirror>: 'forge start <owner/repo>' reuses them.` after a successful delete.

- [ ] **Step 4: Run them to verify they pass**

  Run: `node --test tests/provision.test.ts tests/stop-delete.test.ts && npm run check`. Expected: PASS.

- [ ] **Step 5: Commit**

  `git commit --no-gpg-sign -m "fix: le provisioning ne lance plus git hôte dans le workspace de l'agent"`, with the files above.

### Task 3: `forge start` refreshes through the mirror

**Files:**
- Modify: `cli/lib/commands/start.ts`, `tests/start.test.ts`

**Interfaces:**
- Consumes: `refreshMirror`, `hasOriginDevice`, `ORIGIN_DEVICE` and `mirrorPath` (Task 1); `provisionContainer`'s result (Task 2).

- [ ] **Step 1: Write the failing tests**
  - **Shared rules** (`rules()` in `tests/start.test.ts`) gain `{ match: "config device list", stdout: "origin\nworkspace\n" }`.
  - **Replaced:** `a supervised container skips the fetch` becomes `the host mirror is refreshed, then the container fetches from it`. The host `--git-dir=…/agent-moroine-agent-forge.git … fetch --prune` index is lower than the in-container `git -C /workspace fetch origin` index, which is lower than `worktree add`.
  - `a failing mirror refresh only warns, and the container still fetches`:
    - the rule `fetch --prune` gives code 128 with stderr `Error connecting to agent`;
    - err lines match `/WARNING: refreshing the mirror from GitHub failed: Error connecting to agent/` and `/ForwardAgent/`;
    - the worktree is still created.
  - `a container without the origin device is refused, with the way out`:
    - `config device list` answers `workspace\n`;
    - rejects with `/no 'origin' device/`, `/forge delete moroine\/agent-forge/` and `/aside/`;
    - no `worktree add`.
  - `right after a fresh mirror clone, start does not fetch GitHub again`: drive `cmdStart` on a new container (FakeIncus with runtime) and count host `fetch --prune` calls: 0.
  - `no host git touches the workspace` (`assertNoHostGitIn`).
  - **Kept:** the existing `fetch origin` warning tests. Their rule match becomes `-C /workspace fetch origin`.

- [ ] **Step 2: Run them to verify they fail**

  Run: `node --test tests/start.test.ts`. Expected: FAIL on the new tests.

- [ ] **Step 3: Implement**
  - **The guard.** After the container is running: `if (!(await hasOriginDevice(ctx, container)))`, throw `"<c> predates the read-only mirror (no 'origin' device). Retrieve its work, then: forge delete <owner/repo>, move <workspace> aside, and forge start <owner/repo> again."`.
  - **`refreshMain(ctx, container, ownerRepo, opts: { mirror: boolean })`:**
    1. When `opts.mirror`, print `Refreshing the host mirror of <owner/repo>…`, then `refreshMirror`. On failure print the WARNING above and `Continuing from the mirror's last-known refs (is your SSH agent forwarded? attach with ForwardAgent yes).`
    2. The in-container `git -C /workspace fetch origin`, with its existing warnings.
    3. `advanceMain`, unchanged.
  - **The call.** `cmdStart` passes `mirror: false` only when `provisionContainer` returned `"created"` in this run.
  - **Removed:** the `containerMode` import and the supervised branch.

- [ ] **Step 4: Run them to verify they pass**

  Run: `node --test tests/start.test.ts && npm run check`. Expected: PASS.

- [ ] **Step 5: Commit**

  `git commit --no-gpg-sign -m "feat: forge start rafraîchit main via le miroir hôte puis dans le container"`

### Task 4: `forge upload-pack` and the retrieval instructions

**Files:**
- Create: `cli/lib/commands/upload-pack.ts`, `tests/upload-pack.test.ts`, `tests/contract/retrieval.test.ts`
- Modify: `cli/lib/incus.ts` (`uploadPackArgv`), `cli/lib/validate.ts` (`validateContainerName`), `cli/forge.ts` (dispatch, usage), `container/CLAUDE.md`, `tests/test-claude-template.sh`, `tests/e2e.test.ts`, `tests/validate.test.ts`

**Interfaces:**
- Produces:
  - `validateContainerName(name: string): void`: `/^agent-[a-z0-9-]+$/`, else `ForgeError("container must be agent-<name> with [a-z0-9-], got: <name>")`.
  - `uploadPackArgv(container: string, gitProtocol: string | undefined): string[]`.
  - `cmdUploadPack(ctx, container?: string, gitProtocol = process.env.GIT_PROTOCOL): Promise<number>`.
  - The usage line `upload-pack <container> [<path>]   Serve a container's repository to git fetch (see forge start's retrieval hint)`.

- [ ] **Step 1: Write the failing tests**
  - **`tests/upload-pack.test.ts`:**
    - `argv runs git-upload-pack in the container as aiuser`: the exact argv of Global Constraints without `GIT_PROTOCOL`;
    - `GIT_PROTOCOL=version=2` adds `--env GIT_PROTOCOL=version=2` before `--`;
    - `version=2:x` and `x` are dropped;
    - `a stopped container is started, and nothing goes to stdout`: a FakeIncus instance `Stopped`; `incus start` is called before the `attach`; `ctx.out_lines` deep-equals `[]` (Review Focus 4);
    - `a container without user.forge.repo is refused`: `/not a forge container/`, no attach;
    - `an invalid container name is refused before any call`: `agent-x;id` → `/container must be/`, and `ctx.calls` is empty;
    - `the exit code of upload-pack is returned`: `attachCode: 5` gives 5;
    - `no host git runs`: `assertNoHostGitIn(ctx.calls, <workspaces>)`, and no call has `argv[0] === "git"` at all.
  - **`tests/e2e.test.ts`:** `forge upload-pack 'agent-x;id'` exits 1, with stdout `""` and stderr matching `/^Error: container must be/m`.
  - **`tests/contract/retrieval.test.ts`** (real git):
    - a clean "server" repository holds a commit on `agent/t`;
    - a stand-in executable `forge` in a temp bin directory appends its argv to a file, then `exec git-upload-pack <server>`;
    - a client repository runs `git remote add agent-x <empty temp dir>` and `git config remote.agent-x.uploadpack "<bin>/forge upload-pack agent-x"`, then `git fetch agent-x`;
    - asserted:
      - the fetch succeeds;
      - `refs/remotes/agent-x/agent/t` exists;
      - the recorded argv is `upload-pack agent-x <the URL path>`.
  - **`tests/test-claude-template.sh`:**
    - `assert_contains 'uploadpack "forge upload-pack <container>"'`;
    - `assert_contains '/forge/origin.git'`;
    - `assert_contains 'git fetch origin'`;
    - `assert_not_contains 'ssh://<user>@<host><workspaces>'`.
  - **`tests/validate.test.ts`:** `validateContainerName` accepts `agent-o-r` and rejects `agent-x;id`, `x` and `agent-X`.

- [ ] **Step 2: Run them to verify they fail**

  Run: `node --test tests/upload-pack.test.ts tests/e2e.test.ts tests/validate.test.ts tests/contract/retrieval.test.ts && bash tests/test-claude-template.sh`. Expected: FAIL (the module is missing, the template is unchanged). The retrieval contract test already passes: it does not run forge.

- [ ] **Step 3: Implement**
  - **`cmdUploadPack`:**
    1. `validateContainerName`;
    2. `containerRepo` must be non-empty;
    3. when not running, `mustSucceed("incus start", startInstance(…))`, with no `ctx.out`;
    4. `return ctx.attach(uploadPackArgv(…))`.
  - **`forge.ts`:** `case "upload-pack": return cmdUploadPack(ctx, a);`.
  - **`container/CLAUDE.md`, supervised paragraph** (French):
    - `origin` is a read-only mirror at `/forge/origin.git`, refreshed by forge at each `forge start`;
    - `git fetch origin` works; `git push` is impossible (and blocked);
    - the retrieval block becomes:

      ```bash
      git remote add <container> <forge-host>:<container>
      git config remote.<container>.uploadpack "forge upload-pack <container>"
      git fetch <container> agent/<task-name>:agent/<task-name>
      git log -p main..agent/<task-name>          # review avant toute autre action
      git checkout agent/<task-name>
      git rebase --reset-author main
      git push origin agent/<task-name>            # identité de l'humain, re-signé par lui
      ```

    - the "La commande exacte … ne l'invente pas" sentence stays, naming `<forge-host>`.

- [ ] **Step 4: Run them to verify they pass**

  Run: the command of Step 2, then `npm run check`. Expected: PASS.

- [ ] **Step 5: Commit**

  `git commit --no-gpg-sign -m "feat: forge upload-pack sert le dépôt depuis le container pour la récupération"`

### Task 5: Integration tests for host-side git

**Files:**
- Modify: `tests/integration/incus.test.ts`

**Interfaces:**
- Consumes:
  - `ensureMirror`-equivalent seeding by hand;
  - `refreshMirror`, `cloneWorkspace` and `mirrorPath` (Task 1), called with `createContext()` and `process.env.FORGE_INCUS_PROJECT = PROJECT`;
  - the real `cli/forge` for `upload-pack`.

- [ ] **Step 1: Write the tests** (they run only with `FORGE_INTEGRATION=1`)
  - **`mirror: mounted read-only and locked`:**
    1. A bare repository goes in `<workspaces>/mirror-ro.git`, and is added to `c1` as `origin` with `readonly=true` and `path=/forge/origin.git`.
    2. `asAgent(c1, "touch /forge/origin.git/x")` fails.
    3. `incus exec c1 -- mount -o remount,rw /forge/origin.git` fails.
    4. The host directory has no new entry.
  - **`hostile workspace: refresh and retrieval run nothing the agent planted`:**
    1. Launch `${PREFIX}${id}-g` with the sentinel.
    2. On the host:
       - set `FORGE_MIRRORS=<workspaces>/mirrors`;
       - create a stand-in "GitHub" bare repository with a commit;
       - seed the mirror with `git clone --bare <stand-in> <mirrorPath(c)>`, then `remote set-url origin git@github.com:forge-selftest/throwaway.git`.
    3. Add the `origin` device (read-only) and an empty `workspace`, then `cloneWorkspace` (asserted 0).
    4. As `aiuser`, through `asAgent`, plant the following in `/workspace/.git`:
       - each pair of `hostileConfig(marker)` with `git -C /workspace config`;
       - each `HOSTILE_HOOKS` hook as `hookScript(marker)`, mode 755;
       - an `.git/FETCH_HEAD` symlink to the host path `<workspaces>/CANARY` (created on the host with known content).

       `marker` is the **host** path `<workspaces>/HOST-MARKER`: a planted command creates it only if it runs on the host.
    5. Run:
       - `refreshMirror(ctx, mirrorPath(c), "forge-selftest/throwaway")`. It fails, since there is no GitHub key on the test VM; only its effects are checked;
       - in the container, `git -C /workspace fetch origin` as `aiuser`;
       - on the host, a clean client repository fetches through `git config remote.<c>.uploadpack "<FORGE> upload-pack <c>"`, with `FORGE_INCUS_PROJECT`, from a local-path remote.
    6. Asserted:
       - the client fetch succeeds;
       - no `HOST-MARKER` on the host;
       - `CANARY` unchanged.

- [ ] **Step 2: Run the unit suite to check that nothing else moved**

  Run: `npm test && npm run check`. Expected: PASS. The integration tests are skipped without `FORGE_INTEGRATION`.

- [ ] **Step 3: Run the integration suite on a test Incus, if one is available**

  - Ask the parent session (`local_8e87246d-c94b-493c-ba97-2d5766e74803`) before using its AWS VMs.
  - On the VM, run `FORGE_INTEGRATION=1 npm run test:integration`. Expected: PASS.
  - With no VM, write "integration not run" in the PR body.

- [ ] **Step 4: Commit, then deliver PR sp4 2/4** (see "Delivery")

  `git commit --no-gpg-sign -m "test: intégration du miroir en lecture seule et du workspace piégé"`

### Task 6: The agent seam and `forge attach`

**Files:**
- Create: `cli/lib/agent.ts`, `cli/lib/session.ts`, `cli/lib/commands/attach.ts`, `tests/session.test.ts`, `tests/attach.test.ts`
- Modify: `cli/lib/context.ts` (`attach` options), `cli/lib/incus.ts` (`attachArgv`), `cli/forge.ts`, `tests/lib/fake-context.ts` (`attachCalls`), `tests/incus.test.ts`, `tests/e2e.test.ts`

**Interfaces:**
- Consumes: `validateContainerName` (Task 4).
- Produces:
  - **`context.ts`:** `type AttachOptions = { env?: Record<string, string> }` and `Context.attach(argv: string[], opts?: AttachOptions): Promise<number>`.
  - **The fake context** records `attachCalls: { argv: string[]; opts?: AttachOptions }[]`. It still pushes the argv to `calls`.
  - **`agent.ts`:** `type Agent = { herdrLabel: string; command(container: string, task: string, resume: boolean): string[]; marker(container: string, task: string): string }`. `AGENT: Agent` is `{ herdrLabel: "claude", … }`, and `marker` gives `--remote-control <c>-<task>`.
  - **`incus.ts`:** `attachArgv(container: string, task: string, term: string, command: string[]): string[]`, replacing the tmux one.
  - **`session.ts`:**
    - `claudeSlug(path: string): string`;
    - `transcriptDir(task: string): string`;
    - `hasConversation(ctx, container, task): Promise<boolean>`;
    - `ensureRunning(ctx, container): Promise<void>`;
    - `attachTask(ctx, container, task): Promise<number>`.
  - **`commands/attach.ts`:** `cmdAttach(ctx, container?: string, task?: string): Promise<number>`, and the usage line `attach <container> <task>          Run a task's agent in this terminal (what herdr tabs run)`.

- [ ] **Step 1: Write the failing tests**
  - **`tests/incus.test.ts`:** `attachArgv runs the agent command directly under incus exec`. It deep-equals `[...P, "exec","agent-x","--user","1001","--group","1001","--cwd","/workspace/.trees/cli","--env","TERM=xterm-256color","--","bash","-lc","exec claude --permission-mode auto --remote-control agent-x-cli"]` for `AGENT.command("agent-x","cli",false)`. It contains neither `su` nor `tmux`.
  - **`tests/session.test.ts`:**
    - `AGENT.command` with `resume: true` ends with ` --continue'`, and `AGENT.marker("agent-x","cli")` is `--remote-control agent-x-cli`;
    - `claudeSlug("/workspace") === "-workspace"`, `claudeSlug("/workspace/.trees/fix.v2") === "-workspace--trees-fix-v2"`;
    - `hasConversation` runs, through `execAsAgentArgv`, `["sh","-c","ls \"$1\"/*.jsonl >/dev/null 2>&1","sh","/home/aiuser/.claude/projects/-workspace--trees-cli"]`. Code 0 gives `true`, 2 gives `false`;
    - `ensureRunning`:
      - starts a stopped container;
      - tolerates a failed `incus start` when a second `list` reports `Running` (two answers in sequence);
      - throws `/incus start failed/` when it stays stopped;
    - `attachTask passes HERDR_AGENT=claude to the incus process`: `attachCalls[0].opts.env` deep-equals `{ HERDR_AGENT: "claude" }`;
    - `--continue` is present only when the probe answers 0.
  - **`tests/attach.test.ts`:**
    - `an invalid container name is refused before any call`;
    - `a container without forge metadata is refused`;
    - `a missing worktree names forge start`;
    - `the agent's exit code is returned` (`attachCode: 3`);
    - `a stopped container is started first`.
  - **`tests/e2e.test.ts`:** `forge attach` with no arguments exits 1 with `Usage: forge attach`.

- [ ] **Step 2: Run them to verify they fail**

  Run: `node --test tests/incus.test.ts tests/session.test.ts tests/attach.test.ts tests/e2e.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**
  - **`ensureRunning`:** if `isRunning`, return. Otherwise `startInstance`. On failure, re-read the status, and throw `mustSucceed`-style (`incus start failed: <stderr>`) only when it is not `Running`.
  - **`attachTask`:**
    1. `const resume = await hasConversation(…)`;
    2. `return ctx.attach(attachArgv(c, t, process.env.TERM ?? "xterm-256color", AGENT.command(c, t, resume)), { env: { HERDR_AGENT: AGENT.herdrLabel } })`.
  - **`cmdAttach`:**
    1. usage when an argument is missing;
    2. `validateContainerName`, `validateTaskName`;
    3. `containerRepo` must be non-empty (`<c> is not a forge container`);
    4. `ensureRunning`;
    5. `test -e /workspace/.trees/<task>` (`no worktree .trees/<task> in <c>. Start it with 'forge start'.`);
    6. `attachTask`.
  - **`forge.ts`:** `case "attach": return cmdAttach(ctx, a, b);`.
  - **Callers of the old `attachArgv`** (`start.ts`, `resume.ts`) call `attachTask` for now. Task 8 replaces those calls.
  - **Contract with sub-project 3** (its plan `docs/superpowers/plans/2026-10-18-v2-egress-allowlist.md`, Task 8). It applies if `cli/lib/strict.ts` exists on the base branch when this task runs; otherwise sub-project 3 adds these lines when it lands second.
    - **`ensureRunning`** begins with `await egressBeforeStart(ctx, container)`, before any `incus start`, even when the container already runs. A too-old Incus is then refused before the container starts.
    - **`attachTask`** begins with `await egressAfterStart(ctx, container, await egressMode(ctx, container))`. `egressMode` is read-only: it reads `user.forge.egress`.

- [ ] **Step 4: Run them to verify they pass**

  Run: `npm run test:unit && npm run check`. Expected: PASS. Tests that still look for `tmux` in `start.test.ts` / `resume-finish.test.ts` now look for the `attachCalls` entry (`bash -lc`) instead.

- [ ] **Step 5: Commit**

  `git commit --no-gpg-sign -m "feat: forge attach lance l'agent sans tmux, --continue quand une conversation existe"`

### Task 7: Running-task probe, `forge list` and `forge finish`

**Files:**
- Modify: `cli/lib/worktrees.ts`, `cli/lib/session.ts`, `cli/lib/commands/list.ts`, `cli/lib/commands/finish.ts`, `tests/worktrees.test.ts`, `tests/list.test.ts`, `tests/resume-finish.test.ts`
- Delete: `tests/contract/tmux.test.ts`

**Interfaces:**
- Produces:
  - **`worktrees.ts`:** `parseRunningTasks(ps: string, container: string): Set<string>` and `runningTasks(ctx, container): Promise<Set<string>>`. The probe is `execAsAgentArgv(ctx, c, ["ps","-u","1001","-o","args="])`; non-zero gives an empty set. These replace `parseSessionStates` / `sessionStates`.
  - **`session.ts`:**
    - `stopAgent(ctx, container, task): Promise<void>`;
    - `setTranscriptsAside(ctx, container, task, now = new Date()): Promise<void>`;
    - `finishedStamp(now: Date): string`, giving `YYYYMMDDTHHMMSSZ`.

- [ ] **Step 1: Write the failing tests**
  - **`tests/worktrees.test.ts`, `parseRunningTasks`:**
    - `claude --permission-mode auto --remote-control agent-x-cli` and `node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --remote-control agent-x-docs --continue` give `{cli, docs}`;
    - `--remote-control agent-y-cli` (another container) is ignored;
    - `--remote-control agent-x-a;rm` is ignored (the token must end at whitespace or at the end of the line);
    - `--remote-control agent-x-` (empty name) is ignored;
    - the parsed names pass `[A-Za-z0-9._-]+`.
  - **`tests/list.test.ts`:**
    - the `list-sessions` rule becomes `{ match: "ps -u 1001 -o args=", stdout: "claude --permission-mode auto --remote-control agent-moroine-agent-forge-cli\n" }`;
    - task lines read `cli  running`, `docs  stopped`, `api  stopped`.
  - **`tests/resume-finish.test.ts`, `finish`:**
    - the order is the `pkill` call (argv `["pkill","-f","--","--remote-control agent-moroine-agent-forge-cli( |$)"]` through `execAsAgentArgv`), then `worktree remove`, then a `sh -c` whose argv ends with `/home/aiuser/.claude/projects/-workspace--trees-cli` and a stamp matching `/^\d{8}T\d{6}Z$/`;
    - no `tmux` call;
    - a `pkill` exit 1 (no process) does not fail `finish`;
    - a failing transcripts move only warns (`WARNING`);
    - `list` and `finish` run no host git (`assertNoHostGitIn`, and no `argv[0] === "git"`).
  - **`finishedStamp(new Date("2026-10-18T09:05:03.456Z"))`** is `20261018T090503Z`.

- [ ] **Step 2: Run them to verify they fail**

  Run: `node --test tests/worktrees.test.ts tests/list.test.ts tests/resume-finish.test.ts tests/session.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**
  - **`stopAgent`:** `execAsAgentArgv` with the `pkill` argv above, result ignored.
  - **`setTranscriptsAside`:** `execAsAgentArgv(ctx, c, ["sh","-c","[ ! -d \"$1\" ] || mv \"$1\" \"$1.finished-$2\"","sh", transcriptDir(task), finishedStamp(now)])`. A non-zero result gives `WARNING: moving the transcripts of <task> aside failed: …`.
  - **`finish.ts`**, in this order:
    1. the WIP check;
    2. `stopAgent`;
    3. `worktree remove` (`mustSucceed`);
    4. `setTranscriptsAside`;
    5. `Finished task … (branch agent/<task> retained).`

    The tmux line goes.
  - **`list.ts`:** `runningTasks` once per running container.

- [ ] **Step 4: Run them to verify they pass**

  Run: `npm run test:unit && npm run test:contract && npm run check`. Expected: PASS, and `tests/contract/tmux.test.ts` is gone.

- [ ] **Step 5: Commit**

  `git commit --no-gpg-sign -m "feat: forge list et finish suivent le processus de l'agent au lieu de tmux"`

### Task 8: `start` and `resume` on the attach core; tmux out of the image and CI

**Files:**
- Create: `cli/lib/tabs.ts` (`runTask`, `TaskRef`)
- Modify: `cli/lib/commands/start.ts`, `cli/lib/commands/resume.ts`, `cli/lib/context.ts` and `cli/lib/prompt.ts` (comments), `tests/lib/fake-context.ts` (the `attachCode` comment), `ansible/roles/forge_image/tasks/base.yml`, `ansible/roles/forge_image/tasks/verify.yml`, `.github/workflows/ci.yml`, `tests/start.test.ts`, `tests/resume-finish.test.ts`

**Interfaces:**
- Produces, in `tabs.ts`, which imports `session.ts` and never the reverse:
  - `type TaskRef = { container: string; ownerRepo: string; task: string }`;
  - `runTask(ctx, t: TaskRef): Promise<number>`. In this task it prints `outside herdr: the agent stops when this terminal closes` on stderr, then returns `attachTask`. Task 10 adds the herdr branch.
  - `ownerRepo` is the container's stored `user.forge.repo` (`containerRepo`), not the argument as typed.

- [ ] **Step 1: Write the failing tests**
  - **`tests/start.test.ts`:**
    - `the task's agent is attached in the foreground outside herdr`: the last `attachCalls` entry ends with `bash -lc 'exec claude …--remote-control agent-moroine-agent-forge-fresh'`, and `err_lines` contains the outside-herdr line;
    - `a new task whose transcript folder would collide with an existing task is refused` (Review Focus 2): the worktree list holds `.trees/fix.v2`; `cmdStart(c, "moroine/agent-forge", "fix-v2")` rejects with `/share Claude's transcript folder with 'fix.v2'/`, and no `worktree add` is made;
    - every former `call.includes("tmux")` assertion becomes an assertion on `attachCalls`.
  - **`tests/resume-finish.test.ts`:**
    - `resume attaches the task's agent`, with the `attachCalls` argv `--cwd /workspace/.trees/cli`;
    - `resume asks for repo then task …` checks `--cwd /workspace/.trees/docs`;
    - `resume runs no host git` (no `argv[0] === "git"`).

- [ ] **Step 2: Run them to verify they fail**

  Run: `node --test tests/start.test.ts tests/resume-finish.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**
  - **`addWorktree`.** When the worktree does not exist yet, before any `worktree add`: if another task from `taskNames` has the same `claudeSlug(worktreeAbsPath(…))`, throw `"task '<task>' would share Claude's transcript folder with '<other>' (Claude Code maps both to <slug>); pick another name."`.
  - **`cmdStart` and `cmdResume`** end with `return runTask(ctx, { container, ownerRepo: await containerRepo(ctx, container), task })`. `cmdResume` uses `ensureRunning`.
  - **`base.yml`:** remove the `tmux` package line and its comment. **`verify.yml`:** remove `tmux -V`.
  - **`ci.yml`:** `sudo apt-get install -y jq`. The comment says jq is for `tests/test-pre-bash.sh`. herdr comes in Task 9.
  - **Comments.** In `context.ts`, `attach`'s comment says it inherits the terminal for the agent and for `ansible-playbook`. In `prompt.ts`, the example becomes the agent's `attach`. Both stay in French.

- [ ] **Step 4: Run them to verify they pass**

  Run: `npm test && npm run check`. Then `git grep -n -i tmux -- cli tests ansible .github container`. Expected:
  - PASS;
  - the grep prints nothing. Dated specs and plans, and the README (sub-project 5's), are outside those paths.

- [ ] **Step 5: Commit, then deliver PR sp4 3/4** (see "Delivery")

  `git commit --no-gpg-sign -m "chore: retire tmux du CLI, de l'image et de la CI"`

### Task 9: The herdr CLI layer

**Files:**
- Create: `cli/lib/herdr.ts`, `tests/herdr.test.ts`, `tests/contract/herdr.test.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces, in `herdr.ts`:
  - `type HerdrEnv = { bin: string; popup: boolean }`, and `herdrEnv(env = process.env): HerdrEnv | null`;
  - `type Workspace = { id: string; label: string }`, `type Tab = { id: string; label: string; workspaceId: string }`, `type Pane = { id: string; tabId: string }`, `type PaneState = "live" | "shell" | "busy"`;
  - `listWorkspaces(ctx, h): Promise<Workspace[]>`, from `[bin,"workspace","list"]`, field `result.workspaces[].{workspace_id,label}`;
  - `createWorkspace(ctx, h, label: string, cwd: string): Promise<{ workspaceId: string; tabId: string; paneId: string }>`, from `[bin,"workspace","create","--label",label,"--cwd",cwd,"--focus"]`, fields `result.workspace.workspace_id`, `result.tab.tab_id`, `result.root_pane.pane_id`;
  - `listTabs(ctx, h): Promise<Tab[]>`, from `[bin,"tab","list"]`;
  - `listPanes(ctx, h): Promise<Pane[]>`, from `[bin,"pane","list"]`;
  - `createTab(ctx, h, workspaceId: string, label: string, cwd: string): Promise<{ tabId: string; paneId: string }>`, from `[bin,"tab","create","--workspace",workspaceId,"--label",label,"--cwd",cwd,"--focus"]`;
  - `renameTab(ctx, h, tabId: string, label: string)`, `focusTab(ctx, h, tabId: string)` and `closeTab(ctx, h, tabId: string)`, each `Promise<void>`;
  - `paneRun(ctx, h, paneId: string, command: string): Promise<void>`;
  - `paneForeground(ctx, h, paneId: string): Promise<string[][]>`, from `[bin,"pane","process-info","--pane",paneId]`, field `result.process_info.foreground_processes[].argv`;
  - `classifyPane(foreground: string[][], container: string, task: string): PaneState`:
    - **live:** some argv holds `attach`, `container`, `task` consecutively;
    - **shell:** the list is non-empty and every process's argv0 basename, without a leading `-`, is one of `bash sh zsh fish dash`;
    - **busy:** anything else, an empty list included.

- [ ] **Step 1: Write the failing tests**
  - **`tests/herdr.test.ts`:**
    - **`herdrEnv`:**
      - `{HERDR_ENV:"1",HERDR_BIN_PATH:"/x"}` gives `{bin:"/x",popup:true}`;
      - with `HERDR_PANE_ID:"w1:p1"`, `popup:false`;
      - with no `HERDR_ENV` or an empty `HERDR_BIN_PATH`, `null`.
    - **Argv and parsing.** Each function's argv is exact, and its fields are parsed from the 0.9.5 JSON shapes, which the spec's "Research" and spike point 1 quote.
    - **Errors** (Review Focus 3):
      - a non-zero exit rejects with `/herdr tab create failed: /` and quotes stderr, or stdout when stderr is empty;
      - stdout `not json` rejects with `/herdr workspace list: unreadable answer: not json/`;
      - `{"error":{"code":"x","message":"boom"}}` with exit 0 rejects with `/herdr workspace list failed: boom/`;
      - a workspace without `workspace_id` rejects with `/unreadable answer/`.
    - **`classifyPane`:**
      - `[["node","/opt/agent-forge/current/cli/forge.ts","attach","agent-x","cli"]]` is `live` for `agent-x`/`cli`, and `busy` for `agent-x`/`docs`;
      - `[["-bash"]]` and `[["/usr/bin/zsh"]]` are `shell`;
      - `[["vim","x"]]` and `[]` are `busy`.
  - **`tests/contract/herdr.test.ts`** (real herdr):
    - **Skip and fail rules:** skip when `herdr` is not on PATH, except under `CI=true`, where it fails.
    - **Setup:**
      - `HOME = mkdtempSync("/tmp/fh-")`, `HERDR_SOCKET_PATH = <HOME>/s.sock` (short paths: spec "Research", point 7);
      - `herdr server` spawned detached;
      - wait at most 5 s for the socket.
    - **Calls**, with `createContext()` and `h = { bin: "herdr", popup: false }`:
      - `createWorkspace(ctx, h, "o/r", HOME)` returns three ids, and `listWorkspaces` includes label `o/r`;
      - `createTab(ctx, h, ws, "cli", HOME)` gives a pane that `listPanes` lists under its tab;
      - after `paneRun(pane, "exec sleep 30")`, `paneForeground` within 5 s gives `[["sleep","30"]]`, and `classifyPane` gives `busy`;
      - a fresh tab's pane is `shell`.
    - **After:** `herdr server stop`, then remove the temp directory.

- [ ] **Step 2: Run them to verify they fail**

  Run: `node --test tests/herdr.test.ts tests/contract/herdr.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement**
  - **One private helper** `herdrJson(ctx, h, args, pick: (result) => T)` handles exit codes, `JSON.parse`, the `error` object and missing fields, and throws `ForgeError` with the messages above.
  - **CI** (`cli` job, before `npm ci`), step `Install herdr (pinned)`:

    ```yaml
    - name: Install herdr (pinned, for the herdr contract tests)
      run: |
        mkdir -p "$HOME/.local/bin"
        curl -fsSL -o "$HOME/.local/bin/herdr" https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-linux-x86_64
        echo "14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d  $HOME/.local/bin/herdr" | sha256sum -c -
        chmod +x "$HOME/.local/bin/herdr"
        echo "$HOME/.local/bin" >> "$GITHUB_PATH"
    ```

- [ ] **Step 4: Run them to verify they pass**

  Run: `node --test tests/herdr.test.ts tests/contract/herdr.test.ts && npm run check`. Expected: PASS. herdr 0.9.5 is installed on this Mac.

- [ ] **Step 5: Commit**

  `git commit --no-gpg-sign -m "feat: couche CLI herdr (workspaces, onglets, panes) et test de contrat"`

### Task 10: Opening a task inside herdr

**Files:**
- Create: `tests/tabs.test.ts`
- Modify: `cli/lib/tabs.ts` (`openTask`, `runTask`'s herdr branch), `cli/lib/paths.ts` (`forgeCommand`), `cli/forge` (shim), `cli/forge.ts` (popup wait), `tests/e2e.test.ts`, `tests/test-forge-shim.sh`, `tests/paths.test.ts`

**Interfaces:**
- Consumes: `herdr.ts` (Task 9); `runningTasks` (Task 7); `TaskRef` and `attachTask` (Task 8); `forgeHome` (`paths.ts`).
- Produces:
  - `forgeCommand(): string`;
  - in `tabs.ts`:
    - `shellQuote(s: string): string`;
    - `attachCommand(container: string, task: string): string`;
    - `findTaskTab(ctx, h, ownerRepo: string, task: string): Promise<{ workspace: Workspace | null; tab: Tab | null; panes: Pane[] }>`;
    - `openTask(ctx, h: HerdrEnv, t: TaskRef): Promise<number>`;
  - `runTask` dispatches to `openTask` when `herdrEnv()` is not null.

- [ ] **Step 1: Write the failing tests**
  - **`tests/paths.test.ts`:**
    - `FORGE_INVOKED_AS=./cli/forge` gives `path.resolve("./cli/forge")`, and a symlink is not resolved;
    - with it unset, `forge`.
  - **`tests/tabs.test.ts`.** Fake context with herdr answers as rules, `HERDR_*` set per test, and the herdr rules matching on the bin path `/h/herdr`:
    - **Typed command:** `attachCommand("agent-x","cli")` with `FORGE_INVOKED_AS=/usr/local/bin/forge` is exactly `exec env HERDR_AGENT=claude '/usr/local/bin/forge' attach agent-x cli`. `shellQuote("a'b")` is `'a'\''b'`.
    - **The four rows of the spec's table:**
      - `no agent, no workspace`:
        - one `workspace create --label o/r --cwd <home> --focus`;
        - then `tab rename <root tab> cli`;
        - then `pane run <root pane> <typed command>`;
        - no `tab create`.
      - `no agent, workspace without the tab`: `tab create --workspace w1 --label cli --cwd <home> --focus`, then `pane run`.
      - `no agent, tab with a bare shell`: `pane run` in that tab's pane, then `tab focus`.
      - `no agent, tab busy` rejects with `/is busy/`, and no `pane run`.
      - `agent running, live tab`: only `tab focus`, no `pane run`.
      - `agent running, no tab` and `agent running, bare tab` both reject with `/already runs outside this herdr/`.
    - **Case** (Review Focus 1): workspace label `Moroine/Agent-Forge` and `ownerRepo` `moroine/agent-forge` give no `workspace create`; the existing workspace is used.
    - **Several matches:** two workspaces labelled `o/r` → the first is used, and stderr says so.
    - **`runTask` outside herdr:** no herdr call, and `attachTask` is used (from Task 8's tests, kept green).
  - **`tests/e2e.test.ts`.** The helper `forge()` scrubs `HERDR_*` from the child's environment unless a test passes them.
    - `a failure in the herdr popup waits for Enter`:
      - env `HERDR_ENV=1`, `HERDR_BIN_PATH=/bin/false`, no `HERDR_PANE_ID`, input `"\n"`;
      - `forge frobnicate` exits 1;
      - stderr contains `Error: unknown command` and then `Press Enter to close`.
    - `outside the popup there is no wait`: the same with `HERDR_PANE_ID=w1:p1`; stderr has no `Press Enter`.
  - **`tests/test-forge-shim.sh`:** `assert_contains 'export FORGE_INVOKED_AS="${BASH_SOURCE[0]}"'`.

- [ ] **Step 2: Run them to verify they fail**

  Run: `node --test tests/tabs.test.ts tests/paths.test.ts tests/e2e.test.ts && bash tests/test-forge-shim.sh`. Expected: FAIL.

- [ ] **Step 3: Implement**
  - **`openTask`:**
    1. `running = (await runningTasks(ctx, t.container)).has(t.task)`;
    2. `findTaskTab`, which:
       - matches workspace labels case-insensitively and tab labels exactly;
       - takes the first on duplicates, with a stderr note;
       - collects the tab's panes from `listPanes`;
    3. the state of the tab: `live` if any pane is live, otherwise the first pane's state;
    4. the table's action.
  - **Messages:**
    - on success: `Opened <owner/repo> <task> in herdr.` or `Focused <owner/repo> <task> in herdr.`;
    - the busy refusal: `herdr tab <task> in <owner/repo> is busy (it runs <argv0>): close it or free its shell, then run this again.`;
    - the second-agent refusal: `the agent for <task> already runs outside this herdr (another terminal?): stop it there first.`
  - **`cwd`** is `forgeHome()`.
  - **The shim:** add `export FORGE_INVOKED_AS="${BASH_SOURCE[0]}"` before the `exec` line, with a comment (French) saying why: a stable path for herdr, unlike the resolved release.
  - **`forge.ts`.** In `catch`, after the error line, when `herdrEnv()?.popup`: print `Press Enter to close`, then await one line or the end of stdin (`node:readline`, one `line` or `close` event).

- [ ] **Step 4: Run them to verify they pass**

  Run: `npm test && npm run check`. Expected: PASS.

- [ ] **Step 5: Commit**

  `git commit --no-gpg-sign -m "feat: forge start et resume ouvrent la tâche dans un onglet herdr"`

### Task 11: `forge resume --all` and `finish`'s tab cleanup

**Files:**
- Modify: `cli/lib/tabs.ts` (`resumeAll`, `closeBareTab`), `cli/lib/commands/resume.ts`, `cli/lib/commands/finish.ts`, `cli/forge.ts` (`--all`, usage), `tests/tabs.test.ts`, `tests/resume-finish.test.ts`

**Interfaces:**
- Consumes: Tasks 7–10.
- Produces:
  - `resumeAll(ctx, h: HerdrEnv): Promise<number>`;
  - `closeBareTab(ctx, h, t: TaskRef): Promise<void>`;
  - `cmdResume(ctx, repo?, task?, all = false)`;
  - the usage line `resume [<owner/repo>] [<task>]   Re-attach a task's agent (--all: every forge tab left bare by a herdr restart)`.

- [ ] **Step 1: Write the failing tests**
  - **`tests/tabs.test.ts`, `resumeAll`.** Two forge containers and three workspaces: `o/r` (forge), `O/S` (forge, other case), `misc` (not forge). Tabs:

    | Workspace | Tab | Pane state / situation | Expected |
    |---|---|---|---|
    | `o/r` | `cli` | bare shell | `pane run` with `attachCommand`; line `o/r cli: resumed` |
    | `o/r` | `docs` | live | `o/r docs: already running` |
    | `o/r` | `api` | bare shell, but `api` running in the container | `o/r api: skipped (agent runs outside this herdr)` |
    | `o/r` | `notes` | not a task with a worktree | ignored, no line |
    | `O/S` | `x` | busy | `o/s x: skipped (tab is busy)`, with the repo as stored |
    | `misc` | any | — | never inspected |

    - A stopped container whose workspace has tabs is started before its tasks are listed.
    - With no herdr, `cmdResume(ctx, undefined, undefined, true)` rejects with `/resume --all only works inside herdr/`.
    - `--all` with a repo argument is a usage error.
  - **`tests/resume-finish.test.ts`:**
    - `finish closes the task's tab when it is a bare shell, inside herdr`: `tab close <id>` comes after the transcripts move;
    - a live tab is not closed;
    - outside herdr there is no herdr call.

- [ ] **Step 2: Run them to verify they fail**

  Run: `node --test tests/tabs.test.ts tests/resume-finish.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**
  - **`resumeAll`:**
    1. Map each forge container to its stored repo, lowercased.
    2. For each matching workspace:
       - `ensureRunning`. On failure, one line `<repo>: skipped (container did not start: <message>)`;
       - `taskNames`;
       - `runningTasks`.
    3. For each tab whose label is a task, apply the table above.
    4. When no line was printed, print `no forge tab to resume.`.
    5. Return 0.
  - **`forge.ts`:** the `parseArgs` options gain `all: { type: "boolean" }`; `resume` gets `values.all === true`.
  - **`finish.ts`:** after the transcripts move, `if (herdrEnv()) await closeBareTab(…)`.

- [ ] **Step 4: Run them to verify they pass**

  Run: `npm run test:unit && npm run check`. Expected: PASS.

- [ ] **Step 5: Commit**

  `git commit --no-gpg-sign -m "feat: forge resume --all relance les onglets forge après un redémarrage de herdr"`

### Task 12: The herdr config block in `forge setup`

**Files:**
- Create: `cli/lib/herdr-config.ts`, `tests/herdr-config.test.ts`
- Modify: `cli/lib/paths.ts` (`herdrConfigPath`), `cli/lib/commands/setup.ts` (one call), `tests/setup.test.ts`, `tests/contract/herdr.test.ts`, `tests/integration/incus.test.ts`

**Interfaces:**
- Consumes: `forgeCommand`, `shellQuote` (Task 10).
- Produces:
  - `herdrConfigPath(): string` in `paths.ts`;
  - in `herdr-config.ts`:
    - `BLOCK_START`, `BLOCK_END`;
    - `renderBlock(forge: string): string`;
    - `spliceBlock(text: string, block: string): { text: string; outcome: "created" | "updated" | "unchanged" }`;
    - `conflictingKeys(text: string): string[]`;
    - `ensureHerdrConfig(ctx): Promise<void>`;
  - `cmdSetup` calls `await ensureHerdrConfig(ctx)` as its last step, before `return 0`.

- [ ] **Step 1: Write the failing tests**
  - **`tests/herdr-config.test.ts`:**
    - **`renderBlock("/usr/local/bin/forge")`** equals exactly:

      ```
      # >>> agent-forge >>>
      # Managed by `forge setup`: edits inside this block are overwritten.
      # Keep your own settings above it.
      [[keys.command]]
      key = "prefix+f"
      type = "popup"
      command = "'/usr/local/bin/forge' start"
      description = "forge: start or open a task"
      width = "90%"
      height = "90%"

      [[keys.command]]
      key = "prefix+shift+f"
      type = "popup"
      command = "'/usr/local/bin/forge' resume --all"
      description = "forge: resume agents stopped by a herdr restart"
      width = "90%"
      height = "90%"
      # <<< agent-forge <<<
      ```

      A path holding `"` or `\` is escaped as a TOML basic string.
    - **`spliceBlock`:**
      - `""` gives the block and `created`;
      - `"x = 1\n"` gives `"x = 1\n\n" + block` and `created`;
      - `"x = 1"` (no final newline) gives `"x = 1\n\n" + block`;
      - a text already holding this block gives `unchanged`, with an identical text;
      - an old block (another command path) between user lines gives `updated`, with the user lines before and after byte-identical;
      - user content in CRLF keeps its `\r\n`, and markers followed by `\r` are found (Review Focus 5);
      - a start marker without an end, and two blocks, throw `/agent-forge block/`.
    - **`conflictingKeys`** finds `key = "prefix+f"` above the block, and ignores the block's own keys.
    - **`ensureHerdrConfig`** (temp `HERDR_CONFIG_PATH` under a temp directory that does not exist yet; fake context):
      - **The file:**
        - created with mode 0644, its directory with mode 0700;
        - out line `herdr config <path>: created`;
        - a second run: `unchanged`, and the file's `mtimeMs` and inode unchanged;
        - an existing file with mode 0600 keeps 0600 after an update.
      - **No herdr** (rule `herdr --version` code 127, no `HERDR_BIN_PATH`, no `~/.local/bin/herdr`):
        - stderr `NOTICE: herdr is not installed on this host yet: the bindings apply once \`herdr --remote\` installs it.`;
        - no `config check` call.
      - **With a herdr:**
        - `config check` answering `config: ok` gives no warning;
        - `config: issues found\nunknown config key x; ignoring key` gives `WARNING: herdr config check: unknown config key x; ignoring key`;
        - `config check` runs with env `HERDR_CONFIG_PATH=<path>`;
        - `server reload-config` answering `{"result":{"status":"applied"}}` gives nothing;
        - `{"error":{"code":"server_not_running"}}` gives `NOTICE: no herdr server is running: the bindings apply when it starts.`;
        - anything else gives a `WARNING` quoting the output.
      - **A conflict** gives `WARNING: <path> also binds prefix+f outside forge's block; herdr may run either.`
  - **`tests/setup.test.ts`.**
    - `beforeEach` sets `HERDR_CONFIG_PATH` inside the temp `xdg` directory and adds the rule `herdr --version` code 127.
    - `an empty Incus gives four creations` expects a fifth out line `herdr config <path>: created`.
    - `a second run makes no mutating call` still holds; every out line ends with `: unchanged`.
  - **`tests/contract/herdr.test.ts`:** `herdr config check`, with `HERDR_CONFIG_PATH` on a file holding only `renderBlock("/usr/local/bin/forge")`, prints `config: ok`.
  - **`tests/integration/incus.test.ts`:** `forge()` passes `HERDR_CONFIG_PATH=<workspaces>/herdr.toml`; the second setup run expects 5 lines.

- [ ] **Step 2: Run them to verify they fail**

  Run: `node --test tests/herdr-config.test.ts tests/setup.test.ts tests/contract/herdr.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**
  - **`herdrConfigPath`**, following Global Constraints.
  - **`ensureHerdrConfig`:**
    1. read the file (absent means `""`);
    2. `spliceBlock(text, renderBlock(forgeCommand()))`. A thrown error is rethrown as `ForgeError("<path>: <message>")`;
    3. write only when the outcome is not `unchanged`:
       - `mkdirSync(dirname, { recursive: true, mode: 0o700 })` when the directory is missing;
       - write `<path>.forge-tmp` with the existing mode or 0644, then `renameSync`;
    4. report, then the conflicts;
    5. find a herdr binary: `HERDR_BIN_PATH` when the file exists, then `<forge home>/.local/bin/herdr`, then `herdr --version` exiting 0;
    6. `config check`, then `server reload-config`, as tested.

- [ ] **Step 4: Run them to verify they pass**

  Run: `npm test && npm run check`. Expected: PASS.

- [ ] **Step 5: Commit, then deliver PR sp4 4/4** (see "Delivery")

  `git commit --no-gpg-sign -m "feat: forge setup installe les raccourcis forge dans la config herdr"`

### Task 13: Final verification and hand-over

**Files:**
- Modify: `/Users/moroinebentefrit/Library/Application Support/Claude/side-session-notes/local_8e87246d-c94b-493c-ba97-2d5766e74803/readme-needs-sp4.md` (outside the repo)

- [ ] **Step 1: Run the whole suite on the top branch**

  Run: `npm test && npm run check`. Then `git grep -n -i tmux -- cli tests ansible .github container`. Expected: PASS; the grep prints nothing.

- [ ] **Step 2: Check the spec's coverage**

  For each section of the spec ("The design" 1–6, "herdr integration", "Security tests", "Testing"), name the task and test that cover it. The PR sp4 4/4 body lists what was not run:
  - the integration tests, unless a test Incus was used;
  - the manual acceptance on a real VM;
  - Claude's `--continue` probe on the image's Claude Code.

- [ ] **Step 3: Update the README notes for sub-project 5**

  Check `readme-needs-sp4.md` against what was built (commands, keys, messages, retrieval lines), then send its path to the sub-project 5 session (`local_9d081379-f329-43a8-9ef4-3c739bae0a9a`).
