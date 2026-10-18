# agent-forge v2, sub-project 3: Egress allowlist — Design

**Date:** 2026-10-17
**Status:** Approved by the user (2026-10-18)
**Branch:** `agent/v2-egress-spec` → `next` (stacked on `agent/hook-fail-closed`, moroine/agent-forge#36)
**Framing spec:** `docs/superpowers/specs/2026-10-15-v2-incus-ansible-herdr-design.md`
(section "Optional egress allowlist (sub-project 3)")
**Runtime spec:** `docs/superpowers/specs/2026-10-15-v2-runtime-design.md` (sub-project 2, implemented)
**Spike report:** `docs/superpowers/spikes/2026-10-15-v2-validation-spike.md` (point 5)

## Context and intent

v2 containers have open egress by default: everything except private,
link-local, CGNAT and multicast ranges (ACL `forge-egress`). The framing spec
adds an opt-in **strict mode** for sensitive repositories, and decides its
shape, which this document does not reopen:

- a `forge-proxy` container, managed by `forge setup`, runs a forward HTTP(S)
  proxy that filters by domain;
- a strict container gets ACL `forge-egress-strict` (default egress reject; only
  the proxy's address and port allowed) and `HTTP_PROXY` / `HTTPS_PROXY`,
  including in the rootless Docker daemon's environment. It fails closed: a
  program that ignores the proxy reaches nothing;
- v2.0: one allowlist per user, strict mode toggled per container;
- DNS exfiltration is a known limit, documented and deferred.

**Why (from the user).** The point is not mainly code confidentiality. It is
that someone who takes control of an agent — through a prompt injection in an
issue, a dependency's README, a page read by WebFetch — cannot attack the
organization: no access to its data, no reach into its systems, integrity of
the code. The Claude token is the only thing a hijacked agent is tolerated to
leak; what the user hands to the VM is otherwise low-impact. In v2.0 strict mode
is a **demonstrable control** more than an answer to a current use case: it must
let the user show a security officer (RSSI) that a strict container reaches
exactly what is listed and nothing else.

**Where it goes later (not v2.0).** Full sovereignty: a VM with no internet at
all, a local model, reverse engineering on sensitive code, and an **empty**
allowlist. v2.0 must not preclude it.

## Goals

- A strict container reaches only the domains on the user's allowlist, through
  the proxy; anything else fails, including programs that ignore the proxy.
- The allowlist is one human-readable file, each entry an explicit, commented
  choice; an empty list is valid and means "nothing".
- The user (and a security officer) can see which containers are strict and
  what the proxy allowed and refused.
- Developer tooling inside a strict container keeps working for allowlisted
  domains: Claude Code (including Remote Control), Node, npm/pnpm, pip, git over
  HTTPS, curl, Chrome through chrome-devtools-mcp, rootless Docker (daemon
  pulls; builds and containers when they are handed the proxy variables, see
  "Proxy settings inside").

## Non-goals and anti-goals

- **No TLS interception.** The proxy sees the CONNECT host only. Closing
  exfiltration to an allowed domain (see "Known limits") would need a CA injected
  into every trust store and a decrypting proxy; out of scope.
- **No DNS exfiltration fix** (framing decision). Noted below as a possible
  future direction only.
- **No per-container or per-repo allowlists** (framing: one per user in v2.0).
- **No local-model endpoint, no offline VM.** Designed for: an empty list works,
  and a later sub-project can add an allowed private endpoint (a local model on
  the host or the LAN) without restructuring.
- **Anti-goal: fail open.** Any state where a container marked strict has
  unfiltered egress — even briefly, even on an error path — is a failure of this
  design, whatever else works.
- **Anti-goal: a strict container that ever booted open.** A strict container is
  created strict; it never had open egress, not even during provisioning.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Proxy software | **squid** (Ubuntu `main`, `squid` 7.2 in resolute) | Security support from Ubuntu; `dstdomain -n` matching; an `access.log` format security teams know. tinyproxy rejected: `universe`, recent CVEs fixed only as upstream commits. smokescreen rejected: not packaged |
| Proxy placement | Instance `forge-proxy` in project `agent-forge`, fixed address on `forgebr0` | Framing decision; a fixed address lets the strict ACL name it |
| Proxy address | First address of a block reserved out of the bridge's DHCP range (default `10.77.0.2`) | Bridge ACLs only accept addresses, not ACL names (see "Incus facts") |
| Strict ACL | `forge-egress-strict`: allow TCP 3128 to the proxy, UDP 67 to the bridge; default egress and ingress reject | Fails closed; UDP 67 lets DHCP leases renew |
| Incus version | **Strict mode requires Incus 7.0.2+ on the 7.0 LTS line, or 7.5.0+** | Earlier releases can leave a NIC unfiltered when a filter update fails (lxc/incus#4008): fail open |
| Allowlist file | `~/.config/agent-forge/egress-allowlist`, one domain per line, `#` comments | One reviewable file, a justification per line |
| Default list | Anthropic's four domains active; GitHub, npm, PyPI, Docker Hub, Claude telemetry shipped commented | Claude Code works out of the box; every other entry is an explicit choice |
| Applying the list | Edit the file, run `forge setup` | `forge setup` is already the one idempotent convergence command |
| CLI | `forge start --strict`, `forge egress [<owner/repo>] [strict\|open]`, `forge egress log [<owner/repo>]`, an `EGRESS` column in `forge list` | Strict from creation; toggle later; audit trail |
| Toggling | Only on a stopped container | Conntrack keeps already-open connections alive after an ACL change |
| In-container proxy settings | Rewritten idempotently at every `forge start`/`resume` of a strict container | Survives a proxy address change; needs no file access to a stopped container |
| Docker builds and containers | No proxy by default; the agent hands it explicitly when needed | Docker's `proxies` setting would send Compose service-to-service calls to squid |
| Proxy build | Driven by `forge setup` in TypeScript, no Ansible: launch `images:ubuntu/26.04`, install `squid` and `unattended-upgrades`, push forge-generated config | A handful of commands, unit-tested with the fake `incus` like every other object |
| Proxy lifecycle | Disposable: config files converged in place; instance recreated when forge's proxy recipe version changes | No state worth keeping in it except recent logs |

## Incus facts this design relies on

Checked against the Incus v7.0.1 and v7.0.2 source (`internal/server/`); the
integration tests confirm them on a real host.

- **Rule subjects on a bridge are addresses only.** `source`/`destination` take
  IPs, CIDRs, ranges and address sets; ACL names and `@internal`/`@external` are
  OVN-only ("Bridge limitations" in the ACL docs; `aclRuleSubjectToACLMatch` in
  `firewall/drivers/drivers_nftables.go`). Creation accepts an ACL name and only
  the filter application fails, so forge must never write one.
- **NIC-level ACLs filter container ↔ container traffic in both directions.**
  Each NIC has its own chain on the bridge forward hook: A's egress rules and B's
  ingress rules must both accept. Chains start with
  `ct state established,related accept`, so replies pass, and so do connections
  opened before an ACL change.
- **Ingress `reject` is rendered as `drop`**, and so is an egress reject towards
  another container on the bridge: wrong-port probes to the proxy time out
  rather than fail fast. Egress reject towards the host or the outside is a real
  reject (ICMP port-unreachable).
- **Baseline rules precede the ACL.** DNS (TCP/UDP 53) to the bridge address,
  DHCPv4 from `0.0.0.0` to broadcast, and DHCP replies are always accepted.
  Unicast DHCP renewals (client address → bridge:67) are **not**, hence the
  explicit UDP 67 rule.
- **Static address on a bridged NIC.** NIC key `ipv4.address` is a dnsmasq
  reservation; Incus checks it against other NICs' static addresses only, not
  against dynamic leases. By default the dynamic range is the whole subnet.
  `ipv4.dhcp.ranges` (`FIRST-LAST[,…]`) on the bridge keeps a block out of it.
  `ipv4.address` belongs on the instance's own device, not in a profile.
- **Live updates.** `security.acls` and `security.acls.default.*` on a running
  NIC update in place, and ACL rule edits reach running NICs that use the
  `network=` key (forge's profiles do). `environment.*` instance keys apply at
  the next `incus exec`. `incus config device set` refuses a profile device; a
  per-instance override is `incus config device override`, or `-d` at
  `create`/`launch`.
- **ACL logging** (`state: logged`) goes to the host kernel log; `incus network
  acl show-log` works for OVN only. The proxy's `access.log` is therefore the
  audit trail.
- **The fail-open fix.** Commit c5173e31 ("Keep existing filters when an update
  fails", 2026-09-17) and the one-transaction chain and set replacement came
  with it. They are in feature release **7.5.0** and later, and backported to
  LTS **7.0.2** (2026-10-16). Earlier releases (7.0.0–7.0.1, 7.1.0–7.4.0, the
  6.0 LTS line) delete and recreate the chains in separate calls (a brief
  unfiltered gap) and leave the NIC unfiltered when an update fails
  (lxc/incus#4008). Sub-project 1's `incus` role installs the latest `lts-7.0`
  package, so a fresh VM gets 7.0.2 or later.

### The version gate

`environment.server_version` (from `incus query /1.0`) is parsed as
`MAJOR.MINOR[.PATCH]`. Strict mode is allowed when the version is `7.0.x` with
`x ≥ 2`, or ≥ `7.5.0` (any later minor or major). Everything else is refused:
6.x, 7.0.0–7.0.1, 7.1–7.4, and a version string forge cannot parse. The refusal
names the version found and the fix (upgrade Incus; on a VM, re-run the host
playbook). If 6.0 LTS gets the backport, the gate is widened then, not
guessed now.

## The allowlist

### File and format

`~/.config/agent-forge/egress-allowlist`, next to `config.json` (same
`$XDG_CONFIG_HOME` handling, `paths.ts`).

- One entry per line. `#` starts a comment, to the end of the line. Blank lines
  are ignored.
- `example.com` allows that host only. `.example.com` allows the domain and all
  its subdomains (squid's `dstdomain` semantics, documented in the file header).
- Validation is strict, as for `config.json`: an invalid line stops `forge
  setup` with the file, the line number and the expected form. Refused:
  - anything but lowercase LDH labels (`a-z`, `0-9`, `-`, no leading or trailing
    hyphen) separated by dots, with at least two labels; internationalized names
    must be written in punycode (`xn--…`);
  - IP literals, ports, schemes, paths, `*` wildcards, a trailing dot;
  - duplicates, and overlaps (`example.com` with `.example.com`, or
    `a.example.com` with `.example.com`), which squid warns about and handles
    surprisingly.
- An empty list (no entry left after comments) is valid: strict containers then
  reach nothing. `forge setup` says so in one line; it does not refuse.

### Default content

`forge setup` writes the default file when it is missing, and **never rewrites
an existing one**, even an empty one. Its header explains the format, that the
list applies to every strict container, and that changes take effect at the next
`forge setup`. Each entry carries a comment saying why it is there.

Active:

| Entry | Why |
|---|---|
| `api.anthropic.com` | API, Remote Control, feature flags, WebFetch's domain check |
| `platform.claude.com` | OAuth token exchange and refresh, claude.ai accounts included |
| `claude.ai` | Account authentication |
| `downloads.claude.ai` | Anthropic's apt repository (Claude Code refresh at provisioning) |

Shipped commented, grouped, each group with a warning where it applies:

| Group | Entries | Note in the file |
|---|---|---|
| GitHub | `github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `raw.githubusercontent.com` | Needed for the superpowers plugin. Anyone can publish there (repos, gists, releases): a hijacked agent can fetch from, and with a token push to, any of it |
| npm | `registry.npmjs.org` | With a token, `npm publish` is an exfiltration channel |
| PyPI | `pypi.org`, `files.pythonhosted.org` | Same remark for uploads |
| Docker Hub | `registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com`, `docker-images-prod.s3.dualstack.us-east-1.amazonaws.com` | Same remark for pushes. The registry redirects image layers to a storage host (the last entry, seen in a real pull); when a pull is still refused, check `forge egress log` for the host it tried |
| Claude telemetry | `http-intake.logs.us5.datadoghq.com`, `browser-intake-us5-datadoghq.com` | Optional: Claude Code works without them |

The Anthropic list comes from Claude Code's documentation (network
configuration, data usage, Remote Control requirements). Whether `claude.ai`
is contacted at runtime with a copied credentials file is unconfirmed; the
manual acceptance check (see "Testing") settles it, and the default list is
trimmed or completed from what `forge egress log` shows there.

## The proxy

### Address plan

- The bridge keeps forge's configured address (`network.ipv4Address`, default
  `10.77.0.1/24`).
- **Reserved block:** the 8 addresses from network + 2 to network + 9. The
  bridge's `ipv4.dhcp.ranges` becomes network + 10 → broadcast − 1. (If the
  bridge's own address falls in the reserved block, it is skipped when picking
  slots; dnsmasq never leases its own address anyway.)
- **Proxy address:** the first reserved address that is not the bridge's
  (`10.77.0.2` by default). It is a slot: slot 0 for project `agent-forge`, slot
  1 for the test-only `FORGE_INCUS_PROJECT` override (see "Testing"); the other
  slots are free for later (multi-user B: one proxy per user).
- `network.ipv4Address` validation tightens from `/30` to **`/27` at most**, so
  that the reserved block and a DHCP range of at least 20 addresses fit. v2 is
  unreleased; no migration.
- Changing the DHCP range on a host with running containers can leave a
  container holding a lease inside the reserved block. `forge setup` checks
  every instance's current IPv4 (from `incus list -f json`): if one other than
  the proxy holds the proxy's address, it stops before creating the proxy and
  names the container to restart.

### Incus objects (added to `forge setup`)

In convergence order, after the existing project, bridge, `forge-egress` and
`agent-forge` profile:

| Object | Project | Desired state |
|---|---|---|
| Bridge `forgebr0` (changed) | `default` | Existing keys plus `ipv4.dhcp.ranges=<network+10>-<broadcast−1>` |
| ACL `forge-proxy` | `default` | One ingress rule: `allow`, `enabled`, TCP, source `<bridge subnet>`, destination port `3128`. No egress rule |
| ACL `forge-egress-strict` | `default` | Egress: `allow` TCP to `<proxy address>` port `3128`; `allow` UDP to `<bridge address>` port `67`. No ingress rule |
| Profile `forge-proxy` | `agent-forge` | Below |
| Instance `forge-proxy` | `agent-forge` | Below |

Profile `forge-proxy`:

```yaml
config:
  security.privileged: "false"
  security.nesting: "false"
  security.syscalls.deny_default: "true"
  limits.memory: 512MiB
  limits.processes: "1000"
  raw.lxc: <the agent profile's capability drops, same rule for restricted projects>
  boot.autostart: "true"
devices:
  eth0:
    type: nic
    name: eth0
    network: forgebr0
    security.acls: forge-egress,forge-proxy
    security.acls.default.egress.action: allow
    security.acls.default.ingress.action: reject
  root:
    type: disk
    path: /
    pool: <storagePool>
    size: 4GiB
```

- `forge-egress` on the proxy's own NIC means an allowlisted name that resolves
  to a private, link-local or metadata address is still unreachable (DNS
  rebinding towards the host, the LAN or `169.254.169.254`). squid's own
  `privdst` rule repeats it.
- No `raw.idmap` and no workspace: the proxy holds no user data.
- `ipv4.address=<proxy address>` is set on the instance's eth0 at creation
  (`-d eth0,ipv4.address=…`), never in the profile.
- The name does not start with `agent-`, so `forge list` and completion never
  show it.

### Instance lifecycle (in `forge setup`)

1. **Recipe.** A constant `PROXY_RECIPE` (an integer) versions the package set
   and installation steps. The instance carries `user.forge.proxy_recipe`, set
   as the **last** creation step.
2. **Missing, incomplete or outdated** (no instance, no `user.forge.proxy_recipe`,
   or a different value): delete any leftover `forge-proxy`, then:
   - `incus launch images:ubuntu/26.04 forge-proxy --profile forge-proxy -d eth0,ipv4.address=<addr>`;
   - `waitReady` (shared helper);
   - `apt-get update` (with retries, as in the image build) and
     `apt-get install -y squid unattended-upgrades`;
   - enable unattended upgrades (Ubuntu's security pocket, the default);
   - push the config files (next step), then `squid -k parse`, then enable and
     restart squid;
   - set `user.forge.proxy_recipe`. Outcome: `created` (or `updated` when an
     outdated one was replaced).
3. **Present and current:** converge its address (`ipv4.address` on the local
   eth0, restart when it changed, e.g. after a bridge address change) and its
   config files.
4. **Config files** — `/etc/squid/squid.conf` and `/etc/squid/allowlist`, both
   generated by forge (pure functions, unit-tested). Read back with
   `incus file pull forge-proxy/<path> -` and compared byte for byte; when
   either differs: push both (owner root, mode 644), `squid -k parse` (a failure
   leaves the previous running configuration in place and stops `forge setup`
   with squid's message), then `squid -k reconfigure`. Outcome: `updated` or
   `unchanged`.
5. **Running:** `forge setup` starts the proxy if it is stopped.
6. **Back up:** squid refuses connections for a few seconds after a restart or
   a reconfigure. After each one (creation included), `forge setup` waits
   until squid accepts TCP on `<proxy address>:3128`, probed from inside the
   proxy (`timeout 2 bash -c '< "/dev/tcp/$0/$1"' <addr> 3128`), up to 30
   attempts a second apart. Only then is the loaded configuration recorded
   (`user.forge.proxy_config`); a squid that never answers stops `forge setup`
   with an error and leaves the hash unrecorded, so the next run retries.

Report lines, in the existing style: `network acl forge-proxy: created`,
`network acl forge-egress-strict: created`, `profile forge-proxy: created`,
`instance forge-proxy: created`, `allowlist: created (default list)` /
`allowlist: 4 entries` / `allowlist: empty (strict containers reach nothing)`.

When the creation fails (no network, apt error), `forge setup` stops naming the
step and leaves the incomplete instance for debugging; the next run replaces it
(no recipe key). The proxy is never "half converged" for strict containers in a
way that opens anything: a broken proxy only denies.

### squid configuration

Generated from the bridge subnet and the allowlist. Requirements (the exact text
is the builder's):

- `http_port <proxy address>:3128` only; ICP and HTCP off (`icp_port 0`,
  `htcp_port 0`); `cache deny all`, no cache directory; no FTP, no URN, no
  authentication helpers; `via off`, `forwarded_for delete`.
- `acl agents src <bridge subnet>`; everything else denied.
- `http_access` order:
  1. deny ports other than 80 and 443;
  2. deny `CONNECT` to ports other than 443;
  3. deny FTP;
  4. deny IP-literal destinations (`dstdom_regex -n` for IPv4 and bracketed
     IPv6) — without `-n`, `dstdomain` would reverse-resolve an IP literal and
     an attacker-controlled PTR record could match an allowed suffix;
  5. allow `agents` to `dstdomain -n "/etc/squid/allowlist"` **and not** to a
     private, loopback, link-local or CGNAT destination (`!privdst`, a `dst`
     ACL, IPv4 and IPv6), in that order on one line: `dst` makes squid resolve
     the name, and squid stops at the first ACL that does not match, so only a
     listed name is ever resolved (a refused name causes no DNS query, no DNS
     channel through the proxy);
  6. deny all.
- With an empty allowlist, rule 5 is omitted (squid treats an empty ACL file
  inconsistently across versions).
- `access_log` in squid's native format at `/var/log/squid/access.log`, rotated
  by the package's logrotate. Each line holds the client address, the result
  (`TCP_DENIED/403`, `TCP_TUNNEL/200`, …), the method and the host.
- squid resolves names itself through the proxy container's resolver (the
  bridge's dnsmasq): a strict client needs no DNS for proxied traffic.

## Strict containers

### Network

A strict container's `eth0` is a per-instance override of the profile's NIC:

- `security.acls=forge-egress-strict`
- `security.acls.default.egress.action=reject`
- `security.acls.default.ingress.action=reject`

Nothing else reaches out: no direct internet, no host service, no other
container. DNS to the bridge stays possible (baseline rule): the known limit.

### Proxy settings inside

Every consumer gets the proxy (`http://<proxy address>:3128`), both letter
cases where tools differ:

| Consumer | Mechanism |
|---|---|
| `incus exec` sessions (attach, `execAsAgentArgv`, apt as root) | Instance keys `environment.HTTP_PROXY`, `environment.HTTPS_PROXY`, `environment.http_proxy`, `environment.https_proxy`, `environment.NO_PROXY` and `environment.no_proxy` (`localhost,127.0.0.1,::1`), `environment.NODE_USE_ENV_PROXY=1` |
| Login shells and `su - aiuser -c` (`execAsAgent`), which reset the environment | The same variables in a root-owned file read by every login (pam_env's `/etc/environment`, or `/etc/profile.d/`; builder's choice, verified by the integration test through `execAsAgent`) |
| apt (root) | `/etc/apt/apt.conf.d/90agent-forge-proxy` (`Acquire::http::Proxy`, `Acquire::https::Proxy`) |
| aiuser's rootless Docker daemon (pulls) | system-wide systemd user drop-in `/etc/systemd/user/docker.service.d/agent-forge-proxy.conf` (root, 644; systemd applies it to the `docker.service` of every user manager) with the variables; the user daemon is restarted when the drop-in changes |
| Containers and builds run by that daemon | **Nothing by default.** They get no proxy, so they reach nothing outside, while traffic between Compose services by name and to Docker networks keeps working. A build or container that needs an allowlisted domain is handed the variables explicitly (`--build-arg HTTPS_PROXY`, `-e HTTPS_PROXY`, or the project's Compose file); `container/CLAUDE.md` tells the agent so |
| Chrome (chrome-devtools-mcp) | Reads the environment variables itself when no desktop environment runs (Chromium's `proxy_config_service_linux`); verified by the integration test. If it fails, forge adds `--proxy-server` to the MCP arguments in strict containers |

- Docker's `proxies` key in `~/.docker/config.json` is deliberately not used:
  it injects the proxy into every container **and** every build, and a narrow
  `NO_PROXY` then sends calls between Compose services (`http://api:8080`) to
  squid, which refuses them. `NO_PROXY` cannot list service names, and CIDRs in
  it are handled unevenly across clients.
- Files written by forge are all owned by root, under `/etc/…`. forge writes
  them as root at every start, after the agent has run, so it never writes (or
  reads) through a path the agent owns, such as its home: a symlink planted
  there would turn the write into one to `/etc/passwd`. An agent that masks
  them (a drop-in of the same name in `~/.config/systemd/user`) only breaks its
  own access: the ACL is what enforces, the variables only make tools use the
  proxy.
- The container is marked `user.forge.egress=strict`. `forge list` does not
  trust this key alone (see "`forge list`").

### Applying the strict settings

One idempotent step, **apply strict settings**, writes everything above from
the current proxy address: the `environment.*` keys, the login-shell file, the
apt file and the Docker drop-in (restarting the user daemon only when the
drop-in changed). It runs on a running container:

- at provisioning with `--strict`, right after `waitReady`;
- at **every** `forge start` and `forge resume` of a strict container, once it
  runs and before attaching — including the first start after
  `forge egress … strict`;
- on every other path to the agent that sub-project 4 introduces (its
  `attachTask`, reached by herdr tabs and by the reattach after a herdr
  restart), which calls the same idempotent hooks.

Running it at every start is what keeps strict containers working after the
proxy's address changes (a new `network.ipv4Address`): `forge setup` moves the
proxy and rewrites `forge-egress-strict`, but never touches agent containers.
Until their next start, strict containers keep the old address and simply reach
nothing (closed). When the proxy address changes and strict containers exist,
`forge setup` says so and names them.

### `container/CLAUDE.md`

A short paragraph for the agent: when `HTTPS_PROXY` points at forge's proxy, the
container is strict; a `403` from the proxy, or a connection that times out,
means the destination is not on the human's allowlist; do not try to work around
it; name the domain to the human and carry on without it. Docker builds and
containers get no proxy by default: hand them `HTTPS_PROXY`/`HTTP_PROXY`
(`--build-arg`, `-e`) when they need an allowlisted domain. The same template
serves open containers, where the paragraph does not apply.

## Commands

### `forge start --strict <owner/repo> [<task>]`

- `--strict` only matters when the container does not exist yet. On an existing
  container it is refused unless the container is already strict, with a pointer
  to `forge egress`.
- Preconditions, before anything is created, in addition to sub-project 2's:
  the version gate passes; ACL `forge-egress-strict` exists; instance
  `forge-proxy` exists with its recipe key. Otherwise the message names
  `forge setup` (or the Incus upgrade).
- The container is **created strict**: `incus launch` gets the eth0 overrides
  (`-d eth0,…`), the `environment.*` keys (`-c …`) and `user.forge.egress=strict`
  in the same call, so it never boots open. "Apply strict settings" runs right
  after `waitReady`, before any provisioning step that uses the network.
- Provisioning steps that need the internet go through the proxy and adapt:
  - **Claude Code refresh**: `apt-get update` restricted to Anthropic's source
    (`-o Dir::Etc::sourcelist=<that file> -o Dir::Etc::sourceparts=-`); still a
    warning on failure, as today.
  - **superpowers plugin**: in strict mode a failure is a warning, not fatal. It
    names the domains to allow (the GitHub group) and the command to run later
    inside the container.
- On an existing container, `forge start` and `forge resume` read
  `user.forge.egress`:
  - **strict**: check the version gate (a downgraded Incus refuses to start
    it), start the proxy if it is stopped, start the container, then "apply
    strict settings" before attaching;
  - **open**: remove any file forge's strict settings wrote, a no-op when
    there is none, before attaching. This completes a switch to open made
    while the container was stopped;
  - **unset** (a container from before strict mode, never switched): nothing;
    only a switch writes or removes forge's files.
  - Before any of these, the marker is checked against the **effective** NIC
    (see "`forge list`"), from the `incus list` entry of the container:
    - a `strict` marker on an open NIC, or a strict NIC under an `open` or
      absent marker, is refused before anything starts, naming both states and
      `forge egress <owner/repo> strict` / `… open`, which finish the switch;
    - a `strict` marker on a `?` NIC (changed by hand) is refused too, pointing
      at `incus config device show <container>`: `forge egress` refuses to
      overwrite such a NIC either way, so it is not suggested;
    - a `strict` marker on a container that `incus list` does not show (a
      failed listing) is refused: its NIC cannot be checked;
    - an open or absent marker on a `?` NIC starts as above (open: files
      removed; unset: nothing).

### `forge egress [<owner/repo>] [strict|open]`

- Without a mode: prints the container's effective egress (see "`forge list`")
  and, when strict, the allowlist file's path and entry count (display only:
  a missing file is reported, `not created yet: run forge setup`, never
  created). A marker that disagrees with the effective NIC, or a switch left
  half-done, is reported with the command that finishes it.
- With a mode: refuses on a running container ("stop it first: forge stop
  <owner/repo>", WIP checks are `forge stop`'s business). On a stopped container
  it changes Incus configuration only, then prints what changed and that the
  in-container files follow at the next `forge start`.
  - **→ strict**: same preconditions as `--strict`. In this order: the eth0
    override with the three keys, the `environment.*` keys,
    `user.forge.egress=strict`.
  - **→ open**: in this order: `user.forge.egress=open`, unset the
    `environment.*` keys, then remove the eth0 override (`incus config device
    remove <c> eth0`, which restores the profile's NIC).
  - The ACL is applied **first** when going strict and removed **last** when
    going open, so an interruption leaves the container stricter, never looser.
  - The files inside the container are handled by `forge start`'s egress step
    (above), which needs no file access to a stopped container.
- A missing repo argument opens the usual repo menu (`resolveRepo`).

### `forge egress log [<owner/repo>]`

- Reads the last 200 lines of the proxy's `access.log`
  (`incus exec forge-proxy -- tail -n 200 …`).
- Prints one line per request: time, container, result (`denied` for squid's
  `TCP_DENIED…`, `error` for `NONE…`, the requests squid could not serve,
  `allowed` otherwise), method, host[:port], with every control character
  stripped (the fields come from the agents' requests). The container name
  comes from the DHCP leases of the bridge (`incus network list-leases`, which
  still name a stopped instance), overridden by the current address of each
  instance (`incus list -f json`); an address nobody holds is shown as is.
- With `<owner/repo>`: only that container's lines.
- Addresses are reused by DHCP over time, so old lines can name the wrong
  container; the command says so in its usage text.

### `forge list`

A new `EGRESS` column: `open`, `strict`, or `?`. It is derived from the
**effective** NIC, not from `user.forge.egress`: `strict` when the expanded
`eth0` has `security.acls=forge-egress-strict` and default egress `reject`;
`open` when it has the profile's `forge-egress`; `?` for anything else (a manual
change). `listInstances` reads `expanded_devices` from the `incus list -f json`
it already runs, so the column costs no extra call.

### `forge setup`

Gains the objects and steps above, plus:

- If the version gate fails, it skips `forge-proxy`, `forge-egress-strict` and
  the proxy's ACL and profile, with a notice naming the Incus version found and
  the versions strict mode needs. The bridge's DHCP range change still applies.
- It creates the default allowlist file when missing (before the proxy, which
  needs it).

### Usage, completion

`forge`'s usage text lists `egress` and the `--strict` flag; `forge completion
bash` completes `egress`, its modes and `log`.

## Error handling

- sub-project 2's rules stand: mutating steps go through `mustSucceed`, probes
  are never fatal by themselves, config errors name the file, the line or key,
  and the expected form.
- **Fail-closed ordering** everywhere a strict container is concerned: the
  restricting change comes first, the relaxing one last, and a failure in
  between leaves the stricter state.
- A stopped or broken proxy is not an error for open containers; for strict
  ones it only means no egress. `forge start`/`resume` of a strict container try
  to start it and warn when it does not come up.

## Restricted-project compatibility (for B)

Not built in v2.0; recorded so B does not need a restructure.

- `forge-proxy` profile keys are a subset of the agent profile's (no nesting, no
  `raw.idmap`): the same restricted-project table applies, with `raw.lxc`
  omitted under the same condition.
- The NIC override keys (`security.acls*`) and `ipv4.address` on a NIC are not
  project-checked.
- ACLs `forge-proxy` and `forge-egress-strict` live in `default`, like
  `forge-egress`: created by the admin (or an admin-run `forge setup`).
- Under B each user's project gets its own proxy slot (an address in the
  reserved block) and its own pair of ACLs named after the project. The slot
  mechanism above is that shape; assigning slots to users is B's design.

## Testing

- **Unit** (`node --test`, fake `incus`):
  - Allowlist: parsing, comments, every refused form with its line number,
    overlaps, empty list; the default file is created when missing and never
    rewritten.
  - Address plan: proxy slot and DHCP range from various bridge addresses and
    prefixes; `/28` and narrower refused by config validation.
  - Desired objects: bridge with `ipv4.dhcp.ranges`, both ACLs, `forge-proxy`
    profile (with and without `raw.lxc`).
  - squid configuration: rule order, `-n` flags, the empty-list variant, subnet
    and address substitution.
  - `forge setup`: empty Incus gives every creation including the proxy steps in
    order; a second run makes **no** mutating call (config files pulled and
    found equal); a changed allowlist gives one push and one reconfigure; a
    changed `PROXY_RECIPE` recreates the instance; a leftover without the recipe
    key is replaced; a failing version gate skips the strict objects with the
    notice; a container holding the proxy address stops setup; a changed proxy
    address with strict containers present names them.
  - Version gate: 7.0.1, 7.1.0 and 7.4.0 refused; 7.0.2, 7.0.3, 7.5.0, 7.5.1 and
    8.0.0 accepted; 6.0.7 and unparsable strings refused.
  - Provisioning `--strict`: the launch argv carries every override and
    environment key (never a launch without them); "apply strict settings"
    runs before the plugin step; plugin failure is a warning; Claude refresh
    restricted to Anthropic's source.
  - "Apply strict settings": idempotent (a second run writes nothing and does
    not restart the Docker user daemon); a new proxy address rewrites every
    file and key. Its open counterpart removes only forge's files.
  - `forge start`/`resume`: on a strict container, gate, proxy start, then
    settings before attach; on an open one, the cleanup no-op.
  - `forge egress`: refused on a running container; strict/open on a stopped
    one, with the fail-closed ordering of calls; `forge list` column from
    expanded devices, including `?`.
  - `forge egress log`: parsing squid lines, address → container mapping,
    filter by repo.
  - The fake `incus` gains what these need: `launch -d/-c`, `config device
    override|remove|set`, `file pull … -`, `expanded_devices` and IPv4
    addresses in `list -f json`, `server_version` in `query /1.0`.
- **Integration** (`FORGE_INTEGRATION=1`, a real Incus that passes the version gate, project
  `forge-selftest`, proxy slot 1 with ACLs suffixed by the project so a real
  agent-forge setup on the same host is untouched; `XDG_CONFIG_HOME` points at a
  throwaway allowlist allowing `example.com` only):
  - `forge setup` twice; the second run reports only `unchanged`.
  - From a strict container, as aiuser, through `incus exec` **and** through
    `su - aiuser -c`:
    - `curl https://example.com` → 200 through the proxy;
    - `curl https://example.org` → 403 from the proxy;
    - `curl --noproxy '*' https://example.com` → fails;
    - `curl` through the proxy to an IP literal → denied;
    - the proxy on another port, the bridge address, another container → fail;
    - `node -e 'fetch(…)'`, `git ls-remote https://example.com/…` (any HTTP
      answer proves the tunnel), Chrome headless dumping `https://example.com`
      with its sandbox;
    - rootless Docker: the daemon's environment holds the proxy; a container it
      runs has no proxy variable and cannot reach `https://example.com`, and
      reaches it when run with `-e HTTPS_PROXY`. A real pull needs Docker Hub on
      the list: behind a second opt-in.
  - The proxy stopped → `https://example.com` fails from the strict container
    (fails closed).
  - DHCP renewal works in a strict container (forced renew, then the address is
    still held).
  - `forge egress … open` then `strict` on a stopped container round-trips,
    with the in-container files following at each `forge start`;
    `forge list` shows the column; `forge egress log` shows the 403 above
    attributed to the container.
  - An open container cannot reach the proxy (it is in a rejected range):
    expected, recorded so nobody "fixes" it.
- **Manual acceptance on a test VM** (needs the user's Claude login, so not in
  the automated suite): a strict container with the default list runs Claude
  Code (a prompt, Remote Control registration, WebFetch to an allowed and to a
  refused domain); `forge egress log` records which Anthropic hosts were used;
  the default list is adjusted to match. Result recorded in the PR.

## Known limits (documented for the user)

| Limit | Why it stays |
|---|---|
| DNS tunneling through the bridge's dnsmasq | Baseline rule, before any ACL (framing). Possible future direction, untested: strict containers need no DNS since squid resolves names, so a bridge or dnsmasq setup that answers no queries from them would close it |
| Exfiltration to an allowed domain (a token supplied by an attacker: `npm publish`, another API key on `api.anthropic.com`, a gist) | The proxy sees the host, not the content. Closing it needs TLS interception (non-goal). The default list therefore holds Anthropic only, and the commented groups say which ones are upload channels |
| Domain fronting (CONNECT to an allowed host, TLS to another tenant of the same CDN) | Same cause |
| A compromised squid gives open egress, minus private ranges | The proxy is the choke point. Mitigations: Ubuntu security updates (`unattended-upgrades`), minimal features, its own `forge-egress` ACL |
| Connections opened before switching to strict | Conntrack keeps them: hence "stopped containers only" |
| Old `forge egress log` lines may name the wrong container | DHCP reuses addresses |

## Calls made while writing this document

The user approved the technical choices above in brainstorming (squid, the
address plan, the strict ACL, the 7.0.2 requirement, the allowlist file and its
default content, the commands, the proxy built by `forge setup`, the known
limits). These points were settled by the author afterwards, from the builder
review, and are the ones to check:

- the version gate's exact rule (7.0.2+ on 7.0, or 7.5.0+; everything else
  refused), from where the fix landed;
- in-container settings rewritten at every start, and `forge egress` touching
  Incus configuration only;
- Docker builds and containers get no proxy by default;
- the `/27` prefix limit, the proxy slots, and the conflict check on the proxy
  address;
- `forge egress log` reading the last 200 lines.

## Changes to earlier specs

Recorded here; the earlier documents are not edited.

- **Runtime spec, forge's configuration:** `network.ipv4Address` prefix `/27` at
  most (was `/30`).
- **Runtime spec, objects:** `forgebr0` gains `ipv4.dhcp.ranges`; new ACLs
  `forge-proxy` and `forge-egress-strict`, profile and instance `forge-proxy`.
- **Runtime spec, host contract:** strict mode only requires Incus 7.0.2+ on the
  7.0 LTS line or 7.5.0+ (the version gate); there is still no gate for the
  rest.
- **Runtime spec, provisioning:** with `--strict`, the superpowers plugin
  install becomes a warning on failure, and the Claude Code refresh reads only
  Anthropic's apt source.
- **Runtime spec, commands:** `egress` added; `start` gains `--strict`; `list`
  gains `EGRESS`.
- **Framing spec, Security model summary:** row "Agent exfiltrates code or the
  Claude token" gains "exfiltration to an allowlisted domain and domain fronting
  remain possible in strict mode (no TLS interception)".

## Repository layout (new and touched)

| Path | Contents |
|---|---|
| `cli/lib/egress.ts` (new) | Allowlist parsing and validation, default file, address plan (slot, DHCP range) |
| `cli/lib/proxy.ts` (new) | squid configuration generation, proxy instance lifecycle |
| `cli/lib/commands/egress.ts` (new) | `forge egress` and `forge egress log` |
| `cli/lib/objects.ts` | New ACLs and profile, bridge DHCP range |
| `cli/lib/commands/setup.ts`, `provision.ts`, `start.ts`, `resume.ts`, `list.ts`, `completion.ts`, `cli/forge.ts` | As described |
| `cli/lib/config.ts` | `/27` limit |
| `cli/lib/incus.ts` | `listInstances` with expanded devices and addresses; server version |
| `container/CLAUDE.md` | The strict-mode paragraph |
| `tests/…` | Unit tests, fake `incus` additions, integration tests |

The README is rewritten by sub-project 5, which receives this sub-project's
user-facing surface through the shared notes.
