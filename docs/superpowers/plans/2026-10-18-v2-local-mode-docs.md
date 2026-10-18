# v2 Local Mode and Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent-forge v2 usable locally through a Lima VM on macOS and
Ubuntu, document every mode in a rewritten README, and leave no personal value
in the repository.

**Architecture:**
- **Branch 2:** three latent host bugs found under Lima are fixed in the
  playbook; the repo ships a Lima template and an example inventory;
  `vm-test.sh` gains a Lima target; `forge setup` warns on bare metal.
- **Branch 3:** the cleanup, `CLAUDE.md` and the README land last, on top of
  every other v2 stack, so the README documents what actually ships.

**Tech Stack:**
- Ansible (ansible-core ≥ 2.20, devsec.hardening 11.0.0);
- bash (`set -e`);
- Lima ≥ 2.0 (vz on macOS, QEMU on Linux);
- TypeScript run by Node 24 (`node --test`);
- Markdown.

**Spec:** `docs/superpowers/specs/2026-10-18-v2-local-mode-docs-design.md`
(read it first; this plan argues from it).

## Global Constraints

- **Commits:**
  - always `git commit --no-gpg-sign`, under the maintainer's standing
    authorization for the v2 stack;
  - each PR body says the commits are unsigned and need re-signing;
  - conventional messages in French, as in the repo (`feat:`, `fix:`,
    `docs:`, `test:`, `chore:`);
  - every message ends with
    `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Branches and PRs:**
  - branches `agent/*`; PR titles end with `(pile v2 · sp5, N/3)`;
  - each PR's base is the previous branch of the stack;
  - never merge into `next` or `main`, never push to them;
  - push with a bare `git push -u origin <branch>`.
- **Mac hook:** the repo's `.claude/settings.json` runs
  `container/pre-bash.sh` on the developer's Mac. It blocks:
  - any command text containing `sudo`;
  - `git merge` other than `origin/main`, and `git rebase`;
  - `2>&1` after `git push`;
  - push or force text inside heredocs.

  Write files with the Write/Edit tools, not shell heredocs. Root commands
  inside a test VM go through Ansible's `become`.
- **Bash scripts:** `set -e`; variables quoted (`"$VAR"`); preconditions
  checked first; non-obvious blocks commented.
- **SSH port:** `forge_ssh_port` default stays 22. Lima forwards
  `127.0.0.1:<port>` to the guest's 22. `vm-test.sh` keeps its test-only 2222
  for its default and `--host` targets.
- **Lima template values, exact:**
  - `minimumLimaVersion: 2.0.0`;
  - `base: [template:_images/ubuntu-26.04]`;
  - `plain: true`;
  - `cpus: 4`, `memory: 6GiB`, `disk: 60GiB`;
  - `ssh.localPort: 60022`, `ssh.overVsock: false`.
- **Names:**
  - Lima instance and SSH alias `forge-local`;
  - Ansible's host-key alias for the admin `forge-local-admin`;
  - forge user `forge` in local mode;
  - remote SSH alias `forge-vm`.
- **No personal value** in any new or changed file: no maintainer name,
  login, home path, host name, LAN address or email. Use `alice`,
  `acme/widgets`, `203.0.113.10` and `192.0.2.x`. The project's own GitHub
  address and PR references are allowed (spec, "Kept").
- **README language:** English. `CLAUDE.md` stays in French.

## Review Focus

1. **The admin is someone other than `ubuntu`, with a UID below 1000**
   (bare-metal installs, Lima on a Mac). The playbook must never lock them out.
   Covered by Task 1's verify check and Task 5's fresh admin login after each
   run.
2. **The Lima VM restarts** (the Mac sleeps, `limactl stop/start`). SSH must
   keep working with the same host key. Covered by Task 2 and Task 5's
   restart step under strict `known_hosts`.
3. **A developer already runs another Lima VM, or their own `forge-local`.**
   `vm-test.sh --lima` must not collide with it: automatic port, random name
   (Task 5), and a test that `--lima` refuses `--host`.
4. **`forge setup` run directly on a laptop from a checkout.** It must warn,
   while an Ansible-installed host or any VM stays quiet (Task 6, four cases,
   including a missing `systemd-detect-virt`).
5. **The README's commands and files drift apart:** the template's port vs the
   inventory example vs the SSH block. Task 4's bash test cross-checks the
   port in the template and the inventory example. Task 11's README test
   asserts the same values in the README.

---

## Part A — branch `agent/v2-local-spec` (1/3)

Already holds the approved spec (commit `107d194` and the status update), on
top of `agent/v2-polish` (moroine/agent-forge#38). This plan is committed
there too.

### Task 0: Publish the spec and plan

**Files:**
- Create: `docs/superpowers/plans/2026-10-18-v2-local-mode-docs.md` (this
  file)

- [ ] **Step 1:** Commit the plan, and the spec status line if it is not yet
  committed.

```bash
git add docs/superpowers/specs/2026-10-18-v2-local-mode-docs-design.md docs/superpowers/plans/2026-10-18-v2-local-mode-docs.md
git commit --no-gpg-sign -m "docs: plan du sous-projet 5 v2, mode local et docs"
```

- [ ] **Step 2:** Push and open the PR.
  - Push: `git push -u origin agent/v2-local-spec`.
  - Open the PR with `gh pr create --base agent/v2-polish`, title
    `docs: spec et plan du sous-projet 5 v2, mode local Lima et docs (pile v2 · sp5, 1/3)`.
  - The body summarizes the spec's decisions and the Lima validation, says the
    commits are unsigned, and links the spec and plan.

---

## Part B — branch `agent/v2-local-lima` (2/3)

Create it from `agent/v2-local-spec`:
`git switch -c agent/v2-local-lima agent/v2-local-spec`.

Run before every commit of this part:
- `npm run test:ansible` (Ansible tasks);
- `npm test && npm run check` (CLI and bash tasks);
- `ansible-lint ansible/` when available. CI runs it anyway.

### Task 1: Keep devsec from locking out the admin

devsec's `os_hardening` sets the shell of every account with a UID up to
`SYS_UID_MAX` to `/usr/sbin/nologin`, unless the account is in
`os_ignore_users`. Lima's admin has the Mac's UID, 501. See the spec, "Host
fixes", item 1.

**Files:**
- Modify: `ansible/roles/hardening/vars/main.yml` (next to
  `hardening_users_without_password_ageing`)
- Modify: `ansible/roles/hardening/tasks/main.yml` (the `import_role` vars of
  `devsec.hardening.os_hardening`)
- Test: `ansible/tests/unit/hardening.yml`
- Test: `ansible/tests/verify/hardening.yml`

**Interfaces:**
- Produces: `hardening_ignore_users`, a list equal to
  `[vagrant, kitchen, "{{ forge_admin_user }}"]`. `vagrant` and `kitchen` are
  devsec's own default for `os_ignore_users`, kept so that nothing changes for
  them.

- [ ] **Step 1: Write the failing unit assertion** in
  `ansible/tests/unit/hardening.yml`. Add it after "Check the admin is exempt
  from password ageing":

```yaml
    # devsec gives every account below UID_MIN a nologin shell; Lima's admin
    # has the Mac's UID (501). The admin must keep its shell.
    - name: Check the admin keeps its login shell
      ansible.builtin.assert:
        that:
          - hardening_ignore_users == ['vagrant', 'kitchen', 'ubuntu']
```

- [ ] **Step 2: Run it.** Run `npm run test:ansible`. Expected: it FAILS, with
  `hardening_ignore_users` undefined.
- [ ] **Step 3: Define the variable.** Add `hardening_ignore_users` to
  `vars/main.yml`, with a comment giving the reason: UID < 1000 counts as a
  system account, which is the case for Lima's admin. Then pass
  `os_ignore_users: "{{ hardening_ignore_users }}"` in `tasks/main.yml`, next
  to `os_users_without_password_ageing`.
- [ ] **Step 4: Add the verify check.** In `ansible/tests/verify/hardening.yml`,
  add a check that the admin's shell is not nologin:
  - read it with `ansible.builtin.getent: database=passwd key={{ ansible_user }}`;
  - assert `ansible_facts.getent_passwd[ansible_user][5] not in ['/usr/sbin/nologin', '/bin/false']`.
- [ ] **Step 5: Run the tests.** `npm run test:ansible` must PASS. Run
  `ansible-lint ansible/` if it is installed.
- [ ] **Step 6: Commit.**

```bash
git add ansible/roles/hardening ansible/tests/unit/hardening.yml ansible/tests/verify/hardening.yml
git commit --no-gpg-sign -m "fix(hardening): devsec ne passe plus l'admin en nologin quand son UID est < 1000"
```

### Task 2: Keep the SSH host keys across cloud-init instance changes

Lima gives cloud-init a new instance id at every start, so cloud-init deletes
and regenerates the host keys. See the spec, "Host fixes", item 2.

**Files:**
- Create: `ansible/roles/base/files/99-agent-forge-keep-host-keys.cfg`
- Modify: `ansible/roles/base/tasks/main.yml`
- Test: `ansible/tests/unit/base.yml`, `ansible/tests/verify/base.yml`

**Interfaces:**
- Produces: `/etc/cloud/cloud.cfg.d/99-agent-forge-keep-host-keys.cfg` on
  every host, mode `0644`, owned by `root:root`.

- [ ] **Step 1: Write the failing unit assertion** in
  `ansible/tests/unit/base.yml`. It checks that the file's YAML parses to
  exactly `{'ssh_deletekeys': false}`:

```yaml
    - name: Check the cloud-init drop-in keeps the host keys
      ansible.builtin.assert:
        that:
          - unit_keep_keys == {'ssh_deletekeys': false}
      vars:
        unit_keep_keys: "{{ lookup('ansible.builtin.file', playbook_dir ~ '/../../roles/base/files/99-agent-forge-keep-host-keys.cfg') | from_yaml }}"
```

- [ ] **Step 2: Run it.** Run `npm run test:ansible`. Expected: it FAILS, the
  file is not found.
- [ ] **Step 3: Create the file.** It holds a `#cloud-config` header, a
  comment, and `ssh_deletekeys: false`.
  - The comment explains: Lima assigns a new instance id at each boot, and
    cloud-init would then replace the host keys; on a cloud VM the id is stable
    and this changes nothing.
  - Copy it with a task in `tasks/main.yml`, placed after the journald tasks:
    `ansible.builtin.copy`, `dest: /etc/cloud/cloud.cfg.d/`.
  - The task does not depend on `forge_exposure`.
- [ ] **Step 4: Add the verify check.** In `ansible/tests/verify/base.yml`,
  `slurp` the deployed file and assert that its decoded content parses to the
  same dict.
- [ ] **Step 5: Run the tests.** `npm run test:ansible` must PASS.
- [ ] **Step 6: Commit.**

```bash
git add ansible/roles/base ansible/tests/unit/base.yml ansible/tests/verify/base.yml
git commit --no-gpg-sign -m "fix(base): l'hôte garde ses clés SSH quand cloud-init change d'instance (Lima)"
```

### Task 3: Lima template and example inventory

**Files:**
- Create: `ansible/lima/forge.yaml`
- Create: `ansible/inventory.lima.example.yml`
- Modify: `.ansible-lint` (`kinds`)
- Test: `tests/test-lima-files.sh` (new, picked up by `npm run test:bash`)

**Interfaces:**
- Produces:
  - `ansible/lima/forge.yaml`, used by the README (`limactl create --name forge-local ansible/lima/forge.yaml`)
    and by Task 5 (`limactl create --set '.ssh.localPort = 0'`);
  - `ansible/inventory.lima.example.yml`, used by the README.

- [ ] **Step 1: Write the failing test** `tests/test-lima-files.sh`. Use the
  same `PASS`/`FAIL` counter style as `tests/test-readme-docs.sh`.
  - **The template** (`ansible/lima/forge.yaml`) contains each of these
    exact lines:
    - `minimumLimaVersion: 2.0.0`
    - `- template:_images/ubuntu-26.04`
    - `plain: true`
    - `cpus: 4`
    - `memory: 6GiB`
    - `disk: 60GiB`
    - `  localPort: 60022`
    - `  overVsock: false`

    It also has no `mounts:` key and no `portForwards:` key.
  - **The inventory example** (`ansible/inventory.lima.example.yml`)
    contains:
    - `ansible_host: 127.0.0.1`
    - `ansible_port: 60022`
    - `ansible_ssh_private_key_file: ~/.lima/_config/user`
    - `HostKeyAlias=forge-local-admin`
    - `StrictHostKeyChecking=accept-new`
    - `forge_exposure: local`
    - `- name: forge`

    It has no `forge_ssh_port:` line other than a comment.
  - **Cross-check:** the template's `localPort` value equals the example's
    `ansible_port` value, both read with `sed`.
- [ ] **Step 2: Run it.** Run `bash tests/test-lima-files.sh`. Expected: it
  FAILS, the files are missing.
- [ ] **Step 3: Write `ansible/lima/forge.yaml`.**
  - It starts with `---` and a header comment: what it is, and the two README
    commands.
  - It holds the exact values from Global Constraints.
  - Each setting gets a one-line comment giving its reason, from the spec's
    "Lima template" bullets:
    - `plain` keeps the Mac's home, ports and containerd out;
    - `overVsock: false`, or preflight cannot see where SSH arrives;
    - a fixed port for copy-paste;
    - the sizes were validated on a 16 GiB Mac, and are changed with
      `limactl edit`.
- [ ] **Step 4: Write `ansible/inventory.lima.example.yml`.**
  - It follows the shape of the spec's "Inventory" block and the comment style
    of `ansible/inventory.example.yml`.
  - Placeholders: `YOUR_LOGIN` and `"ssh-ed25519 AAAA... you@laptop"`.
  - `ansible_ssh_common_args` is
    `-o IdentitiesOnly=yes -o HostKeyAlias=forge-local-admin -o StrictHostKeyChecking=accept-new`.
  - A comment says the forge user must differ from your login, and to copy
    the file outside the repository.
- [ ] **Step 5: Register the files with ansible-lint.** In `.ansible-lint`
  `kinds`, add `- yaml: "**/ansible/inventory.lima.example.yml"` and
  `- yaml: "**/ansible/lima/*.yaml"`, so that they are linted as plain YAML.
- [ ] **Step 6: Run the tests.** `bash tests/test-lima-files.sh` must PASS
  (`PASS=… FAIL=0`). If `limactl` is installed, also run
  `limactl validate ansible/lima/forge.yaml`, which must exit 0.
- [ ] **Step 7: Commit.**

```bash
git add ansible/lima ansible/inventory.lima.example.yml .ansible-lint tests/test-lima-files.sh
git commit --no-gpg-sign -m "feat(lima): template de VM locale et inventaire d'exemple pour le mode local"
```

### Task 4: `verify.yml` takes the controller-side SSH port

**Files:**
- Modify: `ansible/tests/verify.yml` (play `vars`, header comment)

**Interfaces:**
- Produces: the extra var `verify_ssh_port`, the port the controller uses to
  reach sshd. It defaults to `forge_ssh_port`. `vm-test.sh` sets it in Lima
  mode (Task 5).

- [ ] **Step 1: Add the variable.** In `verify.yml`'s play `vars`, add
  `verify_ssh_port: "{{ forge_ssh_port }}"`.
  - In `verify_ssh`, replace `-p {{ forge_ssh_port }}` with
    `-p {{ verify_ssh_port }}`.
  - Add `verify_ssh_port` to the header comment's list of extra vars, with one
    line: "under Lima, the forwarded port; sshd itself listens on
    forge_ssh_port".
  - Leave `verify/ssh_client.yml`'s "port 22 no longer answers" check as it
    is: it keys on `forge_ssh_port`, which is 22 under Lima, so it is skipped.
- [ ] **Step 2: Check the syntax.** Run
  `ansible-playbook -i ansible/tests/unit-inventory.yml --syntax-check ansible/tests/verify.yml`.
  Expected: `playbook: ansible/tests/verify.yml`, exit 0. Then run
  `npm run test:ansible`, which must PASS.
- [ ] **Step 3: Commit.**

```bash
git add ansible/tests/verify.yml
git commit --no-gpg-sign -m "test(verify): port SSH vu du contrôleur distinct de forge_ssh_port"
```

### Task 5: `vm-test.sh --lima`

**Files:**
- Modify: `ansible/tests/vm-test.sh`
- Test: `tests/test-vm-test.sh`

**Interfaces:**
- Consumes:
  - `ansible/lima/forge.yaml` (Task 3);
  - `verify_ssh_port` (Task 4);
  - the verify checks of Tasks 1 and 2.
- Produces:
  - the usage `ansible/tests/vm-test.sh --lima [--exposure public|lan|local] [--keep]`;
  - the PASS line `vm-test: PASS (exposure <e>, lima)`.

Behaviour to add, following the spec's "`vm-test.sh --lima`":

- **Arguments:**
  - `--lima` sets `LIMA=1`;
  - `--lima` with `--host` dies with
    `vm-test: --lima and --host are exclusive`;
  - the exposure defaults to `local` with `--lima`, and stays `public`
    otherwise. Keep `EXPOSURE` empty until arguments are parsed, then apply
    the default.
- **Preconditions (Lima):**
  - `limactl` is on PATH, or die with
    `vm-test: --lima needs limactl (Lima 2.0 or newer)`;
  - the version from `limactl --version` is at least 2.0;
  - on Linux (`uname -s` = `Linux`), `/dev/kvm` is writable, or die with
    `vm-test: /dev/kvm is not writable: add yourself to the kvm group`.

  The existing lxc/incus/KVM checks apply only to the default target. The
  Lima checks run before the generic tool loop (`ansible-playbook`, …), so
  that a machine without Lima gets the Lima message first, even when Ansible
  is missing too (CI).
- **Admin key:** copy `${LIMA_HOME:-$HOME/.lima}/_config/user` to
  `$WORK/admin` (mode 600), instead of generating one.
- **Machine:**
  - `VM="forge-host-test-<6 hex>"`, as today;
  - `limactl create --tty=false --name "$VM" --set '.ssh.localPort = 0' "$REPO/ansible/lima/forge.yaml"`,
    then `limactl start --tty=false "$VM"`;
  - `PORT` comes from `limactl list "$VM" --format '{{.SSHLocalPort}}'`, and
    `ADMIN` from `limactl list "$VM" --format '{{.Config.User.Name}}'`. Check
    both formats against the installed Lima. If the second prints a pointer
    address, use `limactl shell --workdir / "$VM" id -un` instead;
  - `IP=127.0.0.1`;
  - wait with `wait_ssh "$PORT"`, then `cloud-init status --wait`, accepting
    exit 0 or 2, as the other targets do.
- **Inventory (Lima):**
  - `ansible_port: $PORT`;
  - `forge_ssh_port: 22`;
  - everything else as generated today.
- **Port bookkeeping:**
  - one variable, `SSH_PORT`: `$FORGE_SSH_PORT` for the existing targets,
    `$PORT` for Lima;
  - `wait_ssh`, `ssh_admin` and the `verify` function use `SSH_PORT`;
  - `verify` also passes `-e "verify_ssh_port=$SSH_PORT"`;
  - the "host key changed during provisioning" block only runs when the port
    changed. Under Lima the single `known_hosts` entry already enforces the
    key.
- **New for every target:** right after each of the two runs, check that the
  admin logs in on a fresh connection:
  - `ssh_admin "$SSH_PORT" true`, or die with
    `vm-test: the admin cannot log in on a fresh connection after the <first|second> run`;
  - after the first run on the existing targets, `SSH_PORT` is the new port.
- **Reboot (Lima):** `limactl stop "$VM"`, then `limactl start --tty=false "$VM"`,
  then `wait_ssh "$SSH_PORT"`. A changed host key fails here, under
  `StrictHostKeyChecking=accept-new` against `$WORK/known_hosts`. Die with
  `vm-test: SSH on port $SSH_PORT failed after the restart (a changed host key shows above)`.
- **Cleanup:** `limactl delete --force "$VM"` unless `--keep`.
- **Header comment:** document the third target and its usage line.

Steps:

- [ ] **Step 1: Write the failing argument tests** in `tests/test-vm-test.sh`,
  with the existing `expect` helper:

```bash
expect lima-and-host nonzero '--lima and --host are exclusive' -- --lima --host 203.0.113.10 --admin-key "$TMP/admin"
# A PATH without limactl stands for a machine without Lima.
lima_missing() { PATH="/usr/bin:/bin" "$SCRIPT" --lima 2>&1; }
```

  Place them after the `host-port-filtered` case, which creates
  `$TMP/admin`. Then add a case asserting that `lima_missing` exits non-zero
  with `--lima needs limactl`. Write it inline, the way `expect` does, because
  `expect` cannot change PATH.
- [ ] **Step 2: Run them.** Run `bash tests/test-vm-test.sh`. Expected: the
  two new cases FAIL, and the existing ones PASS.
- [ ] **Step 3: Implement** the behaviour above in `ansible/tests/vm-test.sh`.
  Run `bash -n ansible/tests/vm-test.sh`.
- [ ] **Step 4: Run the tests.** Run `bash tests/test-vm-test.sh`. Expected:
  `PASS=… FAIL=0`.
- [ ] **Step 5: Run it for real** on the Mac, with the maintainer's agreement
  on disk space (about 6 GiB, deleted at the end):

```bash
ansible/tests/vm-test.sh --lima
```

  Expected:
  - it ends with `vm-test: PASS (exposure local, lima)`;
  - the second run shows `changed=0`;
  - both verifies show `failed=0`.

  Keep the recaps for the PR body. If it fails, debug with
  superpowers:systematic-debugging before changing anything.
- [ ] **Step 6: Commit.**

```bash
git add ansible/tests/vm-test.sh tests/test-vm-test.sh
git commit --no-gpg-sign -m "test(vm-test): cible --lima (VM Lima jetable, redémarrage par limactl, login admin sur connexion neuve)"
```

### Task 6: `forge setup` warns on bare metal outside Ansible

The spec's "`forge setup` on bare metal". Keep the change in one new function
in `host.ts`, plus a few lines in `setup.ts`. Sub-projects 3 and 4 also edit
`setup.ts`, and the stacks get chained later.

**Files:**
- Modify: `cli/lib/host.ts`
- Modify: `cli/lib/commands/setup.ts` (`SetupOptions`, and the warnings at
  step 5)
- Test: `tests/host.test.ts`, `tests/setup.test.ts`

**Interfaces:**
- Produces:
  - `export function runsOnBareMetalOutsideAnsible(releaseRoot: string, virt: string | null): boolean`
    in `host.ts`. It returns true when `releaseRoot` does not start with
    `/opt/agent-forge/releases/`, and `virt` is `null` or `"none"`;
  - `export function detectVirt(): string | null` in `host.ts`. It runs
    `systemd-detect-virt --vm` with `spawnSync`, and returns its trimmed
    stdout (`"none"` when not in a VM, exit 1), or `null` when the binary
    cannot be run;
  - in `SetupOptions`: `virt?: () => string | null` (default `detectVirt`)
    and `releaseRoot?: string` (default `repoRoot()` from `paths.ts`).
- Exact warning, one line on stderr through `ctx.err`, after the host-address
  warnings:
  `WARNING: forge runs directly on this machine, not in a VM: an agent that escapes its container lands here, with this machine's keys and sessions. The supported local mode is a Lima VM (see the README).`

- [ ] **Step 1: Write the failing tests.**
  - **In `tests/host.test.ts`,** `runsOnBareMetalOutsideAnsible`:

```ts
test("bare metal from a checkout is flagged", () => {
  assert.equal(runsOnBareMetalOutsideAnsible("/home/alice/agent-forge", "none"), true);
  assert.equal(runsOnBareMetalOutsideAnsible("/home/alice/agent-forge", null), true);
});
test("a VM or an Ansible release is not", () => {
  assert.equal(runsOnBareMetalOutsideAnsible("/home/alice/agent-forge", "kvm"), false);
  assert.equal(runsOnBareMetalOutsideAnsible("/opt/agent-forge/releases/abc123", "none"), false);
});
```

  - **In `tests/setup.test.ts`:**
    - add `virt: () => "kvm"` to the `opts()` helper's defaults, so that
      existing tests stay quiet;
    - one test: with `virt: () => "none"` and
      `releaseRoot: "/home/alice/agent-forge"`, `c.err_lines` contains the
      exact warning;
    - one test: with `releaseRoot: "/opt/agent-forge/releases/abc"`, no line
      contains `not in a VM`.
- [ ] **Step 2: Run them.** Run `node --test tests/host.test.ts tests/setup.test.ts`.
  Expected: they FAIL (the export is missing, the warning is absent).
- [ ] **Step 3: Implement** both functions in `host.ts` and the options in
  `setup.ts`. Update `setup.ts`'s header comment: every mode runs it (VM,
  Lima); a bare-metal run outside Ansible warns.
- [ ] **Step 4: Run the tests.** `npm test && npm run check` must PASS.
- [ ] **Step 5: Commit.**

```bash
git add cli/lib/host.ts cli/lib/commands/setup.ts tests/host.test.ts tests/setup.test.ts
git commit --no-gpg-sign -m "feat(setup): avertir quand forge tourne sur une machine physique hors Ansible"
```

### Task 7: `ansible/README.md` covers Lima, then publish branch 2

**Files:**
- Modify: `ansible/README.md`

- [ ] **Step 1: Document Lima** in `ansible/README.md`.
  - **"Running it":** a short paragraph for a local Lima VM, pointing to
    `ansible/lima/forge.yaml` and `ansible/inventory.lima.example.yml`, and to
    the main README's local quick start for the full walk-through.
  - **"VM test",** a third subsection, "On a Lima VM (`--lima`)":
    - the command;
    - what it creates and deletes;
    - the requirements: Lima ≥ 2.0, and `/dev/kvm` plus the `kvm` group on
      Linux;
    - that it uses an automatic port and never touches `forge-local`.
  - **"Hardening choices":**
    - the admin is in `os_ignore_users`, and why;
    - the cloud-init drop-in, and why.
- [ ] **Step 2: Run all tests.** `npm test && npm run check && npm run test:ansible`
  must PASS.
- [ ] **Step 3: Commit, push and open the PR.**

```bash
git add ansible/README.md
git commit --no-gpg-sign -m "docs(ansible): VM Lima, vm-test --lima et les deux correctifs hôte"
git push -u origin agent/v2-local-lima
```

  Open the PR with `gh pr create --base agent/v2-local-spec`, title
  `feat: mode local Lima, correctifs hôte et vm-test --lima (pile v2 · sp5, 2/3)`.
  The body gives:
  - the three host fixes, and the latent bug each one closes;
  - the `vm-test.sh --lima` recaps from Task 5;
  - that the fixes apply to every exposure. If the maintainer provided a
    fresh cloud VM, a `vm-test.sh --host` summary; otherwise "validated under
    Lima only";
  - that the commits are unsigned.

---

## Part C — branch `agent/v2-docs` (3/3), last

**Gate.** Do not start until the maintainer has chained every open v2 PR into
one line (spec, "Delivery"). That covers #34, the main stack through #38,
sub-project 3 through its last branch (#47 at the time of writing), sub-project
4 through #45, any later v2 PR such as #48, and branches 1 and 2 of this
plan. Ask the maintainer which branch is the resulting top.

### Task 8: Start branch 3 on the chained top

- [ ] **Step 1: Check the gate.** For each open v2 PR's head branch (list them
  with `gh pr list --state open --json headRefName,baseRefName`; keep those
  whose chain leads to `next`), run
  `git merge-base --is-ancestor origin/<head> origin/<top>`.
  - Expected: exit 0 for every one.
  - If one fails, stop and tell the maintainer which branch is missing.
- [ ] **Step 2: Create the branch.**
  `git switch -c agent/v2-docs origin/<top>`. Run
  `npm test && npm run check && npm run test:ansible`: it must PASS before you
  change anything. If it fails, report it; never fix another stack's code
  here.

### Task 9: Remove every personal value

**Files:**
- Delete: `config/` (and the `config/` line in `.ansible-lint`'s
  `exclude_paths`)
- Modify:
  - the test fixtures;
  - `ansible/roles/hardening/vars/main.yml` (its comment on the v1 server);
  - every file under `docs/superpowers/` that the grep finds.

The spec's tables "Replacements" and "Kept" are the rules.

- [ ] **Step 1: Build the pattern list in the shell.** Never write it to a
  tracked file.
  - **Maintainer:** the first name, family name and login from
    `git log --format='%an <%ae>' | sort -u`.
  - **v1 server:** the host name and LAN prefix from the v1 README on `main`
    (`git show origin/main:README.md`, the "Remote access" section).
  - **Bot and work email:** the bot address from
    `git show origin/main:scripts/lib/provision.ts` (or whatever file
    defines it on `main`), and the work email domain from `git log`.

  Then run:
  `git grep -n -i -I -E '<pattern>' -- . ':!package-lock.json'`.
- [ ] **Step 2: Replace each hit.**
  - **Code and tests:**
    - fixtures `<login>/agent-forge` → `acme/widgets`;
    - `agent-<login>-agent-forge` → `agent-acme-widgets`;
    - other names → `alice`;
    - LAN addresses → `192.0.2.x`.

    Run `npm test` after each file group. Update every expectation together
    with its fixture.
  - **Docs (`docs/superpowers/**`):**
    - the maintainer as a person → "the maintainer" (they/them);
    - the v1 server → "the v1 server";
    - home paths → `/home/<user>`;
    - LAN addresses → `192.0.2.x`;
    - the bot address → `<bot>@users.noreply.github.com`.

    Keep each sentence's meaning, and do not reflow paragraphs.
  - **Keep:** `github.com/<login>/agent-forge` and `<login>/agent-forge#N`
    when they designate the project or its PRs.
- [ ] **Step 3: Delete `config/`.**
  - Run `git rm -r config` and drop `config/` from `.ansible-lint`.
  - `git grep -n 'config/sshd_config\|config/jail.local'` may only return
    design history in `docs/`. Reword those hits as "v1's sshd_config", and
    add no new path.
- [ ] **Step 4: Check.**
  - Re-run the Step 1 grep. It must print only "Kept" hits, which are
    project-address lines.
  - Run `npm test && npm run check && npm run test:ansible`: it must PASS.
- [ ] **Step 5: Commit.**

```bash
git add -A
git commit --no-gpg-sign -m "chore: retirer toute valeur personnelle du dépôt (code, tests, docs, config v1)"
```

### Task 10: `CLAUDE.md` for v2

**Files:**
- Modify: `CLAUDE.md` (French)

- [ ] **Step 1: Rewrite the sections** listed in the spec's "`CLAUDE.md`".
  - **Contexte:**
    - the five sub-projects are delivered;
    - the README describes v2;
    - the host is a VM reached over SSH, or a local Lima VM.
  - **Git:** the three audiences.
    - Inside a v2 container (supervised): commits only, unsigned, under the
      host's identity; no push, no `gh`; the maintainer retrieves through
      `forge upload-pack`, re-signs, pushes, opens the PR.
    - On the dev machine, in `auto` mode: push `agent/<tâche>` and
      `gh pr create --base next` (`main` after the release).
    - On the dev machine, interactive: confirmation before any push.

    It also states:
    - never a PR merge, never a push to `main` or `next`;
    - `git merge origin/<base>` only;
    - while `main` (which has #27) is not merged into `next`, `pre-bash.sh` on
      `next` accepts only `origin/main`.

    v1's autonomous-container bullet leaves the file.
  - **Périmètre / Ce que tu peux faire:** `config/` removed; `ansible/` and
    `docs/` listed.
  - **Sécurité:** the YubiKey line becomes "une clé SSH (une clé matérielle
    par exemple)".
  - **Unchanged:** keep the "Branche `next`" section and "Runtime v2" as they
    are, except facts the chained stacks changed:
    - tmux is replaced by herdr (sub-project 4);
    - strict mode exists (sub-project 3).

    Check each fact against the code.
- [ ] **Step 2: Check.** `git grep -n -i 'tmux\|autonom\|config/' CLAUDE.md`
  only returns lines that say these are v1-only or gone. Run
  `bash tests/test-claude-template.sh` if it reads the root `CLAUDE.md`
  (check its `FILE=`). Otherwise there is nothing to run.
- [ ] **Step 3: Commit.**
  `git commit --no-gpg-sign -m "docs: CLAUDE.md décrit la v2 livrée et son flux git"`.

### Task 11: The README for v2

**Files:**
- Modify: `README.md` (full rewrite, English)
- Modify: `tests/test-readme-docs.sh` (rewritten)

**Inputs:**
- the spec's "README" section (structure and inputs);
- in the shared notes folder: `readme-needs-sp3.md`, `readme-needs-sp4.md`,
  `sp5-inputs-collected.md`, `sp5-lima-spike.md`;
- sub-projects 3 and 4's specs. For each command, message and default, read
  their final code: the notes predate the implementation, for example the
  default allowlist changed in #47.

- [ ] **Step 1: Rewrite `tests/test-readme-docs.sh`.** Same helpers.
  - Present:
    - `limactl create --name forge-local ansible/lima/forge.yaml`
    - `limactl start forge-local`
    - `ansible/inventory.lima.example.yml`
    - `ansible-galaxy collection install -r ansible/requirements.yml`
    - `ansible-playbook -i`
    - `Host forge-local`
    - `Port 60022`
    - `User forge`
    - `HostKeyAlias forge-local`
    - `ForwardAgent yes`
    - `IdentityAgent`
    - `claude auth login`
    - `forge setup`
    - `forge image build`
    - `herdr --remote forge-local --remote-keybindings server`
    - `prefix+f`
    - `prefix+shift+f`
    - `forge upload-pack`
    - `uploadpack`
    - `forge egress`
    - `--strict`
    - `egress-allowlist`
    - `forge resume`
    - `forge finish`
    - `forge list`
    - `forge completion bash`
    - `incus --project agent-forge delete --force`
    - `brew install lima`
    - `pipx install ansible-core`
    - `/dev/kvm`
    - `Host forge-vm`
    - `not yet validated` (the Ubuntu path, until the maintainer's run)
  - Absent:
    - `lxc `
    - `LXD`
    - `scripts/forge`
    - `tmux`
    - `Ctrl+b d`
    - `ufw`
    - `forge image build super`
    - `agent-super`
    - `incus admin init`
    - `Port 2222`
  - **Run it:** `bash tests/test-readme-docs.sh` must FAIL against the v1
    README.
- [ ] **Step 2: Write `README.md`** following the spec's ten sections, in that
  order.
  - **Quick start: local.** Its commands, in this order:
    1. the per-OS prerequisites:
       - macOS: `brew install lima ansible herdr`;
       - Ubuntu: the Lima release archive, `qemu-system-x86 qemu-utils`, the
         `kvm` group, `pipx install ansible-core`, and herdr's Linux install
         from herdr.dev. Check each name and URL when writing;
    2. `git clone https://github.com/<project>/agent-forge.git`;
    3. `limactl create …` and `limactl start forge-local`;
    4. copy and edit the inventory example: your login (`whoami`), your public
       key (`ssh-add -L`);
    5. `ansible-galaxy collection install -r ansible/requirements.yml` and
       `ansible-playbook -i ~/forge-local-inventory.yml ansible/site.yml`;
    6. the `Host forge-local` block from the spec, and the `IdentityAgent`
       gotcha;
    7. `ssh forge-local`, then `claude auth login`, `git config --global user.name/user.email`,
       `forge setup`, `forge image build`;
    8. `herdr --remote forge-local --remote-keybindings server` in a real
       terminal, then `prefix+f`;
    9. retrieval with sub-project 4's three commands, with `forge-local:<container>`.
  - **Ubuntu:** say the path is "not yet validated" until the maintainer's run
    on their Ubuntu server.
  - **Remote host:** port 22 by default, no `Port` line in `Host forge-vm`.
  - **Security model:** the per-mode table, including the local-mode row
    "the Lima VM can reach the developer's localhost and LAN; an agent that
    escapes its container could too" (spec, "Security: what the local VM can
    reach").
  - **No personal value;** examples use `alice`, `acme/widgets`,
    `203.0.113.10`.
- [ ] **Step 3: Run the tests.** `bash tests/test-readme-docs.sh` must PASS,
  then `npm test` must PASS.
- [ ] **Step 4: Check the commands.** Run each README command that needs no VM
  or credentials:
  - `forge --help` and `forge completion bash`, through `cli/forge`;
  - `limactl validate ansible/lima/forge.yaml`;
  - `ansible-playbook --syntax-check -i ansible/inventory.lima.example.yml ansible/site.yml`.

  Each must work as written.
- [ ] **Step 5: Commit.**

```bash
git add README.md tests/test-readme-docs.sh
git commit --no-gpg-sign -m "docs: README v2 par mode (local Lima, distant), sécurité, dépannage"
```

### Task 12: Final check, the maintainer's walk-through, PR 3

- [ ] **Step 1: Run every test.** `npm test && npm run check && npm run test:ansible`
  must PASS. Re-run Task 9's personal-value grep on the final tree; it must
  show only "Kept" hits.
- [ ] **Step 2: Push** `agent/v2-docs` (`git push -u origin agent/v2-docs`).
  Open the PR as a **draft**, based on the chained top, titled
  `docs: README v2, CLAUDE.md et nettoyage des valeurs personnelles (pile v2 · sp5, 3/3)`.
  The body:
  - lists what each commit does;
  - says the commits are unsigned;
  - says the PR waits for the maintainer's macOS walk-through.
- [ ] **Step 3: The maintainer's walk-through.** The maintainer follows the
  README's local quick start on their Mac, end to end:
  - a fresh `forge-local`;
  - `claude auth login`;
  - `forge start` on a real repository through `prefix+f`;
  - retrieval with `git fetch`.

  Then:
  - fix every README step that did not work as written, and re-run
    Steps 1–2;
  - when the maintainer reports their run on their Ubuntu server, change
    "not yet validated" for Ubuntu, and update `tests/test-readme-docs.sh` to
    match;
  - put both results in the PR body. The PR leaves draft only after the macOS
    walk-through.
