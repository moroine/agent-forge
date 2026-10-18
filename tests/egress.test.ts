import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fakeContext } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { ForgeError } from "../cli/lib/context.ts";
import { cmdEgress, parseSquidLine } from "../cli/lib/commands/egress.ts";
import { ENV_KEYS, currentPlan, proxyEnv } from "../cli/lib/strict.ts";

const dir = mkdtempSync(join(tmpdir(), "forge-egress-"));
process.env.XDG_CONFIG_HOME = dir;
const PROJECT = "agent-forge";
const NAME = "agent-o-r";
const OPEN_NIC = {
  type: "nic", network: "forgebr0", "security.acls": "forge-egress", "security.acls.default.egress.action": "allow",
};
const STRICT_NIC = {
  ...OPEN_NIC, "security.acls": "forge-egress-strict",
  "security.acls.default.egress.action": "reject", "security.acls.default.ingress.action": "reject",
};

function setup(opts: { mode?: "open" | "strict" | "manual"; status?: "Running" | "Stopped"; version?: string } = {}) {
  const fake = FakeIncus.withRuntime();
  if (opts.version) fake.serverVersion = opts.version;
  fake.networks.set("forgebr0", { name: "forgebr0", description: "", config: {}, type: "bridge", managed: true });
  fake.addProfile(PROJECT, "agent-forge", { devices: { eth0: OPEN_NIC } });
  fake.acls.set("forge-egress-strict", { name: "forge-egress-strict", description: "", config: {}, ingress: [], egress: [] });
  fake.addInstance(PROJECT, "forge-proxy", { config: { "user.forge.proxy_recipe": "1" }, ipv4: "10.77.0.2" });
  const mode = opts.mode ?? "open";
  const strict = mode === "strict";
  fake.addInstance(PROJECT, NAME, {
    status: opts.status ?? "Stopped",
    profiles: ["agent-forge"],
    config: {
      "user.forge.repo": "o/r", "user.forge.egress": strict ? "strict" : "open",
      ...(strict ? Object.fromEntries(Object.entries(proxyEnv(currentPlan())).map(([k, v]) => [`environment.${k}`, v])) : {}),
    },
    devices: strict ? { eth0: STRICT_NIC } : mode === "manual" ? { eth0: { ...OPEN_NIC, "security.acls": "mine" } } : {},
    ipv4: "10.77.0.57",
  });
  return { fake, ctx: fakeContext({ incus: fake }) };
}
const cmds = (ctx: { calls: string[][] }) => ctx.calls.map((c) => c.join(" "));
const writes = (ctx: { calls: string[][] }) => cmds(ctx).filter((c) => / config (set|unset|device) /.test(c));

test("without a mode it prints the effective egress, and for strict the allowlist, never creating it", async () => {
  const path = join(dir, "agent-forge", "egress-allowlist");
  const { ctx } = setup({ mode: "strict" });
  assert.equal(await cmdEgress(ctx, "o/r"), 0);
  assert.deepEqual(ctx.out_lines, ["o/r: strict", `allowlist: ${path} (not created yet: run forge setup)`]);
  assert.equal(existsSync(path), false);
  assert.deepEqual(ctx.err_lines, []);

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "example.com\n.example.org\n");
  try {
    const again = setup({ mode: "strict" });
    await cmdEgress(again.ctx, "o/r");
    assert.deepEqual(again.ctx.out_lines, ["o/r: strict", `allowlist: ${path} (2 entries)`]);
  } finally {
    rmSync(path);
  }
  const open = setup();
  await cmdEgress(open.ctx, "o/r");
  assert.deepEqual(open.ctx.out_lines, ["o/r: open"]);
  assert.deepEqual(open.ctx.err_lines, []);
});

test("without a mode, a marker/NIC mismatch is reported with the commands that finish the switch", async () => {
  // Marked strict, eth0 override removed by hand.
  const lost = setup({ mode: "strict" });
  lost.fake.instances.get(PROJECT)!.get(NAME)!.devices = {};
  assert.equal(await cmdEgress(lost.ctx, "o/r"), 0);
  assert.equal(lost.ctx.out_lines[0], "o/r: open");
  assert.match(lost.ctx.err_lines.join("\n"),
    /^WARNING: agent-o-r is marked user\.forge\.egress=strict but its eth0 is open\. .*forge egress o\/r strict .*forge egress o\/r open/);
  // A switch to strict interrupted before the marker: strict NIC, marker open.
  const half = setup();
  half.fake.instances.get(PROJECT)!.get(NAME)!.devices.eth0 = { ...STRICT_NIC };
  await cmdEgress(half.ctx, "o/r");
  assert.equal(half.ctx.out_lines[0], "o/r: strict");
  assert.match(half.ctx.err_lines.join("\n"), /user\.forge\.egress=open but its eth0 is strict\. .*forge egress o\/r strict/);
  // Marked strict, eth0 changed by hand: forge egress would refuse it, the device is named instead.
  const manual = setup({ mode: "strict" });
  manual.fake.instances.get(PROJECT)!.get(NAME)!.devices.eth0 = { ...OPEN_NIC, "security.acls": "mine" };
  await cmdEgress(manual.ctx, "o/r");
  assert.equal(manual.ctx.out_lines[0], "o/r: ?");
  const warning = manual.ctx.err_lines.join("\n");
  assert.match(warning, /changed by hand\?\)\. Inspect it: incus --project agent-forge config device show agent-o-r$/);
  assert.doesNotMatch(warning, /forge egress/);
});

test("without a mode, a half-done switch whose marker agrees is reported with the command that finishes it", async () => {
  const strict = setup({ mode: "strict" });
  for (const k of ENV_KEYS) delete strict.fake.instances.get(PROJECT)!.get(NAME)!.config[k];
  await cmdEgress(strict.ctx, "o/r");
  assert.match(strict.ctx.err_lines.join("\n"), /^WARNING: the switch of agent-o-r to strict is not complete.*forge egress o\/r strict$/);
  const open = setup();
  open.fake.instances.get(PROJECT)!.get(NAME)!.config["environment.HTTPS_PROXY"] = "http://10.77.0.2:3128";
  await cmdEgress(open.ctx, "o/r");
  assert.match(open.ctx.err_lines.join("\n"), /the switch of agent-o-r to open is not complete.*forge egress o\/r open$/);
});

test("a switch prints one line per step it applied", async () => {
  const next = "The settings inside the container follow at the next forge start.";
  const toStrict = setup();
  await cmdEgress(toStrict.ctx, "o/r", "strict");
  assert.deepEqual(toStrict.ctx.out_lines, [
    "changed: eth0 filtered by forge-egress-strict, default egress and ingress reject",
    "changed: proxy environment set (7 keys, http://10.77.0.2:3128)",
    "changed: user.forge.egress=strict",
    `o/r: now strict. ${next}`,
  ]);
  const toOpen = setup({ mode: "strict" });
  await cmdEgress(toOpen.ctx, "o/r", "open");
  assert.deepEqual(toOpen.ctx.out_lines, [
    "changed: user.forge.egress=open",
    "changed: proxy environment removed (7 keys)",
    "changed: eth0 override removed, the profile's NIC applies again",
    `o/r: now open. ${next}`,
  ]);
  // Only the steps that had something to do: a strict marker left on an open NIC.
  const marker = setup({ mode: "strict" });
  const inst = marker.fake.instances.get(PROJECT)!.get(NAME)!;
  inst.devices = {};
  for (const k of ENV_KEYS) delete inst.config[k];
  await cmdEgress(marker.ctx, "o/r", "open");
  assert.deepEqual(marker.ctx.out_lines, ["changed: user.forge.egress=open", `o/r: now open. ${next}`]);
});

test("a running container is refused: stop it first", async () => {
  const { ctx } = setup({ status: "Running" });
  await assert.rejects(() => cmdEgress(ctx, "o/r", "strict"), /forge stop o\/r/);
  assert.deepEqual(writes(ctx), []);
});

test("→ strict on a stopped open container: override first, then environment, then the marker", async () => {
  const { fake, ctx } = setup();
  assert.equal(await cmdEgress(ctx, "o/r", "strict"), 0);
  const w = writes(ctx);
  assert.equal(w.length, 3);
  assert.equal(w[0], `incus --project agent-forge config device override ${NAME} eth0 security.acls=forge-egress-strict ` +
    "security.acls.default.egress.action=reject security.acls.default.ingress.action=reject");
  assert.ok(w[1].startsWith(`incus --project agent-forge config set ${NAME} environment.HTTP_PROXY=http://10.77.0.2:3128`));
  assert.equal(w[2], `incus --project agent-forge config set ${NAME} user.forge.egress strict`);
  assert.ok(ctx.out_lines.join("\n").includes("next forge start"));
  const inst = fake.instances.get(PROJECT)!.get(NAME)!;
  assert.equal(inst.config["environment.NODE_USE_ENV_PROXY"], "1");
  assert.equal(inst.devices.eth0["security.acls"], "forge-egress-strict");
});

test("→ strict with a local eth0 already there uses device set", async () => {
  // A local eth0 that still has the open ACL (e.g. left by a half-done switch).
  const again = setup();
  again.fake.instances.get(PROJECT)!.get(NAME)!.devices.eth0 = { ...OPEN_NIC };
  await cmdEgress(again.ctx, "o/r", "strict");
  const w = writes(again.ctx);
  assert.ok(w[0].includes(`config device set ${NAME} eth0`), w[0]);
});

test("→ strict checks the gate, the ACL and the proxy first", async () => {
  const gate = setup({ version: "7.0.1" });
  await assert.rejects(() => cmdEgress(gate.ctx, "o/r", "strict"), ForgeError);
  assert.deepEqual(writes(gate.ctx), []);
  const noAcl = setup();
  noAcl.fake.acls.delete("forge-egress-strict");
  await assert.rejects(() => cmdEgress(noAcl.ctx, "o/r", "strict"), /forge setup/);
  assert.deepEqual(writes(noAcl.ctx), []);
});

test("→ open: the marker, then the environment, then the override last", async () => {
  const { fake, ctx } = setup({ mode: "strict" });
  assert.equal(await cmdEgress(ctx, "o/r", "open"), 0);
  const w = writes(ctx);
  assert.equal(w.length, 9);
  assert.equal(w[0], `incus --project agent-forge config set ${NAME} user.forge.egress open`);
  assert.deepEqual(w.slice(1, 8), ENV_KEYS.map((k) => `incus --project agent-forge config unset ${NAME} ${k}`));
  assert.equal(w[8], `incus --project agent-forge config device remove ${NAME} eth0`);
  const inst = fake.instances.get(PROJECT)!.get(NAME)!;
  assert.deepEqual(inst.devices, {});
});

test("→ open skips what is already absent", async () => {
  const { fake, ctx } = setup({ mode: "strict" });
  const inst = fake.instances.get(PROJECT)!.get(NAME)!;
  delete inst.config["environment.NO_PROXY"];
  await cmdEgress(ctx, "o/r", "open");
  assert.equal(writes(ctx).filter((c) => c.includes(" config unset ")).length, 6);
});

test("a hand-made eth0 override is refused, not overwritten", async () => {
  for (const mode of ["strict", "open"] as const) {
    const { ctx } = setup({ mode: "manual" });
    await assert.rejects(() => cmdEgress(ctx, "o/r", mode), /eth0/);
    assert.deepEqual(writes(ctx), []);
  }
});

test("asking for the current mode changes nothing", async () => {
  const { ctx } = setup({ mode: "strict" });
  assert.equal(await cmdEgress(ctx, "o/r", "strict"), 0);
  assert.deepEqual(ctx.out_lines, ["o/r: already strict"]);
  assert.deepEqual(writes(ctx), []);
});

test("an unknown mode is a usage error", async () => {
  const { ctx } = setup();
  await assert.rejects(() => cmdEgress(ctx, "o/r", "loose"), /Usage: forge egress/);
});

test("a half-done → strict switch (override landed, marker open, no env) is completed", async () => {
  const { fake, ctx } = setup();
  fake.instances.get(PROJECT)!.get(NAME)!.devices.eth0 = { ...STRICT_NIC };
  assert.equal(await cmdEgress(ctx, "o/r", "strict"), 0);
  assert.ok(!ctx.out_lines.join("\n").includes("already"));
  const inst = fake.instances.get(PROJECT)!.get(NAME)!;
  assert.equal(inst.config["user.forge.egress"], "strict");
  assert.equal(inst.config["environment.HTTPS_PROXY"], "http://10.77.0.2:3128");
  assert.ok(writes(ctx).some((c) => c.includes("config device set")));
  assert.ok(!writes(ctx).some((c) => c.includes("device override")));
});

test("a half-done → open switch (marker open, env partly unset, override left) is completed", async () => {
  const { fake, ctx } = setup({ mode: "strict" });
  const inst = fake.instances.get(PROJECT)!.get(NAME)!;
  inst.config["user.forge.egress"] = "open";
  for (const k of ENV_KEYS.slice(0, 4)) delete inst.config[k];
  assert.equal(await cmdEgress(ctx, "o/r", "open"), 0);
  const w = writes(ctx);
  assert.equal(w.filter((c) => c.includes(" config unset ")).length, 3);
  assert.ok(w[w.length - 1].includes("config device remove"));
  assert.deepEqual(inst.devices, {});
  assert.ok(!ENV_KEYS.some((k) => k in inst.config));
});

test("squid lines parse into time, client, result, method and host", () => {
  assert.deepEqual(parseSquidLine("1760745600.123     45 10.77.0.57 TCP_TUNNEL/200 3901 CONNECT api.anthropic.com:443 - HIER_DIRECT/160.79.104.10 -"),
    { time: "2025-10-18T00:00:00Z", client: "10.77.0.57", result: "allowed", method: "CONNECT", host: "api.anthropic.com:443" });
  assert.equal(parseSquidLine("1760745600.123 0 10.77.0.57 TCP_DENIED/403 3870 CONNECT example.org:443 - HIER_NONE/- text/html")!.result, "denied");
});

test("an origin 403 over plain HTTP is allowed: the proxy let it through", () => {
  assert.equal(parseSquidLine("1760745600.1 3 10.77.0.57 TCP_MISS/403 10 GET http://example.com/ - HIER_DIRECT/x text/html")!.result, "allowed");
});

test("the result: denied for TCP_DENIED, error for NONE (invalid requests, squid errors), allowed otherwise", () => {
  const result = (action: string, method = "CONNECT", url = "example.com:443") =>
    parseSquidLine(`1760745600.1 0 10.77.0.57 ${action} 10 ${method} ${url} - HIER_NONE/- -`)!.result;
  assert.equal(result("TCP_DENIED/403"), "denied");
  assert.equal(result("TCP_DENIED_REPLY/403"), "denied");
  assert.equal(result("NONE_NONE/400", "NONE", "error:invalid-request"), "error");
  assert.equal(result("NONE/503"), "error");
  assert.equal(result("NONE_NONE/000"), "error");
  assert.equal(result("TCP_TUNNEL/200"), "allowed");
  assert.equal(result("TCP_MISS/200", "GET", "http://example.com/"), "allowed");
  // A URL without a host keeps its field: the column is never empty.
  assert.equal(parseSquidLine("1760745600.1 0 10.77.0.57 NONE_NONE/400 10 NONE error:invalid-request - HIER_NONE/- -")!.host,
    "error:invalid-request");
});

test("odd squid lines are skipped, plain HTTP URLs give their host", () => {
  assert.equal(parseSquidLine(""), null);
  assert.equal(parseSquidLine("1760745600.123 0 10.77"), null);
  assert.equal(parseSquidLine("x.y 0 10.77.0.57 TCP_MISS/200 10 GET http://example.com/a/b - HIER_DIRECT/x text/html"), null);
  assert.equal(parseSquidLine("1760745600.1 3 fd00::5 TCP_MISS/200 10 GET http://example.com/a/b - HIER_DIRECT/x text/html")!.host, "example.com");
});

const LOG = [
  "1760745600.123 45 10.77.0.57 TCP_TUNNEL/200 3901 CONNECT api.anthropic.com:443 - HIER_DIRECT/1.2.3.4 -",
  "garbage",
  "1760745660.000 0 10.77.0.99 TCP_DENIED/403 3870 CONNECT example.org:443 - HIER_NONE/- text/html",
].join("\n");

test("log maps addresses to container names and filters by repo", async () => {
  const c = fakeContext({ incus: setup().fake, rules: [{ match: "tail -n 200", stdout: LOG }] });
  assert.equal(await cmdEgress(c, "log"), 0);
  assert.match(c.out_lines[0], /^TIME\s+CONTAINER\s+RESULT\s+METHOD\s+HOST$/);
  assert.match(c.out_lines[1], /^2025-10-18T00:00:00Z\s+agent-o-r\s+allowed\s+CONNECT\s+api\.anthropic\.com:443$/);
  assert.match(c.out_lines[2], /^2025-10-18T00:01:00Z\s+10\.77\.0\.99\s+denied\s+CONNECT\s+example\.org:443$/);
  assert.equal(c.out_lines.length, 3);

  const f = fakeContext({ incus: setup().fake, rules: [{ match: "tail -n 200", stdout: LOG }] });
  await cmdEgress(f, "log", "o/r");
  assert.equal(f.out_lines.length, 2);
  assert.ok(f.out_lines[1].includes("agent-o-r"));
});

test("log names a stopped container through its DHCP lease", async () => {
  const { fake } = setup({ status: "Stopped" });
  const c = fakeContext({ incus: fake, rules: [{ match: "tail -n 200", stdout: LOG }] });
  await cmdEgress(c, "log", "o/r");
  assert.ok(c.calls.some((x) => x.join(" ") === "incus --project agent-forge network list-leases forgebr0 -f json"));
  assert.equal(c.out_lines.length, 2);
  assert.match(c.out_lines[1], /^\S+\s+agent-o-r\s+allowed\s+CONNECT\s+api\.anthropic\.com:443$/);
});

test("log: an instance's current address wins over a lease naming another host", async () => {
  const { fake } = setup({ status: "Running" });
  const leases = JSON.stringify([{ hostname: "someone-else", address: "10.77.0.57" }, { hostname: "gone", address: "10.77.0.99" }]);
  const c = fakeContext({ incus: fake, rules: [{ match: "tail -n 200", stdout: LOG }, { match: "list-leases", stdout: leases }] });
  await cmdEgress(c, "log");
  assert.match(c.out_lines[1], /\sagent-o-r\s/);
  assert.match(c.out_lines[2], /\sgone\s+denied\s/);
});

test("log: a lease without a real hostname (dnsmasq's \"*\") leaves the address as is", async () => {
  const leases = JSON.stringify([{ hostname: "*", address: "10.77.0.99" }, { hostname: "", address: "10.77.0.57" }]);
  const c = fakeContext({ incus: setup({ status: "Stopped" }).fake,
    rules: [{ match: "tail -n 200", stdout: LOG }, { match: "list-leases", stdout: leases }] });
  await cmdEgress(c, "log");
  assert.match(c.out_lines[1], /\s10\.77\.0\.57\s+allowed\s/);
  assert.match(c.out_lines[2], /\s10\.77\.0\.99\s+denied\s/);
});

test("log: a failed lease listing is not fatal", async () => {
  const c = fakeContext({ incus: setup({ status: "Running" }).fake,
    rules: [{ match: "tail -n 200", stdout: LOG }, { match: "list-leases", code: 1, stderr: "boom" }] });
  assert.equal(await cmdEgress(c, "log"), 0);
  assert.match(c.out_lines[1], /\sagent-o-r\s/);
});

test("log strips control characters (C0, DEL, C1) from every field it prints", async () => {
  const evil = "1760745600.1 0 10.77.0.57 TCP_DENIED/403 10 CONNECT ev\x1b[2J\x1b]0;pwned\x07il\x7f\u009b31m.example:443 - HIER_NONE/- -";
  const c = fakeContext({ incus: setup().fake, rules: [{ match: "tail -n 200", stdout: evil }] });
  await cmdEgress(c, "log");
  assert.equal(c.out_lines.length, 2);
  assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(c.out_lines.join("")), JSON.stringify(c.out_lines));
  assert.match(c.out_lines[1], /\sev\[2J\]0;pwnedil31m\.example:443$/);
});

test("log without a proxy names forge setup", async () => {
  const c = fakeContext({ incus: setup().fake, rules: [{ match: "tail -n 200", code: 1, stderr: "Instance not found" }] });
  await assert.rejects(() => cmdEgress(c, "log"), /forge setup/);
});
