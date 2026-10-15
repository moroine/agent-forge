# agent-forge v2 — Validation spike findings

**Date:** 2026-10-15
**Spec under test:** `docs/superpowers/specs/2026-10-15-v2-incus-ansible-herdr-design.md`
(section "Validation spike", points 1–9)
**Status:** Done. Throwaway work: the VM and every container below were
deleted afterwards. This report is the deliverable.

Each finding gives a verdict, the evidence (the commands run and the relevant
output, trimmed), and what it changes: the framing-spec section and the
sub-project spec it feeds (1 host, 2 runtime, 4 orchestration, 5 local mode).
The framing spec itself is not edited here.

## Summary

| # | Question | Verdict | Feeds |
|---|---|---|---|
| 1 | `herdr tab create` / `pane run` syntax | **Works** | 4 |
| 2 | `HERDR_AGENT=claude` through `incus exec` | **Works**, if the hint is on the wrapper process only | 4 |
| 3 | SSH features needed by `herdr --remote` | **Stdio only**: no forwarding, no sftp, `MaxSessions 1` is enough | 1, 4 |
| 4 | `claude --continue` after a herdr server restart | **Works**: same conversation resumed | 4 |
| 5 | Does an Incus ACL filter container → host? | **Works** (NIC or bridge level), for host addresses in the rejected ranges | 2, 5 |
| 6 | Chrome on linux/arm64 | **Workaround**: Chrome stable arm64 exists, but its sandbox fails on an Ubuntu 26.04 host; it runs with `--no-sandbox`. The same cause breaks rootless Docker | 2 (and 1) |
| 7 | Nested Incus without `mac_admin`/`mac_override`/`sys_ptrace` | **Workaround**: works with AppArmor disabled for the nested daemon and a smaller subuid range | 2 (later) |
| 8 | Server-side custom command from a remote client | **Only with `--remote-keybindings server`** | 4 |
| 9 | Config include | **Doesn't exist**: use the delimited block in `config.toml` | 4 |

Beyond the 9 points, the spike found two **blockers**:

- **Unprivileged user namespaces are refused in containers on an Ubuntu 26.04
  host** (point 6). This breaks Chrome's sandbox and rootless Docker
  (`rootlesskit`). Rootless Docker is in the v2 image, so sub-project 2 must
  settle this first.
- **Incus cannot auto-pick a bridge subnet under Lima** (additional finding A).
  This breaks `incus admin init --minimal` and any `ipv4.address=auto` in
  macOS local mode.

It also found one **simplification**: herdr 0.9.5 already gives panes and
popups a stable forwarded SSH agent (additional finding F). The `~/.ssh/rc`
mechanism of the framing spec is unnecessary.

## Environment

| Component | Version |
|---|---|
| Dev machine | macOS on Apple Silicon (arm64), Lima 2.2.1 (`vmType: vz`), herdr 0.9.5 (Homebrew) |
| Host VM | Ubuntu 26.04.1 LTS, kernel `7.0.0-34-generic`, aarch64, 4 vCPU / 6 GiB / 25 GiB |
| Incus | `1:7.0.1-ubuntu26.04-202609250512` from `https://pkgs.zabbly.com/incus/lts-7.0` (suite `resolute`, arm64), storage driver `dir` |
| Containers | `images:ubuntu/26.04/cloud` (arm64), project `agent-forge`, bridge `forgebr0` (`10.77.0.1/24`, IPv6 off) |
| Container profile | Mirror of v1's `config/lxd-agent-profile.yaml`: unprivileged, `security.nesting=true`, `security.syscalls.deny_default=true`, `limits.processes`, the v1 `raw.lxc` capability drops, `raw.idmap` computed from the VM user (uid 501 / gid 1000 → 1001) |
| Agent | `aiuser` (1001), Claude Code 2.1.300 (native installer), logged in by the user |
| herdr server on the VM | 0.9.5, auto-installed by the first `herdr --remote` |

The host VM had **no host firewall**, which models local Linux mode for
point 5. Its sshd was hardened for point 3 (see there).

---

## 1. herdr CLI: named tab running a command — works

**Syntax** (herdr 0.9.5; `docs/next/website/src/content/docs/cli-reference.mdx`
in the herdr repo, and verified):

```
herdr tab create [--workspace ID] [--cwd PATH] [--label TEXT] [--env KEY=VALUE]... [--focus|--no-focus]
herdr tab rename <tab_id> <label>
herdr pane run <pane_id> <command>          # types the command + Enter into the pane's shell
herdr pane split [<pane_id>|--pane ID|--current] --direction right|down [--cwd PATH] [--env KEY=VALUE] [--focus|--no-focus]
```

There is no `--command` flag on `tab create`. A tab always starts the user's
shell, and the command is typed into it with `pane run`. Creation leaves focus
unchanged unless `--focus` is given. `herdr tab create --help` (any third-level
`--help`) falls back to the global help, so the reference page is the
authority.

**Evidence:**

```
$ herdr tab create --label "demo/task-1" --cwd /tmp --env FORGE_SPIKE=1 --no-focus
{"id":"cli:tab:create","result":{"root_pane":{"cwd":"/tmp",…,"pane_id":"w1:p3",…},
 "tab":{…,"label":"demo/task-1","tab_id":"w1:t3",…},"type":"tab_created"}}
# pane run issued immediately, without waiting for the prompt (race test)
$ herdr pane run w1:p3 'echo "cwd=$PWD spike=$FORGE_SPIKE env=$HERDR_ENV bin=$HERDR_BIN_PATH"'
cwd=/tmp spike=1 env=1 bin=/home/<user>/.local/bin/herdr
$ herdr tab rename w1:t3 "demo/task-1-renamed"     → "label":"demo/task-1-renamed"
$ herdr pane run w1:p3 'exec sh -c "echo bye; sleep 1; exit 0"'
$ herdr tab list    → only w1:t1 left; herdr pane get w1:p3 → pane_not_found
```

- Running `pane run` straight after `tab create` worked: no race with a bash
  login shell.
- `exec <cmd>` makes the tab close when the command exits. Without it the user
  falls back to a host shell in that tab.

**Changes:** framing spec "Orchestration → Daily flow (remote)", step 2. In
sub-project 4, `forge` runs:

```
"$HERDR_BIN_PATH" tab create --label "<repo>/<task>" --cwd "$HOME/workspaces/<container>" --focus
"$HERDR_BIN_PATH" pane run <root_pane.pane_id> "exec env HERDR_AGENT=claude forge attach <container> <task>"
```

- The pane ID is parsed from `.result.root_pane.pane_id`.
- `--focus` is needed for "the new tab appears in the local UI" to also mean
  "the user lands on it". It was not tested; `--no-focus` was.
- Whether the tab should close when the agent exits (`exec`) is a
  sub-project 4 choice.

## 2. `HERDR_AGENT=claude` through `incus exec` — works, hint on the wrapper only

herdr reads the hint from `/proc/<pid>/environ` of the pane's **foreground
processes**. Behind `incus exec`, the only foreground process it sees on the
host is the `incus` client, so the hint must be in the environment of that
client or of a wrapper above it.

**Evidence:** three tabs, each running
`incus exec --project agent-forge spike2 --user 1001 --group 1001 --cwd /workspace --env HOME=/home/aiuser -- claude`.

| Variant | `herdr agent list` |
|---|---|
| A: no hint | not listed |
| B: `HERDR_AGENT=claude incus exec …` (hint on the command) | `claude idle` |
| C: `tab create --env HERDR_AGENT=claude`, plain `incus exec …` | `claude idle` |

```
$ herdr pane process-info --pane w1:p5
"foreground_processes":[{"argv":["incus","exec","--project","agent-forge","spike2",…,"/home/aiuser/.local/bin/claude"],"name":"incus",…}]
```

Lifecycle states are read from the screen and work through the incus pty
(variant B, after the user logged in):

```
$ herdr agent prompt w1:p5 "…run: sleep 4 && date. Then answer FINI." --wait   → returns, agent_status "idle" (working observed)
$ herdr agent prompt w1:p5 "Use AskUserQuestion: red or blue?" --wait
prompt --wait returned state: blocked
$ herdr agent explain w1:p5   → state: blocked, rule: live_blocked_form (region=after_last_horizontal_rule priority=980)
$ herdr agent send-keys w1:p5 esc   → after esc: idle
```

**Variant C is a trap:**

- After claude exits, the host bash shell still carries `HERDR_AGENT=claude`.
  herdr keeps reporting `w1:p6 claude idle` while the foreground process is
  `bash`: a false positive.
- A tab's `--env` is **not restored** after a herdr server restart. The
  restored shell has no `HERDR_AGENT`, so detection is lost (see point 4).

**Changes:** framing spec "Orchestration → Daily flow (remote)" ("with
`HERDR_AGENT=claude` set on the host-side wrapper") is confirmed and made
precise. In sub-project 4, the hint goes on the wrapper process only:
`exec env HERDR_AGENT=claude forge attach …`, or `forge attach` passes it in the
`incus` child's environment. Never on the tab.

## 3. SSH features needed by `herdr --remote` — stdio only

**Evidence:**

- VM sshd hardened to the most restrictive forwarding settings. The `sftp`
  subsystem was commented out, as `devsec.ssh_hardening` does by default.
- `MaxSessions 1` was added for the second run.
- The test used a **fresh** SSH connection: old ControlMaster connections were
  closed first (see additional finding D).

```
$ sudo sshd -T | grep …
maxsessions 1
allowagentforwarding no
allowtcpforwarding no
allowstreamlocalforwarding no
disableforwarding yes
permittunnel no
x11forwarding no
$ sftp forge-spike   → subsystem request failed on channel 0
```

- `herdr --remote forge-spike` (first run) prompted
  `Install the 0.9.5 stable asset for linux-aarch64 to "$HOME/.local/bin/herdr"? [Y/n]`.
- The install worked without sftp, and the TUI attached.
- The second run, with `--remote-keybindings server` on a fresh connection,
  attached too, and server custom commands fired (point 8).
- Client side, the whole transport is one stdio command:

```
ssh -C -F <herdr-generated config> -S /tmp/hssh-501/<hash>-%C -o ControlMaster=auto -o ControlPersist=600 \
    -T forge-spike printf '\n%s\n' 'herdr-remote-output-ready:1'
exec "$HOME/.local/bin/herdr" remote-client-bridge
```

Server side:
`sshd-session: <user>@notty → herdr remote-client-bridge → herdr server`.
The herdr v0.9.5 source agrees:

- `src/remote/` contains no `-L`, `-R` or `StreamLocalForward`.
- `install_herdr` (`src/remote/attach.rs`) streams the binary through the
  stdin of an `ssh` command. The client downloads the release asset first;
  here the Mac fetched the linux-aarch64 asset.
- `scp`, which needs the sftp subsystem in current OpenSSH, is only used for
  Windows remotes (`copy_windows_file`).

**Changes:**

- **Framing spec "Host → Roles → hardening"** ("exactly the forwarding features
  herdr's remote attach needs"): herdr needs **none**.
  - Sub-project 1: `ssh_hardening` keeps TCP, stream-local, X11 forwarding and
    tunnels off, and sftp disabled. `MaxSessions` can stay at its default.
  - The only forwarding to allow is `AllowAgentForwarding yes`, for forge users
    only, and it is for the host-side `git clone`/`fetch`, not for herdr (see
    finding F).
- **Sub-project 4:**
  - The first attach is interactive (`[Y/n]` install prompt). Per herdr's docs
    it fails when non-interactive.
  - The README's first-run instructions say so.

## 4. `claude --continue` after a herdr server restart — works

**Evidence:**

- The user logged in inside the container (variant B pane) and told claude to
  remember the word ANANAS.
- More turns followed (points 2 and 8).
- Then:

```
before stop: claude in container   PID 905 /home/aiuser/.local/bin/claude
             transcript            /home/aiuser/.claude/projects/-workspace/39c1664c-….jsonl (359399 bytes)
$ herdr server stop
after stop:  herdr procs → none ; host incus exec clients → none ; claude in container → none
# reattach (starts the server again)
restored tabs:   w1:t1 '1', w1:t4 'p2/A-no-hint', w1:t5 'p2/B-hint-on-cmd', w1:t6 'p2/C-hint-tab-env'
restored panes:  all host shells in /home/<user> (host cwd), agent_status unknown
herdr agent list → empty    (no integration; pane C's tab-level HERDR_AGENT not restored)
$ herdr pane run w1:p5 "HERDR_AGENT=claude incus exec … -- claude --continue"
screen: previous turns visible ("Retiens le mot ANANAS…", "Bash(sleep 4 && date)", "FINI", …)
transcript: same file 39c1664c-….jsonl, now 361407 bytes
$ herdr agent prompt w1:p5 "Which word did I ask you to remember? One word." --wait
● ANANAS
```

- **The agent dies with the server.** Stopping herdr closes the pty, which
  kills the `incus exec` client and claude inside the container. No orphaned
  claude is left behind.
- **Layout comes back, processes don't.** The server restores the layout and
  labels as bare host shells in their host cwd. It does not restart the agent.
- **Recovery is manual.** Running `claude --continue` in the same container cwd
  resumes the conversation. A `forge resume` run per tab is the recovery path.
- **Caveat:** right after `--continue`, Claude Code showed a feature
  announcement dialog ("Flicker-free output… 1. Yes, try it / 2. Not now").
  herdr saw it as `unknown` and a typed prompt went into the dialog.
  `forge resume`, or anything that prompts the agent automatically, must not
  assume an idle prompt right after start.

**Changes:**

- **Framing spec "Orchestration → Changes to forge"** (`forge resume` runs
  `claude --continue`; no dependency on herdr's resume integration): confirmed.
  - Sub-project 4 decides how the user resumes after a restart: a key binding,
    or a printed hint.
  - Optional later improvement, not tested: herdr's `resume_agents_on_restore`
    can replay a resume command. A host-side `herdr pane report-agent-session`
    pointing at `forge resume …` could feed it.
- `--continue` picks the latest conversation of the cwd. One worktree per task
  (`/workspace/.trees/<task>`) keeps tasks apart.

## 5. Incus ACL and container → host traffic — works (in the rejected ranges)

**Setup:**

- ACL `forge-egress`, as in the spec: egress `reject` to `10.0.0.0/8`,
  `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10`,
  `224.0.0.0/4`.
- Default egress action `allow`, default ingress action `reject`.
- Host-side listeners: `python3 -m http.server 8080` and sshd on `:22`.
- The probes target the bridge IP (`10.77.0.1`) and the VM's other address
  (`192.168.5.15`). They run inside the container (`hostname` = `spike2`).

| Probe from the container | no ACL | ACL on the NIC (`security.acls` on `eth0`) | ACL on the bridge (`forgebr0`) |
|---|---|---|---|
| `10.77.0.1:8080`, `10.77.0.1:22` | OPEN | blocked | blocked |
| `192.168.5.15:8080`, `192.168.5.15:22` | OPEN | blocked | blocked |
| DNS through the bridge | OK | OK | OK |
| `https://example.com` | 200 | 200 | 200 |
| Another container on `forgebr0` (`:9000`) | — | blocked (host → peer: OPEN) | — |

**Why it works:** at NIC level, Incus 7.0 writes the ACL into
`table bridge incus`. There, a chain on the **input** hook covers traffic
addressed to the host itself:

```
chain in.agent-forge_spike2.eth0 {
    type filter hook input priority filter; policy accept;
    …DHCP, ND, ct established…
    iifname "veth…" ip daddr 10.77.0.1 tcp dport 53 accept
    iifname "veth…" ip daddr 10.77.0.1 udp dport 53 accept
    iifname "veth…" ip daddr { 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4 } reject with icmp port-unreachable
    iifname "veth…" accept
}
chain fwd.agent-forge_spike2.eth0 { … ip daddr { …same ranges… } drop … }
```

**Limit:**

- Host services are blocked only because the host's addresses fall in the
  rejected ranges.
- With the default egress action `allow`, a host address outside them stays
  reachable from the container. Examples: a public IPv4 configured on the
  host, or on a dev machine.
- DNS (and DHCP) to the bridge is accepted before the ACL rules, as the spec
  already notes.

**Changes:**

- **Framing spec "Local mode → Linux"**, open point (spike 5): resolved. On a
  Linux dev machine whose addresses are private or CGNAT, the ACL alone keeps
  containers away from host services, so no manual nftables rule is needed.
  - The README (sub-project 5) documents the public-address exception.
  - `forge setup` can warn when a host address lies outside the rejected
    ranges.
- **"Security model summary"**, row "Container reaches host services": the
  local-Linux cell becomes "Incus ACL (host addresses in private/CGNAT
  ranges)".
- **Sub-project 2:** apply the ACL at NIC level through the profile, as
  planned. It also isolates containers from each other, as verified.
- **Sub-project 1:** the host firewall role must coexist with **three** tables:
  - `inet incus` and `bridge incus`, both written by Incus;
  - `ip nat`, present on the Lima VM.

  The "never `flush ruleset`" rule stands.

## 6. Chrome on linux/arm64 — workaround

**Chrome exists for arm64.** Google's apt repository publishes arm64, so the
Chromium fallback is not needed:

```
$ curl -fsSL https://dl.google.com/linux/chrome/deb/dists/stable/Release | grep Architectures
Architectures: amd64 arm64
Package: google-chrome-stable | Version: 155.0.8059.79-1 | Architecture: arm64
# in the container: apt install google-chrome-stable → ii google-chrome-stable 155.0.8059.79-1 arm64
```

**But it does not start with its sandbox on an Ubuntu 26.04 host:**

```
$ su - aiuser -c 'google-chrome --headless=new --disable-gpu --dump-dom https://example.com'
FATAL:sandbox/linux/services/credentials.cc:131] Check failed: . : Permission denied (13)
$ su - aiuser -c 'unshare -Ur id'          → unshare failed: Permission denied
$ unshare -Ur id   (as root in the container) → uid=0(root)
host: kernel.apparmor_restrict_unprivileged_userns = 1   (Ubuntu 26.04 default)
```

The cause is the host's `kernel.apparmor_restrict_unprivileged_userns=1`:
inside the container, an unprivileged user cannot create a user namespace.

- The Incus AppArmor profile of the container already contains `userns,`.
  Adding `raw.apparmor "userns,"` changes nothing.
- The container image has no `apparmor` package. Even with it, loading a
  profile would need `mac_admin`, which the profile drops.
- **The cause is not specific to arm64.** It comes from the host OS, so an
  amd64 Ubuntu 26.04 host would hit it too.

**Workarounds tested:**

| Option | Result |
|---|---|
| `--no-sandbox` | `<title>Example Domain</title>`; DevTools endpoint answers (`"Browser": "Chrome/155.0.8059.79"`, `"Protocol-Version": "1.3"`) |
| Host `sysctl kernel.apparmor_restrict_unprivileged_userns=0` (temporary) | Chrome works **with** its sandbox: `<title>Example Domain</title>` |
| Per-container `raw.apparmor "userns,"` | No effect |

`chrome-devtools-mcp` 1.10.1 supports passing the flag:
`--chrome-arg='--no-sandbox'` (its own help example).

**Same cause: rootless Docker is blocked too.** Rootless Docker relies on
`rootlesskit`, which creates a user namespace as `aiuser`:

```
host sysctl = 1:  [rootlesskit:parent] error: failed to start the child: fork/exec /proc/self/exe: permission denied
                  (rootlesskit's hint: install /etc/apparmor.d/usr.bin.rootlesskit with "userns,")
host sysctl = 0:  uid=0(root) gid=0(root) groups=0(root)
```

Full `dockerd-rootless-setuptool.sh` was not run; `rootlesskit` is the step
that fails.

v1 runs on Ubuntu 24.04 with LXD, where the same sysctl defaults to 1. Whether
v1's Chrome and rootless Docker are affected on omen was not checked. That
read-only check is worth doing.

**Changes:**

- **Framing spec "Runtime → Image"**: "On arm64, use Chromium if Chrome still
  has no linux/arm64 build" is obsolete; use Chrome stable on both
  architectures.
- **Framing spec "Runtime → Profile"** (rootless Docker via
  `security.nesting=true`) **does not hold as written** on a 26.04 host.
  Sub-project 2 must choose one of:
  1. **Host sysctl `kernel.apparmor_restrict_unprivileged_userns=0`.**
     - Simple, and tested to fix both Chrome and rootlesskit.
     - Weakens a host-wide Ubuntu mitigation.
     - On a single-user VM the forge user is already root-equivalent
       (`incus-admin`), so the marginal cost is low there.
     - On a local Linux dev machine it is a real weakening, to be documented
       and left to the user.
     - Setting it is sub-project 1's `base`/`hardening` role, which interacts
       with `os_hardening`. It is a host OS setting, so in local Linux mode it
       is a README step, not `forge`.
  2. **Per-binary AppArmor profiles (`userns,`) for `rootlesskit` and Chrome
     loaded inside the container.**
     - Needs `apparmor` in the image and `mac_admin`/`mac_override` kept.
     - Not tested.
  3. **Chrome with `--no-sandbox`**, the container being the boundary. This
     does not solve rootless Docker.

  Recommendation: test option 1 against `os_hardening` first in sub-project 2,
  and keep `--no-sandbox` as Chrome's fallback.

## 7. Nested Incus without the three capabilities — workaround (optional point)

**Setup:**

- Container `nest7` with the v2 profile.
- Its bounding set lacks `mac_admin`, `mac_override` and `sys_ptrace`:
  `CapBnd: 00000100afa435ff`.
- Nested Incus installed with `apt install incus` from the Ubuntu archive.

**Findings:**

- **Ubuntu 26.04's archive ships Incus `6.0.5-8`, not 7.0.** Super mode would
  need the Zabbly repository inside the image.
- **AppArmor:**
  - Without `mac_admin` the nested daemon cannot load AppArmor profiles, so its
    bridge's dnsmasq fails:
    `aa-exec: ERROR: profile 'incus_dnsmasq-nestbr0_</var/lib/incus>' does not exist`.
  - Workaround: `Environment=INCUS_SECURITY_APPARMOR=false` on the nested
    `incus.service`. The network is then created.
- **subuid range:**
  - The default nested subuid range (`root:1000000:1000000000`) does not fit
    in the outer container's map, which holds about 1e9 ids. Error:
    `newuidmap: write to uid_map failed: Operation not permitted`.
  - Workaround: `root:1000000:100000000` in `/etc/subuid` and `/etc/subgid`.
- **cgroup BPF:** `cgroup2_devices … Failed to load bpf program: Operation not
  permitted` is logged but **not fatal**. `bpf` is in the dropped caps.
- **Result:** with those three changes, plus an explicit bridge subnet (see
  finding A), a nested container starts, gets an address and reaches the
  internet:

```
| nested | RUNNING | 10.88.0.237 (eth0) | CONTAINER |
<title>Example Domain</title>
```

**Changes:**

- **Framing spec "Non-goals → Super mode"**: when super mode returns, it does
  **not** need to restore the three capabilities v1's `agent-super` profile
  keeps for snapd. Instead it needs:
  - Zabbly Incus in the image;
  - AppArmor off for the nested daemon, so nested containers lose that layer
    while the outer confinement stays;
  - a subuid/subgid range sized to the outer map.
- This feeds the future super-mode work in sub-project 2.

## 8. Server-side custom command from a remote client — only with `--remote-keybindings server`

**Setup:**

- Host `~/.config/herdr/config.toml`: a popup custom command on `prefix+f`.
- The command writes a marker file and dumps the `HERDR_*` env, on the
  server.
- `herdr server reload-config` applied it:
  `{"result":{"diagnostics":[],"status":"applied",…}}`.
- Keys were sent to a Mac client running in a private tmux (`send-keys C-b f`).
- Sanity check: `prefix+c` opens herdr's "new tab" dialog the same way.

| Client | `ctrl+b f` |
|---|---|
| `herdr --remote forge-spike` (default: local keybindings) | **NOT FIRED** |
| `herdr --remote forge-spike --remote-keybindings server` | **Fired**: popup on the Mac showing `lima-forge-spike` / `POPUP-ON-SERVER` |

Environment of the popup process on the server:

```
HERDR_ACTIVE_PANE_CWD=/home/<user>   HERDR_ACTIVE_PANE_ID=w1:p1   HERDR_ACTIVE_TAB_ID=w1:t1
HERDR_ACTIVE_WORKSPACE_ID=w1         HERDR_BIN_PATH=/home/<user>/.local/bin/herdr
HERDR_ENV=1                          HERDR_SOCKET_PATH=/home/<user>/.config/herdr/herdr.sock
```

This matches the herdr source. Test
`local_keybindings_profile_includes_defaults_and_excludes_commands`
(`src/config.rs`) shows that the local keybinding profile carries no
`[[keys.command]]`.

**`prefix+n` is taken by default.** In herdr's defaults, `prefix+n` is
`next_tab`.

- A custom command on `prefix+n` passes `herdr config check` (`config: ok`).
- It silently wins: the marker fired and the focused tab did not change.

Default prefix bindings use
`n ? s q o w g c p e h j k l v x z r b`, `tab`, `minus`, `1..9` and several
shift variants. Free letters include `f`, `a`, `t`, `d`, `i`, `m`, `u`, `y`.

**Changes:**

- **Framing spec "Orchestration → Daily flow (remote)", step 1**: the attach
  command becomes `herdr --remote forge-vm --remote-keybindings server`. It
  goes in the README (sub-projects 4 and 5), and in a `herdr machine` profile
  if one is used.
  - With server keybindings the server's whole keymap applies, so the user's
    local herdr key customizations do not apply in that session. Worth a line
    in the README.
- **Framing spec "herdr key bindings"**: the example `prefix+n` shadows
  `next_tab`. Sub-project 4 picks a free key, `prefix+f` for example.
- The popup has `HERDR_ENV=1`, so `forge start` run from it takes the "inside
  herdr" path. It has `HERDR_BIN_PATH` and `HERDR_SOCKET_PATH` but no
  `HERDR_PANE_ID`. Use `--workspace "$HERDR_ACTIVE_WORKSPACE_ID"` when creating
  the tab.

## 9. Config include — not supported

Every candidate syntax is rejected by `herdr config check`. The server reads a
single file (`src/config/io.rs`, `read_optional_config(path)` →
`std::fs::read_to_string`), and no `conf.d` is looked up.

```
== include = string     → unknown config key include; ignoring key
== include = array      → unknown config key include; ignoring key
== includes / import / imports / extends → unknown config key …; ignoring key
== [include] path       → unknown config section [include]; ignoring section
== keys.command_files   → unknown config key keys.command_files; ignoring key
```

**Changes:** framing spec "herdr key bindings". The fallback the spec already
describes becomes the plan: `forge setup` owns a delimited, idempotent block
in `~/.config/herdr/config.toml`. Details for sub-project 4:

- After writing, `forge setup` runs `herdr server reload-config`, which
  applied changes live in the spike. Startup-only settings still need a
  restart.
- herdr's own `herdr config reset-keys` "backs up config.toml and removes
  custom keybindings". Its effect on forge's block was not tested; re-running
  `forge setup` restores the block.
- Unknown keys are warnings, not errors, so a typo in forge's block would be
  silently ignored. The unit tests should run `herdr config check` on the
  generated block (contract test).

---

## Additional findings (outside the 9 points)

**A. Incus cannot auto-pick a subnet under Lima.**

```
$ sudo incus admin init --minimal
Error: Failed to create local member network "incusbr0" in project "default": Failed generating auto config:
Failed to automatically find an unused IPv4 subnet, manual configuration required
$ ping -c1 10.123.45.1 / 10.200.7.1 / 172.31.9.1 / 203.0.113.9   → all answer
```

Lima's user-mode network (`vz`, default networking) answers ICMP for every
address, so Incus believes every candidate subnet is in use. The same happened
for the nested Incus in point 7.

- **Sub-project 1**, `incus` role: initialize with a preseed that creates the
  storage pool only, never `--minimal`'s auto network.
- **Sub-project 2**, `forge setup`: create `forgebr0` with an explicit
  `ipv4.address`, configurable in forge's config, rather than `auto`.
- **Sub-project 5:** document it for macOS. Lima's `vzNAT` networking might
  avoid it; not tested.

**B. `raw.idmap` from the real UID/GID works without touching `/etc/subuid`.**

```
raw.idmap: "uid 501 1001\ngid 1000 1001"   (VM user uid 501 / gid 1000)
/proc/<init>/uid_map:   0 1000000 1001 / 1001 501 1 / 1002 1001002 999998998
/proc/<init>/gid_map:   0 1000000 1001 / 1001 1000 1 / 1002 1001002 999998998
```

Root's `/etc/subuid` entry (`root:1074266112:1000000000`) was left untouched.
This confirms "`raw.idmap` computed from the forge user's actual UID/GID"
(framing spec "Runtime → `forge setup`") with no host OS step, which matters
for local Linux mode (sub-projects 2 and 5).

**C. `incus profile create` reads YAML from stdin when stdin is not a TTY.**
A non-interactive caller hung until killed. The CLI port (sub-project 2) must
close stdin or pass the YAML explicitly when it shells out to `incus`. The
fake `incus` in unit tests should model this.

**D. herdr's SSH multiplexing hides sshd changes.**

- The client keeps a ControlMaster with `ControlPersist=600`.
- An attach right after an sshd config change reused a connection opened
  before it, so the old settings still applied.
- Sub-project 1's tests of `ssh_hardening` must close masters first:
  `ssh -S /tmp/hssh-<uid>/… -O exit <host>`.

**E. The herdr server is started by, and inherits the environment of, the SSH
session that first attaches.**

- Process tree: `sshd-session → herdr remote-client-bridge → herdr server`.
- The server's environment holds that session's `SSH_CLIENT` and
  `SSH_CONNECTION`.
- The server survives the client's detach (`prefix+q`): same PID afterwards,
  re-parented.
- If `os_hardening` turns on logind's `KillUserProcesses`, the server would die
  at logout. Sub-project 1 should check it.

**F. herdr already provides the stable SSH agent.** This makes the `~/.ssh/rc`
mechanism unnecessary.

herdr 0.9.5 has its own mechanism (`src/remote/ssh_agent.rs`, docs page
"Connecting machines"):

- The client bridge registers its forwarded `SSH_AUTH_SOCK` with the server.
- Panes and popups get a stable address,
  `~/.config/herdr/herdr.sock.agent`.
- That address is repointed at each attach.

**Setup:**

- A **throwaway** `ssh-agent` and key on the Mac; the user's own agent was
  never forwarded.
- `AllowAgentForwarding yes` on the VM, with every other forwarding still off.

```
# new tab created while attached
SOCK=/home/<user>/.config/herdr/herdr.sock.agent
256 SHA256:yNbD… spike-throwaway-key (ED25519)
# client detached and SSH masters closed → same pane:
Error connecting to agent: No such file or directory
# reattached over a new SSH connection → same pane, same SSH_AUTH_SOCK:
256 SHA256:yNbD… spike-throwaway-key (ED25519)
# server-side popup (prefix+f), i.e. where `forge start` will run:
SSH_AUTH_SOCK=/home/<user>/.config/herdr/herdr.sock.agent
256 SHA256:yNbD… spike-throwaway-key (ED25519)
```

**Changes:**

- **Framing spec "Orchestration → Stable SSH agent" and "Host → Roles →
  `forge_users`"** (`~/.ssh/rc`, `~/.ssh/agent.sock`): herdr does this
  natively, for panes and for the popup.
  - Sub-project 1 can drop the `~/.ssh/rc` part.
  - In sub-project 4, `forge` relies on the `SSH_AUTH_SOCK` it inherits inside
    herdr.
- **Behaviour when disconnected:** with no client attached, git fails with
  `Error connecting to agent`, the "clear message" the spec asks for.
- **Panes created before an agent was supplied** keep their old environment,
  per herdr's docs, and must be recreated once.
- **README gotcha (sub-project 5):** the OpenSSH client only requested
  forwarding when its default agent (`IdentityAgent`) answered (`ssh -vvv`:
  `ssh_get_authentication_socket` on the `IdentityAgent` path). The agent
  holding the YubiKey must therefore be the default agent for the forge host.

**G. `~/.local/bin` is not on the PATH of non-interactive SSH commands on
Ubuntu.** After installing, herdr warned:
`installed remote binary to ~/.local/bin/herdr, but the remote shell does not resolve herdr to that path`.

- herdr itself uses the absolute path, so attach works.
- Scripts run by herdr should use `$HERDR_BIN_PATH`, as the spec already says.
- Sub-project 1's `forge_users` role may add `~/.local/bin` to PATH.

**H. Chrome on Ubuntu 26.04** and **Incus in the Ubuntu archive**: see points
6 and 7.

## What this spike did not cover

- The full host-side `git clone`/`fetch` with the YubiKey agent. Forwarding
  itself was verified with a throwaway agent (F).
- `tab create --focus`.
- herdr's resume integration fed by `pane report-agent-session`.
- The full rootless Docker setup (only `rootlesskit`).
- Lima `vzNAT`.
- Behaviour on an amd64 host.
- v1's Chrome/rootless Docker on omen.
