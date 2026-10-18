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
  // A real ~/.local/bin/herdr (Linux hosts) must never be found.
  savedForgeHome = process.env.FORGE_HOME;
  process.env.FORGE_HOME = join(xdg, "home");
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
  ({ proc: fakeProc(), ids: { uid: 501, gid: 20 }, interfaces: () => ({}), ...over });
const writes = (fake: FakeIncus) => fake.calls.filter((c) => c.argv.includes("create") || c.argv.includes("edit"));
const profile = (fake: FakeIncus) => fake.profiles.get("agent-forge")!.get("agent-forge")!;

test("an empty Incus gives four creations, then the herdr config, in order", async () => {
  const fake = new FakeIncus();
  const c = fakeContext({ incus: fake, rules: [NO_HERDR] });
  assert.equal(await cmdSetup(c, opts()), 0);
  assert.deepEqual(c.out_lines, [
    "project agent-forge: created",
    "network forgebr0: created",
    "network acl forge-egress: created",
    "profile agent-forge: created",
    `herdr config ${join(xdg, "herdr.toml")}: created`,
  ]);
  assert.equal(profile(fake).config["raw.idmap"], "uid 501 1001\ngid 20 1001");
  assert.ok(profile(fake).config["raw.lxc"]);
  assert.equal(fake.networks.get("forgebr0")!.config["ipv4.address"], "10.77.0.1/24");
});

test("a second run makes no mutating call", async () => {
  const fake = new FakeIncus();
  await cmdSetup(fakeContext({ incus: fake, rules: [NO_HERDR] }), opts());
  const before = writes(fake).length;
  const c = fakeContext({ incus: fake, rules: [NO_HERDR] });
  await cmdSetup(c, opts());
  assert.equal(writes(fake).length, before);
  assert.ok(c.out_lines.every((l) => l.endsWith(": unchanged")), c.out_lines.join("\n"));
});

test("every object goes to Incus as JSON on stdin", async () => {
  const fake = new FakeIncus();
  await cmdSetup(fakeContext({ incus: fake, rules: [NO_HERDR] }), opts());
  assert.equal(writes(fake).length, 4);
  for (const w of writes(fake)) assert.doesNotThrow(() => JSON.parse(w.input ?? ""), w.argv.join(" "));
});

test("a changed bridge address gives exactly one edit, of the whole bridge", async () => {
  const fake = new FakeIncus();
  await cmdSetup(fakeContext({ incus: fake, rules: [NO_HERDR] }), opts());
  writeConfig({ network: { ipv4Address: "10.78.0.1/24" } });
  const n = writes(fake).length;
  const c = fakeContext({ incus: fake, rules: [NO_HERDR] });
  await cmdSetup(c, opts());
  const w = writes(fake).slice(n);
  assert.equal(w.length, 1);
  assert.deepEqual(w[0].argv.slice(-3), ["network", "edit", "forgebr0"]);
  assert.deepEqual(JSON.parse(w[0].input!).config, { "ipv4.address": "10.78.0.1/24", "ipv4.nat": "true", "ipv6.address": "none" });
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
  const n = writes(fake).length;
  await cmdSetup(fakeContext({ incus: fake, rules: [NO_HERDR] }), opts());
  const w = writes(fake).slice(n);
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
