import { test } from "node:test";
import assert from "node:assert/strict";
import type { NetworkInterfaceInfo } from "node:os";
import { fakeContext } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { fakeProc } from "./lib/fake-host.ts";
import { checkHost, checkIpForward, checkStoragePool, exposedHostAddresses, readProc } from "../cli/lib/host.ts";

const USER = 1000;
const ctx = (fake = new FakeIncus()) => fakeContext({ incus: fake });

const v4 = (address: string, internal = false) =>
  ({ address, netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal, cidr: `${address}/24` }) as NetworkInterfaceInfo;
const v6 = (address: string) =>
  ({ address, netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "00:00:00:00:00:00", internal: false, cidr: `${address}/64`, scopeid: 0 }) as NetworkInterfaceInfo;

test("a host that meets the contract passes", async () => {
  await checkHost(ctx(), { proc: fakeProc(), uid: USER });
});

test("root is refused before Incus is even asked", async () => {
  const c = ctx();
  await assert.rejects(() => checkHost(c, { proc: fakeProc(), uid: 0 }), /must not run as root/);
  assert.equal(c.calls.length, 0);
});

test("an unreachable Incus says what to check, with Incus' own message", async () => {
  const c = fakeContext({ rules: [{ match: "incus query /1.0", code: 1, stderr: "Error: permission denied\n" }] });
  await assert.rejects(() => checkHost(c, { proc: fakeProc(), uid: USER }), (e: Error) => {
    assert.match(e.message, /permission denied/);
    assert.match(e.message, /incus-admin/);
    return true;
  });
});

test("a firewall driver other than nftables is refused", async () => {
  const fake = new FakeIncus();
  fake.firewall = "xtables";
  await assert.rejects(() => checkHost(ctx(fake), { proc: fakeProc(), uid: USER }), /"xtables"[\s\S]*nftables/);
});

test("the AppArmor userns restriction is refused, with the fix for both modes", async () => {
  await assert.rejects(() => checkHost(ctx(), { proc: fakeProc({ restrictUserns: "1\n" }), uid: USER }), (e: Error) => {
    assert.match(e.message, /kernel\.apparmor_restrict_unprivileged_userns is 1/);
    assert.match(e.message, /ansible\/site\.yml/);
    assert.match(e.message, /sudo sysctl -w kernel\.apparmor_restrict_unprivileged_userns=0/);
    assert.match(e.message, /\/etc\/sysctl\.d\/60-agent-forge-userns\.conf/);
    return true;
  });
});

test("unprivileged_userns_clone=0 is refused", async () => {
  await assert.rejects(() => checkHost(ctx(), { proc: fakeProc({ usernsClone: "0\n" }), uid: USER }),
    /unprivileged_userns_clone is 0[\s\S]*sudo sysctl -w kernel\.unprivileged_userns_clone=1/);
});

test("a kernel without the knobs passes", async () => {
  await checkHost(ctx(), { proc: fakeProc({ restrictUserns: null, usernsClone: null }), uid: USER });
});

test("checks stop at the first failure", async () => {
  await assert.rejects(
    () => checkHost(ctx(), { proc: fakeProc({ restrictUserns: "1", usernsClone: "0" }), uid: USER }),
    (e: Error) => !/unprivileged_userns_clone/.test(e.message) && /apparmor_restrict/.test(e.message));
});

test("a missing storage pool names the pool, the fix and the config key", async () => {
  const fake = new FakeIncus();
  fake.storagePools = ["other"];
  await assert.rejects(() => checkStoragePool(ctx(fake), "default", "/c/config.json"),
    /pool "default" not found[\s\S]*storagePool[\s\S]*\/c\/config\.json/);
  await checkStoragePool(ctx(fake), "other", "/c/config.json");
});

test("IPv4 forwarding must be on", () => {
  assert.throws(() => checkIpForward(fakeProc({ ipForward: "0\n" })), /ip_forward is 0[\s\S]*sysctl -w net\.ipv4\.ip_forward=1/);
  assert.throws(() => checkIpForward(fakeProc({ ipForward: null })), /ip_forward is absent/);
  checkIpForward(fakeProc({ ipForward: "1\n" }));
});

test("readProc trims the value and maps a missing file to null", () => {
  const proc = fakeProc({ ipForward: "1\n", restrictUserns: null });
  assert.equal(readProc(proc.ipForward), "1");
  assert.equal(readProc(proc.restrictUserns), null);
});

test("host addresses the ACL covers raise nothing", () => {
  assert.deepEqual(exposedHostAddresses({
    eth0: [v4("192.168.5.15"), v6("fe80::1")],
    tailscale0: [v4("100.101.1.2")],
    lo: [v4("127.0.0.1", true)],
    forgebr0: [v4("10.77.0.1")],
  }, "10.77.0.1/24"), []);
});

test("a public host address is reported", () => {
  assert.deepEqual(exposedHostAddresses({ eth0: [v4("203.0.113.7"), v4("192.168.1.2")] }, "10.77.0.1/24"), ["203.0.113.7"]);
});
