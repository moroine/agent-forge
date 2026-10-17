import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext, type ExecRule } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { fakeProc } from "./lib/fake-host.ts";
import { ansibleArgv, buildCommit, cmdImage } from "../cli/lib/commands/image.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// The build reads forge's config for the storage pool: never the developer's.
let xdg: string;
beforeEach(() => {
  xdg = mkdtempSync(join(tmpdir(), "forge-xdg-"));
  process.env.XDG_CONFIG_HOME = xdg;
});
afterEach(() => {
  rmSync(xdg, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.FORGE_INCUS_PROJECT;
});

// A release directory, with or without a COMMIT file.
function release(commit: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "forge-release-"));
  dirs.push(root);
  if (commit !== null) writeFileSync(join(root, "COMMIT"), `${commit}\n`);
  return root;
}

function build(opts: { fake?: FakeIncus; rules?: ExecRule[]; attachCode?: number; root?: string } = {}) {
  const fake = opts.fake ?? FakeIncus.withRuntime({ commit: "OLD" });
  const ctx = fakeContext({ incus: fake, rules: opts.rules, attachCode: opts.attachCode });
  const root = opts.root ?? release(SHA);
  return { fake, ctx, run: () => cmdImage(ctx, "build", undefined, { proc: fakeProc(), root }) };
}

const flat = (ctx: ReturnType<typeof fakeContext>) => ctx.calls.map((c) => c.join(" "));

test("the build runs its steps in the spec's order", async () => {
  const fake = FakeIncus.withRuntime({ commit: "OLD" });
  fake.publishReuseKeepsOld = true;
  const { ctx, run } = build({ fake });
  assert.equal(await run(), 0);
  const calls = flat(ctx);
  const at = (s: string) => {
    const i = calls.findIndex((l) => l.includes(s));
    assert.ok(i >= 0, `missing: ${s}\n${calls.join("\n")}`);
    return i;
  };
  const order = [
    at("launch images:ubuntu/26.04 forge-image-build --profile agent-forge"),
    at("exec forge-image-build -- systemctl is-system-running --wait"),
    at("ansible-playbook -i forge-image-build,"),
    at("stop forge-image-build"),
    at("publish forge-image-build --alias agent-base --reuse"),
    at(`image set-property agent-base user.forge.commit ${SHA}`),
    at("image delete fp1"),
    at("delete forge-image-build --force"),
  ];
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("the new image carries the alias and the commit; the old one and the instance are gone", async () => {
  const { fake, run } = build();
  const old = fake.findImage("agent-forge", "agent-base")!.fingerprint;
  await run();
  const images = fake.images.get("agent-forge")!;
  assert.equal(images.length, 1);
  assert.notEqual(images[0].fingerprint, old);
  assert.equal(images[0].properties["user.forge.commit"], SHA);
  assert.equal(fake.instances.get("agent-forge")!.has("forge-image-build"), false);
});

test("the old image is deleted only after the new one is published and stamped", async () => {
  const fake = FakeIncus.withRuntime({ commit: "OLD" });
  fake.publishReuseKeepsOld = true;
  const { ctx, run } = build({ fake });
  await run();
  const calls = flat(ctx);
  const deleted = calls.findIndex((l) => l.includes("image delete"));
  assert.ok(deleted > calls.findIndex((l) => l.includes(" publish ")));
  assert.ok(deleted > calls.findIndex((l) => l.includes("set-property")));
});

test("with Incus removing the old image on --reuse, no explicit delete is issued and the build succeeds", async () => {
  const { fake, ctx, run } = build();
  assert.equal(await run(), 0);
  const images = fake.images.get("agent-forge")!;
  assert.equal(images.length, 1);
  assert.equal(images[0].properties["user.forge.commit"], SHA);
  assert.ok(!flat(ctx).some((l) => l.includes("image delete")));
  assert.equal(fake.instances.get("agent-forge")!.has("forge-image-build"), false);
});

test("a first build deletes no image", async () => {
  const fake = new FakeIncus();
  fake.addProject("agent-forge");
  fake.addProfile("agent-forge", "agent-forge");
  const { ctx, run } = build({ fake });
  await run();
  assert.ok(!flat(ctx).some((l) => l.includes("image delete")));
  assert.ok(fake.findImage("agent-forge", "agent-base"));
});

test("a leftover build instance is removed before the launch", async () => {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "forge-image-build", { status: "Running" });
  const { ctx, run } = build({ fake });
  await run();
  const calls = flat(ctx);
  const removed = calls.findIndex((l) => l.includes("delete forge-image-build"));
  assert.ok(removed >= 0 && removed < calls.findIndex((l) => l.includes(" launch ")), calls.join("\n"));
});

test("ansible-playbook gets the instance, the incus connection and the repo's playbook", () => {
  assert.deepEqual(ansibleArgv("agent-forge", "/opt/agent-forge/releases/abc"), [
    "ansible-playbook",
    "-i", "forge-image-build,",
    "-e", "ansible_connection=community.general.incus",
    "-e", "ansible_incus_project=agent-forge",
    "-e", "ansible_pipelining=true",
    "/opt/agent-forge/releases/abc/ansible/image.yml",
  ]);
});

test("the build follows FORGE_INCUS_PROJECT, Ansible included", async () => {
  process.env.FORGE_INCUS_PROJECT = "forge-selftest";
  const { ctx, run } = build({ fake: FakeIncus.withRuntime({ project: "forge-selftest" }) });
  await run();
  assert.ok(ctx.calls.some((c) => c[0] === "ansible-playbook" && c.includes("ansible_incus_project=forge-selftest")));
  assert.ok(flat(ctx).some((l) => l.startsWith("incus --project forge-selftest launch")));
});

test("COMMIT is read first, and git is not asked", async () => {
  const ctx = fakeContext({ rules: [{ match: "rev-parse HEAD", stdout: `${"f".repeat(40)}\n` }] });
  assert.equal(await buildCommit(ctx, release(SHA)), SHA);
  assert.ok(!ctx.calls.some((c) => c.includes("rev-parse")));
});

test("without COMMIT, the checkout's HEAD", async () => {
  const root = release(null);
  const ctx = fakeContext({ rules: [{ match: "rev-parse HEAD", stdout: `${SHA}\n` }] });
  assert.equal(await buildCommit(ctx, root), SHA);
  assert.deepEqual(ctx.calls[0], ["git", "-C", root, "rev-parse", "HEAD"]);
});

test("with neither, the build fails before launching anything", async () => {
  const { fake, run } = build({
    root: release(null),
    rules: [{ match: "rev-parse HEAD", code: 128, stderr: "fatal: not a git repository\n" }],
  });
  await assert.rejects(run, /cannot tell which commit[\s\S]*not a git repository/);
  assert.ok(!fake.calls.some((c) => c.argv.includes("launch")));
});

test("a failed playbook keeps the build instance and the old image", async () => {
  const { fake, run } = build({ attachCode: 2 });
  const old = fake.findImage("agent-forge", "agent-base")!.fingerprint;
  await assert.rejects(run, /ansible-playbook failed \(exit code 2\)[\s\S]*forge-image-build is left/);
  assert.equal(fake.findImage("agent-forge", "agent-base")!.fingerprint, old);
  assert.ok(fake.instances.get("agent-forge")!.has("forge-image-build"));
  assert.ok(!fake.calls.some((c) => c.argv.includes("publish")));
});

test("without forge setup, the build names it and creates nothing", async () => {
  const fake = new FakeIncus();
  await assert.rejects(build({ fake }).run, /Run 'forge setup' first/);
  assert.ok(!fake.calls.some((c) => c.argv.includes("launch")));
});

test("without the incus connection plugin, the build says how to get it", async () => {
  const { fake, run } = build({ rules: [{ match: "ansible-doc -t connection community.general.incus", code: 1 }] });
  await assert.rejects(run, /community\.general\.incus/);
  assert.ok(!fake.calls.some((c) => c.argv.includes("launch")));
});

test("without ansible-playbook, the build says so", async () => {
  await assert.rejects(build({ rules: [{ match: "ansible-playbook --version", code: 127 }] }).run, /ansible-playbook not found/);
});

test("a degraded instance counts as ready", async () => {
  const { run } = build({ rules: [{ match: "is-system-running", code: 1, stdout: "degraded\n" }] });
  assert.equal(await run(), 0);
});

test("an instance that did not boot stops the build and is kept", async () => {
  const { run } = build({ rules: [{ match: "is-system-running", code: 1, stdout: "maintenance\n" }] });
  await assert.rejects(run, /did not finish booting \(systemd state: maintenance\).*forge-image-build is left for debugging.*the next build removes it/);
});

test("forge image takes build and nothing else", async () => {
  await assert.rejects(() => cmdImage(fakeContext(), "update"), /Usage: forge image build$/);
  await assert.rejects(() => cmdImage(fakeContext(), "build", "super"), /Usage: forge image build$/);
  await assert.rejects(() => cmdImage(fakeContext(), undefined), /Usage: forge image build$/);
});
