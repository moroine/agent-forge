import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import type { Context } from "../cli/lib/context.ts";
import { proxyPlan } from "../cli/lib/ipv4.ts";
import {
  PROXY_RECIPE, SQUID_ACCESS_LOG, SQUID_ALLOWLIST, SQUID_CONF, allowlistText, convergeProxy, squidConfig,
} from "../cli/lib/proxy.ts";

const plan = proxyPlan("10.77.0.1/24", 0);
const conf = squidConfig(plan, { hasEntries: true });
const lines = conf.split("\n");
const access = lines.filter((l) => l.startsWith("http_access"));

test("squid listens on the proxy address only, with ICP, HTCP and the cache off", () => {
  for (const line of ["http_port 10.77.0.2:3128", "icp_port 0", "htcp_port 0", "cache deny all", "via off", "forwarded_for delete",
    "acl agents src 10.77.0.0/24", "access_log daemon:/var/log/squid/access.log squid"]) assert.ok(lines.includes(line), line);
  assert.equal(SQUID_ACCESS_LOG, "/var/log/squid/access.log");
});

test("http_access denies bad ports, non-443 CONNECT, IP literals and private destinations before the allowlist", () => {
  assert.equal(access.length, 7);
  assert.match(access[0], /deny !Safe_ports/);
  assert.match(access[1], /deny CONNECT !SSL_ports/);
  assert.equal(access[2], "http_access deny ftp");
  assert.ok(lines.includes("acl ftp proto FTP"));
  assert.match(access[3], /deny iplit/);
  assert.match(access[4], /deny privdst/);
  assert.equal(access[5], "http_access allow agents allowed");
  assert.equal(access[6], "http_access deny all");
  assert.ok(conf.includes('acl allowed dstdomain -n "/etc/squid/allowlist"'));
  assert.match(conf, /^acl iplit dstdom_regex -n /m);
  const priv = lines.find((l) => l.startsWith("acl privdst dst"))!;
  for (const net of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "127.0.0.0/8",
    "0.0.0.0/8", "224.0.0.0/4", "::1", "::/128", "fc00::/7", "fe80::/10", "ff00::/8"]) assert.ok(priv.split(" ").includes(net), net);
});

test("an empty allowlist drops the allow rule and the allowlist ACL", () => {
  const empty = squidConfig(plan, { hasEntries: false });
  assert.ok(!empty.includes("allow agents"));
  assert.ok(!empty.includes("dstdomain"));
  assert.ok(empty.includes("http_access deny all"));
});

test("allowlistText is one entry per line with a final newline, empty when empty", () => {
  assert.equal(allowlistText([".github.com", "example.org"]), ".github.com\nexample.org\n");
  assert.equal(allowlistText([]), "");
});

// --- lifecycle, against the stateful fake ---

const ENTRIES = [".github.com", ".npmjs.org"];
const nicFor = (p: typeof plan) => ({ type: "nic", network: "forgebr0", "ipv4.address": p.proxyAddress });
const nic = nicFor(plan);

function setup(): { fake: FakeIncus; ctx: ReturnType<typeof fakeContext> } {
  const fake = FakeIncus.withRuntime();
  fake.addProfile("agent-forge", "forge-proxy", { devices: { eth0: { type: "nic", network: "forgebr0" } } });
  return { fake, ctx: fakeContext({ incus: fake }) };
}
const opts = { aptDelayMs: 0 };
const line = (ctx: { calls: string[][] }) => ctx.calls.map((c) => c.join(" "));
const idx = (calls: string[], s: string) => calls.findIndex((c) => c.includes(s));

test("a missing proxy is launched with its address, configured, then stamped last", async () => {
  const { fake, ctx } = setup();
  const r = await convergeProxy(ctx, { plan, entries: ENTRIES, nic }, opts);
  assert.deepEqual(r, { outcome: "created", previousAddress: null });
  const calls = line(ctx).filter((c) => !c.includes(" list "));
  const order = [
    "launch images:ubuntu/26.04 forge-proxy --profile forge-proxy -d eth0,ipv4.address=10.77.0.2",
    "systemctl is-system-running --wait",
    "apt-get update",
    "apt-get install -y squid unattended-upgrades",
    "file push",
    "forge-proxy/etc/squid/squid.conf",
    "forge-proxy/etc/squid/allowlist",
    "squid -k parse",
    "systemctl enable squid",
    "systemctl restart squid",
    "config set forge-proxy user.forge.proxy_recipe 1",
  ].map((s) => idx(calls, s));
  assert.ok(order.every((i) => i >= 0), order.join());
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(calls.some((c) => c.includes("forge-proxy/etc/apt/apt.conf.d/20auto-upgrades")));
  assert.equal(fake.files.get("agent-forge/forge-proxy/etc/apt/apt.conf.d/50agent-forge-keep-conffiles")?.content,
    'Dpkg::Options {\n  "--force-confdef";\n  "--force-confold";\n};\n');
  const inst = fake.instances.get("agent-forge")!.get("forge-proxy")!;
  assert.match(inst.config["user.forge.proxy_config"], /^[0-9a-f]{64}$/);
  assert.ok(idx(calls, "user.forge.proxy_config") < idx(calls, "user.forge.proxy_recipe"));
  assert.equal(idx(calls, "config set forge-proxy user.forge.proxy_recipe 1"), calls.length - 1);
  assert.equal(fake.files.get(`agent-forge/forge-proxy${SQUID_CONF}`)?.content, conf);
  assert.equal(fake.files.get(`agent-forge/forge-proxy${SQUID_ALLOWLIST}`)?.content, allowlistText(ENTRIES));
  assert.equal(fake.files.get("agent-forge/forge-proxy/etc/apt/apt.conf.d/20auto-upgrades")?.content,
    'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n');
  assert.equal(fake.instances.get("agent-forge")!.get("forge-proxy")!.config["user.forge.proxy_recipe"], String(PROXY_RECIPE));
});

test("apt-get update is retried while the network comes up", async () => {
  const { fake } = setup();
  const base = fakeContext({ incus: fake });
  let failures = 2;
  let updates = 0;
  const ctx: Context = {
    ...base,
    exec: async (argv, o) => {
      if (argv.join(" ").includes("apt-get update")) updates++;
      if (argv.join(" ").includes("apt-get update") && failures-- > 0) return { code: 100, stdout: "", stderr: "no network" };
      return base.exec(argv, o);
    },
  };
  const r = await convergeProxy(ctx, { plan, entries: ENTRIES, nic }, opts);
  assert.equal(r.outcome, "created");
  assert.equal(updates, 3);
});

test("apt-get update gives up after the attempts and leaves the instance", async () => {
  const { fake } = setup();
  const ctx = fakeContext({ incus: fake, rules: [{ match: "apt-get update", code: 100, stderr: "offline" }] });
  await assert.rejects(convergeProxy(ctx, { plan, entries: ENTRIES, nic }, { aptAttempts: 2, aptDelayMs: 0 }), /offline[\s\S]*forge setup/);
  assert.equal(ctx.calls.filter((c) => c.join(" ").includes("apt-get update")).length, 2);
  assert.ok(fake.instances.get("agent-forge")!.has("forge-proxy"));
  assert.equal(fake.instances.get("agent-forge")!.get("forge-proxy")!.config["user.forge.proxy_recipe"], undefined);
});

test("a second run pulls both files, finds them equal, and makes no mutating call", async () => {
  const { fake } = setup();
  await convergeProxy(fakeContext({ incus: fake }), { plan, entries: ENTRIES, nic }, opts);
  const ctx = fakeContext({ incus: fake });
  const r = await convergeProxy(ctx, { plan, entries: ENTRIES, nic }, opts);
  assert.deepEqual(r, { outcome: "unchanged", previousAddress: null });
  const calls = line(ctx);
  assert.equal(calls.filter((c) => c.includes(" file pull ")).length, 2);
  assert.equal(calls.filter((c) => !c.includes(" list ") && !c.includes(" file pull ") && !c.includes("is-active")).length, 0, calls.join("\n"));
});

async function converged(): Promise<FakeIncus> {
  const { fake } = setup();
  await convergeProxy(fakeContext({ incus: fake }), { plan, entries: ENTRIES, nic }, opts);
  return fake;
}

test("a changed allowlist pushes both files, parses, then reconfigures", async () => {
  const fake = await converged();
  const ctx = fakeContext({ incus: fake });
  const r = await convergeProxy(ctx, { plan, entries: [".github.com"], nic }, opts);
  assert.deepEqual(r, { outcome: "updated", previousAddress: null });
  const calls = line(ctx);
  assert.equal(calls.filter((c) => c.includes(" file push ")).length, 2);
  assert.ok(idx(calls, "squid -k parse") > idx(calls, " file push "));
  assert.ok(idx(calls, "squid -k reconfigure") > idx(calls, "squid -k parse"));
  assert.equal(fake.files.get(`agent-forge/forge-proxy${SQUID_ALLOWLIST}`)?.content, ".github.com\n");
});

test("a config file missing in the proxy is pushed again", async () => {
  const fake = await converged();
  fake.files.delete(`agent-forge/forge-proxy${SQUID_ALLOWLIST}`);
  const r = await convergeProxy(fakeContext({ incus: fake }), { plan, entries: ENTRIES, nic }, opts);
  assert.equal(r.outcome, "updated");
  assert.equal(fake.files.get(`agent-forge/forge-proxy${SQUID_ALLOWLIST}`)?.content, allowlistText(ENTRIES));
});

test("a failed squid -k parse stops with squid's message and does not reconfigure", async () => {
  const fake = await converged();
  const ctx = fakeContext({ incus: fake, rules: [{ match: "squid -k parse", code: 1, stderr: "FATAL: bad" }] });
  await assert.rejects(convergeProxy(ctx, { plan, entries: [".other.org"], nic }, opts), /FATAL: bad/);
  const calls = line(ctx);
  assert.ok(!calls.some((c) => c.includes("squid -k reconfigure") || c.includes("systemctl restart squid") || c.includes(" restart ")));
});

test("a leftover without the recipe key is deleted and recreated", async () => {
  const { fake } = setup();
  fake.addInstance("agent-forge", "forge-proxy", { profiles: ["forge-proxy"] });
  const ctx = fakeContext({ incus: fake });
  const r = await convergeProxy(ctx, { plan, entries: ENTRIES, nic }, opts);
  assert.deepEqual(r, { outcome: "created", previousAddress: null });
  const calls = line(ctx);
  assert.ok(idx(calls, "delete forge-proxy --force") >= 0);
  assert.ok(idx(calls, " launch ") > idx(calls, "delete forge-proxy --force"));
});

test("an older recipe is replaced", async () => {
  const { fake } = setup();
  fake.addInstance("agent-forge", "forge-proxy", { profiles: ["forge-proxy"], config: { "user.forge.proxy_recipe": "0" } });
  const r = await convergeProxy(fakeContext({ incus: fake }), { plan, entries: ENTRIES, nic }, opts);
  assert.deepEqual(r, { outcome: "updated", previousAddress: null });
  assert.equal(fake.instances.get("agent-forge")!.get("forge-proxy")!.config["user.forge.proxy_recipe"], String(PROXY_RECIPE));
});

test("a moved bridge recreates the proxy and returns the old address", async () => {
  const fake = await converged();
  const moved = proxyPlan("10.78.0.1/24", 0);
  const ctx = fakeContext({ incus: fake });
  const r = await convergeProxy(ctx, { plan: moved, entries: ENTRIES, nic: nicFor(moved) }, opts);
  assert.deepEqual(r, { outcome: "updated", previousAddress: "10.77.0.2" });
  const calls = line(ctx);
  assert.ok(idx(calls, "delete forge-proxy --force") >= 0);
  assert.ok(idx(calls, "launch images:ubuntu/26.04 forge-proxy --profile forge-proxy -d eth0,ipv4.address=10.78.0.2") > idx(calls, "delete"));
  assert.equal(fake.files.get(`agent-forge/forge-proxy${SQUID_CONF}`)?.content, squidConfig(moved, { hasEntries: true }));
});

test("a changed NIC key recreates the proxy without a previous address", async () => {
  const fake = await converged();
  const ctx = fakeContext({ incus: fake });
  const r = await convergeProxy(ctx, { plan, entries: ENTRIES, nic: { ...nic, "security.acls": "forge-egress,forge-proxy" } }, opts);
  assert.deepEqual(r, { outcome: "updated", previousAddress: null });
  assert.ok(idx(line(ctx), "delete forge-proxy --force") >= 0);
});

test("a failed parse is retried: the next run parses, reconfigures and reports updated", async () => {
  const fake = await converged();
  const bad = fakeContext({ incus: fake, rules: [{ match: "squid -k parse", code: 1, stderr: "FATAL: bad" }] });
  await assert.rejects(convergeProxy(bad, { plan, entries: [".github.com"], nic }, opts), /FATAL: bad/);
  const ctx = fakeContext({ incus: fake });
  const r = await convergeProxy(ctx, { plan, entries: [".github.com"], nic }, opts);
  assert.equal(r.outcome, "updated");
  const calls = line(ctx);
  assert.ok(idx(calls, "squid -k reconfigure") > idx(calls, "squid -k parse"));
  const again = await convergeProxy(fakeContext({ incus: fake }), { plan, entries: [".github.com"], nic }, opts);
  assert.equal(again.outcome, "unchanged");
});

test("an inactive squid is restarted and reported updated, files untouched", async () => {
  const fake = await converged();
  const ctx = fakeContext({ incus: fake, rules: [{ match: "systemctl is-active", code: 3 }] });
  const r = await convergeProxy(ctx, { plan, entries: ENTRIES, nic }, opts);
  assert.equal(r.outcome, "updated");
  const calls = line(ctx);
  assert.ok(idx(calls, "systemctl restart squid") >= 0);
  assert.ok(!calls.some((c) => c.includes(" file push ")));
});

test("an inactive squid with changed files is restarted instead of reconfigured", async () => {
  const fake = await converged();
  const ctx = fakeContext({ incus: fake, rules: [{ match: "systemctl is-active", code: 3 }] });
  await convergeProxy(ctx, { plan, entries: [".github.com"], nic }, opts);
  const calls = line(ctx);
  assert.ok(idx(calls, "systemctl restart squid") > idx(calls, "squid -k parse"));
  assert.ok(!calls.some((c) => c.includes("squid -k reconfigure")));
});

test("a stopped proxy is started", async () => {
  const fake = await converged();
  fake.instances.get("agent-forge")!.get("forge-proxy")!.status = "Stopped";
  const ctx = fakeContext({ incus: fake });
  const r = await convergeProxy(ctx, { plan, entries: ENTRIES, nic }, opts);
  assert.deepEqual(r, { outcome: "updated", previousAddress: null });
  assert.ok(idx(line(ctx), " start forge-proxy") >= 0);
  assert.equal(fake.instances.get("agent-forge")!.get("forge-proxy")!.status, "Running");
});

test("creation never unsets the loaded-config key (absent on a fresh instance)", async () => {
  const { ctx } = setup();
  await convergeProxy(ctx, { plan, entries: ENTRIES, nic }, opts);
  assert.ok(!line(ctx).some((c) => c.includes("config unset")));
});

test("a stamped instance without the hash key converges without an unset", async () => {
  const fake = await converged();
  delete fake.instances.get("agent-forge")!.get("forge-proxy")!.config["user.forge.proxy_config"];
  const ctx = fakeContext({ incus: fake });
  const r = await convergeProxy(ctx, { plan, entries: ENTRIES, nic }, opts);
  assert.equal(r.outcome, "updated");
  const calls = line(ctx);
  assert.ok(!calls.some((c) => c.includes("config unset")));
  assert.ok(idx(calls, "squid -k parse") >= 0 && idx(calls, "squid -k reconfigure") > idx(calls, "squid -k parse"));
  assert.match(fake.instances.get("agent-forge")!.get("forge-proxy")!.config["user.forge.proxy_config"], /^[0-9a-f]{64}$/);
});

test("after a NIC-driven recreation the next run is unchanged", async () => {
  const fake = await converged();
  const profileNic = { type: "nic", network: "forgebr0", "security.acls": "forge-egress,forge-proxy" };
  fake.addProfile("agent-forge", "forge-proxy", { devices: { eth0: profileNic } });
  const want = { ...profileNic, "ipv4.address": plan.proxyAddress };
  const first = await convergeProxy(fakeContext({ incus: fake }), { plan, entries: ENTRIES, nic: want }, opts);
  assert.equal(first.outcome, "updated");
  const second = await convergeProxy(fakeContext({ incus: fake }), { plan, entries: ENTRIES, nic: want }, opts);
  assert.deepEqual(second, { outcome: "unchanged", previousAddress: null });
});
