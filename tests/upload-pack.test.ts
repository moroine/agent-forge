import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { assertNoHostGitIn } from "./lib/host-git.ts";
import { cmdUploadPack } from "../cli/lib/commands/upload-pack.ts";
import { uploadPackArgv } from "../cli/lib/incus.ts";
import { workspacesDir } from "../cli/lib/paths.ts";

const P = ["incus", "--project", "agent-forge"];
const BASE_ARGV = [
  ...P, "exec", "agent-x", "--force-noninteractive",
  "--user", "1001", "--group", "1001", "--cwd", "/workspace",
  "--env", "HOME=/home/aiuser",
];

const rules = (status: string, repo = "o/r") => [
  { match: "agent-x user.forge.repo", stdout: repo },
  { match: "incus --project agent-forge list", stdout: JSON.stringify([{ name: "agent-x", status }]) },
];

test("argv runs git-upload-pack in the container as aiuser", () => {
  assert.deepEqual(uploadPackArgv("agent-x", undefined), [...BASE_ARGV, "--", "git-upload-pack", "/workspace"]);
});

test("GIT_PROTOCOL=version=2 adds --env GIT_PROTOCOL=version=2 before --", () => {
  assert.deepEqual(uploadPackArgv("agent-x", "version=2"), [
    ...BASE_ARGV, "--env", "GIT_PROTOCOL=version=2", "--", "git-upload-pack", "/workspace",
  ]);
});

test("version=2:x and x are dropped", () => {
  for (const v of ["version=2:x", "x", "", "version=12", "version=2\nfoo"]) {
    assert.deepEqual(uploadPackArgv("agent-x", v), [...BASE_ARGV, "--", "git-upload-pack", "/workspace"], v);
  }
});

test("a stopped container is started, and nothing goes to stdout", async () => {
  const c = fakeContext({ rules: rules("Stopped") });
  assert.equal(await cmdUploadPack(c, "agent-x", undefined), 0);
  const start = c.calls.findIndex((a) => a.join(" ") === [...P, "start", "agent-x"].join(" "));
  const attach = c.calls.findIndex((a) => a.includes("git-upload-pack"));
  assert.ok(start >= 0 && attach > start, "incus start must precede the attach");
  assert.deepEqual(c.out_lines, []);
});

test("a running container is not started", async () => {
  const c = fakeContext({ rules: rules("Running") });
  await cmdUploadPack(c, "agent-x", undefined);
  assert.ok(!c.calls.some((a) => a.includes("start")));
});

test("a container without user.forge.repo is refused", async () => {
  const c = fakeContext({ rules: rules("Running", "") });
  await assert.rejects(() => cmdUploadPack(c, "agent-x", undefined), /not a forge container/);
  assert.ok(!c.calls.some((a) => a.includes("git-upload-pack")));
});

test("an invalid container name is refused before any call", async () => {
  const c = fakeContext({ rules: rules("Running") });
  await assert.rejects(() => cmdUploadPack(c, "agent-x;id", undefined), /container must be/);
  assert.deepEqual(c.calls, []);
});

test("a missing container name is refused before any call", async () => {
  const c = fakeContext();
  await assert.rejects(() => cmdUploadPack(c, undefined, undefined), /container must be/);
  assert.deepEqual(c.calls, []);
});

test("the exit code of upload-pack is returned", async () => {
  const c = fakeContext({ rules: rules("Running"), attachCode: 5 });
  assert.equal(await cmdUploadPack(c, "agent-x", undefined), 5);
});

test("no host git runs", async () => {
  const c = fakeContext({ rules: rules("Stopped") });
  await cmdUploadPack(c, "agent-x", "version=2");
  assertNoHostGitIn(c.calls, workspacesDir());
  assert.ok(!c.calls.some((a) => a[0] === "git"));
});
