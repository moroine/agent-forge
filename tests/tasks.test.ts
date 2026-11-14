import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext, type ExecRule } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { parseConfig } from "../cli/lib/config.ts";
import { assign, busyState, release } from "../cli/lib/tasks.ts";

const cfg = parseConfig("/c.json", {
  teams: {
    web: {
      repo: "o/web",
      roles: {
        dev: { count: 2, capabilities: ["repo", "publish"] },
        reviewer: { capabilities: ["repo", "read-team"] },
      },
    },
  },
});
const DEV1 = "agent-web-dev-1";
const DEV2 = "agent-web-dev-2";
const REV = "agent-web-reviewer";

function setup(config: Record<string, Record<string, string>> = {}, rules: ExecRule[] = [], status: "Running" | "Stopped" = "Running") {
  const fake = FakeIncus.withRuntime();
  for (const name of [DEV1, DEV2, REV]) fake.addInstance("agent-forge", name, { status, config: { ...config[name] } });
  const ctx = fakeContext({ incus: fake, rules });
  const keys = (name: string) => fake.instances.get("agent-forge")!.get(name)!.config;
  const flat = () => ctx.calls.map((c) => c.join(" "));
  return { fake, ctx, keys, flat };
}
const HUMAN = "human";

test("a free developer gets a new branch from origin/main, the keys, then a session", async () => {
  const { ctx, keys, flat } = setup();
  await assign(ctx, cfg, { to: DEV1, task: "fix-login", text: "Corrige", by: HUMAN });
  const calls = flat();
  const order = ["git -C /workspace status --porcelain", "git -C /workspace fetch origin",
    "git -C /workspace switch -c agent/fix-login origin/main", "-- hc run --bg --name agent"].map((s) => calls.findIndex((c) => c.includes(s)));
  assert.ok(order.every((i) => i >= 0) && order.every((i, k) => k === 0 || i > order[k - 1]), calls.join("\n"));
  assert.ok(calls.some((c) => c.includes("find /home/aiuser/.forge/messages -mindepth 1 -delete")), "the messages are cleared");
  assert.deepEqual(
    [keys(DEV1)["user.forge.base.fix-login"], keys(DEV1)["user.forge.task"], keys(DEV1)["user.forge.assigned_by"]],
    ["origin/main", "fix-login", HUMAN]);
});

test("the owner of an existing branch switches to it, its base is unchanged", async () => {
  const { ctx, keys, flat } = setup({ [DEV1]: { "user.forge.base.fix-login": "origin/main" } });
  await assign(ctx, cfg, { to: DEV1, task: "fix-login", text: "Reprends", by: HUMAN });
  assert.ok(flat().some((c) => c.includes("git -C /workspace switch agent/fix-login")));
  assert.ok(!flat().some((c) => c.includes("switch -c")));
  assert.equal(keys(DEV1)["user.forge.task"], "fix-login");
});

test("refusals change nothing: no state, no git switch, no session", async () => {
  const cases: [string, Record<string, Record<string, string>>, Parameters<typeof assign>[2], RegExp, ExecRule[]?][] = [
    ["busy", { [DEV1]: { "user.forge.task": "other", "user.forge.assigned_by": "human" } },
      { to: DEV1, task: "a", text: "x", by: HUMAN }, /busy with other.*assigned by human/],
    ["a task owned by another developer", { [DEV1]: { "user.forge.base.fix-login": "origin/main" } },
      { to: DEV2, task: "fix-login", text: "x", by: HUMAN }, /owned by agent-web-dev-1/],
    ["a developer without a task", {}, { to: DEV1, task: null, text: "x", by: HUMAN }, /task name/],
    ["a task for a member without publish", {}, { to: REV, task: "a", text: "x", by: HUMAN }, /no publish capability/],
    ["a dirty clone", {}, { to: DEV1, task: "a", text: "x", by: HUMAN }, /2 uncommitted changes/,
      [{ match: "status --porcelain", stdout: " M a.ts\n?? b.ts\n" }]],
    ["an invalid task name", {}, { to: DEV1, task: "a b", text: "x", by: HUMAN }, /task-name/],
    ["an undeclared member", {}, { to: "agent-web-dev-9", task: "a", text: "x", by: HUMAN }, /not declared.*agent-web-dev-1/],
  ];
  for (const [label, config, req, pattern, rules] of cases) {
    const { ctx, keys, flat } = setup(config, rules ?? []);
    const before = JSON.stringify(keys(DEV1)) + JSON.stringify(keys(DEV2));
    await assert.rejects(() => assign(ctx, cfg, req), pattern, label);
    assert.equal(JSON.stringify(keys(DEV1)) + JSON.stringify(keys(DEV2)), before, `${label}: state changed`);
    assert.ok(!flat().some((c) => c.includes("switch") || c.includes("hc run")), `${label}: acted`);
  }
});

test("a reviewer takes a task without a branch: marked '-', no git", async () => {
  const { ctx, keys, flat } = setup();
  await assign(ctx, cfg, { to: REV, task: null, text: "Relis", by: HUMAN });
  assert.equal(keys(REV)["user.forge.task"], "-");
  assert.ok(!flat().some((c) => c.includes(" git ")));
});

test("a stopped member is started, and a failing session leaves it free", async () => {
  const { ctx, keys, flat } = setup({}, [{ match: "hc run", code: 1, stderr: "no core" }], "Stopped");
  await assert.rejects(() => assign(ctx, cfg, { to: REV, task: null, text: "x", by: HUMAN }), /hc run failed/);
  assert.ok(flat().some((c) => c.endsWith(`start ${REV}`)));
  assert.equal(keys(REV)["user.forge.task"], undefined);
  assert.equal(keys(REV)["user.forge.assigned_by"], undefined);
});

test("release: by the human or by who assigned; not by anyone else, not when free", async () => {
  const busy = { "user.forge.task": "a", "user.forge.assigned_by": "agent-web-lead" };
  const mine = setup({ [DEV1]: busy });
  await release(mine.ctx, cfg, { to: DEV1, by: "agent-web-lead" });
  assert.equal(await busyState(mine.ctx, DEV1), null);
  assert.ok(mine.flat().some((c) => c.includes("find /home/aiuser/.forge/messages -mindepth 1 -delete")), "the messages are cleared");
  const human = setup({ [DEV1]: busy });
  await release(human.ctx, cfg, { to: DEV1, by: HUMAN });
  assert.equal(await busyState(human.ctx, DEV1), null);
  const other = setup({ [DEV1]: busy });
  await assert.rejects(() => release(other.ctx, cfg, { to: DEV1, by: DEV2 }), /only that member or the human/);
  assert.deepEqual(await busyState(other.ctx, DEV1), { task: "a", assignedBy: "agent-web-lead" });
  await assert.rejects(() => release(setup().ctx, cfg, { to: DEV1, by: HUMAN }), /already free/);
});
