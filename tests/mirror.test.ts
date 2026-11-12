import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import {
  cloneWorkspace, ensureMirror, hasOriginDevice, mirrorRepo, pointOriginAtMirror, refreshMirror,
} from "../cli/lib/mirror.ts";

let dir: string;
let mirror: string;
const saved = process.env.FORGE_MIRRORS;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "forge-mirror-"));
  process.env.FORGE_MIRRORS = join(dir, "mirrors");
  mirror = join(dir, "mirrors", "agent-x.git");
});

after(() => {
  if (saved === undefined) delete process.env.FORGE_MIRRORS;
  else process.env.FORGE_MIRRORS = saved;
  rmSync(dir, { recursive: true, force: true });
});

const NOPROMPT = { GIT_TERMINAL_PROMPT: "0" };

test("ensureMirror creates a bare clone over SSH only", async () => {
  rmSync(join(dir, "mirrors"), { recursive: true, force: true });
  const ctx = fakeContext();
  const r = await ensureMirror(ctx, mirror, "o/r");
  assert.equal(r, "created");
  assert.deepEqual(ctx.calls, [[
    "git", "-c", "protocol.allow=never", "-c", "protocol.ssh.allow=always",
    "clone", "--bare", "git@github.com:o/r.git", mirror,
  ]]);
  assert.deepEqual(ctx.execOptions[0]?.env, NOPROMPT);
  assert.ok(existsSync(join(dir, "mirrors")));
});

test("an existing mirror of the same repo is kept", async () => {
  mkdirSync(mirror, { recursive: true });
  const ctx = fakeContext({ rules: [{ match: "--get remote.origin.url", stdout: "git@github.com:O/R.git\n" }] });
  assert.equal(await ensureMirror(ctx, mirror, "o/r"), "kept");
  assert.ok(!ctx.calls.some((c) => c.includes("clone")));
});

test("a mirror of another repo is refused", async () => {
  mkdirSync(mirror, { recursive: true });
  const ctx = fakeContext({ rules: [{ match: "--get remote.origin.url", stdout: "git@github.com:a/b.git\n" }] });
  await assert.rejects(ensureMirror(ctx, mirror, "o/r"), /mirror of a\/b/);
  assert.ok(!ctx.calls.some((c) => c.includes("clone")));
});

test("an invalid repo never reaches git", async () => {
  const ctx = fakeContext();
  await assert.rejects(ensureMirror(ctx, mirror, "o/r;id"), /repo must be/);
  assert.deepEqual(ctx.calls, []);
});

test("a failing clone surfaces git's stderr and names the forwarded agent", async () => {
  rmSync(join(dir, "mirrors"), { recursive: true, force: true });
  const ctx = fakeContext({ rules: [{ match: "clone --bare", code: 128, stderr: "Permission denied (publickey)" }] });
  const err = await ensureMirror(ctx, mirror, "o/r").then(() => null, (e: Error) => e);
  assert.match(err?.message ?? "", /create mirror failed: Permission denied/);
  assert.match(err?.message ?? "", /forge team up/);
});

test("refreshMirror fetches heads and tags with the URL on the command line", async () => {
  const ctx = fakeContext();
  const r = await refreshMirror(ctx, mirror, "o/r");
  assert.equal(r.code, 0);
  assert.deepEqual(ctx.calls, [[
    "git", `--git-dir=${mirror}`, "-c", "protocol.allow=never", "-c", "protocol.ssh.allow=always",
    "fetch", "--prune", "--no-recurse-submodules", "git@github.com:o/r.git",
    "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*",
  ]]);
  assert.deepEqual(ctx.execOptions[0]?.env, NOPROMPT);
});

// Defense in depth: forge started from inside ~/workspaces/<c> must not let
// host git discover the agent's repository there.
test("every host git call on the mirror runs from /, whatever forge's own cwd", async () => {
  rmSync(join(dir, "mirrors"), { recursive: true, force: true });
  const ctx = fakeContext({ rules: [{ match: "--get remote.origin.url", stdout: "git@github.com:o/r.git\n" }] });
  await ensureMirror(ctx, mirror, "o/r");
  mkdirSync(mirror, { recursive: true });
  await mirrorRepo(ctx, mirror);
  await refreshMirror(ctx, mirror, "o/r");
  assert.equal(ctx.calls.length, 3);
  assert.deepEqual(ctx.execOptions.map((o) => o?.cwd), ["/", "/", "/"]);
});

test("refreshMirror rejects an invalid repo before git, as a promise", async () => {
  const ctx = fakeContext();
  await assert.rejects(() => refreshMirror(ctx, mirror, "o/r;id"), /repo must be/);
  const pending = (() => { try { return refreshMirror(ctx, mirror, "o/r;id"); } catch { return null; } })();
  assert.ok(pending instanceof Promise, "refreshMirror threw synchronously");
  await pending.catch(() => {});
  assert.deepEqual(ctx.calls, []);
});

test("mirrorRepo returns null without exec when there is no mirror", async () => {
  const ctx = fakeContext();
  assert.equal(await mirrorRepo(ctx, join(dir, "absent.git")), null);
  assert.deepEqual(ctx.calls, []);
});

test("mirrorRepo returns null when git cannot read the mirror", async () => {
  mkdirSync(mirror, { recursive: true });
  const ctx = fakeContext({ rules: [{ match: "--get remote.origin.url", code: 1 }] });
  assert.equal(await mirrorRepo(ctx, mirror), null);
});

test("an unreadable mirror is refused as a mirror of an unknown repository", async () => {
  mkdirSync(mirror, { recursive: true });
  const ctx = fakeContext({ rules: [{ match: "--get remote.origin.url", code: 128, stderr: "fatal: not a git repository" }] });
  await assert.rejects(ensureMirror(ctx, mirror, "o/r"), /is a mirror of an unknown repository, not o\/r/);
  assert.ok(!ctx.calls.some((c) => c.includes("clone")));
});

test("cloneWorkspace runs in the container as aiuser", async () => {
  const ctx = fakeContext();
  await cloneWorkspace(ctx, "agent-x");
  assert.deepEqual(ctx.calls, [[
    "incus", "--project", "agent-forge", "exec", "agent-x", "--user", "1001", "--group", "1001",
    "--env", "HOME=/home/aiuser", "--", "env", "GIT_LFS_SKIP_SMUDGE=1",
    "git", "clone", "--no-local", "/forge/origin.git", "/workspace",
  ]]);
});

test("pointOriginAtMirror ends with the set-url command", async () => {
  const ctx = fakeContext();
  await pointOriginAtMirror(ctx, "agent-x");
  assert.deepEqual(ctx.calls[0].slice(-8),
    ["--", "git", "-C", "/workspace", "remote", "set-url", "origin", "/forge/origin.git"]);
});

test("hasOriginDevice", async () => {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-x", { devices: { origin: { type: "disk" }, workspace: { type: "disk" } } });
  fake.addInstance("agent-forge", "agent-y", { devices: { workspace: { type: "disk" } } });
  assert.equal(await hasOriginDevice(fakeContext({ incus: fake }), "agent-x"), true);
  assert.equal(await hasOriginDevice(fakeContext({ incus: fake }), "agent-y"), false);
  assert.equal(await hasOriginDevice(fakeContext({ rules: [{ match: "device list", code: 1 }] }), "agent-x"), false);
});
