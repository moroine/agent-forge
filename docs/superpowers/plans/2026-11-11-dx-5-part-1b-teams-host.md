# DX 5, part 1b: teams on the host — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the forge host, a team declared in the config becomes a set of containers (one per agent), each with its capabilities, its own clone, the team's origin mirror and the team mirror; the human assigns and releases tasks from the host, and each assignment runs a fresh Claude session through the container's `hc`.

**Architecture:** The config gains `teams` and `pilot`, validated by hand like the rest of `config.ts`. A pure module turns them into members (container names, roles, capabilities, resolved `talkTo`). `forge team converge` provisions missing members with the existing provisioning steps, made reusable. The host keeps each container's busy/free state and its task records in Incus config keys. Sessions run in each container's own hc core, driven by `incus exec` with an argv; agent text travels as a file, never in an argv. The team mirror is a bare repository on the host, filled with `forge upload-pack` from developers' containers, branch by owned branch. Nothing here touches the Mac, and `forge start` keeps working (part 1c removes it).

**Tech Stack:** TypeScript on Node 24 (`node --test`), Incus (`incus exec`, disk devices, config keys), git (bare repos, `upload-pack`), herdr-core `hc` 0.1.20 inside the containers.

**Spec:** `docs/superpowers/specs/2026-11-11-dx-5-herdr-core-design.md`, decisions 1-7 and 9 (§3), §5.2, §5.3, §5.5, §5.7 (host side), §5.8, §5.11 part 1. Prerequisite: part 1a merged (token, `forge-agent`, `hc` in the image).

## Global Constraints

- Branch `agent/dx5-teams-host`, from `origin/main` after part 1a is merged; one pull request, `Refs #92 #19`. Title: `feat: les équipes d'agents sur l'hôte : config, containers, tâches, miroir d'équipe (DX 5, partie 1b)`.
- Capabilities, a closed list: `repo`, `publish`, `read-team`, `assign`, `ask-human`, `tickets`, `services`. `talkTo` and `strict` are their own role fields. In this part, `repo`, `publish` and `read-team` act; the others are parsed and stored for parts 2 and 3.
- Container names: `agent-pilot`; `agent-<team>-<role>` for a role without `count`; `agent-<team>-<role>-<n>` (n from 1) for a role with `count`. Team names `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, role names `^[a-z][a-z0-9]*$`, whole name at most 63 characters; every name passes `validateContainerName` (`cli/lib/validate.ts:38`).
- Incus config keys on a member: `user.forge.team`, `user.forge.role`, `user.forge.repo` (members with `repo`), `user.forge.task` (absent = free; the task name, or `-` for a task without a branch), `user.forge.assigned_by` (a container name or `human`), `user.forge.base.<task>` (the existing `baseKey`, on the owner only).
- Paths on the host: the team's origin mirror `mirrorPath("team-<team>")`; the team mirror `<mirrorsDir()>/team-<team>.agents.git`; each member's workspace `workspacesDir()/<container>`. In a container: `/forge/origin.git` (read-only), `/forge/team.git` (read-only, `read-team` only), `/workspace`, git remote `team` pointing at `/forge/team.git`.
- Agent text (an assignment's instruction) goes into the container as a file, `/home/aiuser/.forge/instruction.md` (uid 1001, mode 600, through `pushText`), never in an argv on the host. No agent text is ever interpolated into a `su -c` line.
- The host's git never runs inside an agent's repository: the team mirror is filled with `upload-pack` run in the container (`incus.ts:339`), with `core.hooksPath=/dev/null` on the host side.
- No runtime dependency. Lean tests: the assignment rules, the mirror's ownership rule and the argv shapes get tests; nothing tests documentation.
- Docs and plan in English; `container/CLAUDE.team.md` in French. Commits: conventional prefix, French message.

## Review Focus

1. **Two developers, one task name.** `assign web-dev-2 fix-login` while `web-dev-1` owns `agent/fix-login` must be refused, and the mirror refresh must never take `agent/fix-login` from `web-dev-2` (Tasks 4 and 5).
2. **A Lead that has finished its turn but not its ticket.** hc says `done`, yet `user.forge.task` is set: `assign` to it is refused until someone `release`s it (Task 4).
3. **A dirty developer clone.** Uncommitted changes in `/workspace` make `assign` refuse, naming the files' count, instead of switching branches under the agent's feet (Task 4).
4. **A container stopped or missing when the human assigns.** `assign` starts a stopped member (`ensureRunning`) and refuses a member the config does not declare, with the list of declared ones (Tasks 4 and 6).
5. **The config changes between two converges** (a `count` lowered, a role removed). `converge` reports the members the config no longer declares and leaves them alone: it never deletes a container (Task 6).

---

### Task 1: Teams in the config

**Files:**
- Create: `cli/lib/team-config.ts`
- Modify: `cli/lib/config.ts:9-15` (type and default), `:60` (known keys), `parseConfig`
- Test: `tests/team-config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const CAPABILITIES = ["repo","publish","read-team","assign","ask-human","tickets","services"] as const;
  export type Capability = (typeof CAPABILITIES)[number];
  export type RoleConfig = { count: number | null; capabilities: Capability[]; talkTo: string[]; strict: boolean; memory: string | null; cpu: number | null; plugins: string[] };
  export type TeamConfig = { repo: string; roles: Record<string, RoleConfig>; prompts: string | null; gitIdentity: { name: string; email: string } | null };
  export type PilotConfig = { capabilities: Capability[]; talkTo: string[]; strict: boolean; memory: string | null; plugins: string[]; prompt: string | null };
  export function parseTeams(path: string, raw: unknown): Record<string, TeamConfig>;
  export function parsePilot(path: string, raw: unknown): PilotConfig | null;
  ```
  `ForgeConfig` gains `teams: Record<string, TeamConfig>` (default `{}`) and `pilot: PilotConfig | null` (default `null`).

- [ ] **Step 1: Write the failing tests** (`tests/team-config.test.ts`, with the `rejects(raw, /pattern/)` style of `tests/config.test.ts`)
  - a team `web` with `repo: "o/web"`, roles `lead` (no count) and `dev` (`count: 3`, `memory: "8GiB"`) parses; missing optional fields take `null`, `[]` or `false`.
  - rejected, each with a message starting `<path>: teams.web…`: an unknown capability `"push"`; `count: 0`; a role name `"Dev"`; a team name `"Web"`; `repo: "web"` (not `owner/repo`, through `validateRepo`); an unknown role key; `talkTo` naming a role the team does not have (allowed words: the team's role names, `team`, `pilot`); a `pilot.talkTo` entry that is not a team name.
- [ ] **Step 2: Run them to verify they fail**
  Run: `node --test tests/team-config.test.ts`
  Expected: FAIL.
- [ ] **Step 3: Implement** `parseTeams` and `parsePilot` with the `fields()`/`invalid()` helpers of `config.ts:42-58` (export them, or pass them in), and wire both keys into `parseConfig`. `memory` uses the `SIZE` regex (`config.ts:18`).
- [ ] **Step 4: Run the tests**
  Run: `node --test tests/team-config.test.ts tests/config.test.ts`
  Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add cli/lib/team-config.ts cli/lib/config.ts tests/team-config.test.ts
  git commit -m "feat: les équipes et le Pilote dans la config de forge"
  ```

### Task 2: Members, names and the `talkTo` lists

**Files:**
- Create: `cli/lib/team.ts`
- Test: `tests/team.test.ts`

**Interfaces:**
- Consumes: `TeamConfig`, `PilotConfig` (Task 1).
- Produces:
  ```ts
  export type Member = { name: string; team: string | null; role: string; index: number | null; repo: string | null;
    capabilities: Capability[]; talkTo: string[]; strict: boolean; memory: string | null; cpu: number | null; plugins: string[]; prompt: string | null };
  export function members(cfg: ForgeConfig): Member[];            // pilot first, then teams in key order, roles in key order
  export function memberNamed(cfg: ForgeConfig, name: string): Member; // ForgeError listing the declared names
  export const PILOT = "agent-pilot";
  ```
  `talkTo` holds container names: a role name means every container of that role in the same team; `team` means every other member of the team; `pilot` means `agent-pilot`; for the Pilot, a team name means that team's `lead` containers. `prompt` is `<prompts>/<role>.md` when the team sets `prompts`, else `null`.

- [ ] **Step 1: Write the failing tests**
  - `members()` of a config with a pilot (`talkTo: ["web"]`) and team `web` (`lead`, `dev` count 2, `reviewer`) returns the names `agent-pilot, agent-web-lead, agent-web-dev-1, agent-web-dev-2, agent-web-reviewer`.
  - the lead with `talkTo: ["pilot","team"]` resolves to `[agent-pilot, agent-web-dev-1, agent-web-dev-2, agent-web-reviewer]`; a dev with `talkTo: ["lead"]` to `[agent-web-lead]`; the pilot to `[agent-web-lead]`.
  - a team name long enough to make a name over 63 characters is refused, naming the member.
  - `memberNamed(cfg, "agent-web-dev-9")` throws with the list of declared names.
- [ ] **Step 2: Run them to verify they fail**
  Run: `node --test tests/team.test.ts`
  Expected: FAIL.
- [ ] **Step 3: Implement** `cli/lib/team.ts` as specified (pure functions, no I/O).
- [ ] **Step 4: Run the tests**
  Run: `node --test tests/team.test.ts`
  Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add cli/lib/team.ts tests/team.test.ts
  git commit -m "feat: les membres d'une équipe, leurs noms et à qui ils parlent"
  ```

### Task 3: Provision a member

**Files:**
- Create: `cli/lib/team-provision.ts`, `container/CLAUDE.team.md`
- Modify: `cli/lib/commands/provision.ts` (export `hostGitIdentity` `:217`, `requireRuntime` `:233`, `requireHookBlocks` `:252`, `pushFile` `:280`, `refreshClaude` `:289`, and the token push of part 1a as `pushClaudeToken(ctx, container)`); `container/forge-agent` (`--instruction-file`)
- Modify: `cli/lib/mirror.ts` (a `teamMirrorPath(team)` and `ensureTeamMirror(ctx, team)`)
- Test: `tests/team-provision.test.ts`, `tests/test-forge-agent.sh`

**Interfaces:**
- Consumes: `Member` (Task 2); `ensureMirror` (`mirror.ts:63`); `strictLaunchArgs`, `requireStrictRuntime`, `applyStrictSettings` (`strict.ts:74, 86, 109`); `pushText` (`incus.ts:278`).
- Produces:
  ```ts
  export function teamMirrorPath(team: string): string;                 // <mirrorsDir>/team-<team>.agents.git
  export async function ensureTeamMirror(ctx: Context, team: string): Promise<"created"|"kept">;
  export async function provisionMember(ctx: Context, cfg: ForgeConfig, m: Member): Promise<void>;
  ```
  `forge-agent` accepts `--instruction-file <path>`: when given and the file is non-empty, its content is passed to `claude` as the last argument (the first prompt).

- [ ] **Step 1: Write the failing tests** (`tests/team-provision.test.ts`, through `FakeIncus.withRuntime` and `fakeContext` as in `tests/provision.test.ts:44-48`)
  - a `dev` member: `launch` carries `--profile agent-forge`, `-c user.forge.team=web`, `-c user.forge.role=dev`, `-c user.forge.repo=o/web`, `-c limits.memory=8GiB`; devices `origin` (`source=mirrorPath("team-web")`, `readonly=true`) and `workspace`; **no** `team` device; the clone runs in the container after both devices.
  - a `reviewer` member with `read-team`: a `team` device `{source: teamMirrorPath("web"), path: "/forge/team.git", readonly: "true"}`, and a call running `git -C /workspace remote add team /forge/team.git` as the agent.
  - the pilot (no `repo`): no `origin` device, no clone, a `workspace` device, no `user.forge.repo`.
  - pushed files: the token (part 1a path), `/home/aiuser/.claude/CLAUDE.md` whose content is `container/CLAUDE.team.md` followed by the role prompt file's content when `prompt` is set, `/home/aiuser/.claude/settings.json` equal to `container/settings.json` plus `enabledPlugins` built from `plugins` (absent when empty), `pre-bash.sh`, `forge-agent`, `claude.json`.
  - a team `gitIdentity` sets the clone's `user.name`/`user.email`; without one, the host's (`hostGitIdentity`).
  - `tests/test-forge-agent.sh`: `--instruction-file <f>` containing `Fais X` makes the fake claude print `…|--permission-mode auto Fais X`; an empty file passes nothing.
- [ ] **Step 2: Run them to verify they fail**
  Run: `node --test tests/team-provision.test.ts; bash tests/test-forge-agent.sh`
  Expected: FAIL.
- [ ] **Step 3: Implement**
  `provisionMember` follows `provisionContainer` (`provision.ts:60-212`) step for step, minus what is per-repository-task (no `.trees/` exclude, no worktree), plus: the team origin mirror (`ensureMirror(ctx, mirrorPath("team-<team>"), repo)`, run with the human's forwarded agent like today), `ensureTeamMirror` (`git init --bare`, then `git config core.hooksPath /dev/null` and `fetch.fsckObjects true` in it) for teams with a `publish` member, the `team` device and remote for `read-team`, the per-member `limits.*` and `user.forge.*` keys at launch, strict mode when `strict`, the role's plugins installed like Superpowers was before part 1a (`claude plugin marketplace add`, `claude plugin install`) only when `plugins` is non-empty. Write `container/CLAUDE.team.md` (French): one task per container, working directory `/workspace`, the branch is set by forge and never changed by the agent, refresh by `git fetch origin` then `git rebase origin/main`, teammates' branches through `git fetch team` when that remote exists, no credential (so no `git push`, no `gh`), and the Docker, browser, strict-mode and scope sections of `container/CLAUDE.md` unchanged.
- [ ] **Step 4: Run the tests**
  Run: `npm test`
  Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add cli/lib/team-provision.ts cli/lib/commands/provision.ts cli/lib/mirror.ts container/ tests/
  git commit -m "feat: provisionner un membre d'équipe selon ses capacités"
  ```

### Task 4: Sessions in a container's hc, and the busy/free state

**Files:**
- Create: `cli/lib/hc-session.ts`, `cli/lib/tasks.ts`
- Test: `tests/hc-session.test.ts`, `tests/tasks.test.ts`

**Interfaces:**
- Consumes: `Member`, `memberNamed` (Task 2); `configGet`, `configSet`, `configUnset`, `execAsAgentArgv`, `pushText` (`incus.ts`); `ensureRunning` (`session.ts:36`); `egressBeforeStart`, `egressAfterStart` (`strict.ts:172, 199`); `validateTaskName` (`validate.ts:16`); `baseKey` (`containers.ts:26`).
- Produces:
  ```ts
  // hc-session.ts
  export const SESSION = "agent";                                    // the hc terminal name in every container
  export function hcArgv(container: string, args: string[]): string[]; // incus --project <p> exec <c> --user 1001 --group 1001 --cwd /workspace
                                                                       //   --env HOME=/home/aiuser --env XDG_RUNTIME_DIR=/run/user/1001
                                                                       //   --env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus -- hc ...args
  export type SessionState = "none" | "idle" | "working" | "done" | "unknown";
  export async function sessionState(ctx: Context, container: string): Promise<SessionState>;   // from `hc get agent` JSON
  export async function startSession(ctx: Context, m: Member, task: string, instruction: string): Promise<void>;
  // tasks.ts
  export type Busy = { task: string; assignedBy: string } | null;
  export async function busyState(ctx: Context, container: string): Promise<Busy>;
  export async function owner(ctx: Context, cfg: ForgeConfig, team: string, task: string): Promise<string | null>;
  export async function assign(ctx: Context, cfg: ForgeConfig, req: { to: string; task: string | null; text: string; by: string }): Promise<void>;
  export async function release(ctx: Context, cfg: ForgeConfig, req: { to: string; by: string }): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests**
  - `hcArgv("agent-web-dev-1", ["get","agent"])` equals the argv above with `--project agent-forge`.
  - `startSession`: in order, `hc kill agent` and `hc rm agent` (their failure is ignored), the instruction pushed to `/home/aiuser/.forge/instruction.md` (uid 1001, mode 600), then `hc run --bg --name agent --cwd /workspace forge-agent --forge-task agent-web-dev-1-fix-login --permission-mode auto --instruction-file /home/aiuser/.forge/instruction.md`; **no call's argv contains the instruction text**.
  - `sessionState` maps `hc get` outputs `{"status":{"app":"claude-code","state":"working"}}` to `working`, a non-zero exit to `none`, unparsable output to `unknown`.
  - `assign` (fake incus with the member containers and their config keys):
    - to a free dev with a new task `fix-login`: runs `git -C /workspace status --porcelain` (empty), `git -C /workspace fetch origin`, `git -C /workspace switch -c agent/fix-login origin/main`; sets `user.forge.base.fix-login=origin/main`, `user.forge.task=fix-login`, `user.forge.assigned_by=human`; then starts a session.
    - to the owner of an existing `agent/fix-login`: `git -C /workspace switch agent/fix-login`, base unchanged.
    - refused, with no state change and no session: target busy (message names the task and `assigned_by`); task owned by another member of the team (names it); a dev without a task; a task given to a member without `publish`; a dirty clone (`status --porcelain` non-empty); an invalid task name; a name the config does not declare.
    - to a reviewer (no `publish`) with no task: `user.forge.task=-`, no git call.
  - `release`: by `human` or by the recorded `assigned_by` unsets both keys; by anyone else is refused; releasing a free member is refused.
- [ ] **Step 2: Run them to verify they fail**
  Run: `node --test tests/hc-session.test.ts tests/tasks.test.ts`
  Expected: FAIL.
- [ ] **Step 3: Implement** as specified. Every git call is an `execAsAgentArgv` argv. `startSession` calls `egressBeforeStart`/`egressAfterStart` around the session start, so strict settings are applied as `attachTask` does today (`session.ts:57`). The `--forge-task` value is `<container>-<task>`, or `<container>-session` for a task without a branch.
- [ ] **Step 4: Run the tests**
  Run: `node --test tests/hc-session.test.ts tests/tasks.test.ts`
  Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add cli/lib/hc-session.ts cli/lib/tasks.ts tests/hc-session.test.ts tests/tasks.test.ts
  git commit -m "feat: confier et libérer une tâche, une session neuve dans le hc du container"
  ```

### Task 5: The team mirror

**Files:**
- Create: `cli/lib/team-mirror.ts`
- Test: `tests/team-mirror.test.ts`, `tests/contract/team-mirror.test.ts`

**Interfaces:**
- Consumes: `teamMirrorPath` (Task 3), `owner`/the base keys (Task 4), `members` (Task 2), `forgeCommand()` (`paths.ts:12`).
- Produces: `export async function refreshTeamMirror(ctx: Context, cfg: ForgeConfig, team: string): Promise<{ fetched: string[]; failed: string[] }>`. For each member with `publish`, the refspecs are exactly `+refs/heads/agent/<t>:refs/heads/agent/<t>` for the tasks it owns (its `user.forge.base.*` keys); the fetch runs on the host as `git --git-dir=<team mirror> -c core.hooksPath=/dev/null -c remote.src.url=<an empty temp dir> -c "remote.src.uploadpack=FORGE_SIDE=host <forge> upload-pack <container>" fetch --no-tags src <refspecs>`, the pattern of `tests/integration/incus.test.ts:381-387`. A member that fails is reported in `failed` and does not stop the others.

- [ ] **Step 1: Write the failing tests**
  - unit: with `agent-web-dev-1` owning `fix-login` and `agent-web-dev-2` owning `export-csv`, the two fetch calls carry exactly one refspec each, for their own task; `assertNoHostGitIn(ctx.calls, workspacesDir())` holds (`tests/lib/host-git.ts:6`).
  - contract (real git, no Incus; `tests/lib/git-layout.ts`): a "container" repo that also has `agent/other` and a planted hook; after a refresh owning only `fix-login`, the team mirror has `refs/heads/agent/fix-login` and not `agent/other`, and the hook did not run; a rebased `fix-login` replaces the old one (forced update).
- [ ] **Step 2: Run them to verify they fail**
  Run: `node --test tests/team-mirror.test.ts tests/contract/team-mirror.test.ts`
  Expected: FAIL.
- [ ] **Step 3: Implement** `refreshTeamMirror` as specified.
- [ ] **Step 4: Run the tests**
  Run: `npm run test:unit && npm run test:contract`
  Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add cli/lib/team-mirror.ts tests/team-mirror.test.ts tests/contract/team-mirror.test.ts
  git commit -m "feat: le miroir d'équipe ne prend à chaque dev que les branches qu'il possède"
  ```

### Task 6: The host commands `forge team …`

**Files:**
- Create: `cli/lib/commands/team.ts`
- Modify: `cli/forge.ts:30-116` (usage, dispatch), `cli/lib/side.ts:22-24` (`team` is a host command), `cli/lib/commands/completion.ts:33`
- Test: `tests/team-command.test.ts`, `tests/side.test.ts`

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces, on the host:
  - `forge team converge [<team>]`: provisions every declared member that does not exist (pilot first), starts stopped ones, starts the Pilot's session when it has none, refreshes the team mirror, then prints one line per member (`name role state task`) and one line per `agent-*` container carrying a `user.forge.team` the config no longer declares ("not in the config, left as is").
  - `forge team assign <container> [<task>]`: the instruction is read from stdin (empty refused); `by` is `human`.
  - `forge team release <container>`.
  - `forge team status [--json]`: refreshes the team mirror of each team first (spec §5.5), then per member `{name, team, role, busy: Busy, session: SessionState}`; the text form is a table. A refresh failure is a warning on stderr, never a failure of `status`.
  - `forge team sync <team>`: refreshes the team's origin mirror (`refreshMirror`, `mirror.ts:86`), which needs the forwarded SSH agent, then the team mirror.

- [ ] **Step 1: Write the failing tests**
  - `forge team assign agent-web-dev-1 fix-login` with stdin `Corrige le login` calls `assign` with `{to: "agent-web-dev-1", task: "fix-login", text: "Corrige le login", by: "human"}`; empty stdin is refused before any Incus call.
  - `converge` on a fake Incus where `agent-web-dev-1` exists: only the missing members are launched; a stray `agent-web-dev-9` with `user.forge.team=web` is reported and not deleted.
  - `status --json` prints one JSON array and nothing else on stdout.
  - `tests/side.test.ts`: `team` is refused on the laptop side with the usual message.
- [ ] **Step 2: Run them to verify they fail**
  Run: `node --test tests/team-command.test.ts tests/side.test.ts`
  Expected: FAIL.
- [ ] **Step 3: Implement** the sub-commands. Read stdin the way `cli/lib/relay/serve.ts` reads its request (whole stdin, size capped at 64 KiB, UTF-8).
- [ ] **Step 4: Run the tests**
  Run: `npm test`
  Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add cli/lib/commands/team.ts cli/forge.ts cli/lib/side.ts cli/lib/commands/completion.ts tests/
  git commit -m "feat: forge team converge, assign, release, status et sync sur l'hôte"
  ```

### Task 7: A real team on a real Incus

**Files:**
- Create: `tests/integration/team.test.ts`

- [ ] **Step 1: Write the integration test** (`FORGE_INTEGRATION=1`, helpers of `tests/integration/lib.ts`, a throwaway config with a team of two developers (`dev`, `count: 2`, `publish`) and one `reviewer` (`read-team`) on the sentinel repository, a throwaway token file; the team name starts with a prefix that `teardownProject` cleans, extended if needed)
  - `forge team converge` creates the three members; `forge team assign <dev-1> it-task` with an instruction; `hc get agent` in dev-1 reports a session; a commit made in dev-1's `/workspace` on `agent/it-task` (as the agent, by `incus exec`) appears in the team mirror after `forge team status`; the reviewer runs `git fetch team` and sees `team/agent/it-task`; `forge team assign <dev-2> it-task` is refused because dev-1 owns it; `release` of dev-1 then a second `assign` of `it-task` to dev-1 checks the branch out again.
  - The `hc` checks need a session that can start without a real model call: the instruction is empty, and the test only reads that the terminal exists.
- [ ] **Step 2: Run it on the dev VM**
  Run: `FORGE_INTEGRATION=1 npm run test:integration`
  Expected: PASS. If `hc` cannot reach its core through `incus exec --user` (no session bus), fix `hcArgv`'s environment, or fall back to `su - aiuser -c` with a fixed, validated line, and say which in the pull request.
- [ ] **Step 3: Commit**
  ```bash
  git add tests/integration/team.test.ts
  git commit -m "test: une petite équipe sur un vrai Incus"
  ```
