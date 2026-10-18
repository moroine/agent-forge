import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import {
  listInstances, instanceStatus, instanceExists, configGet, configSet, imageProperty,
  execAsAgent, startInstance, stopInstance, deleteInstance, attachArgv, forgeProject, waitReady,
} from "../cli/lib/incus.ts";
import { AGENT } from "../cli/lib/agent.ts";

const P = ["incus", "--project", "agent-forge"];
const LIST_JSON = JSON.stringify([
  { name: "agent-moroine-agent-forge", status: "Running" },
  { name: "agent-acme-widgets", status: "Stopped" },
]);

afterEach(() => { delete process.env.FORGE_INCUS_PROJECT; });

test("every call names the agent-forge project", async () => {
  const ctx = fakeContext({ rules: [{ match: "list -f json", stdout: "[]" }] });
  await listInstances(ctx);
  await instanceExists(ctx, "c");
  await configGet(ctx, "c", "k");
  await configSet(ctx, "c", "k", "v");
  await imageProperty(ctx, "agent-base", "k");
  await execAsAgent(ctx, "c", "true");
  await startInstance(ctx, "c");
  await stopInstance(ctx, "c");
  await deleteInstance(ctx, "c");
  assert.equal(ctx.calls.length, 9);
  for (const call of ctx.calls) assert.deepEqual(call.slice(0, 3), P, call.join(" "));
});

test("FORGE_INCUS_PROJECT points every call at another project", async () => {
  process.env.FORGE_INCUS_PROJECT = "forge-selftest";
  assert.equal(forgeProject(), "forge-selftest");
  const ctx = fakeContext();
  await configSet(ctx, "c", "k", "v");
  assert.deepEqual(ctx.calls[0], ["incus", "--project", "forge-selftest", "config", "set", "c", "k", "v"]);
  assert.deepEqual(attachArgv("c", "t", "xterm", ["bash"]).slice(0, 3), ["incus", "--project", "forge-selftest"]);
});

test("listInstances parses incus list -f json without jq", async () => {
  const ctx = fakeContext({ rules: [{ match: "incus --project agent-forge list", stdout: LIST_JSON }] });
  assert.deepEqual(await listInstances(ctx), [
    { name: "agent-moroine-agent-forge", status: "Running" },
    { name: "agent-acme-widgets", status: "Stopped" },
  ]);
  assert.ok(!ctx.calls.some((c) => c.includes("jq")), "must not shell out to jq");
});

test("listInstances treats unparseable output as no instances", async () => {
  const ctx = fakeContext({ rules: [{ match: "incus --project agent-forge list", stdout: "not json" }] });
  assert.deepEqual(await listInstances(ctx), []);
});

test("instanceStatus returns the status, or null when absent", async () => {
  const ctx = fakeContext({ rules: [{ match: "incus --project agent-forge list", stdout: LIST_JSON }] });
  assert.equal(await instanceStatus(ctx, "agent-acme-widgets"), "Stopped");
  const empty = fakeContext({ rules: [{ match: "incus --project agent-forge list", stdout: "[]" }] });
  assert.equal(await instanceStatus(empty, "nope"), null);
});

test("instanceExists maps incus info's exit code to a boolean", async () => {
  const yes = fakeContext({ rules: [{ match: "incus --project agent-forge info", code: 0 }] });
  const no = fakeContext({ rules: [{ match: "incus --project agent-forge info", code: 1 }] });
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
  await configSet(ctx, "agent-x", "user.forge.mode", "supervised");
  assert.deepEqual(ctx.calls[0], [...P, "config", "set", "agent-x", "user.forge.mode", "supervised"]);
});

test("imageProperty returns empty when the image is unstamped", async () => {
  const ctx = fakeContext({ rules: [{ match: "image get-property", code: 1, stdout: "" }] });
  assert.equal(await imageProperty(ctx, "agent-base", "user.forge.commit"), "");
});

test("execAsAgent passes the script as one argv element, with no outer shell", async () => {
  const ctx = fakeContext();
  await execAsAgent(ctx, "agent-x", "git -C /workspace status --porcelain");
  assert.deepEqual(ctx.calls[0], [
    ...P, "exec", "agent-x", "--",
    "su", "-", "aiuser", "-c", "git -C /workspace status --porcelain",
  ]);
});

test("deleteInstance always forces, since the caller has already decided", async () => {
  const ctx = fakeContext();
  await deleteInstance(ctx, "agent-x");
  assert.deepEqual(ctx.calls[0], [...P, "delete", "agent-x", "--force"]);
});

test("attachArgv runs the agent command directly under incus exec", () => {
  const argv = attachArgv("agent-x", "cli", "xterm-256color", AGENT.command("agent-x", "cli", false));
  assert.deepEqual(argv, [
    ...P, "exec", "agent-x",
    "--user", "1001", "--group", "1001",
    "--cwd", "/workspace/.trees/cli",
    "--env", "TERM=xterm-256color",
    "--", "bash", "-lc", "exec claude --permission-mode auto --remote-control agent-x-cli",
  ]);
  // Invariant du commit c34a145 : aucun `su` entre incus exec et l'agent.
  assert.ok(!argv.includes("su"));
  assert.ok(!argv.includes("tmux"));
});

test("the fake incus answers the transport, project included", async () => {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-x", { status: "Stopped", config: { "user.forge.repo": "o/r" } });
  const ctx = fakeContext({ incus: fake });
  assert.deepEqual(await listInstances(ctx), [{ name: "agent-x", status: "Stopped" }]);
  assert.equal(await configGet(ctx, "agent-x", "user.forge.repo"), "o/r");
  assert.equal(await imageProperty(ctx, "agent-base", "user.forge.commit"), "aaaa1111");
});

// waitReady : un Context dont exec rend les réponses données, la dernière en boucle.
function readyContext(answers: { code: number; stdout: string; stderr: string }[]) {
  let n = 0;
  const ctx = { ...fakeContext(), exec: async () => answers[Math.min(n++, answers.length - 1)] };
  return { ctx, count: () => n };
}
const BUS = { code: 1, stdout: "", stderr: "Failed to connect to system scope bus via local transport: No such file or directory\n" };

test("waitReady retries while systemd's bus is not up, then resolves", async () => {
  const { ctx, count } = readyContext([BUS, BUS, { code: 0, stdout: "running\n", stderr: "" }]);
  await waitReady(ctx, "c", { delayMs: 0 });
  assert.equal(count(), 3);
});

test("waitReady gives up after the attempts, with the last stderr", async () => {
  const { ctx, count } = readyContext([BUS]);
  await assert.rejects(waitReady(ctx, "c", { attempts: 4, delayMs: 0 }), /did not finish booting[\s\S]*system scope bus/);
  assert.equal(count(), 4);
});

test("waitReady retries while systemd answers offline, then resolves", async () => {
  const off = { code: 1, stdout: "offline\n", stderr: "" };
  const { ctx, count } = readyContext([off, off, { code: 0, stdout: "running\n", stderr: "" }]);
  await waitReady(ctx, "c", { delayMs: 0 });
  assert.equal(count(), 3);
});

test("waitReady throws at once on a non-empty state that is neither ready nor offline", async () => {
  const { ctx, count } = readyContext([{ code: 1, stdout: "maintenance\n", stderr: "" }]);
  await assert.rejects(waitReady(ctx, "c", { delayMs: 0 }), /systemd state: maintenance/);
  assert.equal(count(), 1);
});
