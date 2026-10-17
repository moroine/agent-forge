import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { converge, differs, ensureProject } from "../cli/lib/converge.ts";
import { desiredProject } from "../cli/lib/objects.ts";

const writes = (fake: FakeIncus) => fake.calls.filter((c) => c.argv.includes("create") || c.argv.includes("edit"));
const PROFILE = {
  description: "d",
  config: { "limits.processes": "10000" },
  devices: { root: { type: "disk", path: "/", pool: "default", size: "50GiB" } },
};

test("a missing object is created with its whole state on stdin", async () => {
  const fake = FakeIncus.withRuntime();
  const r = await converge(fakeContext({ incus: fake }), "profile", "p", PROFILE);
  assert.equal(r.outcome, "created");
  const [w] = writes(fake);
  assert.deepEqual(w.argv, ["--project", "agent-forge", "profile", "create", "p"]);
  assert.deepEqual(JSON.parse(w.input!), PROFILE);
});

test("an identical object is left alone: no write at all", async () => {
  const fake = FakeIncus.withRuntime();
  fake.addProfile("agent-forge", "p", PROFILE);
  assert.equal((await converge(fakeContext({ incus: fake }), "profile", "p", PROFILE)).outcome, "unchanged");
  assert.deepEqual(writes(fake), []);
});

test("one differing key gives one edit carrying the whole object", async () => {
  const fake = FakeIncus.withRuntime();
  fake.addProfile("agent-forge", "p", { ...PROFILE, config: { "limits.processes": "500" } });
  const r = await converge(fakeContext({ incus: fake }), "profile", "p", PROFILE);
  assert.equal(r.outcome, "updated");
  assert.equal(r.previous?.config?.["limits.processes"], "500");
  const w = writes(fake);
  assert.equal(w.length, 1);
  assert.deepEqual(w[0].argv.slice(-2), ["edit", "p"]);
  assert.deepEqual(JSON.parse(w[0].input!), PROFILE);
});

test("a key added by hand is removed", async () => {
  const fake = FakeIncus.withRuntime();
  fake.addProfile("agent-forge", "p", { ...PROFILE, config: { ...PROFILE.config, "security.privileged": "true" } });
  await converge(fakeContext({ incus: fake }), "profile", "p", PROFILE);
  assert.deepEqual(fake.profiles.get("agent-forge")!.get("p")!.config, PROFILE.config);
});

test("volatile keys are ignored when comparing, and carried over in an edit", async () => {
  const fake = FakeIncus.withRuntime();
  const bridge = { description: "b", config: { "ipv4.address": "10.77.0.1/24" } };
  fake.networks.set("br", {
    name: "br", type: "bridge", managed: true, description: "b",
    config: { ...bridge.config, "volatile.network.id": "7" },
  });
  const ctx = fakeContext({ incus: fake });
  assert.equal((await converge(ctx, "network", "br", bridge)).outcome, "unchanged");
  fake.networks.get("br")!.description = "drifted";
  assert.equal((await converge(ctx, "network", "br", bridge)).outcome, "updated");
  assert.equal(fake.networks.get("br")!.config["volatile.network.id"], "7");
});

test("ACL rules Incus lists with empty fields compare equal (second run unchanged)", async () => {
  const fake = FakeIncus.withRuntime();
  const acl = { description: "a", config: {}, ingress: [], egress: [{ action: "reject", state: "enabled", destination: "10.0.0.0/8" }] };
  const ctx = fakeContext({ incus: fake });
  assert.equal((await converge(ctx, "network acl", "a", acl)).outcome, "created");
  assert.equal((await converge(ctx, "network acl", "a", acl)).outcome, "unchanged");
});

test("unmanaged host interfaces in network list do not matter", async () => {
  const fake = FakeIncus.withRuntime();
  fake.hostInterfaces = ["lo", "eth0", "forgebr1"];
  const r = await converge(fakeContext({ incus: fake }), "network", "forgebr0", { description: "", config: {} });
  assert.equal(r.outcome, "created");
});

test("a failed write names the object and carries Incus' message", async () => {
  const ctx = fakeContext({
    rules: [{ match: "profile create", code: 1, stderr: "Error: Invalid value for raw.idmap\n" }],
    incus: FakeIncus.withRuntime(),
  });
  await assert.rejects(() => converge(ctx, "profile", "p", PROFILE), /create profile p failed: Error: Invalid value for raw\.idmap/);
});

test("key order does not matter", () => {
  assert.equal(differs({ description: "", config: { a: "1", b: "2" } }, { name: "x", description: "", config: { b: "2", a: "1" } }), false);
});

test("ensureProject creates a missing project with forge's features", async () => {
  const fake = new FakeIncus();
  const r = await ensureProject(fakeContext({ incus: fake }), "agent-forge", desiredProject());
  assert.equal(r.outcome, "created");
  assert.deepEqual(writes(fake)[0].argv, ["project", "create", "agent-forge"]);
  assert.equal(fake.projects.get("agent-forge")!.config["features.networks"], "false");
});

test("an existing project with forge's features is left alone, extra keys included", async () => {
  const fake = new FakeIncus();
  fake.addProject("agent-forge", { restricted: "true" });
  const r = await ensureProject(fakeContext({ incus: fake }), "agent-forge", desiredProject());
  assert.equal(r.outcome, "unchanged");
  assert.equal(r.config.restricted, "true");
  assert.deepEqual(writes(fake), []);
});

test("an existing project with wrong features is refused, never edited", async () => {
  const fake = new FakeIncus();
  fake.addProject("agent-forge", { "features.networks": "true", "features.images": "false" });
  await assert.rejects(() => ensureProject(fakeContext({ incus: fake }), "agent-forge", desiredProject()), (e: Error) => {
    assert.match(e.message, /features\.images=false \(forge needs true\)/);
    assert.match(e.message, /features\.networks=true \(forge needs false\)/);
    assert.match(e.message, /never edits/);
    return true;
  });
  assert.deepEqual(writes(fake), []);
});
