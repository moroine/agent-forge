import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import {
  parseWorktreeDirs, parseAgentBranches, parseSessionStates,
  taskNames, branchExists, sessionStates, worktreeAbsPath,
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

test("parseSessionStates maps the attached flag", () => {
  const m = parseSessionStates("cli 1\ndocs 0\n");
  assert.equal(m.get("cli"), true);
  assert.equal(m.get("docs"), false);
  assert.equal(m.has("api"), false);
});

test("parseSessionStates returns an empty map when no server is running", () => {
  assert.equal(parseSessionStates("").size, 0);
  assert.equal(parseSessionStates("no server running on /tmp/tmux-1001/default").size, 0);
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

test("sessionStates survives tmux exiting non-zero", async () => {
  const ctx = fakeContext({
    rules: [{ match: "list-sessions", code: 1, stderr: "no server running" }],
  });
  assert.equal((await sessionStates(ctx, "agent-x")).size, 0);
});

test("worktreeAbsPath is the session's cwd", () => {
  assert.equal(worktreeAbsPath("cli"), "/workspace/.trees/cli");
});
