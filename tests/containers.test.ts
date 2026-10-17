import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { ForgeError } from "../cli/lib/context.ts";
import {
  listForgeContainers, forgeRepos, containerForRepo, requireContainerForRepo,
  checkNameCollision, isRunning, buildStatus, baseImageFor, latestImageCommitFor,
} from "../cli/lib/containers.ts";

const LIST = JSON.stringify([
  { name: "agent-moroine-agent-forge", status: "Running" },
  { name: "agent-acme-widgets", status: "Stopped" },
  { name: "unrelated-container", status: "Running" },
]);

function ctxWith(repos: Record<string, string>) {
  return fakeContext({
    rules: [
      { match: "incus --project agent-forge list", stdout: LIST },
      ...Object.entries(repos).map(([name, repo]) => ({
        match: `config get ${name} user.forge.repo`,
        stdout: repo,
      })),
    ],
  });
}

test("listForgeContainers keeps only agent-* names", async () => {
  const ctx = fakeContext({ rules: [{ match: "incus --project agent-forge list", stdout: LIST }] });
  assert.deepEqual(await listForgeContainers(ctx), [
    "agent-moroine-agent-forge",
    "agent-acme-widgets",
  ]);
});

test("forgeRepos reads config keys only, never incus exec", async () => {
  const ctx = ctxWith({
    "agent-moroine-agent-forge": "moroine/agent-forge",
    "agent-acme-widgets": "acme/widgets",
  });
  assert.deepEqual(await forgeRepos(ctx), ["moroine/agent-forge", "acme/widgets"]);
  assert.ok(!ctx.calls.some((c) => c[1] === "exec"), "un TAB doit rester rapide");
});

test("forgeRepos skips a container with no repo metadata", async () => {
  const ctx = ctxWith({ "agent-moroine-agent-forge": "moroine/agent-forge" });
  assert.deepEqual(await forgeRepos(ctx), ["moroine/agent-forge"]);
});

test("containerForRepo matches case-insensitively", async () => {
  const ctx = ctxWith({ "agent-moroine-agent-forge": "moroine/agent-forge" });
  assert.equal(await containerForRepo(ctx, "Moroine/Agent-Forge"), "agent-moroine-agent-forge");
});

test("requireContainerForRepo throws a ForgeError naming the repo", async () => {
  const ctx = ctxWith({});
  await assert.rejects(() => requireContainerForRepo(ctx, "nobody/nothing"), ForgeError);
  await assert.rejects(() => requireContainerForRepo(ctx, "nobody/nothing"), /nobody\/nothing/);
});

test("checkNameCollision refuses a container with no forge metadata", async () => {
  const ctx = fakeContext({
    rules: [{ match: "incus --project agent-forge info", code: 0 }, { match: "config get", stdout: "" }],
  });
  await assert.rejects(() => checkNameCollision(ctx, "agent-x", "o/r"), /no user.forge.repo metadata/);
});

test("checkNameCollision refuses a container belonging to another repo", async () => {
  const ctx = fakeContext({
    rules: [{ match: "incus --project agent-forge info", code: 0 }, { match: "config get", stdout: "other/repo" }],
  });
  await assert.rejects(() => checkNameCollision(ctx, "agent-x", "o/r"), /different repo/);
});

test("checkNameCollision accepts a not-yet-existing container", async () => {
  const ctx = fakeContext({ rules: [{ match: "incus --project agent-forge info", code: 1 }] });
  await checkNameCollision(ctx, "agent-x", "o/r");
});

test("isRunning is true only for Running", async () => {
  const ctx = fakeContext({ rules: [{ match: "incus --project agent-forge list", stdout: LIST }] });
  assert.equal(await isRunning(ctx, "agent-moroine-agent-forge"), true);
  assert.equal(await isRunning(ctx, "agent-acme-widgets"), false);
  assert.equal(await isRunning(ctx, "absent"), false);
});

test("buildStatus compares the two stamps", () => {
  assert.equal(buildStatus("aaa", "aaa"), "up-to-date");
  assert.equal(buildStatus("aaa", "bbb"), "behind");
  assert.equal(buildStatus("", "bbb"), "unknown");
  assert.equal(buildStatus("aaa", ""), "unknown");
});

test("baseImageFor maps super to agent-base-super, everything else to agent-base", () => {
  assert.equal(baseImageFor("super"), "agent-base-super");
  assert.equal(baseImageFor("autonomous"), "agent-base");
  assert.equal(baseImageFor("supervised"), "agent-base");
  assert.equal(baseImageFor(""), "agent-base");
});

test("latestImageCommitFor reads the commit of the mode's base image", async () => {
  const ctx = fakeContext({
    rules: [
      { match: "image get-property agent-base-super", stdout: "SUPERSHA\n" },
      { match: "image get-property agent-base", stdout: "BASESHA\n" },
    ],
  });
  assert.equal(await latestImageCommitFor(ctx, "super"), "SUPERSHA");
  assert.equal(await latestImageCommitFor(ctx, "autonomous"), "BASESHA");
});
