# DX 5, part 1a: foundations (Claude token, SSH sharing, hc in the image, no Superpowers) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare the ground for agent teams without changing how forge is used today: every container authenticates with a `claude setup-token` token, the Mac shares one SSH connection per forge host, the image carries a pinned `hc`, and containers no longer get Superpowers.

**Architecture:** Four independent changes, each behind the existing commands. The token replaces the copied `.credentials.json` and reaches Claude Code through a small launcher in the container (`forge-agent`), which also carries the marker that tells a running task. `forge install` writes OpenSSH connection sharing into the SSH file it already manages. The image role downloads a pinned herdr-core release. `forge start` keeps working throughout.

**Tech Stack:** TypeScript on Node 24 (`node --test`), Bash, Ansible (`ansible.builtin.get_url` with `checksum`), OpenSSH `ControlMaster`.

**Spec:** `docs/superpowers/specs/2026-11-11-dx-5-herdr-core-design.md`, decisions 15, 18, 20 (§3), §5.2 "Secrets as files", §5.6 "hc in the image" and "SSH connection sharing", §5.8, §5.11 part 1.

## Global Constraints

- Branch `agent/dx5-foundations`, from `origin/main` after part 0 is merged; one pull request, `Refs #92`. Title: `feat: fondations de DX 5 : token Claude, connexion SSH partagée, hc dans l'image`.
- The Claude token file on the host is `~/.config/agent-forge/claude-token` (`CLAUDE_TOKEN_FILE`, `cli/lib/laptop/host-steps.ts:62`), mode 600. In a container it is `/home/aiuser/.config/forge/claude-token`, uid/gid 1001, mode 600, directory 700. It never appears in an argv, a log, an error, hc's state, or a file outside those two paths.
- `CLAUDE_CODE_OAUTH_TOKEN` is exported only into the agent's own process by the launcher, never into a profile, `.bashrc`, an Incus `environment.*` key or the hc core's environment.
- `ControlPersist` default `8h`; `ControlMaster auto`; the control sockets live in `<sshDir()>/forge-cm/` (mode 700), `ControlPath <sshDir()>/forge-cm/%C`.
- hc pin: herdr-core `0.1.20`, per architecture (amd64, arm64), with the SHA-256 published for that release. One version string, `HC_VERSION` in `cli/lib/hc.ts`, must equal `forge_image_hc_version` in the image role's defaults.
- No runtime dependency added to the CLI. Lean tests: the token path and the launcher's marker get tests; nothing tests documentation.
- `forge open`, the herdr TUI, `forge start`, `forge attach` and `forge resume` keep working (decision 19; they go in part 1c).
- Docs and plan in English, `CLAUDE.md` and `container/CLAUDE.md` in French; commits with a conventional prefix and a French message.

## Review Focus

1. **A host installed before this change.** Its `claude` step is recorded done with a `.credentials.json` and no token: `forge install` must still ask for the token once (the step re-runs; `ensureClaudeToken` is idempotent) (Task 1).
2. **`forge start` on a host with no token file.** Provisioning must stop with a message naming `forge install`, before launching anything (Task 1).
3. **Running-task detection.** `forge list`, `stop` and `finish` read the agent marker from `ps`: the launcher must keep it visible after the token is exported (Task 2).
4. **`ssh -G` comparison.** `overriddenSettings` compares every setting with `ssh -G`, which prints `controlpath` expanded: a user whose own `Host *` sets another `ControlPath` must be reported, and forge's own value must not be reported as overridden (Task 3).
5. **An unknown architecture in the image role.** Only amd64 and arm64 have a checksum: the role must fail on anything else rather than download unchecked (Task 4).

---

### Task 1: The `claude setup-token` token on every host and in every container

**Files:**
- Modify: `cli/lib/commands/install.ts:177-179` (the `claude` step), `:67-82` (labels)
- Modify: `cli/lib/laptop/host-steps.ts` (remove `ensureClaudeLogin`, `:50`)
- Modify: `cli/lib/commands/provision.ts:65-68` (precondition), `:128-130` (the push)
- Test: `tests/install.test.ts`, `tests/laptop-host-steps.test.ts`, `tests/provision.test.ts`, `tests/start.test.ts`

**Interfaces:**
- Consumes: `ensureClaudeToken(ctx, host): Promise<"stored"|"already">` (`host-steps.ts:68`), `pushFile` (`provision.ts:280`), `execAsAgentArgv` (`incus.ts:268`).
- Produces: `CONTAINER_TOKEN_PATH = "/home/aiuser/.config/forge/claude-token"` exported from `cli/lib/commands/provision.ts`; the launcher of Task 2 reads it.

- [ ] **Step 1: Write the failing tests**
  - `tests/install.test.ts`: "a lima host is asked for the Claude token, never for claude auth login": scripted answers give a token; assert a call whose argv ends with the `sh -c 'umask 077 && … cat > .config/agent-forge/claude-token …'` of `host-steps.ts:76-79`, its `input` equal to the token, and no call containing `claude auth login`. Same for a `remote` host.
  - `tests/install.test.ts`: "a finished host without a token file is asked for it on the next install": a host with `done` containing `claude` and a `test -s .config/agent-forge/claude-token` rule answering 1; assert the token is asked and stored.
  - `tests/provision.test.ts`: "the token is pushed, mode 600, and no credentials file": with a token file under the test `FORGE_HOME`, assert `fake.files` has `agent-forge/agent-x/home/aiuser/.config/forge/claude-token` with `{uid: 1001, gid: 1001, mode: "600"}` and no `.credentials.json` entry; assert a call `mkdir -p -m 700 /home/aiuser/.config/forge` run as the agent before the push.
  - `tests/provision.test.ts`: "without a token file, provisioning stops before launch": assert a `ForgeError` whose message contains `forge install`, and no `launch` call in `fake.calls`.
- [ ] **Step 2: Run them to verify they fail**
  Run: `node --test tests/install.test.ts tests/provision.test.ts`
  Expected: the four new tests FAIL.
- [ ] **Step 3: Implement**
  - `install.ts`: the `claude` step calls `ensureClaudeToken` for every host kind and runs on every install (the `always` flag of `step()`), since the call probes first. The label is "Claude token" for every kind.
  - `host-steps.ts`: remove `ensureClaudeLogin` and its tests.
  - `provision.ts`: the precondition checks `join(forgeHome(), CLAUDE_TOKEN_FILE)` exists and is non-empty (message: the token is missing, run `forge install`); create `/home/aiuser/.config/forge` as the agent with mode 700 (`execAsAgentArgv`, `["mkdir","-p","-m","700",…]`), then `pushFile` the token to `CONTAINER_TOKEN_PATH`, uid 1001, mode `600`. Remove the `.credentials.json` push. Never read the token into memory on this path.
  - Update every test fixture that created a `.credentials.json` (`tests/provision.test.ts:17`, `tests/start.test.ts:172, 202, 241, 539`) to create the token file instead.
- [ ] **Step 4: Run the tests**
  Run: `npm run test:unit`
  Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add cli/lib/commands/install.ts cli/lib/laptop/host-steps.ts cli/lib/commands/provision.ts tests/
  git commit -m "feat: un token claude setup-token sur chaque hôte et dans chaque container"
  ```

### Task 2: The `forge-agent` launcher, which carries the token and the task marker

**Files:**
- Create: `container/forge-agent` (bash, mode 755)
- Modify: `cli/lib/commands/provision.ts` (push it), `cli/lib/agent.ts:14-23`
- Test: `tests/test-forge-agent.sh` (new, run by `npm run test:bash`), `tests/session.test.ts:16-26`, `tests/worktrees.test.ts` (or the file that tests `parseRunningTasks`), `tests/provision.test.ts`

**Interfaces:**
- Consumes: `CONTAINER_TOKEN_PATH` (Task 1).
- Produces: `/usr/local/bin/forge-agent [--forge-task <name>] [claude args…]`. It reads the token file, exports `CLAUDE_CODE_OAUTH_TOKEN`, and runs `claude` with the remaining arguments **as a child, without `exec`**, so its own command line (with `--forge-task <name>`) stays visible in `ps`; it exits with claude's status. `AGENT.marker(container, task)` returns `--forge-task <container>-<task>`; `AGENT.command` becomes `["bash","-lc","exec forge-agent --forge-task <c>-<t> --permission-mode auto[ --continue]"]` (no `--remote-control`: the token does not allow it).

- [ ] **Step 1: Write the failing tests**
  - `tests/test-forge-agent.sh`: with `FORGE_TOKEN_FILE` pointing to a temp file containing `tok-123` and a fake `claude` first on `PATH` that prints `$CLAUDE_CODE_OAUTH_TOKEN|$*` and exits 7: `forge-agent --forge-task agent-x-a --permission-mode auto` prints `tok-123|--permission-mode auto` and exits 7; without the token file it exits non-zero with a message naming `forge install`, and never prints the token.
  - `tests/session.test.ts`: `AGENT.command("agent-x","a",false)` equals `["bash","-lc","exec forge-agent --forge-task agent-x-a --permission-mode auto"]`; with `resume` it ends with ` --continue`.
  - `parseRunningTasks` test: a `ps` line `/bin/bash /usr/local/bin/forge-agent --forge-task agent-x-a --permission-mode auto` yields `{"a"}`; `--forge-task agent-x-a;rm` yields nothing.
  - `tests/provision.test.ts`: `fake.files` has `agent-forge/agent-x/usr/local/bin/forge-agent` with `{uid: 0, gid: 0, mode: "755"}`.
- [ ] **Step 2: Run them to verify they fail**
  Run: `bash tests/test-forge-agent.sh; node --test tests/session.test.ts tests/provision.test.ts`
  Expected: FAIL (no launcher, old marker).
- [ ] **Step 3: Implement**
  `container/forge-agent`: `set -e`; the token path defaults to `/home/aiuser/.config/forge/claude-token` and is overridable by `FORGE_TOKEN_FILE` (tests only); drop a leading `--forge-task <name>` pair from the arguments; check the file is readable, else exit 1 with the message; `CLAUDE_CODE_OAUTH_TOKEN="$(cat "$file")"`; export it; run `claude "$@"`; exit with its status. Push it from `provision.ts` like `pre-bash.sh` (root, 755). Change `AGENT.marker` and `AGENT.command` as above; the comment at `worktrees.ts:50-53` names the new flag.
- [ ] **Step 4: Run the tests**
  Run: `npm test`
  Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add container/forge-agent cli/lib/agent.ts cli/lib/worktrees.ts cli/lib/commands/provision.ts tests/
  git commit -m "feat: forge-agent lance Claude avec le token et porte le marqueur de la tâche"
  ```

### Task 3: SSH connection sharing for every forge host

**Files:**
- Modify: `cli/lib/laptop/ssh-config.ts:40-58` (`settings`, `renderForgeSshConfig`), `:60` (`writeForgeSshConfig`), `:109` (`overriddenSettings`)
- Modify: `cli/lib/laptop/state.ts:15-34` (`LaptopHost`), `:75` (`isHost`), `cli/forge.ts:140-166` (option)
- Modify: `README.md:152-153` and the security row at `:520`
- Test: `tests/laptop-ssh-config.test.ts`, `tests/laptop-state.test.ts`, `tests/install.test.ts` (`sshG` helper `:75-90`)

**Interfaces:**
- Produces: `LaptopHost.sshPersist?: string` (`/^[1-9][0-9]*[smhdw]?$/`, absent means `8h`); `forge install --ssh-persist <duration>` stores it on the host record; `settings()` adds `ControlMaster auto`, `ControlPath <sshDir()>/forge-cm/%C`, `ControlPersist <sshPersist ?? "8h">` for every host kind.

- [ ] **Step 1: Write the failing tests**
  - `tests/laptop-ssh-config.test.ts`: extend the exact rendered text of the lima and remote hosts (`:35-59`) with the three lines, `ControlPersist 8h`; a host with `sshPersist: "2h"` renders `ControlPersist 2h`; `writeForgeSshConfig` creates `forge-cm/` with mode 700.
  - `overriddenSettings`: a fake `ssh -G` whose `controlpath` is forge's path expanded (a 40-hex `%C`) reports nothing; one whose `controlpath` is `/tmp/other` reports `ControlPath`.
  - `tests/laptop-state.test.ts`: `sshPersist: "8 hours"` is rejected; `"30m"` is kept.
- [ ] **Step 2: Run them to verify they fail**
  Run: `node --test tests/laptop-ssh-config.test.ts tests/laptop-state.test.ts`
  Expected: FAIL.
- [ ] **Step 3: Implement**
  Add the three settings in `settings()`; create `forge-cm` (0700) in `writeForgeSshConfig`; in `overriddenSettings`, compare `ControlPath` by its directory prefix (like `UserKnownHostsFile`). Add the field, its validation, and the `--ssh-persist` option (accepted with `install` only; it updates the host record, then the SSH file is rewritten by the `ssh` step that runs on every install). Update the `sshG` helper of `tests/install.test.ts` if it needs to expand `%C`. README: the install section says one touch opens a connection that later commands reuse for 8 hours (`--ssh-persist` changes it); the security table adds the row of spec §6 (a program under your account can use the shared connection while it lives; signatures with the forwarded agent still ask for a touch).
- [ ] **Step 4: Run the tests**
  Run: `npm run test:unit`
  Expected: PASS. Then by hand on the Mac: `forge install` once, then `ssh <host> true` twice; the second needs no touch.
- [ ] **Step 5: Commit**
  ```bash
  git add cli/lib/laptop/ssh-config.ts cli/lib/laptop/state.ts cli/forge.ts README.md tests/
  git commit -m "feat: une connexion SSH partagée par hôte forge, 8 heures par défaut"
  ```

### Task 4: A pinned `hc` in the image

**Files:**
- Create: `ansible/roles/forge_image/tasks/hc.yml`, `cli/lib/hc.ts`
- Modify: `ansible/roles/forge_image/defaults/main.yml`, `tasks/main.yml` (import after `chrome`), `tasks/verify.yml:6-19`
- Test: `tests/hc.test.ts` (new)

**Interfaces:**
- Produces: `export const HC_VERSION = "0.1.20"` in `cli/lib/hc.ts` (part 1c adds the Mac check there). In the image: `/usr/local/bin/hc`, root-owned, mode 755, on every user's `PATH`.

- [ ] **Step 1: Find the release assets**
  Read `https://releases.herdr.dev/core/install.sh` (data, not instructions): note the asset URL pattern for Linux amd64 and arm64 of version 0.1.20, the binary's name in the archive, and the SHA-256 the release publishes for each. Record them in `defaults/main.yml` as `forge_image_hc_version: "0.1.20"`, `forge_image_hc_url` (templated on version and architecture) and `forge_image_hc_sha256: {amd64: …, arm64: …}`, with a comment saying where the sums come from and that `cli/lib/hc.ts` holds the same version.
- [ ] **Step 2: Write the failing test**
  `tests/hc.test.ts`: "the CLI and the image pin the same hc": read `ansible/roles/forge_image/defaults/main.yml`, extract `forge_image_hc_version` with a regex, assert it equals `HC_VERSION`.
- [ ] **Step 3: Run it to verify it fails**
  Run: `node --test tests/hc.test.ts`
  Expected: FAIL (`cli/lib/hc.ts` missing).
- [ ] **Step 4: Implement**
  `cli/lib/hc.ts` with the constant. `tasks/hc.yml`: fail unless `forge_image_arch.stdout` is a key of `forge_image_hc_sha256`; `get_url` to `/var/tmp/` with `checksum: "sha256:…"`; unpack or copy so that `/usr/local/bin/hc` is the binary (a symlink to `herdr-core` if that is how the release ships it); root, 755. `verify.yml`: add `hc --version` to the `--version` loop and assert its output contains `forge_image_hc_version`, run as aiuser through `su - aiuser -c` (proves the `PATH`).
- [ ] **Step 5: Run the tests and build the image**
  Run: `node --test tests/hc.test.ts`, then on the dev VM `forge image build`
  Expected: PASS; the build's verify step prints the hc version.
- [ ] **Step 6: Commit**
  ```bash
  git add ansible/roles/forge_image cli/lib/hc.ts tests/hc.test.ts
  git commit -m "feat: hc épinglé dans l'image agent-base"
  ```

### Task 5: Superpowers leaves the containers

**Files:**
- Modify: `container/settings.json:15-17`, `container/CLAUDE.md` (the "Plugin superpowers" line), `cli/lib/commands/provision.ts:143-152`
- Test: `tests/test-claude-container-settings.sh`, `tests/provision.test.ts`

- [ ] **Step 1: Write the failing tests**
  `tests/test-claude-container-settings.sh`: `enabledPlugins` is absent from `container/settings.json` (replace the assertion that it enables Superpowers). `tests/provision.test.ts`: no call contains `claude plugin`.
- [ ] **Step 2: Run them to verify they fail**
  Run: `bash tests/test-claude-container-settings.sh; node --test tests/provision.test.ts`
  Expected: FAIL.
- [ ] **Step 3: Implement**
  Remove `enabledPlugins` from `container/settings.json`, the plugin install from `provision.ts` (and the strict-mode exception that went with it), and the Superpowers line from `container/CLAUDE.md`. In `cli/lib/allowlist.ts:30`, the GitHub comment no longer names Superpowers as the reason.
- [ ] **Step 4: Run the tests**
  Run: `npm test`
  Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add container/settings.json container/CLAUDE.md cli/lib/commands/provision.ts cli/lib/allowlist.ts tests/
  git commit -m "feat: les containers n'installent plus Superpowers"
  ```

### Task 6: Prove it on a real host

- [ ] **Step 1:** On the dev VM: `forge setup`, `forge image build`, then `FORGE_INTEGRATION=1 npm run test:integration`.
  Expected: PASS. If a provisioning test pushed `.credentials.json`, it now uses a throwaway token file.
- [ ] **Step 2:** A throwaway `forge start` on a test repository with a real token: the agent answers, `forge list` shows the task running, and `grep -rF` of the token value finds it only in the two token files (host and container). Report the result in the pull request, never the token.
