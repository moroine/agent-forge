import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { resolveRepo, resolveTask } from "../cli/lib/commands/resolve.ts";

const LIST = JSON.stringify([
  { name: "agent-moroine-agent-forge", status: "Running" },
  { name: "agent-acme-widgets", status: "Running" },
]);
const RULES = [
  { match: "agent-moroine-agent-forge user.forge.repo", stdout: "moroine/agent-forge" },
  { match: "agent-acme-widgets user.forge.repo", stdout: "acme/widgets" },
  { match: "incus --project agent-forge list", stdout: LIST },
  { match: "git worktree list", stdout: "worktree /workspace\nworktree /workspace/.trees/cli\nworktree /workspace/.trees/docs\n" },
];

test("a provided repo is returned untouched, with no prompt", async () => {
  const c = fakeContext({ rules: RULES });
  assert.equal(await resolveRepo(c, "given/repo", "usage"), "given/repo");
  assert.equal(c.err_lines.length, 0);
});

test("a missing repo is picked from the managed repos", async () => {
  const c = fakeContext({ rules: RULES, answers: [2] });
  assert.equal(await resolveRepo(c, undefined, "usage"), "acme/widgets");
});

test("resolveRepo throws the usage when it cannot ask", async () => {
  const c = fakeContext({ rules: RULES, tty: false });
  await assert.rejects(() => resolveRepo(c, undefined, "Usage: forge stop <owner/repo>"), /Usage: forge stop/);
});

test("resolveRepo explains when no container exists at all", async () => {
  const c = fakeContext({ rules: [{ match: "incus --project agent-forge list", stdout: "[]" }] });
  await assert.rejects(() => resolveRepo(c, undefined, "usage"), /no forge container yet/);
});

test("a missing task is picked from the existing worktrees", async () => {
  const c = fakeContext({ rules: RULES, answers: [1] });
  assert.equal(await resolveTask(c, "agent-moroine-agent-forge", undefined, "usage"), "cli");
});

test("resolveTask refuses on a stopped container with a clear reason", async () => {
  const c = fakeContext({
    rules: [{ match: "incus --project agent-forge list", stdout: JSON.stringify([{ name: "agent-x", status: "Stopped" }]) }],
  });
  await assert.rejects(() => resolveTask(c, "agent-x", undefined, "usage"), /stopped/);
});

test("resolveTask explains when the container has no worktree", async () => {
  const c = fakeContext({
    rules: [
      { match: "incus --project agent-forge list", stdout: JSON.stringify([{ name: "agent-x", status: "Running" }]) },
      { match: "git worktree list", stdout: "worktree /workspace\n" },
    ],
  });
  await assert.rejects(() => resolveTask(c, "agent-x", undefined, "usage"), /no task worktree/);
});
