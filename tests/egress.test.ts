import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { ForgeError } from "../cli/lib/context.ts";
import { cmdEgress, parseSquidLine } from "../cli/lib/commands/egress.ts";
import { ENV_KEYS } from "../cli/lib/strict.ts";

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
      ...(strict ? Object.fromEntries(ENV_KEYS.map((k) => [k, "x"])) : {}),
    },
    devices: strict ? { eth0: STRICT_NIC } : mode === "manual" ? { eth0: { ...OPEN_NIC, "security.acls": "mine" } } : {},
    ipv4: "10.77.0.57",
  });
  return { fake, ctx: fakeContext({ incus: fake }) };
}
const cmds = (ctx: { calls: string[][] }) => ctx.calls.map((c) => c.join(" "));
const writes = (ctx: { calls: string[][] }) => cmds(ctx).filter((c) => / config (set|unset|device) /.test(c));

test("without a mode it prints the effective egress, and for strict the allowlist", async () => {
  const { ctx } = setup({ mode: "strict" });
  assert.equal(await cmdEgress(ctx, "o/r"), 0);
  assert.equal(ctx.out_lines[0], "o/r: strict");
  // The default allowlist (created on first read) holds four entries.
  assert.equal(ctx.out_lines[1], `allowlist: ${join(dir, "agent-forge", "egress-allowlist")} (4 entries)`);
  const open = setup();
  await cmdEgress(open.ctx, "o/r");
  assert.deepEqual(open.ctx.out_lines, ["o/r: open"]);
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

test("squid lines parse into time, client, result, method and host", () => {
  assert.deepEqual(parseSquidLine("1760745600.123     45 10.77.0.57 TCP_TUNNEL/200 3901 CONNECT api.anthropic.com:443 - HIER_DIRECT/160.79.104.10 -"),
    { time: "2025-10-18T00:00:00Z", client: "10.77.0.57", result: "allowed", method: "CONNECT", host: "api.anthropic.com:443" });
  assert.equal(parseSquidLine("1760745600.123 0 10.77.0.57 TCP_DENIED/403 3870 CONNECT example.org:443 - HIER_NONE/- text/html")!.result, "denied");
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

test("log without a proxy names forge setup", async () => {
  const c = fakeContext({ incus: setup().fake, rules: [{ match: "tail -n 200", code: 1, stderr: "Instance not found" }] });
  await assert.rejects(() => cmdEgress(c, "log"), /forge setup/);
});
