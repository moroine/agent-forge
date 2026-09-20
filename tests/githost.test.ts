import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { ForgeError } from "../scripts/lib/context.ts";
import { acquireGitHost } from "../scripts/lib/githost.ts";

function ctxFor(fleet: { name: string; status: string; role: string; task: string }[]) {
  return fakeContext({
    rules: [
      { match: "lxc list", stdout: JSON.stringify(fleet.map((c) => ({ name: c.name, status: c.status }))) },
      ...fleet.flatMap((c) => [
        { match: `config get ${c.name} user.forge.repo`, stdout: "o/r" },
        { match: `config get ${c.name} user.forge.mode`, stdout: "autonomous" },
        { match: `config get ${c.name} user.forge.role`, stdout: c.role },
        { match: `config get ${c.name} user.forge.task`, stdout: c.task },
      ]),
    ],
  });
}

test("a running preferred container is used as-is and released without stopping", async () => {
  const ctx = ctxFor([
    { name: "agent-o-r", status: "Stopped", role: "template", task: "" },
    { name: "agent-o-r-feat", status: "Running", role: "task", task: "feat" },
  ]);
  const host = await acquireGitHost(ctx, "o/r", "agent-o-r-feat");
  assert.equal(host.name, "agent-o-r-feat");
  await host.release();
  assert.ok(!ctx.calls.some((c) => c[1] === "stop"));
  assert.ok(!ctx.calls.some((c) => c[1] === "start"));
});

test("another running task container is preferred over waking the template", async () => {
  const ctx = ctxFor([
    { name: "agent-o-r", status: "Stopped", role: "template", task: "" },
    { name: "agent-o-r-dead", status: "Stopped", role: "task", task: "dead" },
    { name: "agent-o-r-live", status: "Running", role: "task", task: "live" },
  ]);
  const host = await acquireGitHost(ctx, "o/r", "agent-o-r-dead");
  assert.equal(host.name, "agent-o-r-live");
  await host.release();
  assert.ok(!ctx.calls.some((c) => c[1] === "start"));
});

test("with nothing running, the template is started and stopped again on release", async () => {
  const ctx = ctxFor([{ name: "agent-o-r", status: "Stopped", role: "template", task: "" }]);
  const host = await acquireGitHost(ctx, "o/r");
  assert.equal(host.name, "agent-o-r");
  assert.ok(ctx.calls.some((c) => c.join(" ") === "lxc start agent-o-r"));
  await host.release();
  assert.ok(ctx.calls.some((c) => c.join(" ") === "lxc stop agent-o-r"));
});

test("a running template is used without being stopped afterwards", async () => {
  const ctx = ctxFor([{ name: "agent-o-r", status: "Running", role: "template", task: "" }]);
  const host = await acquireGitHost(ctx, "o/r");
  await host.release();
  assert.ok(!ctx.calls.some((c) => c[1] === "stop"));
});

test("a repo with no container at all is a ForgeError", async () => {
  await assert.rejects(() => acquireGitHost(ctxFor([]), "o/r"), ForgeError);
});
