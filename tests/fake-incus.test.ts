import { test } from "node:test";
import assert from "node:assert/strict";
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

test("publish --reuse moves the alias to a new image and keeps the old one", () => {
  const fake = FakeIncus.withRuntime();
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

test("an unsupported command fails instead of passing silently", () => {
  assert.equal(new FakeIncus().run(["--project", "default", "snapshot", "create", "c"]).code, 1);
});
