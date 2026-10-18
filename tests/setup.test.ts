import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, type NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";
import { fakeContext } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { fakeProc } from "./lib/fake-host.ts";
import { cmdSetup, type SetupOptions } from "../cli/lib/commands/setup.ts";

let xdg: string;
let savedForgeHome: string | undefined;
// "herdr --version" fails: setup never discovers a real herdr.
const NO_HERDR = { match: "herdr --version", code: 127 };
beforeEach(() => {
  xdg = mkdtempSync(join(tmpdir(), "forge-xdg-"));
  process.env.XDG_CONFIG_HOME = xdg;
  process.env.HERDR_CONFIG_PATH = join(xdg, "herdr.toml");
  // A real ~/.local/bin/herdr (Linux hosts) must never be found, nor the
  // herdr of a session the tests were started from.
  savedForgeHome = process.env.FORGE_HOME;
  process.env.FORGE_HOME = join(xdg, "home");
  delete process.env.HERDR_BIN_PATH;
});
afterEach(() => {
  rmSync(xdg, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.HERDR_CONFIG_PATH;
  if (savedForgeHome === undefined) delete process.env.FORGE_HOME; else process.env.FORGE_HOME = savedForgeHome;
});

function writeConfig(config: unknown) {
  mkdirSync(join(xdg, "agent-forge"), { recursive: true });
  writeFileSync(join(xdg, "agent-forge", "config.json"), JSON.stringify(config));
}

const opts = (over: Partial<SetupOptions> = {}): SetupOptions =>
  ({ proc: fakeProc(), ids: { uid: 501, gid: 20 }, interfaces: () => ({}), aptDelayMs: 0, waitDelayMs: 0, ...over });
// Every mutating call: object create/edit, instance lifecycle, file push, config changes, and every exec
// except the readiness and squid probes. `file pull`, `list` and `query` are probes.
const MUTATING = ["create", "edit", "launch", "delete", "start", "restart", "push"];
const PROBES = ["systemctl is-system-running --wait", "systemctl is-active --quiet squid"];
const writes = (fake: FakeIncus) => fake.calls.filter((c) => {
  const a = c.argv;
  if (a.includes("exec")) return !PROBES.some((p) => a.join(" ").includes(p));
  if (a.includes("config")) return a.includes("set") || a.includes("unset") || a.includes("device");
  return MUTATING.some((m) => a.includes(m));
});
const objectWrites = (fake: FakeIncus) => fake.calls.filter((c) => c.argv.includes("create") || c.argv.includes("edit"));
const profile = (fake: FakeIncus) => fake.profiles.get("agent-forge")!.get("agent-forge")!;
const allowlistFile = () => join(xdg, "agent-forge", "egress-allowlist");

test("an empty Incus gives every creation, then the herdr config, in order", async () => {
  const fake = new FakeIncus();
  const c = fakeContext({ incus: fake, rules: [NO_HERDR] });
  assert.equal(await cmdSetup(c, opts()), 0);
  assert.deepEqual(c.out_lines, [
    "project agent-forge: created",
    "network forgebr0: created",
    "network acl forge-egress: created",
    "profile agent-forge: created",
    "network acl forge-proxy: created",
    "network acl forge-egress-strict: created",
    "profile forge-proxy: created",
    "allowlist: created (default list, 3 entries)",
    "instance forge-proxy: created",
    `herdr config ${join(xdg, "herdr.toml")}: created`,
  ]);
  assert.equal(profile(fake).config["raw.idmap"], "uid 501 1001\ngid 20 1001");
  assert.ok(profile(fake).config["raw.lxc"]);
  assert.equal(fake.networks.get("forgebr0")!.config["ipv4.address"], "10.77.0.1/24");
  assert.equal(fake.expandedDevices("agent-forge", "forge-proxy").eth0["ipv4.address"], "10.77.0.2");
});

test("a second run reports only unchanged and makes no mutating call", async () => {
  const fake = new FakeIncus();
  await cmdSetup(fakeContext({ incus: fake, rules: [NO_HERDR] }), opts());
  const before = writes(fake).length;
  const c = fakeContext({ incus: fake, rules: [NO_HERDR] });
  await cmdSetup(c, opts());
  assert.equal(writes(fake).length, before, writes(fake).slice(before).map((w) => w.argv.join(" ")).join("\n"));
  assert.ok(c.out_lines.every((l) => l.endsWith(": unchanged") || l === "allowlist: 3 entries"), c.out_lines.join("\n"));
});

test("every object goes to Incus as JSON on stdin", async () => {
  const fake = new FakeIncus();
  await cmdSetup(fakeContext({ incus: fake, rules: [NO_HERDR] }), opts());
  assert.equal(objectWrites(fake).length, 7);
  for (const w of objectWrites(fake)) assert.doesNotThrow(() => JSON.parse(w.input ?? ""), w.argv.join(" "));
});

test("the proxy is created after IPv4 forwarding is checked", async () => {
  const fake = new FakeIncus();
  await assert.rejects(() => cmdSetup(fakeContext({ incus: fake, rules: [NO_HERDR] }), opts({ proc: fakeProc({ ipForward: "0" }) })), /ip_forward is 0/);
  assert.ok(!fake.calls.some((c) => c.argv.includes("launch")));
});

test("an Incus below the version gate skips the strict objects with a notice, and still sets the DHCP range", async () => {
  const fake = new FakeIncus();
  fake.serverVersion = "7.0.1";
  const c = fakeContext({ incus: fake, rules: [NO_HERDR] });
  assert.equal(await cmdSetup(c, opts()), 0);
  assert.equal(c.out_lines.length, 5, c.out_lines.join("\n"));
  assert.ok(c.err_lines.some((l) => /NOTICE: .*7\.0\.1.*strict mode/.test(l)), c.err_lines.join("\n"));
  assert.equal(fake.acls.has("forge-proxy"), false);
  assert.equal(fake.acls.has("forge-egress-strict"), false);
  assert.equal(fake.profiles.get("agent-forge")!.has("forge-proxy"), false);
  assert.equal(fake.instances.get("agent-forge")!.has("forge-proxy"), false);
  assert.ok(fake.networks.get("forgebr0")!.config["ipv4.dhcp.ranges"]);
});

test("the test override creates the strict objects on a 7.0.1 Incus, with a WARNING", async () => {
  process.env.FORGE_TEST_ALLOW_INCUS_BELOW_GATE = "1";
  process.env.FORGE_INCUS_PROJECT = "forge-selftest";
  try {
    const fake = new FakeIncus();
    fake.serverVersion = "7.0.1";
    const c = fakeContext({ incus: fake, rules: [NO_HERDR] });
    assert.equal(await cmdSetup(c, opts()), 0, c.err_lines.join("\n"));
    assert.ok(c.err_lines.some((l) => l.startsWith("WARNING: FORGE_TEST_ALLOW_INCUS_BELOW_GATE") &&
      l.includes("Incus 7.0.1") && l.includes("forge-selftest")), c.err_lines.join("\n"));
    assert.ok(!c.err_lines.some((l) => /NOTICE: .*too old/.test(l)), c.err_lines.join("\n"));
    assert.ok(fake.acls.has("forge-proxy-forge-selftest"), [...fake.acls.keys()].join(","));
  } finally {
    delete process.env.FORGE_TEST_ALLOW_INCUS_BELOW_GATE;
    delete process.env.FORGE_INCUS_PROJECT;
  }
});

// Seen on Incus 7.5.1 (integration suite, 2026-10-18): a second forge-proxy on
// the bridge, in a test project, failed with "Instance DNS name already used".
test("a test project's proxy gets its own name, next to the real one on the same bridge", async () => {
  const fake = new FakeIncus();
  assert.equal(await cmdSetup(fakeContext({ incus: fake, rules: [NO_HERDR] }), opts()), 0);
  assert.ok(fake.instances.get("agent-forge")!.has("forge-proxy"));
  process.env.FORGE_INCUS_PROJECT = "forge-selftest";
  try {
    const c = fakeContext({ incus: fake, rules: [NO_HERDR] });
    assert.equal(await cmdSetup(c, opts()), 0, c.err_lines.join("\n"));
    assert.ok(c.out_lines.includes("instance forge-proxy-forge-selftest: created"), c.out_lines.join("\n"));
    assert.ok(fake.instances.get("forge-selftest")!.has("forge-proxy-forge-selftest"));
    assert.equal(fake.instances.get("forge-selftest")!.has("forge-proxy"), false);
  } finally {
    delete process.env.FORGE_INCUS_PROJECT;
  }
});

test("the override set for the default project still gives the notice and no strict objects", async () => {
  process.env.FORGE_TEST_ALLOW_INCUS_BELOW_GATE = "1";
  try {
    const fake = new FakeIncus();
    fake.serverVersion = "7.0.1";
    const c = fakeContext({ incus: fake, rules: [NO_HERDR] });
    assert.equal(await cmdSetup(c, opts()), 0);
    assert.ok(c.err_lines.some((l) => /NOTICE: .*7\.0\.1.*strict mode/.test(l)), c.err_lines.join("\n"));
    assert.equal(fake.acls.has("forge-proxy"), false);
    assert.equal(fake.instances.get("agent-forge")!.has("forge-proxy"), false);
  } finally {
    delete process.env.FORGE_TEST_ALLOW_INCUS_BELOW_GATE;
  }
});

test("a container holding the proxy address stops setup before the proxy, naming it", async () => {
  const fake = new FakeIncus();
  await cmdSetup(fakeContext({ incus: fake, rules: [NO_HERDR] }), opts());
  fake.instances.get("agent-forge")!.delete("forge-proxy");
  fake.addInstance("agent-forge", "agent-o-r", { ipv4: "10.77.0.2" });
  const n = fake.calls.length;
  await assert.rejects(() => cmdSetup(fakeContext({ incus: fake, rules: [NO_HERDR] }), opts()), /agent-o-r .*10\.77\.0\.2.*restart/);
  assert.ok(!fake.calls.slice(n).some((c) => c.argv.includes("launch")));
});

test("an edited allowlist gives one push and one reconfigure", async () => {
  const fake = new FakeIncus();
  await cmdSetup(fakeContext({ incus: fake, rules: [NO_HERDR] }), opts());
  writeFileSync(allowlistFile(), "api.anthropic.com\n.github.com\n");
  const n = fake.calls.length;
  const c = fakeContext({ incus: fake, rules: [NO_HERDR] });
  await cmdSetup(c, opts());
  const calls = fake.calls.slice(n).map((x) => x.argv.join(" "));
  assert.ok(c.out_lines.includes("allowlist: 2 entries"), c.out_lines.join("\n"));
  assert.ok(c.out_lines.includes("instance forge-proxy: updated"));
  assert.equal(calls.filter((x) => x.includes("/etc/squid/allowlist") && x.includes(" push ")).length, 1);
  assert.equal(calls.filter((x) => x.includes("squid -k reconfigure")).length, 1);
});

test("an empty allowlist is applied and said", async () => {
  const fake = new FakeIncus();
  await cmdSetup(fakeContext({ incus: fake, rules: [NO_HERDR] }), opts());
  writeFileSync(allowlistFile(), "");
  const c = fakeContext({ incus: fake, rules: [NO_HERDR] });
  await cmdSetup(c, opts());
  assert.ok(c.out_lines.includes("allowlist: empty (strict containers reach nothing)"), c.out_lines.join("\n"));
  assert.ok(c.out_lines.includes("instance forge-proxy: updated"));
});

test("an invalid allowlist stops setup with the file and line, before touching the proxy", async () => {
  const fake = new FakeIncus();
  mkdirSync(join(xdg, "agent-forge"), { recursive: true });
  writeFileSync(allowlistFile(), "api.anthropic.com\nExample.COM\n");
  await assert.rejects(() => cmdSetup(fakeContext({ incus: fake, rules: [NO_HERDR] }), opts()), /egress-allowlist.*:2/);
  assert.ok(!fake.calls.some((c) => c.argv.includes("launch")));
  assert.equal(fake.instances.get("agent-forge")!.has("forge-proxy"), false);
});

test("a moved proxy names the strict containers that pick it up at their next start", async () => {
  const fake = new FakeIncus();
  await cmdSetup(fakeContext({ incus: fake, rules: [NO_HERDR] }), opts());
  fake.addInstance("agent-forge", "agent-o-s", {
    profiles: ["agent-forge"],
    devices: { eth0: { type: "nic", "security.acls": "forge-egress-strict", "security.acls.default.egress.action": "reject" } },
  });
  writeConfig({ network: { ipv4Address: "10.78.0.1/24" } });
  const c = fakeContext({ incus: fake, rules: [NO_HERDR] });
  await cmdSetup(c, opts());
  const notice = c.err_lines.find((l) => l.startsWith("NOTICE") && l.includes("forge-proxy moved"));
  assert.ok(notice?.includes("agent-o-s") && notice.includes("forge start"), c.err_lines.join("\n"));
});

test("a changed bridge address gives exactly one edit, of the whole bridge", async () => {
  const fake = new FakeIncus();
  await cmdSetup(fakeContext({ incus: fake, rules: [NO_HERDR] }), opts());
  writeConfig({ network: { ipv4Address: "10.78.0.1/24" } });
  const n = objectWrites(fake).length;
  const c = fakeContext({ incus: fake, rules: [NO_HERDR] });
  await cmdSetup(c, opts());
  const w = objectWrites(fake).slice(n).filter((x) => x.argv.includes("forgebr0"));
  assert.equal(w.length, 1);
  assert.deepEqual(w[0].argv.slice(-3), ["network", "edit", "forgebr0"]);
  assert.deepEqual(JSON.parse(w[0].input!).config, {
    "ipv4.address": "10.78.0.1/24", "ipv4.nat": "true", "ipv6.address": "none", "ipv4.dhcp.ranges": "10.78.0.10-10.78.0.254",
  });
  assert.ok(c.out_lines.includes("network forgebr0: updated"));
});

test("an address change warns about the containers running on the bridge", async () => {
  const fake = new FakeIncus();
  await cmdSetup(fakeContext({ incus: fake, rules: [NO_HERDR] }), opts());
  fake.addInstance("agent-forge", "agent-o-r", { status: "Running" });
  fake.addInstance("agent-forge", "agent-o-s", { status: "Stopped" });
  writeConfig({ network: { ipv4Address: "10.78.0.1/24" } });
  const c = fakeContext({ incus: fake, rules: [NO_HERDR] });
  await cmdSetup(c, opts());
  const warning = c.err_lines.find((l) => l.startsWith("WARNING") && l.includes("forgebr0"));
  assert.ok(warning?.includes("agent-o-r"), c.err_lines.join("\n"));
  assert.ok(!warning?.includes("agent-o-s"));
});

test("a changed limit gives exactly one edit, of the whole profile", async () => {
  const fake = new FakeIncus();
  await cmdSetup(fakeContext({ incus: fake, rules: [NO_HERDR] }), opts());
  writeConfig({ limits: { memory: "12GiB" } });
  const n = objectWrites(fake).length;
  await cmdSetup(fakeContext({ incus: fake, rules: [NO_HERDR] }), opts());
  const w = objectWrites(fake).slice(n);
  assert.equal(w.length, 1);
  assert.deepEqual(w[0].argv.slice(-3), ["profile", "edit", "agent-forge"]);
  const body = JSON.parse(w[0].input!);
  assert.equal(body.config["limits.memory"], "12GiB");
  assert.equal(body.devices.eth0.network, "forgebr0");
});

test("a manual change to the profile is reverted, and said so", async () => {
  const fake = new FakeIncus();
  await cmdSetup(fakeContext({ incus: fake, rules: [NO_HERDR] }), opts());
  profile(fake).config["security.privileged"] = "true";
  const c = fakeContext({ incus: fake, rules: [NO_HERDR] });
  await cmdSetup(c, opts());
  assert.ok(c.out_lines.includes("profile agent-forge: updated"));
  assert.equal(profile(fake).config["security.privileged"], "false");
});

test("a restricted project without lowlevel gets a profile without raw.lxc, and a notice", async () => {
  const fake = new FakeIncus();
  fake.addProject("agent-forge", { restricted: "true" });
  const c = fakeContext({ incus: fake, rules: [NO_HERDR] });
  await cmdSetup(c, opts());
  assert.equal(profile(fake).config["raw.lxc"], undefined);
  assert.ok(c.err_lines.some((l) => l.startsWith("NOTICE") && l.includes("raw.lxc")), c.err_lines.join("\n"));
});

test("a failed host check creates nothing", async () => {
  const fake = new FakeIncus();
  await assert.rejects(() => cmdSetup(fakeContext({ incus: fake, rules: [NO_HERDR] }), opts({ proc: fakeProc({ restrictUserns: "1" }) })),
    /apparmor_restrict_unprivileged_userns/);
  assert.deepEqual(writes(fake), []);
});

test("an invalid config creates nothing", async () => {
  writeConfig({ limits: { memroy: "1GiB" } });
  const fake = new FakeIncus();
  await assert.rejects(() => cmdSetup(fakeContext({ incus: fake, rules: [NO_HERDR] }), opts()), /unknown key limits\.memroy/);
  assert.deepEqual(writes(fake), []);
});

test("IPv4 forwarding is checked once the bridge exists", async () => {
  const fake = new FakeIncus();
  await assert.rejects(() => cmdSetup(fakeContext({ incus: fake, rules: [NO_HERDR] }), opts({ proc: fakeProc({ ipForward: "0" }) })), /ip_forward is 0/);
  assert.ok(fake.networks.has("forgebr0"));
});

test("a host address outside the rejected ranges is warned about", async () => {
  const eth0 = [{ address: "203.0.113.7", netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "203.0.113.7/24" } as NetworkInterfaceInfo];
  const c = fakeContext({ incus: new FakeIncus(), rules: [NO_HERDR] });
  await cmdSetup(c, opts({ interfaces: () => ({ eth0 }) }));
  assert.ok(c.err_lines.some((l) => l.startsWith("WARNING") && l.includes("203.0.113.7")), c.err_lines.join("\n"));
});
