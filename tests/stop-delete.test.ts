import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { cmdStop } from "../cli/lib/commands/stop.ts";
import { cmdDelete } from "../cli/lib/commands/delete.ts";
import { join } from "node:path";
import { mirrorPath, workspacesDir } from "../cli/lib/paths.ts";

const RULES = [
  { match: "agent-moroine-agent-forge user.forge.repo", stdout: "moroine/agent-forge" },
  { match: "incus --project agent-forge list", stdout: JSON.stringify([{ name: "agent-moroine-agent-forge", status: "Running" }]) },
  { match: "git worktree list", stdout: "worktree /workspace\nworktree /workspace/.trees/cli\n" },
  { match: "status --porcelain", stdout: " M scripts/forge\n" },
];

test("stop runs the WIP pre-flight and refuses a dirty worktree", async () => {
  const c = fakeContext({ rules: RULES });
  await assert.rejects(() => cmdStop(c, "moroine/agent-forge", false), /uncommitted changes/);
  assert.ok(!c.calls.some((call) => call[1] === "stop"));
});

test("stop --force skips the pre-flight and stops the container", async () => {
  const c = fakeContext({ rules: RULES });
  assert.equal(await cmdStop(c, "moroine/agent-forge", true), 0);
  assert.ok(c.calls.some((call) => call.join(" ") === "incus --project agent-forge stop agent-moroine-agent-forge"));
  assert.ok(!c.calls.some((call) => call.join(" ").includes("status --porcelain")));
});

test("stop asks for the repo when it is missing", async () => {
  const c = fakeContext({ rules: RULES, answers: [1] });
  await cmdStop(c, undefined, true);
  assert.ok(c.calls.some((call) => call.join(" ") === "incus --project agent-forge stop agent-moroine-agent-forge"));
});

test("delete skips the pre-flight on an already stopped container", async () => {
  const c = fakeContext({
    rules: [
      { match: "agent-x user.forge.repo", stdout: "o/r" },
      { match: "incus --project agent-forge list", stdout: JSON.stringify([{ name: "agent-x", status: "Stopped" }]) },
      { match: "git worktree list", stdout: "worktree /workspace\nworktree /workspace/.trees/cli\n" },
      { match: "status --porcelain", stdout: " M scripts/forge\n" },
    ],
  });
  assert.equal(await cmdDelete(c, "o/r", false), 0);
  assert.ok(!c.calls.some((call) => call.join(" ").includes("status --porcelain")));
  assert.ok(c.calls.some((call) => call.join(" ") === "incus --project agent-forge delete agent-x --force"));
});

test("delete runs the pre-flight on a running container", async () => {
  const c = fakeContext({ rules: RULES });
  await assert.rejects(() => cmdDelete(c, "moroine/agent-forge", false), /uncommitted changes/);
});

// Fail-fast : `ctx.exec` capture stderr là où bash en héritait. Sans
// mustSucceed, un `incus stop`/`incus delete` en échec rendait 0 et n'affichait
// rien du tout — pire que le bash d'origine sous `set -e`.
test("stop fails loudly when incus stop fails, surfacing its stderr", async () => {
  const c = fakeContext({
    rules: [
      { match: "incus --project agent-forge stop", code: 1, stderr: "Error: The instance is currently in use\n" },
      ...RULES,
    ],
  });
  await assert.rejects(
    () => cmdStop(c, "moroine/agent-forge", true),
    /incus stop failed: Error: The instance is currently in use/,
  );
});

test("delete fails loudly when incus delete fails, surfacing its stderr", async () => {
  const c = fakeContext({
    rules: [
      { match: "incus --project agent-forge delete", code: 1, stderr: "Error: Instance is protected\n" },
      { match: "agent-x user.forge.repo", stdout: "o/r" },
      { match: "incus --project agent-forge list", stdout: JSON.stringify([{ name: "agent-x", status: "Stopped" }]) },
    ],
  });
  await assert.rejects(
    () => cmdDelete(c, "o/r", false),
    /incus delete failed: Error: Instance is protected/,
  );
});

test("delete says the workspace and the mirror are kept", async () => {
  const c = fakeContext({
    rules: [
      { match: "agent-moroine-agent-forge user.forge.repo", stdout: "moroine/agent-forge" },
      { match: "incus --project agent-forge list", stdout: JSON.stringify([{ name: "agent-moroine-agent-forge", status: "Stopped" }]) },
    ],
  });
  await cmdDelete(c, "moroine/agent-forge", false);
  const line = c.out_lines.find((l) => l.startsWith("Kept "));
  assert.ok(line, c.out_lines.join("\n"));
  assert.ok(line.includes(join(workspacesDir(), "agent-moroine-agent-forge")), line);
  assert.ok(line.includes(mirrorPath("agent-moroine-agent-forge")), line);
  assert.ok(line.includes("forge start moroine/agent-forge"), line);
});
