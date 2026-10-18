import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { cmdAttach } from "../cli/lib/commands/attach.ts";

const RUNNING = JSON.stringify([{ name: "agent-x", status: "Running" }]);
const STOPPED = JSON.stringify([{ name: "agent-x", status: "Stopped" }]);
const BASE = [
  { match: "agent-x user.forge.repo", stdout: "moroine/x" },
  { match: "incus --project agent-forge list", stdout: RUNNING },
];

test("a missing argument prints the usage", async () => {
  const c = fakeContext();
  await assert.rejects(cmdAttach(c, undefined, undefined), /Usage: forge attach <container> <task>/);
  await assert.rejects(cmdAttach(c, "agent-x", undefined), /Usage: forge attach <container> <task>/);
});

test("an invalid container name is refused before any call", async () => {
  const c = fakeContext();
  await assert.rejects(cmdAttach(c, "../etc", "cli"), /container must be agent-/);
  assert.equal(c.calls.length, 0);
});

test("a container without forge metadata is refused", async () => {
  const c = fakeContext({ rules: [{ match: "user.forge.repo", stdout: "" }] });
  await assert.rejects(cmdAttach(c, "agent-x", "cli"), /agent-x is not a forge container/);
  assert.equal(c.attachCalls.length, 0);
});

test("a missing worktree names forge start", async () => {
  const c = fakeContext({ rules: [...BASE, { match: "test -e", code: 1 }] });
  await assert.rejects(cmdAttach(c, "agent-x", "cli"), /no worktree \.trees\/cli in agent-x\. Start it with 'forge start'\./);
  assert.equal(c.attachCalls.length, 0);
});

test("the agent's exit code is returned", async () => {
  const c = fakeContext({ rules: [...BASE, { match: "test -e", code: 0 }], attachCode: 3 });
  assert.equal(await cmdAttach(c, "agent-x", "cli"), 3);
  assert.equal(c.attachCalls.length, 1);
});

test("a second agent for the task is refused, naming the stored repo", async () => {
  const c = fakeContext({ rules: [
    { match: "ps -u 1001 -o args=", stdout: "claude --remote-control agent-x-cli --continue\n" },
    ...BASE, { match: "test -e", code: 0 },
  ] });
  await assert.rejects(cmdAttach(c, "agent-x", "cli"), (e: Error) => e.message ===
    "the agent for cli already runs in agent-x (in a herdr tab, or another terminal): " +
    "attach to it there, or stop it first with 'forge stop moroine/x'.");
  assert.equal(c.attachCalls.length, 0);
});

test("a stopped container is started first", async () => {
  const c = fakeContext({
    rules: [{ match: "agent-x user.forge.repo", stdout: "moroine/x" }, { match: "list", stdout: STOPPED }, { match: "test -e", code: 0 }],
  });
  await cmdAttach(c, "agent-x", "cli");
  const lines = c.calls.map((call) => call.join(" "));
  const start = lines.findIndex((l) => l.endsWith("start agent-x"));
  assert.ok(start >= 0, "no start");
  assert.ok(start < lines.findIndex((l) => l.includes("--cwd")), "started after attaching");
});
