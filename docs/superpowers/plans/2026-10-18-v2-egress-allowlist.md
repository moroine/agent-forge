# agent-forge v2 — Sub-project 3: Egress allowlist (strict mode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opt-in strict egress per container: `forge setup` manages a squid container `forge-proxy` and the ACLs `forge-proxy` / `forge-egress-strict`; `forge start --strict` creates a container that only reaches the user's allowlisted domains through the proxy; `forge egress` shows, toggles and audits it; `forge list` shows the effective mode.

**Architecture:** Pure modules compute everything testable without Incus: the address plan (`ipv4.ts`), the allowlist (`allowlist.ts`), the desired ACLs and profile (`objects.ts`), the squid configuration (`proxy.ts`) and the in-container proxy files (`strict.ts`). Thin lifecycle functions on top drive Incus through the existing transport (`incus.ts`) and convergence engine (`converge.ts`), with the same rules as sub-project 2: read, compare, write only on difference; `mustSucceed` for mutations; probes never fatal. Every unit test runs against the stateful fake `incus` (`tests/lib/fake-incus.ts`), which this plan extends first.

**Tech Stack:** Node 24 (type stripping, `node --test`, no runtime dependency), TypeScript 5 (`tsc --noEmit`), Incus ≥ 7.0.2, squid 7 (Ubuntu 26.04 `main`), bash.

**Spec:** `docs/superpowers/specs/2026-10-17-v2-egress-allowlist-design.md` is authoritative. Read it before starting, then the runtime spec `docs/superpowers/specs/2026-10-15-v2-runtime-design.md` for the conventions this code extends.

## Global Constraints

- Names: instance, profile and ACL `forge-proxy`; ACL `forge-egress-strict` (both ACLs in Incus project `default`, like `forge-egress`). The instance and profile live in the forge project (`agent-forge`, or `FORGE_INCUS_PROJECT`).
- Proxy port `3128`. Proxy URL `http://<proxy address>:3128`.
- Address plan: reserved block network + 2 … network + 9; bridge `ipv4.dhcp.ranges` = network + 10 → broadcast − 1; the proxy is the reserved address at index `slot` once the bridge's own address is removed from the block (`10.77.0.2` by default). `network.ipv4Address` prefix `/27` at most.
- Slots: project `agent-forge` → slot 0, ACL names `forge-proxy` / `forge-egress-strict`. Any other project (tests only) → slot `FORGE_PROXY_SLOT` (integer 1–7, default 1), ACL names `forge-proxy-<project>` / `forge-egress-strict-<project>`. `FORGE_PROXY_SLOT` is test-only and undocumented, like `FORGE_INCUS_PROJECT`.
- Strict ACL egress rules, in order: `allow` `enabled` `tcp` destination `<proxy address>` destination_port `3128`; `allow` `enabled` `udp` destination `<bridge address>` destination_port `67`. No ingress rule.
- Proxy ACL: one ingress rule `allow` `enabled` `tcp` source `<bridge subnet>` destination_port `3128`. No egress rule.
- Strict NIC override keys on `eth0`: `security.acls=<strict ACL>`, `security.acls.default.egress.action=reject`, `security.acls.default.ingress.action=reject`.
- Profile `forge-proxy`: `security.privileged=false`, `security.nesting=false`, `security.syscalls.deny_default=true`, `limits.memory=512MiB`, `limits.processes=1000`, `boot.autostart=true`, `raw.lxc` = the agent profile's `RAW_LXC` under the same restricted-project rule; eth0 `nic` on `forgebr0` with `security.acls=forge-egress,<proxy ACL>`, default egress `allow`, default ingress `reject`; root disk on the configured pool, `size: 4GiB`. No `raw.idmap`, no `ipv4.address` in the profile.
- Proxy instance: source `images:ubuntu/26.04`; packages `squid unattended-upgrades`; key `user.forge.proxy_recipe` set last; files `/etc/squid/squid.conf` and `/etc/squid/allowlist` (root, `644`).
- Version gate: `7.0.x` with `x ≥ 2`, or ≥ `7.5.0`; everything else (6.x, 7.0.0–7.0.1, 7.1–7.4, unparsable) refused.
- Allowlist file: `~/.config/agent-forge/egress-allowlist` (`$XDG_CONFIG_HOME` honoured, empty means unset), created with the default content when missing, never rewritten.
- In-container proxy environment, exact keys: `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, `https_proxy` = proxy URL; `NO_PROXY`, `no_proxy` = `localhost,127.0.0.1,::1`; `NODE_USE_ENV_PROXY` = `1`.
- In-container files: `/etc/profile.d/agent-forge-proxy.sh` (root, 644), `/etc/apt/apt.conf.d/90agent-forge-proxy` (root, 644), `/home/aiuser/.config/systemd/user/docker.service.d/agent-forge-proxy.conf` (1001:1001, 644). Nothing in `~/.docker/config.json`.
- Container marker `user.forge.egress` = `strict` | `open` (unset on containers never made strict).
- Fail-closed ordering: the restricting change first, the relaxing one last.
- sub-project 2's rules stand: every mutating step through `mustSucceed`; probes never fatal; values as argv elements, never in a shell string (except `execAsAgent`'s fixed scripts); no runtime npm dependency.
- Comments: new files in English; an existing file keeps its language for new comments (`incus.ts`, `provision.ts`, `start.ts`, `resume.ts`, `list.ts`, `completion.ts`, `cli/forge.ts`, `container/CLAUDE.md` are French; `objects.ts`, `setup.ts`, `host.ts`, `ipv4.ts`, `config.ts`, `converge.ts`, `paths.ts` are English).
- Git: work on `agent/v2-egress`, created from `agent/v2-egress-plan` (itself on `agent/v2-egress-spec`, on `agent/hook-fail-closed`, moroine/agent-forge#36). Conventional messages. Commits are unsigned (`--no-gpg-sign`) only once the user has confirmed it in the executing session; the user re-signs the stack. Push only `agent/*` branches, with a bare `git push -u origin <branch>`. PRs target the previous branch of the stack, titled with `(pile v2 · sp3, N/n)`. Never merge, never touch `main` or `next`.
- Shell quirks on the Mac: the repo's hook (`container/pre-bash.sh`) blocks `sudo`, `gh api`, `2>&1` after `git push` and git push text in heredocs. Write files with the editor tools, not heredocs.

## Review Focus

These follow from the spec, but no test in its "Testing" section exercises them. Each has a test in the task that owns the code.

1. **An allowlist edited on Windows or in a GUI editor**: CRLF line endings, a UTF-8 BOM, tabs and trailing spaces. Expected: read exactly as the LF version. → Task 3, `CRLF, a BOM, tabs and trailing spaces read like plain LF`.
2. **A container whose eth0 was overridden by hand** (`EGRESS` shows `?`). Expected: `forge egress … strict|open` refuses and says why, instead of overwriting a manual change. → Task 10, `a hand-made eth0 override is refused, not overwritten`.
3. **A proxy whose config files are missing or unreadable** (someone deleted them, or `file pull` fails). Expected: counted as "differs", pushed again, outcome `updated` — never a crash, never `unchanged`. → Task 6, `a config file missing in the proxy is pushed again`.
4. **Squid log lines forge cannot parse**: blank lines, a truncated last line, an IPv6 client, a plain-HTTP URL with a path. Expected: unparsable lines skipped, the rest printed. → Task 10, `odd squid lines are skipped, plain HTTP URLs give their host`.
5. **The proxy stopped or deleted while strict containers exist** (host reboot, manual `incus delete`). Expected: `forge setup` restarts or recreates it; `forge start` of a strict container warns (naming `forge setup`) and still starts it, closed. → Task 6, `a stopped proxy is started`, and Task 9, `a strict container starts with a warning when the proxy is gone`.

## Choices this plan makes (not settled by the spec)

The reviewer can veto any of these before execution:

- **Module split.** The spec's layout table puts the allowlist and the address plan in one `egress.ts`. This plan splits them by responsibility: `allowlist.ts` (the file), the address plan in `ipv4.ts` (it is IPv4 arithmetic), and `strict.ts` (in-container settings and the start/resume hooks). `proxy.ts` and `commands/egress.ts` are as in the spec.
- **`FORGE_PROXY_SLOT`.** Two test projects (the integration suite has three) cannot share slot 1. A second test-only variable picks the slot; `agent-forge` always uses slot 0.
- **Open cleanup only after a toggle.** The "open" step at `forge start`/`resume` runs only when `user.forge.egress=open`, i.e. on containers that were strict once. Containers that were never strict (key unset) get no extra call.
- **Login-shell file.** `/etc/profile.d/agent-forge-proxy.sh` (login shells, `su - aiuser -c`) rather than editing `/etc/environment`, which Ubuntu fills with `PATH`.
- **Pushing content.** A new `pushText` helper writes to a temporary file and runs `incus file push … --create-dirs`, as provisioning already pushes files; `pullText` uses `incus file pull <instance><path> -`.
- **Restricted apt update for the Claude refresh.** `-o Dir::Etc::sourcelist=/etc/apt/sources.list.d/claude-code.sources -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0` (the image's deb822 source is named `claude-code`).
- **Integration tests run one file at a time** (`--test-concurrency=1`), and the strict-mode tests get their own file and project (`forge-selftest-egress`, slot 3).
- **`--strict` outside `forge start`** is a usage error.
- **`EGRESS` column position**: right after `MODE`.

## Test Incus (prerequisite for Task 12)

The unit tests need nothing. Task 12 needs a throwaway Incus host that passes the version gate (7.0.2 or later on the 7.0 LTS line), with `agent-base` built once (`forge image build`) in project `agent-forge`, and this checkout on it. The VMs used for v2 tests are shared with other sessions: ask the user (or the session that coordinates the v2 work) which one to use before touching it.

---

### Task 1: The fake `incus` models what strict mode uses

**Files:**
- Modify: `tests/lib/fake-incus.ts`
- Test: `tests/fake-incus.test.ts`

**Interfaces:**
- Produces (used by every later test):
  - `InstanceState` gains `ipv4?: string` (the address `list -f json` reports for eth0).
  - `FakeIncus.serverVersion: string`, default `"7.0.2"`, served as `environment.server_version` by `query /1.0`.
  - `FakeIncus.files: Map<string, { content: string; uid: string; gid: string; mode: string }>`, keyed `"<project>/<instance><path>"`.
  - `FakeIncus.expandedDevices(project: string, name: string): Devices` — profile devices (in profile order) overlaid by the instance's local devices.
  - Supported calls, all requiring `--project`: `launch <image> <name> [--profile P]… [-d dev,key=value]… [-c key=value]…`; `config set <i> k=v [k=v…]` (alongside the existing `set <i> <key> <value>`); `config unset <i> <key>`; `config device override <i> <dev> k=v…`; `config device set <i> <dev> k=v…`; `config device remove <i> <dev>`; `file push <src> <i><path> [--uid U] [--gid G] [--mode M] [--create-dirs]`; `file pull <i><path> -`; `restart <i>`; `list -f json` returning each instance with `name`, `status`, `config`, `devices`, `profiles`, `expanded_devices` and `state.network.eth0.addresses` (`[{ family: "inet", address: ipv4 }]` when `ipv4` is set, else `[]`).

- [ ] **Step 1: Write the failing tests** in `tests/fake-incus.test.ts`

```ts
test("launch applies -d device overrides on top of the profile device, and -c keys", () => {
  const fake = FakeIncus.withRuntime();
  fake.addProfile("agent-forge", "agent-forge", { devices: { eth0: { type: "nic", network: "forgebr0", "security.acls": "forge-egress" } } });
  const r = fake.run(["--project", "agent-forge", "launch", "agent-base", "c1", "--profile", "agent-forge",
    "-d", "eth0,security.acls=forge-egress-strict", "-c", "user.forge.egress=strict"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fake.expandedDevices("agent-forge", "c1").eth0,
    { type: "nic", network: "forgebr0", "security.acls": "forge-egress-strict" });
  assert.equal(fake.instances.get("agent-forge")!.get("c1")!.config["user.forge.egress"], "strict");
});

test("device override copies the profile device; set needs a local device; remove restores the profile's", () => {
  // override on a profile device → local copy with the keys; a second override fails ("already overridden");
  // set on a local device changes it; set on a profile-only device fails; remove drops the local copy.
});

test("config set takes several key=value pairs, unset removes a key", () => { /* … */ });

test("file push stores content, owner and mode; file pull - serves it; a missing file fails", () => {
  // push a temp file to c1/etc/x with --uid 0 --gid 0 --mode 644 → fake.files.get("agent-forge/c1/etc/x")
  // pull c1/etc/x - → stdout is the content; pull c1/etc/missing - → code 1
});

test("list -f json reports expanded devices and the eth0 address", () => { /* ipv4 "10.77.0.57" → addresses[0].address */ });

test("query /1.0 reports serverVersion", () => { /* default "7.0.2"; set "7.0.1" → served */ });

test("restart keeps a running instance running and fails on a missing one", () => { /* … */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/fake-incus.test.ts`
Expected: FAIL (`unsupported launch flag -d`, `expandedDevices is not a function`, …)

- [ ] **Step 3: Implement the additions in `tests/lib/fake-incus.ts`**

Keep the fake's rule: anything it does not model fails with exit code 1. `file push` reads the source file synchronously at push time (`readFileSync`), so the caller may delete its temporary file right after. `exec` stays as it is (tests force exec answers through `fakeContext` rules).

- [ ] **Step 4: Run the whole unit suite**

Run: `npm run test:unit`
Expected: PASS, including the 276 existing tests (the default `serverVersion` change from `7.0.1` to `7.0.2` must not break `host.test.ts`; adjust only an assertion that printed the version).

- [ ] **Step 5: Commit**

```bash
git add tests/lib/fake-incus.ts tests/fake-incus.test.ts
git commit -m "test: le faux incus modélise les surcharges de NIC, file push/pull et la version du serveur"
```

---

### Task 2: Address plan, slots and the `/27` limit

**Files:**
- Modify: `cli/lib/ipv4.ts`, `cli/lib/config.ts`, `cli/lib/objects.ts`
- Test: `tests/ipv4.test.ts`, `tests/config.test.ts`, `tests/objects.test.ts`

**Interfaces:**
- Produces:
  - `ipv4.ts`: `formatAddress(n: number): string`; `type ProxyPlan = { bridgeAddress: string; subnet: string; proxyAddress: string; dhcpRanges: string }`; `dhcpRanges(bridgeCidr: string): string`; `proxyPlan(bridgeCidr: string, slot: number): ProxyPlan` (`subnet` is `"<network>/<prefix>"`, `dhcpRanges` is `"<first>-<last>"`).
  - `objects.ts`: constants `PROXY_INSTANCE = "forge-proxy"`, `PROXY_PROFILE = "forge-proxy"`, `PROXY_PORT = 3128`; `type EgressNames = { slot: number; proxyAcl: string; strictAcl: string }`; `egressNames(project: string): EgressNames`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/ipv4.test.ts
test("the default bridge gives the proxy 10.77.0.2 and DHCP from .10 to .254", () => {
  assert.deepEqual(proxyPlan("10.77.0.1/24", 0), {
    bridgeAddress: "10.77.0.1", subnet: "10.77.0.0/24", proxyAddress: "10.77.0.2", dhcpRanges: "10.77.0.10-10.77.0.254",
  });
});
test("a bridge address inside the reserved block is skipped when picking slots", () => {
  assert.equal(proxyPlan("10.77.0.2/24", 0).proxyAddress, "10.77.0.3");
  assert.equal(proxyPlan("10.77.0.2/24", 1).proxyAddress, "10.77.0.4");
});
test("slot 1 is the next reserved address", () => assert.equal(proxyPlan("10.77.0.1/24", 1).proxyAddress, "10.77.0.3"));
test("a /27 keeps 21 dynamic addresses", () => assert.equal(proxyPlan("192.168.50.1/27", 0).dhcpRanges, "192.168.50.10-192.168.50.30"));
test("a bridge address that is not the first of its subnet still plans from the network", () =>
  assert.equal(proxyPlan("172.20.3.200/16", 0).proxyAddress, "172.20.0.2"));

// tests/config.test.ts
test("a bridge narrower than /27 is refused", () => {
  assert.throws(() => parseConfig("f", { network: { ipv4Address: "10.77.0.1/28" } }), /network\.ipv4Address/);
  assert.doesNotThrow(() => parseConfig("f", { network: { ipv4Address: "10.77.0.1/27" } }));
});

// tests/objects.test.ts
test("agent-forge uses slot 0 and the spec's ACL names", () =>
  assert.deepEqual(egressNames("agent-forge"), { slot: 0, proxyAcl: "forge-proxy", strictAcl: "forge-egress-strict" }));
test("another project gets FORGE_PROXY_SLOT (default 1) and suffixed names", () => {
  assert.deepEqual(egressNames("forge-selftest"),
    { slot: 1, proxyAcl: "forge-proxy-forge-selftest", strictAcl: "forge-egress-strict-forge-selftest" });
  // with FORGE_PROXY_SLOT=3 → slot 3; FORGE_PROXY_SLOT=0 or 8 or "x" → throws an Error naming the variable
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/ipv4.test.ts tests/config.test.ts tests/objects.test.ts`
Expected: FAIL (`proxyPlan is not a function`, the `/28` case accepted)

- [ ] **Step 3: Implement**

- `proxyPlan`: network = `network(cidr)`, broadcast = network + 2^(32 − prefix) − 1; reserved = network + 2 … network + 9 without the bridge address; `proxyAddress = reserved[slot]`; `dhcpRanges(bridgeCidr)` = network + 10 → broadcast − 1. A slot beyond the block throws `Error` (programming error, not a user error).
- `config.ts`: the prefix test becomes `cidr.prefix <= 27`; the expected-form text says "with a prefix of /27 or wider".
- `egressNames`: compares with `DEFAULT_PROJECT` from `incus.ts`.

- [ ] **Step 4: Run the unit suite**

Run: `npm run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/lib/ipv4.ts cli/lib/config.ts cli/lib/objects.ts tests/ipv4.test.ts tests/config.test.ts tests/objects.test.ts
git commit -m "feat: plan d'adresses du proxy (bloc réservé, plage DHCP, slots) et bridge en /27 au plus"
```

---

### Task 3: The allowlist file

**Files:**
- Create: `cli/lib/allowlist.ts`
- Modify: `cli/lib/paths.ts`
- Test: `tests/allowlist.test.ts`, `tests/paths.test.ts`

**Interfaces:**
- Produces:
  - `paths.ts`: `allowlistPath(): string` → `<XDG_CONFIG_HOME or ~/.config>/agent-forge/egress-allowlist`.
  - `allowlist.ts`: `DEFAULT_ALLOWLIST: string`; `parseAllowlist(path: string, text: string): string[]` (entries in file order; throws `ForgeError`); `loadAllowlist(path: string): { entries: string[]; created: boolean }` (writes `DEFAULT_ALLOWLIST` with `mkdirSync(recursive)` when the file is missing, then parses).

- [ ] **Step 1: Write the failing tests**

```ts
test("comments, inline comments and blank lines are ignored", () =>
  assert.deepEqual(parseAllowlist("f", "# head\n\napi.anthropic.com   # why\n.example.com\n"), ["api.anthropic.com", ".example.com"]));
test("CRLF, a BOM, tabs and trailing spaces read like plain LF", () =>
  assert.deepEqual(parseAllowlist("f", "﻿a.example.com\t \r\n\t.b.example.org  # x\r\n"), ["a.example.com", ".b.example.org"]));
for (const [line, why] of [
  ["Example.com", /lowercase/], ["example", /two labels/], ["10.0.0.1", /IP/], ["[::1]", /IP/],
  ["example.com:443", /port/], ["https://example.com", /scheme/], ["example.com/path", /path/],
  ["*.example.com", /\*/], ["example.com.", /trailing dot/], ["-a.example.com", /hyphen/], ["exämple.com", /punycode/],
] as const) {
  test(`"${line}" is refused with its line number`, () =>
    assert.throws(() => parseAllowlist("/x/egress-allowlist", `# c\n${line}\n`), (e: Error) =>
      e instanceof ForgeError && e.message.startsWith("/x/egress-allowlist:2:") && why.test(e.message)));
}
test("duplicates and overlaps are refused", () => {
  assert.throws(() => parseAllowlist("f", "a.com\na.com\n"), /f:2: .*duplicate/);
  assert.throws(() => parseAllowlist("f", "example.com\n.example.com\n"), /f:2: .*overlaps .*line 1/);
  assert.throws(() => parseAllowlist("f", ".example.com\na.example.com\n"), /f:2: .*overlaps/);
});
test("an empty list is valid", () => assert.deepEqual(parseAllowlist("f", "# nothing\n\n"), []));
test("the default list holds Anthropic's four domains, active, and the rest commented", () =>
  assert.deepEqual(parseAllowlist("f", DEFAULT_ALLOWLIST), ["api.anthropic.com", "platform.claude.com", "claude.ai", "downloads.claude.ai"]));
test("a missing file is created with the default list; an existing one, even empty, is never rewritten", () => {
  // tmp dir: loadAllowlist(p) → { created: true, entries: 4 }, file content === DEFAULT_ALLOWLIST;
  // writeFileSync(p, "") → loadAllowlist(p) → { created: false, entries: [] }, content still ""
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/allowlist.test.ts tests/paths.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `cli/lib/allowlist.ts`**

`DEFAULT_ALLOWLIST` is exactly this text (the spec's "Default content"):

```
# agent-forge egress allowlist: the only domains strict containers reach,
# through forge-proxy. One entry per line; "#" starts a comment.
#   example.com    that host only
#   .example.com   the domain and all its subdomains
# Lowercase letters, digits and hyphens; internationalized names in punycode
# (xn--...). No IP address, port, scheme, path or "*".
# The list applies to every strict container. Changes take effect at the next
# `forge setup`. An empty list is valid: strict containers then reach nothing.

# Anthropic: Claude Code needs these.
api.anthropic.com      # API, Remote Control, feature flags, WebFetch's domain check
platform.claude.com    # OAuth token exchange and refresh
claude.ai              # account authentication
downloads.claude.ai    # Claude Code's apt repository (refresh at provisioning)

# GitHub: the superpowers plugin needs it. Anyone can publish there (repos,
# gists, releases): a hijacked agent can fetch from all of it, and push to it
# with a token it is handed.
#github.com
#codeload.github.com
#objects.githubusercontent.com
#raw.githubusercontent.com

# npm. With a token, `npm publish` is an exfiltration channel.
#registry.npmjs.org

# PyPI. Same remark for uploads.
#pypi.org
#files.pythonhosted.org

# Docker Hub. Same remark for pushes.
#registry-1.docker.io
#auth.docker.io
#production.cloudflare.docker.com

# Claude Code telemetry and error reports. Optional: Claude Code works without them.
#http-intake.logs.us5.datadoghq.com
#browser-intake-us5-datadoghq.com
```

Each error message is `<path>:<line>: <what is wrong> (<expected form>)`. Overlap: entry A covers B when A is `.d` and B is `d` or ends with `.d`; the message names the earlier line.

- [ ] **Step 4: Run the unit suite**

Run: `npm run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/lib/allowlist.ts cli/lib/paths.ts tests/allowlist.test.ts tests/paths.test.ts
git commit -m "feat: fichier de liste blanche de sortie, validation stricte et liste par défaut"
```

---

### Task 4: The desired ACLs, the proxy profile and the bridge's DHCP range

**Files:**
- Modify: `cli/lib/objects.ts`
- Test: `tests/objects.test.ts`

**Interfaces:**
- Consumes: `ProxyPlan`, `proxyPlan`, `dhcpRanges` (Task 2); `EgressNames` (Task 2).
- Produces: `desiredBridge(cfg)` now includes `"ipv4.dhcp.ranges": dhcpRanges(cfg.network.ipv4Address)`; `desiredProxyAcl(plan: ProxyPlan): DesiredAcl`; `desiredStrictAcl(plan: ProxyPlan): DesiredAcl`; `desiredProxyProfile(cfg: ForgeConfig, names: EgressNames, opts: { rawLxc: boolean }): DesiredProfile`.

- [ ] **Step 1: Write the failing tests**

```ts
const plan = proxyPlan("10.77.0.1/24", 0);
test("the bridge keeps the reserved block out of DHCP", () =>
  assert.equal(desiredBridge(DEFAULT_CONFIG).config["ipv4.dhcp.ranges"], "10.77.0.10-10.77.0.254"));
test("the proxy ACL lets the bridge subnet in on TCP 3128 only", () =>
  assert.deepEqual([desiredProxyAcl(plan).ingress, desiredProxyAcl(plan).egress], [[
    { action: "allow", state: "enabled", protocol: "tcp", source: "10.77.0.0/24", destination_port: "3128" }], []]));
test("the strict ACL allows the proxy and DHCP renewals, nothing else", () =>
  assert.deepEqual([desiredStrictAcl(plan).egress, desiredStrictAcl(plan).ingress], [[
    { action: "allow", state: "enabled", protocol: "tcp", destination: "10.77.0.2", destination_port: "3128" },
    { action: "allow", state: "enabled", protocol: "udp", destination: "10.77.0.1", destination_port: "67" }], []]));
test("no ACL rule names another ACL", () => { /* every source/destination of both ACLs parses as an address or CIDR */ });
test("the proxy profile: small, unnested, both ACLs on eth0, no idmap, no address", () => {
  const p = desiredProxyProfile(DEFAULT_CONFIG, egressNames("agent-forge"), { rawLxc: true });
  assert.equal(p.config["security.nesting"], "false");
  assert.equal(p.config["limits.memory"], "512MiB");
  assert.equal(p.config["limits.processes"], "1000");
  assert.equal(p.config["boot.autostart"], "true");
  assert.equal(p.config["raw.lxc"], RAW_LXC);
  assert.equal(p.config["raw.idmap"], undefined);
  assert.equal(p.devices.eth0["security.acls"], "forge-egress,forge-proxy");
  assert.equal(p.devices.eth0["ipv4.address"], undefined);
  assert.deepEqual(p.devices.root, { type: "disk", path: "/", pool: "default", size: "4GiB" });
});
test("in a restricted project the proxy profile goes without raw.lxc", () => { /* rawLxc: false → no key */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/objects.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement in `cli/lib/objects.ts`**

Descriptions follow the existing pattern (`"agent-forge: … (managed by forge setup)"`).

- [ ] **Step 4: Run the unit suite**

Run: `npm run test:unit`
Expected: `tests/setup.test.ts` fails on the bridge's expected config (the new `ipv4.dhcp.ranges` key): update that one assertion (`a changed bridge address gives exactly one edit, of the whole bridge`) to include `"ipv4.dhcp.ranges": "10.78.0.10-10.78.0.254"`. Then PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/lib/objects.ts tests/objects.test.ts tests/setup.test.ts
git commit -m "feat: ACL forge-proxy et forge-egress-strict, profil forge-proxy, plage DHCP du bridge"
```

---

### Task 5: Transport additions and the version gate

**Files:**
- Modify: `cli/lib/incus.ts`, `cli/lib/host.ts`
- Test: `tests/incus.test.ts`, `tests/host.test.ts`

**Interfaces:**
- Produces:
  - `incus.ts`:
    - `Instance` becomes `{ name: string; status: string; config: Record<string, string>; expandedDevices: Record<string, Record<string, string>>; ipv4: string[] }` (`listInstances` fills them from `config`, `expanded_devices`, `state.network.eth0.addresses[family=inet]`; missing fields give `{}` / `[]`).
    - `ServerInfo` gains `environment.server_version?: string`.
    - `pushText(ctx: Context, instance: string, dest: string, content: string, owner: { uid: number; gid: number; mode: string }): Promise<ExecResult>` — temp file, `incus file push <tmp> <instance><dest> --uid U --gid G --mode M --create-dirs`, temp dir removed in `finally`.
    - `pullText(ctx: Context, instance: string, path: string): Promise<string | null>` — probe; `null` on a non-zero exit.
    - `configSetMany(ctx, instance: string, pairs: Record<string, string>): Promise<ExecResult>` (one `config set <i> k=v …` call); `configUnset(ctx, instance: string, key: string): Promise<ExecResult>`.
    - `deviceOverride(ctx, instance: string, device: string, pairs: Record<string, string>)`, `deviceSet(…same)`, `deviceRemove(ctx, instance: string, device: string)`: `Promise<ExecResult>`.
    - `restartInstance(ctx, name: string): Promise<ExecResult>`.
    - `execArgv(ctx, name: string, argv: string[], env: Record<string, string> = {}): Promise<ExecResult>` → `incus exec <name> [--env K=V]… -- …argv` (root).
  - `host.ts`: `strictModeSupported(version: string): boolean`; `requireStrictIncus(ctx: Context): Promise<string>` (returns the version; throws `ForgeError`).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/host.test.ts
for (const v of ["7.0.2", "7.0.3", "7.0.10", "7.5.0", "7.5.1", "7.6", "8.0.0"]) test(`${v} allows strict mode`, () => assert.ok(strictModeSupported(v)));
for (const v of ["7.0.1", "7.0.0", "7.1.0", "7.4.0", "6.0.7", "6.0.5-8", "", "garbage", "7"]) test(`${JSON.stringify(v)} refuses strict mode`, () => assert.ok(!strictModeSupported(v)));
test("the refusal names the version found and the fix", async () => {
  const fake = new FakeIncus(); fake.serverVersion = "7.0.1";
  await assert.rejects(requireStrictIncus(fakeContext({ incus: fake })), (e: Error) =>
    /7\.0\.1/.test(e.message) && /7\.0\.2/.test(e.message) && /7\.5\.0/.test(e.message) && /ansible\/site\.yml/.test(e.message));
});

// tests/incus.test.ts
test("listInstances reads config, expanded devices and the IPv4 address", async () => { /* via FakeIncus with ipv4 */ });
test("pushText pushes the content with its owner and mode, then removes its temp file", async () => {
  // fake.files.get("agent-forge/c1/etc/x") → { content: "hi\n", uid: "0", gid: "0", mode: "644" }; argv has --create-dirs
});
test("pullText returns null when the file is missing", async () => { /* … */ });
test("configSetMany sends every pair in one call", async () => { /* one call: config set c1 a=1 b=2 */ });
```

Existing tests that `deepEqual` the result of `listInstances` get the new fields.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/host.test.ts tests/incus.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

`strictModeSupported`: match `^(\d+)\.(\d+)(?:\.(\d+))?$` on the whole string (no suffix); major > 7 → true; major 7 and minor ≥ 5 → true; major 7, minor 0 and patch ≥ 2 → true; anything else false. The refusal message:
`strict mode needs Incus 7.0.2 or later on the 7.0 LTS line, or 7.5.0 or later (this host runs <v>): earlier releases can leave a NIC unfiltered when a filter update fails. On an agent-forge VM, re-run the host playbook (ansible/site.yml); in local Linux mode, install Incus from Zabbly (lts-7.0 or the feature channel).`

- [ ] **Step 4: Run the unit suite**

Run: `npm run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/lib/incus.ts cli/lib/host.ts tests/incus.test.ts tests/host.test.ts
git commit -m "feat: transport incus (file push/pull, surcharges de device) et garde de version du mode strict"
```

---

### Task 6: The squid configuration and the proxy's lifecycle

**Files:**
- Create: `cli/lib/proxy.ts`
- Test: `tests/proxy.test.ts`

**Interfaces:**
- Consumes: `ProxyPlan` (Task 2); `PROXY_INSTANCE`, `PROXY_PROFILE` (Task 2); `pushText`, `pullText`, `execArgv`, `restartInstance`, `deviceSet`, `listInstances`, `configSet`, `deleteInstance`, `startInstance`, `incus`, `waitReady` (Task 5 and existing); `Outcome` (`converge.ts`).
- Produces:
  - `PROXY_RECIPE = 1`; `PROXY_SOURCE_IMAGE = "images:ubuntu/26.04"`; `SQUID_CONF = "/etc/squid/squid.conf"`; `SQUID_ALLOWLIST = "/etc/squid/allowlist"`; `SQUID_ACCESS_LOG = "/var/log/squid/access.log"`.
  - `squidConfig(plan: ProxyPlan, opts: { hasEntries: boolean }): string`; `allowlistText(entries: string[]): string` (one per line, final newline; `""` when empty).
  - `convergeProxy(ctx: Context, args: { plan: ProxyPlan; entries: string[] }, opts?: { aptAttempts?: number; aptDelayMs?: number }): Promise<{ outcome: Outcome; previousAddress: string | null }>` — `previousAddress` is the address the proxy held before this run when it changed, else `null`.

- [ ] **Step 1: Write the failing tests**

```ts
const plan = proxyPlan("10.77.0.1/24", 0);
const conf = squidConfig(plan, { hasEntries: true });
const access = conf.split("\n").filter((l) => l.startsWith("http_access"));
test("squid listens on the proxy address only, with ICP, HTCP and the cache off", () => {
  for (const line of ["http_port 10.77.0.2:3128", "icp_port 0", "htcp_port 0", "cache deny all", "via off", "forwarded_for delete",
    "acl agents src 10.77.0.0/24", "access_log daemon:/var/log/squid/access.log squid"]) assert.ok(conf.split("\n").includes(line), line);
});
test("http_access denies bad ports, non-443 CONNECT, IP literals and private destinations before the allowlist", () => {
  assert.equal(access.length, 6);
  assert.match(access[0], /deny !Safe_ports/); assert.match(access[1], /deny CONNECT !SSL_ports/);
  assert.match(access[2], /deny iplit/); assert.match(access[3], /deny privdst/);
  assert.equal(access[4], "http_access allow agents allowed"); assert.equal(access[5], "http_access deny all");
  assert.ok(conf.includes('acl allowed dstdomain -n "/etc/squid/allowlist"'));
  assert.match(conf, /^acl iplit dstdom_regex -n /m);
  // privdst lists 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 127.0.0.0/8 0.0.0.0/8 224.0.0.0/4 ::1 fc00::/7 fe80::/10
});
test("an empty allowlist drops the allow rule and the allowlist ACL", () => {
  const empty = squidConfig(plan, { hasEntries: false });
  assert.ok(!empty.includes("allow agents")); assert.ok(!empty.includes("dstdomain"));
});

// lifecycle, against FakeIncus with profile forge-proxy present
test("a missing proxy is launched with its address, configured, then stamped last", async () => {
  // calls in order: launch images:ubuntu/26.04 forge-proxy --profile forge-proxy -d eth0,ipv4.address=10.77.0.2;
  // exec systemctl is-system-running --wait; exec apt-get update; exec apt-get install -y squid unattended-upgrades;
  // file push …/etc/apt/apt.conf.d/20auto-upgrades; file push squid.conf and allowlist; exec squid -k parse;
  // exec systemctl enable squid; exec systemctl restart squid; config set forge-proxy user.forge.proxy_recipe 1 (last)
  // outcome "created"
});
test("apt-get update is retried while the network comes up", async () => { /* rule fails twice then the fake answers: 3 calls, created */ });
test("a second run pulls both files, finds them equal, and makes no mutating call", async () => { /* outcome unchanged; no push, no exec besides pulls */ });
test("a changed allowlist pushes both files, parses, then reconfigures", async () => { /* outcome updated; squid -k parse before squid -k reconfigure */ });
test("a config file missing in the proxy is pushed again", async () => { /* delete fake.files entry → updated */ });
test("a failed squid -k parse stops with squid's message and does not reconfigure", async () => { /* rule on "squid -k parse" code 1 stderr "FATAL: bad" → rejects /FATAL: bad/; no reconfigure call */ });
test("a leftover without the recipe key is deleted and recreated", async () => { /* delete --force then launch; outcome created */ });
test("an older recipe is replaced", async () => { /* user.forge.proxy_recipe=0 → recreated; outcome updated */ });
test("a moved bridge moves the proxy and restarts it", async () => {
  // instance eth0 ipv4.address 10.77.0.2, plan for 10.78.0.1/24 → config device set forge-proxy eth0 ipv4.address=10.78.0.2; restart; previousAddress "10.77.0.2"
});
test("a stopped proxy is started", async () => { /* status Stopped → start forge-proxy; outcome updated */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/proxy.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `cli/lib/proxy.ts`**

- `squidConfig`: also `acl SSL_ports port 443`, `acl Safe_ports port 80 443`, and the IP-literal ACL `acl iplit dstdom_regex -n ^[0-9.]+$ ^\[?[0-9a-fA-F]*:[0-9a-fA-F:.]*\]?$` (an IPv6 literal must contain a colon, so a hex-looking host name is not caught).
- Apt runs as `execArgv(ctx, PROXY_INSTANCE, ["apt-get", …], { DEBIAN_FRONTEND: "noninteractive" })`; `update` retried `aptAttempts` times (default 10) with `aptDelayMs` (default 6000) between tries, the last failure through `mustSucceed`.
- `20auto-upgrades` content: `APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n`.
- Creation leaves an incomplete instance in place on failure; the error message says the next `forge setup` replaces it.
- The comparison is byte for byte between `pullText` and the generated text; `null` counts as different.

- [ ] **Step 4: Run the unit suite**

Run: `npm run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/lib/proxy.ts tests/proxy.test.ts
git commit -m "feat: configuration squid et cycle de vie du container forge-proxy"
```

---

### Task 7: `forge setup` converges the strict-mode objects

**Files:**
- Modify: `cli/lib/commands/setup.ts`
- Test: `tests/setup.test.ts`

**Interfaces:**
- Consumes: Tasks 2–6 (`egressNames`, `proxyPlan`, `desiredProxyAcl`, `desiredStrictAcl`, `desiredProxyProfile`, `loadAllowlist`, `allowlistPath`, `strictModeSupported`, `serverInfo`, `convergeProxy`, `listInstances`).
- Produces: `SetupOptions` gains `aptAttempts?: number` and `aptDelayMs?: number`, passed to `convergeProxy` (tests use `aptDelayMs: 0`). Report lines, in this order after the existing four: `network acl <proxyAcl>: …`, `network acl <strictAcl>: …`, `profile forge-proxy: …`, `allowlist: created (default list)` | `allowlist: <n> entries` | `allowlist: empty (strict containers reach nothing)`, `instance forge-proxy: …`. The `allowlist:` line is printed even when the file was just created: then `allowlist: created (default list, 4 entries)`.

- [ ] **Step 1: Write the failing tests** (replace the "four creations" tests)

```ts
test("an empty Incus gives every creation, in order", async () => {
  // out_lines deepEqual: project agent-forge: created / network forgebr0: created / network acl forge-egress: created /
  // profile agent-forge: created / network acl forge-proxy: created / network acl forge-egress-strict: created /
  // profile forge-proxy: created / allowlist: created (default list, 4 entries) / instance forge-proxy: created
});
test("a second run reports only unchanged and makes no mutating call", async () => {
  // writes() (create/edit/launch/file push/config set/exec other than pulls and probes) unchanged; every line ends with ": unchanged" or is "allowlist: 4 entries"
});
test("the proxy is created after IPv4 forwarding is checked", async () => { /* ip_forward 0 → rejects, no launch call */ });
test("an Incus below the version gate skips the strict objects with a notice, and still sets the DHCP range", async () => {
  // fake.serverVersion = "7.0.1" → no acl forge-proxy / forge-egress-strict / profile forge-proxy / instance; err has /NOTICE: .*7\.0\.1.*strict mode/;
  // forgebr0 has ipv4.dhcp.ranges
});
test("a container holding the proxy address stops setup before the proxy, naming it", async () => {
  // addInstance("agent-forge", "agent-o-r", { ipv4: "10.77.0.2" }) → rejects /agent-o-r .*10\.77\.0\.2.*restart/; no launch of forge-proxy
});
test("an edited allowlist gives one push and one reconfigure", async () => { /* instance forge-proxy: updated */ });
test("an empty allowlist is applied and said", async () => { /* write "" → "allowlist: empty (strict containers reach nothing)" */ });
test("an invalid allowlist stops setup with the file and line, before touching the proxy", async () => { /* … */ });
test("a moved proxy names the strict containers that pick it up at their next start", async () => {
  // first setup; strict container (expanded eth0 with forge-egress-strict) present; new bridge address → err names it and "forge start"
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/setup.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement in `cli/lib/commands/setup.ts`**

Order: host checks, config, pool; project, bridge (with its existing warning), `forge-egress`, `agent-forge` profile; IPv4 forwarding; then, if `strictModeSupported(serverVersion)`: both ACLs, the `forge-proxy` profile, the allowlist, the address-conflict check (`listInstances`: any instance other than `forge-proxy` whose `ipv4` holds `plan.proxyAddress`), `convergeProxy`, and the moved-proxy notice; else the notice. Then the existing host-address warnings. The rest of the file (and the herdr block that sub-project 4 appends at the very end) is untouched.

- [ ] **Step 4: Run the unit suite**

Run: `npm run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/lib/commands/setup.ts tests/setup.test.ts
git commit -m "feat: forge setup crée le proxy, ses ACL et la liste blanche"
```

---

### Task 8: In-container strict settings and the start/resume hooks

**Files:**
- Create: `cli/lib/strict.ts`
- Test: `tests/strict.test.ts`

**Interfaces:**
- Consumes: `ProxyPlan`, `proxyPlan`, `egressNames`, `PROXY_INSTANCE`, `PROXY_PORT` (Task 2); `ACL` (`objects.ts`); `requireStrictIncus` (Task 5); `pushText`, `pullText`, `configSetMany`, `execArgv`, `listInstances`, `listObjects`, `configGet`, `startInstance`, `execAsAgent` (Task 5 and existing); `loadConfig`, `configPath`, `forgeProject`.
- Produces:
  - `type EgressMode = "open" | "strict"`.
  - `PROXY_FILES = { profile: "/etc/profile.d/agent-forge-proxy.sh", apt: "/etc/apt/apt.conf.d/90agent-forge-proxy", docker: "/home/aiuser/.config/systemd/user/docker.service.d/agent-forge-proxy.conf" } as const`.
  - `ENV_KEYS: readonly string[]` = the seven `environment.*` keys of the Global Constraints, in that order.
  - `proxyEnv(plan: ProxyPlan): Record<string, string>` (variable name → value, the seven variables).
  - `profileScript(env)`, `aptConf(plan)`, `dockerDropIn(env)`: `string`.
  - `currentPlan(): ProxyPlan` (from the config's bridge and the project's slot).
  - `strictLaunchArgs(plan: ProxyPlan, names: EgressNames): string[]` — the three `-d eth0,…` overrides, then `-c environment.<VAR>=<value>` for each variable, then `-c user.forge.egress=strict`.
  - `requireStrictRuntime(ctx: Context): Promise<ProxyPlan>` — version gate; the strict ACL exists (`listObjects(ctx, "network acl")`); `forge-proxy` exists with `user.forge.proxy_recipe`; otherwise `ForgeError` naming `forge setup`.
  - `applyStrictSettings(ctx: Context, container: string, plan: ProxyPlan): Promise<void>`.
  - `clearStrictSettings(ctx: Context, container: string): Promise<void>`.
  - `effectiveEgress(devices: Record<string, Record<string, string>>, names: EgressNames): EgressMode | "?"`.
  - `egressMode(ctx: Context, container: string): Promise<EgressMode | null>` — read-only: `user.forge.egress` as a mode, `null` when unset or anything else.
  - `egressBeforeStart(ctx: Context, container: string): Promise<EgressMode | null>` (uses `egressMode`) and `egressAfterStart(ctx: Context, container: string, mode: EgressMode | null): Promise<void>`.
  - **Contract with sub-project 4 (herdr):** both hooks stay exported, idempotent and safe to call twice on a running container. Sub-project 4's stack replaces the attach paths (`attachTask` in `cli/lib/session.ts`, reached by `forge attach`, herdr tabs and `forge resume --all` after a herdr restart, none of which go through `start`/`resume`). Whichever stack lands second also calls `egressBeforeStart` in sub-project 4's `ensureRunning` (before its `incus start`, and on an already running container too) and `egressAfterStart(ctx, container, await egressMode(ctx, container))` at the top of `attachTask`, so every path to the agent applies the strict settings.

- [ ] **Step 1: Write the failing tests**

```ts
const plan = proxyPlan("10.77.0.1/24", 0);
test("the proxy environment, both letter cases, Node's switch and the loopback exceptions", () =>
  assert.deepEqual(proxyEnv(plan), {
    HTTP_PROXY: "http://10.77.0.2:3128", HTTPS_PROXY: "http://10.77.0.2:3128", http_proxy: "http://10.77.0.2:3128",
    https_proxy: "http://10.77.0.2:3128", NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1", NODE_USE_ENV_PROXY: "1" }));
test("the launch arguments override eth0 three times, then set the environment and the marker", () => {
  const a = strictLaunchArgs(plan, egressNames("agent-forge"));
  assert.deepEqual(a.slice(0, 6), ["-d", "eth0,security.acls=forge-egress-strict", "-d", "eth0,security.acls.default.egress.action=reject",
    "-d", "eth0,security.acls.default.ingress.action=reject"]);
  assert.deepEqual(a.slice(-2), ["-c", "user.forge.egress=strict"]);
  assert.ok(a.includes("environment.HTTPS_PROXY=http://10.77.0.2:3128"));
});
test("the file contents", () => {
  assert.match(profileScript(proxyEnv(plan)), /^export HTTPS_PROXY='http:\/\/10\.77\.0\.2:3128'$/m);
  assert.equal(aptConf(plan), 'Acquire::http::Proxy "http://10.77.0.2:3128";\nAcquire::https::Proxy "http://10.77.0.2:3128";\n');
  assert.match(dockerDropIn(proxyEnv(plan)), /^\[Service\]\nEnvironment="HTTPS_PROXY=http:\/\/10\.77\.0\.2:3128"$/m);
  // nothing anywhere mentions .docker/config.json
});
test("effectiveEgress reads the expanded NIC, not a label", () => {
  const n = egressNames("agent-forge");
  assert.equal(effectiveEgress({ eth0: { "security.acls": "forge-egress-strict", "security.acls.default.egress.action": "reject" } }, n), "strict");
  assert.equal(effectiveEgress({ eth0: { "security.acls": "forge-egress" } }, n), "open");
  assert.equal(effectiveEgress({ eth0: { "security.acls": "forge-egress-strict", "security.acls.default.egress.action": "allow" } }, n), "?");
  assert.equal(effectiveEgress({}, n), "?");
});
test("applyStrictSettings writes the keys and the three files, then restarts the Docker user daemon", async () => {
  // fake.files has the three paths with uids 0/0/1001 and mode 644; config set c with the 7 keys in one call;
  // an execAsAgent call "systemctl --user daemon-reload && systemctl --user restart docker"
});
test("a second applyStrictSettings writes nothing and does not restart Docker", async () => { /* no push, no config set, no restart */ });
test("a new proxy address rewrites every file and key", async () => { /* … */ });
test("clearStrictSettings removes only forge's files and restarts Docker only when its drop-in was there", async () => {
  // exec rm -f with the three paths exactly; with a rule "test -e …agent-forge-proxy.conf" code 1 → no restart
});
test("requireStrictRuntime names forge setup when the ACL or the proxy is missing", async () => { /* … */ });
test("before start: a strict container checks the gate and starts a stopped proxy; an unset one does nothing", async () => { /* … */ });
test("before start: a missing proxy is a warning naming forge setup, not an error", async () => { /* err /forge setup/; returns "strict" */ });
test("after start: strict applies the settings, open clears them, unset does nothing", async () => { /* … */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/strict.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `cli/lib/strict.ts`**

- `applyStrictSettings`: reads the instance's current `config` (`listInstances`) and calls `configSetMany` only with the differing keys (skipped when none); for each file, `pullText` then `pushText` only on difference (root `0:0` for the two `/etc` files, `1001:1001` for the drop-in); restarts the Docker user daemon with `execAsAgent(ctx, container, "systemctl --user daemon-reload && systemctl --user restart docker")` only when the drop-in was written, and turns a failure there into a `WARNING:` line (the ACL already enforces).
- `clearStrictSettings`: probe `test -e <docker drop-in>` (`execArgv`), then `execArgv(ctx, c, ["rm", "-f", …the three paths])` through `mustSucceed`, then the daemon restart only when the probe found the drop-in.
- `egressBeforeStart`: `configGet(…, "user.forge.egress")`; for `strict`, `requireStrictIncus` (throws), then the proxy (`listInstances`): missing → `WARNING: forge-proxy is missing: <c> starts without any egress. Run 'forge setup'.`; stopped → `startInstance`, a failure becoming a warning. Returns the mode, `null` when unset or another value.
- `egressAfterStart`: `strict` → `applyStrictSettings(ctx, c, currentPlan())`; `open` → `clearStrictSettings`; `null` → nothing.

- [ ] **Step 4: Run the unit suite**

Run: `npm run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/lib/strict.ts tests/strict.test.ts
git commit -m "feat: réglages proxy dans les containers stricts et crochets de démarrage"
```

---

### Task 9: `forge start --strict`, strict provisioning, and start/resume hooks

**Files:**
- Modify: `cli/lib/commands/provision.ts`, `cli/lib/commands/start.ts`, `cli/lib/commands/resume.ts`, `cli/forge.ts`, `container/CLAUDE.md`
- Test: `tests/provision.test.ts`, `tests/start.test.ts`, `tests/resume-finish.test.ts`, `tests/e2e.test.ts`, `tests/test-claude-template.sh`

**Interfaces:**
- Consumes: Task 8 (`requireStrictRuntime`, `strictLaunchArgs`, `applyStrictSettings`, `egressBeforeStart`, `egressAfterStart`, `egressNames`), `forgeProject`.
- Produces: `provisionContainer(ctx, container, ownerRepo, opts: { strict?: boolean } = {})`; `cmdStart(ctx, repo?, task?, opts: { strict?: boolean } = {})`; `cli/forge.ts` accepts `--strict` (boolean) for `start` only.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/provision.test.ts (fixture: FakeIncus.withRuntime + strict objects: ACL forge-egress-strict, instance forge-proxy with user.forge.proxy_recipe=1)
test("--strict launches with every override in the same call; there is no launch without them", async () => {
  // exactly one launch call; it equals incus --project agent-forge launch agent-base agent-x --profile agent-forge ...strictLaunchArgs(plan)
});
test("--strict applies the settings right after waitReady, before the plugin install", async () => {
  // index(file push …agent-forge-proxy.sh) > index(waitReady) and < index("claude plugin marketplace add")
});
test("--strict refuses before creating anything when the gate, the ACL or the proxy is missing", async () => { /* no launch; message names forge setup */ });
test("--strict: a failed plugin install is a warning naming the GitHub group", async () => { /* rule on "claude plugin" code 1 → resolves; err /WARNING: .*github\.com/ */ });
test("--strict: the Claude refresh reads only Anthropic's apt source", async () => {
  // apt-get update -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/claude-code.sources -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0
});
test("without --strict, provisioning is unchanged", async () => { /* launch argv has no -d; plugin failure still fatal */ });

// tests/start.test.ts
test("start --strict on a new repo provisions it strict", async () => { /* … */ });
test("start --strict on an existing open container is refused, pointing at forge egress", async () => { /* … */ });
test("start of a strict container checks the gate before starting it", async () => { /* serverVersion 7.0.1 → rejects; no incus start */ });
test("start applies the strict settings after starting and before attaching", async () => { /* index(push) < index(attach) */ });
test("a strict container starts with a warning when the proxy is gone", async () => { /* no forge-proxy → err /forge setup/; attach happens */ });
test("start of a container switched to open clears forge's files before attaching", async () => { /* rm -f … before attach */ });
// tests/resume-finish.test.ts: the same three hooks for resume (gate before start, settings before attach, open cleanup)
// tests/e2e.test.ts: "--strict is refused outside forge start" (forge stop --strict o/r → exit 1, usage)
```

`tests/test-claude-template.sh` gains: `assert_contains 'HTTPS_PROXY'` and `assert_contains 'forge-proxy'`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/provision.test.ts tests/start.test.ts tests/resume-finish.test.ts tests/e2e.test.ts && bash tests/test-claude-template.sh`
Expected: FAIL

- [ ] **Step 3: Implement**

- `provision.ts`: with `strict`, `requireStrictRuntime` joins the preconditions (before `launch`); the launch argv appends `strictLaunchArgs(plan, egressNames(forgeProject()))`; `applyStrictSettings` right after `waitReady`; the plugin step's failure becomes the warning `WARNING: installing the superpowers plugin failed (strict mode: <stderr>). Allow the GitHub group in <allowlist path>, run forge setup, then inside the container: claude plugin install superpowers@claude-plugins-official`; `refreshClaude` takes the strict flag for the restricted update.
- `start.ts` / `resume.ts`: `egressBeforeStart` before `startInstance` (also when the container already runs: then only the gate and the proxy), `egressAfterStart` right before `ctx.attach`. A new container provisioned strict goes through the same two calls (idempotent: no second write).
- `cli/forge.ts`: `strict: { type: "boolean" }` in `parseArgs`; `dispatch` passes it to `cmdStart`; any other command with `--strict` throws the usage error. `USAGE` lists `start [--strict] [<owner/repo>] [<task>]`.
- `container/CLAUDE.md`, a new paragraph in the existing French style, after the Chrome DevTools paragraph:

```
- **Mode strict** : si `HTTPS_PROXY` pointe vers forge-proxy (`http://…:3128`), ce container est en mode strict : tu ne joins que les domaines de la liste blanche de l'humain, via ce proxy. Un `403` du proxy, ou une connexion qui expire, veut dire que la destination n'y est pas : ne cherche pas à contourner, nomme le domaine à l'humain et continue sans. Les builds et containers Docker ne reçoivent pas le proxy d'office : passe-leur `HTTPS_PROXY`/`HTTP_PROXY` (`--build-arg`, `-e`) quand ils ont besoin d'un domaine autorisé. Sans `HTTPS_PROXY`, ce paragraphe ne s'applique pas.
```

- [ ] **Step 4: Run every unit and bash test**

Run: `npm run test:unit && npm run test:bash`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/lib/commands/provision.ts cli/lib/commands/start.ts cli/lib/commands/resume.ts cli/forge.ts container/CLAUDE.md tests/provision.test.ts tests/start.test.ts tests/resume-finish.test.ts tests/e2e.test.ts tests/test-claude-template.sh
git commit -m "feat: forge start --strict, provisioning strict et réglages appliqués à chaque démarrage"
```

---

### Task 10: `forge egress`, `forge egress log`, the `EGRESS` column and completion

**Files:**
- Create: `cli/lib/commands/egress.ts`
- Modify: `cli/forge.ts`, `cli/lib/commands/list.ts`, `cli/lib/commands/completion.ts`
- Test: `tests/egress.test.ts`, `tests/list.test.ts`, `tests/completion.test.ts`

**Interfaces:**
- Consumes: Task 8 (`effectiveEgress`, `requireStrictRuntime`, `ENV_KEYS`, `proxyEnv`), Task 5 (`deviceOverride`, `deviceSet`, `deviceRemove`, `configSetMany`, `configUnset`, `execArgv`, `listInstances`), Task 3 (`loadAllowlist`, `allowlistPath`), `resolveRepo`, `requireContainerForRepo`, `table.ts`.
- Produces: `cmdEgress(ctx: Context, a?: string, b?: string): Promise<number>`; `type LogEntry = { time: string; client: string; result: "allowed" | "denied"; method: string; host: string }`; `parseSquidLine(line: string): LogEntry | null`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/egress.test.ts
test("without a mode it prints the effective egress, and for strict the allowlist", async () => {
  // out: "o/r: strict" then "allowlist: <path> (4 entries)"; open → only "o/r: open"
});
test("a running container is refused: stop it first", async () => { /* /forge stop o\/r/; no config call */ });
test("→ strict on a stopped open container: override first, then environment, then the marker", async () => {
  // calls in order: config device override c eth0 security.acls=forge-egress-strict …egress.action=reject …ingress.action=reject;
  // config set c environment.HTTP_PROXY=… (7 keys); config set c user.forge.egress=strict; out mentions "next forge start"
});
test("→ strict checks the gate, the ACL and the proxy first", async () => { /* serverVersion 7.0.1 → rejects, no override */ });
test("→ open: the marker, then the environment, then the override last", async () => {
  // config set c user.forge.egress=open; 7 × config unset; config device remove c eth0 (last)
});
test("a hand-made eth0 override is refused, not overwritten", async () => { /* effective "?" → rejects /eth0/ for both modes, no write */ });
test("asking for the current mode changes nothing", async () => { /* "already strict" */ });
test("an unknown mode is a usage error", async () => { /* forge egress o/r loose */ });
test("squid lines parse into time, client, result, method and host", () => {
  assert.deepEqual(parseSquidLine("1760745600.123     45 10.77.0.57 TCP_TUNNEL/200 3901 CONNECT api.anthropic.com:443 - HIER_DIRECT/160.79.104.10 -"),
    { time: "2025-10-18T00:00:00Z", client: "10.77.0.57", result: "allowed", method: "CONNECT", host: "api.anthropic.com:443" });
  assert.equal(parseSquidLine("1760745600.123 0 10.77.0.57 TCP_DENIED/403 3870 CONNECT example.org:443 - HIER_NONE/- text/html")!.result, "denied");
});
test("odd squid lines are skipped, plain HTTP URLs give their host", () => {
  assert.equal(parseSquidLine(""), null); assert.equal(parseSquidLine("1760745600.123 0 10.77"), null);
  assert.equal(parseSquidLine("1760745600.1 3 fd00::5 TCP_MISS/200 10 GET http://example.com/a/b - HIER_DIRECT/x text/html")!.host, "example.com");
});
test("log maps addresses to container names and filters by repo", async () => {
  // tail rule returns two lines (10.77.0.57 = agent-o-r, 10.77.0.99 = nobody) → TIME CONTAINER RESULT METHOD HOST table;
  // unknown address printed as is; with o/r only its line
});
test("log without a proxy names forge setup", async () => { /* … */ });

// tests/list.test.ts: header ^REPO\s+MODE\s+EGRESS\s+STATE\s+BUILD$; a row with expanded_devices strict → "strict"; none → "?"
// tests/completion.test.ts: the script lists egress; egress <TAB> offers repos and "log"; egress <repo> <TAB> offers "strict open"
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/egress.test.ts tests/list.test.ts tests/completion.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

- `cmdEgress`: `a === "log"` → the log (`b` optional repo); otherwise `a` is the repo (`resolveRepo` when missing) and `b` the mode (`undefined`, `strict`, `open`; anything else is `Usage: forge egress [<owner/repo>] [strict|open] | forge egress log [<owner/repo>]`). → strict uses `deviceOverride` when the instance has no local `eth0`, `deviceSet` otherwise.
- `parseSquidLine`: fields split on runs of spaces; needs ≥ 7 fields, a numeric time, `action/code`; `denied` when the action starts with `TCP_DENIED` or the code is `403`; time as `new Date(seconds * 1000).toISOString()` without milliseconds; host from `CONNECT`'s `host:port`, or the URL's `host` for other methods.
- `forge egress log`: `execArgv(ctx, PROXY_INSTANCE, ["tail", "-n", "200", SQUID_ACCESS_LOG])` through `mustSucceed` (prefixed: `forge-proxy is not reachable; run 'forge setup'`); the usage text adds `Old lines may name the wrong container: addresses are reused.`
- `list.ts`: `EGRESS` after `MODE`, from `effectiveEgress(instance.expandedDevices, egressNames(forgeProject()))`.
- `cli/forge.ts`: `case "egress": return cmdEgress(ctx, a, b);`; `USAGE` gains `egress [<owner/repo>] [strict|open]   Show or switch a stopped container's egress` and `egress log [<owner/repo>]           Show the proxy's recent requests`.

- [ ] **Step 4: Run every unit test and the type check**

Run: `npm run test:unit && npm run check`
Expected: PASS; `tsc` reports nothing (in a worktree without `node_modules`, run `npm install` first or use the main checkout's `node_modules/.bin/tsc --noEmit -p .`).

- [ ] **Step 5: Commit**

```bash
git add cli/lib/commands/egress.ts cli/forge.ts cli/lib/commands/list.ts cli/lib/commands/completion.ts tests/egress.test.ts tests/list.test.ts tests/completion.test.ts
git commit -m "feat: forge egress (état, bascule, journal) et colonne EGRESS dans forge list"
```

---

### Task 11: Integration tests against a real Incus

**Files:**
- Create: `tests/integration/lib.ts`, `tests/integration/egress.test.ts`
- Modify: `tests/integration/incus.test.ts`, `package.json`

**Interfaces:**
- Produces: `tests/integration/lib.ts` exports the helpers now private to `incus.test.ts` (`run`, `incus`, `forge`, `raw`, `must`, `teardownProject`, `launch`, `waitReady`, `copyImage`, `asAgent`, `ENABLED`, `PREFIX`, `SENTINEL`), with `forge(project, args, env = {})` passing extra variables. `teardownProject` also deletes `forge-proxy` (instance and profile) in the test project, and the two ACLs named after that project in `default`.

- [ ] **Step 1: Adjust the existing suite**

- `package.json`: `"test:integration": "node --test --test-concurrency=1 tests/integration/*.test.ts"`.
- `incus.test.ts`: helpers imported from `lib.ts`; the second-setup assertion expects every line `: unchanged` or `allowlist: <n> entries` (no fixed count); `XDG_CONFIG_HOME` points at a throwaway directory so the user's allowlist is never touched; the restricted project runs with `FORGE_PROXY_SLOT=2`.

- [ ] **Step 2: Write `tests/integration/egress.test.ts`**

Project `forge-selftest-egress`, `FORGE_PROXY_SLOT=3`, a throwaway `XDG_CONFIG_HOME` whose `agent-forge/egress-allowlist` is `example.com\n`; `agent-base` copied from `agent-forge` (as `incus.test.ts` does).

The strict container `s1` is not created with `forge start --strict`, which would clone from GitHub on the host. Instead:
1. A `node -e` one-liner, with the test's `FORGE_INCUS_PROJECT`, `FORGE_PROXY_SLOT` and `XDG_CONFIG_HOME`, imports `cli/lib/strict.ts` and prints `strictLaunchArgs(currentPlan(), egressNames(project))` as JSON.
2. `incus launch agent-base s1 --profile agent-forge -c user.forge.repo=<SENTINEL>` plus those arguments, then `waitReady`.
3. A second one-liner runs `egressAfterStart(createContext(), "s1", "strict")`.

Tests (each probe as aiuser, through `incus exec --user 1001 --group 1001 --env HOME=/home/aiuser` **and** through `su - aiuser -c`):

```ts
test("setup creates the proxy, then reports unchanged", …);
test("an allowed domain answers through the proxy", …);           // curl -sS -m 20 -o /dev/null -w %{http_code} https://example.com → 200
test("a domain off the list gets the proxy's 403", …);           // https://example.org → 403 (curl's %{http_code} of the CONNECT: use -w '%{http_connect}')
test("going around the proxy reaches nothing", …);                // curl --noproxy '*' https://example.com → non-zero
test("an IP literal is denied by the proxy", …);                  // curl https://<example.com's IPv4> → 403 / failure
test("the proxy's other ports, the bridge and a second container are unreachable", …);  // timeout 5 bash -c '</dev/tcp/…'
test("Node, git and Chrome go through the proxy", …);             // node -e fetch; git ls-remote https://example.com (any HTTP status in stderr); Chrome --dump-dom https://example.com with its sandbox
test("Docker's daemon has the proxy; its containers do not, unless given it", …);  // systemctl --user show docker -p Environment; docker run --rm curlimages/curl… only behind FORGE_INTEGRATION_DOCKER=1 (needs Docker Hub on the list)
test("with the proxy stopped, nothing answers (fails closed)", …);
test("a forced DHCP renewal keeps the address", …);               // networkctl renew eth0 (or dhclient) then the same IPv4
test("forge egress open, then strict, on a stopped container round-trips", …);  // with FORGE_INCUS_PROJECT: EGRESS column, files after forge start
test("forge egress log shows the 403, attributed to the container", …);
test("an open container cannot reach the proxy (by design)", …);
```

- [ ] **Step 3: Run on the test Incus**

On the test VM (see "Test Incus"), from this checkout:
Run: `FORGE_INTEGRATION=1 npm run test:integration`
Expected: PASS for both files. Record any Incus fact the spec relied on that did not hold, and fix the code (not the test) unless the spec was wrong — then stop and report to the user.

- [ ] **Step 4: Commit**

```bash
git add package.json tests/integration/lib.ts tests/integration/incus.test.ts tests/integration/egress.test.ts
git commit -m "test: tests d'intégration du mode strict contre un vrai Incus"
```

---

### Task 12: Manual acceptance, final verification and pull requests

**Files:**
- Modify (only if the acceptance shows it): `cli/lib/allowlist.ts` (`DEFAULT_ALLOWLIST`)

- [ ] **Step 1: Manual acceptance on the test VM** (needs the user's Claude login; ask the user to be available)

On a strict container created with `forge start --strict` and the default list: a prompt answers; Remote Control registers; WebFetch on `https://example.com` is refused (not on the list) and on an allowed domain works after adding it and re-running `forge setup`. Then `forge egress log` lists the Anthropic hosts actually used. If `claude.ai` (or any other default entry) never appears and Claude Code works without it, remove it from `DEFAULT_ALLOWLIST` and its test; if a needed host is missing, add it with its reason. Write the observed host list in the PR body.

- [ ] **Step 2: Full verification**

Run: `npm test && npm run check`
Expected: PASS, no type error. `grep -rn "moroine\|/home/moroine" cli container` returns nothing.

- [ ] **Step 3: Commit any acceptance change**

```bash
git add cli/lib/allowlist.ts tests/allowlist.test.ts
git commit -m "fix: liste par défaut ajustée aux hôtes Anthropic observés"
```

- [ ] **Step 4: Push and open the PRs** (one per branch of the stack, each based on the previous)

```bash
git push -u origin agent/v2-egress
```

`gh pr create --base agent/v2-egress-plan --title "feat: mode strict, liste blanche de sortie (pile v2 · sp3, 3/n)"`, with a body that says the commits are unsigned (authorized by the user, to be re-signed), lists the integration and acceptance results, and links the spec. The spec and plan PRs are `(pile v2 · sp3, 1/n)` on `agent/hook-fail-closed` and `(pile v2 · sp3, 2/n)` on `agent/v2-egress-spec`.
