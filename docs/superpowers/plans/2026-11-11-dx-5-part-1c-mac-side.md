# DX 5, part 1c: the Mac side, and the single-agent flow removed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the Mac, the human builds a team (`forge team up`), sees every agent of it as a machine in Herdr App, assigns and releases tasks, and gets the work back with `forge fetch` and `forge ship` from the team mirror; `forge start`, `attach`, `resume`, `finish`, the herdr tabs, popups and toasts are gone.

**Architecture:** `team` becomes a command on both sides: on the Mac it forwards to the host over SSH (with the agent forwarded for `up` and `sync`), then registers Herdr App machines; on the host it is part 1b's command. Herdr App reaches each container through `forge hc-via` (Mac) and `forge hc-exec` (host), a byte pipe with no secret. The laptop's git exit reads the team mirror through a host `upload-pack` of that mirror, and task bases from the host's task records. The herdr TUI modules that only served the single-agent flow are deleted; `forge open` and the contributor VM keep the TUI (decision 19).

**Tech Stack:** TypeScript on Node 24 (`node --test`), OpenSSH, git, herdr-core `hc` 0.1.20 and Herdr App on macOS.

**Spec:** `docs/superpowers/specs/2026-11-11-dx-5-herdr-core-design.md`, decisions 4, 10, 19 (§3), §5.5 (`forge fetch`), §5.6, §5.7, §5.8 (`container/CLAUDE.md`), §5.11 part 1. Prerequisite: part 1b merged.

## Global Constraints

- Branch `agent/dx5-mac-side`, from `origin/main` after part 1b is merged; one pull request, `Refs #92`. Title: `feat: les équipes depuis le Mac, Herdr App, et la fin de forge start (DX 5, partie 1c)`.
- Kept, untouched in behaviour: `forge open`, `forge cloud start`, the herdr presence check in `cli/lib/laptop/prereqs.ts`, `install.ts:193` (`return cmdOpen(...)`), the contributor launcher, `docs/contributor-model.md`, `cli/forge`'s `FORGE_INVOKED_AS` and `paths.forgeCommand()` (now used for the `--via` command).
- Herdr App machine names: `<host alias>-<container without the agent- prefix>` (for example `forge-local-web-dev-1`); forge owns every machine whose name starts with `<host alias>-` and is not declared by another tool.
- `hc` on the Mac must report exactly `HC_VERSION` (`cli/lib/hc.ts`, part 1a); otherwise forge refuses to add machines and prints the fix. Machines are added without `--install`.
- `forge hc-exec <container> <line>` accepts only containers the host config declares; `<line>` is hc's own shell line from the human's hc client, never agent text.
- The laptop's remote for a team is named `forge-<team>`, its URL `<host alias>:team-<team>`, its `uploadpack` `forge team upload-pack <team>`; agent refs live under `refs/remotes/forge-<team>/agent/*`.
- The plan moves the forge mod for Herdr App (spec §5.6, §5.11 part 1) to part 3: its only part-1 shortcut would be `forge sync`, and its notification needs part 3's Inbox. Telemetry is turned off here.
- No runtime dependency. Lean tests; the doc-content assertions that pin removed features are deleted, not rewritten.
- Docs and plan in English; `CLAUDE.md` and `container/CLAUDE.md` in French. Commits: conventional prefix, French message.

## Review Focus

1. **`forge fetch` in a clone whose repository has no team on the host.** It must say which host it asked and that no team declares `<owner>/<repo>`, not fail inside git (Task 2).
2. **A Mac whose `hc` is not the pinned version.** `forge team up` converges the host but adds no machine, and says how to align the version; a second run after the fix adds them (Task 3).
3. **A machine left from a removed member.** After a `count` goes down and `forge team up` runs again, the extra machine disappears from Herdr App; machines of another host alias are never touched (Task 3).
4. **`forge hc-exec` with a container outside the team**, or an `agent-<owner>-<repo>` single-agent container: refused before any `incus exec` (Task 3).
5. **A host that still has single-agent containers.** `forge list`, `stop`, `delete` and `egress` keep working on them, and their messages no longer send the user to `forge start` (Task 5).

---

### Task 1: The host side of the team's git exit

**Files:**
- Modify: `cli/lib/commands/team.ts` (part 1b)
- Test: `tests/team-command.test.ts`

**Interfaces:**
- Consumes: `refreshTeamMirror`, `teamMirrorPath` (part 1b), `uploadPackArgv`'s pattern (`incus.ts:339`), `safeRef`/`validateGitRef` as in `commands/task-base.ts`.
- Produces, on the host:
  - `forge team for-repo <owner/repo>`: prints the team name whose `repo` matches, nothing and exit 1 otherwise.
  - `forge team task-base <team>`: one `<task>\t<base>` line per task owned in the team, sorted; stdout is read by a machine.
  - `forge team upload-pack <team> [<path>]`: refreshes the team mirror (warnings on stderr only), then `ctx.attach(["git","-c","core.hooksPath=/dev/null","upload-pack",teamMirrorPath(team)])` with `GIT_PROTOCOL` passed through; nothing else on stdout. git appends the path argument; it is ignored, as in `commands/upload-pack.ts`.

- [ ] **Step 1: Write the failing tests**: `for-repo` finds `web` for `o/web`, exits 1 for `o/none`; `task-base` prints `export-csv\torigin/main\nfix-login\torigin/main` sorted from two owners' config keys, and drops a value that is not a safe ref; `upload-pack` writes nothing to stdout before attaching and refuses an undeclared team.
- [ ] **Step 2: Run them to verify they fail.** Run: `node --test tests/team-command.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the three sub-commands.
- [ ] **Step 4: Run the tests.** Run: `node --test tests/team-command.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add cli/lib/commands/team.ts tests/team-command.test.ts
  git commit -m "feat: le miroir d'équipe se lit depuis le Mac, avec les bases des tâches"
  ```

### Task 2: `forge fetch` and `forge ship` on the team mirror

**Files:**
- Modify: `cli/lib/laptop/clone.ts:15-80` (`openClone`, `forgeRemoteHost`, `ensureForgeRemote`), `cli/lib/commands/fetch.ts`, `cli/lib/commands/ship.ts`, `cli/lib/laptop/ship-plan.ts:51-56` (`agentRef`, `limitRef`)
- Test: `tests/fetch.test.ts`, `tests/ship.test.ts`, `tests/laptop-clone.test.ts`, `tests/lib/git-layout.ts`

**Interfaces:**
- Produces: `Fetched` becomes `{ root, ownerRepo, team: string, remote: string, host: LaptopHost, bases: Map<string,string> }` (`remote` = `forge-<team>`); `agentRef(remote, task)` and `limitRef(remote, base)` take the remote name; `ensureForgeRemote(ctx, root, team, alias)` writes the url and uploadpack of the Global Constraints.

- [ ] **Step 1: Update the tests first**: `tests/lib/git-layout.ts`'s fake `core.sshCommand` answers `forge team upload-pack <team>` with `git upload-pack <team mirror dir>` and `forge team for-repo o/r` with the team name; `fetch.test.ts`'s `taskBase` rule (`:34`) becomes `forge team task-base <team>`. New cases: a clone with no team on the host fails with a message naming the host and `<owner>/<repo>`; an old `agent-<owner>-<repo>` remote in the clone is left in place and reported once ("single-agent remote, no longer fetched").
- [ ] **Step 2: Run them to verify they fail.** Run: `node --test tests/fetch.test.ts tests/ship.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**: `openClone` no longer derives a container; `fetchAgents` asks the host `forge team for-repo`, ensures the `forge-<team>` remote, fetches it, then reads `forge team task-base <team>`; `cmdShip` and `ship-plan` use the remote name. `resolveBase` (`ship-plan.ts:20`) is unchanged.
- [ ] **Step 4: Run the tests.** Run: `npm run test:unit`. Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add cli/lib/laptop/ cli/lib/commands/fetch.ts cli/lib/commands/ship.ts tests/
  git commit -m "feat: forge fetch et forge ship lisent le miroir d'équipe"
  ```

### Task 3: Herdr App machines: the transport, the version check, the sync

**Files:**
- Modify: `cli/lib/hc.ts` (part 1a)
- Create: `cli/lib/laptop/machines.ts`, `cli/lib/commands/hc-via.ts` (laptop), `cli/lib/commands/hc-exec.ts` (host)
- Modify: `cli/forge.ts` (dispatch), `cli/lib/side.ts` (`hc-via` laptop, `hc-exec` host)
- Test: `tests/hc.test.ts`, `tests/machines.test.ts`, `tests/hc-transport.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function checkLocalHc(ctx: Context): Promise<void>;        // `hc --version` must contain HC_VERSION; ForgeError with the fix otherwise
  export function machineName(alias: string, container: string): string;  // "forge-local", "agent-web-dev-1" -> "forge-local-web-dev-1"
  export function viaCommand(alias: string, container: string): string;   // `${shellQuote(forgeCommand())} hc-via ${alias} ${container}`
  export async function syncMachines(ctx: Context, host: LaptopHost, containers: string[]): Promise<{ added: string[]; removed: string[] }>;
  ```
  `forge hc-via <alias> <container> <line>` (laptop) = `ctx.attach(["ssh","-T","-o","BatchMode=yes",alias,"--",remoteCommand(["forge","hc-exec",container,line])])`; `forge hc-exec <container> <line>` (host) = `ctx.attach(incus("exec","-T",container,"--","su","-","aiuser","-c",line))` after `memberNamed(cfg, container)`.

- [ ] **Step 1: Write the failing tests**
  - `checkLocalHc`: `hc --version` printing `hc 0.1.20` passes; `0.1.21` and a missing `hc` fail with a message naming `HC_VERSION` and how to install it.
  - `syncMachines`: given `hc machine ls --json` listing `forge-local-web-dev-1`, `forge-local-web-dev-9` and `other-x`, and declared containers `agent-web-lead`, `agent-web-dev-1`: one `hc machine add --name forge-local-web-lead --via '<forge> hc-via forge-local agent-web-lead'` (no `--install`), one `hc machine rm forge-local-web-dev-9`, nothing for `other-x`. Check the real `hc machine ls` output format against `hc --skill` before fixing the parser's expectations.
  - transport: `hc-via` builds the ssh argv above with the line as one quoted word; `hc-exec` refuses `agent-o-r` (not declared) and `agent-web-dev-1;id` before any `incus` call.
- [ ] **Step 2: Run them to verify they fail.** Run: `node --test tests/hc.test.ts tests/machines.test.ts tests/hc-transport.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run the tests.** Run: `npm run test:unit`. Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add cli/lib/hc.ts cli/lib/laptop/machines.ts cli/lib/commands/hc-via.ts cli/lib/commands/hc-exec.ts cli/forge.ts cli/lib/side.ts tests/
  git commit -m "feat: une machine Herdr App par container de l'équipe"
  ```

### Task 4: `forge team` on the Mac, and Herdr App's telemetry

**Files:**
- Modify: `cli/lib/commands/team.ts`, `cli/lib/side.ts:20-28` (`team` runs on both sides, like `completion`), `cli/lib/laptop/remote.ts` (a variant of `remoteAttach` that forwards the agent)
- Modify: `cli/lib/commands/install.ts` (a `herdr-app` step that sets Herdr App's telemetry off)
- Test: `tests/team-command.test.ts`, `tests/install.test.ts`, `tests/side.test.ts`

**Interfaces:**
- Produces, on the Mac:
  - `forge team up [<team>] [--host <alias>]`: `checkLocalHc` first (a mismatch converges nothing and stops), then `ssh -A <alias> forge team converge [<team>]` attached, then `forge team status --json` over `remoteExec`, then `syncMachines` with every declared container.
  - `forge team assign <container> [<task>]` (stdin forwarded as `input`), `forge team release <container>`, `forge team status [--json]`: `remoteExec` of the same host command.
  - `forge team sync <team>`: attached `ssh -A` of the host command.
  - `export function remoteAttachForwarding(ctx, host, argv): Promise<number>`: like `remoteAttach` but with `-A` instead of `ForwardAgent=no`; refused for a `cloud` host.

- [ ] **Step 1: Write the failing tests**: on the laptop side, `forge team assign agent-web-dev-1 fix-login` with stdin `X` runs `ssh … forge team assign agent-web-dev-1 fix-login` with `input: "X"` and no `-A`; `forge team up` runs `ssh -A` then `syncMachines`; a cloud host refuses `remoteAttachForwarding`; `install` writes Herdr App's settings with telemetry off and keeps the user's other settings (look up the settings file's path and key in Herdr App's documentation first; record them in a comment with the version they were read for).
- [ ] **Step 2: Run them to verify they fail.** Run: `node --test tests/team-command.test.ts tests/install.test.ts tests/side.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run the tests.** Run: `npm run test:unit`. Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add cli/lib/commands/team.ts cli/lib/side.ts cli/lib/laptop/remote.ts cli/lib/commands/install.ts tests/
  git commit -m "feat: forge team depuis le Mac, et la télémétrie de Herdr App coupée"
  ```

### Task 5: Remove the single-agent flow and the TUI modules it used

**Files:**
- Delete: `cli/lib/herdr.ts`, `cli/lib/tabs.ts`, `cli/lib/popup.ts`, `cli/lib/herdr-config.ts`, `cli/lib/commands/start.ts`, `cli/lib/commands/attach.ts`, `cli/lib/commands/resume.ts`, `cli/lib/commands/finish.ts`, and their tests (`tests/herdr.test.ts`, `tests/tabs.test.ts`, `tests/popup.test.ts`, `tests/herdr-config.test.ts`, `tests/start.test.ts`, `tests/attach.test.ts`, `tests/resume-finish.test.ts`, the herdr-config cases of `tests/contract/herdr.test.ts`, the herdr part of `tests/egress-attach.test.ts`)
- Modify: `cli/forge.ts` (imports `:5-6,10-11,18`, usage `:35-37,47`, dispatch `:96-98,103`, `--all` and `--strict` guards, `attachInHerdrPane` `:128-133`, popup and toast handling `:173-210`, `collectNotices` `:137`); `cli/lib/session.ts` (remove `attachTask`, `hasConversation`); `cli/lib/agent.ts` (remove `herdrLabel` and `command`; keep `marker`); `cli/lib/incus.ts` (remove `attachArgv` `:142-155`); `cli/lib/context.ts` (remove `notify`); `cli/lib/paths.ts` (remove `herdrConfigPath`); `cli/lib/commands/setup.ts:11,144-145` (no herdr block); `cli/lib/commands/install.ts` (remove `herdrToasts` `:655-689`, its imports and summary line); `cli/lib/commands/provision.ts` (remove what only `forge start` used: `provisionContainer` and its worktree steps; keep the helpers part 1b exported); `cli/lib/side.ts:39-42`, `cli/lib/commands/completion.ts:25,33,38-49`; the "run `forge start`" messages in `containers.ts:73`, `resolve.ts:22,48`, `delete.ts:56,66,70-71`, `egress.ts:7,166`, `task-base.ts:4`
- Replace: `container/CLAUDE.md` by the content of `container/CLAUDE.team.md` (then delete `CLAUDE.team.md` and point part 1b's provisioning at `CLAUDE.md`)
- Modify: `tests/e2e.test.ts` (remove the fake herdr scripts and the popup, toast, pane, start, resume and `--strict` cases), `tests/side.test.ts`, `tests/completion.test.ts`, `tests/session.test.ts`, `tests/incus.test.ts`, `tests/install.test.ts` (the `TOASTS()` question and its asserts), `tests/cloud.test.ts` (toast answers), `tests/setup.test.ts` (the herdr config line), `tests/shell.test.ts:13-15`, `tests/test-readme-docs.sh:50-60,85,107,118-148` and `tests/test-ansible-readme-docs.sh:58-62` (delete the assertions on removed text), `tests/integration/incus.test.ts:38-42,80-86`

- [ ] **Step 1: Delete and edit** as listed. `strict.ts`'s `egressAfterStart` keeps its caller in part 1b's `startSession`. Hosts already set up keep forge's old block in their herdr config: `forge setup` removes it once if present (the block's markers are in `herdr-config.ts:16-21`; keep a three-line removal in `setup.ts`, with a comment saying it can go after a release).
- [ ] **Step 2: Typecheck and run everything.** Run: `npm run check && npm test`. Expected: no type error, PASS. Then `grep -rnE "herdr\.(ts|js)|tabs\.ts|popup\.ts|herdr-config|attachTask|forge start" cli/ tests/` returns nothing but `open.ts`, `prereqs.ts`, the setup cleanup, and test names of kept features.
- [ ] **Step 3: Commit**
  ```bash
  git add -A cli/ container/ tests/
  git commit -m "feat: fin de forge start, attach, resume et finish, et des onglets herdr"
  ```

### Task 6: Docs

**Files:**
- Modify: `README.md` (intro `1-27`, install steps `78-153`, "What forge install changes" `155-203`, "Start a task from herdr" `228-258` (keep `forge open` at `230-239`), "Get the work back" `260-310`, "The local VM day to day" `312-319`, "Daily use" `358-402`, "Rules for getting work back" `404-424`, "Strict egress mode" `426-452`, security model `510-534`, troubleshooting `536-573`); `ansible/README.md:190-195`; `CLAUDE.md:12,66-67,83-86`

- [ ] **Step 1: Rewrite the user path**: Herdr App and `hc` on the Mac (pinned version), a team in `~/.config/agent-forge/config.json` on the host (one example: a pilot, a lead, two devs, a reviewer), `forge team up`, Herdr App's machines, `forge team assign` / `release` / `status`, `forge sync`, `forge fetch`, `forge ship`; `forge open` stays documented for the TUI until DX 5 is done; remove the keys table, the toasts and the `forge start` sections; the strict mode is per role (`strict: true`). `CLAUDE.md`: the stack line on orchestration names herdr-core and teams; the herdr keybinding and tabs lines go.
- [ ] **Step 2: Check.** Run: `grep -nE "prefix\+f|forge start|forge attach|forge resume|toast" README.md ansible/README.md CLAUDE.md`. Expected: nothing, or only a line saying these commands are gone.
- [ ] **Step 3: Commit**
  ```bash
  git add README.md ansible/README.md CLAUDE.md
  git commit -m "docs: les équipes depuis le Mac remplacent forge start"
  ```

### Task 7: Acceptance on a real host and the maintainer's Mac

- [ ] **Step 1 (dev VM):** `FORGE_INTEGRATION=1 npm run test:integration` and `ansible/tests/vm-test.sh --lima`. Expected: PASS.
- [ ] **Step 2 (the maintainer, on the Mac; write the runbook in the pull request):** `forge install` (one touch, then no touch for the next commands); a team of a pilot, a lead, two devs and a reviewer in the host config; `forge team up`; Herdr App shows five machines named after the containers and opens a terminal in each; `forge team assign <dev-1> <task>` with a small instruction; the agent works and commits; `forge fetch` in a clone lists the task; `forge ship <task>` opens the pull request; `forge open` still opens the herdr TUI.
