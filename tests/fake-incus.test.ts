import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeIncus } from "./lib/fake-incus.ts";

const P = ["--project", "agent-forge"];

test("instance, profile and image commands require --project", () => {
  const fake = new FakeIncus();
  for (const argv of [["list", "-f", "json"], ["profile", "list", "-f", "json"],
    ["image", "list", "-f", "json"], ["launch", "agent-base", "c"]]) {
    const r = fake.run(argv);
    assert.equal(r.code, 1, argv.join(" "));
    assert.match(r.stderr, /--project is required/);
  }
});

test("an unknown project is refused", () => {
  assert.match(new FakeIncus().run(["--project", "nope", "list", "-f", "json"]).stderr, /Project not found/);
});

test("create reads the object from stdin, and list serves it back", () => {
  const fake = FakeIncus.withRuntime();
  const body = {
    description: "d",
    config: { "limits.processes": "10" },
    devices: { root: { type: "disk", path: "/", pool: "default" } },
  };
  assert.equal(fake.run([...P, "profile", "create", "p"], JSON.stringify(body)).code, 0);
  const listed = JSON.parse(fake.run([...P, "profile", "list", "-f", "json"]).stdout);
  const p = listed.find((x: { name: string }) => x.name === "p");
  assert.deepEqual({ description: p.description, config: p.config, devices: p.devices }, body);
});

test("an empty stdin wipes the object on edit, as the real CLI does", () => {
  const fake = FakeIncus.withRuntime();
  fake.addProfile("agent-forge", "p", { config: { "limits.memory": "1GiB" }, devices: { root: { type: "disk" } } });
  assert.equal(fake.run([...P, "profile", "edit", "p"], "").code, 0);
  assert.deepEqual(fake.profiles.get("agent-forge")!.get("p"), { name: "p", description: "", config: {}, devices: {} });
});

test("create without stdin creates an empty object", () => {
  const fake = FakeIncus.withRuntime();
  fake.run([...P, "network", "create", "br"]);
  assert.deepEqual(fake.networks.get("br")!.config, {});
});

test("an ACL is listed with every rule field, empty ones included", () => {
  const fake = FakeIncus.withRuntime();
  fake.run([...P, "network", "acl", "create", "a"],
    JSON.stringify({ egress: [{ action: "reject", state: "enabled", destination: "10.0.0.0/8" }] }));
  const [acl] = JSON.parse(fake.run([...P, "network", "acl", "list", "-f", "json"]).stdout);
  assert.equal(acl.egress[0].destination, "10.0.0.0/8");
  assert.equal(acl.egress[0].protocol, "");
  assert.deepEqual(acl.ingress, []);
});

test("the ACL loader rejects unknown fields", () => {
  const fake = FakeIncus.withRuntime();
  assert.equal(fake.run([...P, "network", "acl", "create", "a"], JSON.stringify({ rules: [] })).code, 1);
});

test("project create fills in the default features", () => {
  const fake = new FakeIncus();
  fake.run(["project", "create", "p"], JSON.stringify({ config: { "features.images": "false" } }));
  const config = fake.projects.get("p")!.config;
  assert.equal(config["features.images"], "false");
  assert.equal(config["features.storage.buckets"], "true");
  assert.ok(fake.profiles.get("p")!.has("default"));
});

test("network list includes the host's unmanaged interfaces", () => {
  const fake = FakeIncus.withRuntime();
  const listed = JSON.parse(fake.run([...P, "network", "list", "-f", "json"]).stdout);
  assert.ok(listed.some((n: { name: string; managed: boolean }) => n.name === "eth0" && !n.managed));
});

test("publish --reuse moves the alias to a new image and removes the old one", () => {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "b", { status: "Stopped" });
  const before = fake.findImage("agent-forge", "agent-base")!.fingerprint;
  assert.equal(fake.run([...P, "publish", "b", "--alias", "agent-base", "--reuse"]).code, 0);
  assert.equal(fake.images.get("agent-forge")!.length, 1);
  assert.notEqual(fake.findImage("agent-forge", "agent-base")!.fingerprint, before);
});

test("publish --reuse keeps the old image when publishReuseKeepsOld is set", () => {
  const fake = FakeIncus.withRuntime();
  fake.publishReuseKeepsOld = true;
  fake.addInstance("agent-forge", "b", { status: "Stopped" });
  const before = fake.findImage("agent-forge", "agent-base")!.fingerprint;
  assert.equal(fake.run([...P, "publish", "b", "--alias", "agent-base", "--reuse"]).code, 0);
  assert.equal(fake.images.get("agent-forge")!.length, 2);
  assert.notEqual(fake.findImage("agent-forge", "agent-base")!.fingerprint, before);
});

test("exec answers systemd's readiness, and needs a running instance", () => {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "c", { status: "Running" });
  assert.equal(fake.run([...P, "exec", "c", "--", "systemctl", "is-system-running", "--wait"]).stdout, "running\n");
  fake.addInstance("agent-forge", "d", { status: "Stopped" });
  assert.equal(fake.run([...P, "exec", "d", "--", "true"]).code, 1);
});

test("every call is recorded with its stdin", () => {
  const fake = new FakeIncus();
  fake.run(["project", "create", "p"], "{}");
  assert.deepEqual(fake.calls, [{ argv: ["project", "create", "p"], input: "{}" }]);
});

const strictFake = () => {
  const fake = FakeIncus.withRuntime();
  fake.addProfile("agent-forge", "agent-forge", {
    devices: { eth0: { type: "nic", network: "forgebr0", "security.acls": "forge-egress" } },
  });
  return fake;
};

test("launch applies -d device overrides on top of the profile device, and -c keys", () => {
  const fake = strictFake();
  const r = fake.run([...P, "launch", "agent-base", "c1", "--profile", "agent-forge",
    "-d", "eth0,security.acls=forge-egress-strict", "-c", "user.forge.egress=strict"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fake.expandedDevices("agent-forge", "c1").eth0,
    { type: "nic", network: "forgebr0", "security.acls": "forge-egress-strict" });
  assert.equal(fake.instances.get("agent-forge")!.get("c1")!.config["user.forge.egress"], "strict");
  // a device created by launch -d accepts device set
  assert.equal(fake.run([...P, "config", "device", "set", "c1", "eth0", "ipv4.address=10.77.0.9"]).code, 0);
  assert.equal(fake.expandedDevices("agent-forge", "c1").eth0["ipv4.address"], "10.77.0.9");
});

test("launch accumulates several -d flags on one device, one key=value each, as Incus does", () => {
  const fake = strictFake();
  const r = fake.run([...P, "launch", "agent-base", "c1", "--profile", "agent-forge",
    "-d", "eth0,security.acls=forge-egress-strict", "-d", "eth0,security.acls.default.egress.action=reject",
    "-d", "eth0,x=a,b"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fake.expandedDevices("agent-forge", "c1").eth0, {
    type: "nic", network: "forgebr0", "security.acls": "forge-egress-strict",
    "security.acls.default.egress.action": "reject", x: "a,b",
  });
});

test("device override copies the profile device; set needs a local device; remove restores the profile's", () => {
  const fake = strictFake();
  fake.run([...P, "launch", "agent-base", "c1", "--profile", "agent-forge"]);
  const dev = (...a: string[]) => fake.run([...P, "config", "device", ...a]);
  assert.equal(dev("set", "c1", "eth0", "a=b").code, 1);
  assert.equal(dev("override", "c1", "nope", "a=b").code, 1);
  assert.equal(dev("override", "c1", "eth0", "security.acls=x").code, 0);
  assert.equal(dev("override", "c1", "eth0", "security.acls=y").code, 1);
  assert.deepEqual(fake.instances.get("agent-forge")!.get("c1")!.devices.eth0,
    { type: "nic", network: "forgebr0", "security.acls": "x" });
  assert.equal(dev("set", "c1", "eth0", "security.acls=z").code, 0);
  assert.equal(fake.expandedDevices("agent-forge", "c1").eth0["security.acls"], "z");
  assert.equal(dev("remove", "c1", "eth0").code, 0);
  assert.equal(fake.expandedDevices("agent-forge", "c1").eth0["security.acls"], "forge-egress");
  assert.equal(dev("remove", "c1", "eth0").code, 1);
});

test("config unset of an absent key fails like real Incus", () => {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "c1");
  const r = fake.run([...P, "config", "unset", "c1", "nope"]);
  assert.equal(r.code, 1);
  assert.equal(r.stderr.trim(), "Error: Can't unset key 'nope', it's not currently set");
});

test("config set takes several key=value pairs, unset removes a key", () => {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "c1");
  const cfg = () => fake.instances.get("agent-forge")!.get("c1")!.config;
  assert.equal(fake.run([...P, "config", "set", "c1", "a=1", "b=x=y"]).code, 0);
  assert.deepEqual(cfg(), { a: "1", b: "x=y" });
  assert.equal(fake.run([...P, "config", "set", "c1", "c", "3"]).code, 0);
  assert.equal(cfg().c, "3");
  assert.equal(fake.run([...P, "config", "unset", "c1", "a"]).code, 0);
  assert.deepEqual(cfg(), { b: "x=y", c: "3" });
});

test("file push stores content, owner and mode; file pull - serves it; a missing file fails", () => {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "c1");
  const src = join(mkdtempSync(join(tmpdir(), "fake-incus-")), "src");
  writeFileSync(src, "hello\n");
  const r = fake.run([...P, "file", "push", src, "c1/etc/x", "--uid", "0", "--gid", "0", "--mode", "644", "--create-dirs"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fake.files.get("agent-forge/c1/etc/x"), { content: "hello\n", uid: "0", gid: "0", mode: "644" });
  assert.equal(fake.run([...P, "file", "pull", "c1/etc/x", "-"]).stdout, "hello\n");
  assert.equal(fake.run([...P, "file", "pull", "c1/etc/missing", "-"]).code, 1);
});

test("list -f json reports expanded devices and the eth0 address", () => {
  const fake = strictFake();
  fake.addInstance("agent-forge", "c1", { profiles: ["agent-forge"], ipv4: "10.77.0.57" });
  fake.addInstance("agent-forge", "c2");
  const [a, b] = JSON.parse(fake.run([...P, "list", "-f", "json"]).stdout);
  assert.equal(a.state.network.eth0.addresses[0].address, "10.77.0.57");
  assert.equal(a.state.network.eth0.addresses[0].family, "inet");
  assert.equal(a.expanded_devices.eth0.network, "forgebr0");
  assert.deepEqual(b.state.network.eth0.addresses, []);
});

test("a stopped instance has no eth0 address in list -f json; network list-leases still reports it", () => {
  const fake = strictFake();
  fake.networks.set("forgebr0", { name: "forgebr0", description: "", config: {}, type: "bridge", managed: true });
  fake.addInstance("agent-forge", "up", { ipv4: "10.77.0.57" });
  fake.addInstance("agent-forge", "down", { status: "Stopped", ipv4: "10.77.0.58" });
  fake.addInstance("agent-forge", "none");
  const listed = JSON.parse(fake.run([...P, "list", "-f", "json"]).stdout);
  assert.deepEqual(listed.map((i: { state: { network: { eth0: { addresses: unknown[] } } } }) => i.state.network.eth0.addresses.length), [1, 0, 0]);
  const leases = JSON.parse(fake.run([...P, "network", "list-leases", "forgebr0", "-f", "json"]).stdout);
  assert.deepEqual(leases.map((l: { hostname: string; address: string }) => [l.hostname, l.address]),
    [["up", "10.77.0.57"], ["down", "10.77.0.58"]]);
  assert.match(fake.run([...P, "network", "list-leases", "nope", "-f", "json"]).stderr, /Network not found/);
});

test("query /1.0 reports serverVersion", () => {
  const fake = new FakeIncus();
  const version = () => JSON.parse(fake.run(["query", "/1.0"]).stdout).environment.server_version;
  assert.equal(version(), "7.0.2");
  fake.serverVersion = "7.0.1";
  assert.equal(version(), "7.0.1");
});

test("restart keeps a running instance running and fails on a missing one", () => {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "c1");
  assert.equal(fake.run([...P, "restart", "c1"]).code, 0);
  assert.equal(fake.instances.get("agent-forge")!.get("c1")!.status, "Running");
  assert.equal(fake.run([...P, "restart", "nope"]).code, 1);
  fake.run([...P, "stop", "c1"]);
  const r = fake.run([...P, "restart", "c1"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /already stopped/);
  assert.match(new FakeIncus().run(["restart", "c1"]).stderr, /--project is required/);
});

test("an unsupported command fails instead of passing silently", () => {
  assert.equal(new FakeIncus().run(["--project", "default", "snapshot", "create", "c"]).code, 1);
});
