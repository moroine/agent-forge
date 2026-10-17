# agent-forge v2 — Sub-project 1: Host (Ansible) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ansible/site.yml` turns a fresh Ubuntu 26.04 machine, VM or bare metal, into a hardened agent-forge host. The host gets native nftables, fail2ban, Incus 7.0 LTS with a btrfs pool, and one forge user with Node 24, Claude Code, Ansible and `forge`. The playbook is backed by controller-only unit tests, a throwaway-VM test run on omen, and a light CI.

**Architecture:** One preflight play validates the inventory, normalizes the optional `forge_*` variables into facts, resolves the SSH port and checks the target. Then one provisioning play runs six roles in order: `base`, `hardening`, `firewall`, `fail2ban`, `incus`, `forge_users`. The sshd restart and the nftables load are handlers, and `force_handlers` is on. Logic that can be checked without a machine (input checks, port fallback, computed variables, rendered templates) is covered by unit playbooks on the controller. Everything else is asserted by `ansible/tests/verify.yml`, which `ansible/tests/vm-test.sh` runs against a throwaway LXD VM on omen.

**Tech Stack:** Ansible (ansible-core ≥ 2.20), devsec.hardening 11.0.0, nftables, fail2ban, Incus 7.0 LTS (Zabbly), bash, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-15-v2-host-ansible-design.md`. Read it before starting. Its parent is the framing spec `docs/superpowers/specs/2026-10-15-v2-incus-ansible-herdr-design.md`; its input is the spike report `docs/superpowers/spikes/2026-10-15-v2-validation-spike.md`.

## Global Constraints

- Target: a fresh Ubuntu 26.04 LTS machine (`resolute`), VM or bare metal. Nothing may be assumed from cloud-init. The external interface is detected (WiFi included) unless `forge_external_interface` is set.
- Controller: ansible-core ≥ 2.20, git, and a git checkout of this repository, because `forge` is deployed from its HEAD.
- Collections, pinned in `ansible/requirements.yml`: `devsec.hardening` `11.0.0`, `community.general` `13.5.0`, `ansible.posix` `2.2.2`.
- Boundary rule: Ansible configures the host OS and stops once Incus is installed, initialized with a storage pool, and usable by the forge user. The only place it touches Incus internals is the smoke test in `verify.yml`, which creates and deletes a throwaway project.
- Firewall: native nftables, in one table of our own, `inet forge_host`. **Never `flush ruleset`.**
- Naming:
  - User-facing variables have the `forge_` prefix and are documented in `ansible/inventory.example.yml`.
  - Role internals carry their role's prefix: `base_`, `hardening_`, `firewall_`, `fail2ban_`, `incus_`, `forge_users_`. This includes registered variables inside roles.
  - Test variables use `unit_` or `verify_`.
- Accounts:
  - Exactly one forge user in v2.0.
  - The admin is `ansible_user`, never `root`. The playbook never changes the admin's keys or sudo.
  - The forge user is in `incus-admin` only, never `sudo`.
- Shared constants: the bridge is `forgebr0`, the storage pool is `default` (btrfs).
- `forge` install layout:
  - releases unpack to `/opt/agent-forge/releases/<sha>/`, with a `COMMIT` file holding the full SHA at the release root, beside `scripts/` (later `cli/`) and `ansible/`; sub-project 2's image stamp reads it there;
  - `/opt/agent-forge/current` and `/opt/agent-forge/previous` are symlinks;
  - `/usr/local/bin/forge` → `/opt/agent-forge/current/scripts/forge`.
- Ansible style:
  - FQCN modules;
  - every task named, starting with a capital letter;
  - `cmd:` form for `command`/`shell`;
  - `mode:` on every file a task writes;
  - `changed_when` on every `command`/`shell`.
- `ansible-lint` profile `production` must pass. A `# noqa: <rule>` (rule ids only, nothing else on the comment) is allowed only with a comment line just above the task saying why.
- Bash (CLAUDE.md):
  - `set -e` is mandatory;
  - variables always quoted (`"$VAR"`);
  - non-obvious blocks commented;
  - preconditions tested at the top.
- Comments and docs in new files are in English: v2 targets open-source sharing and its specs are in English.
- Git:
  - work on branch `agent/v2-host`, created from `agent/v2-host-spec`;
  - conventional commit messages (`feat:`, `fix:`, `test:`, `docs:`, `ci:`);
  - commits are GPG-signed with the user's YubiKey: **ask the user to be at the key before every commit**, never use `--no-gpg-sign`;
  - **ask before any push**;
  - PRs target `next` (`gh pr create --base next`);
  - never touch `main`.
- Harness quirk: if Ansible aborts with `Ansible requires blocking IO on stdin/stdout/stderr`, run the same command with `</dev/null 2>&1 | cat` appended.

## Review Focus

These five input classes are implied by the spec but no test listed in the spec exercises them. Each one gets a test in the task that owns the code.

1. **`forge_ssh_allowed_sources` with only one address family** (IPv4 only, or IPv6 only): the other family must be refused, not left open. → Task 5, firewall unit cases `local-v4` and `public-v6`.
2. **A host with no default IPv4 route** (an IPv6-only VPS) and no `forge_external_interface`: a clear failure, not a ruleset matching `iifname ""` that drops SSH. → Task 5, `check_interface.yml` unit test.
3. **OpenSSH 10 logs from `sshd-session`**: fail2ban must count real failed logins, not merely accept a manual `banip`. → Task 7, `verify/fail2ban.yml` "Total failed ≥ 1" check.
4. **A dedicated device or an explicit pool size**: with `forge_incus_storage_source`, the preseed carries `source` and no `size`. An explicit `forge_incus_storage_size` is never replaced by the 80 % rule. → Task 8, preseed unit cases `device` and `explicit`.
5. **An explicit `ansible_port`** (Lima) must survive the port probe, and a closed `forge_ssh_port` must fall back to 22. → Task 1, port unit cases.

---

## File map

```
.ansible-lint                                   Task 1  lint profile and file kinds
.github/workflows/ci.yml                        Task 10 CI: cli, ansible-lint, ansible-unit
package.json                                    Task 1  adds "test:ansible"
ansible/
  requirements.yml                              Task 1  pinned controller collections
  site.yml                                      Task 1 (preflight play), Task 3+ (roles)
  inventory.example.yml                         Task 1  documented user-facing variables
  README.md                                     Task 1, 2, 8
  preflight/inputs.yml                          Task 1  validate + normalize forge_* vars
  preflight/controller.yml                      Task 1  ansible-core version, git checkout
  preflight/port.yml                            Task 1  ansible_port probe / fallback
  preflight/target.yml                          Task 1  facts + Ubuntu 26.04 check
  roles/base/...                                Task 3
  roles/hardening/...                           Task 4
  roles/firewall/...                            Task 5
  roles/fail2ban/...                            Task 7
  roles/incus/...                               Task 8
  roles/forge_users/...                         Task 9
  tests/unit.yml                                Task 1+ imports every unit playbook
  tests/unit-inventory.yml                      Task 1+ localhost test cases
  tests/unit/{preflight,base,hardening,firewall,fail2ban,incus}.yml
  tests/unit/tasks/*.yml                        per-case task files
  tests/vm-test.sh                              Task 2  throwaway VM harness (omen)
  tests/verify.yml                              Task 2+ assertions on the provisioned host
  tests/verify/{platform,base,hardening,ssh_client,firewall,fail2ban,incus,forge_users}.yml
  tests/files/incus-smoke.sh                    Task 9  container userns smoke test
```

Before Task 1, create the work branch:

```bash
git switch -c agent/v2-host agent/v2-host-spec
```

---

### Task 1: Preflight play, scaffolding and the unit-test harness

**Files:**
- Create: `ansible/requirements.yml`, `.ansible-lint`, `ansible/site.yml`, `ansible/preflight/inputs.yml`, `ansible/preflight/controller.yml`, `ansible/preflight/port.yml`, `ansible/preflight/target.yml`, `ansible/inventory.example.yml`, `ansible/README.md`, `ansible/tests/unit.yml`, `ansible/tests/unit-inventory.yml`, `ansible/tests/unit/preflight.yml`
- Modify: `package.json` (scripts)

**Interfaces:**
- Produces (facts set by `preflight/inputs.yml`, used by every role and by later preflight files):
  - `forge_ssh_port` (int, default 22);
  - `forge_ssh_allowed_sources` (list, default `[]`);
  - `forge_external_interface` (str, default `""`);
  - `forge_incus_storage_size` (str, default `""`);
  - `forge_incus_storage_source` (str, default `""`);
  - `forge_fail2ban_ignoreip` (list, default `[]`);
  - `forge_admin_user` (str: `ansible_user`, or `$USER` when unset);
  - `forge_user` (dict: the single entry of `forge_users`, with `name` and `ssh_keys`).
- Produces: `ansible_port`, set by `preflight/port.yml` when the inventory does not set it.
- Produces: the unit-test convention. Each case is a host in `ansible/tests/unit-inventory.yml`, so facts never leak between cases. Host vars `unit_expect` (`passed`/`failed`) and `unit_expect_message` give the expected outcome. Template tests run on host `render_local` in group `render` and use absolute paths built from `playbook_dir`.

- [ ] **Step 1: Install the dev tools (once per machine)**

```bash
command -v ansible-lint >/dev/null || brew install ansible-lint   # or: pipx install ansible-lint
ansible --version </dev/null 2>&1 | cat | head -1                 # must show core 2.20 or newer
```

- [ ] **Step 2: Write `ansible/requirements.yml` and install the collections**

```yaml
---
# Controller-side collections for site.yml (sub-project 1), pinned so that a
# run is reproducible. Runtime image builds (sub-project 2) do not use this
# file: they rely on Ubuntu's `ansible` package on the host.
collections:
  - name: devsec.hardening
    version: "11.0.0"   # first release that lists Ubuntu 26.04
  - name: community.general
    version: "13.5.0"
  - name: ansible.posix
    version: "2.2.2"
```

Run: `ansible-galaxy collection install -r ansible/requirements.yml </dev/null 2>&1 | cat`
Expected: `devsec.hardening:11.0.0 was installed successfully` (plus its dependencies community.crypto and community.mysql).

- [ ] **Step 3: Write `.ansible-lint`**

```yaml
---
# ansible-lint configuration, used by CI (job ansible-lint) and by
# `ansible-lint ansible/` locally.
profile: production
exclude_paths:
  - .github/
  - .claude/
  - config/
  - docs/
  - node_modules/
# Files outside the usual roles/ layout: tell ansible-lint what they are.
# The first match wins, so the more specific patterns come first.
kinds:
  - tasks: "**/ansible/preflight/*.yml"
  - tasks: "**/ansible/tests/unit/tasks/*.yml"
  - tasks: "**/ansible/tests/verify/*.yml"
  - playbook: "**/ansible/tests/unit/*.yml"
  - yaml: "**/ansible/tests/unit-inventory.yml"
  - yaml: "**/ansible/inventory.example.yml"
```

- [ ] **Step 4: Write the failing unit test: inventory, preflight cases, entry point**

`ansible/tests/unit-inventory.yml`:

```yaml
---
# Inventory of the controller-only unit tests (ansible/tests/unit.yml). Every
# host is the local machine; each one is a test case with its own variables,
# so facts set by one case never leak into another.
all:
  vars:
    ansible_connection: local
    ansible_python_interpreter: "{{ ansible_playbook_python }}"
  children:
    render:
      hosts:
        render_local: {}
    preflight_cases:
      vars:
        unit_alice:
          name: alice
          ssh_keys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIUnitTestOnly alice@test"]
      hosts:
        preflight_valid:
          ansible_user: ubuntu
          forge_exposure: public
          forge_users: ["{{ unit_alice }}"]
          unit_expect: passed
        preflight_root_admin:
          ansible_user: root
          forge_exposure: public
          forge_users: ["{{ unit_alice }}"]
          unit_expect: failed
          unit_expect_message: not root
        preflight_bad_exposure:
          ansible_user: ubuntu
          forge_exposure: cloud
          forge_users: ["{{ unit_alice }}"]
          unit_expect: failed
          unit_expect_message: forge_exposure
        preflight_no_exposure:
          ansible_user: ubuntu
          forge_users: ["{{ unit_alice }}"]
          unit_expect: failed
          unit_expect_message: forge_exposure
        preflight_two_users:
          ansible_user: ubuntu
          forge_exposure: lan
          forge_users: ["{{ unit_alice }}", {name: bob, ssh_keys: ["ssh-ed25519 AAAA bob@test"]}]
          unit_expect: failed
          unit_expect_message: exactly one
        preflight_user_is_admin:
          ansible_user: alice
          forge_exposure: lan
          forge_users: ["{{ unit_alice }}"]
          unit_expect: failed
          unit_expect_message: different from ansible_user
        preflight_no_keys:
          ansible_user: ubuntu
          forge_exposure: lan
          forge_users: [{name: alice, ssh_keys: []}]
          unit_expect: failed
          unit_expect_message: ssh_keys
        preflight_bad_port:
          ansible_user: ubuntu
          forge_exposure: lan
          forge_users: ["{{ unit_alice }}"]
          forge_ssh_port: 70000
          unit_expect: failed
          unit_expect_message: forge_ssh_port
        preflight_sources_not_list:
          ansible_user: ubuntu
          forge_exposure: lan
          forge_users: ["{{ unit_alice }}"]
          forge_ssh_allowed_sources: 192.0.2.0/24
          unit_expect: failed
          unit_expect_message: must be lists
    port_cases:
      hosts:
        port_explicit:
          ansible_host: 127.0.0.1
          ansible_port: 60022
          forge_ssh_port: 2222
          unit_expect_port: 60022
        port_closed:
          ansible_host: 127.0.0.1
          forge_ssh_port: 1
          unit_expect_port: 22
```

`ansible/tests/unit/preflight.yml`:

```yaml
---
- name: Preflight input checks
  hosts: preflight_cases
  gather_facts: false
  tasks:
    - name: Run the input checks
      block:
        - name: Include the input checks
          ansible.builtin.include_tasks: "{{ playbook_dir }}/../../preflight/inputs.yml"
        - name: Record success
          ansible.builtin.set_fact:
            unit_outcome: passed
      rescue:
        - name: Record failure
          ansible.builtin.set_fact:
            unit_outcome: failed
            unit_message: "{{ ansible_failed_result.msg | default('') }}"

    - name: Check the outcome
      ansible.builtin.assert:
        that:
          - unit_outcome == unit_expect
          - unit_expect == 'passed' or unit_expect_message in unit_message
        fail_msg: >-
          {{ inventory_hostname }}: expected {{ unit_expect }}
          ({{ unit_expect_message | default('') }}), got {{ unit_outcome }}:
          {{ unit_message | default('') }}

    - name: Check the optional variables got their defaults
      ansible.builtin.assert:
        that:
          - forge_ssh_port == 22
          - forge_ssh_allowed_sources == []
          - forge_external_interface == ''
          - forge_incus_storage_size == ''
          - forge_incus_storage_source == ''
          - forge_fail2ban_ignoreip == []
          - forge_admin_user == 'ubuntu'
          - forge_user.name == 'alice'
      when: inventory_hostname == 'preflight_valid'

- name: SSH port resolution
  hosts: port_cases
  gather_facts: false
  tasks:
    - name: Resolve the port
      ansible.builtin.include_tasks: "{{ playbook_dir }}/../../preflight/port.yml"

    - name: Check the resolved port
      ansible.builtin.assert:
        that:
          - ansible_port | int == unit_expect_port
        fail_msg: "{{ inventory_hostname }}: expected port {{ unit_expect_port }}, got {{ ansible_port }}"
```

`ansible/tests/unit.yml`:

```yaml
---
# Controller-only unit tests of the host playbook: input checks, computed
# variables and rendered templates. No target machine is involved.
#   ansible-playbook -i ansible/tests/unit-inventory.yml ansible/tests/unit.yml
- name: Preflight
  ansible.builtin.import_playbook: unit/preflight.yml
```

- [ ] **Step 5: Run the unit tests to verify they fail**

Run: `ansible-playbook -i ansible/tests/unit-inventory.yml ansible/tests/unit.yml </dev/null 2>&1 | cat`
Expected: FAIL. `preflight_valid` reports `unit_outcome == unit_expect` false (the include fails because `ansible/preflight/inputs.yml` does not exist), and the port cases fail on the missing `port.yml`.

- [ ] **Step 6: Write the preflight task files**

`ansible/preflight/inputs.yml`:

```yaml
---
# Validates the inventory's user-facing variables and normalizes the optional
# ones to their defaults, as facts. Every forge_* variable the roles read is
# listed here: this file is the single reference for their defaults.
- name: Normalize the optional variables to their defaults
  ansible.builtin.set_fact:
    forge_ssh_port: "{{ forge_ssh_port | default(22) | int }}"
    forge_ssh_allowed_sources: "{{ forge_ssh_allowed_sources | default([]) }}"
    forge_external_interface: "{{ forge_external_interface | default('') }}"
    forge_incus_storage_size: "{{ forge_incus_storage_size | default('') }}"
    forge_incus_storage_source: "{{ forge_incus_storage_source | default('') }}"
    forge_fail2ban_ignoreip: "{{ forge_fail2ban_ignoreip | default([]) }}"
    forge_admin_user: "{{ ansible_user | default(lookup('ansible.builtin.env', 'USER')) }}"

- name: Check forge_exposure
  ansible.builtin.assert:
    that:
      - forge_exposure is defined
      - forge_exposure in ['public', 'lan', 'local']
    fail_msg: "forge_exposure must be public, lan or local (got: {{ forge_exposure | default('nothing') }})."
    quiet: true

- name: Check the admin account
  ansible.builtin.assert:
    that:
      - forge_admin_user != 'root'
    fail_msg: >-
      ansible_user must be the machine's sudo account, not root: the playbook
      sets PermitRootLogin no, which would lock the next run out.
    quiet: true

- name: Check forge_users
  ansible.builtin.assert:
    that:
      - forge_users is defined
      - forge_users is sequence
      - forge_users is not string
      - forge_users | length == 1
    fail_msg: >-
      forge_users must list exactly one user in v2.0: several forge users
      would share one Incus project and bridge.
    quiet: true

- name: Check the forge user
  ansible.builtin.assert:
    that:
      - forge_users[0].name is defined
      - forge_users[0].name is match('^[a-z_][a-z0-9_-]*$')
      - forge_users[0].name != forge_admin_user
      - forge_users[0].ssh_keys | default([]) | length > 0
    fail_msg: >-
      forge_users[0] needs a valid name, different from ansible_user
      ({{ forge_admin_user }}), and at least one entry in ssh_keys.
    quiet: true

- name: Check the optional variables
  ansible.builtin.assert:
    that:
      - forge_ssh_port | int >= 1
      - forge_ssh_port | int <= 65535
      - forge_ssh_allowed_sources is sequence
      - forge_ssh_allowed_sources is not string
      - forge_fail2ban_ignoreip is sequence
      - forge_fail2ban_ignoreip is not string
    fail_msg: >-
      forge_ssh_port must be 1-65535; forge_ssh_allowed_sources and
      forge_fail2ban_ignoreip must be lists.
    quiet: true

- name: Remember the forge user
  ansible.builtin.set_fact:
    forge_user: "{{ forge_users[0] }}"
```

`ansible/preflight/controller.yml`:

```yaml
---
# Checks the controller: a recent enough ansible-core, and a git checkout of
# the repository (forge is deployed from its HEAD by the forge_users role).
- name: Check the controller's ansible-core version
  ansible.builtin.assert:
    that:
      - ansible_version.full is version('2.20', '>=')
    fail_msg: "ansible-core 2.20 or newer is required on the controller (found {{ ansible_version.full }})."
    quiet: true
  run_once: true

- name: Check the playbook runs from a git checkout
  ansible.builtin.command:
    cmd: git -C "{{ playbook_dir | dirname }}" rev-parse --show-toplevel
  delegate_to: localhost
  become: false
  run_once: true
  changed_when: false
```

`ansible/preflight/port.yml`:

```yaml
---
# Picks the port Ansible connects to. An explicit ansible_port (Lima's
# forwarded port, for instance) is used as is. Otherwise the controller probes
# forge_ssh_port with a bare TCP connect (no authentication, so fail2ban never
# counts it) and falls back to 22, where sshd still listens before the first
# run moves it.
- name: Probe forge_ssh_port from the controller
  when: ansible_port is not defined
  block:
    - name: Wait briefly for forge_ssh_port
      ansible.builtin.wait_for:
        host: "{{ ansible_host | default(inventory_hostname) }}"
        port: "{{ forge_ssh_port }}"
        timeout: 5
      delegate_to: localhost
      become: false

    - name: Connect on forge_ssh_port
      ansible.builtin.set_fact:
        ansible_port: "{{ forge_ssh_port }}"
  rescue:
    - name: Connect on 22 (first run, sshd has not moved yet)
      ansible.builtin.set_fact:
        ansible_port: 22
```

`ansible/preflight/target.yml`:

```yaml
---
- name: Gather the target's facts
  ansible.builtin.setup:

- name: Check the target is Ubuntu 26.04
  ansible.builtin.assert:
    that:
      - ansible_facts.distribution == 'Ubuntu'
      - ansible_facts.distribution_release == 'resolute'
    fail_msg: >-
      The host must run Ubuntu 26.04 LTS (found {{ ansible_facts.distribution }}
      {{ ansible_facts.distribution_version }}).
    quiet: true
```

- [ ] **Step 7: Run the unit tests to verify they pass**

Run: `ansible-playbook -i ansible/tests/unit-inventory.yml ansible/tests/unit.yml </dev/null 2>&1 | cat`
Expected: PASS. `failed=0` for every host in the PLAY RECAP; the failing cases show `rescued=1`.

- [ ] **Step 8: Write `ansible/site.yml` (preflight play only for now)**

```yaml
---
# Provisions an agent-forge host (v2, sub-project 1). Run from a git checkout,
# on the controller:
#   ansible-galaxy collection install -r ansible/requirements.yml
#   ansible-playbook -i inventory.yml ansible/site.yml
# See ansible/README.md and ansible/inventory.example.yml.
- name: Preflight
  hosts: all
  gather_facts: false
  tasks:
    - name: Check and normalize the inventory's variables
      ansible.builtin.import_tasks: preflight/inputs.yml
    - name: Check the controller
      ansible.builtin.import_tasks: preflight/controller.yml
    - name: Resolve the SSH port to connect to
      ansible.builtin.import_tasks: preflight/port.yml
    - name: Check the target
      ansible.builtin.import_tasks: preflight/target.yml
```

- [ ] **Step 9: Write `ansible/inventory.example.yml`**

```yaml
---
# Example inventory for ansible/site.yml. Copy it outside the repository (it
# names your host and keys), adjust it, then run:
#   ansible-playbook -i inventory.yml ansible/site.yml
all:
  hosts:
    forge-vm:
      ansible_host: 203.0.113.10
      # The admin: the machine's existing sudo account (ubuntu on cloud
      # images, the account created at install on bare metal). Never root:
      # the playbook sets PermitRootLogin no. Its keys and sudo are left alone.
      ansible_user: ubuntu
      # sshd allows 2 authentication attempts (MaxAuthTries 2), which an agent
      # holding several keys can use up: offer only this key.
      # ansible_ssh_private_key_file: ~/.ssh/id_ed25519
      # ansible_ssh_common_args: -o IdentitiesOnly=yes
      # Only when the port Ansible connects to differs from forge_ssh_port
      # (Lima forwards a local port to the VM's sshd).
      # ansible_port: 60022
      # Only if the admin's sudo asks for a password and ansible-core < 2.22:
      # Ubuntu 26.04's sudo-rs rewrites the prompt Ansible waits for, so use
      # the C sudo that 26.04 still ships as sudo.ws. Keep the password in an
      # ansible-vault file (ansible_become_password), never in plain text.
      # ansible_become_exe: sudo.ws
  vars:
    # public: cloud VM with a public IP. lan: homelab or LAN machine.
    # local: Lima VM on a Mac.
    forge_exposure: public
    # Exactly one user in v2.0. ssh_keys is authoritative: keys added by hand
    # to the user's authorized_keys are removed on the next run.
    forge_users:
      - name: alice
        ssh_keys:
          - "ssh-ed25519 AAAA... alice@laptop"
    # Optional; the values shown are the defaults.
    # Port sshd listens on. The first run connects on 22 and moves sshd here.
    # forge_ssh_port: 22
    # CIDRs (IPv4 and/or IPv6) allowed to reach SSH; [] means anywhere.
    # Include the controller's own address, or the next run is locked out.
    # forge_ssh_allowed_sources: []
    # "" means the interface of the default IPv4 route (wlo1 on WiFi, ...).
    # forge_external_interface: ""
    # Size of the Incus pool's loop file, e.g. "100GiB". "" means about 80 %
    # of the free space, computed once, when the pool is created.
    # forge_incus_storage_size: ""
    # A disk or partition for the pool instead of a loop file, e.g. /dev/vdb.
    # forge_incus_storage_source: ""
    # Extra addresses fail2ban never bans.
    # forge_fail2ban_ignoreip: []
```

- [ ] **Step 10: Write `ansible/README.md`**

````markdown
# Host playbook

`site.yml` provisions an agent-forge host: a fresh Ubuntu 26.04 machine, VM or
bare metal. It hardens the OS (devsec.hardening), installs a native nftables
firewall, fail2ban, and Incus 7.0 LTS with a btrfs storage pool. It also sets
up one forge user with Node 24, Claude Code, Ansible and `forge`. Everything
inside Incus (project, bridge, profiles, image) is `forge setup`'s job. Design:
`docs/superpowers/specs/2026-10-15-v2-host-ansible-design.md`.

## Running it

On the controller (your machine), from a git checkout of this repository.
`forge` is deployed from the checkout's HEAD.

```bash
ansible-galaxy collection install -r ansible/requirements.yml
cp ansible/inventory.example.yml ~/forge-inventory.yml   # then edit it
ansible-playbook -i ~/forge-inventory.yml ansible/site.yml
```

- **Requirements.** The controller needs ansible-core 2.20 or newer and git.
- **Account.** Ansible connects as the machine's existing sudo account
  (`ansible_user`), never as root.
- **Port.** The first run connects on port 22 and moves sshd to
  `forge_ssh_port`. Later runs connect there directly.
- **sudo password.** Ubuntu 26.04's sudo is sudo-rs. A passwordless sudo admin
  needs nothing. With a password (`-K`, or `ansible_become_password` in an
  ansible-vault file), Ansible's become times out until ansible-core 2.22
  (ansible/ansible#85837). Set `ansible_become_exe: sudo.ws` to use the C sudo
  that 26.04 still ships. The host's own `sudo` stays sudo-rs.
- **Several keys in your agent.** sshd allows two authentication attempts. Give
  the host an `IdentityFile` and `IdentitiesOnly yes` in `~/.ssh/config`, and
  `ansible_ssh_common_args: -o IdentitiesOnly=yes` in the inventory.

## Tests

```bash
npm run test:ansible     # controller-only unit tests, no target machine
ansible-lint ansible/    # profile production (.ansible-lint)
```
````

- [ ] **Step 11: Add the `test:ansible` script to `package.json`**

In `"scripts"`, after `"test:integration"`, add:

```json
    "test:ansible": "ansible-playbook -i ansible/tests/unit-inventory.yml ansible/tests/unit.yml",
```

- [ ] **Step 12: Lint and syntax-check**

Run: `ansible-playbook --syntax-check -i ansible/inventory.example.yml ansible/site.yml </dev/null 2>&1 | cat`
Expected: `playbook: ansible/site.yml`

Run: `ansible-lint ansible/ </dev/null 2>&1 | cat`
Expected: `Passed: 0 failure(s), 0 warning(s)` (on profile `production`). Fix any finding. Use a `# noqa` only with its reason on the comment line above the task.

Run: `npm run test:ansible </dev/null 2>&1 | cat`
Expected: PASS, as in Step 7.

- [ ] **Step 13: Commit** (ask the user to be at the YubiKey first)

```bash
git add .ansible-lint package.json ansible/requirements.yml ansible/site.yml ansible/preflight ansible/inventory.example.yml ansible/README.md ansible/tests/unit.yml ansible/tests/unit-inventory.yml ansible/tests/unit/preflight.yml
git commit -m "feat: preflight du playbook hôte v2 et tests unitaires Ansible"
```

---

### Task 2: Throwaway-VM harness and platform checks

**Files:**
- Create: `ansible/tests/vm-test.sh`, `ansible/tests/verify.yml`, `ansible/tests/verify/platform.yml`
- Modify: `ansible/README.md` (new section "VM test")

**Interfaces:**
- Consumes:
  - from Task 1, `ansible/site.yml`, `ansible/requirements.yml`, and the `forge_*` variables;
  - from the generated inventory, `ansible_host`, `ansible_user`, `forge_ssh_port`, `forge_exposure`, `forge_users`.
- Produces, used by every later `verify/*.yml`:
  - `verify.yml` play vars:
    - `verify_ssh`: base ssh command, fresh connection, throwaway `known_hosts`, `-p {{ forge_ssh_port }}`;
    - `verify_ssh_forge`: `verify_ssh` plus the forge key, ending with `forgetest@<ip>`;
    - `verify_ssh_admin`: the same for the admin.
  - Extra vars from `vm-test.sh`:
    - `verify_work` (temp dir holding the `admin`, `forge` and `known_hosts` files);
    - `verify_negative_auth` (`true` on the first verify, `false` after the reboot);
    - `ansible_port` (`2222`).
  - The harness's throwaway `ssh-agent` holds the forge key, with comment `vm-test-forge`; its `SSH_AUTH_SOCK` is exported to Ansible.
  - `verify.yml` imports its files in this order: `platform`, `base`, `hardening`, `ssh_client`, `firewall`, `fail2ban`, `incus`, `forge_users`. Each later task inserts its line at that position.

- [ ] **Step 1: Write the platform checks (`ansible/tests/verify/platform.yml`)**

```yaml
---
- name: Check the host runs Ubuntu 26.04
  ansible.builtin.assert:
    that:
      - ansible_facts.distribution == 'Ubuntu'
      - ansible_facts.distribution_release == 'resolute'
    quiet: true

- name: Read sudo's version
  ansible.builtin.command:
    cmd: sudo --version
  become: false
  register: verify_sudo_version
  changed_when: false

- name: Read ls's version
  ansible.builtin.command:
    cmd: ls --version
  register: verify_ls_version
  changed_when: false

- name: Check the host runs sudo-rs and uutils, as Ubuntu 26.04 ships them
  ansible.builtin.assert:
    that:
      - "'sudo-rs' in verify_sudo_version.stdout"
      - "'uutils' in verify_ls_version.stdout"
    fail_msg: >-
      This test must run against sudo-rs and Rust coreutils; got
      "{{ verify_sudo_version.stdout_lines | first }}" and
      "{{ verify_ls_version.stdout_lines | first }}".
```

- [ ] **Step 2: Write `ansible/tests/verify.yml`**

```yaml
---
# Assertions against a host provisioned by site.yml. vm-test.sh runs this
# after the two provisioning runs and again after a reboot, with the
# generated inventory and these extra vars:
#   ansible_port          forge_ssh_port (sshd has moved there)
#   verify_work           the harness's temporary directory (keys, known_hosts)
#   verify_negative_auth  true to run the deliberate authentication failures
- name: Verify the provisioned host
  hosts: all
  become: true
  gather_facts: true
  vars:
    # Every SSH check opens a fresh connection: a multiplexed one would hide
    # sshd changes (validation spike, finding D).
    verify_ssh: >-
      ssh -F none -o BatchMode=yes -o ConnectTimeout=10
      -o ControlMaster=no -o ControlPath=none -o IdentitiesOnly=yes
      -o HostKeyAlgorithms=ssh-ed25519
      -o UserKnownHostsFile={{ verify_work }}/known_hosts
      -o StrictHostKeyChecking=accept-new -p {{ forge_ssh_port }}
    verify_ssh_forge: "{{ verify_ssh }} -i {{ verify_work }}/forge {{ forge_users[0].name }}@{{ ansible_host }}"
    verify_ssh_admin: "{{ verify_ssh }} -i {{ verify_work }}/admin {{ ansible_user }}@{{ ansible_host }}"
  tasks:
    - name: Platform
      ansible.builtin.import_tasks: verify/platform.yml
```

- [ ] **Step 3: Syntax-check verify.yml**

Run: `ansible-playbook --syntax-check -i ansible/inventory.example.yml ansible/tests/verify.yml </dev/null 2>&1 | cat`
Expected: `playbook: ansible/tests/verify.yml`

- [ ] **Step 4: Write `ansible/tests/vm-test.sh`**

```bash
#!/bin/bash
# Throwaway-VM test of ansible/site.yml (agent-forge v2, sub-project 1).
#
# Creates a VM on this LXD or Incus host, provisions it twice with site.yml
# (the second run must change nothing), runs tests/verify.yml, reboots the VM,
# verifies again, then deletes the VM. Runs on omen today, from a clone of
# `next` kept apart from the v1 clone. A v1 agent container cannot run it: it
# has no access to the host's LXD and cannot run a VM.
#
# Usage: ansible/tests/vm-test.sh [--exposure public|lan|local] [--keep]
set -e
set -o pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPOSURE="public"
KEEP=0
FORGE_SSH_PORT=2222   # moves sshd away from 22, so the port change is exercised

die() { echo "vm-test: $*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --exposure) EXPOSURE="${2:-}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) die "usage: $0 [--exposure public|lan|local] [--keep]" ;;
  esac
done
case "$EXPOSURE" in
  public|lan|local) ;;
  *) die "--exposure must be public, lan or local" ;;
esac

# --- Preconditions ---------------------------------------------------------
if command -v incus >/dev/null 2>&1; then
  CLI=incus
  IMAGE="images:ubuntu/26.04/cloud"
elif command -v lxc >/dev/null 2>&1; then
  CLI=lxc
  IMAGE="ubuntu:26.04"
else
  die "needs lxc (LXD) or incus on this host"
fi
[ -e /dev/kvm ] || die "/dev/kvm is missing: this host cannot run VMs"
for tool in ansible-playbook ansible-galaxy git ssh ssh-keygen ssh-agent ssh-add; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is missing"
done
# ansible-core >= 2.20; Ubuntu 24.04's apt ships 2.16 (pipx install ansible-core).
read -r major minor <<<"$(ansible-playbook --version | sed -nE '1s/.*core ([0-9]+)\.([0-9]+).*/\1 \2/p')"
if [ -z "$major" ] || [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt 20 ]; }; then
  die "ansible-core >= 2.20 is required ($(ansible-playbook --version | head -1)); try: pipx install ansible-core"
fi

# --- Throwaway material ----------------------------------------------------
WORK="$(mktemp -d)"
VM="forge-host-test-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
AGENT_PID=""
cleanup() {
  if [ -n "$AGENT_PID" ]; then kill "$AGENT_PID" 2>/dev/null || true; fi
  if [ "$KEEP" -eq 1 ]; then
    echo "vm-test: kept VM $VM and $WORK"
  else
    "$CLI" delete --force "$VM" >/dev/null 2>&1 || true
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

ssh-keygen -q -t ed25519 -N "" -C "vm-test-admin" -f "$WORK/admin"
ssh-keygen -q -t ed25519 -N "" -C "vm-test-forge" -f "$WORK/forge"
: > "$WORK/known_hosts"
# The forge key goes into a throwaway agent, so that verify.yml can check
# that agent forwarding reaches the forge user and is refused to the admin.
eval "$(ssh-agent -s)" >/dev/null
AGENT_PID="$SSH_AGENT_PID"
ssh-add -q "$WORK/forge"

export ANSIBLE_COLLECTIONS_PATH="$WORK/collections"
ansible-galaxy collection install -r "$REPO/ansible/requirements.yml" -p "$WORK/collections" >/dev/null

# --- VM ----------------------------------------------------------------------
cat > "$WORK/user-data" <<EOF
#cloud-config
ssh_authorized_keys:
  - $(cat "$WORK/admin.pub")
EOF
echo "vm-test: creating $VM from $IMAGE"
"$CLI" launch "$IMAGE" "$VM" --vm \
  -c limits.cpu=2 -c limits.memory=4GiB \
  -c cloud-init.user-data="$(cat "$WORK/user-data")" \
  -d root,size=40GiB

# The VM agent needs a moment before `exec` works.
for _ in $(seq 60); do
  "$CLI" exec "$VM" -- true >/dev/null 2>&1 && break
  sleep 5
done
# cloud-init exits 2 for "done, with recoverable errors": accept 0 and 2.
rc=0
"$CLI" exec "$VM" -- cloud-init status --wait >/dev/null || rc=$?
[ "$rc" -eq 0 ] || [ "$rc" -eq 2 ] || die "cloud-init failed in $VM (exit $rc)"
IP="$("$CLI" list "$VM" --format csv --columns 4 | sed -E 's/ .*//' | head -1)"
[ -n "$IP" ] || die "$VM has no IPv4 address"

wait_ssh() {  # $1 = port; succeeds once the admin can log in on it
  for _ in $(seq 60); do
    if ssh -F none -o BatchMode=yes -o ConnectTimeout=5 -o IdentitiesOnly=yes \
        -o HostKeyAlgorithms=ssh-ed25519 \
        -o UserKnownHostsFile="$WORK/known_hosts" -o StrictHostKeyChecking=accept-new \
        -i "$WORK/admin" -p "$1" "ubuntu@$IP" true 2>/dev/null; then
      return 0
    fi
    sleep 5
  done
  return 1
}
wait_ssh 22 || die "SSH on port 22 never answered"

# --- Inventory -------------------------------------------------------------
# ansible_port is left out on purpose: site.yml must find the port itself.
cat > "$WORK/inventory.yml" <<EOF
all:
  hosts:
    vm:
      ansible_host: "$IP"
      ansible_user: ubuntu
      ansible_ssh_private_key_file: "$WORK/admin"
      ansible_ssh_common_args: >-
        -o IdentitiesOnly=yes -o HostKeyAlgorithms=ssh-ed25519
        -o UserKnownHostsFile=$WORK/known_hosts -o StrictHostKeyChecking=accept-new
  vars:
    forge_exposure: "$EXPOSURE"
    forge_ssh_port: $FORGE_SSH_PORT
    forge_users:
      - name: forgetest
        ssh_keys:
          - "$(cat "$WORK/forge.pub")"
EOF

playbook() { ansible-playbook -i "$WORK/inventory.yml" "$@"; }

echo "vm-test: first run"
playbook "$REPO/ansible/site.yml"

echo "vm-test: second run (must change nothing; only changed tasks are shown)"
ANSIBLE_DISPLAY_OK_HOSTS=false ANSIBLE_DISPLAY_SKIPPED_HOSTS=false \
  playbook "$REPO/ansible/site.yml" | tee "$WORK/second-run.log"
grep -Eq '^vm +: .*changed=0 .*failed=0' "$WORK/second-run.log" \
  || die "the second run changed something (see the tasks above)"

# devsec must not have regenerated the host key: the key sshd showed on 22
# before provisioning is the one it shows on the new port.
key_on() { ssh-keygen -F "$1" -f "$WORK/known_hosts" | grep -v '^#' | awk '{print $3}' | head -1; }
k22="$(key_on "$IP")"
knew="$(key_on "[$IP]:$FORGE_SSH_PORT")"
[ -n "$k22" ] && [ "$k22" = "$knew" ] || die "the host key changed during provisioning"

verify() {  # $1 = true|false: run the deliberate authentication failures
  playbook "$REPO/ansible/tests/verify.yml" \
    -e "ansible_port=$FORGE_SSH_PORT" -e "verify_work=$WORK" -e "verify_negative_auth=$1"
}
echo "vm-test: verify"
verify true

echo "vm-test: reboot"
"$CLI" restart "$VM" --timeout 120 || "$CLI" restart --force "$VM"
wait_ssh "$FORGE_SSH_PORT" || die "SSH on port $FORGE_SSH_PORT never came back after the reboot"
echo "vm-test: verify after reboot"
verify false

echo "vm-test: PASS (exposure $EXPOSURE)"
```

Then: `chmod +x ansible/tests/vm-test.sh`

- [ ] **Step 5: Check the script's syntax**

Run: `bash -n ansible/tests/vm-test.sh && echo OK`
Expected: `OK`

Run, if shellcheck is installed: `shellcheck ansible/tests/vm-test.sh`
Expected: no error-level finding. Fix warnings unless they are false positives on the heredocs.

Run: `ansible/tests/vm-test.sh --exposure nope; echo "rc=$?"`
Expected: `vm-test: --exposure must be public, lan or local` and `rc=1`. The argument check runs before any precondition, so this works on the Mac.

- [ ] **Step 6: Document the VM test in `ansible/README.md`**

Append:

````markdown
## VM test

`tests/vm-test.sh` creates a throwaway VM on an LXD or Incus host with KVM, and
provisions it with this playbook. omen is that host today. The script checks
that a second run changes nothing, runs `tests/verify.yml`, reboots the VM,
verifies again, and deletes the VM. Run it on omen, from a clone of `next` kept
apart from the v1 clone:

```bash
git clone git@github.com:moroine/agent-forge.git ~/src/agent-forge-next   # once
git -C ~/src/agent-forge-next fetch origin
git -C ~/src/agent-forge-next checkout --detach origin/<branch>
~/src/agent-forge-next/ansible/tests/vm-test.sh                    # --exposure public (default)
~/src/agent-forge-next/ansible/tests/vm-test.sh --exposure local   # fail2ban off
```

It needs ansible-core 2.20 or newer (`pipx install ansible-core` on Ubuntu
24.04). `--keep` leaves the VM and its keys in place for debugging. The script
prints where they are.
````

- [ ] **Step 7: Lint**

Run: `ansible-lint ansible/ </dev/null 2>&1 | cat`
Expected: `Passed: 0 failure(s), 0 warning(s)`.

- [ ] **Step 8: Commit** (ask the user to be at the YubiKey first)

```bash
git add ansible/tests/vm-test.sh ansible/tests/verify.yml ansible/tests/verify/platform.yml ansible/README.md
git commit -m "test: harnais de VM jetable pour le playbook hôte"
```

---

### Task 3: Role `base`

**Files:**
- Create: `ansible/roles/base/defaults/main.yml`, `ansible/roles/base/tasks/main.yml`, `ansible/roles/base/tasks/apt_repo.yml`, `ansible/roles/base/templates/52agent-forge-unattended-upgrades.j2`, `ansible/roles/base/files/20auto-upgrades`, `ansible/roles/base/files/journald-agent-forge.conf`, `ansible/roles/base/handlers/main.yml`, `ansible/tests/unit/base.yml`, `ansible/tests/verify/base.yml`
- Modify: `ansible/site.yml` (add the provisioning play), `ansible/tests/unit.yml`, `ansible/tests/verify.yml`

**Interfaces:**
- Produces `base/tasks/apt_repo.yml`, called by Tasks 8 and 9 through `ansible.builtin.include_role: {name: base, tasks_from: apt_repo.yml}`, with these vars:
  - `base_apt_repo_name` (str; names `/etc/apt/keyrings/<name>.asc` and `/etc/apt/sources.list.d/<name>.sources`);
  - `base_apt_repo_key_url` (str);
  - `base_apt_repo_fingerprint` (str, 40 upper-case hex characters, primary key);
  - `base_apt_repo_uris`, `base_apt_repo_suites`, `base_apt_repo_components` (lists);
  - `base_apt_repo_architectures` (list, optional).
- Produces: the provisioning play in `site.yml`, with `become: true`, `gather_facts: false`, `force_handlers: true`, and `module_defaults` setting `apt` `lock_timeout: 600`.

- [ ] **Step 1: Write the failing unit test (`ansible/tests/unit/base.yml`)**

```yaml
---
- name: Base templates
  hosts: render
  gather_facts: false
  vars_files:
    - ../../roles/base/defaults/main.yml
  tasks:
    - name: Create a scratch directory
      ansible.builtin.tempfile:
        state: directory
      register: unit_tmp

    - name: Render the unattended-upgrades file
      ansible.builtin.template:
        src: "{{ playbook_dir }}/../../roles/base/templates/52agent-forge-unattended-upgrades.j2"
        dest: "{{ unit_tmp.path }}/uu"
        mode: "0644"

    - name: Check it covers the three repositories and never reboots
      ansible.builtin.assert:
        that:
          - unit_uu is search('"site=pkgs.zabbly.com";')
          - unit_uu is search('"site=deb.nodesource.com";')
          - unit_uu is search('"site=downloads.claude.ai";')
          - unit_uu is search('Unattended-Upgrade::Automatic-Reboot "false";')
      vars:
        unit_uu: "{{ lookup('ansible.builtin.file', unit_tmp.path ~ '/uu') }}"

    - name: Remove the scratch directory
      ansible.builtin.file:
        path: "{{ unit_tmp.path }}"
        state: absent
```

Append to `ansible/tests/unit.yml`:

```yaml
- name: Base
  ansible.builtin.import_playbook: unit/base.yml
```

- [ ] **Step 2: Run the unit tests to verify they fail**

Run: `npm run test:ansible </dev/null 2>&1 | cat`
Expected: FAIL: the play cannot load `../../roles/base/defaults/main.yml` (file not found).

- [ ] **Step 3: Write the role**

`ansible/roles/base/defaults/main.yml`:

```yaml
---
# python3-debian is required by ansible.builtin.deb822_repository; gpg checks
# the fingerprints of third-party apt keys (tasks/apt_repo.yml).
base_packages:
  - git
  - curl
  - ca-certificates
  - gpg
  - python3-debian
# Third-party repositories that unattended-upgrades keeps current, matched by
# host name ("site"). The spec says "matched by their Release origin", but
# NodeSource's Release file has Origin ". nodistro"; the host name is the one
# stable key for all three.
base_unattended_upgrade_sites:
  - pkgs.zabbly.com
  - deb.nodesource.com
  - downloads.claude.ai
base_sleep_targets:
  - sleep.target
  - suspend.target
  - hibernate.target
  - hybrid-sleep.target
```

`ansible/roles/base/templates/52agent-forge-unattended-upgrades.j2`:

```
// Managed by agent-forge (ansible/roles/base); local changes are overwritten.
// Also upgrade the third-party repositories the playbook adds. Never reboot
// automatically: it would kill the herdr server and every running agent.
Unattended-Upgrade::Origins-Pattern {
{% for site in base_unattended_upgrade_sites %}
        "site={{ site }}";
{% endfor %}
};
Unattended-Upgrade::Automatic-Reboot "false";
```

`ansible/roles/base/files/20auto-upgrades`:

```
// Managed by agent-forge (ansible/roles/base).
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
```

`ansible/roles/base/files/journald-agent-forge.conf`:

```
# Managed by agent-forge (ansible/roles/base): keep logs across reboots, capped.
[Journal]
Storage=persistent
SystemMaxUse=1G
```

`ansible/roles/base/handlers/main.yml`:

```yaml
---
- name: Restart journald
  ansible.builtin.systemd_service:
    name: systemd-journald
    state: restarted
```

`ansible/roles/base/tasks/apt_repo.yml`:

```yaml
---
# Adds a signed third-party apt repository. Called from other roles with
# include_role (tasks_from: apt_repo.yml); inputs are the base_apt_repo_*
# variables listed in the plan. The key's fingerprint is checked against the
# value pinned by the caller, on every run.
- name: Fetch the signing key of {{ base_apt_repo_name }}
  ansible.builtin.get_url:
    url: "{{ base_apt_repo_key_url }}"
    dest: "/etc/apt/keyrings/{{ base_apt_repo_name }}.asc"
    mode: "0644"
    owner: root
    group: root

- name: Read the fingerprints of the key of {{ base_apt_repo_name }}
  ansible.builtin.command:
    cmd: gpg --batch --show-keys --with-colons "/etc/apt/keyrings/{{ base_apt_repo_name }}.asc"
  register: base_apt_repo_gpg
  changed_when: false

- name: Check the key of {{ base_apt_repo_name }} is the pinned one
  ansible.builtin.assert:
    that:
      # A colon-listing fingerprint record: "fpr" + 9 colons + fingerprint + ":".
      - ("fpr:::::::::" ~ base_apt_repo_fingerprint ~ ":") in base_apt_repo_gpg.stdout_lines
    fail_msg: >-
      /etc/apt/keyrings/{{ base_apt_repo_name }}.asc is not the expected key
      ({{ base_apt_repo_fingerprint }}). Remove it only once you know why.
    quiet: true

- name: Add the repository {{ base_apt_repo_name }}
  ansible.builtin.deb822_repository:
    name: "{{ base_apt_repo_name }}"
    types: [deb]
    uris: "{{ base_apt_repo_uris }}"
    suites: "{{ base_apt_repo_suites }}"
    components: "{{ base_apt_repo_components }}"
    architectures: "{{ base_apt_repo_architectures | default(omit) }}"
    signed_by: "/etc/apt/keyrings/{{ base_apt_repo_name }}.asc"
  register: base_apt_repo_source

# The caller installs from this repository right after: a handler would
# refresh the cache too late.
- name: Refresh the apt cache after adding {{ base_apt_repo_name }}  # noqa: no-handler
  ansible.builtin.apt:
    update_cache: true
  when: base_apt_repo_source is changed
```

`ansible/roles/base/tasks/main.yml`:

```yaml
---
- name: Install the base packages
  ansible.builtin.apt:
    name: "{{ base_packages }}"
    state: present
    update_cache: true
    cache_valid_time: 3600

- name: Create the apt keyrings directory
  ansible.builtin.file:
    path: /etc/apt/keyrings
    state: directory
    mode: "0755"
    owner: root
    group: root

- name: Install unattended-upgrades
  ansible.builtin.apt:
    name: unattended-upgrades
    state: present

- name: Turn the periodic unattended upgrade on
  ansible.builtin.copy:
    src: 20auto-upgrades
    dest: /etc/apt/apt.conf.d/20auto-upgrades
    mode: "0644"
    owner: root
    group: root

- name: Upgrade the added repositories too, never rebooting
  ansible.builtin.template:
    src: 52agent-forge-unattended-upgrades.j2
    dest: /etc/apt/apt.conf.d/52agent-forge-unattended-upgrades
    mode: "0644"
    owner: root
    group: root

- name: Read whether time synchronisation is on
  ansible.builtin.command:
    cmd: timedatectl show --property=NTP --value
  register: base_ntp
  changed_when: false

- name: Turn time synchronisation on
  ansible.builtin.command:
    cmd: timedatectl set-ntp true
  when: base_ntp.stdout != 'yes'
  changed_when: true

- name: Mask the sleep targets (headless host)
  ansible.builtin.systemd_service:
    name: "{{ item }}"
    masked: true
  loop: "{{ base_sleep_targets }}"

- name: Read the default boot target
  ansible.builtin.command:
    cmd: systemctl get-default
  register: base_default_target
  changed_when: false

- name: Boot to multi-user.target
  ansible.builtin.command:
    cmd: systemctl set-default multi-user.target
  when: base_default_target.stdout != 'multi-user.target'
  changed_when: true

- name: Create the journald drop-in directory
  ansible.builtin.file:
    path: /etc/systemd/journald.conf.d
    state: directory
    mode: "0755"
    owner: root
    group: root

- name: Keep the journal across reboots, capped at 1G
  ansible.builtin.copy:
    src: journald-agent-forge.conf
    dest: /etc/systemd/journald.conf.d/agent-forge.conf
    mode: "0644"
    owner: root
    group: root
  notify: Restart journald
```

- [ ] **Step 4: Add the provisioning play to `ansible/site.yml`**

Append:

```yaml

- name: Provision the host
  hosts: all
  become: true
  gather_facts: false   # the preflight play gathered them
  # The sshd restart and the nftables load are handlers: forcing them keeps
  # sshd's port and the firewall in agreement even when a later task fails.
  force_handlers: true
  module_defaults:
    # A fresh cloud VM often runs apt-daily at boot and holds the dpkg lock.
    ansible.builtin.apt:
      lock_timeout: 600
  roles:
    - role: base
```

- [ ] **Step 5: Write the VM checks (`ansible/tests/verify/base.yml`)**

```yaml
---
- name: Read apt's configuration
  ansible.builtin.command:
    cmd: apt-config dump
  register: verify_apt_config
  changed_when: false

- name: Check unattended-upgrades runs and covers the added repositories
  ansible.builtin.assert:
    that:
      - verify_apt_config.stdout is search('APT::Periodic::Unattended-Upgrade "1";')
      - verify_apt_config.stdout is search('site=pkgs.zabbly.com')
      - verify_apt_config.stdout is search('site=deb.nodesource.com')
      - verify_apt_config.stdout is search('site=downloads.claude.ai')
      - verify_apt_config.stdout is search('Unattended-Upgrade::Automatic-Reboot "false";')

# systemd_service cannot report a unit's masked state.
- name: Read the sleep targets' state  # noqa: command-instead-of-module
  ansible.builtin.command:
    cmd: systemctl is-enabled sleep.target suspend.target hibernate.target hybrid-sleep.target
  register: verify_sleep
  changed_when: false
  failed_when: false

- name: Read the default boot target
  ansible.builtin.command:
    cmd: systemctl get-default
  register: verify_default_target
  changed_when: false

- name: Read whether time synchronisation is on
  ansible.builtin.command:
    cmd: timedatectl show --property=NTP --value
  register: verify_ntp
  changed_when: false

- name: Look for the persistent journal
  ansible.builtin.stat:
    path: /var/log/journal
  register: verify_journal_dir

- name: Check the host is headless, keeps its journal and syncs its clock
  ansible.builtin.assert:
    that:
      - verify_sleep.stdout_lines == ['masked', 'masked', 'masked', 'masked']
      - verify_default_target.stdout == 'multi-user.target'
      - verify_ntp.stdout == 'yes'
      - verify_journal_dir.stat.isdir | default(false)
```

In `ansible/tests/verify.yml`, after the `Platform` import, add:

```yaml
    - name: Base
      ansible.builtin.import_tasks: verify/base.yml
```

- [ ] **Step 6: Run the unit tests, the syntax checks and lint**

Run: `npm run test:ansible </dev/null 2>&1 | cat`
Expected: PASS (`failed=0` everywhere).

Run: `ansible-playbook --syntax-check -i ansible/inventory.example.yml ansible/site.yml </dev/null 2>&1 | cat && ansible-playbook --syntax-check -i ansible/inventory.example.yml ansible/tests/verify.yml </dev/null 2>&1 | cat`
Expected: both print `playbook: …`

Run: `ansible-lint ansible/ </dev/null 2>&1 | cat`
Expected: `Passed`. ansible-lint may flag the `base_apt_repo_*` vars that later roles pass to `include_role` (rule `var-naming[no-role-prefix]`). If it does, the fix belongs in those tasks (Tasks 8 and 9), not here.

- [ ] **Step 7: Commit** (ask the user to be at the YubiKey first)

```bash
git add ansible/roles/base ansible/site.yml ansible/tests/unit.yml ansible/tests/unit/base.yml ansible/tests/verify.yml ansible/tests/verify/base.yml
git commit -m "feat: rôle base (mises à jour, horloge, headless, journald)"
```

---

### Task 4: Role `hardening` (devsec.hardening with documented overrides)

**Files:**
- Create: `ansible/roles/hardening/vars/main.yml`, `ansible/roles/hardening/tasks/main.yml`, `ansible/tests/unit/hardening.yml`, `ansible/tests/verify/hardening.yml`, `ansible/tests/verify/ssh_client.yml`
- Modify: `ansible/site.yml` (roles), `ansible/tests/unit.yml`, `ansible/tests/verify.yml`, `ansible/README.md`

**Interfaces:**
- Consumes: `forge_admin_user`, `forge_users`, `forge_ssh_port` (Task 1).
- Produces:
  - `hardening_sysctl_overwrite` (dict);
  - `hardening_ssh_allow_users` (str, space-separated);
  - `hardening_ssh_match_user` (list of `{user, rules}`);
  - devsec's handler `Restart sshd`. It runs right before the firewall's handlers only because `site.yml` imports the roles as ordered `import_role` tasks (final-review fix C2); under `roles:` it would run last.

- [ ] **Step 1: Write the failing unit test (`ansible/tests/unit/hardening.yml`)**

```yaml
---
- name: Hardening overrides
  hosts: render
  gather_facts: false
  vars:
    forge_admin_user: ubuntu
    forge_users: [{name: alice, ssh_keys: ["ssh-ed25519 AAAA alice@test"]}]
  vars_files:
    - ../../roles/hardening/vars/main.yml
  tasks:
    - name: Check the sysctl overrides
      ansible.builtin.assert:
        that:
          - hardening_sysctl_overwrite == unit_expected_sysctls
      vars:
        unit_expected_sysctls:
          net.ipv4.ip_forward: 1
          kernel.unprivileged_userns_clone: 1
          kernel.apparmor_restrict_unprivileged_userns: 0
          kernel.yama.ptrace_scope: 1

    - name: Check who may log in, and who gets agent forwarding
      ansible.builtin.assert:
        that:
          - hardening_ssh_allow_users == 'ubuntu alice'
          - hardening_ssh_match_user == [{'user': 'alice', 'rules': ['AllowAgentForwarding yes']}]
```

Append to `ansible/tests/unit.yml`:

```yaml
- name: Hardening
  ansible.builtin.import_playbook: unit/hardening.yml
```

- [ ] **Step 2: Run the unit tests to verify they fail**

Run: `npm run test:ansible </dev/null 2>&1 | cat`
Expected: FAIL: the play cannot load `../../roles/hardening/vars/main.yml` (file not found).

- [ ] **Step 3: Write the role**

`ansible/roles/hardening/vars/main.yml`:

```yaml
---
# Overrides of devsec.hardening 11.0.0. Everything not listed keeps the
# upstream default on purpose (sub-project 1 spec, "Role hardening").
hardening_sysctl_overwrite:
  # Incus's NAT bridge routes container traffic.
  net.ipv4.ip_forward: 1
  # devsec's Ubuntu vars set 0: an unprivileged user inside a container could
  # then not create a user namespace (Chrome's sandbox, rootless Docker).
  kernel.unprivileged_userns_clone: 1
  # Same breakage, from Ubuntu's AppArmor mediation (validation spike,
  # point 6). v1 on omen runs with 0 too: the LXD snap sets it host-wide.
  kernel.apparmor_restrict_unprivileged_userns: 0
  # Ubuntu's default. devsec's 2, with sys_ptrace dropped from containers,
  # leaves no strace or gdb at all inside containers.
  kernel.yama.ptrace_scope: 1
# Nobody but the admin and the forge user logs in.
hardening_ssh_allow_users: "{{ ([forge_admin_user] + forge_users | map(attribute='name') | list) | join(' ') }}"
# Agent forwarding only for the forge user, for host-side git clone and fetch.
# herdr itself needs no forwarding at all (validation spike, point 3).
hardening_ssh_match_user:
  - user: "{{ forge_users | map(attribute='name') | join(',') }}"
    rules:
      - AllowAgentForwarding yes
```

`ansible/roles/hardening/tasks/main.yml`:

```yaml
---
- name: Harden the OS with devsec.hardening.os_hardening
  ansible.builtin.import_role:
    name: devsec.hardening.os_hardening
  vars:
    sysctl_overwrite: "{{ hardening_sysctl_overwrite }}"
    # UFW is not used: the firewall role runs native nftables.
    ufw_manage_defaults: false

- name: Harden sshd with devsec.hardening.ssh_hardening
  ansible.builtin.import_role:
    name: devsec.hardening.ssh_hardening
  vars:
    ssh_server_ports: ["{{ forge_ssh_port }}"]
    ssh_allow_users: "{{ hardening_ssh_allow_users }}"
    ssh_permit_root_login: "no"
    ssh_allow_agent_forwarding: false
    ssh_server_match_user: "{{ hardening_ssh_match_user }}"
    # devsec does not template this one, and OpenSSH defaults it to yes.
    sshd_custom_options:
      - AllowStreamLocalForwarding no
    # Keep Ubuntu's ed25519 host key. Otherwise devsec regenerates the RSA key
    # (Ubuntu's is 3072 bits, devsec wants 4096) and clients see a new key.
    ssh_host_key_files:
      - /etc/ssh/ssh_host_ed25519_key
```

If `ansible-lint` flags the devsec variable names (`var-naming[no-role-prefix]`), add `# noqa: var-naming[no-role-prefix]` at the end of the task's `name:` line, with the comment line `# devsec.hardening's own variable names, passed to its roles.` just above the task.

In `ansible/site.yml`, under `roles:`, after `- role: base`, add:

```yaml
    - role: hardening
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `npm run test:ansible </dev/null 2>&1 | cat`
Expected: PASS.

- [ ] **Step 5: Write the VM checks**

`ansible/tests/verify/hardening.yml`:

```yaml
---
- name: Validate sshd's configuration
  ansible.builtin.command:
    cmd: sshd -t
  changed_when: false

- name: Read sshd's effective configuration
  ansible.builtin.command:
    cmd: sshd -T
  register: verify_sshd
  changed_when: false

- name: Read sshd's effective configuration for the forge user
  ansible.builtin.command:
    cmd: sshd -T -C user={{ forge_users[0].name }},host=verify.invalid,addr=192.0.2.1
  register: verify_sshd_forge
  changed_when: false

- name: Check sshd's settings
  ansible.builtin.assert:
    that:
      - verify_cfg.port == forge_ssh_port | string
      - verify_cfg.permitrootlogin == 'no'
      - verify_cfg.passwordauthentication == 'no'
      - verify_cfg.allowtcpforwarding == 'no'
      - verify_cfg.allowstreamlocalforwarding == 'no'
      - verify_cfg.allowagentforwarding == 'no'
      - verify_cfg.x11forwarding == 'no'
      - verify_cfg.permittunnel == 'no'
      - verify_cfg.hostkey == '/etc/ssh/ssh_host_ed25519_key'
      - verify_cfg_forge.allowagentforwarding == 'yes'
  vars:
    verify_cfg: "{{ dict(verify_sshd.stdout_lines | map('split', ' ', 1)) }}"
    verify_cfg_forge: "{{ dict(verify_sshd_forge.stdout_lines | map('split', ' ', 1)) }}"

- name: Read the kernel settings the hardening role overrides
  ansible.builtin.command:
    cmd: sysctl -n net.ipv4.ip_forward kernel.apparmor_restrict_unprivileged_userns kernel.yama.ptrace_scope
  register: verify_sysctls
  changed_when: false

- name: Read kernel.unprivileged_userns_clone, which not every kernel has
  ansible.builtin.command:
    cmd: sysctl -n kernel.unprivileged_userns_clone
  register: verify_userns_clone
  changed_when: false
  failed_when: false

- name: Read /proc's mount options
  ansible.builtin.command:
    cmd: findmnt --noheadings --output OPTIONS /proc
  register: verify_proc_options
  changed_when: false

- name: Read logind's KillUserProcesses
  ansible.builtin.command:
    cmd: busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager KillUserProcesses
  register: verify_kill_user_processes
  changed_when: false

- name: Check the kernel settings, /proc's hidepid and logind
  ansible.builtin.assert:
    that:
      - verify_sysctls.stdout_lines == ['1', '0', '1']
      - verify_userns_clone.rc != 0 or verify_userns_clone.stdout == '1'
      - verify_proc_options.stdout is search('hidepid=(2|invisible)')
      # The herdr server must survive logout (validation spike, finding E).
      - verify_kill_user_processes.stdout == 'b false'
```

`ansible/tests/verify/ssh_client.yml`:

```yaml
---
# SSH checks from the controller, each on a fresh connection.
- name: Check root cannot log in
  ansible.builtin.command:
    cmd: "{{ verify_ssh }} -i {{ verify_work }}/admin root@{{ ansible_host }} true"
  delegate_to: localhost
  become: false
  register: verify_root_login
  changed_when: false
  failed_when: verify_root_login.rc == 0
  # A deliberate authentication failure; only on the first verify, so that
  # the run stays below public's maxretry of 3 (fail2ban).
  when: verify_negative_auth | default(false) | bool

- name: Check sshd no longer answers on port 22
  ansible.builtin.wait_for:
    host: "{{ ansible_host }}"
    port: 22
    state: stopped
    timeout: 10
  delegate_to: localhost
  become: false
  when: forge_ssh_port | int != 22

- name: Check agent forwarding is refused to the admin
  ansible.builtin.command:
    cmd: >-
      {{ verify_ssh }} -A -i {{ verify_work }}/admin
      {{ ansible_user }}@{{ ansible_host }} 'test -z "$SSH_AUTH_SOCK"'
  delegate_to: localhost
  become: false
  changed_when: false
```

In `ansible/tests/verify.yml`, after the `Base` import, add:

```yaml
    - name: Hardening
      ansible.builtin.import_tasks: verify/hardening.yml
    - name: SSH from the controller
      ansible.builtin.import_tasks: verify/ssh_client.yml
```

- [ ] **Step 6: Document the hardening choices in `ansible/README.md`**

Append:

```markdown
## Hardening choices

`roles/hardening` applies devsec.hardening 11.0.0 (`os_hardening`,
`ssh_hardening`). Every upstream default is kept, except these:

- **Sysctls.**
  - `net.ipv4.ip_forward=1`, for the Incus bridge.
  - `kernel.unprivileged_userns_clone=1` and
    `kernel.apparmor_restrict_unprivileged_userns=0`, for user namespaces
    inside containers (Chrome's sandbox, rootless Docker).
  - `kernel.yama.ptrace_scope=1`, Ubuntu's default, so strace and gdb work in
    containers.
- **UFW.** `ufw_manage_defaults: false`, since nftables is used instead.
- **sshd.**
  - The port is `forge_ssh_port`, and `AllowUsers` lists the admin and the
    forge user.
  - Agent forwarding is allowed for the forge user only, and
    `AllowStreamLocalForwarding no`.
  - The ed25519 host key is the only host key.
```

- [ ] **Step 7: Syntax-check and lint**

Run: `ansible-playbook --syntax-check -i ansible/inventory.example.yml ansible/site.yml </dev/null 2>&1 | cat && ansible-playbook --syntax-check -i ansible/inventory.example.yml ansible/tests/verify.yml </dev/null 2>&1 | cat`
Expected: both print `playbook: …`. This also proves the devsec roles resolve from the installed collection.

Run: `ansible-lint ansible/ </dev/null 2>&1 | cat`
Expected: `Passed`.

- [ ] **Step 8: Commit** (ask the user to be at the YubiKey first)

```bash
git add ansible/roles/hardening ansible/site.yml ansible/tests/unit.yml ansible/tests/unit/hardening.yml ansible/tests/verify.yml ansible/tests/verify/hardening.yml ansible/tests/verify/ssh_client.yml ansible/README.md
git commit -m "feat: rôle hardening (devsec.hardening et surcharges documentées)"
```

---

### Task 5: Role `firewall` (nftables, own table)

**Files:**
- Create: `ansible/roles/firewall/defaults/main.yml`, `ansible/roles/firewall/tasks/main.yml`, `ansible/roles/firewall/tasks/check_interface.yml`, `ansible/roles/firewall/templates/nftables.conf.j2`, `ansible/roles/firewall/files/nftables-agent-forge.conf`, `ansible/roles/firewall/handlers/main.yml`, `ansible/tests/unit/firewall.yml`, `ansible/tests/unit/tasks/firewall_case.yml`, `ansible/tests/verify/firewall.yml`
- Modify: `ansible/site.yml` (roles), `ansible/tests/unit.yml`, `ansible/tests/verify.yml`

**Interfaces:**
- Consumes: `forge_exposure`, `forge_ssh_port`, `forge_ssh_allowed_sources`, `forge_external_interface`, `ansible_facts.default_ipv4`.
- Produces: role defaults, all lazily templated so that unit tests can render them:
  - `firewall_bridge` (`forgebr0`);
  - `firewall_ssh_rate` (`10/minute`), `firewall_ssh_burst` (`5`);
  - `firewall_external_interface` (str);
  - `firewall_allowed_v4`, `firewall_allowed_v6` (lists);
  - `firewall_rate_limit` (bool).
- Produces: handlers `Reload systemd units` and `Load the host firewall`.

- [ ] **Step 1: Write the failing unit test**

`ansible/tests/unit/firewall.yml`:

```yaml
---
- name: Firewall template and interface check
  hosts: render
  gather_facts: false
  # vars_files, not include_vars: its lower precedence lets each case's task
  # vars (forge_exposure, forge_ssh_allowed_sources, ...) win.
  vars_files:
    - ../../roles/firewall/defaults/main.yml
  tasks:
    - name: Create a scratch directory
      ansible.builtin.tempfile:
        state: directory
      register: unit_tmp

    - name: Render and check each case
      ansible.builtin.include_tasks: "{{ playbook_dir }}/tasks/firewall_case.yml"
      loop:
        - {name: lan-open, exposure: lan, sources: [], open: true, v4: false, v6: false}
        - {name: public-open, exposure: public, sources: [], open: true, v4: false, v6: false}
        - {name: lan-both, exposure: lan, sources: [192.0.2.0/24, "2001:db8::/32"], open: false, v4: true, v6: true}
        - {name: local-v4, exposure: local, sources: [192.0.2.0/24], open: false, v4: true, v6: false}
        - {name: public-v6, exposure: public, sources: ["2001:db8::/32"], open: false, v4: false, v6: true}
      loop_control:
        loop_var: unit_case
        label: "{{ unit_case.name }}"

    - name: Check a known interface passes
      ansible.builtin.include_tasks: "{{ playbook_dir }}/../../roles/firewall/tasks/check_interface.yml"
      vars:
        forge_external_interface: eth9

    - name: Check an unknown interface fails (no default IPv4 route, nothing set)
      block:
        - name: Run the interface check with no interface
          ansible.builtin.include_tasks: "{{ playbook_dir }}/../../roles/firewall/tasks/check_interface.yml"
          vars:
            forge_external_interface: ""
        - name: Record that it passed
          ansible.builtin.set_fact:
            unit_interface_outcome: passed
      rescue:
        - name: Record that it failed
          ansible.builtin.set_fact:
            unit_interface_outcome: failed
            unit_interface_message: "{{ ansible_failed_result.msg }}"

    - name: Check the unknown interface was refused with a clear message
      ansible.builtin.assert:
        that:
          - unit_interface_outcome == 'failed'
          - "'forge_external_interface' in unit_interface_message"

    - name: Remove the scratch directory
      ansible.builtin.file:
        path: "{{ unit_tmp.path }}"
        state: absent
```

`ansible/tests/unit/tasks/firewall_case.yml`:

```yaml
---
- name: Render the firewall for {{ unit_case.name }}
  ansible.builtin.template:
    src: "{{ playbook_dir }}/../../roles/firewall/templates/nftables.conf.j2"
    dest: "{{ unit_tmp.path }}/{{ unit_case.name }}.nft"
    mode: "0644"
  vars:
    forge_exposure: "{{ unit_case.exposure }}"
    forge_ssh_allowed_sources: "{{ unit_case.sources }}"
    forge_ssh_port: 2222
    forge_external_interface: eth9

- name: Check the firewall for {{ unit_case.name }}
  ansible.builtin.assert:
    that:
      # Own table only, recreated, never a flushed ruleset.
      - unit_nft is search('(?m)^table inet forge_host \\{\\}$')
      - unit_nft is search('(?m)^delete table inet forge_host$')
      - unit_nft is not search('(?m)^\\s*flush\\s+ruleset')
      - unit_nft | regex_findall('policy drop;') | length == 2
      # SSH on the external interface only; DHCP and DNS from the bridge.
      - "'iifname \"eth9\" tcp dport 2222 ct state new jump ssh' in unit_nft"
      - "'iifname \"forgebr0\" udp dport 67 accept' in unit_nft"
      - "'iifname \"forgebr0\" meta l4proto { tcp, udp } th dport 53 accept' in unit_nft"
      - "'iifname \"forgebr0\" oifname \"eth9\" accept' in unit_nft"
      # Rate limit with public only; open SSH only without allowed sources;
      # each family's allow-list present exactly when it has entries.
      - ('update @ssh_meter_v4' in unit_nft) == (unit_case.exposure == 'public')
      - (unit_nft is search('(?m)^\\s+accept$')) == unit_case.open
      - ('ip saddr @ssh_allowed_v4 accept' in unit_nft) == unit_case.v4
      - ('ip6 saddr @ssh_allowed_v6 accept' in unit_nft) == unit_case.v6
    fail_msg: "Case {{ unit_case.name }} failed; rendered file: {{ unit_tmp.path }}/{{ unit_case.name }}.nft"
  vars:
    unit_nft: "{{ lookup('ansible.builtin.file', unit_tmp.path ~ '/' ~ unit_case.name ~ '.nft') }}"
```

Append to `ansible/tests/unit.yml`:

```yaml
- name: Firewall
  ansible.builtin.import_playbook: unit/firewall.yml
```

- [ ] **Step 2: Run the unit tests to verify they fail**

Run: `npm run test:ansible </dev/null 2>&1 | cat`
Expected: FAIL: the play cannot load `../../roles/firewall/defaults/main.yml` (file not found).

- [ ] **Step 3: Write the role**

`ansible/roles/firewall/defaults/main.yml`:

```yaml
---
# Interface of the forge bridge, created by `forge setup` (sub-project 2): a
# constant shared by both sub-projects. Rules match it by name only, never by
# subnet, so they are valid before the bridge exists.
firewall_bridge: forgebr0
# public exposure: new SSH connections allowed per source address.
firewall_ssh_rate: 10/minute
firewall_ssh_burst: 5
# Derived from the forge_* inputs (lazily templated, so the unit tests can
# render the template with their own inputs).
firewall_external_interface: "{{ forge_external_interface or (ansible_facts.default_ipv4.interface | default('')) }}"
firewall_allowed_v4: "{{ forge_ssh_allowed_sources | reject('search', ':') | list }}"
firewall_allowed_v6: "{{ forge_ssh_allowed_sources | select('search', ':') | list }}"
firewall_rate_limit: "{{ forge_exposure == 'public' }}"
```

`ansible/roles/firewall/tasks/check_interface.yml`:

```yaml
---
- name: Check the external interface is known
  ansible.builtin.assert:
    that:
      - firewall_external_interface | length > 0
    fail_msg: >-
      The host has no default IPv4 route, so the firewall cannot tell which
      interface SSH arrives on: set forge_external_interface.
    quiet: true
```

`ansible/roles/firewall/files/nftables-agent-forge.conf`:

```
# Managed by agent-forge (ansible/roles/firewall).
# Ubuntu's nftables.service runs `nft flush ruleset` on stop, and so on every
# restart: that would wipe Incus's tables and cut container networking. Stop
# deletes agent-forge's own table only ("-": no error if it is already gone).
[Service]
ExecStop=
ExecStop=-/usr/sbin/nft delete table inet forge_host
```

`ansible/roles/firewall/templates/nftables.conf.j2`:

```
#!/usr/sbin/nft -f
# Managed by agent-forge (ansible/roles/firewall); local changes are overwritten.
#
# agent-forge's host firewall manages this table only. It never flushes the
# ruleset: that would wipe Incus's tables (inet incus, bridge incus) and cut
# container networking until Incus restarts. Creating the table before
# deleting it makes the very first load work too.
table inet forge_host {}
delete table inet forge_host

table inet forge_host {
{% if firewall_allowed_v4 %}
	set ssh_allowed_v4 {
		type ipv4_addr
		flags interval
		elements = { {{ firewall_allowed_v4 | join(', ') }} }
	}
{% endif %}
{% if firewall_allowed_v6 %}
	set ssh_allowed_v6 {
		type ipv6_addr
		flags interval
		elements = { {{ firewall_allowed_v6 | join(', ') }} }
	}
{% endif %}
{% if firewall_rate_limit | bool %}
	# Per-source meters for the public SSH rate limit.
	set ssh_meter_v4 {
		type ipv4_addr
		flags dynamic, timeout
		timeout 1m
	}
	set ssh_meter_v6 {
		type ipv6_addr
		flags dynamic, timeout
		timeout 1m
	}
{% endif %}

	# New SSH connections on the external interface land here.
	chain ssh {
{% if firewall_rate_limit | bool %}
		update @ssh_meter_v4 { ip saddr limit rate over {{ firewall_ssh_rate }} burst {{ firewall_ssh_burst }} packets } drop
		update @ssh_meter_v6 { ip6 saddr limit rate over {{ firewall_ssh_rate }} burst {{ firewall_ssh_burst }} packets } drop
{% endif %}
{% if forge_ssh_allowed_sources %}
{% if firewall_allowed_v4 %}
		ip saddr @ssh_allowed_v4 accept
{% endif %}
{% if firewall_allowed_v6 %}
		ip6 saddr @ssh_allowed_v6 accept
{% endif %}
{% else %}
		accept
{% endif %}
	}

	chain input {
		type filter hook input priority filter; policy drop;
		ct state established,related accept
		ct state invalid drop
		iif lo accept

		# ICMP the host needs: errors and path-MTU discovery, rate-limited
		# ping, and IPv6 neighbor/router discovery (without it IPv6 breaks).
		icmp type { destination-unreachable, time-exceeded, parameter-problem } accept
		icmp type echo-request limit rate 5/second accept
		icmpv6 type { destination-unreachable, packet-too-big, time-exceeded, parameter-problem, nd-router-solicit, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } accept
		icmpv6 type echo-request limit rate 5/second accept

		# Containers on the forge bridge get DHCP and DNS from the host, nothing else.
		iifname "{{ firewall_bridge }}" udp dport 67 accept
		iifname "{{ firewall_bridge }}" meta l4proto { tcp, udp } th dport 53 accept

		# SSH, on the external interface only.
		iifname "{{ firewall_external_interface }}" tcp dport {{ forge_ssh_port }} ct state new jump ssh
	}

	chain forward {
		type filter hook forward priority filter; policy drop;
		ct state established,related accept
		# Containers reach out; from outside, only return traffic comes in.
		iifname "{{ firewall_bridge }}" oifname "{{ firewall_external_interface }}" accept
	}
}
```

`ansible/roles/firewall/handlers/main.yml`:

```yaml
---
- name: Reload systemd units
  ansible.builtin.systemd_service:
    daemon_reload: true

# Reload runs `nft -f /etc/nftables.conf`, which replaces agent-forge's table
# atomically and leaves every other table alone.
- name: Load the host firewall
  ansible.builtin.systemd_service:
    name: nftables
    state: reloaded
```

`ansible/roles/firewall/tasks/main.yml`:

```yaml
---
- name: Check the external interface
  ansible.builtin.import_tasks: check_interface.yml

- name: Remove UFW (a single tool writes into netfilter, nftables)
  ansible.builtin.apt:
    name: ufw
    state: absent
    purge: true

- name: Install nftables
  ansible.builtin.apt:
    name: nftables
    state: present

- name: Create the nftables drop-in directory
  ansible.builtin.file:
    path: /etc/systemd/system/nftables.service.d
    state: directory
    mode: "0755"
    owner: root
    group: root

- name: Make stopping nftables delete agent-forge's table only
  ansible.builtin.copy:
    src: nftables-agent-forge.conf
    dest: /etc/systemd/system/nftables.service.d/agent-forge.conf
    mode: "0644"
    owner: root
    group: root
  notify: Reload systemd units

- name: Write the host firewall
  ansible.builtin.template:
    src: nftables.conf.j2
    dest: /etc/nftables.conf
    mode: "0644"
    owner: root
    group: root
    validate: nft -c -f %s
  notify: Load the host firewall

- name: Load the host firewall at boot
  ansible.builtin.systemd_service:
    name: nftables
    enabled: true
```

In `ansible/site.yml`, under `roles:`, after `- role: hardening`, add:

```yaml
    - role: firewall
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `npm run test:ansible </dev/null 2>&1 | cat`
Expected: PASS. All five cases render and pass their checks, and the interface check passes for `eth9` and is refused for `""`.

- [ ] **Step 5: Write the VM checks (`ansible/tests/verify/firewall.yml`)**

```yaml
---
- name: Read the host firewall's table
  ansible.builtin.command:
    cmd: nft list table inet forge_host
  changed_when: false

- name: Read /etc/nftables.conf
  ansible.builtin.slurp:
    src: /etc/nftables.conf
  register: verify_nftables_conf

- name: Read the installed packages
  ansible.builtin.package_facts:

- name: Check the firewall never flushes the ruleset and UFW is gone
  ansible.builtin.assert:
    that:
      - (verify_nftables_conf.content | b64decode) is not search('(?m)^\\s*flush\\s+ruleset')
      - "'ufw' not in ansible_facts.packages"

- name: Create a sentinel table that stands for Incus's tables
  ansible.builtin.command:
    cmd: nft add table inet forge_verify_sentinel
  changed_when: false

- name: Restart nftables
  ansible.builtin.systemd_service:
    name: nftables
    state: restarted

- name: Check the sentinel table survived the restart
  ansible.builtin.command:
    cmd: nft list table inet forge_verify_sentinel
  changed_when: false

- name: Reload nftables
  ansible.builtin.systemd_service:
    name: nftables
    state: reloaded

- name: Check the sentinel table survived the reload, and agent-forge's table is back
  ansible.builtin.command:
    cmd: nft list tables
  register: verify_nft_tables
  changed_when: false
  failed_when: >-
    'table inet forge_verify_sentinel' not in verify_nft_tables.stdout
    or 'table inet forge_host' not in verify_nft_tables.stdout

- name: Remove the sentinel table
  ansible.builtin.command:
    cmd: nft delete table inet forge_verify_sentinel
  changed_when: false
```

In `ansible/tests/verify.yml`, after the `SSH from the controller` import, add:

```yaml
    - name: Firewall
      ansible.builtin.import_tasks: verify/firewall.yml
```

- [ ] **Step 6: Syntax-check and lint**

Run: `ansible-playbook --syntax-check -i ansible/inventory.example.yml ansible/site.yml </dev/null 2>&1 | cat && ansible-playbook --syntax-check -i ansible/inventory.example.yml ansible/tests/verify.yml </dev/null 2>&1 | cat`
Expected: both print `playbook: …`

Run: `ansible-lint ansible/ </dev/null 2>&1 | cat`
Expected: `Passed`.

- [ ] **Step 7: Commit** (ask the user to be at the YubiKey first)

```bash
git add ansible/roles/firewall ansible/site.yml ansible/tests/unit.yml ansible/tests/unit/firewall.yml ansible/tests/unit/tasks/firewall_case.yml ansible/tests/verify.yml ansible/tests/verify/firewall.yml
git commit -m "feat: rôle firewall (nftables, table inet forge_host)"
```

---

### Task 6: VM checkpoint A, on omen (the user runs it)

This checkpoint covers what can lock a host out: the port move, devsec on 26.04 with sudo-rs and uutils, and the firewall. It runs before the remaining roles are built on top.

**Files:** none, unless the run finds bugs; fixes go in the files of Tasks 1–5.

- [ ] **Step 1: Ask the user for permission to push**, then push:

```bash
git push -u origin agent/v2-host
```

- [ ] **Step 2: Ask the user to run, on omen** (the `pipx` line only once):

```bash
pipx install ansible-core
git clone git@github.com:moroine/agent-forge.git ~/src/agent-forge-next   # once
git -C ~/src/agent-forge-next fetch origin
git -C ~/src/agent-forge-next checkout --detach origin/agent/v2-host
~/src/agent-forge-next/ansible/tests/vm-test.sh --exposure public
```

Expected: `vm-test: PASS (exposure public)`. The user pastes the output, or at least the failing part.

- [ ] **Step 3: Fix what fails, then rerun from Step 2.** Before changing anything, use superpowers:systematic-debugging. Known suspects:
  - **devsec issue #941** (`Unit ssh.socket is masked`). Insert these two tasks in `roles/hardening/tasks/main.yml`, between the `os_hardening` and `ssh_hardening` imports:

    ```yaml
    # devsec.hardening issue #941: with ssh.service.requires/ssh.socket
    # present, ssh_hardening fails with "Unit ssh.socket is masked".
    - name: Remove the ssh.socket requirement link (devsec issue 941)
      ansible.builtin.file:
        path: /etc/systemd/system/ssh.service.requires/ssh.socket
        state: absent
      register: hardening_ssh_socket_link

    # Must happen before ssh_hardening runs, not at the end of the play.
    - name: Reload systemd after removing the link  # noqa: no-handler
      ansible.builtin.systemd_service:
        daemon_reload: true
      when: hardening_ssh_socket_link is changed
    ```
  - **A devsec task that breaks under uutils or sudo-rs.** Fix it with a targeted override in `roles/hardening/tasks/main.yml` and a comment naming the failing task.
  - **A second run that is not idempotent.** The log lists the changed tasks. Make each one idempotent; never relax the check.

Each fix is a commit (`fix: …`). Ask the user to be at the YubiKey first, and ask before every push.

---

### Task 7: Role `fail2ban`

**Files:**
- Create: `ansible/roles/fail2ban/tasks/main.yml`, `ansible/roles/fail2ban/templates/agent-forge.local.j2`, `ansible/roles/fail2ban/handlers/main.yml`, `ansible/tests/unit/fail2ban.yml`, `ansible/tests/verify/fail2ban.yml`
- Modify: `ansible/site.yml` (roles), `ansible/tests/unit.yml`, `ansible/tests/verify.yml`

**Interfaces:**
- Consumes: `forge_exposure`, `forge_ssh_port`, `forge_fail2ban_ignoreip`.
- Consumes, in verify: the deliberate root-login failure from `verify/ssh_client.yml`, which must run before `verify/fail2ban.yml`.
- Produces: handler `Restart fail2ban`.

- [ ] **Step 1: Write the failing unit test (`ansible/tests/unit/fail2ban.yml`)**

```yaml
---
- name: Fail2ban jail
  hosts: render
  gather_facts: false
  tasks:
    - name: Create a scratch directory
      ansible.builtin.tempfile:
        state: directory
      register: unit_tmp

    - name: Render the jail for public and lan
      ansible.builtin.template:
        src: "{{ playbook_dir }}/../../roles/fail2ban/templates/agent-forge.local.j2"
        dest: "{{ unit_tmp.path }}/{{ item }}.local"
        mode: "0644"
      loop: [public, lan]
      vars:
        forge_exposure: "{{ item }}"
        forge_ssh_port: 2222
        forge_fail2ban_ignoreip: [198.51.100.7]

    - name: Check the settings shared by both exposures
      ansible.builtin.assert:
        that:
          - "'banaction = nftables-multiport' in unit_jail"
          - "'banaction_allports = nftables-allports' in unit_jail"
          - "'ignoreip = 127.0.0.1/8 ::1 198.51.100.7' in unit_jail"
          - "'port = 2222' in unit_jail"
          - "'backend = systemd' in unit_jail"
          - "'_COMM=sshd-session' in unit_jail"
      loop: [public, lan]
      vars:
        unit_jail: "{{ lookup('ansible.builtin.file', unit_tmp.path ~ '/' ~ item ~ '.local') }}"

    - name: Check public is strict, with an increasing ban
      ansible.builtin.assert:
        that:
          - "'mode = aggressive' in unit_jail"
          - "'maxretry = 3' in unit_jail"
          - "'findtime = 1h' in unit_jail"
          - "'bantime = 1d' in unit_jail"
          - "'bantime.increment = true' in unit_jail"
          - "'bantime.maxtime = 30d' in unit_jail"
      vars:
        unit_jail: "{{ lookup('ansible.builtin.file', unit_tmp.path ~ '/public.local') }}"

    - name: Check lan is lenient
      ansible.builtin.assert:
        that:
          - "'mode = normal' in unit_jail"
          - "'maxretry = 5' in unit_jail"
          - "'findtime = 10m' in unit_jail"
          - "'bantime = 1h' in unit_jail"
          - "'bantime.increment' not in unit_jail"
      vars:
        unit_jail: "{{ lookup('ansible.builtin.file', unit_tmp.path ~ '/lan.local') }}"

    - name: Remove the scratch directory
      ansible.builtin.file:
        path: "{{ unit_tmp.path }}"
        state: absent
```

Append to `ansible/tests/unit.yml`:

```yaml
- name: Fail2ban
  ansible.builtin.import_playbook: unit/fail2ban.yml
```

- [ ] **Step 2: Run the unit tests to verify they fail**

Run: `npm run test:ansible </dev/null 2>&1 | cat`
Expected: FAIL on "Render the jail for public and lan" (template not found).

- [ ] **Step 3: Write the role**

`ansible/roles/fail2ban/templates/agent-forge.local.j2`:

```
# Managed by agent-forge (ansible/roles/fail2ban); local changes are overwritten.
# sshd jail, scaled with forge_exposure ({{ forge_exposure }}). Bans go into
# fail2ban's own nftables table, which the host firewall never touches.
[DEFAULT]
banaction = nftables-multiport
banaction_allports = nftables-allports
ignoreip = 127.0.0.1/8 ::1{% for address in forge_fail2ban_ignoreip %} {{ address }}{% endfor %}


[sshd]
enabled = true
port = {{ forge_ssh_port }}
# The journal, not /var/log/auth.log, which a minimal install may lack.
backend = systemd
# Ubuntu's unit is ssh.service, and OpenSSH 10 logs authentication from
# sshd-session: the stock journalmatch (sshd.service / sshd) misses both.
journalmatch = _SYSTEMD_UNIT=ssh.service + _COMM=sshd + _COMM=sshd-session
{% if forge_exposure == 'public' %}
mode = aggressive
maxretry = 3
findtime = 1h
bantime = 1d
bantime.increment = true
bantime.maxtime = 30d
{% else %}
mode = normal
maxretry = 5
findtime = 10m
bantime = 1h
{% endif %}
```

`ansible/roles/fail2ban/handlers/main.yml`:

```yaml
---
- name: Restart fail2ban
  ansible.builtin.systemd_service:
    name: fail2ban
    state: restarted
```

`ansible/roles/fail2ban/tasks/main.yml`:

```yaml
---
- name: Run fail2ban (public and lan)
  when: forge_exposure != 'local'
  block:
    - name: Install fail2ban
      ansible.builtin.apt:
        name: fail2ban
        state: present

    - name: Configure the sshd jail
      ansible.builtin.template:
        src: agent-forge.local.j2
        dest: /etc/fail2ban/jail.d/agent-forge.local
        mode: "0644"
        owner: root
        group: root
      notify: Restart fail2ban

    - name: Start fail2ban, now and at boot
      ansible.builtin.systemd_service:
        name: fail2ban
        enabled: true
        state: started

- name: Keep fail2ban off with local (it would ban Lima's gateway)
  when: forge_exposure == 'local'
  block:
    - name: Read the services
      ansible.builtin.service_facts:

    - name: Stop and disable fail2ban
      ansible.builtin.systemd_service:
        name: fail2ban
        enabled: false
        state: stopped
      when: "'fail2ban.service' in ansible_facts.services"
```

In `ansible/site.yml`, under `roles:`, after `- role: firewall`, add:

```yaml
    - role: fail2ban
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `npm run test:ansible </dev/null 2>&1 | cat`
Expected: PASS.

- [ ] **Step 5: Write the VM checks (`ansible/tests/verify/fail2ban.yml`)**

```yaml
---
- name: Check fail2ban (public and lan)
  when: forge_exposure != 'local'
  block:
    - name: Read the sshd jail
      ansible.builtin.command:
        cmd: fail2ban-client status sshd
      changed_when: false

    # Review focus 3: the jail must see real failures, not only accept a
    # manual ban. verify/ssh_client.yml made one (root login) just before.
    - name: Check the jail counted the deliberate failed login
      ansible.builtin.command:
        cmd: fail2ban-client status sshd
      register: verify_jail
      changed_when: false
      until: (verify_jail.stdout | regex_search('Total failed:\\s+(\\d+)', '\\1') | first | int) >= 1
      retries: 10
      delay: 2
      when: verify_negative_auth | default(false) | bool

    - name: Ban a test address
      ansible.builtin.command:
        cmd: fail2ban-client set sshd banip 192.0.2.1
      changed_when: false

    - name: Read fail2ban's nftables table
      ansible.builtin.command:
        cmd: nft list table inet f2b-table
      register: verify_f2b_table
      changed_when: false

    - name: Lift the test ban
      ansible.builtin.command:
        cmd: fail2ban-client set sshd unbanip 192.0.2.1
      changed_when: false

    - name: Check the ban went through nftables
      ansible.builtin.assert:
        that:
          - "'192.0.2.1' in verify_f2b_table.stdout"

- name: Check fail2ban is off (local)
  when: forge_exposure == 'local'
  block:
    # A read-only query: the unit may not even exist with local.
    - name: Read whether fail2ban runs  # noqa: command-instead-of-module
      ansible.builtin.command:
        cmd: systemctl is-active fail2ban
      register: verify_f2b_active
      changed_when: false
      failed_when: false

    - name: Check fail2ban is not running
      ansible.builtin.assert:
        that:
          - verify_f2b_active.stdout != 'active'
```

The backslashes are doubled on purpose: Jinja decodes escapes inside its string literals, so a single `'\1'` would become the character 0x01. The same rule applies to every regex inside a Jinja expression in this plan.

In `ansible/tests/verify.yml`, after the `Firewall` import, add:

```yaml
    - name: Fail2ban
      ansible.builtin.import_tasks: verify/fail2ban.yml
```

- [ ] **Step 6: Syntax-check and lint**

Run: `ansible-playbook --syntax-check -i ansible/inventory.example.yml ansible/site.yml </dev/null 2>&1 | cat && ansible-playbook --syntax-check -i ansible/inventory.example.yml ansible/tests/verify.yml </dev/null 2>&1 | cat`
Expected: both print `playbook: …`

Run: `ansible-lint ansible/ </dev/null 2>&1 | cat`
Expected: `Passed`.

- [ ] **Step 7: Commit** (ask the user to be at the YubiKey first)

```bash
git add ansible/roles/fail2ban ansible/site.yml ansible/tests/unit.yml ansible/tests/unit/fail2ban.yml ansible/tests/verify.yml ansible/tests/verify/fail2ban.yml
git commit -m "feat: rôle fail2ban (actions nftables, réglages selon forge_exposure)"
```

---

### Task 8: Role `incus` (Zabbly LTS 7.0, btrfs pool, no network)

**Files:**
- Create: `ansible/roles/incus/defaults/main.yml`, `ansible/roles/incus/tasks/main.yml`, `ansible/roles/incus/tasks/check_room.yml`, `ansible/roles/incus/templates/preseed.yml.j2`, `ansible/tests/unit/incus.yml`, `ansible/tests/unit/tasks/incus_case.yml`, `ansible/tests/verify/incus.yml`
- Modify: `ansible/site.yml` (roles), `ansible/tests/unit.yml`, `ansible/tests/verify.yml`, `ansible/README.md`

**Interfaces:**
- Consumes: `forge_incus_storage_size`, `forge_incus_storage_source`, `ansible_facts.mounts`, `ansible_facts.distribution_release`, `ansible_facts.architecture`; `base/tasks/apt_repo.yml` (Task 3).
- Produces:
  - pool `default` (btrfs) and the root disk on the `default` profile;
  - group `incus-admin`, created by the package, which Task 9 needs;
  - role defaults `incus_pool_name` (`default`), `incus_mounts`, `incus_pool_mount`, `incus_pool_auto_gib` (int), `incus_min_pool_gib` (`20`), `incus_pool_ratio` (`0.8`).

- [ ] **Step 1: Write the failing unit test**

`ansible/tests/unit/incus.yml`:

```yaml
---
- name: Incus pool sizing and preseed
  hosts: render
  gather_facts: false
  vars:
    unit_gib: 1073741824
  # vars_files, not include_vars: its lower precedence lets each case's task
  # vars (incus_mounts, forge_incus_storage_*) win over the role's defaults.
  vars_files:
    - ../../roles/incus/defaults/main.yml
  tasks:
    - name: Create a scratch directory
      ansible.builtin.tempfile:
        state: directory
      register: unit_tmp

    - name: Render and check each preseed case
      ansible.builtin.include_tasks: "{{ playbook_dir }}/tasks/incus_case.yml"
      loop:
        - name: auto-root
          mounts: [{mount: /, size_available: "{{ 100 * unit_gib }}"}]
          size: ""
          source: ""
          expect: {size: 80GiB}
        - name: auto-var
          mounts:
            - {mount: /, size_available: "{{ 10 * unit_gib }}"}
            - {mount: /var, size_available: "{{ 50 * unit_gib }}"}
            - {mount: /boot, size_available: "{{ 1 * unit_gib }}"}
          size: ""
          source: ""
          expect: {size: 40GiB}
        - name: explicit
          mounts: [{mount: /, size_available: "{{ 100 * unit_gib }}"}]
          size: 200GiB
          source: ""
          expect: {size: 200GiB}
        - name: device
          mounts: [{mount: /, size_available: "{{ 5 * unit_gib }}"}]
          size: ""
          source: /dev/vdb
          expect: {source: /dev/vdb}
      loop_control:
        loop_var: unit_case
        label: "{{ unit_case.name }}"

    - name: Check the room check passes at exactly 20 GiB (80 % of 25 GiB)
      ansible.builtin.include_tasks: "{{ playbook_dir }}/../../roles/incus/tasks/check_room.yml"
      vars:
        incus_mounts: [{mount: /, size_available: "{{ 25 * unit_gib }}"}]
        forge_incus_storage_size: ""
        forge_incus_storage_source: ""

    - name: Check an explicit size skips the room check on a small disk
      ansible.builtin.include_tasks: "{{ playbook_dir }}/../../roles/incus/tasks/check_room.yml"
      vars:
        incus_mounts: [{mount: /, size_available: "{{ 5 * unit_gib }}"}]
        forge_incus_storage_size: 30GiB
        forge_incus_storage_source: ""

    - name: Check the room check refuses 19 GiB (80 % of 24 GiB)
      block:
        - name: Run the room check on a 24 GiB disk
          ansible.builtin.include_tasks: "{{ playbook_dir }}/../../roles/incus/tasks/check_room.yml"
          vars:
            incus_mounts: [{mount: /, size_available: "{{ 24 * unit_gib }}"}]
            forge_incus_storage_size: ""
            forge_incus_storage_source: ""
        - name: Record that it passed
          ansible.builtin.set_fact:
            unit_room_outcome: passed
      rescue:
        - name: Record that it failed
          ansible.builtin.set_fact:
            unit_room_outcome: failed
            unit_room_message: "{{ ansible_failed_result.msg }}"

    - name: Check the small disk was refused with a clear message
      ansible.builtin.assert:
        that:
          - unit_room_outcome == 'failed'
          - "'forge_incus_storage_size' in unit_room_message"

    - name: Remove the scratch directory
      ansible.builtin.file:
        path: "{{ unit_tmp.path }}"
        state: absent
```

`ansible/tests/unit/tasks/incus_case.yml`:

```yaml
---
- name: Render the preseed for {{ unit_case.name }}
  ansible.builtin.template:
    src: "{{ playbook_dir }}/../../roles/incus/templates/preseed.yml.j2"
    dest: "{{ unit_tmp.path }}/{{ unit_case.name }}.yml"
    mode: "0644"
  vars:
    incus_mounts: "{{ unit_case.mounts }}"
    forge_incus_storage_size: "{{ unit_case.size }}"
    forge_incus_storage_source: "{{ unit_case.source }}"

- name: Check the preseed for {{ unit_case.name }}
  ansible.builtin.assert:
    that:
      - unit_preseed.storage_pools | length == 1
      - unit_preseed.storage_pools[0].name == 'default'
      - unit_preseed.storage_pools[0].driver == 'btrfs'
      - unit_preseed.storage_pools[0].config == unit_case.expect
      - unit_preseed.profiles[0].name == 'default'
      - unit_preseed.profiles[0].devices.root == {'path': '/', 'pool': 'default', 'type': 'disk'}
      # The boundary rule: no network, no remote API.
      - "'networks' not in unit_preseed"
      - "'config' not in unit_preseed"
    fail_msg: "Case {{ unit_case.name }}: {{ unit_preseed }}"
  vars:
    unit_preseed: "{{ lookup('ansible.builtin.file', unit_tmp.path ~ '/' ~ unit_case.name ~ '.yml') | from_yaml }}"
```

Append to `ansible/tests/unit.yml`:

```yaml
- name: Incus
  ansible.builtin.import_playbook: unit/incus.yml
```

- [ ] **Step 2: Run the unit tests to verify they fail**

Run: `npm run test:ansible </dev/null 2>&1 | cat`
Expected: FAIL: the play cannot load `../../roles/incus/defaults/main.yml` (file not found).

- [ ] **Step 3: Write the role**

`ansible/roles/incus/defaults/main.yml`:

```yaml
---
incus_zabbly_key_url: https://pkgs.zabbly.com/key.asc
incus_zabbly_fingerprint: 4EFC590696CB15B87C73A3AD82CC8797C838DCFD
incus_zabbly_uri: https://pkgs.zabbly.com/incus/lts-7.0
# incus-base: the daemon without VM support (no QEMU); it depends on
# incus-client, the CLI. btrfs-progs is only a Suggests, and the pool is btrfs.
incus_packages:
  - incus-base
  - btrfs-progs
# Shared with sub-project 2: the forge profile's root disk uses this pool.
incus_pool_name: default
incus_min_pool_gib: 20
incus_pool_ratio: 0.8
# The pool's loop file lives under /var/lib/incus: size it from the free space
# of the deepest mount point holding that path. Lazily templated, so the unit
# tests can pass their own mounts.
incus_mounts: "{{ ansible_facts.mounts }}"
incus_pool_mount_candidates: [/, /var, /var/lib, /var/lib/incus]
incus_pool_mount: "{{ incus_mounts | selectattr('mount', 'in', incus_pool_mount_candidates) | sort(attribute='mount') | last }}"
incus_pool_auto_gib: "{{ (incus_pool_mount.size_available | int * incus_pool_ratio / 1073741824) | int }}"
```

`ansible/roles/incus/tasks/check_room.yml`:

```yaml
---
- name: Check there is room for the Incus pool
  ansible.builtin.assert:
    that:
      - >-
        forge_incus_storage_size | length > 0
        or forge_incus_storage_source | length > 0
        or incus_pool_auto_gib | int >= incus_min_pool_gib
    fail_msg: >-
      Only {{ incus_pool_auto_gib }} GiB would go to the Incus pool (80 % of
      the free space under {{ incus_pool_mount.mount }}), and at least
      {{ incus_min_pool_gib }} GiB are needed. Set forge_incus_storage_size,
      or forge_incus_storage_source for a dedicated disk.
    quiet: true
```

`ansible/roles/incus/templates/preseed.yml.j2`:

```yaml
# Managed by agent-forge (ansible/roles/incus). Storage only: no network
# (Incus cannot auto-pick a subnet under Lima, validation spike finding A) and
# no remote API. `forge setup` owns everything else inside Incus.
storage_pools:
  - name: {{ incus_pool_name }}
    driver: btrfs
    config:
{% if forge_incus_storage_source %}
      source: {{ forge_incus_storage_source }}
{% elif forge_incus_storage_size %}
      size: {{ forge_incus_storage_size }}
{% else %}
      size: {{ incus_pool_auto_gib }}GiB
{% endif %}
profiles:
  - name: default
    devices:
      root:
        path: /
        pool: {{ incus_pool_name }}
        type: disk
```

`ansible/roles/incus/tasks/main.yml`:

```yaml
---
- name: Add the Zabbly Incus LTS 7.0 repository
  ansible.builtin.include_role:
    name: base
    tasks_from: apt_repo.yml
  vars:
    base_apt_repo_name: zabbly
    base_apt_repo_key_url: "{{ incus_zabbly_key_url }}"
    base_apt_repo_fingerprint: "{{ incus_zabbly_fingerprint }}"
    base_apt_repo_uris: ["{{ incus_zabbly_uri }}"]
    base_apt_repo_suites: ["{{ ansible_facts.distribution_release }}"]
    base_apt_repo_components: [main]
    base_apt_repo_architectures: ["{{ 'arm64' if ansible_facts.architecture == 'aarch64' else 'amd64' }}"]

- name: Install Incus (containers only) and the btrfs tools
  ansible.builtin.apt:
    name: "{{ incus_packages }}"
    state: present
    # Recommends would pull iptables next to nftables.
    install_recommends: false

- name: Look for the storage pool
  ansible.builtin.command:
    cmd: incus storage show {{ incus_pool_name }}
  register: incus_pool_show
  changed_when: false
  failed_when: false

- name: Check the existing pool is btrfs
  ansible.builtin.assert:
    that:
      - (incus_pool_show.stdout | from_yaml).driver == 'btrfs'
    fail_msg: >-
      Incus already has a pool "{{ incus_pool_name }}" with driver
      {{ (incus_pool_show.stdout | from_yaml).driver }}; agent-forge needs
      btrfs. There is no automatic migration.
    quiet: true
  when: incus_pool_show.rc == 0

- name: Initialize Incus with a btrfs pool and no network
  when: incus_pool_show.rc != 0
  block:
    - name: Check there is room for the pool
      ansible.builtin.import_tasks: check_room.yml

    - name: Initialize Incus
      ansible.builtin.command:
        cmd: incus admin init --preseed
        stdin: "{{ lookup('ansible.builtin.template', 'preseed.yml.j2') }}"
      changed_when: true
```

If `ansible-lint` flags the `base_apt_repo_*` vars of the `include_role` task (`var-naming[no-role-prefix]`), add `# noqa: var-naming[no-role-prefix]` at the end of the task's `name:` line, with the comment line `# The input names of base's apt_repo.yml.` just above the task.

In `ansible/site.yml`, under `roles:`, after `- role: fail2ban`, add:

```yaml
    - role: incus
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `npm run test:ansible </dev/null 2>&1 | cat`
Expected: PASS. All four preseed cases pass, the 25 GiB and explicit-size checks pass, and 24 GiB is refused.

- [ ] **Step 5: Write the VM checks (`ansible/tests/verify/incus.yml`)**

```yaml
---
- name: Read the installed Incus package
  ansible.builtin.command:
    cmd: dpkg-query --showformat=${Version} --show incus-base
  register: verify_incus_version
  changed_when: false

- name: Read the storage pool
  ansible.builtin.command:
    cmd: incus storage show default
  register: verify_pool
  changed_when: false

- name: Read Incus's networks
  ansible.builtin.command:
    cmd: incus network list --format json
  register: verify_networks
  changed_when: false

- name: Check Incus is Zabbly's 7.0, on a btrfs pool, with no managed network
  ansible.builtin.assert:
    that:
      # Zabbly's packages carry the 1: epoch; Ubuntu's own Incus is 6.0.
      - verify_incus_version.stdout is match('1:7\\.0\\.')
      - (verify_pool.stdout | from_yaml).driver == 'btrfs'
      - verify_networks.stdout | from_json | selectattr('managed') | list | length == 0
```

In `ansible/tests/verify.yml`, after the `Fail2ban` import, add:

```yaml
    - name: Incus
      ansible.builtin.import_tasks: verify/incus.yml
```

- [ ] **Step 6: Document the pool in `ansible/README.md`**

Append:

```markdown
## Incus storage pool

The playbook creates the btrfs pool `default` once. It uses a loop file of
about 80 % of the free space, or `forge_incus_storage_size`, or the device
`forge_incus_storage_source`. It never changes the pool afterwards. To grow a
loop-file pool later, run on the host:

    sudo incus storage set default size=200GiB

A loop file can grow, never shrink. Per-container disk sizes are a guard rail,
not a hard limit: an agent can escape btrfs quotas with nested subvolumes. The
pool's size is the hard ceiling.
```

- [ ] **Step 7: Syntax-check and lint**

Run: `ansible-playbook --syntax-check -i ansible/inventory.example.yml ansible/site.yml </dev/null 2>&1 | cat && ansible-playbook --syntax-check -i ansible/inventory.example.yml ansible/tests/verify.yml </dev/null 2>&1 | cat`
Expected: both print `playbook: …`

Run: `ansible-lint ansible/ </dev/null 2>&1 | cat`
Expected: `Passed`.

- [ ] **Step 8: Commit** (ask the user to be at the YubiKey first)

```bash
git add ansible/roles/incus ansible/site.yml ansible/tests/unit.yml ansible/tests/unit/incus.yml ansible/tests/unit/tasks/incus_case.yml ansible/tests/verify.yml ansible/tests/verify/incus.yml ansible/README.md
git commit -m "feat: rôle incus (Zabbly lts-7.0, pool btrfs, pas de réseau)"
```

---

### Task 9: Role `forge_users` (account, tools, forge release)

**Files:**
- Create:
  - `ansible/roles/forge_users/defaults/main.yml`
  - `ansible/roles/forge_users/tasks/main.yml`, `ansible/roles/forge_users/tasks/account.yml`, `ansible/roles/forge_users/tasks/tools.yml`, `ansible/roles/forge_users/tasks/forge.yml`
  - `ansible/roles/forge_users/files/nodesource-pin`
  - `ansible/roles/forge_users/handlers/main.yml`
  - `ansible/tests/verify/forge_users.yml`, `ansible/tests/files/incus-smoke.sh`
- Modify: `ansible/site.yml` (roles), `ansible/tests/verify.yml`

**Interfaces:**
- Consumes:
  - `forge_user` (Task 1);
  - group `incus-admin` (Task 8);
  - `base/tasks/apt_repo.yml` (Task 3);
  - `playbook_dir`: `site.yml` lives in `ansible/`, so the repository root is `playbook_dir | dirname`.
- Produces, the contract with sub-project 2:
  - `/opt/agent-forge/releases/<sha>/` (root:root) with `COMMIT`;
  - `/opt/agent-forge/current` and `/opt/agent-forge/previous` symlinks;
  - `/usr/local/bin/forge` → `/opt/agent-forge/current/scripts/forge`;
  - `/etc/bash_completion.d/forge`;
  - `/usr/bin/node` (24), `/usr/bin/claude`, Ubuntu's `ansible`.

There is no controller-side unit test in this task: everything it does needs a real host, and `verify/forge_users.yml` checks each piece.

- [ ] **Step 1: Write the VM checks first**

`ansible/tests/files/incus-smoke.sh`:

```bash
#!/bin/bash
# Runs on the provisioned host as the forge user, fed to `bash -s` over SSH by
# verify.yml. Proves that an unprivileged user inside a container can create
# a user namespace (the hardening role's userns sysctls), then deletes what
# it created. The only place the host tests touch Incus internals.
set -e

P="forge-host-test"
cleanup() {
  incus delete --force smoke --project "$P" >/dev/null 2>&1 || true
  for fingerprint in $(incus image list --project "$P" --format csv --columns F 2>/dev/null); do
    incus image delete "$fingerprint" --project "$P" >/dev/null 2>&1 || true
  done
  incus project delete "$P" >/dev/null 2>&1 || true
}
trap cleanup EXIT

incus project create "$P"
# A new project has its own, empty default profile: the container gets a root
# disk on the pool (--storage) and no NIC at all.
incus launch images:ubuntu/26.04 smoke --project "$P" --storage default
incus exec smoke --project "$P" -- setpriv --reuid 1000 --regid 1000 --clear-groups unshare -Ur true
echo "incus-smoke: OK"
```

Then: `chmod +x ansible/tests/files/incus-smoke.sh && bash -n ansible/tests/files/incus-smoke.sh`

`ansible/tests/verify/forge_users.yml`:

```yaml
---
# Checks as the forge user go through non-interactive SSH, the way herdr and
# forge reach the host.
- name: Read the forge user's groups
  ansible.builtin.command:
    cmd: "{{ verify_ssh_forge }} id -nG"
  delegate_to: localhost
  become: false
  register: verify_forge_groups
  changed_when: false

- name: Check the forge user has no sudo
  ansible.builtin.command:
    cmd: "{{ verify_ssh_forge }} sudo -n true"
  delegate_to: localhost
  become: false
  register: verify_forge_sudo
  changed_when: false
  failed_when: verify_forge_sudo.rc == 0

- name: Read the forge user's tools and PATH
  ansible.builtin.command:
    cmd: "{{ verify_ssh_forge }} '{{ item }}'"
  delegate_to: localhost
  become: false
  loop:
    - node --version
    - claude --version
    - ansible-doc -t connection community.general.incus
    - forge --help
    - incus info
    - printenv PATH
  register: verify_forge_tools
  changed_when: false

- name: Check agent forwarding reaches the forge user
  ansible.builtin.command:
    cmd: >-
      {{ verify_ssh }} -A -i {{ verify_work }}/forge
      {{ forge_users[0].name }}@{{ ansible_host }} ssh-add -l
  delegate_to: localhost
  become: false
  register: verify_forge_agent
  changed_when: false

- name: Read the controller's HEAD
  ansible.builtin.command:
    cmd: git -C "{{ playbook_dir | dirname | dirname }}" rev-parse HEAD
  delegate_to: localhost
  become: false
  run_once: true
  register: verify_head
  changed_when: false

- name: Read the deployed release's commit
  ansible.builtin.slurp:
    src: /opt/agent-forge/current/COMMIT
  register: verify_commit

- name: Read the forge entry point
  ansible.builtin.stat:
    path: /usr/local/bin/forge
  register: verify_forge_link

- name: Check the forge user's account, tools and forge release
  ansible.builtin.assert:
    that:
      - "'incus-admin' in verify_forge_groups.stdout.split()"
      - "'sudo' not in verify_forge_groups.stdout.split()"
      - verify_forge_tools.results[0].stdout is match('v24\\.')
      - "('/home/' ~ forge_users[0].name ~ '/.local/bin') in verify_forge_tools.results[5].stdout.split(':')"
      - "'vm-test-forge' in verify_forge_agent.stdout"
      - (verify_commit.content | b64decode | trim) == verify_head.stdout
      - verify_forge_link.stat.islnk
      - verify_forge_link.stat.lnk_source is match('/opt/agent-forge/releases/[0-9a-f]{40}/scripts/forge$')

- name: Run the container smoke test as the forge user
  ansible.builtin.shell:
    cmd: "{{ verify_ssh_forge }} 'bash -s' < {{ playbook_dir }}/files/incus-smoke.sh"
  delegate_to: localhost
  become: false
  register: verify_smoke
  changed_when: false
  failed_when: "'incus-smoke: OK' not in verify_smoke.stdout"
```

In `ansible/tests/verify.yml`, after the `Incus` import, add:

```yaml
    - name: Forge user
      ansible.builtin.import_tasks: verify/forge_users.yml
```

Run: `ansible-playbook --syntax-check -i ansible/inventory.example.yml ansible/tests/verify.yml </dev/null 2>&1 | cat`
Expected: `playbook: ansible/tests/verify.yml`

- [ ] **Step 2: Write the role's defaults, files and handlers**

`ansible/roles/forge_users/defaults/main.yml`:

```yaml
---
forge_users_install_root: /opt/agent-forge
# CLI entry point inside a release: scripts/forge today. Sub-project 2 moves
# the CLI to cli/forge (framing spec layout) and changes this value with it.
forge_users_cli_entrypoint: scripts/forge
# The repository root on the controller (site.yml lives in ansible/).
forge_users_repo_root: "{{ playbook_dir | dirname }}"
forge_users_nodesource_key_url: https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key
forge_users_nodesource_fingerprint: 6F71F525282841EEDAF851B42F59B5F99B1BE0B4
forge_users_nodesource_uri: https://deb.nodesource.com/node_24.x
forge_users_claude_key_url: https://downloads.claude.ai/keys/claude-code.asc
forge_users_claude_fingerprint: 31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE
forge_users_claude_uri: https://downloads.claude.ai/claude-code/apt/stable
# nodejs from NodeSource (Node 24); claude-code for `claude auth login`;
# Ubuntu's ansible (with community.general) for `forge image build`.
forge_users_packages:
  - nodejs
  - claude-code
  - ansible
```

`ansible/roles/forge_users/files/nodesource-pin`:

```
# Managed by agent-forge (ansible/roles/forge_users).
# Node 24 from NodeSource; Ubuntu 26.04 itself only ships Node 22.
Package: nodejs
Pin: origin deb.nodesource.com
Pin-Priority: 600
```

`ansible/roles/forge_users/handlers/main.yml`:

```yaml
---
- name: Regenerate forge's bash completion
  ansible.builtin.command:
    cmd: /usr/local/bin/forge completion bash
  register: forge_users_completion
  changed_when: true
  notify: Write forge's bash completion

- name: Write forge's bash completion
  ansible.builtin.copy:
    content: "{{ forge_users_completion.stdout }}\n"
    dest: /etc/bash_completion.d/forge
    mode: "0644"
    owner: root
    group: root
```

- [ ] **Step 3: Write the account tasks (`ansible/roles/forge_users/tasks/account.yml`)**

```yaml
---
- name: Create the forge user
  ansible.builtin.user:
    name: "{{ forge_user.name }}"
    shell: /bin/bash
    groups: [incus-admin]
    append: false
    password: "!"   # locked: SSH keys only
    create_home: true
  register: forge_users_account

- name: Restrict the forge user's home to its owner
  # os_hardening sets existing homes to 0700 on every run. A home created
  # later with another mode would make the second run report a change.
  ansible.builtin.file:
    path: "{{ forge_users_account.home }}"
    state: directory
    mode: "0700"
    owner: "{{ forge_user.name }}"
    group: "{{ forge_user.name }}"

- name: Install the forge user's SSH keys (the inventory is authoritative)
  ansible.posix.authorized_key:
    user: "{{ forge_user.name }}"
    key: "{{ forge_user.ssh_keys | join('\n') }}"
    exclusive: true

- name: Put ~/.local/bin on the PATH, non-interactive shells included
  ansible.builtin.blockinfile:
    path: "{{ forge_users_account.home }}/.bashrc"
    insertbefore: BOF
    marker: "# {mark} agent-forge: ~/.local/bin on PATH"
    owner: "{{ forge_user.name }}"
    group: "{{ forge_user.name }}"
    mode: "0644"
    block: |
      # Before Ubuntu's early return for non-interactive shells, so that SSH
      # commands find what herdr installs in ~/.local/bin.
      case ":$PATH:" in
        *":$HOME/.local/bin:"*) ;;
        *) PATH="$HOME/.local/bin:$PATH" ;;
      esac
```

- [ ] **Step 4: Write the tools tasks (`ansible/roles/forge_users/tasks/tools.yml`)**

```yaml
---
- name: Add the NodeSource Node 24 repository
  ansible.builtin.include_role:
    name: base
    tasks_from: apt_repo.yml
  vars:
    base_apt_repo_name: nodesource
    base_apt_repo_key_url: "{{ forge_users_nodesource_key_url }}"
    base_apt_repo_fingerprint: "{{ forge_users_nodesource_fingerprint }}"
    base_apt_repo_uris: ["{{ forge_users_nodesource_uri }}"]
    base_apt_repo_suites: [nodistro]
    base_apt_repo_components: [main]

- name: Prefer NodeSource's nodejs to Ubuntu's
  ansible.builtin.copy:
    src: nodesource-pin
    dest: /etc/apt/preferences.d/nodesource
    mode: "0644"
    owner: root
    group: root

- name: Add Anthropic's Claude Code repository (stable channel)
  ansible.builtin.include_role:
    name: base
    tasks_from: apt_repo.yml
  vars:
    base_apt_repo_name: claude-code
    base_apt_repo_key_url: "{{ forge_users_claude_key_url }}"
    base_apt_repo_fingerprint: "{{ forge_users_claude_fingerprint }}"
    base_apt_repo_uris: ["{{ forge_users_claude_uri }}"]
    base_apt_repo_suites: [stable]
    base_apt_repo_components: [main]

- name: Install Node 24, Claude Code and Ansible
  ansible.builtin.apt:
    name: "{{ forge_users_packages }}"
    state: present
```

- [ ] **Step 5: Write the forge release tasks (`ansible/roles/forge_users/tasks/forge.yml`)**

```yaml
---
# forge comes from the controller's HEAD, so it always matches the playbook
# that installs it (works for forks and unpushed branches; the host needs no
# GitHub access). One version per host, root-owned.
- name: Read the controller's HEAD
  ansible.builtin.command:
    cmd: git -C "{{ forge_users_repo_root }}" rev-parse HEAD
  delegate_to: localhost
  become: false
  run_once: true
  register: forge_users_head
  changed_when: false

# A read-only query: the git module only clones and updates.
- name: Read whether the controller's checkout has uncommitted changes  # noqa: command-instead-of-module
  ansible.builtin.command:
    cmd: git -C "{{ forge_users_repo_root }}" status --porcelain
  delegate_to: localhost
  become: false
  run_once: true
  register: forge_users_status
  changed_when: false

- name: Warn that HEAD is deployed, not the working tree
  ansible.builtin.debug:
    msg: >-
      The controller's checkout has uncommitted changes: forge is deployed
      from HEAD ({{ forge_users_head.stdout[:12] }}), not from the working tree.
  when: forge_users_status.stdout | length > 0
  run_once: true

- name: Set the release's paths
  ansible.builtin.set_fact:
    forge_users_sha: "{{ forge_users_head.stdout }}"
    forge_users_release: "{{ forge_users_install_root }}/releases/{{ forge_users_head.stdout }}"

- name: Create the releases directory
  ansible.builtin.file:
    path: "{{ forge_users_install_root }}/releases"
    state: directory
    mode: "0755"
    owner: root
    group: root

- name: Look for this release on the host
  ansible.builtin.stat:
    path: "{{ forge_users_release }}"
  register: forge_users_release_stat

- name: Install this release
  when: not forge_users_release_stat.stat.exists
  block:
    - name: Make a scratch directory on the controller
      ansible.builtin.tempfile:
        state: directory
      delegate_to: localhost
      become: false
      run_once: true
      register: forge_users_scratch

    # The git module has no archive action that writes a tarball of HEAD.
    - name: Archive HEAD on the controller  # noqa: command-instead-of-module
      ansible.builtin.command:
        cmd: >-
          git -C "{{ forge_users_repo_root }}" archive --format=tar.gz
          -o "{{ forge_users_scratch.path }}/forge.tar.gz" HEAD
      delegate_to: localhost
      become: false
      run_once: true
      changed_when: true

    # Unpack into a staging directory and rename it at the end: a release
    # directory that exists is always complete.
    - name: Remove a staging directory left by an interrupted run
      ansible.builtin.file:
        path: "{{ forge_users_release }}.partial"
        state: absent

    - name: Create the staging directory
      ansible.builtin.file:
        path: "{{ forge_users_release }}.partial"
        state: directory
        mode: "0755"
        owner: root
        group: root

    - name: Unpack the release
      ansible.builtin.unarchive:
        src: "{{ forge_users_scratch.path }}/forge.tar.gz"
        dest: "{{ forge_users_release }}.partial"
        owner: root
        group: root

    - name: Record the release's commit
      ansible.builtin.copy:
        content: "{{ forge_users_sha }}\n"
        dest: "{{ forge_users_release }}.partial/COMMIT"
        mode: "0644"
        owner: root
        group: root

    - name: Move the release into place
      ansible.builtin.command:
        cmd: mv "{{ forge_users_release }}.partial" "{{ forge_users_release }}"
        creates: "{{ forge_users_release }}"
  always:
    - name: Remove the controller's scratch directory
      ansible.builtin.file:
        path: "{{ forge_users_scratch.path }}"
        state: absent
      delegate_to: localhost
      become: false
      run_once: true
      when: forge_users_scratch.path is defined

- name: Read the current release
  ansible.builtin.stat:
    path: "{{ forge_users_install_root }}/current"
  register: forge_users_current

- name: Keep the outgoing release as previous
  ansible.builtin.file:
    src: "{{ forge_users_current.stat.lnk_source }}"
    dest: "{{ forge_users_install_root }}/previous"
    state: link
    force: true
  when:
    - forge_users_current.stat.islnk | default(false)
    - forge_users_current.stat.lnk_source != forge_users_release

# The file module replaces an existing link through a temporary link and a
# rename, so `current` is never missing.
- name: Switch current to this release
  ansible.builtin.file:
    src: "{{ forge_users_release }}"
    dest: "{{ forge_users_install_root }}/current"
    state: link
    force: true
  notify: Regenerate forge's bash completion

- name: Put forge on the PATH
  ansible.builtin.file:
    src: "{{ forge_users_install_root }}/current/{{ forge_users_cli_entrypoint }}"
    dest: /usr/local/bin/forge
    state: link
    force: true

- name: Read the previous release
  ansible.builtin.stat:
    path: "{{ forge_users_install_root }}/previous"
  register: forge_users_previous

- name: List the installed releases
  ansible.builtin.find:
    paths: "{{ forge_users_install_root }}/releases"
    file_type: directory
  register: forge_users_releases

- name: Remove releases older than the previous one
  ansible.builtin.file:
    path: "{{ item.path }}"
    state: absent
  loop: "{{ forge_users_releases.files }}"
  loop_control:
    label: "{{ item.path | basename }}"
  when: item.path not in [forge_users_release, forge_users_previous.stat.lnk_source | default('')]
```

`ansible/roles/forge_users/tasks/main.yml`:

```yaml
---
- name: Forge user's account
  ansible.builtin.import_tasks: account.yml
- name: Forge user's tools
  ansible.builtin.import_tasks: tools.yml
- name: Forge release
  ansible.builtin.import_tasks: forge.yml
```

In `ansible/site.yml`, under `roles:`, after `- role: incus`, add:

```yaml
    - role: forge_users
```

- [ ] **Step 6: Run the unit tests, the syntax checks and lint**

Run: `npm run test:ansible </dev/null 2>&1 | cat`
Expected: PASS. Nothing changed in the unit layer, so this checks that nothing regressed.

Run: `ansible-playbook --syntax-check -i ansible/inventory.example.yml ansible/site.yml </dev/null 2>&1 | cat && ansible-playbook --syntax-check -i ansible/inventory.example.yml ansible/tests/verify.yml </dev/null 2>&1 | cat`
Expected: both print `playbook: …`

Run: `ansible-lint ansible/ </dev/null 2>&1 | cat`
Expected: `Passed`. For `var-naming[no-role-prefix]` on the `include_role` vars, apply the same `noqa` as in Task 8.

- [ ] **Step 7: Commit** (ask the user to be at the YubiKey first)

```bash
git add ansible/roles/forge_users ansible/site.yml ansible/tests/verify.yml ansible/tests/verify/forge_users.yml ansible/tests/files/incus-smoke.sh
git commit -m "feat: rôle forge_users (compte, Node 24, Claude Code, Ansible, release forge)"
```

---

### Task 10: CI on GitHub Actions

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes:
  - `npm test` and `npm run check` (existing);
  - the unit tests, `ansible-playbook -i ansible/tests/unit-inventory.yml ansible/tests/unit.yml` (Task 1+);
  - `.ansible-lint` and `ansible/requirements.yml` (Task 1).

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
# Light CI: the CLI's tests and type check, ansible-lint, and the host
# playbook's controller-only unit tests. The playbook's real test is
# ansible/tests/vm-test.sh, run on a host with KVM (not in CI).
name: ci

on:
  pull_request:
  push:
    branches: [next, main]

permissions:
  contents: read

jobs:
  cli:
    runs-on: ubuntu-26.04
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24
      # tmux: the contract tests use a real server (until sub-project 4
      # removes tmux); jq: tests/test-pre-bash.sh.
      - name: Install the test tools
        run: sudo apt-get update && sudo apt-get install -y tmux jq
      - run: npm ci
      - run: npm test
      - run: npm run check

  ansible-lint:
    runs-on: ubuntu-26.04
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: ansible/ansible-lint@9bce2bfb8f4a984e6b13767bc0d6bf0a49492164 # v26.10.1
        with:
          args: ansible/
          requirements_file: ansible/requirements.yml

  ansible-unit:
    runs-on: ubuntu-26.04
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - name: Install ansible-core
        run: |
          sudo apt-get update && sudo apt-get install -y pipx
          pipx install 'ansible-core>=2.20,<2.21'
      - name: Run the controller-only unit tests
        run: ansible-playbook -i ansible/tests/unit-inventory.yml ansible/tests/unit.yml
```

- [ ] **Step 2: Validate the workflow locally**

Run: `command -v actionlint >/dev/null || brew install actionlint; actionlint .github/workflows/ci.yml`
Expected: no output (no finding).

- [ ] **Step 3: Commit** (ask the user to be at the YubiKey first)

```bash
git add .github/workflows/ci.yml
git commit -m "ci: tests de la CLI, ansible-lint et tests unitaires du playbook hôte"
```

The workflow first runs on the pull request opened in Task 11. If a job fails because a runner lacks a tool, fix the CI setup in `ci.yml`, never by skipping the test.

---

### Task 11: VM checkpoint B and the pull request

**Files:** none, unless the run finds bugs.

- [ ] **Step 1: Ask the user for permission to push**, then push:

```bash
git push origin agent/v2-host
```

- [ ] **Step 2: Ask the user to run, on omen:**

```bash
git -C ~/src/agent-forge-next fetch origin
git -C ~/src/agent-forge-next checkout --detach origin/agent/v2-host
~/src/agent-forge-next/ansible/tests/vm-test.sh --exposure public
~/src/agent-forge-next/ansible/tests/vm-test.sh --exposure local
```

Expected: both end with `vm-test: PASS (exposure …)`. The spec requires `public`. `local` also covers the path where fail2ban is off. The user pastes the outputs.

- [ ] **Step 3: Fix what fails, then rerun from Step 1.** Use superpowers:systematic-debugging; each fix is a `fix:` commit. Ask the user to be at the YubiKey before each commit, and ask before each push. Likely suspects:
  - **The fail2ban "Total failed" check fails.** Check `journalctl -u ssh -o verbose` on a `--keep` VM for the real `_COMM` and `_SYSTEMD_UNIT` values, and adjust `journalmatch` in `agent-forge.local.j2` and its unit test.
  - **`apt_repo.yml` refuses a key.** Compare `gpg --show-keys --with-colons` on the host with the pinned value. Never update the pinned fingerprint without checking it against the vendor's documentation.

- [ ] **Step 4: Ask the user for permission to open the pull request**, then:

```bash
gh pr create --base next --head agent/v2-host \
  --title "feat: v2 sous-projet 1 — hôte provisionné par Ansible" \
  --body "$(cat <<'EOF'
## Summary
- `ansible/site.yml`: preflight play, then the six roles (base, hardening, firewall, fail2ban, incus, forge_users).
- Controller-only unit tests (`npm run test:ansible`), throwaway-VM test (`ansible/tests/vm-test.sh`), light CI.
- Spec: `docs/superpowers/specs/2026-10-15-v2-host-ansible-design.md`; plan: `docs/superpowers/plans/2026-10-15-v2-host-ansible.md`.

## VM test (omen, amd64)
<paste the last lines of both vm-test.sh runs here>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Replace the placeholder line with the real run summaries before sending. Then bind the PR with the ccd_pr tools and read its CI. Never merge it: the user reviews and merges it.
