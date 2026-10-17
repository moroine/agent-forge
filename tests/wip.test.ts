import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { checkWorktree } from "../cli/lib/wip.ts";

const clean = { match: "status --porcelain", stdout: "" };
const onBranch = { match: "rev-parse --abbrev-ref HEAD", stdout: "agent/cli\n" };

test("a dirty tree is refused, and the diff is shown", async () => {
  const ctx = fakeContext({
    rules: [{ match: "status --porcelain", stdout: " M scripts/forge\n" }],
  });
  await assert.rejects(
    () => checkWorktree(ctx, "agent-x", "/workspace/.trees/cli"),
    /uncommitted changes[\s\S]*scripts\/forge/,
  );
});

test("a supervised container is only checked for dirtiness", async () => {
  const ctx = fakeContext({
    rules: [clean, { match: "user.forge.mode", stdout: "supervised" }],
  });
  await checkWorktree(ctx, "agent-x", "/workspace/.trees/cli");
  assert.ok(!ctx.calls.some((c) => c.join(" ").includes("origin/main..")));
});

test("an unexpected branch name is refused", async () => {
  const ctx = fakeContext({
    rules: [
      clean,
      { match: "user.forge.mode", stdout: "autonomous" },
      { match: "rev-parse --abbrev-ref HEAD", stdout: "main\n" },
    ],
  });
  await assert.rejects(() => checkWorktree(ctx, "agent-x", "/workspace/.trees/cli"), /unexpected branch name/);
});

test("commits ahead of main with no origin branch are refused", async () => {
  const ctx = fakeContext({
    rules: [
      clean,
      { match: "user.forge.mode", stdout: "autonomous" },
      onBranch,
      { match: "origin/main..", stdout: "abc feat: x\n" },
      { match: "rev-parse --verify origin/", code: 1 },
    ],
  });
  await assert.rejects(() => checkWorktree(ctx, "agent-x", "/workspace/.trees/cli"), /never been pushed/);
});

test("unpushed commits are refused and listed", async () => {
  const ctx = fakeContext({
    rules: [
      clean,
      { match: "user.forge.mode", stdout: "autonomous" },
      onBranch,
      { match: "origin/main..", stdout: "abc feat: x\n" },
      { match: "rev-parse --verify origin/", code: 0 },
      { match: "origin/agent/cli..", stdout: "abc feat: x\n" },
    ],
  });
  await assert.rejects(() => checkWorktree(ctx, "agent-x", "/workspace/.trees/cli"), /unpushed commits[\s\S]*feat: x/);
});

test("a clean worktree with nothing ahead of main passes without probing origin", async () => {
  const ctx = fakeContext({
    rules: [
      clean,
      { match: "user.forge.mode", stdout: "autonomous" },
      onBranch,
      { match: "origin/main..", stdout: "" },
    ],
  });
  await checkWorktree(ctx, "agent-x", "/workspace/.trees/cli");
  assert.ok(!ctx.calls.some((c) => c.join(" ").includes("rev-parse --verify origin/")));
});

// Le cas qui compte vraiment, et que le test ci-dessus ne couvre pas : en
// avance sur main ET entièrement poussé — à quoi ressemble un agent qui a
// fini son travail. Le court-circuit sur `origin/main..` vide n'atteint
// jamais les deux sondes qui suivent ; ici elles sont toutes deux exercées.
test("a branch ahead of main but fully pushed passes, both origin probes exercised", async () => {
  const ctx = fakeContext({
    rules: [
      clean,
      { match: "user.forge.mode", stdout: "autonomous" },
      onBranch,
      { match: "origin/main..", stdout: "abc feat: x\ndef fix: y\n" },
      { match: "rev-parse --verify origin/", code: 0, stdout: "0123456789abcdef\n" },
      { match: "origin/agent/cli..", stdout: "" },
    ],
  });
  await checkWorktree(ctx, "agent-x", "/workspace/.trees/cli");
  const flat = ctx.calls.map((c) => c.join(" "));
  assert.ok(flat.some((l) => l.includes("rev-parse --verify origin/agent/cli")), flat.join("\n"));
  assert.ok(flat.some((l) => l.includes("origin/agent/cli..agent/cli")), flat.join("\n"));
});
