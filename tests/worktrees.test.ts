import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import {
  parseWorktreeDirs, parseAgentBranches, parseRunningTasks,
  taskNames, branchExists, runningTasks, worktreeAbsPath,
} from "../cli/lib/worktrees.ts";

test("parseWorktreeDirs drops the main clone and keeps the features", () => {
  const porcelain = [
    "worktree /workspace",
    "HEAD abc",
    "branch refs/heads/main",
    "",
    "worktree /workspace/.trees/cli",
    "HEAD def",
    "branch refs/heads/agent/cli",
    "",
  ].join("\n");
  assert.deepEqual(parseWorktreeDirs(porcelain), ["/workspace/.trees/cli"]);
});

test("parseWorktreeDirs drops a basename outside the charset, without failing", () => {
  const porcelain = [
    "worktree /workspace/.trees/ok",
    "worktree /workspace/.trees/bad;name",
    "worktree /workspace/.trees/also-ok",
  ].join("\n");
  // Défense en profondeur : ces basenames repartent dans un `su -c`. Une
  // entrée hostile est filtrée, elle n'interrompt pas le reste.
  assert.deepEqual(parseWorktreeDirs(porcelain), [
    "/workspace/.trees/ok",
    "/workspace/.trees/also-ok",
  ]);
});

test("parseAgentBranches strips both agent/ and origin/agent/", () => {
  assert.deepEqual(parseAgentBranches("agent/cli\nagent/docs\n"), ["cli", "docs"]);
  assert.deepEqual(parseAgentBranches("origin/agent/api\n"), ["api"]);
});

test("parseRunningTasks finds the tasks of this container's agents", () => {
  const ps = [
    "claude --permission-mode auto --remote-control agent-x-cli",
    "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --remote-control agent-x-docs --continue",
    "bash",
  ].join("\n");
  assert.deepEqual([...parseRunningTasks(ps, "agent-x")].sort(), ["cli", "docs"]);
});

test("parseRunningTasks ignores another container, an unsafe name and an empty name", () => {
  assert.equal(parseRunningTasks("claude --remote-control agent-y-cli", "agent-x").size, 0);
  assert.equal(parseRunningTasks("claude --remote-control agent-x-a;rm", "agent-x").size, 0);
  assert.equal(parseRunningTasks("claude --remote-control agent-x-", "agent-x").size, 0);
  assert.equal(parseRunningTasks("", "agent-x").size, 0);
});

test("parseRunningTasks only returns names of the safe charset", () => {
  const found = parseRunningTasks("claude --remote-control agent-x-fix.v2_1 --continue", "agent-x");
  assert.deepEqual([...found], ["fix.v2_1"]);
  for (const t of found) assert.match(t, /^[A-Za-z0-9._-]+$/);
});

test("taskNames returns the basenames of the feature worktrees", async () => {
  const ctx = fakeContext({
    rules: [{ match: "git worktree list", stdout: "worktree /workspace\nworktree /workspace/.trees/cli\n" }],
  });
  assert.deepEqual(await taskNames(ctx, "agent-x"), ["cli"]);
});

test("branchExists uses show-ref's exit code as the answer", async () => {
  const yes = fakeContext({ rules: [{ match: "show-ref", code: 0 }] });
  const no = fakeContext({ rules: [{ match: "show-ref", code: 1 }] });
  assert.equal(await branchExists(yes, "agent-x", "refs/heads/agent/cli"), true);
  assert.equal(await branchExists(no, "agent-x", "refs/heads/agent/cli"), false);
});

test("runningTasks probes the agent's processes and survives ps failing", async () => {
  const ok = fakeContext({
    rules: [{ match: "ps -u 1001 -o args=", stdout: "claude --remote-control agent-x-cli\n" }],
  });
  assert.deepEqual([...await runningTasks(ok, "agent-x")], ["cli"]);
  const bad = fakeContext({ rules: [{ match: "ps -u 1001", code: 1, stderr: "boom" }] });
  assert.equal((await runningTasks(bad, "agent-x")).size, 0);
});

test("worktreeAbsPath is the session's cwd", () => {
  assert.equal(worktreeAbsPath("cli"), "/workspace/.trees/cli");
});
