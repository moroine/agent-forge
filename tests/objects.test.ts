import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, type ForgeConfig, type Limits } from "../cli/lib/config.ts";
import {
  ACL, BRIDGE, PROFILE, RAW_LXC, desiredAcl, desiredBridge, desiredProfile, desiredProject, desiredProxyAcl,
  desiredProxyProfile, desiredStrictAcl, effectiveEgress, egressNames, proxyInstance, rawLxcAllowed,
} from "../cli/lib/objects.ts";
import { parseAddress, parseCidr, proxyPlan } from "../cli/lib/ipv4.ts";

const IDS = { uid: 501, gid: 20 };
const cfg = (limits: Partial<Limits> = {}): ForgeConfig => {
  const c = structuredClone(DEFAULT_CONFIG);
  return { ...c, limits: { ...c.limits, ...limits } };
};

test("the names shared with the host and the other sub-projects", () => {
  assert.equal(BRIDGE, "forgebr0");
  assert.equal(ACL, "forge-egress");
  assert.equal(PROFILE, "agent-forge");
});

test("the default profile, key by key", () => {
  assert.deepEqual(desiredProfile(cfg(), IDS, { rawLxc: true }).config, {
    "environment.HOME": "/home/aiuser",
    "security.privileged": "false",
    "security.nesting": "true",
    "security.syscalls.deny_default": "true",
    "limits.memory": "75%",
    "limits.processes": "10000",
    "raw.idmap": "uid 501 1001\ngid 20 1001",
    "raw.lxc": RAW_LXC,
  });
});

test("limits.cpu appears only when set, always as a string", () => {
  assert.equal(desiredProfile(cfg({ cpu: 4 }), IDS, { rawLxc: true }).config["limits.cpu"], "4");
  assert.equal(desiredProfile(cfg({ cpu: "0-3" }), IDS, { rawLxc: true }).config["limits.cpu"], "0-3");
});

test("every value is a string, as Incus stores them", () => {
  for (const value of Object.values(desiredProfile(cfg({ cpu: 4 }), IDS, { rawLxc: true }).config)) {
    assert.equal(typeof value, "string");
  }
});

test("the devices: a NIC on the bridge behind the ACL, a root disk from the config", () => {
  const c = { ...cfg({ rootDisk: "80GiB" }), storagePool: "fast" };
  assert.deepEqual(desiredProfile(c, IDS, { rawLxc: true }).devices, {
    eth0: {
      type: "nic", name: "eth0", network: "forgebr0",
      "security.acls": "forge-egress",
      "security.acls.default.egress.action": "allow",
      "security.acls.default.ingress.action": "reject",
    },
    root: { type: "disk", path: "/", pool: "fast", size: "80GiB" },
  });
});

test("without raw.lxc, nothing else changes", () => {
  const withIt = desiredProfile(cfg(), IDS, { rawLxc: true }).config;
  const without = desiredProfile(cfg(), IDS, { rawLxc: false }).config;
  assert.equal("raw.lxc" in without, false);
  assert.deepEqual({ ...without, "raw.lxc": RAW_LXC }, withIt);
});

test("raw.lxc keeps v1's capability drops", () => {
  for (const line of [
    "lxc.cap.drop = sys_module sys_rawio sys_boot sys_ptrace sys_pacct",
    "lxc.cap.drop = mac_override mac_admin",
    "lxc.cap.drop = bpf perfmon",
  ]) assert.ok(RAW_LXC.split("\n").includes(line), line);
});

test("the bridge: address from the config, NAT on, IPv6 off", () => {
  const c = { ...cfg(), network: { ipv4Address: "10.88.0.1/24" } };
  assert.deepEqual(desiredBridge(c).config, {
    "ipv4.address": "10.88.0.1/24", "ipv4.nat": "true", "ipv6.address": "none", "ipv4.dhcp.ranges": "10.88.0.10-10.88.0.254",
  });
});

test("the ACL: one egress reject rule, no ingress rule", () => {
  const acl = desiredAcl();
  assert.deepEqual(acl.config, {});
  assert.deepEqual(acl.ingress, []);
  assert.deepEqual(acl.egress, [{
    action: "reject", state: "enabled",
    destination: "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,100.64.0.0/10,224.0.0.0/4",
  }]);
});

test("the project's features", () => {
  assert.deepEqual(desiredProject().config, {
    "features.images": "true",
    "features.profiles": "true",
    "features.storage.volumes": "true",
    "features.networks": "false",
  });
});

test("raw.lxc is allowed unless the project is restricted without lowlevel", () => {
  assert.equal(rawLxcAllowed({}), true);
  assert.equal(rawLxcAllowed({ restricted: "false" }), true);
  assert.equal(rawLxcAllowed({ restricted: "true" }), false);
  assert.equal(rawLxcAllowed({ restricted: "true", "restricted.containers.lowlevel": "block" }), false);
  assert.equal(rawLxcAllowed({ restricted: "true", "restricted.containers.lowlevel": "allow" }), true);
});

test("agent-forge uses slot 0 and the spec's ACL names", () =>
  assert.deepEqual(egressNames("agent-forge"), { slot: 0, proxyAcl: "forge-proxy", strictAcl: "forge-egress-strict" }));

// Incus refuses two instances of the same name on one bridge, across projects.
test("the proxy instance is forge-proxy in agent-forge, suffixed with the project elsewhere", () => {
  assert.equal(proxyInstance("agent-forge"), "forge-proxy");
  assert.equal(proxyInstance("forge-selftest"), "forge-proxy-forge-selftest");
});

test("another project gets FORGE_PROXY_SLOT (default 1) and suffixed names", () => {
  const saved = process.env.FORGE_PROXY_SLOT;
  try {
    delete process.env.FORGE_PROXY_SLOT;
    assert.deepEqual(egressNames("forge-selftest"),
      { slot: 1, proxyAcl: "forge-proxy-forge-selftest", strictAcl: "forge-egress-strict-forge-selftest" });
    process.env.FORGE_PROXY_SLOT = "3";
    assert.equal(egressNames("forge-selftest").slot, 3);
    for (const bad of ["0", "8", "x", "1.5"]) {
      process.env.FORGE_PROXY_SLOT = bad;
      assert.throws(() => egressNames("forge-selftest"), /FORGE_PROXY_SLOT/);
    }
  } finally {
    if (saved === undefined) delete process.env.FORGE_PROXY_SLOT; else process.env.FORGE_PROXY_SLOT = saved;
  }
});

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
test("no ACL rule names another ACL", () => {
  for (const acl of [desiredProxyAcl(plan), desiredStrictAcl(plan)])
    for (const rule of [...acl.ingress, ...acl.egress])
      for (const k of ["source", "destination"])
        if (rule[k] !== undefined)
          assert.ok(parseAddress(rule[k]) !== null || parseCidr(rule[k]) !== null, `${k}: ${rule[k]}`);
});
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
test("in a restricted project the proxy profile goes without raw.lxc", () => {
  const p = desiredProxyProfile(DEFAULT_CONFIG, egressNames("agent-forge"), { rawLxc: false });
  assert.equal("raw.lxc" in p.config, false);
});
test("effectiveEgress reads the expanded NIC, not a label", () => {
  const n = egressNames("agent-forge");
  assert.equal(effectiveEgress({ eth0: { "security.acls": "forge-egress-strict", "security.acls.default.egress.action": "reject" } }, n), "strict");
  assert.equal(effectiveEgress({ eth0: { "security.acls": "forge-egress" } }, n), "open");
  assert.equal(effectiveEgress({ eth0: { "security.acls": "forge-egress-strict", "security.acls.default.egress.action": "allow" } }, n), "?");
  assert.equal(effectiveEgress({}, n), "?");
});
