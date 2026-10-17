import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { cmdResume } from "../cli/lib/commands/resume.ts";
import { cmdFinish } from "../cli/lib/commands/finish.ts";

const BASE = [
  { match: "agent-moroine-agent-forge user.forge.repo", stdout: "moroine/agent-forge" },
  { match: "lxc list", stdout: JSON.stringify([{ name: "agent-moroine-agent-forge", status: "Running" }]) },
  { match: "git worktree list", stdout: "worktree /workspace\nworktree /workspace/.trees/cli\nworktree /workspace/.trees/docs\n" },
];

test("resume attaches the task's tmux session", async () => {
  const c = fakeContext({ rules: [...BASE, { match: "test -e", code: 0 }] });
  assert.equal(await cmdResume(c, "moroine/agent-forge", "cli"), 0);
  const attach = c.calls.find((call) => call.includes("tmux"));
  assert.ok(attach, "no attach happened");
  assert.ok(attach.includes("new-session") && attach.includes("cli"));
});

test("resume never creates a worktree", async () => {
  const c = fakeContext({ rules: [...BASE, { match: "test -e", code: 0 }] });
  await cmdResume(c, "moroine/agent-forge", "cli");
  assert.ok(!c.calls.some((call) => call.join(" ").includes("worktree add")));
});

test("resume errors when the worktree is absent, pointing at start", async () => {
  const c = fakeContext({ rules: [...BASE, { match: "test -e", code: 1 }] });
  await assert.rejects(() => cmdResume(c, "moroine/agent-forge", "nope"), /forge start/);
});

test("resume asks for repo then task when both are missing", async () => {
  const c = fakeContext({ rules: [...BASE, { match: "test -e", code: 0 }], answers: [1, 2] });
  await cmdResume(c, undefined, undefined);
  const attach = c.calls.find((call) => call.includes("tmux"));
  assert.ok(attach?.includes("docs"), `attached to the wrong session: ${attach?.join(" ")}`);
});

test("finish removes the worktree after the pre-flight", async () => {
  const c = fakeContext({
    rules: [
      ...BASE,
      { match: "test -e", code: 0 },
      { match: "status --porcelain", stdout: "" },
      { match: "user.forge.mode", stdout: "supervised" },
    ],
  });
  assert.equal(await cmdFinish(c, "moroine/agent-forge", "cli", false), 0);
  assert.ok(c.calls.some((call) => call.join(" ").includes("worktree remove .trees/cli")));
});

test("finish --force skips the pre-flight and forces the removal", async () => {
  const c = fakeContext({
    rules: [...BASE, { match: "test -e", code: 0 }, { match: "status --porcelain", stdout: " M x\n" }],
  });
  assert.equal(await cmdFinish(c, "moroine/agent-forge", "cli", true), 0);
  assert.ok(c.calls.some((call) => call.join(" ").includes("worktree remove --force .trees/cli")));
});

test("finish keeps the branch and kills the session", async () => {
  const c = fakeContext({
    rules: [...BASE, { match: "test -e", code: 0 }, { match: "status --porcelain", stdout: "" }, { match: "user.forge.mode", stdout: "supervised" }],
  });
  await cmdFinish(c, "moroine/agent-forge", "cli", false);
  assert.ok(!c.calls.some((call) => call.join(" ").includes("branch -D")));
  assert.ok(c.calls.some((call) => call.join(" ").includes("kill-session -t cli")));
  assert.ok(c.out_lines.some((l) => l.includes("branch agent/cli retained")));
});

// Fail-fast : sans mustSucceed, `git worktree remove` pouvait échouer et
// finish annonçait quand même « Finished task cli » en rendant 0.
test("finish fails when the worktree removal fails, and claims nothing", async () => {
  const c = fakeContext({
    rules: [
      { match: "worktree remove", code: 1, stderr: "fatal: '.trees/cli' contains modified files\n" },
      ...BASE,
      { match: "test -e", code: 0 },
      { match: "status --porcelain", stdout: "" },
      { match: "user.forge.mode", stdout: "supervised" },
    ],
  });
  await assert.rejects(
    () => cmdFinish(c, "moroine/agent-forge", "cli", false),
    /git worktree remove failed: fatal: '\.trees\/cli' contains modified files/,
  );
  assert.ok(
    !c.out_lines.some((l) => l.includes("Finished task")),
    `success announced despite the failure: ${c.out_lines.join(" | ")}`,
  );
});

test("resume fails when the container refuses to start", async () => {
  const c = fakeContext({
    rules: [
      { match: "lxc start", code: 1, stderr: "Error: Failed to start device\n" },
      { match: "agent-moroine-agent-forge user.forge.repo", stdout: "moroine/agent-forge" },
      { match: "lxc list", stdout: JSON.stringify([{ name: "agent-moroine-agent-forge", status: "Stopped" }]) },
      { match: "test -e", code: 0 },
    ],
  });
  await assert.rejects(
    () => cmdResume(c, "moroine/agent-forge", "cli"),
    /lxc start failed: Error: Failed to start device/,
  );
  assert.ok(!c.calls.some((call) => call.includes("tmux")), "attaché malgré l'échec du démarrage");
});
