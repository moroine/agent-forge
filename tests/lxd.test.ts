import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import {
  listInstances, instanceStatus, instanceExists, configGet, configSet,
  imageProperty, execAsAgent, deleteInstance, attachArgv,
} from "../cli/lib/lxd.ts";

const LIST_JSON = JSON.stringify([
  { name: "agent-moroine-agent-forge", status: "Running" },
  { name: "agent-acme-widgets", status: "Stopped" },
]);

test("listInstances parses lxc list -f json without jq", async () => {
  const ctx = fakeContext({ rules: [{ match: "lxc list", stdout: LIST_JSON }] });
  assert.deepEqual(await listInstances(ctx), [
    { name: "agent-moroine-agent-forge", status: "Running" },
    { name: "agent-acme-widgets", status: "Stopped" },
  ]);
  assert.ok(!ctx.calls.some((c) => c.includes("jq")), "must not shell out to jq");
});

test("listInstances treats unparseable output as no instances", async () => {
  const ctx = fakeContext({ rules: [{ match: "lxc list", stdout: "not json" }] });
  assert.deepEqual(await listInstances(ctx), []);
});

test("instanceStatus returns the status, or null when absent", async () => {
  const ctx = fakeContext({ rules: [{ match: "lxc list", stdout: LIST_JSON }] });
  assert.equal(await instanceStatus(ctx, "agent-acme-widgets"), "Stopped");
  const empty = fakeContext({ rules: [{ match: "lxc list", stdout: "[]" }] });
  assert.equal(await instanceStatus(empty, "nope"), null);
});

test("instanceExists maps lxc info's exit code to a boolean", async () => {
  const yes = fakeContext({ rules: [{ match: "lxc info", code: 0 }] });
  const no = fakeContext({ rules: [{ match: "lxc info", code: 1 }] });
  assert.equal(await instanceExists(yes, "c"), true);
  assert.equal(await instanceExists(no, "c"), false);
});

test("configGet trims and returns empty for an unset key", async () => {
  const set = fakeContext({ rules: [{ match: "config get", stdout: "moroine/agent-forge\n" }] });
  assert.equal(await configGet(set, "c", "user.forge.repo"), "moroine/agent-forge");
  const unset = fakeContext({ rules: [{ match: "config get", stdout: "\n" }] });
  assert.equal(await configGet(unset, "c", "user.forge.repo"), "");
});

test("configSet issues the expected argv", async () => {
  const ctx = fakeContext();
  await configSet(ctx, "agent-x", "user.forge.mode", "autonomous");
  assert.deepEqual(ctx.calls[0], ["lxc", "config", "set", "agent-x", "user.forge.mode", "autonomous"]);
});

test("imageProperty returns empty when the image is unstamped", async () => {
  const ctx = fakeContext({ rules: [{ match: "image get-property", code: 1, stdout: "" }] });
  assert.equal(await imageProperty(ctx, "agent-base", "user.forge.commit"), "");
});

test("execAsAgent passes the script as one argv element, with no outer shell", async () => {
  const ctx = fakeContext();
  await execAsAgent(ctx, "agent-x", "git -C /workspace status --porcelain");
  assert.deepEqual(ctx.calls[0], [
    "lxc", "exec", "agent-x", "--",
    "su", "-", "aiuser", "-c", "git -C /workspace status --porcelain",
  ]);
});

test("deleteInstance always forces, since the caller has already decided", async () => {
  const ctx = fakeContext();
  await deleteInstance(ctx, "agent-x");
  assert.deepEqual(ctx.calls[0], ["lxc", "delete", "agent-x", "--force"]);
});

test("attachArgv keeps tmux the direct target of lxc exec", () => {
  const argv = attachArgv("agent-x", "cli", "xterm-256color");
  assert.deepEqual(argv, [
    "lxc", "exec", "agent-x",
    "--user", "1001", "--group", "1001",
    "--cwd", "/workspace/.trees/cli",
    "--env", "TERM=xterm-256color",
    "--", "tmux", "new-session", "-A", "-s", "cli",
    "exec bash -lc 'claude --permission-mode auto --remote-control agent-x-cli'",
  ]);
  // Invariant du commit c34a145 : aucun `su` entre lxc exec et tmux, sinon
  // SIGWINCH n'atteint jamais le client tmux au redimensionnement.
  assert.ok(!argv.includes("su"));
  assert.equal(argv[argv.indexOf("--", 3) + 1], "tmux");
});
